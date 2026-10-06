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

/**
 * Durable reason for an `interrupted` job. Legacy rows have an empty code and
 * must not be treated as a server-restart continuation.
 */
export const DELEGATION_INTERRUPT_CODES = Object.freeze([
  'server_restart',
  'starting_timeout',
  'running_orphan',
]);

export const DELEGATION_INTERRUPT_SERVER_RESTART = 'server_restart';
export const DELEGATION_INTERRUPT_STARTING_TIMEOUT = 'starting_timeout';
export const DELEGATION_INTERRUPT_RUNNING_ORPHAN = 'running_orphan';

export const DELEGATION_SLOT_REASONS = Object.freeze({
  JOB_IN_PROGRESS: 'job_in_progress',
  RUN_STOPPING: 'run_stopping',
  STALE_RUNNING: 'stale_running',
  UNKNOWN: 'unknown',
});

const TERMINAL = new Set(['cancelled', 'completed', 'failed', 'interrupted']);
const ACTIVE = new Set(['queued', 'starting', 'running', 'waiting_for_input', 'cancelling']);
/** Child work still executing — excludes human-input waits. */
const IN_FLIGHT = new Set(['queued', 'starting', 'running', 'cancelling']);

export const DELEGATION_STARTING_TIMEOUT_MS = 120000;
export const DELEGATION_CANCELLING_TIMEOUT_MS = 120000;
export const MAILBOX_DISPATCHING_TIMEOUT_MS = 60000;
export const DELEGATION_OUTBOX_BACKOFF_MS = 1000;
export const DELEGATION_OUTBOX_BACKOFF_MAX_MS = 60000;
export const DELEGATION_RUNTIME_TICK_MS = 5000;
export const DELEGATION_RUNNING_ORPHAN_GRACE_MS = 60000;
/** Terminal jobs with `runStoppingAt` older than this no longer hold the parent slot. */
export const DELEGATION_RUN_STOPPING_STALE_MS = DELEGATION_CANCELLING_TIMEOUT_MS;
export const DELEGATION_TICK_HUNG_MS = DELEGATION_RUNTIME_TICK_MS * 3;

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
 * @param {unknown} status
 * @returns {boolean}
 */
export function isInFlightDelegationStatus(status) {
  return IN_FLIGHT.has(normalizeDelegationStatus(status));
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
 * Declared interrupt reason. Missing or unknown values stay empty for
 * backward compatibility with pre-`interruptCode` rows.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeDelegationInterruptCode(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (DELEGATION_INTERRUPT_CODES.includes(raw)) return raw;
  return '';
}

/**
 * Only a genuine server-restart interrupt may be continued, and only once.
 *
 * @param {object | null | undefined} row
 * @returns {boolean}
 */
export function isServerRestartInterrupt(row) {
  if (String(row?.status || '') !== 'interrupted') return false;
  return normalizeDelegationInterruptCode(row?.interruptCode) === DELEGATION_INTERRUPT_SERVER_RESTART;
}

/**
 * @param {object | null | undefined} row
 * @param {number} [nowMs]
 * @returns {boolean}
 */
export function isStaleTerminalRunStopping(row, nowMs = Date.now()) {
  if (!row || !isTerminalDelegationStatus(row.status)) return false;
  const at = String(row.runStoppingAt || '').trim();
  if (!at) return false;
  const age = nowMs - Date.parse(at);
  return Number.isFinite(age) && age >= DELEGATION_RUN_STOPPING_STALE_MS;
}

/**
 * Parent start/retry slot. Terminal jobs still occupy it while a stop is
 * unconfirmed (`runStoppingAt`), unless that marker is stale.
 *
 * @param {object | null | undefined} row
 * @param {number} [nowMs]
 * @returns {boolean}
 */
export function isDelegationSlotOccupied(row, nowMs = Date.now()) {
  if (!row) return false;
  const stopping = String(row.runStoppingAt || '').trim();
  if (stopping) {
    if (isStaleTerminalRunStopping(row, nowMs)) return false;
    return true;
  }
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
