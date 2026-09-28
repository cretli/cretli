/**
 * Bounded long-poll for parent MCP delegation_wait (not a sequencer).
 * `waiting_for_input` keeps `slot_occupied` true — approver waits are not
 * infra failures and must not trigger fanout retry while the slot is held.
 */

import {
  isDelegationSlotOccupied,
  isTerminalDelegationStatus,
} from '../../delegation-status.js';

export const DELEGATION_WAIT_DEFAULT_MS = 20000;
export const DELEGATION_WAIT_MAX_MS = 25000;
export const DELEGATION_WAIT_POLL_MS = 50;
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
 * @param {object | null | undefined} row
 * @returns {boolean}
 */
export function isDelegationWaitSettled(row) {
  if (!row) return false;
  return isTerminalDelegationStatus(row.status) && !isDelegationSlotOccupied(row);
}

/**
 * @param {object[]} rows
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
      err.code = 'VALIDATION_ERROR';
      throw err;
    }
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const err = new Error('MCP call cancelled');
      err.code = 'VALIDATION_ERROR';
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
      err.code = 'VALIDATION_ERROR';
      reject(err);
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}
