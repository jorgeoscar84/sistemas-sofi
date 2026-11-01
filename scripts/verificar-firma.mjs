/**
 * Verificación integral de la firma electrónica XAdES-BES.
 *
 * Genera (si hace falta) un certificado de prueba, construye los cinco tipos de
 * comprobante del SRI, los firma, comprueba los digests localmente y valida cada
 * XML con el validador XMLDSig estándar del JDK (`tools/ValidarFirma.java`).
 *
 * Uso:  node scripts/verificar-firma.mjs [--sha256] [--out storage/certs/prueba]
 * Requisitos: Java 17+ en el PATH (sólo para la validación externa).
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { buildClaveAcceso } from '../packages/shared/src/index.ts';
import {
  buildFacturaXml,
  buildGuiaRemisionXml,
  buildNotaCreditoXml,
  buildNotaDebitoXml,
  buildRetencionXml,
  generateSelfSignedCertificate,
  signXml,
  verifySignedXml,
} from '../packages/sri/src/index.ts';

const args = process.argv.slice(2);
const useSha256 = args.includes('--sha256');
const outIndex = args.indexOf('--out');
const outDir = path.resolve(outIndex >= 0 ? args[outIndex + 1] : path.join('storage', 'certs', 'prueba'));
fs.mkdirSync(outDir, { recursive: true });

/* ---------------------------------------------------- certificado de prueba */

const certPath = path.join(outDir, 'certificate.pem');
const keyPath = path.join(outDir, 'private-key.pem');
let certificatePem;
let privateKeyPem;
if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  certificatePem = fs.readFileSync(certPath, 'utf8');
  privateKeyPem = fs.readFileSync(keyPath, 'utf8');
  console.log(`Certificado existente: ${certPath}`);
} else {
  const generated = generateSelfSignedCertificate({
    commonName: 'PRUEBA FACTURACION EC',
    organization: 'COMERCIAL DEMO S.A.',
    country: 'EC',
  });
  certificatePem = generated.certificatePem;
  privateKeyPem = generated.privateKeyPem;
  fs.writeFileSync(certPath, certificatePem, 'utf8');
  fs.writeFileSync(keyPath, privateKeyPem, 'utf8');
  console.log(`Certificado generado: ${certPath}`);
}

/* --------------------------------------------------------------- utilidades */

const RUC = '1792456789001';
const FECHA = '01/11/2026';
let sequence = 0;

function nextClave(codDoc) {
  sequence += 1;
  return buildClaveAcceso({
    fechaEmision: FECHA,
    codDoc,
    ruc: RUC,
    ambiente: '1',
    estab: '001',
    ptoEmi: '001',
    secuencial: sequence,
  });
}

function infoTributaria(codDoc) {
  const clave = nextClave(codDoc);
  return {
    clave,
    info: {
      ambiente: '1',
      tipoEmision: '1',
      razonSocial: 'COMERCIAL DEMO S.A.',
      nombreComercial: 'COMERCIAL DEMO',
      ruc: RUC,
      claveAcceso: clave,
      codDoc,
      estab: '001',
      ptoEmi: '001',
      secuencial: String(sequence).padStart(9, '0'),
      dirMatriz: 'Av. Amazonas N34-120, Quito',
      obligadoContabilidad: 'SI',
    },
  };
}

const detalle = {
  codigoPrincipal: 'P001',
  descripcion: 'Laptop Lenovo ThinkPad E14',
  cantidad: 2,
  precioUnitario: 100,
  descuento: 0,
  subtotal: 200,
  impuestos: [{ codigo: '2', codigoPorcentaje: '4', tarifa: 15, baseImponible: 200, valor: 30 }],
};

function documentos() {
  const docs = [];

  {
    const { info } = infoTributaria('01');
    docs.push({
      name: 'factura',
      xml: buildFacturaXml({
        infoTributaria: info,
        infoFactura: {
          fechaEmision: FECHA,
          dirEstablecimiento: 'Av. Amazonas N34-120, Quito',
          obligadoContabilidad: 'SI',
          comprador: { tipoIdentificacion: '04', razonSocial: 'ALEJANDRO TES', identificacion: '1752048122001' },
          totalSinImpuestos: 200,
          totalDescuento: 0,
          totalConImpuestos: [{ codigo: '2', codigoPorcentaje: '4', tarifa: 15, baseImponible: 200, valor: 30 }],
          propina: 0,
          importeTotal: 230,
          pagos: [{ formaPago: 'efectivo', total: 230 }],
        },
        detalles: [detalle],
        infoAdicional: [{ nombre: 'Orden de compra', valor: 'OC-001' }],
      }),
    });
  }

  {
    const { info } = infoTributaria('04');
    docs.push({
      name: 'nota-credito',
      xml: buildNotaCreditoXml({
        infoTributaria: info,
        infoNotaCredito: {
          fechaEmision: FECHA,
          tipoIdentificacionComprador: '04',
          razonSocialComprador: 'ALEJANDRO TES',
          identificacionComprador: '1752048122001',
          obligadoContabilidad: 'SI',
          codDocModificado: '01',
          numDocModificado: '001-001-000000001',
          fechaEmisionDocSustento: FECHA,
          totalSinImpuestos: 200,
          valorModificacion: 230,
          totalConImpuestos: [{ codigo: '2', codigoPorcentaje: '4', tarifa: 15, baseImponible: 200, valor: 30 }],
          motivo: 'Devolución de mercadería',
        },
        detalles: [detalle],
      }),
    });
  }

  {
    const { info } = infoTributaria('05');
    docs.push({
      name: 'nota-debito',
      xml: buildNotaDebitoXml({
        infoTributaria: info,
        infoNotaDebito: {
          fechaEmision: FECHA,
          tipoIdentificacionComprador: '04',
          razonSocialComprador: 'ALEJANDRO TES',
          identificacionComprador: '1752048122001',
          obligadoContabilidad: 'SI',
          codDocModificado: '01',
          numDocModificado: '001-001-000000001',
          fechaEmisionDocSustento: FECHA,
          totalSinImpuestos: 100,
          impuestos: [{ codigo: '2', codigoPorcentaje: '4', tarifa: 15, baseImponible: 100, valor: 15 }],
          valorTotal: 115,
          motivo: 'Intereses de mora',
        },
      }),
    });
  }

  {
    const { info } = infoTributaria('07');
    docs.push({
      name: 'retencion',
      xml: buildRetencionXml({
        infoTributaria: info,
        infoCompRetencion: {
          fechaEmision: FECHA,
          dirEstablecimiento: 'Av. Amazonas N34-120, Quito',
          obligadoContabilidad: 'SI',
          tipoIdentificacionSujetoRetenido: '04',
          razonSocialSujetoRetenido: 'PROVEEDOR DEMO S.A.',
          identificacionSujetoRetenido: '1792146141001',
          periodoFiscal: '10/2026',
        },
        docsSustento: [
          {
            codSustento: '01',
            codDocSustento: '01',
            numDocSustento: '001-001-000000123',
            fechaEmisionDocSustento: '15/10/2026',
            numAutDocSustento: '1510202601179214614100120010010000001231234567811',
            pagoLocExt: '01',
            totalSinImpuestos: 100,
            importeTotal: 115,
            impuestosDocSustento: [
              { codImpuestoDocSustento: '2', codigoPorcentaje: '4', baseImponible: 100, tarifa: 15, valorImpuesto: 15 },
            ],
            retenciones: [
              { codigo: '1', codigoPorcentaje: '303', tarifa: 10, baseImponible: 100, valorRetenido: 10 },
              { codigo: '2', codigoPorcentaje: '1', tarifa: 10, baseImponible: 15, valorRetenido: 1.5 },
            ],
          },
        ],
      }),
    });
  }

  {
    const { info } = infoTributaria('06');
    docs.push({
      name: 'guia-remision',
      xml: buildGuiaRemisionXml({
        infoTributaria: info,
        infoGuiaRemision: {
          dirEstablecimiento: 'Av. Amazonas N34-120, Quito',
          dirPartida: 'Av. Amazonas N34-120, Quito',
          razonSocialTransportista: 'TRANSPORTES ANDINOS S.A.',
          tipoIdentificacionTransportista: '04',
          rucTransportista: RUC,
          obligadoContabilidad: 'SI',
          fechaIniTransporte: FECHA,
          fechaFinTransporte: FECHA,
          placa: 'PBX-1234',
        },
        destinatarios: [
          {
            identificacionDestinatario: '1752048122001',
            razonSocialDestinatario: 'ALEJANDRO TES',
            dirDestinatario: 'Av. 6 de Diciembre N24-56, Quito',
            motivoTraslado: '03',
            codDocSustento: '01',
            numDocSustento: '001-001-000000001',
            fechaEmisionDocSustento: FECHA,
            detalles: [{ codigoInterno: 'P001', descripcion: 'Laptop Lenovo ThinkPad E14', cantidad: 2 }],
          },
        ],
      }),
    });
  }

  return docs;
}

/* --------------------------------------------------------------- validación */

const javaTool = path.resolve('tools', 'ValidarFirma.java');
const javaAvailable = spawnSync('java', ['-version'], { stdio: 'ignore' }).status === 0;
if (!javaAvailable) console.warn('AVISO: Java no está disponible; se omite la validación externa XMLDSig.');

let failures = 0;
for (const document of documentos()) {
  const signed = signXml(document.xml, {
    certificatePem,
    privateKeyPem,
    digestAlgorithm: useSha256 ? 'sha256' : 'sha1',
  });
  const file = path.join(outDir, `${document.name}-firmado.xml`);
  fs.writeFileSync(file, signed.xml, 'utf8');
  const verification = verifySignedXml(signed.xml);
  let javaResult = 'omitido';
  if (javaAvailable) {
    // El sandbox no permite capturar stdout de procesos (EPERM); el validador
    // devuelve código 0 si la firma es válida y 1 si no, así que usamos el exit code.
    const run = spawnSync('java', [javaTool, file], { stdio: 'ignore' });
    if (run.error) javaResult = `error:${run.error.code ?? run.error.message}`;
    else javaResult = run.status === 0 ? 'VALID' : `INVALID(exit=${run.status})`;
    if (javaResult !== 'VALID') failures += 1;
  }
  const local = verification.valid ? 'VALID' : 'INVALID';
  if (!verification.valid) failures += 1;
  console.log(
    `${document.name.padEnd(16)} firma_sh${useSha256 ? '256' : 'a1'}: local=${local} java=${javaResult} ` +
      `(doc=${verification.documentDigestValid} props=${verification.signedPropertiesDigestValid} rsa=${verification.signatureValid})`,
  );
}

console.log(
  failures === 0
    ? '\nRESULTADO: todos los comprobantes tienen firma XAdES válida (local + validador XMLDSig del JDK).'
    : `\nRESULTADO: ${failures} comprobante(s) con problemas de firma.`,
);
process.exit(failures === 0 ? 0 : 1);

void pathToFileURL;

