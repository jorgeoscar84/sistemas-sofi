# Contrato de la API (`/api`, v1 interna)

Convenciones: JSON, dinero en **centavos enteros** (`*Cents`), fechas ISO-8601, listas paginadas
`{ page, limit, total, data }`. Autenticación `Authorization: Bearer <jwt>`; los tests pueden usar
`Authorization: ApiToken <token>`. Errores `{ error, message, details? }` con códigos HTTP estándar.

Tipos compartidos: `packages/shared/src/types.ts` (`UserDto`, `CompanyDto`, `ClientDto`, `ProductDto`,
`WarehouseDto`, `StockVoucherDto`, `KardexRowDto`, `VoucherDto`, `DashboardDto`, `Paginated<T>`).

## Autenticación y usuarios

| Método | Ruta | Permiso | Descripción |
|---|---|---|---|
| POST | `/api/auth/login` | público | `{username,password}` → `{token,user}` |
| GET | `/api/auth/me` | sesión | Usuario actual |
| POST | `/api/auth/change-password` | sesión | `{currentPassword,newPassword}` |
| GET | `/api/users` | `users:read` | Lista paginada (`q`, `role`, `status`) |
| POST | `/api/users` | `users:write` | `{username,password,name,email,role,permissions?,status}` |
| GET | `/api/users/:id` | `users:read` | Detalle |
| PUT | `/api/users/:id` | `users:write` | Actualiza (password opcional) |
| DELETE | `/api/users/:id` | `users:write` | Baja lógica (`status=inactive`; no permitir el último admin) |
| GET | `/api/roles` | sesión | `{role,label,permissions}[]` |

Permisos usados: `invoicing:read|create|send`, `clients:read|write`, `catalog:read|write`,
`inventory:read|write`, `users:read|write`, `company:read|write`, `reports:read`, `dashboard:read`.
`admin` tiene `*`.

## Empresa, establecimientos y puntos de emisión

| Método | Ruta | Permiso |
|---|---|---|
| GET/PUT | `/api/company` | `company:read` / `company:write` |
| GET/POST | `/api/company/establishments` | `company:read/write` |
| PUT/DELETE | `/api/company/establishments/:id` | `company:write` |
| POST | `/api/company/establishments/:id/emission-points` | `company:write` |
| PUT/DELETE | `/api/company/emission-points/:id` | `company:write` |
| POST | `/api/company/certificate` | `company:write` — multipart `file` (P12) + `password` (guardar cifrado) |
| GET | `/api/company/certificate/status` | `company:read` |

`PUT /api/company` acepta `{ruc,name,tradeName,address,email,phone,obligedAccounting,rimpe,agentRetention,environment,sriMode,upconta:{baseUrl,token,ruc,estab,ptoEmi}}`.
El secuencial de cada punto de emisión se expone como `sequences: {invoice, creditNote, debitNote, retentionReceipt, waybill, salesNote}`.

## Catálogos y clientes

| Método | Ruta | Permiso |
|---|---|---|
| GET | `/api/catalogs` | sesión — catálogos SRI (`buildCatalogs()`) + `categories` + `units` |
| GET/POST | `/api/clients`, `GET/PUT/DELETE /api/clients/:id` | `clients:read|write` |
| GET | `/api/categories`, POST/PUT/DELETE `/api/categories/:id` | `catalog:read|write` |
| GET | `/api/units`, POST/PUT/DELETE `/api/units/:id` | `catalog:read|write` |

## Productos y servicios

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/products?type=product\|service&q=&categoryId=&status=&page=&limit=` | Lista con stock agregado |
| GET | `/api/products/:id` | Detalle con `stocks[]` por bodega |
| POST | `/api/products` | `{type,code,auxCode,description,categoryId,unitId,priceCents,costCents,ivaCode,iceCode,irbpnrCode,trackStock,minStock,status}` |
| PUT | `/api/products/:id` | Igual (code único por tipo) |
| DELETE | `/api/products/:id` | Baja lógica |
| GET | `/api/products/options` | Categorías, unidades, IVA/ICE para selects |
| GET | `/api/products/search?q=` | Búsqueda rápida para POS (código o descripción, limite 20) |

## Bodegas, stock, comprobantes de stock y Kardex

| Método | Ruta | Descripción |
|---|---|---|
| GET/POST | `/api/warehouses`; PUT/DELETE `/api/warehouses/:id` | CRUD bodegas |
| GET | `/api/stocks?warehouseId=&q=&lowStock=true&page=&limit=` | `{productId,code,description,warehouseId,warehouseName,amount,avgCostCents,totalCents,minStock,lowStock}` |
| GET | `/api/stock-vouchers?type=&from=&to=&page=&limit=` | Lista |
| GET | `/api/stock-vouchers/:id` | Detalle con ítems |
| POST | `/api/stock-vouchers` | `{type:'income'\|'outgoes'\|'transfer',date,warehouseId,toWarehouseId?,provider?,observation?,items:[{productId,quantity,unitCostCents?,lot?,expiresAt?}]}` → aplica stock + kardex |
| PUT | `/api/stock-vouchers/:id` | Solo si `status='draft'` (o revierte y reaplica) |
| DELETE | `/api/stock-vouchers/:id` | Revierte movimientos si es el único aplicado |
| POST | `/api/stock-vouchers/adjust` | `{warehouseId,date?,items:[{productId,targetQuantity}]}` → crea ingreso/egreso por diferencia |
| GET | `/api/kardex?productId=&warehouseId=&from=&to=&page=&limit=` | Filas `KardexRowDto` + `summary {openingQty, inQty, outQty, closingQty, closingCostCents}` |
| GET | `/api/kardex/export?...` | CSV |

Reglas de stock: ingreso → `amount += qty`, recalcula `avg_cost_cents = (costo_actual*anterior + costo_nuevo*qty)/(anterior+qty)`;
egreso → `amount -= qty` (no permitir negativo salvo configuración), costo al promedio actual; transferencia →
egreso en origen + ingreso en destino al mismo costo. Cada operación inserta filas en `stock_movements`
con saldo (`balance_qty`, `balance_cost_cents`).

## Comprobantes electrónicos (facturación)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/vouchers?docType=&status=&q=&clientId=&from=&to=&page=&limit=` | Lista `VoucherDto` |
| GET | `/api/vouchers/:id` | Detalle (ítems, pagos, info adicional, mensajes SRI) |
| POST | `/api/vouchers` | Crear/emitir factura estándar |
| POST | `/api/vouchers/:id/emit` | Emitir borrador (o reintentar `failed`/`offline`) |
| POST | `/api/vouchers/:id/retry` | Reintentar envío al SRI |
| POST | `/api/vouchers/:id/cancel` | Anular |
| DELETE | `/api/vouchers/:id` | Solo `failed` o `draft` |
| GET | `/api/vouchers/:id/xml` | XML firmado (`application/xml`) |
| GET | `/api/vouchers/:id/pdf` | RIDE PDF (`application/pdf`) |
| POST | `/api/vouchers/:id/email` | Reenviar correo |
| POST | `/api/vouchers/:id/credit-note` | `{reason, items?}` → NC que referencia la factura |
| POST | `/api/vouchers/:id/debit-note` | `{reason, items}` → ND |
| POST | `/api/quick-invoices` | Facturación rápida `{items:[{productId,quantity}],paymentMethod,clientId?}`; cliente por defecto consumidor final |
| POST | `/api/pos/sales` | POS `{items:[{productId,quantity,unitPriceCents?}],payments:[{method,amountCents}],clientId?}`; devuelve `{voucher, changeCents}` |
| GET | `/api/vouchers/options` | Tipos de doc, establecimientos, puntos de emisión, clientes, productos |

### Body de `POST /api/vouchers`

```json
{
  "docType": "01",
  "establishmentId": "...",
  "emissionPointId": "...",
  "clientId": "...",
  "issueDate": "2026-10-31",
  "currency": "DOLAR",
  "draft": false,
  "source": "standard",
  "items": [
    { "productId": "...", "quantity": 2, "unitPriceCents": 1000, "discountCents": 0, "warehouseId": "..." }
  ],
  "payments": [{ "method": "efectivo", "amountCents": 2070, "term": 0 }],
  "infoAdicional": [{ "nombre": "Orden de compra", "valor": "OC-001" }]
}
```

Cálculos: `subtotal = qty*unitPrice - discount`; IVA por tarifa del producto (`ivaCode` → `value`);
`total = subtotal + impuestos`; `sum(payments) == total` (tolerancia 0). Si `draft=true` no se emite.

### Estados

`draft` → `sent` → `issued` | `failed` | `offline`; `canceled` por anulación. Movimientos de auditoría
registrados en `audit_movements` con tipos `created`, `sending-sri`, `authorized`, `failed`, `canceled`.

## Dashboard, integración y API pública

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/dashboard` | `DashboardDto` |
| GET/PUT | `/api/integration/upconta` | Config del driver UpConta (`{baseUrl,token,ruc,estab,ptoEmi}`; el token se devuelve enmascarado) |
| POST | `/api/integration/upconta/test` | Prueba `POST {baseUrl}/v3/auth/user` con las credenciales guardadas |
| GET/POST | `/api/integration/tokens` | Tokens de integración (`{name}` → token en claro **una sola vez**) |
| DELETE | `/api/integration/tokens/:id` | Revocar |
| POST | `/api/v1/vouchers` | Igual que `POST /api/vouchers` autenticado con `ApiToken` (integrar) |
| POST | `/api/v1/vouchers/bulk` | `{vouchers: [...]}` → resultados por ítem |
| GET | `/api/v1/vouchers/:id` | Consulta para integraciones (incluye `accessKey`, `status`, `authorizationNumber`) |

## Paquete `@fe/sri` (interfaz pública que consume la API)

```ts
buildFacturaXml(input: FacturaInput): string              // XML sin firmar
buildNotaCreditoXml(input: NotaCreditoInput): string
buildNotaDebitoXml(input: NotaDebitoInput): string
buildRetencionXml(input: RetencionInput): string
buildGuiaRemisionXml(input: GuiaRemisionInput): string
signXml(xml: string, p12: Buffer, password: string): { xml: string; signingTime: string }
sendRecepcion(xmlSigned: string, ambiente: 1 | 2): Promise<SriReceptionResult>
consultarAutorizacion(claveAcceso: string, ambiente: 1 | 2): Promise<SriAuthorizationResult>
generarRidePdf(voucher: RideModel): Promise<Buffer>
createMockSriClient(): { sendRecepcion, consultarAutorizacion }  // driver mock
```

`SriReceptionResult = { estado: 'RECIBIDA' | 'DEVUELTA'; comprobantes: { claveAcceso, estado, mensajes: {identificador, mensaje, informacionAdicional, tipo}[] }[] }`
`SriAuthorizationResult = { estado: 'AUTORIZADO' | 'NO AUTORIZADO' | 'PENDIENTE'; numeroAutorizacion?, fechaAutorizacion?, comprobanteXml?, mensajes }`

La API de nuestro backend usará `@fe/sri` con el driver elegido en `company.sriMode`.

## Anexo: guías de remisión, retenciones, certificado y SRI (agregado)

### Guías de remisión (docType `06`)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/waybills/options` | Establecimientos, clientes, productos, motivos de traslado, tipos de documento de sustento |
| GET | `/api/waybills?status=&q=&from=&to=&page=&limit=` | Listado paginado |
| POST | `/api/waybills` | Crea y emite (o guarda borrador) una guía |

```json
{
  "establishmentId": "...", "emissionPointId": "...", "issueDate": "2026-11-01",
  "dirPartida": "Bodega principal, Quito",
  "transportista": { "razonSocial": "TRANSPORTES ANDINOS S.A.", "ruc": "1792456789001", "tipoIdentificacion": "04", "placa": "PBX-1234" },
  "fechaIniTransporte": "01/11/2026", "fechaFinTransporte": "02/11/2026",
  "destinatarios": [{
    "identificacion": "1752048122001", "razonSocial": "ALEJANDRO TES",
    "direccion": "Av. 6 de Diciembre N24-56, Quito", "motivoTraslado": "03",
    "codDocSustento": "01", "numDocSustento": "001-001-000000001", "numAutDocSustento": "...", "fechaEmisionDocSustento": "01/11/2026",
    "items": [{ "productId": "...", "cantidad": 2 }]
  }],
  "draft": false
}
```

El XML generado (`<guiaRemision id="comprobante" version="1.1.0">`) usa el secuencial `seq_waybill`.
La RIDE PDF incluye transportista, placa, fechas, punto de partida y bienes por destinatario.

### Comprobantes de retención (docType `07`)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/retentions/options` | Establecimientos, tipos de documento/código de sustento, retenciones de IVA y renta sugeridas |
| GET | `/api/retentions?status=&q=&from=&to=&page=&limit=` | Listado paginado |
| POST | `/api/retentions` | Crea y emite (o guarda borrador) una retención |

```json
{
  "sujeto": { "tipoIdentificacion": "04", "identificacion": "1792146141001", "razonSocial": "PROVEEDOR DEMO S.A." },
  "periodoFiscal": "10/2026",
  "docs": [{
    "codSustento": "01", "codDocSustento": "01",
    "numDocSustento": "001-001-000000123", "fechaEmisionDocSustento": "15/10/2026",
    "numAutDocSustento": "1510202601179214614100120010010000001231234567811", "pagoLocExt": "01",
    "totalSinImpuestosCents": 10000, "importeTotalCents": 11500,
    "impuestos": [{ "codImpuestoDocSustento": "2", "codigoPorcentaje": "4", "baseImponibleCents": 10000, "tarifa": 15, "valorImpuestoCents": 1500 }],
    "retenciones": [
      { "codigo": "1", "codigoPorcentaje": "303", "tarifa": 10, "baseImponibleCents": 10000 },
      { "codigo": "2", "codigoPorcentaje": "1", "tarifa": 10, "baseImponibleCents": 1500 }
    ]
  }],
  "draft": false
}
```

`totalCents` del comprobante = suma de `valorRetenidoCents`; el XML es
`<comprobanteRetencion id="comprobante" version="1.0.0">` con secuencial `seq_retention`.

### Certificado digital

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/api/company/certificate` | Acepta `{ p12Base64, password }` **o** `{ certificatePem, privateKeyPem }`; valida clave/certificado, vencimiento y guarda en `storage/certs/<RUC>/` |
| GET | `/api/company/certificate/status` | `{ hasSignature, path, certificate: { subject, issuer, validFrom, validTo, serialNumber, expired } }` |

El paquete `packages/sri` implementa lectura nativa de PKCS#12 (PBE SHA-1/3DES y PBES2/PBKDF2-AES) y firma
XAdES-BES; no requiere OpenSSL.

### Integración SRI

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/integration/sri/status` | Modo, ambiente, endpoints, certificado y nota explicativa |
| POST | `/api/integration/sri/test` | Consulta el WSDL de recepción, mide latencia y valida certificado; devuelve recomendaciones |

### Emisión `direct-sri`

El driver usa `signXml` (XAdES-BES), `sendRecepcion` y `consultarAutorizacion` (3 reintentos, 1.5 s entre ellos)
contra los endpoints de `SRI_ENDPOINTS[ambiente]`. Mapea:
`RECIBIDA` → `sent`; `AUTORIZADO` → `issued`; `DEVUELTA`/`NO AUTORIZADO` → `failed`; error de red → `offline`.
Los mensajes del SRI (`identificador`, `mensaje`, `informacionAdicional`, `tipo`) quedan en `sriMessages` y en
los movimientos de auditoría.

## Anexo 2: autorización, firma y trazabilidad (iteración 3)

### Empresa: algoritmo de firma y guardarraíl de producción

`PUT /api/company` acepta además:

```json
{
  "signatureDigest": "sha1 | sha256",
  "environment": 2,
  "confirmProduction": true
}
```

- `signatureDigest` define el algoritmo de la firma XAdES (`sha1` por compatibilidad, `sha256` moderno).
- Si se intenta pasar al ambiente `2` sin `confirmProduction: true`, la API responde **400** con una
  explicación; la UI pide confirmación explícita.

`GET /api/company` devuelve `signatureDigest`.

### Autorización del SRI

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/api/vouchers/:id/check-authorization` | Consulta `AutorizacionComprobantesOffline` para un comprobante `sent`/`offline`; si el SRI autoriza guarda número, fecha y XML autorizado. |
| GET | `/api/vouchers/:id/signature-check` | Verificación local del XML guardado: `{ valid, signatureValid, documentDigestValid, signedPropertiesDigestValid, digestAlgorithm, subject, details }`. |
| GET | `/api/vouchers/:id/sri-logs` | Bitácora de interacciones: `stage` (`recepcion`, `autorizacion`, `consulta-autorizacion`, `local-verification`), `httpStatus`, `responseXml`, `error`, `createdAt`. |

`GET /api/vouchers/:id/xml` acepta `?type=signed` (XML firmado) o `?type=authorized`
(XML devuelto por el SRI al autorizar). Sin parámetro devuelve el autorizado si existe.

Los comprobantes exponen `hasAuthorizedXml` para que la UI ofrezca la descarga.

### Tabla `sri_transactions`

```sql
CREATE TABLE sri_transactions (
  id TEXT PRIMARY KEY,
  voucher_id TEXT,
  stage TEXT NOT NULL,
  environment INTEGER NOT NULL DEFAULT 1,
  http_status INTEGER,
  request_summary TEXT,
  response_xml TEXT,
  error TEXT,
  created_at TEXT NOT NULL
);
```

Se escribe en cada paso del envío real y permite diagnosticar rechazos del SRI con la respuesta
SOAP exacta. Las emisiones en modo `mock` no generan registros.

### Firma

- `signXml(xml, { certificatePem, privateKeyPem, digestAlgorithm })` genera XAdES-BES conforme:
  `SignedInfo`/`SignedProperties` canónicos, certificado en DER base64, referencia a
  `SignedProperties` con `Type` XAdES, SHA-1 o SHA-256.
- `verifySignedXml(xml)` recalcula digests y RSA; el emisor bloquea el envío si falla.
- `npm run verify:signature` valida los 5 comprobantes con el validador XMLDSig del JDK
  (`tools/ValidarFirma.java`), independiente de nuestra implementación.

## Anexo 3: API de plataforma (superadministrador)

Todas requieren sesión con rol `superadmin`. Las operaciones sobre una empresa usan la cabecera
`X-Company-Id` cuando aplican.

| Método | Ruta | Cuerpo / notas |
|---|---|---|
| GET | `/api/platform/overview` | Totales: empresas, estados, usuarios, comprobantes, productos |
| GET | `/api/platform/companies` | Empresas con licencia, configuración SRI y métricas |
| POST | `/api/platform/companies` | Crea empresa + licencia + administrador + base aislada |
| GET | `/api/platform/companies/:id` | Detalle, usuarios, métricas y configuración |
| PUT | `/api/platform/companies/:id/license` | `{status, plan, expiresAt, notes, paymentReference}` |
| POST | `/api/platform/companies/:id/activate` | `{months, paymentReference}` (liberación por pago) |
| POST | `/api/platform/companies/:id/users` | `{username, password, name, email, role}` |
| POST | `/api/platform/companies/:id/reset-admin-password` | `{userId?, password}` |
| GET | `/api/platform/companies/:id/audit` | Auditoría de la licencia (últimos 100 eventos) |

### Creación de empresa

```json
{
  "ruc": "0105000001001",
  "name": "INDUSTRIAS ANDINAS DEL SUR S.A.",
  "tradeName": "ANDISUR",
  "email": "admin@andisur.ec",
  "phone": "07-000-0000",
  "address": "Av. Las Américas 100, Cuenca",
  "plan": "basico",
  "licenseStatus": "trial",
  "trialDays": 15,
  "licenseNotes": "Demo comercial",
  "paymentReference": null,
  "adminUsername": "andisur_admin",
  "adminPassword": "clave-segura",
  "adminName": "Administrador ANDISUR",
  "adminEmail": "admin@andisur.ec"
}
```

Respuesta: datos de la empresa/licencia, administrador creado y credenciales para entregar al cliente.
La empresa queda operativa en modo simulado con establecimiento `001`, punto de emisión `001`, bodega
`BOD01`, unidades/categorías SRI y cliente CONSUMIDOR FINAL.

### Autenticación multiempresa

- `POST /api/auth/login` devuelve `{token, user, company, license}`. Si la licencia está suspendida o
  vencida responde **403** con el motivo.
- `GET /api/auth/me` devuelve `{user, company, license, companies, isSuperadmin}`; `companies` sólo se
  completa para el superadministrador.
- El JWT identifica al usuario; la empresa y la licencia se validan en cada petición.

### Aislamiento

- Bases separadas: no existe una consulta SQL que pueda devolver datos de otra empresa.
- La cabecera `X-Company-Id` sólo la respeta el rol `superadmin`.
- Los tokens de API (`platform_api_tokens`) están ligados a una empresa y se validan contra su licencia.
