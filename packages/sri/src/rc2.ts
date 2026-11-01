/**
 * Cifrador RC2 (RFC 2268) sin dependencias.
 *
 * Se usa para descifrar certificados y claves dentro de archivos PKCS#12
 * antiguos, que suelen venir cifrados con `pbeWithSHAAnd40BitRC2-CBC`
 * (OpenSSL clásico). Node/OpenSSL 3 ya no incluye RC2.
 *
 * Implementación literal del RFC 2268 §2–§4; verificada con los vectores de
 * prueba de la §5 en las pruebas del proyecto.
 */

const PI_TABLE = new Uint8Array([
  0xd9, 0x78, 0xf9, 0xc4, 0x19, 0xdd, 0xb5, 0xed, 0x28, 0xe9, 0xfd, 0x79, 0x4a, 0xa0, 0xd8, 0x9d,
  0xc6, 0x7e, 0x37, 0x83, 0x2b, 0x76, 0x53, 0x8e, 0x62, 0x4c, 0x64, 0x88, 0x44, 0x8b, 0xfb, 0xa2,
  0x17, 0x9a, 0x59, 0xf5, 0x87, 0xb3, 0x4f, 0x13, 0x61, 0x45, 0x6d, 0x8d, 0x09, 0x81, 0x7d, 0x32,
  0xbd, 0x8f, 0x40, 0xeb, 0x86, 0xb7, 0x7b, 0x0b, 0xf0, 0x95, 0x21, 0x22, 0x5c, 0x6b, 0x4e, 0x82,
  0x54, 0xd6, 0x65, 0x93, 0xce, 0x60, 0xb2, 0x1c, 0x73, 0x56, 0xc0, 0x14, 0xa7, 0x8c, 0xf1, 0xdc,
  0x12, 0x75, 0xca, 0x1f, 0x3b, 0xbe, 0xe4, 0xd1, 0x42, 0x3d, 0xd4, 0x30, 0xa3, 0x3c, 0xb6, 0x26,
  0x6f, 0xbf, 0x0e, 0xda, 0x46, 0x69, 0x07, 0x57, 0x27, 0xf2, 0x1d, 0x9b, 0xbc, 0x94, 0x43, 0x03,
  0xf8, 0x11, 0xc7, 0xf6, 0x90, 0xef, 0x3e, 0xe7, 0x06, 0xc3, 0xd5, 0x2f, 0xc8, 0x66, 0x1e, 0xd7,
  0x08, 0xe8, 0xea, 0xde, 0x80, 0x52, 0xee, 0xf7, 0x84, 0xaa, 0x72, 0xac, 0x35, 0x4d, 0x6a, 0x2a,
  0x96, 0x1a, 0xd2, 0x71, 0x5a, 0x15, 0x49, 0x74, 0x4b, 0x9f, 0xd0, 0x5e, 0x04, 0x18, 0xa4, 0xec,
  0xc2, 0xe0, 0x41, 0x6e, 0x0f, 0x51, 0xcb, 0xcc, 0x24, 0x91, 0xaf, 0x50, 0xa1, 0xf4, 0x70, 0x39,
  0x99, 0x7c, 0x3a, 0x85, 0x23, 0xb8, 0xb4, 0x7a, 0xfc, 0x02, 0x36, 0x5b, 0x25, 0x55, 0x97, 0x31,
  0x2d, 0x5d, 0xfa, 0x98, 0xe3, 0x8a, 0x92, 0xae, 0x05, 0xdf, 0x29, 0x10, 0x67, 0x6c, 0xba, 0xc9,
  0xd3, 0x00, 0xe6, 0xcf, 0xe1, 0x9e, 0xa8, 0x2c, 0x63, 0x16, 0x01, 0x3f, 0x58, 0xe2, 0x89, 0xa9,
  0x0d, 0x38, 0x34, 0x1b, 0xab, 0x33, 0xff, 0xb0, 0xbb, 0x48, 0x0c, 0x5f, 0xb9, 0xb1, 0xcd, 0x2e,
  0xc5, 0xf3, 0xdb, 0x47, 0xe5, 0xa5, 0x9c, 0x77, 0x0a, 0xa6, 0x20, 0x68, 0xfe, 0x7f, 0xc1, 0xad,
]);

const ROTATE = [1, 2, 3, 5];

function rol16(value: number, bits: number): number {
  return ((value << bits) | (value >>> (16 - bits))) & 0xffff;
}

function ror16(value: number, bits: number): number {
  return ((value >>> bits) | (value << (16 - bits))) & 0xffff;
}

/** Expansión de clave del RFC 2268 §2. `effectiveBits` = T1 (1..1024). */
export function expandRc2Key(key: Uint8Array, effectiveBits: number): Uint16Array {
  const T = key.length;
  if (T < 1 || T > 128) throw new Error('RC2: longitud de clave inválida');
  const T1 = Math.max(1, Math.min(1024, effectiveBits));
  const T8 = Math.ceil(T1 / 8);
  const TM = 255 % 2 ** (8 + T1 - 8 * T8);
  const L = new Uint8Array(128);
  L.set(key.subarray(0, T));
  for (let i = T; i < 128; i++) {
    L[i] = PI_TABLE[(L[i - 1]! + L[i - T]!) & 0xff]!;
  }
  L[128 - T8] = PI_TABLE[L[128 - T8]! & TM]!;
  for (let i = 127 - T8; i >= 0; i--) {
    L[i] = PI_TABLE[L[i + 1]! ^ L[i + T8]!]!;
  }
  const words = new Uint16Array(64);
  for (let i = 0; i < 64; i++) {
    // K[i] = L[2i] + 256 * L[2i+1]  (byte bajo primero)
    words[i] = L[2 * i]! | (L[2 * i + 1]! << 8);
  }
  return words;
}

interface Rc2State {
  words: Uint16Array;
  j: number;
  r: [number, number, number, number];
}

function mix(state: Rc2State, index: number): void {
  const r = state.r;
  const previous1 = r[(index + 3) % 4]!;
  const previous2 = r[(index + 2) % 4]!;
  const previous3 = r[(index + 1) % 4]!;
  let value = (r[index]! + state.words[state.j]! + (previous1 & previous2) + (~previous1 & previous3)) & 0xffff;
  state.j += 1;
  value = rol16(value, ROTATE[index]!);
  r[index] = value;
}

function mash(state: Rc2State, index: number): void {
  const r = state.r;
  const previous = r[(index + 3) % 4]!;
  r[index] = (r[index]! + state.words[previous & 63]!) & 0xffff;
}

function mixingRound(state: Rc2State): void {
  mix(state, 0);
  mix(state, 1);
  mix(state, 2);
  mix(state, 3);
}

function mashingRound(state: Rc2State): void {
  mash(state, 0);
  mash(state, 1);
  mash(state, 2);
  mash(state, 3);
}

function rMix(state: Rc2State, index: number): void {
  const r = state.r;
  let value = ror16(r[index]!, ROTATE[index]!);
  const previous1 = r[(index + 3) % 4]!;
  const previous2 = r[(index + 2) % 4]!;
  const previous3 = r[(index + 1) % 4]!;
  value = (value - state.words[state.j]! - (previous1 & previous2) - (~previous1 & previous3)) & 0xffff;
  state.j -= 1;
  r[index] = value;
}

function rMash(state: Rc2State, index: number): void {
  const r = state.r;
  const previous = r[(index + 3) % 4]!;
  r[index] = (r[index]! - state.words[previous & 63]!) & 0xffff;
}

function rMixingRound(state: Rc2State): void {
  rMix(state, 3);
  rMix(state, 2);
  rMix(state, 1);
  rMix(state, 0);
}

function rMashingRound(state: Rc2State): void {
  rMash(state, 3);
  rMash(state, 2);
  rMash(state, 1);
  rMash(state, 0);
}

function bytesToState(block: Uint8Array, words: Uint16Array): Rc2State {
  return {
    words,
    j: 0,
    r: [
      block[0]! | (block[1]! << 8),
      block[2]! | (block[3]! << 8),
      block[4]! | (block[5]! << 8),
      block[6]! | (block[7]! << 8),
    ],
  };
}

function writeState(state: Rc2State, block: Uint8Array): void {
  for (let i = 0; i < 4; i++) {
    block[2 * i] = state.r[i]! & 0xff;
    block[2 * i + 1] = (state.r[i]! >>> 8) & 0xff;
  }
}

/** Cifra un bloque de 8 bytes en sitio (RFC 2268 §3.5). */
export function rc2EncryptBlock(block: Uint8Array, keyWords: Uint16Array): void {
  const state = bytesToState(block, keyWords);
  for (let round = 0; round < 5; round++) mixingRound(state);
  mashingRound(state);
  for (let round = 0; round < 6; round++) mixingRound(state);
  mashingRound(state);
  for (let round = 0; round < 5; round++) mixingRound(state);
  writeState(state, block);
}

/** Descifra un bloque de 8 bytes en sitio (RFC 2268 §4.5). */
export function rc2DecryptBlock(block: Uint8Array, keyWords: Uint16Array): void {
  const state = bytesToState(block, keyWords);
  state.j = 63;
  for (let round = 0; round < 5; round++) rMixingRound(state);
  rMashingRound(state);
  for (let round = 0; round < 6; round++) rMixingRound(state);
  rMashingRound(state);
  for (let round = 0; round < 5; round++) rMixingRound(state);
  writeState(state, block);
}

/** Descifra datos en modo CBC con RC2 (con relleno PKCS#7). */
export function rc2CbcDecrypt(cipherText: Uint8Array, key: Uint8Array, iv: Uint8Array, effectiveBits: number): Buffer {
  if (cipherText.length === 0) return Buffer.alloc(0);
  if (cipherText.length % 8 !== 0) throw new Error('Longitud RC2-CBC no múltiplo de 8');
  const keyWords = expandRc2Key(key, effectiveBits);
  const output = Buffer.alloc(cipherText.length);
  let previous = Uint8Array.from(iv.subarray(0, 8));
  for (let offset = 0; offset < cipherText.length; offset += 8) {
    const cipherBlock = Uint8Array.from(cipherText.subarray(offset, offset + 8));
    const block = Uint8Array.from(cipherBlock);
    rc2DecryptBlock(block, keyWords);
    for (let i = 0; i < 8; i++) output[offset + i] = block[i]! ^ previous[i]!;
    previous = cipherBlock;
  }
  const padding = output[output.length - 1]!;
  if (padding > 0 && padding <= 8) {
    let valid = true;
    for (let i = output.length - padding; i < output.length; i++) {
      if (output[i] !== padding) valid = false;
    }
    if (valid) return output.subarray(0, output.length - padding);
  }
  return output;
}

/** Cifra datos en modo CBC con RC2 (con relleno PKCS#7). */
export function rc2CbcEncrypt(plain: Uint8Array, key: Uint8Array, iv: Uint8Array, effectiveBits: number): Buffer {
  const keyWords = expandRc2Key(key, effectiveBits);
  const padding = 8 - (plain.length % 8);
  const padded = Buffer.concat([Buffer.from(plain), Buffer.alloc(padding, padding)]);
  const output = Buffer.alloc(padded.length);
  let previous = Uint8Array.from(iv.subarray(0, 8));
  for (let offset = 0; offset < padded.length; offset += 8) {
    const block = Uint8Array.from(padded.subarray(offset, offset + 8));
    for (let i = 0; i < 8; i++) block[i] = block[i]! ^ previous[i]!;
    rc2EncryptBlock(block, keyWords);
    for (let i = 0; i < 8; i++) output[offset + i] = block[i]!;
    previous = Uint8Array.from(block);
  }
  return output;
}
