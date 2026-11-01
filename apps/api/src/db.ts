/**
 * Acceso a datos multiempresa.
 *
 * Arquitectura:
 *  - `data/platform.db`      → usuarios globales, licencias (empresas) y tokens de API.
 *  - `data/tenants/<id>.db`  → base de datos aislada de cada empresa (contabilidad,
 *                              catálogo, inventario, comprobantes, certificado, etc.).
 *
 * El contexto de empresa se propaga por petición con AsyncLocalStorage: el router
 * autentica al usuario, determina la empresa activa (propia o la elegida por el
 * superadministrador) y ejecuta el handler dentro de `runWithTenant`.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.ts';
import { newId } from './ids.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Error de contexto: la petición requiere una empresa seleccionada. */
export class TenantRequiredError extends Error {
  constructor(message = 'Seleccione una empresa para operar') {
    super(message);
    this.name = 'TenantRequiredError';
  }
}

/* ---------------------------------------------------------- contexto */

const tenantStore = new AsyncLocalStorage<{ companyId: string | null }>();

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

/* ------------------------------------------------- bases de datos */

let platformInstance: DatabaseSync | null = null;
const tenantInstances = new Map<string, DatabaseSync>();
let defaultTenantId: string | null = null;

export function tenantDbPath(companyId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(companyId)) throw new Error('Identificador de empresa inválido');
  return path.join(config.tenantsDir, `${companyId}.db`);
}

function openDatabase(file: string): DatabaseSync {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

function platformSchema(): string {
  return fs.readFileSync(path.join(here, 'db', 'schema-platform.sql'), 'utf8');
}

function tenantSchema(): string {
  return fs.readFileSync(path.join(here, 'db', 'schema.sql'), 'utf8');
}

/**
 * Inicializa la plataforma. Si existe una base de la versión monoempresa la
 * respalda y avisa que hay que sembrar (no se mezclan datos de plataformas).
 */
export function initPlatformDb(): void {
  const platformFile = config.platformDbPath;
  if (!fs.existsSync(platformFile) && fs.existsSync(config.dbPath)) {
    const backup = `${config.dbPath}.v1-backup`;
    try {
      fs.renameSync(config.dbPath, backup);
      for (const suffix of ['-wal', '-shm']) {
        if (fs.existsSync(`${config.dbPath}${suffix}`)) fs.rmSync(`${config.dbPath}${suffix}`, { force: true });
      }
      console.warn(`[db] Base monoempresa anterior respaldada en ${backup}. Ejecute "npm run seed" para crear la plataforma multiempresa.`);
    } catch (error) {
      console.warn('[db] No se pudo respaldar la base anterior:', error);
    }
  }
  const db = getPlatformDb();
  db.exec(platformSchema());
  db.prepare(
    "INSERT INTO app_meta (key, value) VALUES ('schema_version', '2') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run();
}

export function getPlatformDb(): DatabaseSync {
  if (!platformInstance) {
    platformInstance = openDatabase(config.platformDbPath);
  }
  return platformInstance;
}

/** Abre (o crea) la base de datos de una empresa y aplica el esquema. */
export function openTenantDb(companyId: string): DatabaseSync {
  const cached = tenantInstances.get(companyId);
  if (cached) return cached;
  const file = tenantDbPath(companyId);
  if (!fs.existsSync(file)) throw new Error(`La base de datos de la empresa ${companyId} no existe`);
  const db = openDatabase(file);
  db.exec(tenantSchema());
  applyTenantMigrations(db);
  tenantInstances.set(companyId, db);
  return db;
}

/** Crea la base de datos vacía de una empresa. */
export function createTenantDb(companyId: string): DatabaseSync {
  const file = tenantDbPath(companyId);
  if (fs.existsSync(file)) throw new Error(`La base de datos de la empresa ${companyId} ya existe`);
  const db = openDatabase(file);
  db.exec(tenantSchema());
  applyTenantMigrations(db);
  tenantInstances.set(companyId, db);
  return db;
}

export function tenantDatabaseExists(companyId: string): boolean {
  return fs.existsSync(tenantDbPath(companyId));
}

export function getDb(): DatabaseSync {
  const companyId = currentTenantId() ?? defaultTenantId;
  if (!companyId) throw new TenantRequiredError();
  return openTenantDb(companyId);
}

/** Empresa por defecto para scripts/pruebas que corren fuera de una petición. */
export function setDefaultTenant(companyId: string | null): void {
  defaultTenantId = companyId;
}

/** Cierra todas las conexiones (pruebas, seed --force, apagado). */
export function closeDatabases(): void {
  for (const db of tenantInstances.values()) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
  tenantInstances.clear();
  if (platformInstance) {
    try {
      platformInstance.close();
    } catch {
      /* ignore */
    }
    platformInstance = null;
  }
}

/** Elimina las bases de datos de plataforma y empresas (sólo seed --force/pruebas). */
export function removeAllDatabases(): void {
  closeDatabases();
  for (const file of [config.platformDbPath, config.dbPath]) {
    for (const suffix of ['', '-wal', '-shm']) {
      const target = `${file}${suffix}`;
      if (fs.existsSync(target)) fs.rmSync(target, { force: true });
    }
  }
  if (fs.existsSync(config.tenantsDir)) fs.rmSync(config.tenantsDir, { recursive: true, force: true });
}

/** Migraciones incrementales del esquema de empresa. */
function applyTenantMigrations(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(vouchers)').all() as { name: string }[];
  const names = new Set(columns.map((column) => column.name));
  if (!names.has('extra_json')) {
    db.exec("ALTER TABLE vouchers ADD COLUMN extra_json TEXT NOT NULL DEFAULT '{}'");
  }
  const companyColumns = db.prepare('PRAGMA table_info(company)').all() as { name: string }[];
  const companyNames = new Set(companyColumns.map((column) => column.name));
  if (!companyNames.has('signature_digest')) {
    db.exec("ALTER TABLE company ADD COLUMN signature_digest TEXT NOT NULL DEFAULT 'sha1'");
  }
}

/** Inicializa la plataforma al arrancar el servidor. */
export function initDb(): void {
  initPlatformDb();
}

/* --------------------------------------------------- consultas de empresa */

export type Row = Record<string, unknown>;

export function queryAll<T = Row>(sql: string, params: unknown[] = []): T[] {
  return getDb().prepare(sql).all(...(params as never[])) as T[];
}

export function queryOne<T = Row>(sql: string, params: unknown[] = []): T | undefined {
  return getDb().prepare(sql).get(...(params as never[])) as T | undefined;
}

export function execute(sql: string, params: unknown[] = []): void {
  getDb().prepare(sql).run(...(params as never[]));
}

export function transaction<T>(fn: () => T): T {
  const db = getDb();
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/* -------------------------------------------------- consultas de plataforma */

export function pAll<T = Row>(sql: string, params: unknown[] = []): T[] {
  return getPlatformDb().prepare(sql).all(...(params as never[])) as T[];
}

export function pOne<T = Row>(sql: string, params: unknown[] = []): T | undefined {
  return getPlatformDb().prepare(sql).get(...(params as never[])) as T | undefined;
}

export function pExec(sql: string, params: unknown[] = []): void {
  getPlatformDb().prepare(sql).run(...(params as never[]));
}

export function platformTransaction<T>(fn: () => T): T {
  const db = getPlatformDb();
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/* --------------------------------------------------------------- utilidades */

export function nowIso(): string {
  return new Date().toISOString();
}

/** Convierte columnas snake_case a camelCase. */
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

/** Registra un movimiento de auditoría de la empresa activa. */
export function audit(entity: string, entityId: string, type: string, note: string, userId: string | null): void {
  execute(
    'INSERT INTO audit_movements (id, entity, entity_id, type, note, user_id, created_at) VALUES (?,?,?,?,?,?,?)',
    [newId(), entity, entityId, type, note, userId, nowIso()],
  );
}

/** Auditoría a nivel de plataforma (licencias, empresas, superadmin). */
export function platformAudit(
  companyId: string | null,
  entity: string,
  entityId: string,
  type: string,
  note: string,
  userId: string | null,
): void {
  pExec(
    'INSERT INTO platform_audit (id, company_id, entity, entity_id, type, note, user_id, created_at) VALUES (?,?,?,?,?,?,?,?)',
    [newId(), companyId, entity, entityId, type, note, userId, nowIso()],
  );
}

export function auditList(
  entity: string,
  entityId: string,
): { type: string; note: string | null; userId: string | null; createdAt: string }[] {
  return camelAll(
    queryAll(
      'SELECT type, note, user_id, created_at FROM audit_movements WHERE entity = ? AND entity_id = ? ORDER BY created_at ASC',
      [entity, entityId],
    ),
  ) as { type: string; note: string | null; userId: string | null; createdAt: string }[];
}

