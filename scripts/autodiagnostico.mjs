/**
 * AUTODIAGNÓSTICO INTEGRAL de la plataforma.
 *
 * Levanta una instancia aislada (base de datos temporal), simula el día a día de
 * una empresa y verifica que TODO el flujo funcione:
 *   licencia → administrador → catálogo → inventario → clientes → facturas →
 *   nota de crédito/débito → guía de remisión → retención → RIDE/XML →
 *   dashboard/Kardex → usuarios/roles → suspensión de licencia → aislamiento
 *   entre empresas → certificado y firma XAdES → (opcional) SRI real.
 *
 * Uso:
 *   node scripts/autodiagnostico.mjs
 *   node scripts/autodiagnostico.mjs --sri     (incluye conectividad y envío real al SRI)
 *   node scripts/autodiagnostico.mjs --keep    (no elimina la carpeta temporal)
 *
 * No toca la base de datos real: usa un directorio temporal.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const includeSri = args.includes('--sri');
const keepTemp = args.includes('--keep');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-autotest-'));

process.env.DB_PATH = path.join(tmpDir, 'legacy.db');
process.env.PLATFORM_DB_PATH = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.JWT_SECRET = 'autotest-secret';
process.env.PORT = '0';

const { startServer } = await import('../apps/api/src/server.ts');
const db = await import('../apps/api/src/db.ts');
const { hashPassword } = await import('../apps/api/src/http.ts');
const { newId } = await import('../apps/api/src/ids.ts');
const sri = await import('../packages/sri/src/index.ts');
const shared = await import('../packages/shared/src/index.ts');

const results = [];
let currentSection = '';

function section(name) {
  currentSection = name;
  console.log(`\n── ${name} ──`);
}

async function check(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - started, detail });
    console.log(`  ✓ ${name}${detail ? ` · ${detail}` : ''}`);
    return true;
  } catch (error) {
    results.push({ name, ok: false, ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
    console.log(`  ✗ ${name} → ${error instanceof Error ? error.message : error}`);
    return false;
  }
}

function warning(message) {
  console.log(`  ! ${message}`);
}

/* ------------------------------------------------------------------ HTTP */

let baseUrl = '';

async function request(method, endpoint, { body, token, tenant, raw = false } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (tenant) headers['X-Company-Id'] = tenant;
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (raw) return response;
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: response.status, data, headers: response.headers };
}

async function expectOk(method, endpoint, options = {}) {
  const result = await request(method, endpoint, options);
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`${method} ${endpoint} → ${result.status}: ${result.data?.message ?? JSON.stringify(result.data).slice(0, 200)}`);
  }
  return result.data;
}

/* ---------------------------------------------------------- ciclo de vida */

let server;
let companyId = '';
let tenantToken = '';
let superToken = '';

try {
  const started = await startServer(0, '127.0.0.1');
  baseUrl = started.url;
  server = started.server;

  // Superadministrador inicial de la plataforma temporal.
  db.pExec(
    'INSERT INTO platform_users (id, company_id, username, password_hash, name, email, role, permissions, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [newId(), null, 'autotest_super', hashPassword('autotest123'), 'Super Auto', 'auto@test.ec', 'superadmin', '[]', 'active', db.nowIso(), db.nowIso()],
  );

  section('Plataforma y licencia');
  await check('servicio de salud responde', async () => {
    const health = await expectOk('GET', '/api/health');
    assert.equal(health.status, 'ok');
    return health.name;
  });

  await check('login del superadministrador', async () => {
    const login = await expectOk('POST', '/api/auth/login', { body: { username: 'autotest_super', password: 'autotest123' } });
    assert.equal(login.user.isSuperadmin, true);
    superToken = login.token;
    return login.user.username;
  });

  const companyData = {
    ruc: '0999000001001',
    name: 'EMPRESA AUTODIAGNÓSTICO S.A.',
    tradeName: 'AUTOTEST',
    email: 'auto@test.ec',
    address: 'Av. Prueba 123, Guayaquil',
    plan: 'basico',
    licenseStatus: 'trial',
    trialDays: 15,
    adminUsername: 'autotest_admin',
    adminPassword: 'autotest123',
    adminName: 'Administrador Autotest',
    adminEmail: 'admin@autotest.ec',
  };

  await check('el superadministrador crea una empresa/licencia nueva', async () => {
    const created = await expectOk('POST', '/api/platform/companies', { body: companyData, token: superToken });
    assert.equal(created.company.ruc, companyData.ruc);
    assert.equal(created.company.status, 'trial');
    companyId = created.company.id;
    return `${created.company.name} (${created.company.ruc})`;
  });

  await check('el administrador de la empresa inicia sesión', async () => {
    const login = await expectOk('POST', '/api/auth/login', { body: { username: 'autotest_admin', password: 'autotest123' } });
    assert.equal(login.company.ruc, companyData.ruc);
    tenantToken = login.token;
    return login.user.username;
  });

  await check('configuración inicial de la empresa (modo simulado, RUC propio)', async () => {
    const company = await expectOk('GET', '/api/company', { token: tenantToken });
    assert.equal(company.ruc, companyData.ruc);
    assert.equal(company.sriMode, 'mock');
    assert.equal(company.license.status, 'trial');
    return `modo ${company.sriMode}, licencia ${company.license.statusLabel}`;
  });

  section('Catálogo, inventario y clientes');
  await check('catálogos del SRI disponibles (IVA 15%)', async () => {
    const catalogs = await expectOk('GET', '/api/catalogs', { token: tenantToken });
    const iva = catalogs.porcentajesDeIVA.find((item) => item.id === '4');
    assert.equal(iva.value, 0.15);
    return `${catalogs.impuestos.length} impuestos, ${catalogs.formasDePago.length} formas de pago`;
  });

  let product;
  await check('crear un producto con control de inventario', async () => {
    product = await expectOk('POST', '/api/products', {
      body: {
        type: 'product',
        code: 'AUTO-001',
        description: 'Producto de autodiagnóstico',
        priceCents: 10000,
        costCents: 5000,
        ivaCode: '4',
        trackStock: true,
        minStock: 2,
      },
      token: tenantToken,
    });
    assert.equal(product.priceCents, 10000);
    return `${product.code} · $${(product.priceCents / 100).toFixed(2)}`;
  });

  const warehouses = await expectOk('GET', '/api/warehouses', { token: tenantToken });
  const warehouse = warehouses[0];
  assert.ok(warehouse, 'La empresa nueva debe tener una bodega por defecto');

  await check('rechazo amable al facturar sin stock', async () => {
    const invoice = await request('POST', '/api/vouchers', {
      body: { docType: '01', items: [{ productId: product.id, quantity: 1 }] },
      token: tenantToken,
    });
    assert.equal(invoice.status, 400);
    assert.match(invoice.data.message, /Stock insuficiente/i);
    assert.match(invoice.data.message, /Registre un ingreso de inventario/i);
    const vouchers = await expectOk('GET', '/api/vouchers', { token: tenantToken });
    assert.equal(vouchers.total, 0, 'El intento rechazado no debe crear comprobantes');
    return 'mensaje con instrucciones y sin comprobante creado';
  });

  await check('ingreso de inventario con costo promedio', async () => {
    const income = await expectOk('POST', '/api/stock-vouchers', {
      body: {
        type: 'income',
        warehouseId: warehouse.id,
        provider: 'PROVEEDOR AUTOTEST',
        items: [{ productId: product.id, quantity: 10, unitCostCents: 5000 }],
      },
      token: tenantToken,
    });
    assert.equal(income.totalCents, 50000);
    return `10 unidades · $${(income.totalCents / 100).toFixed(2)}`;
  });

  let client;
  await check('crear un cliente', async () => {
    client = await expectOk('POST', '/api/clients', {
      body: { idType: '04', idNumber: '1792456789001', name: 'CLIENTE AUTOTEST S.A.', email: 'cliente@autotest.ec', address: 'Quito' },
      token: tenantToken,
    });
    return `${client.name} (${client.idNumber})`;
  });

  section('Comprobantes electrónicos');
  let invoice;
  await check('emitir factura (modo simulado)', async () => {
    invoice = await expectOk('POST', '/api/vouchers', {
      body: { docType: '01', clientId: client.id, items: [{ productId: product.id, quantity: 2 }] },
      token: tenantToken,
    });
    assert.equal(invoice.status, 'issued');
    assert.equal(invoice.subtotalCents, 20000);
    assert.equal(invoice.taxCents, 3000);
    assert.equal(invoice.totalCents, 23000);
    assert.equal(invoice.accessKey.length, 49);
    assert.equal(shared.parseClaveAcceso(invoice.accessKey).valida, true);
    assert.match(invoice.number, /-000000001$/, 'El rechazo por stock no debe consumir el secuencial');
    return `${invoice.number} · ${invoice.totalCents / 100} USD · clave válida`;
  });

  await check('RIDE PDF de la factura', async () => {
    const response = await request('GET', `/api/vouchers/${invoice.id}/pdf`, { token: tenantToken, raw: true });
    assert.equal(response.status, 200);
    const buffer = Buffer.from(await response.arrayBuffer());
    assert.equal(buffer.subarray(0, 5).toString(), '%PDF-');
    return `${buffer.length} bytes`;
  });

  await check('XML de la factura con clave de acceso', async () => {
    const response = await request('GET', `/api/vouchers/${invoice.id}/xml`, { token: tenantToken, raw: true });
    const xml = await response.text();
    assert.match(xml, /<factura id="comprobante" version="1.1.0">/);
    assert.match(xml, /<claveAcceso>\d{49}<\/claveAcceso>/);
    return `${xml.length} bytes`;
  });

  await check('Kardex descuenta 2 unidades (saldo 8)', async () => {
    const kardex = await expectOk('GET', `/api/kardex?productId=${product.id}`, { token: tenantToken });
    assert.equal(kardex.summary.outQty, 2);
    assert.equal(kardex.summary.closingQty, 8);
    return `saldo ${kardex.summary.closingQty}`;
  });

  await check('factura rápida', async () => {
    const quick = await expectOk('POST', '/api/quick-invoices', {
      body: { items: [{ productId: product.id, quantity: 1, unitPriceCents: product.priceCents }], paymentMethod: 'efectivo' },
      token: tenantToken,
    });
    assert.equal(quick.voucher.status, 'issued');
    return quick.voucher.number;
  });

  await check('punto de venta (POS)', async () => {
    const pos = await expectOk('POST', '/api/pos/sales', {
      body: {
        items: [{ productId: product.id, quantity: 1 }],
        payments: [{ method: 'efectivo', amountCents: 11500 }],
      },
      token: tenantToken,
    });
    assert.equal(pos.voucher.status, 'issued');
    return `${pos.voucher.number} · vuelto ${(pos.changeCents / 100).toFixed(2)}`;
  });

  await check('nota de crédito', async () => {
    const note = await expectOk('POST', `/api/vouchers/${invoice.id}/credit-note`, {
      body: { reason: 'Devolución de autodiagnóstico' },
      token: tenantToken,
    });
    assert.equal(note.docType, '04');
    assert.equal(note.status, 'issued');
    return `${note.number} · relacionada con ${invoice.number}`;
  });

  await check('nota de débito', async () => {
    const note = await expectOk('POST', `/api/vouchers/${invoice.id}/debit-note`, {
      body: { reason: 'Intereses de autodiagnóstico', items: [{ productId: product.id, quantity: 1 }] },
      token: tenantToken,
    });
    assert.equal(note.docType, '05');
    assert.equal(note.status, 'issued');
    return note.number;
  });

  await check('guía de remisión', async () => {
    const waybill = await expectOk('POST', '/api/waybills', {
      body: {
        dirPartida: 'Av. Prueba 123, Guayaquil',
        transportista: {
          razonSocial: 'TRANSPORTES AUTOTEST S.A.',
          ruc: companyData.ruc,
          tipoIdentificacion: '04',
          placa: 'AUT-1234',
        },
        fechaIniTransporte: '01/11/2026',
        fechaFinTransporte: '01/11/2026',
        destinatarios: [
          {
            identificacion: '1792456789001',
            razonSocial: 'CLIENTE AUTOTEST S.A.',
            direccion: 'Quito',
            motivoTraslado: '03',
            items: [{ productId: product.id, cantidad: 1 }],
          },
        ],
      },
      token: tenantToken,
    });
    assert.equal(waybill.docType, '06');
    assert.equal(waybill.status, 'issued');
    const pdf = await request('GET', `/api/vouchers/${waybill.id}/pdf`, { token: tenantToken, raw: true });
    const buffer = Buffer.from(await pdf.arrayBuffer());
    assert.equal(buffer.subarray(0, 5).toString(), '%PDF-');
    return `${waybill.number} · RIDE ${buffer.length} bytes`;
  });

  await check('comprobante de retención', async () => {
    const retention = await expectOk('POST', '/api/retentions', {
      body: {
        sujeto: { tipoIdentificacion: '04', identificacion: '1792146141001', razonSocial: 'PROVEEDOR AUTOTEST S.A.' },
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
            impuestos: [{ codImpuestoDocSustento: '2', codigoPorcentaje: '4', baseImponibleCents: 10000, tarifa: 15, valorImpuestoCents: 1500 }],
            retenciones: [
              { codigo: '1', codigoPorcentaje: '303', tarifa: 10, baseImponibleCents: 10000 },
              { codigo: '2', codigoPorcentaje: '1', tarifa: 10, baseImponibleCents: 1500 },
            ],
          },
        ],
      },
      token: tenantToken,
    });
    assert.equal(retention.docType, '07');
    assert.equal(retention.status, 'issued');
    assert.equal(retention.totalCents, 1150);
    const pdf = await request('GET', `/api/vouchers/${retention.id}/pdf`, { token: tenantToken, raw: true });
    const buffer = Buffer.from(await pdf.arrayBuffer());
    assert.equal(buffer.subarray(0, 5).toString(), '%PDF-');
    return `${retention.number} · retenido ${(retention.totalCents / 100).toFixed(2)} USD`;
  });

  section('Panel, usuarios y roles');
  await check('dashboard con métricas de la empresa', async () => {
    const dashboard = await expectOk('GET', '/api/dashboard', { token: tenantToken });
    assert.ok(dashboard.invoicesThisMonth >= 3);
    assert.ok(dashboard.products >= 1);
    assert.ok(dashboard.clients >= 2);
    return `${dashboard.invoicesThisMonth} facturas, ${dashboard.products} productos, ${dashboard.clients} clientes`;
  });

  await check('crear usuario facturador y verificar permisos', async () => {
    const user = await expectOk('POST', '/api/users', {
      body: { username: 'autotest_fact', password: 'fact123', name: 'Facturador Autotest', role: 'facturador' },
      token: tenantToken,
    });
    const login = await expectOk('POST', '/api/auth/login', { body: { username: 'autotest_fact', password: 'fact123' } });
    const forbidden = await request('GET', '/api/users', { token: login.token });
    assert.equal(forbidden.status, 403);
    const invoiceByFact = await expectOk('POST', '/api/vouchers', {
      body: { docType: '01', items: [{ productId: product.id, quantity: 1 }] },
      token: login.token,
    });
    assert.equal(invoiceByFact.status, 'issued');
    return `${user.username} (facturador) · sin permiso de usuarios, sí puede facturar`;
  });

  section('Licencia: suspensión y reactivación');
  await check('suspender licencia bloquea el acceso', async () => {
    await expectOk('PUT', `/api/platform/companies/${companyId}/license`, { body: { status: 'suspended' }, token: superToken });
    const login = await request('POST', '/api/auth/login', { body: { username: 'autotest_admin', password: 'autotest123' } });
    assert.equal(login.status, 403);
    assert.match(login.data.message, /licencia/i);
    return 'login bloqueado con motivo';
  });

  await check('activar licencia (simula pago) restablece el acceso', async () => {
    const activated = await expectOk('POST', `/api/platform/companies/${companyId}/activate`, {
      body: { months: 12, paymentReference: 'AUTOTEST-PAGO-001' },
      token: superToken,
    });
    assert.equal(activated.company.status, 'active');
    const login = await expectOk('POST', '/api/auth/login', { body: { username: 'autotest_admin', password: 'autotest123' } });
    tenantToken = login.token;
    return `licencia ${activated.company.statusLabel} · vence ${activated.company.expiresAt?.slice(0, 10)}`;
  });

  section('Aislamiento entre empresas');
  let otherCompanyId = '';
  let otherTenantToken = '';
  await check('crear segunda empresa', async () => {
    const created = await expectOk('POST', '/api/platform/companies', {
      body: {
        ruc: '0999000002001',
        name: 'EMPRESA AISLADA S.A.',
        plan: 'basico',
        licenseStatus: 'trial',
        trialDays: 15,
        adminUsername: 'autotest_admin2',
        adminPassword: 'autotest123',
        adminName: 'Administrador Aislado',
      },
      token: superToken,
    });
    otherCompanyId = created.company.id;
    const login = await expectOk('POST', '/api/auth/login', { body: { username: 'autotest_admin2', password: 'autotest123' } });
    otherTenantToken = login.token;
    return created.company.name;
  });

  await check('la segunda empresa no ve productos ni comprobantes de la primera', async () => {
    const products = await expectOk('GET', '/api/products', { token: otherTenantToken });
    assert.equal(products.total, 0);
    const cross = await request('GET', `/api/vouchers/${invoice.id}`, { token: otherTenantToken });
    assert.equal(cross.status, 404);
    return 'sin fuga de datos (404 al cruzar)';
  });

  await check('el superadministrador puede configurar cualquier empresa', async () => {
    const scoped = await expectOk('GET', '/api/company', { token: superToken, tenant: otherCompanyId });
    assert.equal(scoped.name, 'EMPRESA AISLADA S.A.');
    return 'acceso con X-Company-Id verificado';
  });

  section('Certificado y firma XAdES');
  let signatureOk = false;
  await check('generar certificado de prueba, cargarlo por PKCS#12 y consultar estado', async () => {
    const generated = sri.generateSelfSignedCertificate({
      commonName: 'AUTOTEST FACTURACION',
      organization: 'EMPRESA AUTODIAGNÓSTICO S.A.',
      country: 'EC',
    });
    const p12 = sri.buildAesTestP12(generated.certificatePem, generated.privateKeyPem, 'autotest123');
    const uploaded = await expectOk('POST', '/api/company/certificate', {
      body: { p12Base64: p12.toString('base64'), password: 'autotest123' },
      token: tenantToken,
    });
    assert.equal(uploaded.hasSignature, true);
    const status = await expectOk('GET', '/api/company/certificate/status', { token: tenantToken });
    assert.equal(status.hasSignature, true);
    assert.ok(status.certificate.subject.includes('AUTOTEST'));
    return status.certificate.subject.replace(/\n/g, ', ');
  });

  await check('firmar XML con XAdES-BES y verificar digests/RSA', async () => {
    const generated = sri.generateSelfSignedCertificate({ commonName: 'AUTOTEST FIRMA', organization: 'AUTOTEST', country: 'EC' });
    const clave = shared.buildClaveAcceso({
      fechaEmision: '01/11/2026',
      codDoc: '01',
      ruc: companyData.ruc,
      ambiente: '1',
      estab: '001',
      ptoEmi: '001',
      secuencial: 999,
    });
    const xml = sri.buildFacturaXml({
      infoTributaria: {
        ambiente: '1',
        tipoEmision: '1',
        razonSocial: 'EMPRESA AUTODIAGNÓSTICO S.A.',
        ruc: companyData.ruc,
        claveAcceso: clave,
        codDoc: '01',
        estab: '001',
        ptoEmi: '001',
        secuencial: '000000999',
        dirMatriz: 'Guayaquil',
      },
      infoFactura: {
        fechaEmision: '01/11/2026',
        obligadoContabilidad: 'NO',
        comprador: { tipoIdentificacion: '07', razonSocial: 'CONSUMIDOR FINAL', identificacion: '9999999999999' },
        totalSinImpuestos: 100,
        totalDescuento: 0,
        totalConImpuestos: [{ codigo: '2', codigoPorcentaje: '4', tarifa: 15, baseImponible: 100, valor: 15 }],
        propina: 0,
        importeTotal: 115,
        pagos: [{ formaPago: 'efectivo', total: 115 }],
      },
      detalles: [
        {
          codigoPrincipal: 'AUTO-001',
          descripcion: 'Producto de autodiagnóstico',
          cantidad: 1,
          precioUnitario: 100,
          descuento: 0,
          subtotal: 100,
          impuestos: [{ codigo: '2', codigoPorcentaje: '4', tarifa: 15, baseImponible: 100, valor: 15 }],
        },
      ],
    });
    const signed = sri.signXml(xml, { certificatePem: generated.certificatePem, privateKeyPem: generated.privateKeyPem });
    const verification = sri.verifySignedXml(signed.xml);
    assert.equal(verification.valid, true, verification.details?.join('; '));
    signatureOk = true;
    // Validación externa con el JDK si está disponible.
    const java = spawnSync('java', ['-version'], { stdio: 'ignore' });
    if (java.status === 0) {
      const file = path.join(tmpDir, 'firma-autotest.xml');
      fs.writeFileSync(file, signed.xml, 'utf8');
      const validated = spawnSync('java', [path.resolve('tools/ValidarFirma.java'), file], { stdio: 'ignore' });
      if (validated.status === 0) return 'local + validador XMLDSig del JDK: VÁLIDA';
      warning('El validador Java no confirmó la firma (revise java/tools/ValidarFirma.java)');
      return 'local: VÁLIDA (validador Java no disponible/falló)';
    }
    warning('Java no está disponible; se omitió la validación externa de la firma');
    return 'local: VÁLIDA';
  });

  section('SRI real (opcional)');
  if (includeSri) {
    await check('conectividad con los servicios web del SRI', async () => {
      const test = await expectOk('POST', '/api/integration/sri/test', { body: {}, token: tenantToken });
      assert.equal(test.ok, true, `SRI respondió: ${test.error ?? 'sin detalle'}`);
      return `HTTP ${test.httpStatus} · ${test.latencyMs} ms · ${test.ambienteLabel}`;
    });

    await check('emisión en direct-sri: firma verificada, envío y respuesta del SRI', async () => {
      await expectOk('PUT', '/api/company', { body: { sriMode: 'direct-sri', signatureDigest: 'sha1' }, token: tenantToken });
      const voucher = await expectOk('POST', '/api/vouchers', {
        body: { docType: '01', items: [{ productId: product.id, quantity: 1 }] },
        token: tenantToken,
      });
      // Con RUC de prueba el SRI rechaza, pero debe existir respuesta real y firma válida.
      assert.ok(['failed', 'issued', 'sent', 'offline'].includes(voucher.status));
      const signature = await expectOk('GET', `/api/vouchers/${voucher.id}/signature-check`, { token: tenantToken });
      assert.equal(signature.valid, true, signature.details?.join('; '));
      const logs = await expectOk('GET', `/api/vouchers/${voucher.id}/sri-logs`, { token: tenantToken });
      assert.ok(logs.length >= 1);
      const firstMessage = voucher.sriMessages?.[0]?.mensaje;
      await expectOk('PUT', '/api/company', { body: { sriMode: 'mock' }, token: tenantToken });
      return `${voucher.number} · ${voucher.status}${firstMessage ? ` · SRI: ${firstMessage}` : ''}`;
    });
  } else {
    warning('Se omitió la prueba real contra el SRI (use --sri para incluirla; requiere internet).');
  }

  /* ------------------------------------------------------------- resultado */

  const passed = results.filter((item) => item.ok).length;
  const failed = results.length - passed;
  console.log('\n========================================');
  console.log(`  RESULTADO: ${passed}/${results.length} verificaciones correctas`);
  if (failed > 0) {
    console.log('  Fallaron:');
    for (const item of results.filter((entry) => !entry.ok)) {
      console.log(`   - ${item.name}: ${item.error}`);
    }
  }
  console.log('========================================\n');

  const failedChecks = results.filter((item) => !item.ok);
  process.exitCode = failedChecks.length === 0 ? 0 : 1;
  void signatureOk;
  void currentSection;
  void otherCompanyId;
} catch (error) {
  console.error('\nEl autodiagnóstico no pudo completarse:', error);
  process.exitCode = 2;
} finally {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  try {
    db.closeDatabases();
  } catch {
    /* ignore */
  }
  if (!keepTemp) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  } else {
    console.log(`Datos temporales conservados en ${tmpDir}`);
  }
}


