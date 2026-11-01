/**
 * Genera un certificado autofirmado de PRUEBA (PEM + PKCS#12) para ejercitar el
 * flujo `direct-sri` sin un certificado emitido por una entidad certificadora.
 *
 * Uso:  node scripts/certificado-prueba.mjs [--password clave] [--out storage/certs/prueba]
 *
 * El SRI NO autoriza comprobantes firmados con un certificado autofirmado: este
 * certificado sirve para verificar firma, conexión SOAP y rechazo controlado del SRI.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  buildTestP12,
  generateSelfSignedCertificate,
  inspectSigningMaterial,
  parseP12,
} from '../packages/sri/src/index.ts';

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const password = argValue('--password', 'PruebaSri2026*');
const outputDir = path.resolve(argValue('--out', path.join('storage', 'certs', 'prueba')));
const commonName = argValue('--cn', 'PRUEBA FACTURACION EC');
const organization = argValue('--org', 'COMERCIAL DEMO S.A.');
const country = argValue('--country', 'EC');

fs.mkdirSync(outputDir, { recursive: true });

const { certificatePem, privateKeyPem } = generateSelfSignedCertificate({
  commonName,
  organization,
  country,
  days: 365,
});

const p12 = buildTestP12(certificatePem, privateKeyPem, password);

fs.writeFileSync(path.join(outputDir, 'certificate.pem'), certificatePem, 'utf8');
fs.writeFileSync(path.join(outputDir, 'private-key.pem'), privateKeyPem, 'utf8');
fs.writeFileSync(path.join(outputDir, 'certificado.p12'), p12);

const info = inspectSigningMaterial(certificatePem, privateKeyPem);
const reParsed = parseP12(p12, password);
const meta = {
  subject: info.subject,
  issuer: info.issuer,
  validFrom: info.validFrom,
  validTo: info.validTo,
  serialNumber: info.serialNumber,
  p12Password: password,
  p12Bytes: p12.length,
  p12SelfCheck: reParsed.subject === info.subject,
  note: 'Certificado autofirmado SOLO para pruebas: el SRI lo rechazará con FIRMA INVÁLIDA.',
  generatedAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(outputDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');

console.log('Certificado de prueba generado en', outputDir);
console.log('  subject:', info.subject);
console.log('  válido hasta:', info.validTo);
console.log('  P12:', p12.length, 'bytes · contraseña:', password);
console.log('  auto-lectura P12:', meta.p12SelfCheck ? 'OK' : 'FALLÓ');
