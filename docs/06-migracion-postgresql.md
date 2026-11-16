# Migración a PostgreSQL 18 (multiempresa por schema)

Estado: **ejecutada en producción** el 2026-11-16. La aplicación dejó de usar SQLite como
base operativa; los archivos SQLite anteriores permanecen intactos en el volumen
`sistemas-sofi-data` como respaldo de rollback.

## 1. Arquitectura actual

```
PostgreSQL 18.7 (servicio Docker interno de Dokploy)
  base: sofi
    schema platform            ← usuarios globales, empresas/licencias, tokens y auditoría
    schema tenant_<empresa-id> ← datos aislados de cada empresa
```

- El aislamiento ya no es un archivo por empresa: es un **schema PostgreSQL por empresa**.
  `search_path` se fija por consulta y por transacción; cada request corre dentro de
  `AsyncLocalStorage` con su `companyId`.
- La capa de datos (`apps/api/src/db.ts`) es **async** y usa `pg` (producción) o
  PGlite (pruebas locales).
- `tenant_<id>` es un identificador lógico; `companyDatabasePath`/`tenantDbPath` devuelven
  el nombre del schema, no una ruta de archivo.
- El superadministrador conserva el encabezado `X-Company-Id`; el schema se selecciona
  con ese contexto y nunca por un parámetro del cliente.

### Servicios en Dokploy

| Servicio | ID / nombre | Notas |
|---|---|---|
| Aplicación | `HGw18XbgYUYl5B0XdjSPz` · `sistemas-sofi-hvrcwg` | API + web, volumen `sistemas-sofi-data` y `sistemas-sofi-storage` |
| PostgreSQL | `l3HFaFKQ0E1EafA-7vwLQ` · `sistemas-sofi-postgres-v1ne3v` | `postgres:18-alpine`, sin dominio público, puerto 5432 interno |
| Volumen PostgreSQL | `sistemas-sofi-pgdata` → `/var/lib/postgresql/data` | Persistente; PGDATA en `.../pgdata` |

La aplicación y PostgreSQL comparten la red interna de Dokploy. La base **no** está
expuesta a Internet: no tiene dominio ni puerto publicado.

## 2. Variables nuevas

| Variable | Valor / uso |
|---|---|
| `DB_DRIVER` | `postgres` (producción); `pglite` solo pruebas |
| `DATABASE_URL` | `postgresql://sofi:<clave>@sistemas-sofi-postgres-v1ne3v:5432/sofi` |
| `DB_SCHEMA_PREFIX` | `tenant_` |
| `DB_POOL_MAX` | `10` |
| `PLATFORM_DB_PATH` | Solo fuente de la migración SQLite; no se usa para operar |
| `TENANTS_DIR` | Solo fuente de la migración SQLite |
| `MIGRATE_SQLITE` | `true` **solo** durante la primera migración; retirada después |

La clave de PostgreSQL está en el entorno de Dokploy y en `data/postgres.env` del
workspace local (ignorado por git). No se versiona.

## 3. Runbook de migración (repetible)

El entrypoint de producción:

1. Si `MIGRATE_SQLITE=true`, ejecuta `scripts/migrate-sqlite-to-postgres.mjs`.
2. Ejecuta `apps/api/src/seed.ts` (idempotente: si ya hay usuarios, no hace nada).
3. Arranca `apps/api/src/server.ts`.

El migrador:

- Lee la plataforma SQLite de `PLATFORM_DB_PATH` y cada `TENANTS_DIR/*.db`.
- Crea el schema destino si no existe.
- Ordena las tablas por dependencias de claves foráneas (orden topológico) y copia
  con `INSERT ... ON CONFLICT DO NOTHING`.
- Es idempotente: puede repetirse sin duplicar filas.

Evidencia de la ejecución real (logs de Dokploy):

```
[migracion] plataforma: 10 filas · empresas=2 · usuarios=4
[migracion] tenant 00767a99e6194bd4b13bdedf: 99 filas
[migracion] tenant c793b934aef84b3cb3f4ee2d: 28 filas
[migracion] completada
```

Después de verificar, se retiró `MIGRATE_SQLITE` y se redeployó. Los redeploys ya no
migran ni ejecutan el seed destructivo (`seed` solo crea datos si la plataforma está vacía).

## 4. Verificación realizada en producción

- `GET /api/health` → `200` con `Base de datos: PostgreSQL` en los logs de arranque.
- Login del administrador de empresa (`jorgeoscar84`) → `200`, empresa **JORGE MUÑIZ OSCAR**,
  RUC `1756705784001`.
- Certificado ANFAC cargado y vigente; `hasSignature: true` y ruta del `.p12` en
  `/app/storage/certs/...`.
- Factura real **001-003-000000001**, cliente **OMNITRONEC CIA LTDA**,
  RUC `1793226293001`, total **USD 1.00**, estado `issued`, autorización
  `0311202601175670578400120010030000000016907057213`.
- Descarga del XML autorizado (`/api/vouchers/:id/xml`) y RIDE PDF
  (`/api/vouchers/:id/pdf`) → `200`.
- Dashboard, catálogo, opciones de facturación y Kardex → `200`.
- Superadministrador: login y listado de **2 empresas**; selección con `X-Company-Id`
  verificada.
- Totales de listados normalizados a número (los `COUNT/SUM` de PostgreSQL llegan como
  `int8/numeric`; se configuró el parser de `pg`).

Pruebas locales ejecutadas antes del despliegue:

- `npm test` → **20/20**.
- `npm run autodiagnostico` → **29/29** (con PGlite, sin tocar la base real).
- `tsc -p tsconfig.check.json` → sin errores.

## 5. Respaldo y rollback

### Respaldo recomendado

1. **Snapshot/Volume Backup de Dokploy** del volumen `sistemas-sofi-pgdata` (PostgreSQL)
   y `sistemas-sofi-storage` (certificados). Programarlo y probar restauración.
2. Mantener los archivos SQLite originales del volumen `sistemas-sofi-data` mientras se
   valida el período de convivencia.
3. Para un respaldo lógico, ejecutar desde un contenedor con cliente PostgreSQL 18 en la
   misma red interna:
   `pg_dump -Fc "$DATABASE_URL" -f /backups/sofi-$(date +%F).dump`.
   Restaurar con `pg_restore` en una base vacía; no restaurar sobre producción sin ventana.

### Rollback

- La versión SQLite anterior está en el historial (`main` antes de `a1f3eed`) y los
  archivos SQLite permanecen en `/app/data`.
- Para volver atrás: desplegar el commit anterior, retirar `DB_DRIVER`/`DATABASE_URL`
  del entorno (o dejarlos sin efecto en esa versión) y reiniciar.
- **Advertencia:** cualquier comprobante emitido después del corte existe solo en
  PostgreSQL; un rollback a SQLite perdería esas escrituras. Por eso el rollback es una
  medida de emergencia, no el flujo normal.
- No borrar el volumen PostgreSQL ni los archivos SQLite hasta completar el período de
  validación y un respaldo verificado.

## 6. Limitaciones y siguientes pasos

- **Respaldos automáticos**: falta programar y probar la restauración del volumen
  PostgreSQL en Dokploy.
- **SMTP por empresa**: la configuración sigue siendo central (Brevo/SMTP global); el
  siguiente hito es SMTP por empresa con credenciales aisladas.
- **Inventario/Kardex**: la migración conserva los datos; quedan mejoras de reportes y
  control de existencias.
- **Contabilidad**: se hará sobre PostgreSQL relacional, no sobre MongoDB.
- Rotar las credenciales expuestas durante las pruebas (Brevo, SMTP, contraseñas
  temporales) y mover la clave de PostgreSQL a un gestor de secretos.

