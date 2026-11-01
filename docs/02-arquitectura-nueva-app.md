# Arquitectura de la nueva aplicación (`facturacion-ec`) — implementada

Aplicación de facturación electrónica para Ecuador inspirada en la arquitectura del servicio identificado
en [`01-arquitectura-servicio-upconta.md`](01-arquitectura-servicio-upconta.md).

> **Decisión de implementación (importante):** el entorno de trabajo no permitía instalar paquetes de npm
> de forma fiable, por lo que la aplicación final se implementó **sin dependencias externas** usando sólo
> capacidades nativas de Node.js 24. Esto la hace ejecutable y verificable en cualquier máquina.

## Stack final

| Capa | Tecnología |
|---|---|
| Backend | Node.js 24 nativo: `node:http` (router propio), `node:sqlite`, `node:crypto`, TypeScript ejecutado nativamente |
| Autenticación | JWT HS256 propio + hash `scrypt` + tokens de integración (`ApiToken`) + roles/permisos |
| XML/firma | Paquete `packages/sri`: XML SRI, **XAdES-BES** con `node:crypto`, cliente SOAP por `fetch`, RIDE PDF propio |
| Frontend | SPA *vanilla JS* (ESM) servida estáticamente: router hash, componentes propios, CSS propio |
| Base de datos | SQLite (`data/facturacion.db`), dinero en **centavos enteros** |
| Build | **Ninguno** (no hace falta compilar ni instalar) |

## Estructura real

```
facturacion-ec/
├── apps/
│   ├── api/
│   │   ├── src/
│   │   │   ├── server.ts        # arranque: API + frontend estático
│   │   │   ├── http.ts          # router, JWT, permisos, respuestas, archivos
│   │   │   ├── db.ts            # wrapper node:sqlite + auditoría
│   │   │   ├── config.ts        # configuración por variables de entorno
│   │   │   ├── seed.ts          # datos de demostración
│   │   │   ├── db/schema.sql    # esquema completo
│   │   │   └── modules/         # auth, company, clients, catalog, inventory, invoicing, dashboard, integration
│   │   └── test/core.test.ts    # 12 pruebas (node:test)
│   └── web/static/              # SPA sin build
│       ├── index.html, styles.css, app.js, lib.js
│       └── pages/               # dashboard, clients, catalog, inventory, admin, invoicing, quick, pos
├── packages/
│   ├── shared/src/              # catálogos SRI, clave de acceso (módulo 11), dinero, tipos
│   └── sri/src/                 # xml.ts, sign.ts (XAdES), soap.ts, mock.ts, ride.ts, pdf.ts
└── docs/                        # RE + contrato + documentación de la API identificada
```

## Flujo de emisión (implementado)

1. `POST /api/vouchers` valida el comprobante, calcula totales con IVA por tarifa y **pagos = total**.
2. En la emisión: reserva el **secuencial** del punto de emisión y construye la **clave de acceso** de 49
   dígitos (módulo 11), genera el **XML** (`packages/sri/src/xml.ts`).
3. Driver de emisión según `company.sriMode`:
   - `mock`: recepción/autorización simuladas (por defecto; usado por el seed y las pruebas).
   - `direct-sri`: firma **XAdES-BES** con el PEM de la empresa → `sendRecepcion` → `consultarAutorizacion`
     (3 reintentos) → estados `issued|sent|failed|offline`.
   - `upconta`: `POST {baseUrl}/v3/administrative/invoices` con el token de integración del mismo servicio
     identificado durante la ingeniería inversa.
4. Al autorizar: registra auditoría, descuenta **stock** (Kardex) y permite descargar **RIDE PDF** y **XML**.

## Inventario / Kardex (implementado)

- `stocks(product_id, warehouse_id, amount, avg_cost_cents)` = saldo y costo promedio ponderado por bodega.
- `stock_vouchers` + `stock_voucher_items`: ingreso, egreso, transferencia y ajuste (por cantidad objetivo).
- `stock_movements`: filas de Kardex con entradas/salidas, costo unitario, saldo y saldo valorado.
  El costo promedio se recalcula en cada ingreso: `nuevo_costo = (costo_actual*cant + costo_ingreso*cant_ingreso)/(cant+nueva)`.
- Reporte: `GET /api/kardex?productId=&warehouseId=&from=&to=` + exportación CSV.
- Al eliminar un comprobante de stock se recalculan los saldos del producto/bodega.

## Roles y permisos (implementado)

`admin` (`*`), `facturador` (emisión/clientes), `inventario` (catálogo/inventario), `contador` (lectura).
Se aplican en el router con `requirePermission` y se reflejan en la UI.

## Modos de facturación (implementados)

1. **Estándar** (`/invoicing/new`): cliente, ítems, impuestos, pagos múltiples, info adicional, borrador/emitir.
2. **Facturación rápida** (`/quick-billing`): consumidor final, ítems y pago único con vuelto.
3. **Punto de venta** (`/pos`): carrito, pagos múltiples y vuelto.
4. **Borrador** (`draft: true`) y emisión posterior (`/api/vouchers/:id/emit`).
5. **API de integración** (`POST /api/v1/vouchers` con `Authorization: ApiToken …`, y `/bulk`).
6. **Notas de crédito/débito** desde el detalle de una factura.

## Verificación

- `npm test` → 12/12 pruebas (clave de acceso, identificación, login, catálogo, costo promedio, emisión mock,
  correlativo, borrador, nota de crédito, RIDE/XML, Kardex/ajuste, dashboard y token de API).
- Verificación visual con **REA** (browser automatizado) contra `http://127.0.0.1:4000`: login, dashboard con
  datos reales y navegación entre módulos.

## Anexo: comprobantes especiales, PKCS#12 y SRI real (iteración 2)

### Nuevos módulos

| Módulo | Backend | Frontend |
|---|---|---|
| Guía de remisión (`06`) | `POST/GET /api/waybills`, `/api/waybills/options`; XML `<guiaRemision>`; RIDE propio | `pages/waybills.js` (listado, formulario con transportista/destinatarios/bienes, detalle) |
| Comprobante de retención (`07`) | `POST/GET /api/retentions`, `/api/retentions/options`; XML `<comprobanteRetencion>`; RIDE propio | `pages/retentions.js` (listado, formulario con sujeto/documento de sustento/retenciones, detalle) |
| Certificado digital | `POST /api/company/certificate` (PKCS#12 o PEM), `GET .../status` con metadatos | Empresa y SRI → carga de `.p12`, contraseña, estado y vencimiento |
| SRI real | `GET /api/integration/sri/status`, `POST /api/integration/sri/test`; driver `direct-sri` | Integraciones → panel SRI con ambiente/modo, endpoints y botón de prueba |

### Persistencia

Se agregó la columna `vouchers.extra_json` (migración automática en `initDb`) que guarda los datos propios de
cada tipo: `transportista`, `dirPartida`, fechas y `destinatarios[]` para la guía; `sujeto`, `periodoFiscal` y
`docs[]` (con impuestos y retenciones) para el comprobante de retención. La RIDE usa esos datos para renderizar
el documento y el XML se reconstruye desde ellos al emitir.

### Firma y certificados sin dependencias

- `packages/sri/src/asn1.ts`: lector/escritor DER.
- `packages/sri/src/p12.ts`: lector PKCS#12 (SafeBags, PBE SHA-1/3DES, PBES2/PBKDF2-AES), validación
  certificado↔clave y metadatos X.509.
- `packages/sri/src/testcert.ts`: generador de certificados autofirmados y de un PKCS#12 de prueba
  (útil para probar sin OpenSSL ni entidad certificadora).
- `packages/sri/src/sign.ts`: `signingMaterialFromP12()` usa el lector nativo; la firma XAdES-BES se mantiene.

### Verificación

- `npm test` → 15/15 pruebas (incluye guía, retención, PKCS#12 y firma verificable).
- Prueba real contra `celcer.sri.gob.ec`: factura firmada → recepción → respuesta del SRI `DEVUELTA` con
  mensaje `35` (RUC no registrado). Estado y mensajes quedan guardados en el comprobante.

## Anexo 2: emisión real, firma verificable y operación

### Firma electrónica conforme
- Canonicalización XMLDSig C14N: `SignedInfo` y `SignedProperties` se firman sobre su forma canónica
  (namespaces explícitos, atributos ordenados, etiquetas vacías expandidas).
- Certificado embebido en DER base64; XAdES-BES con `SigningTime`, `SigningCertificate`
  (CertDigest + IssuerSerial) y `SignaturePolicyImplied`.
- Algoritmos configurables por empresa: **RSA-SHA1** (compatibilidad) y **RSA-SHA256**.
- `verifySignedXml()` recalcula digests y RSA; el emisor **no envía al SRI** si la verificación falla.
- Validación externa con el validador XMLDSig del JDK: `tools/ValidarFirma.java`,
  `npm run verify:signature` / `npm run verify:signature:sha256`.

### Certificados
- PKCS#12 moderno (PBE SHA-1/3DES, PBES2/PBKDF2-AES) y **legacy con RC2** (128 y 40 bits).
- RC2 implementado desde cero y verificado con los 8 vectores del RFC 2268.
- Validación de correspondencia certificado↔clave, vencimiento y metadatos X.509.

### Ciclo de autorización
- Estados: `draft → sent → issued` / `failed` / `offline`.
- `POST /api/vouchers/:id/check-authorization` consulta el SRI y actualiza el comprobante
  (útil cuando la primera consulta quedó `PENDIENTE` o el envío quedó `offline`).
- El **XML autorizado** devuelto por el SRI se guarda en `xml_authorized` y se descarga con
  `GET /api/vouchers/:id/xml?type=authorized`.
- `GET /api/vouchers/:id/signature-check` expone la verificación de firma del XML guardado.
- `GET /api/vouchers/:id/sri-logs` devuelve la bitácora de llamadas SOAP y respuestas crudas.

### Guardarraíles de producción
- Cambio al ambiente 2 exige `confirmProduction=true` y confirmación en la UI.
- Emisión en `direct-sri` exige RUC de 13 dígitos, certificado presente y firma verificada.
- Toda interacción con el SRI queda auditada en `sri_transactions`.

## Anexo 3: plataforma multiempresa y licencias

### Decisión de arquitectura

Se pasó de una instalación monoempresa a una **plataforma multiempresa** con aislamiento físico:

- `data/platform.db`: usuarios globales, empresas/licencias, tokens de API y auditoría de plataforma.
- `data/tenants/<id>.db`: una base SQLite por empresa con **todos** sus datos (configuración, catálogo,
  inventario, comprobantes, certificado, bitácora SRI y auditoría).

El contexto de empresa se propaga por petición con `AsyncLocalStorage` (`db.ts`): el router autentica,
resuelve la empresa activa y abre la base correspondiente. Ningún módulo de negocio necesita reescribir
sus consultas para filtrar por empresa; no puede acceder a otra base por diseño.

### Roles y acceso

| Rol | Alcance |
|---|---|
| `superadmin` | Plataforma completa: licencias, empresas, usuarios, configuración de cualquier empresa |
| `admin` | Su empresa: catálogo, inventario, comprobantes, usuarios y SRI |
| `facturador` | Emisión y clientes de su empresa |
| `inventario` | Catálogo e inventario de su empresa |
| `contador` | Consulta y reportes de su empresa |

El superadministrador opera sobre una empresa concreta con la cabecera `X-Company-Id` (selector en la UI).
Los usuarios normales siempre quedan fijados a su empresa; la cabecera se ignora para ellos.

### Licencias

- `trial`, `active`, `suspended`, `expired`; con plan, vencimiento, notas y referencia de pago.
- Al crear una empresa se aprovisiona su base, su configuración mínima (establecimiento, punto de
  emisión, bodega, unidades, categorías y consumidor final) y su **usuario administrador**.
- Autenticación bloquea a los usuarios cuando la licencia no es usable; el superadministrador conserva
  acceso para reactivar o corregir.
- `POST /api/platform/companies/:id/activate` es el punto de integración para liberar/renovar licencia
  automáticamente al detectar un pago.

### Operación

- `npm run backup` respalda la plataforma y todas las empresas (con `VACUUM INTO` para copias consistentes).
- Una instalación por VPS o una instancia central con varias empresas usan el mismo código.
