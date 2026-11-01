/**
 * Utilidades monetarias.
 *
 * Regla del proyecto: el dinero se persiste y calcula en **centavos enteros** para evitar
 * errores de coma flotante. La API expone decimales (USD) y convierte en el borde.
 * El redondeo es half-up a 2 decimales, igual que la práctica contable del SRI.
 */

export type Cents = number;

export function toCents(value: number | string | null | undefined): Cents {
  if (value === null || value === undefined || value === '') return 0;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/,/g, ''));
  if (!Number.isFinite(n)) throw new Error(`Monto inválido: ${value}`);
  return Math.round(n * 100);
}

export function toDecimal(cents: Cents): number {
  return Math.round(cents) / 100;
}

/** Multiplica un monto en centavos por una cantidad decimal (half-up). */
export function multiplyCents(cents: Cents, qty: number): Cents {
  return Math.round(cents * qty);
}

/** Aplica un porcentaje (0..1) a una base en centavos, redondeando half-up. */
export function percentOfCents(cents: Cents, rate: number): Cents {
  return Math.round(cents * rate);
}

export function formatMoney(cents: Cents): string {
  return (Math.round(cents) / 100).toFixed(2);
}

/** Redondea un número decimal a 2 posiciones half-up (para precios unitarios). */
export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
