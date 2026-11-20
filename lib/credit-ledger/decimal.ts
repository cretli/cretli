/**
 * Exact decimal arithmetic on strings + BigInt. Amounts never touch binary floats.
 * A decimal is `{ units: bigint, scale: number }` meaning units / 10^scale.
 */

export interface Decimal {
  units: bigint;
  scale: number;
}

const DECIMAL_RE = /^([+-]?)(\d{1,30})(?:\.(\d{1,12}))?$/;

/**
 * @param input - decimal string such as "12.50" (numbers are rejected)
 */
export function parseDecimal(input: unknown): Decimal | null {
  if (typeof input !== 'string') return null;
  const m = DECIMAL_RE.exec(input.trim());
  if (!m) return null;
  const frac = m[3] || '';
  const units = BigInt(`${m[2]}${frac}`) * (m[1] === '-' ? -1n : 1n);
  return { units, scale: frac.length };
}

export function formatDecimal(dec: Decimal): string {
  const neg = dec.units < 0n;
  const digits = (neg ? -dec.units : dec.units).toString().padStart(dec.scale + 1, '0');
  const cut = digits.length - dec.scale;
  const body = dec.scale ? `${digits.slice(0, cut)}.${digits.slice(cut)}` : digits;
  return neg ? `-${body}` : body;
}

export function addDecimal(a: Decimal, b: Decimal): Decimal {
  const scale = Math.max(a.scale, b.scale);
  const up = (d: Decimal) => d.units * 10n ** BigInt(scale - d.scale);
  return { units: up(a) + up(b), scale };
}

export function negateDecimal(a: Decimal): Decimal {
  return { units: -a.units, scale: a.scale };
}
