/**
 * Respaldo de la plataforma multiempresa.
 *
 * Copia la base de la plataforma y todas las bases de datos de empresas
 * a `backups/<fecha-hora>/`. No detiene la aplicación: para una copia
 * consistente se recomienda ejecutarlo con la app detenida.
 *
 * Uso:  node scripts/backup.mjs [directorio-destino]
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve('.');
const dataDir = path.join(root, 'data');
const platformDb = process.env.PLATFORM_DB_PATH || path.join(dataDir, 'platform.db');
const tenantsDir = process.env.TENANTS_DIR || path.join(dataDir, 'tenants');

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

const destination = path.resolve(
  process.argv[2] || path.join(root, 'backups', timestamp()),
);

if (!fs.existsSync(platformDb)) {
  console.error(`No se encontró la base de la plataforma: ${platformDb}`);
  console.error('Ejecute "npm run seed" para crearla.');
  process.exit(1);
}

fs.mkdirSync(destination, { recursive: true });

// 1) Base de plataforma (consolidando WAL en una copia consistente).
const platformCopy = path.join(destination, 'platform.db');
const source = new DatabaseSync(platformDb, { readOnly: true });
try {
  source.exec(`VACUUM INTO '${platformCopy.replace(/'/g, "''")}'`);
} finally {
  source.close();
}

// 2) Bases de cada empresa.
const tenantsDestination = path.join(destination, 'tenants');
fs.mkdirSync(tenantsDestination, { recursive: true });
let companies = 0;
if (fs.existsSync(tenantsDir)) {
  for (const file of fs.readdirSync(tenantsDir)) {
    if (!file.endsWith('.db')) continue;
    const origin = path.join(tenantsDir, file);
    const target = path.join(tenantsDestination, file);
    const tenant = new DatabaseSync(origin, { readOnly: true });
    try {
      tenant.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    } finally {
      tenant.close();
    }
    companies += 1;
  }
}

// 3) Certificados (opcional, puede contener claves privadas: proteger el destino).
const certsDir = process.env.CERT_DIR || path.join(root, 'storage', 'certs');
if (fs.existsSync(certsDir)) {
  fs.cpSync(certsDir, path.join(destination, 'certs'), { recursive: true });
}

let totalBytes = 0;
for (const entry of fs.readdirSync(destination, { recursive: true, withFileTypes: true })) {
  if (entry.isFile()) totalBytes += fs.statSync(path.join(entry.parentPath ?? entry.path, entry.name)).size;
}

console.log(`Respaldo creado en ${destination}`);
console.log(`  Empresas respaldadas: ${companies}`);
console.log(`  Tamaño total: ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
console.log('  Nota: los certificados incluyen claves privadas; proteja el directorio de respaldos.');
