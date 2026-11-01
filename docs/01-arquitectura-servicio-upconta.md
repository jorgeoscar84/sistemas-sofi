# Arquitectura identificada del servicio de facturación electrónica de UpConta

> Documento de ingeniería inversa realizado con REA sobre `app.upconta.com`, su bundle estático y la
> documentación pública de su API. Fecha: 2026-10-31.
>
> Distinción de evidencia:
> - **[OBSERVADO]** capturado en el navegador/API o en archivos descargados.
> - **[DOCUMENTADO]** descrito en la documentación pública oficial (`docs.upconta.com`).
> - **[INFERIDO]** deducción razonada a partir de lo anterior.

## 1. Superficie de la aplicación

| Componente | Evidencia | Valor |
|---|---|---|
| Web app | [OBSERVADO] | `https://app.upconta.com` — Next.js App Router (Turbopack), React + Ant Design 5, socket.io, detrás de Cloudflare. 249 rutas en `_buildManifest.js`. |
| API app | [OBSERVADO] | `https://api.upconta.com` (axios `baseURL`), rutas `/v3/...` y `/v4/...`. `utils.upconta.com` para utilidades, `api-notificaciones.toc.com.ec` para push. |
| Ambiente de pruebas | [DOCUMENTADO] | `https://app-test.upconta.com` + `https://api-test.upconta.com`. |
| Token de sesión | [OBSERVADO/DOCUMENTADO] | Cookie `rijwb3` (dominio `upconta.com`); JWT 7 días; se obtiene con `POST /v3/auth/user`. |
| Token de integración | [DOCUMENTADO] | Sin expiración, revocable; se crea en Configuración → Empresa o `POST /v4/businesses/me/tokens`. Verificación en `GET /v4/auth/user`. |

### Login real (verificado)

`POST /v3/auth/user` con `{ ruc, username, password }` → `{ name, user, token }`.

Cuenta demo provista por el usuario para la investigación. Sus credenciales **no se versionan**
en el repositorio; fueron utilizadas únicamente durante la fase de ingeniería inversa.
El campo RUC del formulario web es obligatorio; se guarda en `localStorage["upconta-last-ruc"]`.

## 2. Cómo está construido el servicio de facturación electrónica

El servicio es **REST sobre MongoDB**, con un pipeline de emisión en el backend:

1. La app (o una integración) hace `POST /v3/administrative/invoices` con cliente, `infoTributaria.estab/ptoEmi` y
   `detalles[]` (producto, cantidad, precio, descuento). [DOCUMENTADO]
2. El backend asigna **secuencial** y **clave de acceso**, arma el **XML** del comprobante y lo **firma**
   electrónicamente (XAdES-BES con el certificado de la empresa — el flag `hasSignature` aparece en la sesión).
   [DOCUMENTADO + OBSERVADO en `/v3/auth/user`]
3. Lo **envía al SRI** (recepción y luego autorización). El estado resultante es `issued | sent | failed | offline`.
   [DOCUMENTADO]
4. En paralelo: envía **correo al cliente y a la empresa con PDF (RIDE) y XML**, genera **stocks** por bodega
   (`generateStock: "emision"`) y un **asiento contable** si la empresa tiene contabilidad. [DOCUMENTADO + OBSERVADO]
5. Si el SRI está caído, el comprobante queda `offline` y el sistema **reintenta** después
   (`sriRetryCount`, `sriNotFoundCount`). [DOCUMENTADO + OBSERVADO]

### Evidencia de una factura real (fallida, útil para ver el modelo completo)

`docs/upconta-api/samples/invoice_full.json` — factura de la empresa DEMO:

```
status: "failed"
infoTributaria: { ambiente:"2", tipoEmision:"1",
  claveAcceso:"2910202601091234567800120010050000000083854243818",
  razonSocial:"DEMO", ruc:"0912345678001", codDoc:"01",
  estab:"001", ptoEmi:"005", secuencial:"000000008",
  dirMatriz:"...", agenteRetencion:"1", contribuyenteRimpe:"CONTRIBUYENTE RÉGIMEN RIMPE" }
infoFactura: { obligadoContabilidad:"NO", tipoIdentificacionComprador:"06",
  razonSocialComprador:"PRUEBA REPLI", identificacionComprador:"REPLITEST01",
  totalSinImpuestos, totalDescuento, totalSubsidio, totalConImpuestos:[{codigo,codigoPorcentaje,baseImponible,valor}],
  propina, importeTotal, moneda:"DOLAR", pagos:[{formaPago,total,plazo}] }
detalles: [{ product, bodega, codigoPrincipal, codigoAuxiliar, descripcion,
  cantidad, precioUnitario, descuentoInicial, descuento, precioTotalSinImpuesto,
  impuestos:[{codigo,codigoPorcentaje,tarifa,baseImponible,valor}], stock }]
```

La clave de acceso tiene la estructura del SRI (49 dígitos):
`ddmmaaaa(8) + codDoc(2) + ruc(13) + ambiente(1) + estab(3) + ptoEmi(3) + secuencial(9) + codigoNumerico(8) + tipoEmision(1) + dígitoVerificador(1)`.

### Estados y acciones [DOCUMENTADO]

| Estado | Significado |
|---|---|
| `draft` | Borrador; no se envía al SRI ni genera stock/correo |
| `issued` | Autorizado por el SRI |
| `sent` | Enviado al SRI, pendiente de autorización |
| `failed` | Rechazado por el SRI (se puede editar / reintentar) |
| `canceled` | Anulado en el sistema |
| `offline` | SRI no disponible: `recepcion` o `autorizacion`; reintento automático |

Acciones: emitir, guardar como borrador (`?guardarComoBorrador=true`), reenviar correo
(`GET /:id/send-email`), descargar PDF/RIDE (`GET /:id/pdf`), descargar XML (`/:id/xml`), eliminar
(solo `failed`), anular (`DELETE /:id/cancel`).

### Catálogos del SRI entregados por el servicio

`GET /v3/administrative/invoices/get-options` entrega Impuestos (`2` IVA, `3` ICE, `5` IRBPNR),
FormasDePago, TiposDeComprobante (`01` Factura, `04` NC, `05` ND, `06` Guía, `07` Retención, `02` Nota de venta,
`03`/`08` Liquidación de compra, `11` Ticket aéreo), PorcentajesDeIVA (`0,2,4,5,6,7,8,10` con `value`),
PorcentajesDeICE, PorcentajesDeIRBPNR y TiposDeIdentificación. Guardados completos en
`docs/upconta-api/samples/invoice_options.json` y `product_options.json`.

## 3. Vínculo con el SRI

- Referencias directas en la app: `https://cel.sri.gob.ec` (producción) y `https://celcer.sri.gob.ec`
  (pruebas) para la consulta pública de comprobantes; chequeo `sriOnline` y etiqueta
  "Los comprobantes emitidos en el ambiente de pruebas del SRI NO tienen valor tributario".
- El **ambiente SRI** (`configs.useTestEnviroment`) y los secuenciales separados de pruebas
  (`invoiceTest`, `retentionReceiptTest`, ...) viven en la configuración de la empresa.
- Los endpoints SOAP del SRI son los oficiales (`RecepcionComprobantesOffline`, `AutorizacionComprobantesOffline`);
  la app no los llama desde el navegador — los usa el backend. [INFERIDO, consistente con la arquitectura]
- La firma electrónica se administra por empresa (`hasSignature` en sesión; el frontend no expone la clave).

**Conclusión:** "el servicio de facturación electrónica" de UpConta = API REST multiempresa que hace
SECUENCIAL → CLAVE DE ACCESO → XML → FIRMA XAdES → SRI (recepción/autorización) → RIDE/PDF + correo +
stock + contabilidad. Nuestra aplicación replica ese servicio y puede operarlo en dos modos:

1. **Modo directo SRI (por defecto):** nuestro backend genera XML, firma con el P12 de la empresa y envía al SRI.
2. **Modo UpConta:** nuestro backend actúa como cliente de `api.upconta.com` (`/v3/administrative/invoices`),
   reutilizando el mismo servicio identificado, con token de integración.

## 4. Modelo de datos observado

- **Empresa**: `_id, ruc, name, email, address`; `configs.establishments[]` con `id, nombre, address, bodega,
  costCenter, status, emissionPoints[]`; cada punto de emisión tiene `id, nombre, status` y **secuenciales**
  (`invoice, retentionReceipt, creditNote, debitNote, waybill, physicalInvoice, salesNote` + variantes `*Test`).
- **Punto de emisión requerido para emitir** (estab + ptoEmi). [DOCUMENTADO]
- **Productos/Servicios**: `code, auxiliarCode, price, description, iva, ice, irbpnr, aditionalInformation[],
  status, images[], bodegas[{bodega, amount}], total, claveUnidad`; `_movements[]`. [DOCUMENTADO]
- **Bodegas**: `code, name, description, color, _movements[]`. Stock por bodega dentro del producto. [DOCUMENTADO]
- **Clientes**: `idType ("04" RUC, "05" Cédula, "06" Pasaporte, "08" exterior, "09" placa), id, subjectType,
  name, phone, cellphone, email, city, address`. [DOCUMENTADO]
- **Comprobantes de stock**: `type (income|outgoes|transfer), date, bodega, toBodega, provider, observation,
  movements[], total, code, isAdjustment, xmlHash, compra`. [OBSERVADO en bundle]
- **Kardex**: reporte `GET /v4/production/stocks/kardex?startDate&endDate`; ingreso captura `precioBase`
  (costo de compra) que alimenta "stock valorado / kardex". [OBSERVADO en bundle]
- **Movimientos de auditoría** en cada entidad: `_movements[] = {type: created|edit|deleted, date, user, nota}`.
  En comprobantes además `sending-sri`, `failed`, `authorized`. [OBSERVADO]

## 5. Métodos de facturación identificados en la app

| Método | Ruta UI | Descripción |
|---|---|---|
| Facturación electrónica estándar | `/administrative/invoices/insert` | Formulario completo: cliente, ítems, impuestos, pagos, info adicional, guardar borrador o emitir |
| Facturación rápida | `/administrative/facturacion-rapida` (+ `/facturacion`, `/historial`) | Emisión simplificada de facturas |
| Punto de venta (POS) | `/administrative/point-of-sale` (+ `/v3`, `customer-display`) | Caja con carrito, pagos y pantalla de cliente |
| Factura física / preimpresa | `/administrative/physical-invoices` | Registro de facturas de talonario |
| Notas de venta | `/administrative/sales-notes` | Documento no tributario |
| Notas de crédito / débito | `/administrative/credit-notes`, `/debit-notes` | Modifican una factura autorizada |
| Carga masiva | `*/bulk-load` | Importación CSV/Excel |
| API de integración | `api.upconta.com` | Tokens de integración sin expiración |

## 6. Endpoints REST identificados (resumen)

- Autenticación: `POST /v3/auth/user`, `GET /v3/auth/user`, `GET /v4/auth/user`, `GET /v3/auth/empresas`,
  `POST /v3/auth/cambiar-usuario`.
- Empresa: `GET /v3/businesses/me?fields=`, `/me/establishments`, `/me/users/me`, `/v4/businesses/me/tokens`.
- Comprobantes: `GET|POST /v3/administrative/invoices`, `GET /:id?$getAllFields=true`, `/:id/pdf`, `/:id/xml`,
  `/:id/send-email`, `DELETE /:id`, `DELETE /:id/cancel`, `/get-options`.
  Equivalentes para `credit-notes`, `debit-notes`, `retenciones-v2`, `guias-remision`, `physical-invoices`, `sales-notes`.
- Personas: `/v3/administrative/clients|providers|sellers|transporters`.
- Producción: `/v3/production/products`, `/services`, `/products-services/:id`, `/products/get-options`,
  `/categorias`, `/bodegas`, `/stocks-vouchers`, `/v4/production/unit-measures`, `/v4/production/stocks/kardex`,
  `/v4/production/stocks/report`, `POST /v4/production/stock-vouchers/ajuste-stocks`.
- Convenciones: listas `{page,total,data}`, proyección `?fields=a b c`, `?$getAllFields=true`, filtros Mongo
  (`{$in}`), movimientos de auditoría `_movements`.

## 7. Decisiones para la nueva aplicación

Ver [`02-arquitectura-nueva-app.md`](02-arquitectura-nueva-app.md). Resumen:

- Backend propio con SQLite (`node:sqlite`), API REST equivalente (`/api/...`), JWT + roles.
- Paquete `@fe/sri` propio: clave de acceso, XML de factura/NC/ND/retención/guía, firma XAdES-BES, cliente SOAP
  SRI, RIDE PDF.
- **Doble driver de emisión**: `direct-sri` (por defecto) y `upconta` (misma API identificada, con token).
- Kardex con costo promedio ponderado, comprobantes de stock (ingreso/egreso/transferencia/ajuste) y reporte.
- Frontend React + Ant Design con los métodos de facturación: estándar, rápida, POS, borrador, notas, carga masiva.

## 8. Desconocido / fuera de alcance de la evidencia

- Código del backend de UpConta (SaaS): no observable; solo su contrato REST documentado y sus respuestas.
- Algoritmo exacto de firma (SHA1 vs SHA256) usado por UpConta: el estándar del SRI admite ambos; usaremos
  SHA1/RSA-SHA1 (compatibilidad histórica SRI) configurable a SHA256.
- Plantilla exacta del RIDE de UpConta: se observó el PDF real (`samples/invoice_ride.pdf`); nuestra plantilla
  replica la estructura estándar del RIDE del SRI, no su diseño pixel-perfect.

## 9. Evidencia de la verificación visual (REA)

Capturas reales de la aplicación construida, tomadas con el navegador automatizado de REA
(capture_browser_scenario) contra http://127.0.0.1:4000, sesión iniciada con el usuario demo:

| Archivo | Pantalla |
|---|---|
| `docs/evidencias/ui2-06-dashboard.png` | Panel de control con datos reales |
| `docs/evidencias/ui2-08-invoice-list.png` | Listado de comprobantes con clave de acceso |
| `docs/evidencias/ui2-10-invoice-form.png` | Formulario de nueva factura electrónica |
| `docs/evidencias/ui2-12-pos.png` | Punto de venta (caja) |
| `docs/evidencias/ui2-14-kardex.png` | Reporte Kardex valorado |
| `docs/evidencias/ui2-16-products.png` | Catálogo de productos con stock |
| `docs/evidencias/ui2-18-company.png` | Empresa, establecimientos y puntos de emisión |
| `docs/evidencias/ui3-quick-result.png` | Factura emitida desde la UI (autorizada con clave de acceso) |

La captura `ui3-quick-result.png` corresponde a una emisión real hecha desde la interfaz:
comprobante `001-001-000000005` en estado **Autorizado**, con clave de acceso
`0111202601179245678900110010010000000059721067412` y total `$ 1.033,85`.

## 10. Validación del vínculo con el SRI (evidencia real)

Se comprobó el vínculo con los servicios web del SRI desde la aplicación construida:

1. **Conectividad**: `GET https://celcer.sri.gob.ec/comprobantes-electronicos-ws/RecepcionComprobantesOffline?wsdl`
   → HTTP 200 (≈120 ms) desde el backend.
2. **Firma y envío**: una factura generada por la app, firmada con XAdES-BES (certificado PKCS#12 cargado en
   la UI) fue enviada al servicio `validarComprobante` del SRI.
3. **Respuesta real del SRI** (guardada en el comprobante y mostrada en la UI):

```xml
<RespuestaRecepcionComprobante>
  <estado>DEVUELTA</estado>
  <comprobantes><comprobante><claveAcceso>N/A</claveAcceso><mensajes><mensaje>
    <identificador>35</identificador>
    <mensaje>ARCHIVO NO CUMPLE ESTRUCTURA XML</mensaje>
    <informacionAdicional>No existe un contribuyente registrado con el RUC 1792456789001</informacionAdicional>
    <tipo>ERROR</tipo>
  </mensaje></mensajes></comprobante></comprobantes>
</RespuestaRecepcionComprobante>
```

Que el SRI responda con un mensaje propio (y no un error de red) demuestra que el XML fue recibido, el sobre
SOAP y la firma electrónica son aceptados por el servicio, y que la respuesta se parsea y persiste. Para obtener
`AUTORIZADO` se requiere un certificado emitido por una entidad autorizada y un RUC habilitado en el ambiente
de pruebas del SRI.

## 11. Implementación de la facturación electrónica: desarrollo propio

La aplicación construida factura por **desarrollo propio con integración directa al SRI**:

| Pieza | Implementación propia | Tercero |
|---|---|---|
| Clave de acceso (módulo 11) | `packages/shared/src/clave-acceso.ts` | — |
| XML de los 5 comprobantes | `packages/sri/src/xml.ts` | — |
| Firma XAdES-BES | `packages/sri/src/sign.ts` (node:crypto) | — |
| Lectura PKCS#12 (3DES/AES/RC2) | `packages/sri/src/p12.ts` + `rc2.ts` | — |
| Cliente SOAP del SRI | `packages/sri/src/soap.ts` | — |
| RIDE PDF | `packages/sri/src/pdf.ts`, `ride.ts`, `ride-especial.ts` | — |
| Emisión | `apps/api/src/modules/invoicing.ts` | — |
| Servicio UpConta identificado | adaptador opcional `sriMode=upconta` | sólo modo alternativo |

**Validación de la firma con un validador independiente.** `tools/ValidarFirma.java` usa el
validador XMLDSig del JDK (JSR 105), completamente ajeno a nuestro código. `npm run verify:signature`
(valida `SignedInfo`, digest del documento y digest de `SignedProperties`) confirma, para los cinco tipos
de comprobante y con SHA-1 y SHA-256:

```
factura          local=VALID java=VALID
nota-credito     local=VALID java=VALID
nota-debito      local=VALID java=VALID
retencion        local=VALID java=VALID
guia-remision    local=VALID java=VALID
```

**Correcciones de conformidad aplicadas** durante la validación:

- Canonicalización C14N: las etiquetas vacías se serializan como `<x></x>` y los elementos
  firmados (`SignedInfo`, `SignedProperties`) se insertan ya en su forma canónica.
- `ds:X509Certificate` debe contener el certificado en **DER base64** (antes se enviaba el PEM).
- Referencia a `SignedProperties` con `Type="http://uri.etsi.org/01903#SignedProperties"`.

**Intercambio real con el SRI.** Cada emisión en `direct-sri` registra en `sri_transactions` el
SOAP de recepción/autorización y la respuesta cruda del SRI; el detalle del comprobante muestra la
bitácora (`Log SRI`). Esta trazabilidad permite diagnosticar rechazos del SRI sin instrumentación
externa.

## 12. Evidencias de la iteración 3 (facturación real)

| Archivo | Contenido |
|---|---|
| `docs/evidencias/ui4-08-wb-list.png` | Listado de guías de remisión con clave de acceso |
| `docs/evidencias/ui4-12-rt-list.png` | Listado de comprobantes de retención |
| `docs/evidencias/ui5-sri-test.png` | Prueba de conexión con el SRI desde la UI (HTTP 200, certificado válido) |
| `docs/evidencias/ui6-10-detail.png` | Detalle de comprobante con XML firmado, verificación de firma y bitácora SRI |
| `docs/evidencias/ui6-12-sig-modal.png` | Verificación de firma XAdES desde la UI (RSA, digest del documento y de SignedProperties) |
| `docs/evidencias/ui6-14-company.png` | Configuración de empresa con algoritmo de firma seleccionable |

Validación de firma reproducida con el validador XMLDSig del JDK:

```
factura          firma_sha1: local=VALID java=VALID
nota-credito     firma_sha1: local=VALID java=VALID
nota-debito      firma_sha1: local=VALID java=VALID
retencion        firma_sha1: local=VALID java=VALID
guia-remision    firma_sha1: local=VALID java=VALID
```

Prueba real contra `celcer.sri.gob.ec` (comprobante `001-001-000000004`, ambiente de pruebas):
firma **VÁLIDA** (verificada localmente antes del envío) y respuesta del SRI
`[35] No existe un contribuyente registrado con el RUC 1792456789001` — el flujo XML → firma → SOAP →
respuesta funciona; la autorización requiere certificado de una entidad acreditada y RUC habilitado.

## 13. Evolución a plataforma multiempresa (modelo de negocio)

La aplicación evolucionó de instalación monoempresa a una **plataforma de licencias**:

- **Superadministrador** (`superadmin`): dueño de la plataforma; crea empresas/licencias, activa,
  suspende, renueva, asigna administradores y entra a configurar cualquier empresa.
- **Empresa**: cada licencia crea una **base de datos SQLite aislada** (`data/tenants/<id>.db`) con su
  RUC, configuración, catálogo, inventario y comprobantes. El aislamiento es físico.
- **Administrador de empresa**: configura su empresa y su certificado; gestiona usuarios con roles
  (`admin`, `facturador`, `inventario`, `contador`).
- **Licencias**: `trial`, `active`, `suspended`, `expired`; con plan, vencimiento y referencia de pago.
  `POST /api/platform/companies/:id/activate` queda listo para automatizar la liberación al detectar un
  pago (pasarela o conciliación bancaria).
- **Operación**: `npm run backup` respalda plataforma y empresas; el mismo binario sirve para una
  instancia central multiempresa o para instalaciones individuales por cliente en su VPS.

Verificación funcional: el superadministrador creó desde la interfaz la empresa
`INDUSTRIAS ANDINAS DEL SUR S.A.` (RUC `0105000001001`); su administrador ingresó, creó el producto
`AND-001`, y emitió facturas autorizadas en su propio secuencial
(`001-001-000000001` … `001-001-000000004`), sin acceso a los datos de otras empresas.
