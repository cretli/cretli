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

export const DELEGATION_WAIT_DEFAULT_MS = 25000;
export const DELEGATION_WAIT_MAX_MS = 25000;
/** Longer wait for harnesses whose MCP client tool-call limit was confirmed live. */
export const DELEGATION_WAIT_EXTENDED_MAX_MS = 55000;
/**
 * Harnesses allowed the extended wait. A harness is added ONLY after a live
 * trial in which a 50 s delegation_wait returned `pending` through that
 * harness's MCP client without a client-side timeout. Trial results are
 * recorded in .agents/skills/cretli-multi-harness/references/loop-protocol.md.
 * Keyed by `session.harness`; Claude and Codex passed on 2026-11-01.
 * @type {readonly string[]}
 */
export const DELEGATION_WAIT_EXTENDED_HARNESSES = Object.freeze(['claude', 'codex']);
/**
 * Kept for backward compatibility only. The wait loop no longer polls at this
 * rate; it blocks on the change signal and re-reads on `DELEGATION_WAIT_FALLBACK_MS`.
 */
export const DELEGATION_WAIT_POLL_MS = 50;
/** Safety re-check interval so a change missed between read and subscribe still wakes the wait. */
export const DELEGATION_WAIT_FALLBACK_MS = 1000;
/** Default bridge HTTP timeout in remote-api-client. */
export const CRETILI_BRIDGE_HTTP_TIMEOUT_MS = 30000;

/**
 * Maximum wait for a calling harness: the extended limit only for allowlisted
 * harnesses, 25 s for everything else (including an unknown harness).
 * @param {unknown} harness
 * @param {readonly string[]} [allowlist]
 * @returns {number}
 */
export function delegationWaitMaxMsForHarness(harness, allowlist = DELEGATION_WAIT_EXTENDED_HARNESSES) {
  const id = String(harness || '').trim().toLowerCase();
  return id && allowlist.includes(id) ? DELEGATION_WAIT_EXTENDED_MAX_MS : DELEGATION_WAIT_MAX_MS;
}

/**
 * @param {unknown} value
 * @param {number} [maxMs]
 * @returns {number}
 */
export function clampDelegationWaitTimeoutMs(value, maxMs = DELEGATION_WAIT_MAX_MS) {
  if (value === undefined || value === null || value === '') {
    return Math.min(DELEGATION_WAIT_DEFAULT_MS, maxMs);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DELEGATION_WAIT_DEFAULT_MS;
  if (parsed <= 0) return 0;
  return Math.min(maxMs, Math.floor(parsed));
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

/** Advisory only: never advances workflow state or acknowledges a report.
 * @param {{verdict?: string, verifyStatus?: string|null, verifyRequired?: boolean, workRole?: string, assignment?: string, newFailureCount?: number}} input
 * @returns {'start_review'|'start_fix'|'read_report'|'none'}
 */
export function delegationWaitNextStep(input) {
  const rawRole = String(input.workRole || input.assignment || '');
  // work_role carries review_code / review_plan for reviews.
  const role = rawRole.startsWith('review') ? 'review' : rawRole;
  if (input.verdict === 'BLOCKED' || !['PASS', 'FAIL', 'conflict'].includes(input.verdict || '')) return 'read_report';
  if (input.verifyStatus === 'failed' && input.newFailureCount > 0) return 'start_fix';
  if (role === 'review' && ['FAIL', 'conflict'].includes(input.verdict)) return 'start_fix';
  if (input.verdict !== 'PASS') return 'read_report';
  // A PASS review suggests nothing: closing a leaf stays a parent decision.
  if (role === 'review') return 'none';
  // Unknown verification never suggests a review start or closure.
  const verified = ['passed', 'not_applicable'].includes(input.verifyStatus || '');
  if (!verified) return 'read_report';
  return ['implement', 'fix'].includes(role) ? 'start_review' : 'read_report';
}
