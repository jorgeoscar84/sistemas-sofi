# Despliegue en Dokploy

## 1. Resumen

| Elemento | Valor |
|---|---|
| URL pública | `https://sistemas-sofi-hvrcwg-155996-157-180-30-98.sslip.io` |
| Aplicación | **Sistemas Sofi** · `HGw18XbgYUYl5B0XdjSPz` · `sistemas-sofi-hvrcwg` |
| Repositorio | `github.com/jorgeoscar84/sistemas-sofi` |
| Ramas | `main` (producción) y `dev` (desarrollo/integración) |
| Instancia Dokploy | `https://dokploy.nexuss.top` |
| Proyecto Dokploy | **Sistemas Sofi** · `j45SUvi0jr3TfzjJlhdgS` · entorno `ch8ebRze-LLoL_xv2vGoM` |
| Build | Dockerfile Node 24; `npm ci --omit=dev` (dependencia de producción: `pg`) |
| Base de datos | **PostgreSQL 18** interno de Dokploy, schema por empresa |
| Persistencia | `sistemas-sofi-pgdata`, `sistemas-sofi-data`, `sistemas-sofi-storage` |

Runbook de la migración SQLite→PostgreSQL, verificación y rollback:
[`06-migracion-postgresql.md`](06-migracion-postgresql.md).

## 2. Arquitectura de datos

```
PostgreSQL 18.7 (contenedor interno, sin dominio público)
  base sofi
    schema platform            → usuarios globales, empresas/licencias, tokens, auditoría
    schema tenant_<empresa-id> → datos aislados de cada empresa
```

- El contenedor de PostgreSQL es `postgres:18-alpine`, appName
  `sistemas-sofi-postgres-v1ne3v`, aplicación Dokploy `l3HFaFKQ0E1EafA-7vwLQ`.
- No tiene dominio ni puerto publicado; la app lo alcanza por la red interna de Dokploy.
- La app fija `search_path` por consulta/transacción; no hay consultas multiempresa sin contexto.
- Los archivos SQLite anteriores permanecen en el volumen `sistemas-sofi-data` como respaldo
  de rollback; ya no son la fuente operativa.

## 3. Ramas y flujo

- `main`: producción (Dokploy despliega desde aquí).
- `dev`: desarrollo e integración.
- Flujo: `feature/*` → `dev` → pruebas/autodiagnóstico → merge a `main` → deploy.
- CI (`.github/workflows/ci.yml`): `npm ci`, pruebas, autodiagnóstico y validación de firma.

## 4. Variables de entorno

| Variable | Descripción |
|---|---|
| `NODE_ENV` | `production` |
| `HOST` / `PORT` | `0.0.0.0` / `4000` |
| `TZ` | `America/Guayaquil` |
| `JWT_SECRET` | Secreto largo y aleatorio |
| `SUPERADMIN_USERNAME` / `SUPERADMIN_PASSWORD` | Administrador inicial (rotar) |
| `SUPERADMIN_EMAIL` | Correo del superadministrador |
| `SEED_DEMO` | `false` en producción |
| `DB_DRIVER` | `postgres` |
| `DATABASE_URL` | Cadena interna `postgresql://...@sistemas-sofi-postgres-v1ne3v:5432/sofi` |
| `DB_SCHEMA_PREFIX` | `tenant_` |
| `DB_POOL_MAX` | `10` (ajustar según concurrencia) |
| `STORAGE_DIR` / `CERT_DIR` | `/app/storage` / `/app/storage/certs` |
| `PLATFORM_DB_PATH` / `TENANTS_DIR` | Solo fuente de la migración SQLite histórica |
| `MIGRATE_SQLITE` | `true` solo en la primera migración; luego retirar |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | Correo saliente (Brevo) |
| `SMTP_FROM` / `SMTP_SECURE` | Remitente verificado / TLS directo |
| `BREVO_API_KEY` | Alternativa HTTP a SMTP |

No versionar secretos. La contraseña de PostgreSQL está en Dokploy y en `data/postgres.env`
(local, ignorado por git).

## 5. Volúmenes

| Volumen | Montaje | Contenido |
|---|---|---|
| `sistemas-sofi-pgdata` | PostgreSQL `/var/lib/postgresql/data` | Base PostgreSQL (PGDATA en `.../pgdata`) |
| `sistemas-sofi-data` | App `/app/data` | SQLite histórico + respaldo de rollback |
| `sistemas-sofi-storage` | App `/app/storage` | Certificados `.p12`/PEM y metadatos |

Sin estos volúmenes, un redeploy pierde datos. Verificar **Mounts** antes de cargar datos reales.

## 6. Primer arranque y migración

1. Dokploy construye la imagen y arranca el contenedor.
2. Si `MIGRATE_SQLITE=true`, el entrypoint ejecuta
   `scripts/migrate-sqlite-to-postgres.mjs` (idempotente, orden topológico de tablas).
3. Ejecuta `apps/api/src/seed.ts`; si ya hay usuarios de plataforma, no hace nada.
4. Arranca `server.ts`, que crea el schema `platform` si falta y sirve en `0.0.0.0:4000`.

La migración real copió **2 empresas, 4 usuarios, 10 filas de plataforma y 127 filas de tenants**.
Después de verificar se retiró `MIGRATE_SQLITE`.

## 7. Dominio y HTTPS

- Dominio actual generado por Dokploy (Traefik + Let's Encrypt), verificado.
- Para dominio definitivo: registro DNS **A** a la IP del servidor, actualizar dominio de la
  aplicación y esperar el certificado.
- Verificar con una petición HTTPS real a `/api/health`; no confiar solo en el estado del deploy.

## 8. Respaldos

1. **Dokploy → Volume Backups** para `sistemas-sofi-pgdata` y `sistemas-sofi-storage`
   (programar y probar restauración).
2. Conservar los archivos SQLite del volumen `sistemas-sofi-data` hasta cerrar el período de
   validación.
3. Respaldo lógico opcional con `pg_dump -Fc` desde un contenedor con cliente PostgreSQL 18
   en la red interna; restaurar con `pg_restore` en una base vacía.
4. Probar una restauración completa antes de operar con más clientes.

## 9. Diagnóstico

- Dokploy **Logs** de la aplicación: debe mostrar `Base de datos: PostgreSQL` y
  `Schemas: tenant_<empresa>`.
- Si el contenedor reinicia: revisar `DATABASE_URL`, resolución del servicio PostgreSQL y
  `SUPERADMIN_PASSWORD`.
- 502: dominio/puerto 4000 o contenedor no saludable; revisar logs del arranque.
- Errores de migración: revisar el log del entrypoint; el migrador es idempotente y se puede
  reintentar. No borrar el volumen SQLite.

## 10. Checklist de producción

- [x] PostgreSQL 18 desplegado con volumen persistente.
- [x] Datos SQLite migrados y factura real autorizada verificada.
- [x] Login, empresa, certificado, XML, RIDE y dashboard verificados en producción.
- [x] `MIGRATE_SQLITE` retirado tras la migración.
- [ ] Respaldo automático de PostgreSQL configurado y restauración probada.
- [ ] Rotar credenciales temporales/expuestas y mover secretos a gestor.
- [ ] SMTP por empresa y dominio de correo propio.
- [ ] Dominio definitivo (opcional) y monitoreo.
