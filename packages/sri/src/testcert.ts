/**
 * Generación de un certificado X.509 autofirmado y de un PKCS#12 de prueba.
 *
 * Sirve para probar el flujo completo de firma XAdES y de lectura de .p12 sin
 * depender de OpenSSL ni de un certificado emitido por una entidad certificadora.
 *
 * IMPORTANTE: un certificado autofirmado NO es aceptado por el SRI para autorizar
 * comprobantes; sirve para verificar la conexión y la firma, no para producción.
 */

import crypto from 'node:crypto';
import {
  bitString,
  bmpPassword,
  contextTag,
  integer,
  nullValue,
  octetString,
  oid,
  seq,
  setOf,
  tlv,
  utcTime,
  utf8,
} from './asn1.ts';
import { derivePkcs12Key } from './p12.ts';
import { rc2CbcEncrypt } from './rc2.ts';

const OID_SHA256_RSA = '1.2.840.113549.1.1.11';
const OID_RSA = '1.2.840.113549.1.1.1';
const OID_CN = '2.5.4.3';
const OID_O = '2.5.4.10';
const OID_OU = '2.5.4.11';
const OID_C = '2.5.4.6';
const OID_BASIC_CONSTRAINTS = '2.5.29.19';
const OID_KEY_USAGE = '2.5.29.15';
const OID_DATA = '1.2.840.113549.1.7.1';
const OID_ENCRYPTED_DATA = '1.2.840.113549.1.7.6';
const OID_CERT_BAG = '1.2.840.113549.1.12.10.1.3';
const OID_KEY_BAG = '1.2.840.113549.1.12.10.1.1';
const OID_X509_CERT = '1.2.840.113549.1.9.22.1';
const OID_PBE_3DES = '1.2.840.113549.1.12.1.3';

export interface CertificateOptions {
  commonName: string;
  organization?: string;
  organizationalUnit?: string;
  country?: string;
  days?: number;
}

function nameOrdered(options: CertificateOptions): Buffer {
  const rdns: Buffer[] = [];
  rdns.push(setOf(seq(oid(OID_CN), utf8(options.commonName))));
  if (options.organization) rdns.push(setOf(seq(oid(OID_O), utf8(options.organization))));
  if (options.organizationalUnit) rdns.push(setOf(seq(oid(OID_OU), utf8(options.organizationalUnit))));
  if (options.country) rdns.push(setOf(seq(oid(OID_C), utf8(options.country))));
  return seq(...rdns);
}

/** Genera un par de claves RSA y un certificado X.509 v3 autofirmado en PEM. */
export function generateSelfSignedCertificate(options: CertificateOptions): {
  certificatePem: string;
  privateKeyPem: string;
  publicKeyPem: string;
} {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const algorithm = seq(oid(OID_SHA256_RSA), nullValue());
  const serial = BigInt(`0x${crypto.randomBytes(8).toString('hex')}`) & 0x7fffffffffffffffn;
  const now = new Date();
  const notBefore = new Date(now.getTime() - 60_000);
  const notAfter = new Date(now.getTime() + (options.days ?? 365) * 86_400_000);

  const spki = crypto.createPublicKey(publicKey).export({ type: 'spki', format: 'der' }) as Buffer;
  const name = nameOrdered(options);

  const basicConstraints = seq(
    oid(OID_BASIC_CONSTRAINTS),
    tlv(0x01, Buffer.from([0xff])), // critical
    octetString(seq(tlv(0x01, Buffer.from([0xff])))), // CA:TRUE
  );
  const keyUsage = seq(
    oid(OID_KEY_USAGE),
    tlv(0x01, Buffer.from([0xff])),
    octetString(bitString(Buffer.from([0xa0]), 5)), // digitalSignature + keyEncipherment
  );

  const tbs = seq(
    contextTag(0, integer(2)),
    integer(serial),
    algorithm,
    name,
    seq(utcTime(notBefore), utcTime(notAfter)),
    name,
    spki,
    contextTag(3, seq(basicConstraints, keyUsage)),
  );

  const signature = crypto.sign('sha256', tbs, privateKey);
  const certificate = seq(tbs, algorithm, bitString(signature));
  const certificatePem = toPem('CERTIFICATE', certificate);
  return { certificatePem, privateKeyPem: privateKey, publicKeyPem: publicKey };
}

function toPem(label: string, der: Buffer): string {
  const base64 = der.toString('base64').replace(/(.{64})/g, '$1\n').trimEnd();
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----\n`;
}

export function pemToDer(pem: string): Buffer {
  const base64 = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  return Buffer.from(base64, 'base64');
}

function contentTypeData(inner: Buffer): Buffer {
  return seq(oid(OID_DATA), contextTag(0, octetString(inner)));
}

function safeBag(bagOid: string, value: Buffer): Buffer {
  return seq(oid(bagOid), contextTag(0, value));
}

function certBag(certificateDer: Buffer): Buffer {
  return seq(oid(OID_CERT_BAG), contextTag(0, seq(oid(OID_X509_CERT), contextTag(0, octetString(certificateDer)))));
}

function encrypt3des(plain: Buffer, password: string): Buffer {
  const salt = crypto.randomBytes(8);
  const iterations = 2048;
  const key = derivePkcs12Key(password, salt, iterations, 1, 24);
  const iv = derivePkcs12Key(password, salt, iterations, 2, 8);
  const cipher = crypto.createCipheriv('des-ede3-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const algorithm = seq(oid(OID_PBE_3DES), seq(octetString(salt), integer(iterations)));
  const encryptedContentInfo = seq(oid(OID_DATA), algorithm, contextTag(0, encrypted, false));
  return seq(oid(OID_ENCRYPTED_DATA), contextTag(0, seq(integer(0), encryptedContentInfo)));
}

/**
 * Construye un PKCS#12 de prueba: certificado en claro y clave privada protegida
 * con PBE SHA-1/3DES (la variante habitual de los .p12 ecuatorianos).
 */
export function buildTestP12(certificatePem: string, privateKeyPem: string, password: string): Buffer {
  const certificateDer = pemToDer(certificatePem);
  const privateKeyDer = pemToDer(privateKeyPem);

  const certContents = seq(certBag(certificateDer));
  const keyContents = seq(safeBag(OID_KEY_BAG, privateKeyDer));

  const authenticatedSafe = seq(contentTypeData(certContents), encrypt3des(keyContents, password));
  const authSafe = contentTypeData(authenticatedSafe);
  const pfx = seq(integer(3), authSafe);
  return pfx;
}

void bmpPassword;


/* ------------------------------------------------- PKCS#12 "legacy" (RC2) */

const OID_PBE_RC2_40 = '1.2.840.113549.1.12.1.6';

function encryptedContentInfo(algorithmOid: string, salt: Buffer, iterations: number, cipherText: Buffer, iv?: Buffer): Buffer {
  const algorithmParams = iv
    ? seq(oid(algorithmOid), seq(octetString(salt), integer(iterations)))
    : seq(oid(algorithmOid), seq(octetString(salt), integer(iterations)));
  void iv;
  return (
    seq(oid(OID_DATA), algorithmParams, contextTag(0, cipherText, false))
  );
}

function encryptSafeContents3des(plain: Buffer, password: string): Buffer {
  const salt = crypto.randomBytes(8);
  const iterations = 2048;
  const key = derivePkcs12Key(password, salt, iterations, 1, 24);
  const iv = derivePkcs12Key(password, salt, iterations, 2, 8);
  const cipher = crypto.createCipheriv('des-ede3-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const info = encryptedContentInfo(OID_PBE_3DES, salt, iterations, encrypted);
  return seq(oid(OID_ENCRYPTED_DATA), contextTag(0, seq(integer(0), info)));
}

function encryptSafeContentsRc2(plain: Buffer, password: string): Buffer {
  const salt = crypto.randomBytes(8);
  const iterations = 2048;
  const key = derivePkcs12Key(password, salt, iterations, 1, 5);
  const iv = derivePkcs12Key(password, salt, iterations, 2, 8);
  const encrypted = rc2CbcEncrypt(Uint8Array.from(plain), Uint8Array.from(key), Uint8Array.from(iv), 40);
  const info = encryptedContentInfo(OID_PBE_RC2_40, salt, iterations, encrypted);
  return seq(oid(OID_ENCRYPTED_DATA), contextTag(0, seq(integer(0), info)));
}

/**
 * Construye un PKCS#12 con el esquema "legacy" de OpenSSL: certificado en un
 * SafeContents cifrado con RC2-40 y clave privada en otro cifrado con 3DES.
 * Sirve para probar la lectura de certificados ecuatorianos antiguos.
 */
export function buildLegacyTestP12(certificatePem: string, privateKeyPem: string, password: string): Buffer {
  const certificateDer = pemToDer(certificatePem);
  const privateKeyDer = pemToDer(privateKeyPem);
  const certContents = seq(certBag(certificateDer));
  const keyContents = seq(safeBag(OID_KEY_BAG, privateKeyDer));
  const authenticatedSafe = seq(
    encryptSafeContentsRc2(certContents, password),
    encryptSafeContents3des(keyContents, password),
  );
  return seq(integer(3), contentTypeData(authenticatedSafe));
}

/* --------------------------------------------- PKCS#12 moderno (PBES2/AES) */

const OID_PBES2 = '1.2.840.113549.1.5.13';
const OID_PBKDF2 = '1.2.840.113549.1.5.12';
const OID_HMAC_SHA256 = '1.2.840.113549.2.9';
const OID_AES_256_CBC = '2.16.840.1.101.3.4.1.42';

function encryptAes256Pbes2(plain: Buffer, password: string): Buffer {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(16);
  const iterations = 10_000;
  const keyLength = 32;
  const key = crypto.pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iterations, keyLength, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const pbkdf2Params = seq(
    octetString(salt),
    integer(iterations),
    integer(keyLength),
    seq(oid(OID_HMAC_SHA256), nullValue()),
  );
  const pbes2Params = seq(
    seq(oid(OID_PBKDF2), pbkdf2Params),
    seq(oid(OID_AES_256_CBC), octetString(iv)),
  );
  const encryptedContentInfo = seq(
    oid(OID_DATA),
    seq(oid(OID_PBES2), pbes2Params),
    contextTag(0, encrypted, false),
  );
  return seq(oid(OID_ENCRYPTED_DATA), contextTag(0, seq(integer(0), encryptedContentInfo)));
}

/**
 * Construye un PKCS#12 moderno (como los emiten Windows/OpenSSL actuales):
 * certificado en claro y clave privada cifrada con PBES2 / PBKDF2-HMAC-SHA256 / AES-256-CBC.
 * Sirve para verificar la lectura de certificados reales recientes.
 */
export function buildAesTestP12(certificatePem: string, privateKeyPem: string, password: string): Buffer {
  const certificateDer = pemToDer(certificatePem);
  const privateKeyDer = pemToDer(privateKeyPem);
  const certContents = seq(certBag(certificateDer));
  const keyContents = seq(safeBag(OID_KEY_BAG, privateKeyDer));
  const authenticatedSafe = seq(contentTypeData(certContents), encryptAes256Pbes2(keyContents, password));
  return seq(integer(3), contentTypeData(authenticatedSafe));
}
