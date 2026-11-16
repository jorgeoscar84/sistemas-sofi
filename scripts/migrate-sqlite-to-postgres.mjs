/**
 * Migración única SQLite → PostgreSQL.
 *
 * Lee la plataforma SQLite histórica (`PLATFORM_DB_PATH`) y cada archivo de
 * `TENANTS_DIR/*.db`, y los copia a los schemas PostgreSQL ya creados.
 * Es idempotente: usa ON CONFLICT DO NOTHING y puede ejecutarse varias veces.
 *
 * Uso (con DATABASE_URL y DB_DRIVER=postgres):
 *   node scripts/migrate-sqlite-to-postgres.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  initPlatformDb,
  createTenantDb,
  platformTransaction,
  runWithTenantAsync,
  pExec,
  pOne,
  execute,
} from '../apps/api/src/db.ts';
import { config } from '../apps/api/src/config.ts';

const platformFile = process.env.PLATFORM_DB_PATH || path.join(config.root, 'data', 'platform.db');
const tenantsDir = process.env.TENANTS_DIR || path.join(config.root, 'data', 'tenants');

if (!fs.existsSync(platformFile)) {
  console.error(`[migracion] No existe la base de plataforma SQLite: ${platformFile}`);
  process.exit(1);
}

function openSqlite(file) {
  return new DatabaseSync(file, { readOnly: true });
}

function tableNames(sqlite) {
  return sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => String(row.name));
}

function columnsOf(sqlite, table) {
  return sqlite
    .prepare(`PRAGMA table_info("${table.replaceAll('"', '""')}")`)
    .all()
    .map((row) => String(row.name));
}

function quoteIdent(value) {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(value)) throw new Error(`Identificador inválido: ${value}`);
  return `"${value}"`;
}

async function copyTable(sqlite, table, insert, { platform = false } = {}) {
  const columns = columnsOf(sqlite, table);
  if (columns.length === 0) return { table, rows: 0 };
  const rows = sqlite.prepare(`SELECT * FROM ${quoteIdent(table)}`).all();
  if (rows.length === 0) return { table, rows: 0 };
  const placeholders = columns.map(() => '?').join(',');
  const sql = `INSERT INTO ${quoteIdent(table)} (${columns.map(quoteIdent).join(',')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;
  for (const row of rows) {
    if (platform) await pExec(sql, columns.map((column) => row[column] ?? null));
    else await execute(sql, columns.map((column) => row[column] ?? null));
  }
  return { table, rows: rows.length };
}

async function migratePlatform() {
  const sqlite = openSqlite(platformFile);
  try {
    const tables = tableNames(sqlite);
    const migrated = [];
    await platformTransaction(async () => {
      for (const table of tables) {
        if (table === 'sqlite_sequence') continue;
        migrated.push(await copyTable(sqlite, table, null, { platform: true }));
      }
    });
    const total = await pOne('SELECT COUNT(*) AS total FROM platform_companies');
    const users = await pOne('SELECT COUNT(*) AS total FROM platform_users');
    console.log(`[migracion] plataforma: ${migrated.reduce((sum, item) => sum + item.rows, 0)} filas · empresas=${total?.total ?? 0} · usuarios=${users?.total ?? 0}`);
  } finally {
    sqlite.close();
  }
}

async function migrateTenants() {
  if (!fs.existsSync(tenantsDir)) {
    console.log('[migracion] no hay directorio de tenants SQLite; nada que migrar');
    return;
  }
  const files = fs.readdirSync(tenantsDir).filter((file) => file.endsWith('.db'));
  for (const file of files) {
    const companyId = file.slice(0, -3);
    if (!/^[A-Za-z0-9_-]+$/.test(companyId)) continue;
    const sqlite = openSqlite(path.join(tenantsDir, file));
    try {
      const tables = tableNames(sqlite);
      await createTenantDb(companyId);
      const migrated = [];
      await runWithTenantAsync(companyId, async () => {
        for (const table of tables) {
          if (table === 'sqlite_sequence') continue;
          migrated.push(await copyTable(sqlite, table, null));
        }
      });
      console.log(`[migracion] tenant ${companyId}: ${migrated.reduce((sum, item) => sum + item.rows, 0)} filas`);
    } finally {
      sqlite.close();
    }
  }
}

export async function migrate() {
  console.log(`[migracion] origen SQLite: ${platformFile}`);
  console.log(`[migracion] destino PostgreSQL: ${config.dbDriver}`);
  await initPlatformDb();
  await migratePlatform();
  await migrateTenants();
  console.log('[migracion] completada');
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href : false;
if (isMain) await migrate();



