/**
 * Bounded long-poll for parent MCP delegation_wait (not a sequencer).
 * `waiting_for_input` keeps `slot_occupied` true — approver waits are not
 * infra failures and must not trigger fanout retry while the slot is held.
 */

import { VERIFY_PENDING_MAX_AGE_MS } from '../../delegation-implement-verify-gate.js';
import {
  isDelegationSlotOccupied,
  isTerminalDelegationStatus,
} from '../../delegation-status.js';

export const DELEGATION_WAIT_DEFAULT_MS = 20000;
export const DELEGATION_WAIT_MAX_MS = 25000;
/**
 * Kept for backward compatibility only. The wait loop no longer polls at this
 * rate; it blocks on the change signal and re-reads on `DELEGATION_WAIT_FALLBACK_MS`.
 */
export const DELEGATION_WAIT_POLL_MS = 50;
/** Safety re-check interval so a change missed between read and subscribe still wakes the wait. */
export const DELEGATION_WAIT_FALLBACK_MS = 1000;
/** Bridge HTTP client timeout in remote-api-client; wait must stay below this. */
export const CRETILI_BRIDGE_HTTP_TIMEOUT_MS = 30000;

/**
 * @param {unknown} value
 * @returns {number}
 */
export function clampDelegationWaitTimeoutMs(value) {
  if (value === undefined || value === null || value === '') {
    return DELEGATION_WAIT_DEFAULT_MS;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DELEGATION_WAIT_DEFAULT_MS;
  if (parsed <= 0) return 0;
  return Math.min(DELEGATION_WAIT_MAX_MS, Math.floor(parsed));
}

/**
 * @param {Record<string, any> | null | undefined} row
 * @returns {boolean}
 */
export function isDelegationWaitSettled(row) {
  if (!row) return false;
  if (!isTerminalDelegationStatus(row.status) || isDelegationSlotOccupied(row)) return false;
  // A terminal implement/fix whose automatic host verify is still running is not
  // settled yet: waiting for it here replaces the orchestrator's review start
  // racing the verify and failing with verify_pending. An orphaned marker
  // (older than the gate's max age) is ignored.
  const since = Date.parse(String(row.verifyPending?.since || ''));
  if (Number.isFinite(since) && Date.now() - since < VERIFY_PENDING_MAX_AGE_MS) return false;
  return true;
}

/**
 * @param {Record<string, any>[]} rows
 * @param {'all' | 'any'} until
 * @returns {boolean}
 */
export function isDelegationWaitSatisfied(rows, until) {
  if (!Array.isArray(rows) || rows.length === 0) return false;
  if (until === 'any') return rows.some(isDelegationWaitSettled);
  return rows.every(isDelegationWaitSettled);
}

/**
 * @param {AbortSignal | undefined} signal
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleepDelegationWait(signal, ms) {
  const delay = Math.max(0, Number(ms) || 0);
  if (delay === 0) {
    if (signal?.aborted) {
      const err = new Error('MCP call cancelled');
      /** @type {any} */ (err).code = 'VALIDATION_ERROR';
      throw err;
    }
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const err = new Error('MCP call cancelled');
      /** @type {any} */ (err).code = 'VALIDATION_ERROR';
      reject(err);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delay);
    function onAbort() {
      clearTimeout(timer);
      const err = new Error('MCP call cancelled');
      /** @type {any} */ (err).code = 'VALIDATION_ERROR';
      reject(err);
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}
