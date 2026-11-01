/**
 * Firma electrónica XAdES-BES para comprobantes del SRI.
 *
 * Implementación sin dependencias: usa `node:crypto` para RSA-SHA1/SHA256 y el
 * certificado en PEM (certificado público + clave privada).
 *
 * Reglas de canonicalización aplicadas (XMLDSig / C14N inclusiva):
 *  - El digest del documento se calcula sobre el XML sin la firma, sin la
 *    declaración XML y sin espacios entre etiquetas (nuestro XML se genera compacto).
 *  - `SignedInfo` y `SignedProperties` se firman/digestan sobre su forma canónica:
 *    declaraciones de namespace al inicio de la etiqueta (ordenadas por prefijo) y
 *    atributos ordenados alfabéticamente. Para que el verificador obtenga exactamente
 *    la misma cadena, esos elementos se insertan en el documento YA en forma canónica
 *    (con sus `xmlns` explícitos).
 *  - `ds:X509Certificate` contiene el certificado en DER codificado en base64.
 *
 * La firma resultante se valida con el validador XMLDSig estándar de Java
 * (`tools/ValidarFirma.java`) en las pruebas de integración.
 */

import crypto from 'node:crypto';
import { documentBody } from './xml.ts';
import { parseP12 } from './p12.ts';

const NS_DS = 'http://www.w3.org/2000/09/xmldsig#';
const NS_XADES = 'http://uri.etsi.org/01903/v1.3.2#';
const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';

export interface SigningMaterial {
  /** Certificado X.509 en PEM (incluye cadena opcional). */
  certificatePem: string;
  /** Clave privada RSA en PEM (PKCS#8 o PKCS#1, sin cifrar). */
  privateKeyPem: string;
  /** SHA-1 por defecto (compatibilidad SRI); SHA-256 disponible. */
  digestAlgorithm?: 'sha1' | 'sha256';
}

export interface SignResult {
  xml: string;
  signingTime: string;
  certificateSubject: string;
  signatureId: string;
  digestAlgorithm: 'sha1' | 'sha256';
}

function signatureAlgorithm(digest: 'sha1' | 'sha256'): string {
  return digest === 'sha256'
    ? 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256'
    : 'http://www.w3.org/2000/09/xmldsig#rsa-sha1';
}

function digestAlgorithmUri(digest: 'sha1' | 'sha256'): string {
  return digest === 'sha256' ? 'http://www.w3.org/2001/04/xmlenc#sha256' : 'http://www.w3.org/2000/09/xmldsig#sha1';
}

function hashBase64(data: string | Buffer, digest: 'sha1' | 'sha256'): string {
  return crypto.createHash(digest).update(data).digest('base64');
}

function escapeXmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Convierte el nombre del emisor de Node ("C=EC\nO=X") al formato RFC2253. */
export function issuerRfc2253(issuer: string): string {
  return issuer
    .split(/\n/)
    .filter(Boolean)
    .map((part) => part.trim())
    .join(',');
}

function decimalSerial(cert: crypto.X509Certificate): string {
  const hex = cert.serialNumber.replace(/[^0-9a-fA-F]/g, '') || '0';
  return BigInt(`0x${hex}`).toString();
}

function uniqueSuffix(): string {
  return `${Date.now().toString(36)}${crypto.randomBytes(6).toString('hex')}`;
}

function signingTimeIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

interface ReferenceSpec {
  id: string;
  type?: string;
  uri: string;
  digestAlgorithm: 'sha1' | 'sha256';
  digestValue: string;
  transforms: string[];
}

function referenceXml(reference: ReferenceSpec): string {
  // Atributos en orden canónico alfabético: Id, Type, URI.
  const attributes =
    `Id="${reference.id}"` +
    (reference.type ? ` Type="${reference.type}"` : '') +
    ` URI="${reference.uri}"`;
  return (
    `<ds:Reference ${attributes}>` +
    `<ds:Transforms>${reference.transforms
      .map((algorithm) => `<ds:Transform Algorithm="${algorithm}"></ds:Transform>`)
      .join('')}</ds:Transforms>` +
    `<ds:DigestMethod Algorithm="${digestAlgorithmUri(reference.digestAlgorithm)}"></ds:DigestMethod>` +
    `<ds:DigestValue>${reference.digestValue}</ds:DigestValue>` +
    `</ds:Reference>`
  );
}

/** Firma el XML indicado insertando `<ds:Signature>` como último hijo del nodo raíz. */
export function signXml(xml: string, material: SigningMaterial): SignResult {
  const digest: 'sha1' | 'sha256' = material.digestAlgorithm ?? 'sha1';
  const cert = new crypto.X509Certificate(material.certificatePem);
  const certDer = cert.raw;
  const certDigest = hashBase64(certDer, digest);
  const issuerName = issuerRfc2253(cert.issuer);
  const serial = decimalSerial(cert);

  const declaration = /^<\?xml[^>]*\?>/.exec(xml)?.[0] ?? '';
  // C14N serializa las etiquetas vacías como <x></x> (nunca autocerradas).
  const normalizeEmptyTags = (value: string) =>
    value.replace(/<([A-Za-z0-9:._-]+)((?:\s+[^>]*?)?)\s*\/>/g, '<$1$2></$1>');
  const body = normalizeEmptyTags(documentBody(xml));
  const rootMatch = /^<([A-Za-z0-9:]+)([^>]*)>/.exec(body);
  const rootName = rootMatch ? rootMatch[1]! : 'factura';
  const idMatch = rootMatch ? /id="([^"]+)"/.exec(rootMatch[2] ?? '') : null;
  const referenceId = idMatch ? idMatch[1]! : 'comprobante';

  const suffix = uniqueSuffix();
  const signatureId = `Signature-${suffix}`;
  const signedPropertiesId = `SignedProperties-${suffix}`;
  const documentReferenceId = `Reference-doc-${suffix}`;
  const propertiesReferenceId = `Reference-props-${suffix}`;
  const signingTime = signingTimeIso();

  // 1) Digest del documento sin firma (transformada enveloped-signature + C14N).
  const documentDigest = hashBase64(body, digest);

  // 2) SignedProperties en forma canónica (xmlns explícitos, Id después de namespaces).
  const signedPropertiesInner =
    `<xades:SignedSignatureProperties>` +
    `<xades:SigningTime>${signingTime}</xades:SigningTime>` +
    `<xades:SigningCertificate>` +
    `<xades:Cert>` +
    `<xades:CertDigest>` +
    `<ds:DigestMethod Algorithm="${digestAlgorithmUri(digest)}"></ds:DigestMethod>` +
    `<ds:DigestValue>${certDigest}</ds:DigestValue>` +
    `</xades:CertDigest>` +
    `<xades:IssuerSerial>` +
    `<ds:X509IssuerName>${escapeXmlText(issuerName)}</ds:X509IssuerName>` +
    `<ds:X509SerialNumber>${serial}</ds:X509SerialNumber>` +
    `</xades:IssuerSerial>` +
    `</xades:Cert>` +
    `</xades:SigningCertificate>` +
    `<xades:SignaturePolicyIdentifier><xades:SignaturePolicyImplied></xades:SignaturePolicyImplied></xades:SignaturePolicyIdentifier>` +
    `</xades:SignedSignatureProperties>`;
  const signedPropertiesCanonical =
    `<xades:SignedProperties xmlns:ds="${NS_DS}" xmlns:xades="${NS_XADES}" Id="${signedPropertiesId}">` +
    signedPropertiesInner +
    `</xades:SignedProperties>`;
  const signedPropertiesDigest = hashBase64(signedPropertiesCanonical, digest);

  // 3) SignedInfo en forma canónica y firma RSA.
  const references = [
    referenceXml({
      id: documentReferenceId,
      uri: `#${referenceId}`,
      digestAlgorithm: digest,
      digestValue: documentDigest,
      transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', C14N],
    }),
    referenceXml({
      id: propertiesReferenceId,
      type: 'http://uri.etsi.org/01903#SignedProperties',
      uri: `#${signedPropertiesId}`,
      digestAlgorithm: digest,
      digestValue: signedPropertiesDigest,
      transforms: [C14N],
    }),
  ].join('');
  const signedInfoCanonical =
    `<ds:SignedInfo xmlns:ds="${NS_DS}">` +
    `<ds:CanonicalizationMethod Algorithm="${C14N}"></ds:CanonicalizationMethod>` +
    `<ds:SignatureMethod Algorithm="${signatureAlgorithm(digest)}"></ds:SignatureMethod>` +
    references +
    `</ds:SignedInfo>`;

  const rsaAlgorithm = digest === 'sha256' ? 'RSA-SHA256' : 'RSA-SHA1';
  const signatureValue = crypto
    .createSign(rsaAlgorithm)
    .update(signedInfoCanonical, 'utf8')
    .sign(material.privateKeyPem)
    .toString('base64');

  const certificateBase64 = certDer.toString('base64');
  const signature =
    `<ds:Signature xmlns:ds="${NS_DS}" Id="${signatureId}">` +
    signedInfoCanonical +
    `<ds:SignatureValue>${signatureValue}</ds:SignatureValue>` +
    `<ds:KeyInfo><ds:X509Data><ds:X509Certificate>${certificateBase64}</ds:X509Certificate></ds:X509Data></ds:KeyInfo>` +
    `<ds:Object>` +
    `<xades:QualifyingProperties xmlns:xades="${NS_XADES}" Target="#${signatureId}">` +
    signedPropertiesCanonical +
    `</xades:QualifyingProperties>` +
    `</ds:Object>` +
    `</ds:Signature>`;

  const signedBody = body.replace(new RegExp(`</${rootName}>\\s*$`), `${signature}</${rootName}>`);
  if (signedBody === body) throw new Error('No se pudo insertar la firma en el XML (nodo raíz no encontrado)');
  const signedXml = `${declaration}${signedBody}`;
  return { xml: signedXml, signingTime, certificateSubject: cert.subject, signatureId, digestAlgorithm: digest };
}

export interface SignatureVerification {
  valid: boolean;
  signatureValid: boolean;
  documentDigestValid: boolean;
  signedPropertiesDigestValid: boolean;
  digestAlgorithm: 'sha1' | 'sha256';
  subject?: string;
  details: string[];
}

/**
 * Verificación local e independiente de la firma: recalcula el digest del documento,
 * el digest de SignedProperties y comprueba RSA sobre `SignedInfo`.
 */
export function verifySignedXml(signedXml: string): SignatureVerification {
  const details: string[] = [];
  const valueMatch = /<ds:SignatureValue>([^<]+)<\/ds:SignatureValue>/.exec(signedXml);
  const signedInfoMatch = /<ds:SignedInfo xmlns:ds="[^"]+">([\s\S]*?)<\/ds:SignedInfo>/.exec(signedXml);
  const certMatch = /<ds:X509Certificate>([^<]+)<\/ds:X509Certificate>/.exec(signedXml);
  const propsMatch = /<xades:SignedProperties[^>]*>[\s\S]*?<\/xades:SignedProperties>/.exec(signedXml);
  if (!valueMatch || !signedInfoMatch || !certMatch || !propsMatch) {
    return {
      valid: false,
      signatureValid: false,
      documentDigestValid: false,
      signedPropertiesDigestValid: false,
      digestAlgorithm: 'sha1',
      details: ['El XML no contiene una firma XAdES completa'],
    };
  }
  const certificate = new crypto.X509Certificate(Buffer.from(certMatch[1]!, 'base64'));
  const digest: 'sha1' | 'sha256' = /xmldsig-more#rsa-sha256/.test(signedInfoMatch[0]) ? 'sha256' : 'sha1';
  const signedInfoCanonical = `<ds:SignedInfo xmlns:ds="${NS_DS}">${signedInfoMatch[1]}</ds:SignedInfo>`;
  let signatureValid = false;
  try {
    signatureValid = crypto
      .createVerify(digest === 'sha256' ? 'RSA-SHA256' : 'RSA-SHA1')
      .update(signedInfoCanonical, 'utf8')
      .verify(certificate.publicKey, Buffer.from(valueMatch[1]!, 'base64'));
  } catch (error) {
    details.push(`Error verificando RSA: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!signatureValid) details.push('SignatureValue no corresponde a SignedInfo con el certificado');

  const withoutSignature = signedXml.replace(/<ds:Signature[\s\S]*<\/ds:Signature>/, '');
  const body = documentBody(withoutSignature);
  const documentDigest = hashBase64(body, digest);
  const digestValues = [...signedXml.matchAll(/<ds:DigestValue>([^<]+)<\/ds:DigestValue>/g)].map((match) => match[1]!);
  const documentDigestValid = digestValues.includes(documentDigest);
  if (!documentDigestValid) details.push('Digest del documento no coincide');

  const signedPropertiesCanonical = propsMatch[0];
  const propertiesDigest = hashBase64(signedPropertiesCanonical, digest);
  const signedPropertiesDigestValid = digestValues.includes(propertiesDigest);
  if (!signedPropertiesDigestValid) details.push('Digest de SignedProperties no coincide');

  return {
    valid: signatureValid && documentDigestValid && signedPropertiesDigestValid,
    signatureValid,
    documentDigestValid,
    signedPropertiesDigestValid,
    digestAlgorithm: digest,
    subject: certificate.subject,
    details,
  };
}

/**
 * Convierte un PKCS#12 (.p12/.pfx) en material de firma (PEM) usando el lector
 * nativo de `p12.ts` (PBE SHA-1/3DES y PBES2/PBKDF2).
 */
export function signingMaterialFromP12(p12: Buffer, password: string): SigningMaterial {
  const parsed = parseP12(p12, password);
  return {
    certificatePem: parsed.certificatePem,
    privateKeyPem: parsed.privateKeyPem,
  };
}


