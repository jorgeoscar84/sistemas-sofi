#!/bin/sh
# Entrypoint de producción: migra SQLite una sola vez (si se solicita),
# garantiza el superadministrador inicial y arranca el servidor.
set -eu

if [ "${MIGRATE_SQLITE:-false}" = "true" ]; then
  echo "[entrypoint] Migrando datos desde SQLite a PostgreSQL..."
  node scripts/migrate-sqlite-to-postgres.mjs
fi

# Idempotente: si ya existen usuarios de plataforma, no hace nada.
echo "[entrypoint] Verificando plataforma..."
node apps/api/src/seed.ts

exec node apps/api/src/server.ts
