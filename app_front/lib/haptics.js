/**
 * Small haptic feedback helper (Vibration API). Android browsers and installed PWAs
 * support it; iOS Safari does not, where every call is a silent no-op.
 *
 * Kinds are short, distinct patterns so a tap, a selection step and a result feel
 * different. Turn it off with `localStorage.setItem('cretli-haptics', '0')`.
 */

export const HAPTICS_STORAGE_KEY = 'cretli-haptics';

/** @type {Record<string, number | number[]>} */
const PATTERNS = {
  /** A light tick: a press, a toggle, a step between choices. */
  tick: 8,
  /** A confirmed selection. */
  select: 14,
  /** An action that completed. */
  success: [10, 40, 14],
  /** Something needs attention or was refused. */
  warn: [30, 50, 30],
};

/** @returns {boolean} */
export function hapticsEnabled() {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return false;
  try {
    if (localStorage.getItem(HAPTICS_STORAGE_KEY) === '0') return false;
  } catch (_) { /* storage is optional */ }
  return !(typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
}

/**
 * @param {'tick' | 'select' | 'success' | 'warn'} [kind]
 * @returns {boolean} whether a vibration was requested
 */
export function haptic(kind = 'tick') {
  if (!hapticsEnabled()) return false;
  try {
    return navigator.vibrate(PATTERNS[kind] ?? PATTERNS.tick) === true;
  } catch (_) {
    return false;
  }
}
