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

export const DELEGATION_TASK_OUTCOMES = Object.freeze([
  'unspecified',
  'success',
  'failure',
  'blocked',
]);

export const DELEGATION_SLOT_REASONS = Object.freeze({
  JOB_IN_PROGRESS: 'job_in_progress',
  RUN_STOPPING: 'run_stopping',
  STALE_RUNNING: 'stale_running',
  UNKNOWN: 'unknown',
});

const TERMINAL = new Set(['cancelled', 'completed', 'failed', 'interrupted']);
const ACTIVE = new Set(['queued', 'starting', 'running', 'waiting_for_input', 'cancelling']);

export const DELEGATION_STARTING_TIMEOUT_MS = 120000;
export const DELEGATION_CANCELLING_TIMEOUT_MS = 120000;
export const MAILBOX_DISPATCHING_TIMEOUT_MS = 60000;
export const DELEGATION_OUTBOX_BACKOFF_MS = 1000;
export const DELEGATION_OUTBOX_BACKOFF_MAX_MS = 60000;
export const DELEGATION_RUNTIME_TICK_MS = 5000;

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
 * Declared task result. Missing or unknown values stay unspecified.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeDelegationTaskOutcome(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (DELEGATION_TASK_OUTCOMES.includes(raw)) return raw;
  return 'unspecified';
}

/**
 * Parent start/retry slot. Terminal jobs still occupy it while a stop is
 * unconfirmed (`runStoppingAt`).
 *
 * @param {object | null | undefined} row
 * @returns {boolean}
 */
export function isDelegationSlotOccupied(row) {
  if (!row) return false;
  if (String(row.runStoppingAt || '').trim()) return true;
  return isActiveDelegationStatus(row.status);
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
  if (TERMINAL.has(current) && next === 'starting') return true;
  if (TERMINAL.has(current)) return false;
  const allowed = {
    queued: ['starting', 'cancelled', 'failed', 'interrupted'],
    starting: ['running', 'waiting_for_input', 'cancelling', 'cancelled', 'completed', 'failed', 'interrupted'],
    running: ['waiting_for_input', 'cancelling', 'cancelled', 'completed', 'failed', 'interrupted'],
    waiting_for_input: ['running', 'cancelling', 'cancelled', 'completed', 'failed', 'interrupted'],
    cancelling: ['cancelled', 'completed', 'failed', 'interrupted'],
  };
  return (allowed[current] || []).includes(next);
}
