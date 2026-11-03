/**
 * Codificador/decodificador ASN.1 DER mínimo (sin dependencias).
 * Cubre lo necesario para X.509, PKCS#8 y PKCS#12.
 */

export interface Asn1Node {
  /** Primer byte de la etiqueta (las etiquetas de un byte son las que usa este perfil). */
  tag: number;
  constructed: boolean;
  /** Contenido del TLV (para construidos, la concatenación de hijos). */
  content: Buffer;
  children: Asn1Node[];
  /** true cuando el TLV usó longitud indefinida (BER, terminada en 00 00). */
  indefinite?: boolean;
}

const TAG_SEQUENCE = 0x30;
const TAG_SET = 0x31;

function readLength(buffer: Buffer, offset: number): { length: number | null; next: number } {
  const first = buffer[offset]!;
  if (first < 0x80) return { length: first, next: offset + 1 };
  const count = first & 0x7f;
  // 0x80 = longitud indefinida (BER): el contenido termina con 00 00.
  if (count === 0) return { length: null, next: offset + 1 };
  if (count > 6) throw new Error(`Longitud ASN.1 no soportada en offset ${offset} (${count} bytes de longitud)`);
  let length = 0;
  for (let i = 0; i < count; i++) length = length * 256 + buffer[offset + 1 + i]!;
  return { length, next: offset + 1 + count };
}

export function parseDer(buffer: Buffer): Asn1Node {
  const [node, next] = parseAt(buffer, 0);
  if (next !== buffer.length) {
    // Permite bytes de relleno, pero reporta el margen para diagnóstico.
    if (buffer.length - next > 8) throw new Error(`DER con ${buffer.length - next} bytes sobrantes`);
  }
  return node;
}

export function parseAll(buffer: Buffer): Asn1Node[] {
  const nodes: Asn1Node[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const [node, next] = parseAt(buffer, offset);
    nodes.push(node);
    offset = next;
  }
  return nodes;
}

function parseAt(buffer: Buffer, offset: number): [Asn1Node, number] {
  if (offset >= buffer.length) throw new Error('ASN.1 truncado');
  const tag = buffer[offset]!;
  if ((tag & 0x1f) === 0x1f) throw new Error('Etiquetas ASN.1 multibyte no soportadas');
  const constructed = (tag & 0x20) !== 0;
  const { length, next } = readLength(buffer, offset + 1);

  if (length === null) {
    if (!constructed) throw new Error('Longitud indefinida ASN.1 en un elemento primitivo');
    const contentStart = next;
    let childOffset = contentStart;
    const children: Asn1Node[] = [];
    for (;;) {
      if (childOffset + 2 > buffer.length) {
        throw new Error(`ASN.1 truncado en offset ${offset}: falta el fin de contenido 00 00`);
      }
      if (buffer[childOffset] === 0 && buffer[childOffset + 1] === 0) {
        childOffset += 2;
        break;
      }
      const [child, childNext] = parseAt(buffer, childOffset);
      children.push(child);
      childOffset = childNext;
    }
    const content = buffer.subarray(contentStart, childOffset - 2);
    return [{ tag, constructed, content, children, indefinite: true }, childOffset];
  }

  const start = next;
  const end = start + length;
  if (end > buffer.length) {
    throw new Error(
      `Contenido ASN.1 truncado en offset ${offset}: etiqueta 0x${tag.toString(16)}, longitud ${length}, disponibles ${buffer.length - start}`,
    );
  }
  const content = buffer.subarray(start, end);
  let children: Asn1Node[] = [];
  if (constructed) {
    children = [];
    let childOffset = 0;
    while (childOffset < content.length) {
      const [child, childNext] = parseAt(content, childOffset);
      children.push(child);
      childOffset = childNext;
    }
  }
  return [{ tag, constructed, content, children }, end];
}

export function oidToString(content: Buffer): string {
  if (content.length === 0) throw new Error('OID vacío');
  const values: number[] = [];
  let value = 0;
  for (let i = 0; i < content.length; i++) {
    const byte = content[i]!;
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) {
      if (values.length === 0) {
        const first = Math.min(2, Math.floor(value / 40));
        values.push(first, value - first * 40);
      } else {
        values.push(value);
      }
      value = 0;
    }
  }
  return values.join('.');
}

/* ------------------------------------------------------------------ lectura */

export function asSequence(node: Asn1Node): Asn1Node[] {
  if (node.tag !== TAG_SEQUENCE) throw new Error(`Se esperaba SEQUENCE (0x30), llegó 0x${node.tag.toString(16)}`);
  return node.children;
}

export function asInteger(node: Asn1Node): bigint {
  if (node.tag !== 0x02) throw new Error(`Se esperaba INTEGER, llegó 0x${node.tag.toString(16)}`);
  let value = 0n;
  for (const byte of node.content) value = (value << 8n) | BigInt(byte);
  return value;
}

export function asOid(node: Asn1Node): string {
  if (node.tag !== 0x06) throw new Error(`Se esperaba OID, llegó 0x${node.tag.toString(16)}`);
  return oidToString(node.content);
}

export function asOctetString(node: Asn1Node): Buffer {
  // OCTET STRING primitivo (04) o construido (24, habitual en BER): en el
  // segundo caso los segmentos se concatenan, como exige BER/X.690.
  if (!node.constructed && node.tag === 0x04) return node.content;
  if (node.constructed && (node.tag === 0x04 || node.tag === 0x24)) {
    return Buffer.concat(node.children.map((child) => asOctetString(child)));
  }
  throw new Error(`Se esperaba OCTET STRING, llegó 0x${node.tag.toString(16)}`);
}

export function asBmpString(node: Asn1Node): string {
  const text = node.content.toString('utf16le');
  return text.replace(/^\u0000|\u0000+$/g, '');
}

/** Hijos de un nodo construido (SEQUENCE/SET/contexto construido). */
export function children(node: Asn1Node): Asn1Node[] {
  return node.children;
}

/** Contexto explícito [n] (etiqueta 0xa0+n) — devuelve el único hijo. */
export function explicitChild(node: Asn1Node): Asn1Node {
  if (!node.constructed || node.children.length !== 1) throw new Error('Contexto explícito ASN.1 inválido');
  return node.children[0]!;
}

/* ----------------------------------------------------------------- escritura */

export function tlv(tag: number, content: Buffer): Buffer {
  let length: Buffer;
  if (content.length < 0x80) {
    length = Buffer.from([content.length]);
  } else {
    const bytes: number[] = [];
    let value = content.length;
    while (value > 0) {
      bytes.unshift(value & 0xff);
      value >>= 8;
    }
    length = Buffer.from([0x80 | bytes.length, ...bytes]);
  }
  return Buffer.concat([Buffer.from([tag]), length, content]);
}

export function seq(...parts: Buffer[]): Buffer {
  return tlv(TAG_SEQUENCE, Buffer.concat(parts));
}

export function setOf(...parts: Buffer[]): Buffer {
  return tlv(TAG_SET, Buffer.concat(parts));
}

export function oid(value: string): Buffer {
  const parts = value.split('.').map(Number);
  const bytes: number[] = [parts[0]! * 40 + parts[1]!];
  for (const part of parts.slice(2)) {
    if (part < 128) {
      bytes.push(part);
    } else {
      const stack: number[] = [];
      let rest = part;
      stack.unshift(rest & 0x7f);
      rest >>= 7;
      while (rest > 0) {
        stack.unshift((rest & 0x7f) | 0x80);
        rest >>= 7;
      }
      bytes.push(...stack);
    }
  }
  return tlv(0x06, Buffer.from(bytes));
}

export function integer(value: number | bigint | Buffer): Buffer {
  if (Buffer.isBuffer(value)) return tlv(0x02, value);
  let big = BigInt(value);
  if (big < 0n) throw new Error('Entero negativo no soportado');
  const bytes: number[] = [];
  do {
    bytes.unshift(Number(big & 0xffn));
    big >>= 8n;
  } while (big > 0n);
  if ((bytes[0]! & 0x80) !== 0) bytes.unshift(0);
  return tlv(0x02, Buffer.from(bytes));
}

export function octetString(value: Buffer): Buffer {
  return tlv(0x04, value);
}

export function nullValue(): Buffer {
  return tlv(0x05, Buffer.alloc(0));
}

export function bitString(value: Buffer, unusedBits = 0): Buffer {
  return tlv(0x03, Buffer.concat([Buffer.from([unusedBits]), value]));
}

export function utf8(value: string): Buffer {
  return tlv(0x0c, Buffer.from(value, 'utf8'));
}

export function contextTag(number: number, content: Buffer, constructed = true): Buffer {
  return tlv((constructed ? 0xa0 : 0x80) | number, content);
}

export function utcTime(date: Date): Buffer {
  const pad = (value: number) => String(value).padStart(2, '0');
  const text =
    `${pad(date.getUTCFullYear() % 100)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(text, 'ascii'));
}

/** Cadena BMPString para contraseñas PKCS#12 (incluye terminador NUL). */
export function bmpPassword(password: string): Buffer {
  return Buffer.from(`${password}\u0000`, 'utf16le').swap16();
}

/** Serializa de nuevo un nodo analizado a DER (normaliza longitudes BER indefinidas). */
export function toDer(node: Asn1Node): Buffer {
  if (!node.constructed) return tlv(node.tag, node.content);
  return tlv(node.tag, Buffer.concat(node.children.map((child) => toDer(child))));
}

