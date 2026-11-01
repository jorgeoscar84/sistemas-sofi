#!/bin/sh
# Entrypoint de producción: inicializa la plataforma la primera vez y arranca el servidor.
set -eu

PLATFORM_FILE="${PLATFORM_DB_PATH:-/app/data/platform.db}"

if [ ! -f "$PLATFORM_FILE" ]; then
  echo "[entrypoint] Primera ejecución: inicializando plataforma..."
  node apps/api/src/seed.ts
else
  echo "[entrypoint] Base de plataforma encontrada en $PLATFORM_FILE"
fi

exec node apps/api/src/server.ts
