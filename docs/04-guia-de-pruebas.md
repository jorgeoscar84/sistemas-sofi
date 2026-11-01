# Guía de pruebas · Facturación Electrónica EC

Objetivo: **comprobar que la aplicación factura y que el software funciona** antes de trabajar en
licencias automáticas o integraciones de pago.

Las pruebas automáticas **no tocan tu base de datos real**: el autodiagnóstico levanta una instancia
aislada en un directorio temporal y la elimina al terminar.

## 1. Autodiagnóstico completo (recomendado)

```bash
npm run autodiagnostico
```

Verifica 29 puntos de punta a punta:

| Bloque | Qué comprueba |
|---|---|
| Plataforma y licencia | salud, login superadmin, creación de empresa/licencia, login del administrador, configuración inicial |
| Catálogo e inventario | catálogos del SRI (IVA 15%), crear producto, rechazo amable sin stock, ingreso de inventario, crear cliente |
| Comprobantes | factura, RIDE PDF, XML, Kardex, factura rápida, POS, nota de crédito, nota de débito, guía de remisión, retención |
| Panel y usuarios | dashboard con métricas, usuario facturador con permisos correctos |
| Licencia | suspensión bloquea el acceso, activación (pago) lo restablece |
| Aislamiento | segunda empresa no ve datos de la primera, superadmin entra con `X-Company-Id` |
| Certificado y firma | carga de PKCS#12 (PBES2/AES), firma XAdES-BES y validación local + validador XMLDSig del JDK |

Resultado esperado: `RESULTADO: 29/29 verificaciones correctas` y código de salida 0.

### Con prueba real contra el SRI

```bash
npm run autodiagnostico:sri
```

Agrega 2 comprobaciones (31 en total):

1. Conectividad a los servicios web del SRI (HTTP 200, latencia).
2. Emisión en modo `direct-sri`: firma verificada localmente, envío real, respuesta del SRI y bitácora.

Con un RUC de prueba el SRI responderá `ARCHIVO NO CUMPLE ESTRUCTURA XML / No existe un contribuyente
registrado...`; eso **confirma** que el XML, la firma y el sobre SOAP llegan y que la respuesta se procesa.
La autorización real necesita un certificado emitido por una entidad autorizada y un RUC habilitado.

## 2. Pruebas automáticas del núcleo

```bash
npm test                      # 19 pruebas
npm run verify:signature      # firma XAdES de los 5 comprobantes con SHA-1 (local + JDK)
npm run verify:signature:sha256
```

Resultado esperado: `19/19` y `RESULTADO: todos los comprobantes tienen firma XAdES válida`.

## 3. Prueba manual en la interfaz (checklist)

Entra en `http://127.0.0.1:4000` con el usuario que corresponda.

### Como superadministrador
- [ ] Crear una empresa/licencia nueva y recibir las credenciales del administrador.
- [ ] Ver en el listado la empresa con estado, plan, vencimiento y métricas.
- [ ] Entrar a **Configurar** una empresa y editar su configuración.
- [ ] Suspender una licencia y comprobar que su usuario ya no puede ingresar.
- [ ] Activarla de nuevo (simula el pago) y comprobar que el acceso vuelve.

### Como administrador de empresa
- [ ] Completar datos de la empresa (RUC, razón social, dirección, obligado a llevar contabilidad).
- [ ] Verificar establecimiento `001` y punto de emisión `001` con secuenciales.
- [ ] Crear una categoría, una unidad y un producto con precio e IVA.
- [ ] Registrar un ingreso de inventario para el producto.
- [ ] Crear un cliente.
- [ ] Emitir una factura y comprobar: número, clave de acceso de 49 dígitos, estado **Autorizado**, total.
- [ ] Descargar el **RIDE PDF** y el **XML**.
- [ ] Revisar el **Kardex** (salida por venta y saldo).
- [ ] Emitir factura rápida y una venta en el punto de venta.
- [ ] Emitir una **nota de crédito** y una **nota de débito** desde una factura autorizada.
- [ ] Emitir una **guía de remisión** y un **comprobante de retención**; descargar sus RIDE.
- [ ] Crear un usuario con rol facturador y comprobar que no puede administrar usuarios.
- [ ] Probar el dashboard, los filtros y la búsqueda.

### Configurar el SRI de la empresa (cuando ya tengas certificado)
- [ ] Subir el `.p12/.pfx` real con su contraseña en **Empresa y SRI**.
- [ ] Elegir ambiente `1 · Pruebas` y modo `SRI directo`.
- [ ] Pulsar **Probar conexión con el SRI** (debe responder HTTP 200 y certificado válido).
- [ ] Emitir una factura y revisar el estado y los mensajes del SRI.
- [ ] Revisar **Log SRI** para ver la respuesta cruda del servicio.

### Checklist real contra el SRI (autorización)
- [ ] Certificado emitido por **BCE, Security Data, ANF** u otra entidad autorizada.
- [ ] RUC **habilitado en el ambiente de pruebas** del SRI (o RUC de producción para ambiente 2).
- [ ] Certificado cargado y vigente.
- [ ] Ambiente y modo correctos.
- [ ] Emisión: la factura debe pasar a **Autorizado** con número y fecha de autorización.
- [ ] Descargar **XML autorizado** y RIDE.
- [ ] Si el SRI devuelve mensajes, revisarlos en el detalle y en **Log SRI**.

## 4. Interpretar mensajes del SRI

| Mensaje | Significado / acción |
|---|---|
| `No existe un contribuyente registrado con el RUC ...` (35) | El RUC no está habilitado en el ambiente del SRI. Usar un RUC habilitado. |
| `FIRMA INVÁLIDA` | El certificado no es de una entidad autorizada, está vencido o no corresponde al emisor. |
| `CLAVE ACCESO REGISTRADA` | El comprobante ya fue enviado (reintento). Consultar autorización. |
| `PENDIENTE` | El SRI aún no autoriza; usar **Consultar autorización** en el detalle. |
| Error de red / `offline` | El SRI no respondió; reintentar desde el detalle. |

## 5. Qué ya está validado (evidencia)

- **31/31** comprobaciones del autodiagnóstico (con SRI real).
- **19/19** pruebas del núcleo.
- Firma XAdES-BES de factura, nota de crédito, nota de débito, retención y guía validada con el
  **validador XMLDSig del JDK** (SHA-1 y SHA-256).
- Emisión real contra `celcer.sri.gob.ec`: HTTP 200, firma válida, respuesta del SRI registrada.
- Certificados: PKCS#12 con **3DES**, **RC2** (legacy) y **PBES2/AES-256** moderno.
- Bug corregido: un rechazo por falta de stock ya **no crea** una factura fantasma ni consume secuencial;
  la validación ocurre antes de reservar numeración.

## 6. Datos y respaldos

- `npm run autodiagnostico` usa una base temporal; tu información no se modifica.
- `npm run backup` respalda plataforma y empresas reales antes de cualquier prueba con datos propios.
- Para reiniciar los datos demo: `npm run seed -- --force` (borra todo lo existente).
