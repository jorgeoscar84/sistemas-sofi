# Facturación Electrónica EC · Plataforma multiempresa

Aplicación de **facturación electrónica para Ecuador** con arquitectura **multiempresa**: un
**superadministrador** crea empresas/licencias, cada empresa opera con su **RUC** y su información
completamente **aislada** (schema propio en PostgreSQL), y cada empresa tiene su **administrador** y roles.

La emisión es **desarrollo propio con integración directa al SRI** (clave de acceso, XML según fichas
técnicas, firma **XAdES-BES**, SOAP de recepción/autorización), verificada contra el SRI real y con un
validador XMLDSig externo. Ver [`docs/01-arquitectura-servicio-upconta.md`](docs/01-arquitectura-servicio-upconta.md).

## Arquitectura multiempresa

```
PostgreSQL 18
  schema platform            ← usuarios globales, empresas/licencias y tokens de API
  schema tenant_<empresa-id> ← TODA la información de una empresa (catálogo, inventario,
                                comprobantes, certificado, configuración SRI, bitácora SRI)
```

- Cada empresa se aprovisiona con **su propio schema PostgreSQL** (`tenant_<id>`): el aislamiento
  se aplica por `search_path` en cada consulta/transacción y por el contexto de la petición.
- El **superadministrador** (rol `superadmin`) ve la plataforma: crea licencias, activa/suspende/renueva,
  asigna administradores y puede entrar a configurar cualquier empresa.
- El **administrador de empresa** (`admin`) sólo ve su empresa.
- Los usuarios **nunca** ven datos de otra empresa; las claves de API también son por empresa.

## Inicio rápido

```bash
# 1) Sembrar la plataforma (superadmin + 2 empresas demo)
npm run seed

# 2) Iniciar API + frontend en un solo proceso
npm start
```

Abrir **http://127.0.0.1:4000**

| Acceso | Usuario | Contraseña | Alcance |
|---|---|---|---|
| Superadministrador de la plataforma | `superadmin` | `superadmin123` | Todas las empresas / licencias |
| Empresa demo 1 (COMERCIAL DEMO S.A.) | `admin` | `admin123` | Su empresa (datos demo completos) |
| Empresa demo 2 (DISTRIBUIDORA DEL PACÍFICO S.A.) | `dispa` | `dispa123` | Su empresa (vacía, licencia de prueba) |
| Roles demo 1 | `facturador` / `inventario` / `contador` | `*123` | Según permisos |

> Cambie `superadmin123` y las credenciales demo antes de publicar la aplicación en internet.

## Crear una empresa / liberar una licencia

**Desde la interfaz:** inicie sesión como `superadmin` → **Licencias y empresas** → **＋ Nueva empresa / licencia**.
Se crean en un paso: la licencia, la base de datos aislada y el **usuario administrador** de la empresa.
El sistema muestra las credenciales una sola vez para entregarlas al cliente.

**Desde la API:**

```bash
curl -X POST http://127.0.0.1:4000/api/platform/companies \
  -H "Authorization: Bearer <token-superadmin>" -H "Content-Type: application/json" \
  -d '{
    "ruc": "0105000001001",
    "name": "INDUSTRIAS ANDINAS DEL SUR S.A.",
    "tradeName": "ANDISUR",
    "email": "admin@andisur.ec",
    "plan": "basico",
    "licenseStatus": "trial",
    "trialDays": 15,
    "adminUsername": "andisur_admin",
    "adminPassword": "una-clave-segura",
    "adminName": "Administrador ANDISUR"
  }'
```

### Licencias y pago

- Estados: `trial` (prueba), `active` (activa), `suspended` (suspendida), `expired` (vencida).
- `PUT /api/platform/companies/:id/license` permite cambiar estado, plan, vencimiento y notas.
- `POST /api/platform/companies/:id/activate` renueva la licencia indicando `months` y
  `paymentReference`. **Este es el gancho para automatizar la liberación cuando se detecte un pago**
  (integrar pasarela/transferencia → llamar este endpoint).
- Si la licencia está suspendida o vencida, los usuarios de la empresa no pueden ingresar; el
  superadministrador sí puede entrar a corregir/configurar.
- Cada empresa nueva arranca en modo **simulado** para poder probar la facturación sin certificado.

## Facturación electrónica

- Facturas, notas de crédito y débito, **guías de remisión** y **comprobantes de retención**.
- Productos/servicios, clientes, categorías/unidades y **Kardex** con costo promedio ponderado.
- **Modos de emisión:** `mock` (simulado), `direct-sri` (firma XAdES + SOAP real) y `upconta`
  (servicio identificado en la ingeniería inversa, sólo como alternativa).
- **Firma verificable:** antes de enviar al SRI el sistema verifica el XML firmado; el validador
  XMLDSig del JDK confirma los 5 tipos de comprobante con SHA-1 y SHA-256.
- **Bitácora SRI:** cada llamada SOAP y su respuesta cruda quedan registradas por comprobante.

### Configurar el SRI de una empresa

1. El administrador de la empresa entra en **Empresa y SRI** y carga su certificado
   **PKCS#12 (.p12/.pfx)** o PEM (soporta 3DES, AES y RC2 antiguos).
2. En **Integraciones → SRI** elige ambiente (1 pruebas / 2 producción) y modo `direct-sri`.
3. Prueba la conexión y emite. En producción se pide confirmación explícita.

### Probar la facturación real

```bash
npm run probar:emision
```

Emite una factura con la empresa del usuario indicado, muestra estado, clave de acceso, autorización,
verificación de firma y las interacciones con el SRI.

## Comandos

| Comando | Descripción |
|---|---|
| `npm run seed` | Crea la plataforma y las empresas demo (no borra datos si ya existen) |
| `npm run seed -- --force` | **Borra** bases de plataforma/empresas y vuelve a sembrar |
| `npm start` | Inicia API + frontend |
| `npm test` | Pruebas del núcleo (20) |
| `npm run autodiagnostico` | Autodiagnóstico aislado de todo el sistema (no toca tus datos) |
| `npm run autodiagnostico:sri` | Autodiagnóstico + conectividad y emisión real contra el SRI |
| `npm run verify:signature` | Valida la firma de los 5 comprobantes con el XMLDSig del JDK |
| `npm run verify:signature:sha256` | Igual con SHA-256 |
| `npm run probar:emision` | Emite una factura real y muestra el resultado del SRI |
| `npm run backup` | Respaldo de los datos SQLite históricos (solo legado) |
| `npm run reset-db` | Elimina las bases SQLite históricas (no toca PostgreSQL) |

## API de la plataforma (superadministrador)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/platform/overview` | Totales de la plataforma |
| GET | `/api/platform/companies` | Empresas/licencias con métricas y configuración |
| POST | `/api/platform/companies` | Crea empresa + licencia + administrador + base aislada |
| GET | `/api/platform/companies/:id` | Detalle, usuarios y métricas de una empresa |
| PUT | `/api/platform/companies/:id/license` | Edita estado, plan, vencimiento, notas |
| POST | `/api/platform/companies/:id/activate` | Activa/renueva (pago) |
| POST | `/api/platform/companies/:id/users` | Agrega usuarios a una empresa |
| POST | `/api/platform/companies/:id/reset-admin-password` | Restablece contraseña |
| GET | `/api/platform/companies/:id/audit` | Auditoría de la licencia |

El superadministrador opera sobre una empresa enviando la cabecera `X-Company-Id: <empresa-id>`.

## Pruebas y calidad

- Guía completa de pruebas: [`docs/04-guia-de-pruebas.md`](docs/04-guia-de-pruebas.md).
- `npm run autodiagnostico` levanta una instancia aislada y verifica plataforma, licencia, catálogo,
  inventario, factura, notas, guía, retención, usuarios, aislamiento, certificado y firma.
- `npm run autodiagnostico:sri` incluye conectividad y emisión real contra el SRI (requiere internet).
- Resultado actual: **29/29** verificaciones del autodiagnóstico (31/31 con SRI real) y **20/20** pruebas del núcleo.

## Respaldo y despliegue

- **Respaldo de producción:** volumen PostgreSQL `sistemas-sofi-pgdata` (Dokploy Volume Backup)
  y volumen de certificados `sistemas-sofi-storage`. Los archivos SQLite anteriores se conservan
  en `sistemas-sofi-data` como respaldo de rollback.
- Runbook completo: [`docs/06-migracion-postgresql.md`](docs/06-migracion-postgresql.md).
- **VPS propio:** un solo proceso atiende a todas las empresas; PostgreSQL se ejecuta como
  servicio interno de Dokploy, sin exponer el puerto 5432 a Internet.
- Variables principales: `PORT`, `HOST`, `JWT_SECRET`, `DB_DRIVER`, `DATABASE_URL`,
  `DB_SCHEMA_PREFIX`, `STORAGE_DIR`, `CERT_DIR`, `SRI_TIMEOUT_MS`.

## Seguridad recomendada antes de producción

1. Cambiar `JWT_SECRET` y la contraseña de `superadmin`.
2. Publicar detrás de HTTPS (proxy inverso) y restringir acceso al panel de plataforma.
3. Configurar respaldos automáticos del directorio `data/`.
4. Definir un proceso de pago → `activate` (webhook o conciliación manual).

## Estructura

```
apps/
  api/src/
    db/schema-platform.sql    plataforma (usuarios, licencias, tokens)
    db/schema.sql             esquema de una empresa
    db.ts                     contexto multiempresa (AsyncLocalStorage)
    provisioning.ts           creación de empresas/licencias y datos iniciales
    licensing.ts              estados y vencimientos de licencia
    http.ts                   router, JWT, permisos, tenant activo
    modules/                  auth, company, catalog, inventory, invoicing,
                              dashboard, integration y platform (superadmin)
  web/static/                 SPA sin build (app.js, lib.js, pages/platform.js, …)
packages/
  shared/src/                 catálogos SRI, clave de acceso, dinero
  sri/src/                    XML, XAdES-BES, PKCS#12 (3DES/AES/RC2), SOAP, RIDE
scripts/                      verificador de firma, prueba de emisión, respaldo
docs/                         ingeniería inversa, arquitectura, contrato de API y evidencias
```

## Limitaciones conocidas

- El envío de correo con PDF/XML está implementado como registro, pero no hay servidor SMTP configurado.
- Para autorizar comprobantes se requiere un certificado emitido por una entidad autorizada y un RUC
  habilitado en el ambiente del SRI (el certificado autofirmado sólo prueba el flujo).
- El pago de licencias es manual/mediante API; la integración automática con pasarelas queda como
  siguiente paso (el endpoint `activate` ya está listo para eso).

## Mantener el servidor en un VPS

En este entorno de desarrollo los procesos pueden terminar al cerrar la sesión; en un servidor real use un
gestor de procesos. Ejemplos:

```bash
# Opción 1: PM2 (recomendado)
npm i -g pm2
pm2 start "node apps/api/src/server.ts" --name facturacion-ec
pm2 save
pm2 startup

# Opción 2: proceso independiente con logs y PID
npm run start:fondo     # inicia en segundo plano (logs/servidor.log)
npm run stop            # detiene el proceso

# Opción 3: servicio systemd
# /etc/systemd/system/facturacion-ec.service
# [Service]
# WorkingDirectory=/opt/facturacion-ec
# ExecStart=/usr/bin/node apps/api/src/server.ts
# Restart=always
# Environment=PORT=4000
# Environment=JWT_SECRET=cambiar-en-produccion
```

Recuerde abrir el puerto en el firewall y poner HTTPS con un proxy inverso (Nginx/Caddy).


## Despliegue en producción (Dokploy)

El proyecto está preparado para desplegarse en **Dokploy** con Docker:

- `Dockerfile` en la raíz (Node 24 + PostgreSQL 18 vía `pg`).
- Volúmenes persistentes: `/app/data` (archivos SQLite históricos de rollback) y `/app/storage` (certificados).
- PostgreSQL corre como servicio interno de Dokploy con volumen `sistemas-sofi-pgdata`.
- `SEED_DEMO=false` para producción: solo crea el superadministrador definido por variables.
- `HOST=0.0.0.0`, `PORT=4000`, healthcheck en `/api/health`.

Guía de despliegue: [`docs/05-despliegue-dokploy.md`](docs/05-despliegue-dokploy.md).
Runbook de migración: [`docs/06-migracion-postgresql.md`](docs/06-migracion-postgresql.md).

### Ramas

- `main`: producción (la despliega Dokploy).
- `dev`: desarrollo e integración; se prueba antes de pasar a `main`.
- CI en GitHub Actions ejecuta pruebas, autodiagnóstico y validación de firma en ambas ramas.

### Base de datos

La plataforma usa **PostgreSQL 18** con un **schema por empresa** (`tenant_<id>`) y un schema
`platform` para licencias/usuarios. La aplicación usa un pool `pg` y fija `search_path` por
consulta/transacción; el aislamiento no depende de un filtro manual. Ver el runbook de migración
para respaldo, rollback y operación.


