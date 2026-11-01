# Despliegue profesional en Dokploy · Sistemas Sofi

## 0. Estado actual del despliegue

| Elemento | Valor |
|---|---|
| URL pública (verificada) | https://sistemas-sofi-hvrcwg-155996-157-180-30-98.sslip.io |
| Proyecto Dokploy | **Sistemas Sofi** · `j45SUvi0jr3TfzjJlhdgS` |
| Environment | `production` · `ch8ebRze-LLoL_xv2vGoM` |
| Aplicación | **Sistemas Sofi** · `HGw18XbgYUYl5B0XdjSPz` · `sistemas-sofi-hvrcwg` |
| Build | Dockerfile · rama `main` · auto-deploy en push |
| Volúmenes | `sistemas-sofi-data` → `/app/data`, `sistemas-sofi-storage` → `/app/storage` |
| Certificado | Let's Encrypt (válido, verificado por TLS) |
| Estado | **En línea**: `/api/health` → 200, frontend 200, login superadmin 200 |

**Acceso inicial:** usuario `superadmin`, contraseña definida en la variable
`SUPERADMIN_PASSWORD` de Dokploy (cámbiela al primer ingreso). El despliegue arrancó con
`SEED_DEMO=false`: no contiene empresas ni usuarios demo.

**Pendientes:** dominio propio (DNS), backups programados y prueba de autorización con certificado real.

## 1. Resumen

| Elemento | Valor |
|---|---|
| Repositorio | `github.com/jorgeoscar84/sistemas-sofi` |
| Ramas | `main` (producción) y `dev` (desarrollo/integración) |
| Instancia Dokploy | `https://dokploy.nexuss.top` |
| Proyecto Dokploy | **Sistemas Sofi** |
| Build | Dockerfile multi-stage simple (sin dependencias npm) |
| Persistencia | Volúmenes Docker: `/app/data` (bases de datos) y `/app/storage` (certificados) |
| Base de datos | SQLite por empresa sobre volumen persistente (decisión explicada abajo) |

## 2. Decisión de base de datos

### Por qué SQLite por empresa (esta versión)

La aplicación fue diseñada y validada con **una base SQLite aislada por empresa**
(`data/tenants/<id>.db`) + una base de plataforma (`data/platform.db`). Para este producto:

- **Aislamiento físico por RUC:** los datos de una empresa no comparten tablas con otra, lo que simplifica
  la privacidad, el borrado/archivado y los respaldos individuales.
- **Cero dependencias externas:** Node 24 incluye `node:sqlite`; no hay servidor de base de datos que
  operar, actualizar o securizar. Menos superficie de fallo.
- **Rendimiento suficiente:** la facturación electrónica tiene escrituras moderadas (decenas de miles de
  comprobantes al mes) y SQLite en modo WAL es más que suficiente en un solo VPS.
- **Respaldo y portabilidad:** `npm run backup` + volúmenes de Dokploy + copia de la carpeta `data/`;
  además permite instalaciones individuales por cliente en su propio VPS.
- **Costo operativo bajo:** un solo proceso/app para todas las empresas.

Dokploy soporta Postgres, MySQL, MariaDB, MongoDB y Redis ([docs de bases de datos](https://docs.dokploy.com/docs/core/databases)).
No se creó una base adicional porque la aplicación **no está adaptada todavía** a un cliente de red
asíncrono; agregar una base sin usarla no aporta valor y complica el respaldo.

### Cuándo migrar a PostgreSQL (ruta de escalado)

Migrar a **PostgreSQL** (plantilla de Dokploy) cuando se cumpla alguna de estas condiciones:

1. Se necesiten **varias réplicas** de la aplicación (balanceo horizontal).
2. Se requiera **alta concurrencia de escritura** o reportes analíticos multiempresa.
3. Se necesite **alta disponibilidad** con failover gestionado.
4. El volumen supere lo razonable para un solo nodo y se quiera separar datos de aplicación.

La migración profesional implicaría:
- Convertir la capa de datos (`db.ts`) a un cliente asíncrono (`pg`) o un ORM con migraciones.
- Modelar `tenant_id` + Row Level Security **o** un esquema por empresa.
- Migrar datos existentes con un script idempotente y período de convivencia.
- Actualizar pruebas y respaldos.

Esto es un proyecto aparte; hacerlo antes de validar la facturación real agregaría riesgo.

## 3. Ramas y flujo de trabajo

- `main`: rama de **producción**. Dokploy despliega desde aquí.
- `dev`: rama de **desarrollo e integración**. Los cambios se prueban aquí primero.
- Flujo: `feature/*` → `dev` → verificación → merge a `main` → despliegue.
- CI en GitHub Actions (`.github/workflows/ci.yml`): pruebas del núcleo, autodiagnóstico y validación
  de firma en cada push a `main` y `dev`.

## 4. Variables de entorno en Dokploy

| Variable | Descripción |
|---|---|
| `NODE_ENV` | `production` |
| `HOST` | `0.0.0.0` |
| `PORT` | `4000` |
| `TZ` | `America/Guayaquil` |
| `APP_NAME` | `Sistemas Sofi` |
| `JWT_SECRET` | Secreto largo y aleatorio (rotar antes de producción) |
| `SUPERADMIN_USERNAME` | Usuario inicial del superadministrador |
| `SUPERADMIN_PASSWORD` | Contraseña inicial (solo se usa al sembrar; cámbiela al ingresar) |
| `SUPERADMIN_EMAIL` | Correo del superadministrador |
| `SEED_DEMO` | `false` en producción (no crea empresas demo) |
| `PLATFORM_DB_PATH` | `/app/data/platform.db` |
| `TENANTS_DIR` | `/app/data/tenants` |
| `STORAGE_DIR` | `/app/storage` |
| `CERT_DIR` | `/app/storage/certs` |

## 5. Volúmenes

| Volumen | Montaje | Contenido |
|---|---|---|
| `sistemas-sofi-data` | `/app/data` | Plataforma + una base por empresa |
| `sistemas-sofi-storage` | `/app/storage` | Certificados `.p12`/PEM y metadatos |
| `sistemas-sofi-logs` (opcional) | `/app/logs` | Logs de la aplicación |

Sin estos volúmenes, un redeploy borra las bases y los certificados. Verificar en
**Mounts** que estén presentes antes de cargar datos reales.

## 6. Primer arranque

1. Dokploy construye la imagen y arranca el contenedor.
2. El `entrypoint.sh` detecta que no existe `platform.db` y ejecuta `apps/api/src/seed.ts`.
3. Con `SEED_DEMO=false` crea **solo el superadministrador** (usuario y contraseña de las variables).
4. El servidor queda escuchando en `0.0.0.0:4000` detrás de Traefik.

Si la base ya existe, el seed no se ejecuta: los redeploys conservan los datos.

## 7. Dominio y HTTPS

- Dominio generado por Dokploy (Traefik + Let's Encrypt) para verificación inicial.
- Para el dominio definitivo: crear registro DNS **A** hacia la IP del servidor Dokploy y actualizar el
  dominio de la aplicación; luego esperar la emisión del certificado.
- Verificar siempre con una petición HTTPS real a `/api/health`, no solo con el estado del deploy.

## 8. Respaldos

1. **Dokploy → Volume Backups** (si está disponible) para los volúmenes `*-data` y `*-storage`.
2. `docker exec` + `npm run backup` para una copia consistente dentro del contenedor.
3. Copia externa (S3/otro servidor) de `data/` y `storage/`.
4. Probar una restauración antes de operar con clientes reales.

## 9. Diagnóstico

```bash
# Desde el contenedor
node scripts/autodiagnostico.mjs
node apps/api/src/server.ts  # foreground para ver errores
```

En Dokploy revisar **Logs** (aplicación) y **Deployments** (build). Errores típicos:
- Contenedor reinicia: falta `SUPERADMIN_PASSWORD` o el volumen no tiene permisos.
- 502: el dominio apunta a un puerto distinto de 4000.
- HTTPS falla: DNS aún no resuelve al servidor.

## 10. Checklist de salida a producción

- [ ] Dominio propio con DNS apuntando a Dokploy y HTTPS verificado.
- [ ] `JWT_SECRET` y contraseña del superadministrador rotados.
- [ ] Volúmenes `data` y `storage` persistentes verificados tras un redeploy.
- [ ] Respaldo automático configurado y restauración probada.
- [ ] Certificado real del SRI cargado y prueba de autorización realizada.
- [ ] Facturación real validada con un comprobante autorizado.
