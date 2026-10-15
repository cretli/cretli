/**
 * Exact decimal arithmetic on strings + BigInt. Amounts never touch binary floats.
 * A decimal is `{ units: bigint, scale: number }` meaning units / 10^scale.
 */

const DECIMAL_RE = /^([+-]?)(\d{1,30})(?:\.(\d{1,12}))?$/;

/**
 * @param {unknown} input - decimal string such as "12.50" (numbers are rejected)
 * @returns {{ units: bigint, scale: number } | null}
 */
export function parseDecimal(input) {
  if (typeof input !== 'string') return null;
  const m = DECIMAL_RE.exec(input.trim());
  if (!m) return null;
  const frac = m[3] || '';
  const units = BigInt(`${m[2]}${frac}`) * (m[1] === '-' ? -1n : 1n);
  return { units, scale: frac.length };
}

/**
 * @param {{ units: bigint, scale: number }} dec
 * @returns {string}
 */
export function formatDecimal(dec) {
  const neg = dec.units < 0n;
  const digits = (neg ? -dec.units : dec.units).toString().padStart(dec.scale + 1, '0');
  const cut = digits.length - dec.scale;
  const body = dec.scale ? `${digits.slice(0, cut)}.${digits.slice(cut)}` : digits;
  return neg ? `-${body}` : body;
}

/**
 * @param {{ units: bigint, scale: number }} a
 * @param {{ units: bigint, scale: number }} b
 * @returns {{ units: bigint, scale: number }}
 */
export function addDecimal(a, b) {
  const scale = Math.max(a.scale, b.scale);
  const up = (d) => d.units * 10n ** BigInt(scale - d.scale);
  return { units: up(a) + up(b), scale };
}

/**
 * @param {{ units: bigint, scale: number }} a
 * @returns {{ units: bigint, scale: number }}
 */
export function negateDecimal(a) {
  return { units: -a.units, scale: a.scale };
}
