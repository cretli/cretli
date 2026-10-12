/**
 * Shared cancelling timeout handling (boot reconciliation + runtime worker).
 */

import {
  blockTodoForCancelUnconfirmed,
  delegationHarnessSupportsAbort,
  writeDelegationStopProof,
} from './delegation-slot-stop.js';
import {
  DELEGATION_INTERRUPT_CANCEL_UNCONFIRMED,
  DELEGATION_INTERRUPT_RUN_DEADLINE_EXCEEDED,
  DELEGATION_SLOT_HELD_BY_CANCEL_UNCONFIRMED,
  isCancelUnconfirmedDelegationSlot,
  readDelegationCancellingTimeoutMs,
} from './delegation-status.js';
import { shouldFinishCancellingAsRunDeadlineExceeded } from './delegation-run-deadline.js';
import { getDelegationById, updateDelegationRecord } from './persist/delegations-persist.js';

/**
 * @param {string | number | Date | undefined} from
 * @param {number} now
 * @returns {number}
 */
export function cancellingAgeMs(from, now) {
  const parsed = Date.parse(String(from || ''));
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, now - parsed);
}

/**
 * @param {object} row
 * @param {number} now
 * @param {{ finishDelegation: Function }} deps
 * @returns {object | null}
 */
export function escalateCancellingToCancelUnconfirmed(row, now, deps) {
  if (!row?.id || row.status !== 'cancelling') return null;
  const stoppingAt = new Date(now).toISOString();
  const finished = deps.finishDelegation(row, {
    status: 'interrupted',
    interruptCode: DELEGATION_INTERRUPT_CANCEL_UNCONFIRMED,
    error: row.error || 'Stop was requested but could not be confirmed before the deadline.',
    enqueueParentReply: true,
    attemptId: row.attemptId,
    runId: row.runId,
    slotHeldBy: DELEGATION_SLOT_HELD_BY_CANCEL_UNCONFIRMED,
    runStoppingAt: stoppingAt,
    cancelEscalatedAt: stoppingAt,
  });
  const held = finished || row;
  blockTodoForCancelUnconfirmed(held);
  return getDelegationById(held.id) || held;
}

/**
 * @param {object} row
 * @param {{ finishDelegation: Function, status?: string, error?: string, proofKind?: string, proofSource?: string }} input
 * @returns {object | null}
 */
export function finishCancellingWithStopProof(row, input) {
  if (!row?.id) return null;
  if (row.status !== 'cancelling' || isCancelUnconfirmedDelegationSlot(row)) {
    return getDelegationById(row.id) || row;
  }
  const latest = getDelegationById(row.id) || row;
  const runDeadline = shouldFinishCancellingAsRunDeadlineExceeded(latest);
  const status = runDeadline
    ? 'interrupted'
    : String(input.status || 'cancelled').trim().toLowerCase();
  const finished = input.finishDelegation(latest, {
    status,
    interruptCode: runDeadline ? DELEGATION_INTERRUPT_RUN_DEADLINE_EXCEEDED : undefined,
    error: runDeadline
      ? (latest.error || input.error || 'Run exceeded its time limit.')
      : (input.error || latest.error || ''),
    enqueueParentReply: runDeadline,
    attemptId: latest.attemptId,
    runId: latest.runId,
  });
  const base = finished || row;
  const proofKind = String(input.proofKind || 'run_idle').trim().toLowerCase();
  const withProof = writeDelegationStopProof(base, {
    kind: proofKind,
    source: input.proofSource || 'delegation_runtime',
  }) || base;
  const released = updateDelegationRecord(withProof.id, {
    runStoppingAt: '',
    idleObservedAt: '',
  }) || withProof;
  return getDelegationById(released.id) || released;
}

/**
 * @param {object} row
 * @param {number} now
 * @param {{
 *   busy?: boolean,
 *   known?: boolean,
 *   appendCancelTimeoutError?: boolean,
 *   lastCancelTimeoutErrorAt?: string,
 *   cancelTimeoutErrorMinGapMs?: number,
 * }} live
 * @param {{ finishDelegation: Function, hasInFlightDelegationStart: Function }} deps
 * @returns {'noop' | 'released' | 'escalated'}
 */
export function resolveCancellingDeadline(row, now, live, deps) {
  if (!row?.id || row.status !== 'cancelling') return 'noop';
  if (cancellingAgeMs(row.lastTransitionAt || row.createdAt, now) < readDelegationCancellingTimeoutMs()) {
    return 'noop';
  }
  const supportsAbort = delegationHarnessSupportsAbort(row);
  const inFlight = deps.hasInFlightDelegationStart(row.id);
  const busy = live.busy === true || live.known !== true || inFlight;
  if (!supportsAbort) {
    escalateCancellingToCancelUnconfirmed(row, now, deps);
    return 'escalated';
  }
  if (busy) {
    if (live.appendCancelTimeoutError === true) {
      const lastErrorAt = String(live.lastCancelTimeoutErrorAt || '').trim();
      const gap = Number.isFinite(live.cancelTimeoutErrorMinGapMs)
        ? Number(live.cancelTimeoutErrorMinGapMs)
        : 0;
      const repeated = lastErrorAt && cancellingAgeMs(lastErrorAt, now) < gap;
      if (!repeated) {
        updateDelegationRecord(row.id, {
          errorAppend: [{
            at: new Date(now).toISOString(),
            code: 'cancel_timeout',
            message: live.known !== true
              ? 'Stop requested, but the executor state is unknown.'
              : 'Stop requested, but the executor is still running.',
            attemptId: row.attemptId,
          }],
        });
      }
    }
    escalateCancellingToCancelUnconfirmed(row, now, deps);
    return 'escalated';
  }
  finishCancellingWithStopProof(row, {
    finishDelegation: deps.finishDelegation,
    status: 'cancelled',
    error: row.error || 'Stop timed out; executor was idle.',
    proofKind: 'run_idle',
    proofSource: 'cancelling_timeout',
  });
  return 'released';
}
