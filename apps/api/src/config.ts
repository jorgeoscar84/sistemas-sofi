import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..'); // raíz del monorepo

function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

export const config = {
  port: Number(env('PORT', '4000')),
  host: env('HOST', '127.0.0.1'),
  jwtSecret: env('JWT_SECRET', 'facturacion-ec-dev-secret-cambiar-en-produccion'),
  jwtExpiresInSeconds: Number(env('JWT_EXPIRES_IN_SECONDS', String(7 * 24 * 3600))),
  /** Base anterior (monoempresa); se conserva para migración/respaldo. */
  dbPath: env('DB_PATH', path.join(root, 'data', 'facturacion.db')),
  /** Base de la plataforma: usuarios globales, licencias y tokens. */
  platformDbPath: env('PLATFORM_DB_PATH', path.join(root, 'data', 'platform.db')),
  /** Directorio con una base de datos por empresa. */
  tenantsDir: env('TENANTS_DIR', path.join(root, 'data', 'tenants')),
  storageDir: env('STORAGE_DIR', path.join(root, 'storage')),
  certDir: env('CERT_DIR', path.join(root, 'storage', 'certs')),
  webDir: env('WEB_DIR', path.join(root, 'apps', 'web', 'static')),
  smtp: {
    host: env('SMTP_HOST', ''),
    port: Number(env('SMTP_PORT', '587')),
    user: env('SMTP_USER', ''),
    pass: env('SMTP_PASS', ''),
    from: env('SMTP_FROM', 'Facturacion EC <no-reply@facturacion.local>'),
    secure: env('SMTP_SECURE', 'false').toLowerCase() === 'true',
  },
  /** Envío por API de Brevo (la API key no es la SMTP key). */
  brevoApiKey: env('BREVO_API_KEY', ''),
  /** Certificado PEM de ejemplo para firma (modo direct-sri). */
  defaultEnvironment: Number(env('SRI_ENVIRONMENT', '1')) === 2 ? 2 : 1,
  /** Correo de la empresa para reenvíos. */
  appName: env('APP_NAME', 'Facturación Electrónica EC'),
  root,
};

for (const dir of [path.dirname(config.dbPath), config.platformDbPath ? path.dirname(config.platformDbPath) : '', config.tenantsDir, config.storageDir, config.certDir].filter(Boolean)) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export type AppConfig = typeof config;

