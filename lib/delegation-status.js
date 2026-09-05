/**
 * Delegation status helpers.
 */

export const DELEGATION_STATUSES = Object.freeze([
  'queued',
  'starting',
  'running',
  'waiting_for_input',
  'cancelling',
  'cancelled',
  'completed',
  'failed',
  'interrupted',
]);

const TERMINAL = new Set(['cancelled', 'completed', 'failed', 'interrupted']);
const ACTIVE = new Set(['queued', 'starting', 'running', 'waiting_for_input', 'cancelling']);

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeDelegationStatus(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (DELEGATION_STATUSES.includes(raw)) return raw;
  return '';
}

/**
 * @param {unknown} status
 * @returns {boolean}
 */
export function isTerminalDelegationStatus(status) {
  return TERMINAL.has(normalizeDelegationStatus(status));
}

/**
 * @param {unknown} status
 * @returns {boolean}
 */
export function isActiveDelegationStatus(status) {
  return ACTIVE.has(normalizeDelegationStatus(status));
}

/**
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
export function canTransitionDelegationStatus(from, to) {
  const current = normalizeDelegationStatus(from);
  const next = normalizeDelegationStatus(to);
  if (!next) return false;
  if (!current) return next === 'queued';
  if (current === next) return true;
  if (TERMINAL.has(current)) return false;
  const allowed = {
    queued: ['starting', 'cancelled', 'failed', 'interrupted'],
    starting: ['running', 'waiting_for_input', 'cancelling', 'cancelled', 'failed', 'interrupted'],
    running: ['waiting_for_input', 'cancelling', 'cancelled', 'completed', 'failed', 'interrupted'],
    waiting_for_input: ['running', 'cancelling', 'cancelled', 'completed', 'failed', 'interrupted'],
    cancelling: ['cancelled', 'completed', 'failed', 'interrupted'],
  };
  return (allowed[current] || []).includes(next);
}
