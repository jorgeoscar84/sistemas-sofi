/**
 * Prueba de emisión real contra el SRI.
 *
 * Requiere que la aplicación esté configurada en modo `direct-sri` con un
 * certificado válido y un RUC habilitado en el ambiente correspondiente.
 *
 * Uso:
 *   node scripts/probar-emision-sri.mjs [--url http://127.0.0.1:4000]
 *       [--user admin] [--password admin123] [--product CODIGO] [--quantity 1]
 *
 * Salida:
 *   0 = comprobante AUTORIZADO por el SRI
 *   3 = el SRI respondió pero rechazó el comprobante (revise los mensajes)
 *   1 = error técnico
 */

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
function arg(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const baseUrl = arg('--url', 'http://127.0.0.1:4000').replace(/\/$/, '');
const user = arg('--user', 'admin');
const password = arg('--password', 'admin123');
const productCode = arg('--product', '');
const quantity = Number(arg('--quantity', '1'));

let token = '';
async function request(method, endpoint, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!response.ok) throw new Error(`${method} ${endpoint} → ${response.status}: ${data.message ?? text}`);
  return data;
}

try {
  const login = await request('POST', '/api/auth/login', { username: user, password });
  token = login.token;
  console.log(`Conectado a ${baseUrl} como ${login.user.name}`);

  const company = await request('GET', '/api/company');
  const certificate = await request('GET', '/api/company/certificate/status');
  const sri = await request('GET', '/api/integration/sri/status');
  console.log(`Empresa:      ${company.name} · RUC ${company.ruc}`);
  console.log(`Ambiente SRI: ${sri.environmentLabel} · modo: ${company.sriMode} · firma: ${company.signatureDigest.toUpperCase()}`);
  console.log(`Certificado:  ${certificate.hasSignature ? certificate.certificate?.subject.replace(/\n/g, ', ') : 'SIN CERTIFICADO'}`);
  if (company.sriMode !== 'direct-sri') {
    console.error('\nEl modo de emisión no es direct-sri. Configúrelo en Administración → Integraciones.');
    process.exit(1);
  }
  if (!certificate.hasSignature) {
    console.error('\nNo hay certificado cargado. Cárguelo en Administración → Empresa y SRI.');
    process.exit(1);
  }

  const connectivity = await request('POST', '/api/integration/sri/test', {});
  console.log(`Conectividad: ${connectivity.ok ? 'OK' : 'FALLA'} · HTTP ${connectivity.httpStatus ?? '—'} · ${connectivity.latencyMs} ms`);
  if (!connectivity.ok) {
    console.error(`\nNo se pudo contactar al SRI: ${connectivity.error ?? 'sin detalle'}`);
    process.exit(1);
  }

  const options = await request('GET', '/api/vouchers/options');
  const establishment = options.establishments[0];
  const point = establishment.emissionPoints[0];
  const product = productCode
    ? options.products.find((candidate) => candidate.code === productCode)
    : options.products.find((candidate) => candidate.type === 'product');
  if (!product) {
    console.error(`\nNo se encontró el producto ${productCode || '(ninguno)'}`);
    process.exit(1);
  }

  console.log(`\nEmitiendo factura: ${quantity} x ${product.code} ${product.description} …`);
  const voucher = await request('POST', '/api/vouchers', {
    docType: '01',
    establishmentId: establishment.id,
    emissionPointId: point.id,
    items: [{ productId: product.id, quantity }],
  });

  console.log(`\nComprobante:   ${voucher.number}`);
  console.log(`Estado:        ${voucher.status}`);
  console.log(`Clave acceso:  ${voucher.accessKey}`);
  if (voucher.authorizationNumber) console.log(`Autorización:  ${voucher.authorizationNumber} (${voucher.authorizationDate})`);

  const signature = await request('GET', `/api/vouchers/${voucher.id}/signature-check`);
  console.log(`Firma:         ${signature.valid ? 'VÁLIDA' : 'INVÁLIDA'} (${signature.digestAlgorithm.toUpperCase()}, RSA=${signature.signatureValid}, doc=${signature.documentDigestValid}, props=${signature.signedPropertiesDigestValid})`);
  if (!signature.valid) {
    console.log(`Detalles:      ${(signature.details || []).join('; ')}`);
  }

  const messages = voucher.sriMessages || [];
  if (messages.length) {
    console.log('\nMensajes del SRI:');
    for (const message of messages) {
      console.log(`  [${message.identificador ?? ''}] ${message.mensaje ?? ''}${message.informacionAdicional ? ` · ${message.informacionAdicional}` : ''}`);
    }
  }

  const logs = await request('GET', `/api/vouchers/${voucher.id}/sri-logs`);
  console.log(`\nInteracciones con el SRI registradas: ${logs.length}`);
  for (const log of logs) console.log(`  - ${log.stage} · HTTP ${log.httpStatus ?? '—'}`);

  const outputDir = path.resolve('storage', 'emisiones');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, `${voucher.accessKey ?? voucher.id}.json`), JSON.stringify({ voucher, signature, logs }, null, 2));

  if (voucher.status === 'issued') {
    console.log('\nRESULTADO: comprobante AUTORIZADO por el SRI.');
    console.log(`RIDE: ${baseUrl}/api/vouchers/${voucher.id}/pdf`);
    console.log(`XML:  ${baseUrl}/api/vouchers/${voucher.id}/xml?type=authorized`);
    process.exit(0);
  }
  console.log('\nRESULTADO: el SRI no autorizó el comprobante (revise los mensajes de arriba).');
  process.exit(3);
} catch (error) {
  console.error('\nError al probar la emisión:', error.message);
  process.exit(1);
}
