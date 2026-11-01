# Imagen de producción para la plataforma multiempresa
# Node 24 incluye node:sqlite, node:crypto y ejecución nativa de TypeScript.
FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4000 \
    TZ=America/Guayaquil

WORKDIR /app

# Sin dependencias externas: solo se copia el código.
COPY package.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY tools ./tools

# Directorios persistentes (se montan como volúmenes en Dokploy).
RUN mkdir -p /app/data /app/storage /app/logs \
    && chown -R node:node /app \
    && chmod +x /app/scripts/entrypoint.sh

USER node

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 4000) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/app/scripts/entrypoint.sh"]
