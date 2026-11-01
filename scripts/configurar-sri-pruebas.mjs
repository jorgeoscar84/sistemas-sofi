/**
 * Configura el modo de emisión y el ambiente del SRI en una instancia en ejecución.
 *
 * Uso:
 *   node scripts/configurar-sri-pruebas.mjs [opciones]
 *
 * Opciones:
 *   --url <url>            Base de la API (default http://127.0.0.1:4000)
 *   --user <usuario>       Usuario administrador (default admin)
 *   --password <clave>     Contraseña (default admin123)
 *   --mode <mock|direct-sri|upconta>   Modo de emisión (default direct-sri)
 *   --environment <1|2>    Ambiente SRI (default 1 = pruebas)
 *   --p12 <ruta>           Archivo PKCS#12 a cargar (default storage/certs/prueba/certificado.p12)
 *   --p12-password <clave> Contraseña del PKCS#12 (default la de meta.json o PruebaSri2026*)
 *   --no-certificate       No cargar certificado (solo cambiar modo/ambiente)
 *   --test                 Ejecutar la prueba de conectividad con el SRI
 */

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}
function hasFlag(name) {
  return args.includes(name);
}

const baseUrl = argValue('--url', 'http://127.0.0.1:4000').replace(/\/$/, '');
const user = argValue('--user', 'admin');
const password = argValue('--password', 'admin123');
const mode = argValue('--mode', 'direct-sri');
const environment = Number(argValue('--environment', '1'));
const signature = argValue('--signature', 'sha1');
const p12Path = argValue('--p12', path.join('storage', 'certs', 'prueba', 'certificado.p12'));

function readP12Password() {
  if (hasFlag('--p12-password')) return argValue('--p12-password', '');
  const metaPath = path.join(path.dirname(p12Path), 'meta.json');
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (meta.p12Password) return meta.p12Password;
    } catch {
      /* ignore */
    }
  }
  return 'PruebaSri2026*';
}

async function request(method, endpoint, body, token) {
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

const login = await request('POST', '/api/auth/login', { username: user, password });
const token = login.token;
console.log(`Conectado a ${baseUrl} como ${login.user.name} (${login.user.role})`);

if (!hasFlag('--no-certificate')) {
  if (!fs.existsSync(p12Path)) {
    console.error(`No se encontró el certificado: ${p12Path}`);
    console.error('Genérelo con: node scripts/certificado-prueba.mjs');
    process.exit(1);
  }
  const p12Base64 = fs.readFileSync(p12Path).toString('base64');
  const certResult = await request(
    'POST',
    '/api/company/certificate',
    { p12Base64, password: readP12Password() },
    token,
  );
  console.log('Certificado cargado:', certResult.certificate.subject.replace(/\n/g, ', '));
  console.log('  válido hasta:', certResult.certificate.validTo);
}

const company = await request(
  'PUT',
  '/api/company',
  { environment, sriMode: mode, signatureDigest: signature, ...(environment === 2 ? { confirmProduction: true } : {}) },
  token,
);
console.log(`Configuración aplicada: ambiente ${company.environment} (${company.environment === 2 ? 'producción' : 'pruebas'}), modo ${company.sriMode}`);

const status = await request('GET', '/api/integration/sri/status', undefined, token);
console.log('Estado SRI:', JSON.stringify({ mode: status.mode, environment: status.environment, hasSignature: status.hasSignature }));

if (hasFlag('--test') || mode === 'direct-sri') {
  const test = await request('POST', '/api/integration/sri/test', {}, token);
  console.log('Prueba de conectividad SRI:', JSON.stringify(test, null, 2));
}

if (mode === 'direct-sri') {
  console.log(
    '\nNOTA: en modo direct-sri los comprobantes se firman y se envían al SRI. ' +
      'Con un certificado autofirmado el SRI los rechazará (FIRMA INVÁLIDA / RUC no registrado). ' +
      'Cargue su certificado emitido por una entidad certificadora autorizada para autorizar comprobantes reales.',
  );
  console.log('Puede volver al modo simulado con: node scripts/configurar-sri-pruebas.mjs --mode mock --no-certificate');
}

