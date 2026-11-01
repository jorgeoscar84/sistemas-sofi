/**
 * Lectura de PKCS#12 (.p12/.pfx) sin dependencias.
 *
 * Soporta las variantes usadas por los certificados ecuatorianos:
 * - AuthSafe con ContentInfo `data` y `encryptedData`.
 * - SafeBag: keyBag, pkcs8ShroudedKeyBag, certBag (x509Certificate).
 * - PBE PKCS#12 con SHA-1 y 3DES (1.2.840.113549.1.12.1.3 / .4).
 * - PBES2/PBKDF2 con AES-CBC y 3DES (1.2.840.113549.1.5.13).
 *
 * RC2 (1.2.840.113549.1.12.1.5/.6) no está disponible en el runtime de Node; en ese
 * caso se devuelve un error explicativo indicando exportar a PEM.
 */

import crypto from 'node:crypto';
import { rc2CbcDecrypt } from './rc2.ts';
import { asInteger, asOctetString, asOid, asSequence, children, explicitChild, parseDer, toDer, type Asn1Node } from './asn1.ts';

const OID_DATA = '1.2.840.113549.1.7.1';
const OID_ENCRYPTED_DATA = '1.2.840.113549.1.7.6';
const OID_KEY_BAG = '1.2.840.113549.1.12.10.1.1';
const OID_SHROUDED_KEY_BAG = '1.2.840.113549.1.12.10.1.2';
const OID_CERT_BAG = '1.2.840.113549.1.12.10.1.3';
const OID_X509_CERT = '1.2.840.113549.1.9.22.1';
const OID_PBE_3DES = '1.2.840.113549.1.12.1.3';
const OID_PBE_2KEY_3DES = '1.2.840.113549.1.12.1.4';
const OID_PBE_RC2_128 = '1.2.840.113549.1.12.1.5';
const OID_PBE_RC2_40 = '1.2.840.113549.1.12.1.6';
const OID_PBES2 = '1.2.840.113549.1.5.13';
const OID_PBKDF2 = '1.2.840.113549.1.5.12';
const OID_HMAC_SHA1 = '1.2.840.113549.2.7';
const OID_HMAC_SHA256 = '1.2.840.113549.2.9';
const OID_HMAC_SHA512 = '1.2.840.113549.2.10';
const OID_DES_EDE3 = '1.2.840.113549.3.7';
const OID_AES_128 = '2.16.840.1.101.3.4.1.2';
const OID_AES_192 = '2.16.840.1.101.3.4.1.22';
const OID_AES_256 = '2.16.840.1.101.3.4.1.42';

export interface P12Contents {
  certificatePem: string;
  privateKeyPem: string;
  certificateCount: number;
  keyCount: number;
  subject?: string;
  issuer?: string;
  validFrom?: string;
  validTo?: string;
  serialNumber?: string;
}

/* ------------------------------------------------------- KDF PKCS#12 (RFC 7292) */

export function derivePkcs12Key(
  password: string,
  salt: Buffer,
  iterations: number,
  id: 1 | 2,
  size: number,
): Buffer {
  const u = 20; // SHA-1
  const v = 64;
  const passwordBytes = Buffer.from(`${password}\u0000`, 'utf16le').swap16();
  const D = Buffer.alloc(v, id);
  const expand = (data: Buffer) => {
    if (data.length === 0) return Buffer.alloc(0);
    const repeat = Math.ceil(v / data.length) * data.length;
    const out = Buffer.alloc(repeat);
    for (let i = 0; i < repeat; i += data.length) data.copy(out, i);
    return out;
  };
  const S = expand(salt);
  const P = expand(passwordBytes);
  let I = Buffer.concat([S, P]);
  const result: Buffer[] = [];
  let produced = 0;
  while (produced < size) {
    let A = crypto.createHash('sha1').update(Buffer.concat([D, I])).digest();
    for (let round = 1; round < iterations; round++) {
      A = crypto.createHash('sha1').update(A).digest();
    }
    result.push(A);
    produced += A.length;
    if (produced >= size) break;
    const B = Buffer.alloc(v);
    for (let i = 0; i < v; i++) B[i] = A[i % A.length]!;
    const next = Buffer.alloc(I.length);
    for (let block = 0; block < I.length / v; block++) {
      const offset = block * v;
      const addition = Buffer.from(B);
      // I_j = (I_j + B + 1) mod 2^(v*8)
      let carry = 1;
      for (let i = v - 1; i >= 0; i--) {
        const sum = I[offset + i]! + addition[i]! + carry;
        next[offset + i] = sum & 0xff;
        carry = sum >> 8;
      }
    }
    I = next;
  }
  return Buffer.concat(result).subarray(0, size);
}

/* ---------------------------------------------------------------- descifrado */

interface AlgorithmIdentifier {
  oid: string;
  params?: Asn1Node;
}

function readAlgorithm(node: Asn1Node): AlgorithmIdentifier {
  const parts = asSequence(node);
  const algorithm: AlgorithmIdentifier = { oid: asOid(parts[0]!) };
  if (parts[1]) algorithm.params = parts[1];
  return algorithm;
}

function decryptData(algorithm: AlgorithmIdentifier, data: Buffer, password: string): Buffer {
  const { oid, params } = algorithm;

  if (oid === OID_PBE_3DES || oid === OID_PBE_2KEY_3DES) {
    if (!params) throw new Error('PBE PKCS#12 sin parámetros');
    const [saltNode, iterNode] = asSequence(params);
    const salt = asOctetString(saltNode!);
    const iterations = Number(asInteger(iterNode!));
    const keyLength = oid === OID_PBE_3DES ? 24 : 16;
    const key = derivePkcs12Key(password, salt, iterations, 1, keyLength);
    const iv = derivePkcs12Key(password, salt, iterations, 2, 8);
    const cipherKey = oid === OID_PBE_3DES ? key : Buffer.concat([key, key.subarray(0, 8)]);
    const decipher = crypto.createDecipheriv('des-ede3-cbc', cipherKey, iv);
    return Buffer.concat([decipher.update(data), decipher.final()]);
  }

  if (oid === OID_PBE_RC2_128 || oid === OID_PBE_RC2_40) {
    if (!params) throw new Error('PBE RC2 sin parámetros');
    const [saltNode, iterNode] = asSequence(params);
    const salt = asOctetString(saltNode!);
    const iterations = Number(asInteger(iterNode!));
    const keyLength = oid === OID_PBE_RC2_128 ? 16 : 5;
    const effectiveBits = oid === OID_PBE_RC2_128 ? 128 : 40;
    const key = derivePkcs12Key(password, salt, iterations, 1, keyLength);
    const iv = derivePkcs12Key(password, salt, iterations, 2, 8);
    return rc2CbcDecrypt(data, key, iv, effectiveBits);
  }

  if (oid === OID_PBES2) {
    if (!params) throw new Error('PBES2 sin parámetros');
    const [kdfNode, schemeNode] = asSequence(params);
    const kdf = readAlgorithm(kdfNode!);
    if (kdf.oid !== OID_PBKDF2) throw new Error(`KDF no soportado: ${kdf.oid}`);
    const kdfParts = asSequence(kdf.params!);
    const saltNode = kdfParts[0]!;
    let salt: Buffer;
    if (saltNode.tag === 0x04) salt = asOctetString(saltNode);
    else {
      // AlgorithmIdentifier con prf específico: se toma el OCTET STRING interno
      const inner = children(saltNode).find((child) => child.tag === 0x04);
      if (!inner) throw new Error('Sal PBKDF2 no reconocida');
      salt = asOctetString(inner);
    }
    const iterations = Number(asInteger(kdfParts[1]!));
    const prfOid = kdfParts[3] ? readAlgorithm(kdfParts[3]).oid : OID_HMAC_SHA1;
    const digest = prfOid === OID_HMAC_SHA256 ? 'sha256' : prfOid === OID_HMAC_SHA512 ? 'sha512' : 'sha1';
    const scheme = readAlgorithm(schemeNode!);
    // PKCS#5 v2 define los parámetros de AES-CBC como OCTET STRING (IV) directo;
    // algunos emisores los envuelven en SEQUENCE, por eso se aceptan ambas formas.
    let iv: Buffer;
    if (scheme.params?.tag === 0x04) {
      iv = asOctetString(scheme.params);
    } else {
      const schemeParams = asSequence(scheme.params!);
      iv = asOctetString(schemeParams[0]!);
    }
    const cipherMap: Record<string, { cipher: string; keyLength: number }> = {
      [OID_DES_EDE3]: { cipher: 'des-ede3-cbc', keyLength: 24 },
      [OID_AES_128]: { cipher: 'aes-128-cbc', keyLength: 16 },
      [OID_AES_192]: { cipher: 'aes-192-cbc', keyLength: 24 },
      [OID_AES_256]: { cipher: 'aes-256-cbc', keyLength: 32 },
    };
    const entry = cipherMap[scheme.oid];
    if (!entry) throw new Error(`Cifrado PBES2 no soportado: ${scheme.oid}`);
    const key = crypto.pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iterations, entry.keyLength, digest);
    const decipher = crypto.createDecipheriv(entry.cipher, key, iv);
    return Buffer.concat([decipher.update(data), decipher.final()]);
  }

  throw new Error(`Algoritmo de cifrado PKCS#12 no soportado: ${oid}`);
}

/* -------------------------------------------------------------- estructuras */

interface SafeBag {
  bagId: string;
  value: Asn1Node;
  friendlyName?: string;
}

function parseSafeContents(der: Buffer): SafeBag[] {
  const root = parseDer(der);
  const bags: SafeBag[] = [];
  for (const bagNode of asSequence(root)) {
    const parts = asSequence(bagNode);
    if (parts.length < 2) continue;
    const bagId = asOid(parts[0]!);
    const value = explicitChild(parts[1]!);
    let friendlyName: string | undefined;
    const attributes = parts[2];
    if (attributes) {
      for (const attribute of attributes.children) {
        const attrParts = asSequence(attribute);
        if (attrParts.length < 2) continue;
        const attrOid = asOid(attrParts[0]!);
        if (attrOid === '1.2.840.113549.1.9.20') {
          const values = attrParts[1]!.children;
          if (values[0]) friendlyName = values[0].content.toString('utf16le').replace(/\u0000/g, '');
        }
      }
    }
    bags.push({ bagId, value, friendlyName });
  }
  return bags;
}

function collectBags(authenticatedSafeDer: Buffer, password: string): SafeBag[] {
  const root = parseDer(authenticatedSafeDer);
  const bags: SafeBag[] = [];
  for (const contentInfoNode of asSequence(root)) {
    const parts = asSequence(contentInfoNode);
    const contentType = asOid(parts[0]!);
    const explicit = explicitChild(parts[1]!);
    if (contentType === OID_DATA) {
      bags.push(...parseSafeContents(asOctetString(explicit)));
      continue;
    }
    if (contentType === OID_ENCRYPTED_DATA) {
      const encryptedData = explicit;
      const edParts = asSequence(encryptedData);
      // version, encryptedContentInfo
      const eci = asSequence(edParts[1]!);
      const algorithm = readAlgorithm(eci[1]!);
      const encryptedContent = eci[2]!;
      const cipherText = encryptedContent.content;
      const plain = decryptData(algorithm, cipherText, password);
      bags.push(...parseSafeContents(plain));
      continue;
    }
    // Otros tipos (p. ej. MACData) se ignoran.
  }
  return bags;
}

function toPem(label: string, der: Buffer): string {
  const base64 = der.toString('base64').replace(/(.{64})/g, '$1\n').trimEnd();
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----\n`;
}

function pkcs8ToPem(pkcs8Der: Buffer): string {
  const root = parseDer(pkcs8Der);
  asSequence(root); // valida estructura PKCS#8
  return toPem('PRIVATE KEY', pkcs8Der);
}

/** Comprueba que la clave privada corresponda al certificado. */
function matches(certificateDer: Buffer, pkcs8Der: Buffer): boolean {
  try {
    const cert = new crypto.X509Certificate(certificateDer);
    const key = crypto.createPrivateKey({ key: pkcs8Der, format: 'der', type: 'pkcs8' });
    const signature = crypto.sign('sha256', Buffer.from('prueba'), key);
    return crypto.verify('sha256', Buffer.from('prueba'), cert.publicKey, signature);
  } catch {
    return false;
  }
}

/** Lee un PKCS#12 y devuelve material de firma en PEM. */
export function parseP12(p12: Buffer, password: string): P12Contents {
  const root = parseDer(p12);
  const parts = asSequence(root);
  const authSafe = parts[1]!;
  const authParts = asSequence(authSafe);
  const contentType = asOid(authParts[0]!);
  if (contentType !== OID_DATA) throw new Error(`ContentInfo PKCS#12 no soportado: ${contentType}`);
  const authenticatedSafe = asOctetString(explicitChild(authParts[1]!));
  const bags = collectBags(authenticatedSafe, password);

  const certificates: Buffer[] = [];
  const keys: Buffer[] = [];
  for (const bag of bags) {
    if (bag.bagId === OID_CERT_BAG) {
      const certParts = asSequence(bag.value);
      const certType = asOid(certParts[0]!);
      if (certType !== OID_X509_CERT) continue;
      const certDer = asOctetString(explicitChild(certParts[1]!));
      certificates.push(certDer);
    } else if (bag.bagId === OID_KEY_BAG) {
      keys.push(toDer(bag.value));
    } else if (bag.bagId === OID_SHROUDED_KEY_BAG) {
      const encryptedKeyInfo = asSequence(bag.value);
      const algorithm = readAlgorithm(encryptedKeyInfo[0]!);
      const encrypted = asOctetString(encryptedKeyInfo[1]!);
      keys.push(decryptData(algorithm, encrypted, password));
    }
  }

  if (certificates.length === 0) throw new Error('El PKCS#12 no contiene certificados');
  if (keys.length === 0) throw new Error('El PKCS#12 no contiene clave privada (verifique la contraseña)');

  let certificateDer = certificates[0]!;
  let keyDer = keys[0]!;
  for (const cert of certificates) {
    for (const key of keys) {
      if (matches(cert, key)) {
        certificateDer = cert;
        keyDer = key;
        break;
      }
    }
  }
  const cert = new crypto.X509Certificate(certificateDer);
  return {
    certificatePem: toPem('CERTIFICATE', certificateDer),
    privateKeyPem: pkcs8ToPem(keyDer),
    certificateCount: certificates.length,
    keyCount: keys.length,
    subject: cert.subject,
    issuer: cert.issuer,
    validFrom: cert.validFrom,
    validTo: cert.validTo,
    serialNumber: cert.serialNumber,
  };
}

/** Valida y normaliza material PEM (certificado + clave) y devuelve metadatos. */
export function inspectSigningMaterial(certificatePem: string, privateKeyPem: string) {
  const cert = new crypto.X509Certificate(certificatePem);
  const key = crypto.createPrivateKey(privateKeyPem);
  const signature = crypto.sign('sha256', Buffer.from('prueba'), key);
  const ok = crypto.verify('sha256', Buffer.from('prueba'), cert.publicKey, signature);
  if (!ok) throw new Error('La clave privada no corresponde al certificado');
  return {
    subject: cert.subject,
    issuer: cert.issuer,
    validFrom: cert.validFrom,
    validTo: cert.validTo,
    serialNumber: cert.serialNumber,
    expired: new Date(cert.validTo).getTime() < Date.now(),
  };
}




