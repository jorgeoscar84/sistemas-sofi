/**
 * Acceso a datos multiempresa sobre PostgreSQL.
 *
 * Arquitectura:
 *  - Schema `platform`  → usuarios globales, licencias, tokens y auditoría.
 *  - Schema `tenant_<id>` → datos aislados de cada empresa.
 *
 * El contexto de empresa se propaga con AsyncLocalStorage. Cada consulta fija
 * `search_path` al schema correspondiente; para una transacción se reutiliza el
 * mismo cliente mediante el store de transacción.
 *
 * En producción se usa `pg` (PostgreSQL real). En pruebas se puede usar PGlite
 * (motor PostgreSQL WASM) con DB_DRIVER=pglite.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from './config.ts';
import { newId } from './ids.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const PLATFORM_SCHEMA = 'platform';

/** Error de contexto: la petición requiere una empresa seleccionada. */
export class TenantRequiredError extends Error {
  constructor(message = 'Seleccione una empresa para operar') {
    super(message);
    this.name = 'TenantRequiredError';
  }
}

/* ---------------------------------------------------------- contexto */

const tenantStore = new AsyncLocalStorage<{ companyId: string | null }>();
const txStore = new AsyncLocalStorage<{ schema: string; q: Queryable }>();

export function runWithTenant<T>(companyId: string | null, fn: () => T): T {
  return tenantStore.run({ companyId }, fn);
}

export function runWithTenantAsync<T>(companyId: string | null, fn: () => Promise<T>): Promise<T> {
  return tenantStore.run({ companyId }, fn);
}

export function currentTenantId(): string | null {
  return tenantStore.getStore()?.companyId ?? null;
}

export function requireTenantId(): string {
  const companyId = currentTenantId();
  if (!companyId) throw new TenantRequiredError();
  return companyId;
}

/* ------------------------------------------------------------ backend */

export type Row = Record<string, unknown>;
export interface Queryable {
  query<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
}

interface Backend {
  query(schema: string, sql: string, params: unknown[]): Promise<Row[]>;
  execute(schema: string, sql: string, params: unknown[]): Promise<void>;
  transaction<T>(schema: string, fn: (q: Queryable) => Promise<T>): Promise<T>;
  exec(schema: string, sql: string): Promise<void>;
  schemaExists(schema: string): Promise<boolean>;
  createSchema(schema: string): Promise<void>;
  dropSchema(schema: string): Promise<void>;
  listSchemas(prefix: string): Promise<string[]>;
  close(): Promise<void>;
}

function quoteIdent(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(value)) throw new Error(`Identificador SQL inválido: ${value}`);
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Convierte marcadores SQLite `?` a PostgreSQL `$1, $2...` sin tocar los `?`
 * que aparezcan dentro de cadenas o identificadores.
 */
export function toPgSql(sql: string): string {
  let index = 0;
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i]!;
    if (quote) {
      out += char;
      if (char === quote) {
        if (sql[i + 1] === quote) {
          out += sql[i + 1];
          i++;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      out += char;
      continue;
    }
    if (char === '?') {
      index++;
      out += `$${index}`;
      continue;
    }
    out += char;
  }
  return out;
}

class PgBackend implements Backend {
  private pool: pg.Pool;

  constructor() {
    if (!config.databaseUrl) {
      throw new Error('DATABASE_URL no configurada para PostgreSQL');
    }
    // COUNT/SUM de PostgreSQL llegan como int8/numeric (string); la API usa números.
    pg.types.setTypeParser(20, (value: string) => Number(value));
    pg.types.setTypeParser(1700, (value: string) => Number(value));
    this.pool = new pg.Pool({ connectionString: config.databaseUrl, max: config.dbPoolMax });
  }

  private async withClient<T>(schema: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query(`SET search_path TO ${quoteIdent(schema)}, public`);
      return await fn(client);
    } finally {
      client.release();
    }
  }

  private queryable(client: pg.PoolClient): Queryable {
    return {
      query: async <T = Row>(sql: string, params: unknown[] = []) => {
        const result = await client.query(toPgSql(sql), params);
        return result.rows as T[];
      },
    };
  }

  async query(schema: string, sql: string, params: unknown[]): Promise<Row[]> {
    return this.withClient(schema, async (client) => (await client.query(toPgSql(sql), params)).rows as Row[]);
  }

  async execute(schema: string, sql: string, params: unknown[]): Promise<void> {
    await this.withClient(schema, async (client) => {
      await client.query(toPgSql(sql), params);
    });
  }

  async transaction<T>(schema: string, fn: (q: Queryable) => Promise<T>): Promise<T> {
    return this.withClient(schema, async (client) => {
      await client.query('BEGIN');
      try {
        const result = await fn(this.queryable(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }

  async exec(schema: string, sql: string): Promise<void> {
    await this.withClient(schema, async (client) => {
      await client.query(sql);
    });
  }

  async schemaExists(schema: string): Promise<boolean> {
    const result = await this.pool.query('SELECT 1 FROM information_schema.schemata WHERE schema_name = $1', [schema]);
    return result.rowCount === 1;
  }

  async createSchema(schema: string): Promise<void> {
    await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)}`);
  }

  async dropSchema(schema: string): Promise<void> {
    await this.pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
  }

  async listSchemas(prefix: string): Promise<string[]> {
    const result = await this.pool.query(
      "SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE $1",
      [`${prefix}%`],
    );
    return result.rows.map((row: { schema_name: string }) => row.schema_name);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

interface PgliteLike {
  query<T = Row>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

class PgliteBackend implements Backend {
  private db: PgliteLike;

  constructor(db: PgliteLike) {
    this.db = db;
  }

  private async setSchema(schema: string): Promise<void> {
    await this.db.exec(`SET search_path TO ${quoteIdent(schema)}, public`);
  }

  async query(schema: string, sql: string, params: unknown[]): Promise<Row[]> {
    await this.setSchema(schema);
    const result = await this.db.query<Row>(toPgSql(sql), params);
    return result.rows;
  }

  async execute(schema: string, sql: string, params: unknown[]): Promise<void> {
    await this.setSchema(schema);
    await this.db.query(toPgSql(sql), params);
  }

  async transaction<T>(schema: string, fn: (q: Queryable) => Promise<T>): Promise<T> {
    await this.setSchema(schema);
    await this.db.exec('BEGIN');
    try {
      const result = await fn({
        query: async <U = Row>(sql: string, params: unknown[] = []) => {
          const response = await this.db.query<U>(toPgSql(sql), params);
          return response.rows;
        },
      });
      await this.db.exec('COMMIT');
      return result;
    } catch (error) {
      await this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async exec(schema: string, sql: string): Promise<void> {
    await this.setSchema(schema);
    await this.db.exec(sql);
  }

  async schemaExists(schema: string): Promise<boolean> {
    const result = await this.db.query<{ schema_name: string }>(
      'SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1',
      [schema],
    );
    return result.rows.length === 1;
  }

  async createSchema(schema: string): Promise<void> {
    await this.db.exec(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)}`);
  }

  async dropSchema(schema: string): Promise<void> {
    await this.db.exec(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
  }

  async listSchemas(prefix: string): Promise<string[]> {
    const result = await this.db.query<{ schema_name: string }>(
      'SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE $1',
      [`${prefix}%`],
    );
    return result.rows.map((row) => row.schema_name);
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

let backend: Backend | null = null;
let defaultTenantId: string | null = null;

async function getBackend(): Promise<Backend> {
  if (backend) return backend;
  if (config.dbDriver === 'pglite') {
    const { PGlite } = await import('@electric-sql/pglite');
    const db = new PGlite();
    await db.waitReady;
    backend = new PgliteBackend(db as unknown as PgliteLike);
  } else {
    backend = new PgBackend();
  }
  return backend;
}

/* ------------------------------------------------------------ ciclo de vida */

function schemaFor(companyId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(companyId)) throw new Error('Identificador de empresa inválido');
  return `${config.dbSchemaPrefix}${companyId}`;
}

function platformSchemaFile(): string {
  return fs.readFileSync(path.join(here, 'db', 'schema-platform.sql'), 'utf8');
}

function tenantSchemaFile(): string {
  return fs.readFileSync(path.join(here, 'db', 'schema.sql'), 'utf8');
}

export async function initPlatformDb(): Promise<void> {
  const db = await getBackend();
  await db.createSchema(PLATFORM_SCHEMA);
  await db.exec(PLATFORM_SCHEMA, platformSchemaFile());
  await db.execute(
    PLATFORM_SCHEMA,
    "INSERT INTO app_meta (key, value) VALUES ('schema_version', '3') ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    [],
  );
}

export async function initDb(): Promise<void> {
  await initPlatformDb();
}

/** Crea el schema aislado de una empresa. */
export async function createTenantDb(companyId: string): Promise<void> {
  const schema = schemaFor(companyId);
  const db = await getBackend();
  await db.createSchema(schema);
  await db.exec(schema, tenantSchemaFile());
}

/** Asegura que el schema de una empresa exista. */
export async function openTenantDb(companyId: string): Promise<void> {
  const schema = schemaFor(companyId);
  const db = await getBackend();
  if (!(await db.schemaExists(schema))) {
    throw new Error(`El schema de la empresa ${companyId} no existe`);
  }
}

export async function tenantDatabaseExists(companyId: string): Promise<boolean> {
  const db = await getBackend();
  return db.schemaExists(schemaFor(companyId));
}

/** Identificador lógico del schema (se conserva para reportes/API). */
export function tenantDbPath(companyId: string): string {
  return schemaFor(companyId);
}

export function setDefaultTenant(companyId: string | null): void {
  defaultTenantId = companyId;
}

export async function closeDatabases(): Promise<void> {
  if (backend) await backend.close();
  backend = null;
}

export async function removeAllDatabases(): Promise<void> {
  const db = await getBackend();
  const schemas = await db.listSchemas(config.dbSchemaPrefix);
  for (const schema of schemas) await db.dropSchema(schema);
  await db.dropSchema(PLATFORM_SCHEMA);
}

/* --------------------------------------------------------- consultas */

function activeSchema(): string {
  const companyId = currentTenantId() ?? defaultTenantId;
  if (!companyId) throw new TenantRequiredError();
  return schemaFor(companyId);
}

async function runQuery<T = Row>(schema: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const tx = txStore.getStore();
  if (tx && tx.schema === schema) return tx.q.query<T>(sql, params);
  const db = await getBackend();
  return (await db.query(schema, sql, params)) as T[];
}

async function runExec(schema: string, sql: string, params: unknown[] = []): Promise<void> {
  const tx = txStore.getStore();
  if (tx && tx.schema === schema) {
    await tx.q.query(sql, params);
    return;
  }
  const db = await getBackend();
  await db.execute(schema, sql, params);
}

export async function queryAll<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
  return runQuery<T>(activeSchema(), sql, params);
}

export async function queryOne<T = Row>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  const rows = await runQuery<T>(activeSchema(), sql, params);
  return rows[0];
}

export async function execute(sql: string, params: unknown[] = []): Promise<void> {
  await runExec(activeSchema(), sql, params);
}

export async function transaction<T>(fn: () => Promise<T>): Promise<T> {
  const schema = activeSchema();
  if (txStore.getStore()) return fn();
  const db = await getBackend();
  return db.transaction(schema, (q) => txStore.run({ schema, q }, fn));
}

/* ------------------------------------------------- plataforma */

export async function pAll<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
  return runQuery<T>(PLATFORM_SCHEMA, sql, params);
}

export async function pOne<T = Row>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  const rows = await runQuery<T>(PLATFORM_SCHEMA, sql, params);
  return rows[0];
}

export async function pExec(sql: string, params: unknown[] = []): Promise<void> {
  await runExec(PLATFORM_SCHEMA, sql, params);
}

export async function platformTransaction<T>(fn: () => Promise<T>): Promise<T> {
  if (txStore.getStore()) return fn();
  const db = await getBackend();
  return db.transaction(PLATFORM_SCHEMA, (q) => txStore.run({ schema: PLATFORM_SCHEMA, q }, fn));
}

/* ------------------------------------------------- utilidades */

export function nowIso(): string {
  return new Date().toISOString();
}

export function camel<T = Row>(row: Row): T {
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) {
    out[key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())] = value;
  }
  return out as T;
}

export function camelAll<T = Row>(rows: Row[]): T[] {
  return rows.map((row) => camel<T>(row));
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** Auditoría de la empresa activa (se espera en el flujo de la petición). */
export async function audit(entity: string, entityId: string, type: string, note: string, userId: string | null): Promise<void> {
  await execute(
    'INSERT INTO audit_movements (id, entity, entity_id, type, note, user_id, created_at) VALUES (?,?,?,?,?,?,?)',
    [newId(), entity, entityId, type, note, userId, nowIso()],
  );
}

/** Auditoría de plataforma. */
export async function platformAudit(
  companyId: string | null,
  entity: string,
  entityId: string,
  type: string,
  note: string,
  userId: string | null,
): Promise<void> {
  await pExec(
    'INSERT INTO platform_audit (id, company_id, entity, entity_id, type, note, user_id, created_at) VALUES (?,?,?,?,?,?,?,?)',
    [newId(), companyId, entity, entityId, type, note, userId, nowIso()],
  );
}

export async function auditList(
  entity: string,
  entityId: string,
): Promise<{ type: string; note: string | null; userId: string | null; createdAt: string }[]> {
  return camelAll(
    await queryAll(
      'SELECT type, note, user_id, created_at FROM audit_movements WHERE entity = ? AND entity_id = ? ORDER BY created_at ASC',
      [entity, entityId],
    ),
  ) as { type: string; note: string | null; userId: string | null; createdAt: string }[];
}
