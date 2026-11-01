/**
 * Clave de acceso del SRI (49 dígitos).
 *
 * Estructura (ficha técnica del SRI):
 *   ddmmaaaa(8) + tipoComprobante(2) + ruc(13) + ambiente(1) + estab(3) + ptoEmi(3) +
 *   secuencial(9) + codigoNumerico(8) + tipoEmision(1) + digitoVerificador(1)
 *
 * El dígito verificador se calcula con módulo 11 (pesos 2..7 de derecha a izquierda).
 */

export interface ClaveAccesoInput {
  /** Fecha de emisión en formato dd/mm/aaaa o Date. */
  fechaEmision: string | Date;
  codDoc: string;
  ruc: string;
  ambiente: '1' | '2';
  estab: string;
  ptoEmi: string;
  secuencial: number | string;
  /** 8 dígitos. Si se omite se genera determinísticamente a partir de la fecha/secuencial. */
  codigoNumerico?: string;
  tipoEmision?: '1' | '2' | '3' | '4';
}

export function formatFechaClave(fecha: string | Date): string {
  if (typeof fecha === 'string') {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(fecha.trim());
    if (m) return `${m[1]}${m[2]}${m[3]}`;
    const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(fecha.trim());
    if (iso) return `${iso[3]}${iso[2]}${iso[1]}`;
  }
  const d = fecha instanceof Date ? fecha : new Date(fecha);
  if (Number.isNaN(d.getTime())) throw new Error(`Fecha inválida para clave de acceso: ${fecha}`);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = String(d.getFullYear());
  return `${dd}${mm}${yyyy}`;
}

export function pad(value: number | string, length: number): string {
  const s = String(value);
  if (s.length > length) return s.slice(-length);
  return s.padStart(length, '0');
}

/** Dígito verificador módulo 11 del SRI. */
export function modulo11(cadena: string): number {
  const pesos = [2, 3, 4, 5, 6, 7];
  let suma = 0;
  let pesoIdx = 0;
  for (let i = cadena.length - 1; i >= 0; i--) {
    const digito = Number(cadena[i]);
    if (Number.isNaN(digito)) throw new Error(`Carácter no numérico en clave de acceso: ${cadena[i]}`);
    suma += digito * pesos[pesoIdx % pesos.length];
    pesoIdx++;
  }
  const residuo = suma % 11;
  const verificador = residuo === 0 ? 0 : 11 - residuo;
  return verificador === 10 ? 1 : verificador === 11 ? 0 : verificador;
}

/** Genera un código numérico de 8 dígitos estable a partir de la fecha y el secuencial. */
export function defaultCodigoNumerico(fecha: string | Date, secuencial: number | string): string {
  const base = `${formatFechaClave(fecha)}${pad(secuencial, 9)}`;
  let hash = 0;
  for (let i = 0; i < base.length; i++) {
    hash = (hash * 31 + base.charCodeAt(i)) % 100_000_000;
  }
  return pad(hash, 8);
}

export function buildClaveAcceso(input: ClaveAccesoInput): string {
  const fecha = formatFechaClave(input.fechaEmision);
  const codDoc = pad(input.codDoc, 2);
  const ruc = pad(input.ruc, 13);
  const ambiente = input.ambiente;
  const estab = pad(input.estab, 3);
  const ptoEmi = pad(input.ptoEmi, 3);
  const secuencial = pad(input.secuencial, 9);
  const codigoNumerico = input.codigoNumerico ?? defaultCodigoNumerico(input.fechaEmision, input.secuencial);
  const tipoEmision = input.tipoEmision ?? '1';

  const sinVerificador = `${fecha}${codDoc}${ruc}${ambiente}${estab}${ptoEmi}${secuencial}${codigoNumerico}${tipoEmision}`;
  if (sinVerificador.length !== 48) {
    throw new Error(`Clave de acceso inválida: ${sinVerificador.length} dígitos (esperado 48 sin verificador)`);
  }
  const verificador = modulo11(sinVerificador);
  return `${sinVerificador}${verificador}`;
}

export interface ParsedClaveAcceso {
  fechaEmision: string;
  codDoc: string;
  ruc: string;
  ambiente: string;
  estab: string;
  ptoEmi: string;
  secuencial: string;
  codigoNumerico: string;
  tipoEmision: string;
  digitoVerificador: string;
  valida: boolean;
}

export function parseClaveAcceso(clave: string): ParsedClaveAcceso {
  const c = clave.trim();
  if (!/^\d{49}$/.test(c)) throw new Error('La clave de acceso debe tener 49 dígitos numéricos');
  const parsed: ParsedClaveAcceso = {
    fechaEmision: `${c.slice(0, 2)}/${c.slice(2, 4)}/${c.slice(4, 8)}`,
    codDoc: c.slice(8, 10),
    ruc: c.slice(10, 23),
    ambiente: c.slice(23, 24),
    estab: c.slice(24, 27),
    ptoEmi: c.slice(27, 30),
    secuencial: c.slice(30, 39),
    codigoNumerico: c.slice(39, 47),
    tipoEmision: c.slice(47, 48),
    digitoVerificador: c.slice(48, 49),
    valida: modulo11(c.slice(0, 48)) === Number(c[48]),
  };
  return parsed;
}

/** Valida cédula (10 dígitos) y RUC (13 dígitos) ecuatorianos. */
export function validateIdentificacion(tipo: string, numero: string): boolean {
  const n = (numero ?? '').replace(/[^0-9A-Za-z]/g, '');
  if (tipo === '04') {
    if (!/^\d{13}$/.test(n)) return false;
    const provincia = Number(n.slice(0, 2));
    if (provincia < 1 || provincia > 24) return false;
    const tercer = Number(n[2]);
    if (tercer >= 0 && tercer <= 5) {
      // RUC de persona natural: valida la cédula de los primeros 10 dígitos
      return validateCedula(n.slice(0, 10)) && n.slice(10) !== '000';
    }
    if (tercer === 6 || tercer === 9) {
      // RUC de sociedad privada (6) o pública (9): módulo 11 sobre 8 dígitos
      const coef = [4, 3, 2, 7, 6, 5, 4, 3, 2];
      let suma = 0;
      for (let i = 0; i < 9; i++) suma += Number(n[i]) * coef[i];
      const residuo = suma % 11;
      const verificador = residuo === 0 ? 0 : 11 - residuo;
      return verificador === Number(n[9]) && n.slice(10) !== '000';
    }
    if (tercer === 8) return /^\d{13}$/.test(n) && n.slice(10) !== '000';
    return false;
  }
  if (tipo === '05') return validateCedula(n);
  if (tipo === '06') return /^[A-Za-z0-9]{1,20}$/.test(n);
  if (tipo === '07') return n === '9999999999999';
  if (tipo === '08' || tipo === '09') return n.length >= 1 && n.length <= 20;
  return n.length > 0;
}

export function validateCedula(cedula: string): boolean {
  if (!/^\d{10}$/.test(cedula)) return false;
  const provincia = Number(cedula.slice(0, 2));
  if (provincia < 1 || provincia > 24) return false;
  const coef = [2, 1, 2, 1, 2, 1, 2, 1, 2];
  let suma = 0;
  for (let i = 0; i < 9; i++) {
    let v = Number(cedula[i]) * coef[i];
    if (v > 9) v -= 9;
    suma += v;
  }
  const residuo = suma % 10;
  const verificador = residuo === 0 ? 0 : 10 - residuo;
  return verificador === Number(cedula[9]);
}
