/**
 * Pruebas del núcleo (sin dependencias): clave de acceso, cálculo de la factura,
 * emisión simulada, inventario con costo promedio y Kardex.
 *
 * Ejecutar con:  node --test test/core.test.ts   (desde apps/api)
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-test-'));
process.env.DB_PATH = path.join(tmpDir, 'legacy.db');
process.env.PLATFORM_DB_PATH = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.PORT = '0';
process.env.JWT_SECRET = 'test-secret';

const { startServer } = await import('../src/server.ts');
const { pExec, queryOne, setDefaultTenant } = await import('../src/db.ts');
const { provisionCompany } = await import('../src/provisioning.ts');
const { hashPassword } = await import('../src/http.ts');
const { newId } = await import('../src/ids.ts');
const { buildClaveAcceso, parseClaveAcceso, modulo11, validateIdentificacion } = await import(
  '../../../packages/shared/src/index.ts'
);
const {
  buildFacturaXml,
  buildAesTestP12,
  buildBerTestP12,
  buildLegacyTestP12,
  buildTestP12,
  generateSelfSignedCertificate,
  parseP12,
  signXml,
  signingMaterialFromP12,
  verifySignedXml,
} = await import('../../../packages/sri/src/index.ts');
const { expandRc2Key, rc2DecryptBlock, rc2EncryptBlock } = await import('../../../packages/sri/src/rc2.ts');

let server: { close: (cb: () => void) => void };
let baseUrl = '';
let token = '';
let companyId = '';
const ids: Record<string, string> = {};

function api(method: string, endpoint: string, body?: unknown, authToken?: string, tenantId?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (authToken) headers.authorization = `Bearer ${authToken}`;
  if (tenantId) headers['X-Company-Id'] = tenantId;
  return fetch(`${baseUrl}${endpoint}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (response) => ({ status: response.status, data: await response.json() }));
}

before(async () => {
  const started = await startServer(0, '127.0.0.1');
  baseUrl = started.url;
  server = started.server as never;
  const provisioned = provisionCompany({
    ruc: '1792456789001',
    name: 'EMPRESA TEST S.A.',
    tradeName: 'EMPRESA TEST',
    email: 'test@empresa.ec',
    phone: '022222222',
    address: 'Quito',
    plan: 'empresarial',
    licenseStatus: 'active',
    licenseExpiresAt: new Date(Date.now() + 365 * 86_400_000).toISOString(),
    adminUsername: 'admin',
    adminPassword: 'admin123',
    adminName: 'Administrador',
  });
  companyId = provisioned.company.id;
  setDefaultTenant(companyId);
  ids.warehouseId = String(queryOne<{ id: string }>("SELECT id FROM warehouses WHERE code = 'BOD01'")!.id);
  // Superadministrador de la plataforma (usuario global).
  const now = new Date().toISOString();
  pExec(
    'INSERT INTO platform_users (id, company_id, username, password_hash, name, email, role, permissions, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [newId(), null, 'superadmin', hashPassword('superadmin123'), 'Superadministrador', 'superadmin@test.ec', 'superadmin', '[]', 'active', now, now],
  );
});

after(() => {
  server?.close(() => undefined);
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test('clave de acceso: 49 dígitos y módulo 11 válido', () => {
  const clave = buildClaveAcceso({
    fechaEmision: '31/10/2026',
    codDoc: '01',
    ruc: '1792456789001',
    ambiente: '1',
    estab: '001',
    ptoEmi: '001',
    secuencial: 7,
  });
  assert.equal(clave.length, 49);
  assert.match(clave, /^\d{49}$/);
  assert.equal(clave.slice(0, 8), '31102026');
  assert.equal(clave.slice(8, 10), '01');
  assert.equal(clave.slice(10, 23), '1792456789001');
  assert.equal(clave.slice(23, 24), '1');
  assert.equal(clave.slice(24, 27), '001');
  assert.equal(clave.slice(27, 30), '001');
  assert.equal(clave.slice(30, 39), '000000007');
  const parsed = parseClaveAcceso(clave);
  assert.equal(parsed.valida, true);
  assert.equal(parsed.secuencial, '000000007');
  // Un dígito alterado invalida la clave
  const altered = clave.slice(0, 48) + String((Number(clave[48]) + 1) % 10);
  assert.notEqual(modulo11(altered.slice(0, 48)), Number(altered[48]));
});

test('validación de identificaciones ecuatorianas', () => {
  assert.equal(validateIdentificacion('04', '1792456789001'), true);
  assert.equal(validateIdentificacion('05', '1710034065'), true);
  assert.equal(validateIdentificacion('05', '1710034064'), false);
  assert.equal(validateIdentificacion('07', '9999999999999'), true);
});

test('login y catálogos', async () => {
  const login = await api('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  assert.equal(login.status, 200);
  token = login.data.token;
  assert.ok(token.length > 50);
  const catalogs = await api('GET', '/api/catalogs', undefined, token);
  assert.equal(catalogs.status, 200);
  const iva15 = catalogs.data.porcentajesDeIVA.find((item: { id: string }) => item.id === '4');
  assert.equal(iva15.value, 0.15);
  const unauthorized = await api('GET', '/api/products');
  assert.equal(unauthorized.status, 401);
});

test('producto, ingreso de stock y costo promedio ponderado', async () => {
  const product = await api(
    'POST',
    '/api/products',
    {
      type: 'product',
      code: 'TEST-001',
      description: 'Producto de prueba',
      priceCents: 10000,
      costCents: 5000,
      ivaCode: '4',
      trackStock: true,
      minStock: 2,
    },
    token,
  );
  assert.equal(product.status, 200);
  ids.productId = product.data.id;
  assert.equal(product.data.priceCents, 10000);

  const income = await api(
    'POST',
    '/api/stock-vouchers',
    {
      type: 'income',
      warehouseId: ids.warehouseId,
      provider: 'PROVEEDOR TEST',
      items: [{ productId: ids.productId, quantity: 10, unitCostCents: 5000 }],
    },
    token,
  );
  assert.equal(income.status, 200);
  assert.equal(income.data.totalCents, 50000);

  const income2 = await api(
    'POST',
    '/api/stock-vouchers',
    {
      type: 'income',
      warehouseId: ids.warehouseId,
      items: [{ productId: ids.productId, quantity: 10, unitCostCents: 7000 }],
    },
    token,
  );
  assert.equal(income2.status, 200);

  const stocks = await api('GET', `/api/stocks?q=TEST-001&warehouseId=${ids.warehouseId}`, undefined, token);
  assert.equal(stocks.status, 200);
  const row = stocks.data.data[0];
  assert.equal(row.amount, 20);
  // Costo promedio ponderado: (10*5000 + 10*7000) / 20 = 6000
  assert.equal(row.avgCostCents, 6000);
});

test('emitir factura en modo mock: clave de acceso, totales y stock', async () => {
  const client = await api(
    'POST',
    '/api/clients',
    { idType: '04', idNumber: '1792456789001', name: 'CLIENTE TEST S.A.', address: 'Quito' },
    token,
  );
  assert.equal(client.status, 200);
  ids.clientId = client.data.id;

  const invoice = await api(
    'POST',
    '/api/vouchers',
    {
      docType: '01',
      clientId: ids.clientId,
      items: [{ productId: ids.productId, quantity: 2 }],
    },
    token,
  );
  assert.equal(invoice.status, 200);
  const voucher = invoice.data;
  ids.invoiceId = voucher.id;
  assert.equal(voucher.status, 'issued');
  assert.equal(voucher.accessKey.length, 49);
  assert.equal(parseClaveAcceso(voucher.accessKey).valida, true);
  assert.equal(voucher.subtotalCents, 20000);
  assert.equal(voucher.taxCents, 3000); // IVA 15%
  assert.equal(voucher.totalCents, 23000);
  assert.ok(voucher.authorizationNumber);
  assert.equal(voucher.number, '001-001-000000001');

  const kardex = await api('GET', `/api/kardex?productId=${ids.productId}`, undefined, token);
  assert.equal(kardex.status, 200);
  assert.equal(kardex.data.summary.outQty, 2);
  assert.equal(kardex.data.summary.closingQty, 18);
  const lastRow = kardex.data.data[kardex.data.data.length - 1];
  assert.equal(lastRow.type, 'sale');
  assert.equal(lastRow.balanceQty, 18);
});

test('segunda factura usa el siguiente secuencial', async () => {
  const invoice = await api(
    'POST',
    '/api/vouchers',
    { docType: '01', clientId: ids.clientId, items: [{ productId: ids.productId, quantity: 1 }] },
    token,
  );
  assert.equal(invoice.status, 200);
  assert.equal(invoice.data.number, '001-001-000000002');
  ids.invoice2Id = invoice.data.id;
});

test('borrador no emite ni consume stock', async () => {
  const draft = await api(
    'POST',
    '/api/vouchers',
    { docType: '01', clientId: ids.clientId, draft: true, items: [{ productId: ids.productId, quantity: 5 }] },
    token,
  );
  assert.equal(draft.status, 200);
  assert.equal(draft.data.status, 'draft');
  assert.equal(draft.data.accessKey, null);
  const kardex = await api('GET', `/api/kardex?productId=${ids.productId}`, undefined, token);
  assert.equal(kardex.data.summary.outQty, 3);
});

test('nota de crédito referencia la factura y se autoriza', async () => {
  const note = await api(
    'POST',
    `/api/vouchers/${ids.invoiceId}/credit-note`,
    { reason: 'Devolución de mercadería' },
    token,
  );
  assert.equal(note.status, 200);
  assert.equal(note.data.docType, '04');
  assert.equal(note.data.status, 'issued');
  assert.equal(note.data.relatedVoucherId, ids.invoiceId);
  assert.equal(note.data.reason, 'Devolución de mercadería');
});

test('RIDE PDF y XML descargables', async () => {
  const pdf = await fetch(`${baseUrl}/api/vouchers/${ids.invoiceId}/pdf`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  const bytes = Buffer.from(await pdf.arrayBuffer());
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  const xml = await fetch(`${baseUrl}/api/vouchers/${ids.invoiceId}/xml`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const xmlText = await xml.text();
  assert.match(xmlText, /<factura id="comprobante" version="1.1.0">/);
  assert.match(xmlText, /<claveAcceso>\d{49}<\/claveAcceso>/);
  assert.match(xmlText, /<totalConImpuestos>/);
});

test('ajuste de stock y kardex con saldo valorado', async () => {
  const adjust = await api(
    'POST',
    '/api/stock-vouchers/adjust',
    { warehouseId: ids.warehouseId, items: [{ productId: ids.productId, targetQuantity: 5 }] },
    token,
  );
  assert.equal(adjust.status, 200);
  const stocks = await api('GET', `/api/stocks?q=TEST-001&warehouseId=${ids.warehouseId}`, undefined, token);
  assert.equal(stocks.data.data[0].amount, 5);
  const kardex = await api('GET', `/api/kardex?productId=${ids.productId}`, undefined, token);
  assert.equal(kardex.data.summary.closingQty, 5);
  const lastRow = kardex.data.data[kardex.data.data.length - 1];
  assert.equal(lastRow.type, 'adjust');
  assert.equal(lastRow.balanceQty, 5);
});

test('dashboard y token de API de integración', async () => {
  const dashboard = await api('GET', '/api/dashboard', undefined, token);
  assert.equal(dashboard.status, 200);
  assert.ok(dashboard.data.invoicesThisMonth >= 2);
  assert.ok(dashboard.data.products >= 1);

  const created = await api('POST', '/api/integration/tokens', { name: 'Integración de prueba' }, token);
  assert.equal(created.status, 200);
  assert.ok(created.data.token);
  const integrationToken = created.data.token;

  const viaApiToken = await fetch(`${baseUrl}/api/v1/vouchers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `ApiToken ${integrationToken}` },
    body: JSON.stringify({
      docType: '01',
      clientId: ids.clientId,
      items: [{ productId: ids.productId, quantity: 1 }],
    }),
  });
  assert.equal(viaApiToken.status, 200);
  const createdVoucher = await viaApiToken.json();
  assert.equal(createdVoucher.status, 'issued');
  assert.equal(createdVoucher.accessKey.length, 49);
});

test('health público', async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.status, 'ok');
});

/* ------------------------------------------------ guía de remisión (06) */

test('emitir guía de remisión: XML, secuencial, RIDE y estado', async () => {
  const waybill = await api(
    'POST',
    '/api/waybills',
    {
      dirPartida: 'Bodega principal, Quito',
      transportista: {
        razonSocial: 'TRANSPORTES DEMO S.A.',
        ruc: '1792456789001',
        tipoIdentificacion: '04',
        placa: 'PBX-1234',
      },
      fechaIniTransporte: '01/11/2026',
      fechaFinTransporte: '02/11/2026',
      destinatarios: [
        {
          identificacion: '1752048122001',
          razonSocial: 'ALEJANDRO TES',
          direccion: 'Av. Amazonas 123, Quito',
          motivoTraslado: '03',
          items: [{ productId: ids.productId, cantidad: 3 }],
        },
      ],
    },
    token,
  );
  assert.equal(waybill.status, 200, JSON.stringify(waybill.data));
  assert.equal(waybill.data.docType, '06');
  assert.equal(waybill.data.status, 'issued');
  assert.equal(waybill.data.number, '001-001-000000001');
  assert.equal(waybill.data.accessKey.length, 49);
  assert.equal(waybill.data.extra.destinatarios[0].razonSocial, 'ALEJANDRO TES');

  const xml = await fetch(`${baseUrl}/api/vouchers/${waybill.data.id}/xml`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const xmlText = await xml.text();
  assert.match(xmlText, /<guiaRemision id="comprobante" version="1.1.0">/);
  assert.match(xmlText, /<placa>PBX-1234<\/placa>/);
  assert.match(xmlText, /<motivoTraslado>03<\/motivoTraslado>/);

  const pdf = await fetch(`${baseUrl}/api/vouchers/${waybill.data.id}/pdf`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const pdfBytes = Buffer.from(await pdf.arrayBuffer());
  assert.equal(pdfBytes.subarray(0, 5).toString(), '%PDF-');

  const list = await api('GET', '/api/waybills', undefined, token);
  assert.equal(list.status, 200);
  assert.ok(list.data.total >= 1);
});

/* --------------------------------------------- comprobante de retención (07) */

test('emitir comprobante de retención con documento de sustento', async () => {
  const retention = await api(
    'POST',
    '/api/retentions',
    {
      sujeto: {
        tipoIdentificacion: '04',
        identificacion: '1792146141001',
        razonSocial: 'PROVEEDOR DEMO S.A.',
      },
      periodoFiscal: '10/2026',
      docs: [
        {
          codSustento: '01',
          codDocSustento: '01',
          numDocSustento: '001-001-000000123',
          fechaEmisionDocSustento: '15/10/2026',
          numAutDocSustento: '1510202601179214614100120010010000001231234567811',
          pagoLocExt: '01',
          totalSinImpuestosCents: 10000,
          importeTotalCents: 11500,
          impuestos: [
            { codImpuestoDocSustento: '2', codigoPorcentaje: '4', baseImponibleCents: 10000, tarifa: 15, valorImpuestoCents: 1500 },
          ],
          retenciones: [
            { codigo: '1', codigoPorcentaje: '303', tarifa: 10, baseImponibleCents: 10000 },
            { codigo: '2', codigoPorcentaje: '1', tarifa: 10, baseImponibleCents: 1500 },
          ],
        },
      ],
    },
    token,
  );
  assert.equal(retention.status, 200, JSON.stringify(retention.data));
  assert.equal(retention.data.docType, '07');
  assert.equal(retention.data.status, 'issued');
  assert.equal(retention.data.number, '001-001-000000001');
  // 10% de 100 + 10% de 15 = 10 + 1.5 = 11.5 USD
  assert.equal(retention.data.totalCents, 1150);

  const xml = await fetch(`${baseUrl}/api/vouchers/${retention.data.id}/xml`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const xmlText = await xml.text();
  assert.match(xmlText, /<comprobanteRetencion id="comprobante" version="1.0.0">/);
  assert.match(xmlText, /<codigoPorcentaje>303<\/codigoPorcentaje>/);
  assert.match(xmlText, /<periodoFiscal>10\/2026<\/periodoFiscal>/);

  const pdf = await fetch(`${baseUrl}/api/vouchers/${retention.data.id}/pdf`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const pdfBytes = Buffer.from(await pdf.arrayBuffer());
  assert.equal(pdfBytes.subarray(0, 5).toString(), '%PDF-');
});

/* -------------------------------------------------- certificado y PKCS#12 */

test('genera certificado de prueba, lo empaqueta en PKCS#12 y firma XML', async () => {
  const { certificatePem, privateKeyPem } = generateSelfSignedCertificate({
    commonName: 'PRUEBA TEST',
    organization: 'DEMO',
    country: 'EC',
  });
  const p12 = buildTestP12(certificatePem, privateKeyPem, 'clave123');
  const parsed = parseP12(p12, 'clave123');
  assert.match(parsed.certificatePem, /BEGIN CERTIFICATE/);
  assert.match(parsed.privateKeyPem, /BEGIN PRIVATE KEY/);
  assert.ok(parsed.subject?.includes('PRUEBA TEST'));

  // PKCS#12 moderno con PBES2/PBKDF2-SHA256 y AES-256-CBC (certificados recientes)
  const aesP12 = buildAesTestP12(certificatePem, privateKeyPem, 'clave123');
  const aesParsed = parseP12(aesP12, 'clave123');
  assert.ok(aesParsed.subject?.includes('PRUEBA TEST'));
  assert.match(aesParsed.privateKeyPem, /BEGIN PRIVATE KEY/);

  // PKCS#12 en BER con longitudes indefinidas (certificados de algunas entidades)
  const berP12 = buildBerTestP12(certificatePem, privateKeyPem, 'clave123');
  const berParsed = parseP12(berP12, 'clave123');
  assert.ok(berParsed.subject?.includes('PRUEBA TEST'));
  assert.match(berParsed.privateKeyPem, /BEGIN PRIVATE KEY/);

  // PKCS#12 "legacy": certificado cifrado con RC2-40 y clave con 3DES
  const legacy = buildLegacyTestP12(certificatePem, privateKeyPem, 'clave123');
  const legacyParsed = parseP12(legacy, 'clave123');
  assert.ok(legacyParsed.subject?.includes('PRUEBA TEST'));
  assert.match(legacyParsed.privateKeyPem, /BEGIN PRIVATE KEY/);

  const xml = buildFacturaXml({
    infoTributaria: {
      ambiente: '1',
      tipoEmision: '1',
      razonSocial: 'DEMO',
      ruc: '1792456789001',
      claveAcceso: buildClaveAcceso({
        fechaEmision: '01/11/2026',
        codDoc: '01',
        ruc: '1792456789001',
        ambiente: '1',
        estab: '001',
        ptoEmi: '001',
        secuencial: 1,
      }),
      codDoc: '01',
      estab: '001',
      ptoEmi: '001',
      secuencial: '000000001',
      dirMatriz: 'Quito',
    },
    infoFactura: {
      fechaEmision: '01/11/2026',
      obligadoContabilidad: 'NO',
      comprador: { tipoIdentificacion: '07', razonSocial: 'CONSUMIDOR FINAL', identificacion: '9999999999999' },
      totalSinImpuestos: 10,
      totalDescuento: 0,
      totalConImpuestos: [{ codigo: '2', codigoPorcentaje: '4', tarifa: 15, baseImponible: 10, valor: 1.5 }],
      propina: 0,
      importeTotal: 11.5,
      pagos: [{ formaPago: 'efectivo', total: 11.5 }],
    },
    detalles: [
      {
        codigoPrincipal: 'X',
        descripcion: 'Item',
        cantidad: 1,
        precioUnitario: 10,
        descuento: 0,
        subtotal: 10,
        impuestos: [{ codigo: '2', codigoPorcentaje: '4', tarifa: 15, baseImponible: 10, valor: 1.5 }],
      },
    ],
  });
  const material = signingMaterialFromP12(legacy, 'clave123');
  const signed = signXml(xml, material);
  assert.ok(signed.xml.includes('<ds:Signature'));
  assert.ok(signed.xml.includes('QualifyingProperties'));
  // El certificado dentro de la firma debe ir en DER base64 (no en PEM).
  assert.ok(!signed.xml.includes('BEGIN CERTIFICATE'));
  const verification = verifySignedXml(signed.xml);
  assert.equal(verification.signatureValid, true, verification.details.join('; '));
  assert.equal(verification.documentDigestValid, true, verification.details.join('; '));
  assert.equal(verification.signedPropertiesDigestValid, true, verification.details.join('; '));
  assert.equal(verification.valid, true);

  // Variante SHA-256
  const sha256Signed = signXml(xml, { ...material, digestAlgorithm: 'sha256' });
  const sha256Check = verifySignedXml(sha256Signed.xml);
  assert.equal(sha256Check.digestAlgorithm, 'sha256');
  assert.equal(sha256Check.valid, true, sha256Check.details.join('; '));
});

test('RC2 cumple los vectores de prueba del RFC 2268', () => {
  const vectors = [
    { key: '0000000000000000', bits: 63, plain: '0000000000000000', cipher: 'ebb773f993278eff' },
    { key: 'ffffffffffffffff', bits: 64, plain: 'ffffffffffffffff', cipher: '278b27e42e2f0d49' },
    { key: '3000000000000000', bits: 64, plain: '1000000000000001', cipher: '30649edf9be7d2c2' },
    { key: '88bca90e90875a7f0f79c384627bafb2', bits: 128, plain: '0000000000000000', cipher: '2269552ab0f85ca6' },
  ];
  for (const vector of vectors) {
    const key = Buffer.from(vector.key, 'hex');
    const block = Buffer.from(vector.plain, 'hex');
    const keyWords = expandRc2Key(key, vector.bits);
    rc2EncryptBlock(block, keyWords);
    assert.equal(block.toString('hex'), vector.cipher);
    rc2DecryptBlock(block, keyWords);
    assert.equal(block.toString('hex'), vector.plain);
  }
});



/* --------------------------------------------------- plataforma multiempresa */

test('multiempresa: licencia nueva, administrador propio, aislamiento y facturación', async () => {
  const superLogin = await api('POST', '/api/auth/login', { username: 'superadmin', password: 'superadmin123' });
  assert.equal(superLogin.status, 200);
  const superToken = superLogin.data.token;
  assert.equal(superLogin.data.user.isSuperadmin, true);
  assert.equal(superLogin.data.user.role, 'superadmin');

  const created = await api(
    'POST',
    '/api/platform/companies',
    {
      ruc: '0102030405001',
      name: 'CLIENTE MULTIEMPRESA S.A.',
      tradeName: 'CLIENTE MT',
      email: 'admin@cliente-mt.ec',
      address: 'Cuenca, Ecuador',
      plan: 'basico',
      licenseStatus: 'trial',
      trialDays: 15,
      adminUsername: 'cliente_mt',
      adminPassword: 'cliente123',
      adminName: 'Administrador Cliente',
      adminEmail: 'admin@cliente-mt.ec',
    },
    superToken,
  );
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const tenantId = created.data.company.id;
  assert.ok(tenantId);
  assert.equal(created.data.company.ruc, '0102030405001');
  assert.equal(created.data.company.status, 'trial');

  // El administrador de la empresa nueva entra con sus propias credenciales.
  const tenantLogin = await api('POST', '/api/auth/login', { username: 'cliente_mt', password: 'cliente123' });
  assert.equal(tenantLogin.status, 200, JSON.stringify(tenantLogin.data));
  assert.equal(tenantLogin.data.company.ruc, '0102030405001');
  const tenantToken = tenantLogin.data.token;

  const company = await api('GET', '/api/company', undefined, tenantToken);
  assert.equal(company.status, 200);
  assert.equal(company.data.ruc, '0102030405001');
  assert.equal(company.data.sriMode, 'mock');

  // La empresa nueva arranca vacía de catálogo (sólo su consumidor final).
  const initialProducts = await api('GET', '/api/products', undefined, tenantToken);
  assert.equal(initialProducts.status, 200);
  assert.equal(initialProducts.data.total, 0);

  const product = await api(
    'POST',
    '/api/products',
    {
      type: 'product',
      code: 'NUEVO-MT',
      description: 'Producto de la empresa nueva',
      priceCents: 5000,
      ivaCode: '4',
      trackStock: false,
    },
    tenantToken,
  );
  assert.equal(product.status, 200, JSON.stringify(product.data));
  assert.equal(product.data.priceCents, 5000);

  const voucher = await api(
    'POST',
    '/api/vouchers',
    { docType: '01', items: [{ productId: product.data.id, quantity: 2 }] },
    tenantToken,
  );
  assert.equal(voucher.status, 200, JSON.stringify(voucher.data));
  assert.equal(voucher.data.status, 'issued');
  assert.equal(voucher.data.subtotalCents, 10000);
  assert.equal(voucher.data.taxCents, 1500);
  assert.equal(voucher.data.totalCents, 11500);
  assert.equal(voucher.data.accessKey.length, 49);

  // Aislamiento: la empresa demo no ve productos ni comprobantes de la nueva.
  const demoProducts = await api('GET', '/api/products?limit=200', undefined, token);
  assert.ok(!demoProducts.data.data.some((item: { code: string }) => item.code === 'NUEVO-MT'));
  const crossVoucher = await api('GET', `/api/vouchers/${voucher.data.id}`, undefined, token);
  assert.equal(crossVoucher.status, 404);
  const crossDemo = await api('GET', `/api/vouchers/${ids.invoiceId}`, undefined, tenantToken);
  assert.equal(crossDemo.status, 404);

  // El superadministrador puede entrar a configurar la empresa con X-Company-Id.
  const scoped = await api('GET', '/api/company', undefined, superToken, tenantId);
  assert.equal(scoped.status, 200);
  assert.equal(scoped.data.name, 'CLIENTE MULTIEMPRESA S.A.');

  // Suspender la licencia bloquea el acceso; activarla (pago) lo restablece.
  const suspended = await api('PUT', `/api/platform/companies/${tenantId}/license`, { status: 'suspended' }, superToken);
  assert.equal(suspended.status, 200);
  const blocked = await api('POST', '/api/auth/login', { username: 'cliente_mt', password: 'cliente123' });
  assert.equal(blocked.status, 403);
  assert.match(blocked.data.message, /licencia/i);

  const activated = await api(
    'POST',
    `/api/platform/companies/${tenantId}/activate`,
    { months: 12, paymentReference: 'PAGO-TEST-001' },
    superToken,
  );
  assert.equal(activated.status, 200);
  assert.equal(activated.data.company.status, 'active');
  const relogin = await api('POST', '/api/auth/login', { username: 'cliente_mt', password: 'cliente123' });
  assert.equal(relogin.status, 200);

  const overview = await api('GET', '/api/platform/overview', undefined, superToken);
  assert.equal(overview.status, 200);
  assert.ok(overview.data.totalCompanies >= 2);
  assert.equal(overview.data.byStatus.active >= 2, true);
});

/* --------------------------------------------- usuarios por empresa (roles) */

test('usuarios de una empresa quedan aislados y con roles propios', async () => {
  const superLogin = await api('POST', '/api/auth/login', { username: 'superadmin', password: 'superadmin123' });
  const superToken = superLogin.data.token;
  const companies = await api('GET', '/api/platform/companies', undefined, superToken);
  const tenant = companies.data.find((item: { ruc: string }) => item.ruc === '0102030405001');
  assert.ok(tenant);

  const added = await api(
    'POST',
    `/api/platform/companies/${tenant.id}/users`,
    { username: 'cliente_fact', password: 'fact123', name: 'Facturador Cliente', role: 'facturador' },
    superToken,
  );
  assert.equal(added.status, 200, JSON.stringify(added.data));
  assert.equal(added.data.role, 'facturador');

  const factLogin = await api('POST', '/api/auth/login', { username: 'cliente_fact', password: 'fact123' });
  assert.equal(factLogin.status, 200);
  const factToken = factLogin.data.token;
  // El facturador no puede administrar usuarios (rol sin permiso users:write).
  const forbidden = await api('POST', '/api/users', { username: 'x', password: 'xxxxxx', name: 'X', role: 'admin' }, factToken);
  assert.equal(forbidden.status, 403);
  // Pero sí ve el catálogo de SU empresa y puede emitir comprobantes.
  const products = await api('GET', '/api/products', undefined, factToken);
  assert.equal(products.status, 200);
  const ownProduct = products.data.data.find((item: { code: string }) => item.code === 'NUEVO-MT');
  assert.ok(ownProduct);
  const invoice = await api(
    'POST',
    '/api/vouchers',
    { docType: '01', items: [{ productId: ownProduct.id, quantity: 1 }] },
    factToken,
  );
  assert.equal(invoice.status, 200, JSON.stringify(invoice.data));
  assert.equal(invoice.data.status, 'issued');
  // El listado de usuarios está reservado al administrador de la empresa.
  const users = await api('GET', '/api/users', undefined, factToken);
  assert.equal(users.status, 403);
});



/* ----------------------------------------- regresión: stock y numeración */

test('el rechazo por stock no crea comprobante ni consume secuencial', async () => {
  const product = await api(
    'POST',
    '/api/products',
    {
      type: 'product',
      code: 'TEST-NOSTOCK',
      description: 'Producto sin stock inicial',
      priceCents: 1000,
      costCents: 500,
      ivaCode: '4',
      trackStock: true,
    },
    token,
  );
  assert.equal(product.status, 200);

  const before = await api('GET', '/api/vouchers?limit=1', undefined, token);
  const rejected = await api(
    'POST',
    '/api/vouchers',
    { docType: '01', items: [{ productId: product.data.id, quantity: 1 }] },
    token,
  );
  assert.equal(rejected.status, 400);
  assert.match(rejected.data.message, /Stock insuficiente/i);
  const after = await api('GET', '/api/vouchers?limit=1', undefined, token);
  assert.equal(after.data.total, before.data.total, 'El rechazo no debe crear comprobantes');

  // Con stock disponible, la siguiente factura usa el siguiente secuencial real.
  const income = await api(
    'POST',
    '/api/stock-vouchers',
    {
      type: 'income',
      warehouseId: ids.warehouseId,
      items: [{ productId: product.data.id, quantity: 1, unitCostCents: 500 }],
    },
    token,
  );
  assert.equal(income.status, 200);
  const invoice = await api(
    'POST',
    '/api/vouchers',
    { docType: '01', items: [{ productId: product.data.id, quantity: 1 }] },
    token,
  );
  assert.equal(invoice.status, 200, JSON.stringify(invoice.data));
  assert.equal(invoice.data.status, 'issued');
  assert.equal(invoice.data.totalCents, 1150);
});


