/**
 * Shared cancelling timeout handling (boot reconciliation + runtime worker).
 */

import {
  blockTodoForCancelUnconfirmed,
  delegationHarnessSupportsAbort,
  writeDelegationStopProof,
} from './delegation-slot-stop.js';
import { DELEGATION_ADAPTER_INCOMPLETE_CODE } from './delegation-adapter-error.js';
import {
  DELEGATION_INTERRUPT_CANCEL_UNCONFIRMED,
  DELEGATION_INTERRUPT_RESTARTED,
  DELEGATION_INTERRUPT_REVIEW_CANCEL_STUCK,
  DELEGATION_INTERRUPT_RUN_DEADLINE_EXCEEDED,
  DELEGATION_SLOT_HELD_BY_CANCEL_UNCONFIRMED,
  isCancelUnconfirmedDelegationSlot,
  readDelegationCancellingTimeoutMs,
} from './delegation-status.js';
import { shouldFinishCancellingAsRunDeadlineExceeded } from './delegation-run-deadline.js';
import { isReviewReadOnlyAssignment } from './delegation-review-policy.js';
import { getDelegationById, updateDelegationRecord } from './persist/delegations-persist.js';
import { resolveDelegationEnv } from './delegation-settings.js';
import { isTerminalDelegationStatus } from './delegation-status.js';
import { hasWorkspaceWatcherLeafRestartEvidence } from './workspace-watcher-restart-evidence.js';

/** @typedef {import('./shared-types/index.js').DelegationRecord} DelegationRecord */

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
 * @param {DelegationRecord} row
 * @param {number} now
 * @param {{ finishDelegation: Function }} deps
 * @returns {Record<string, any> | null}
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
  // Fire-and-forget by design: the escalation is synchronous and the durable slot state is already written.
  void blockTodoForCancelUnconfirmed(held);
  return getDelegationById(held.id) || held;
}

/**
 * @param {DelegationRecord} row
 * @param {{ finishDelegation: Function, status?: string, error?: string, proofKind?: string, proofSource?: string }} input
 * @returns {Record<string, any> | null}
 */
/**
 * Review assignments are read-only: a stuck `cancelling` stop must not hold a
 * mutating slot as `cancel_unconfirmed`. Finish as infrastructure failure instead.
 *
 * @param {DelegationRecord} row
 * @param {number} now
 * @param {{ finishDelegation: Function }} deps
 * @returns {Record<string, any> | null}
 */
export function finishReviewCancellingAsInfra(row, now, deps) {
  if (!row?.id || row.status !== 'cancelling') return null;
  const message = row.error
    || 'Review cancellation exceeded the deadline while the executor was still active.';
  const finished = deps.finishDelegation(row, {
    status: 'interrupted',
    interruptCode: DELEGATION_INTERRUPT_REVIEW_CANCEL_STUCK,
    error: message,
    enqueueParentReply: true,
    attemptId: row.attemptId,
    runId: row.runId,
    errorAppend: [{
      at: new Date(now).toISOString(),
      code: DELEGATION_ADAPTER_INCOMPLETE_CODE,
      message,
      attemptId: row.attemptId,
    }],
  });
  const base = finished || row;
  writeDelegationStopProof(base, {
    kind: 'run_idle',
    source: 'review_cancelling_hard_timeout',
  });
  const released = updateDelegationRecord(base.id, {
    runStoppingAt: '',
    idleObservedAt: '',
  }) || base;
  return getDelegationById(released.id) || released;
}

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
 * @param {Record<string, any>} row
 * @param {number} now
 * @param {{
 *   busy?: boolean,
 *   known?: boolean,
 *   appendCancelTimeoutError?: boolean,
 *   lastCancelTimeoutErrorAt?: string,
 *   cancelTimeoutErrorMinGapMs?: number,
 *   restartEvidence?: boolean,
 * }} live
 * @param {{ finishDelegation: Function, hasInFlightDelegationStart: Function, drainQueue?: Function }} deps
 * @returns {'noop' | 'released' | 'escalated'}
 */
export function resolveCancellingDeadline(row, now, live, deps) {
  if (!row?.id || row.status !== 'cancelling') return 'noop';
  // A child that died with a previous process instance cannot answer a stop:
  // close right away instead of waiting out the adapter deadline.
  if (live.restartEvidence === true && isChildConfirmedGone(live) && !deps.hasInFlightDelegationStart(row.id)) {
    finishDelegationInterruptedRestart(row, deps);
    return 'released';
  }
  if (cancellingAgeMs(row.lastTransitionAt || row.createdAt, now) < readDelegationCancellingTimeoutMs(resolveDelegationEnv(row.workspaceFolder))) {
    return 'noop';
  }
  const supportsAbort = delegationHarnessSupportsAbort(row);
  const inFlight = deps.hasInFlightDelegationStart(row.id);
  const busy = live.busy === true || live.known !== true || inFlight;
  const reviewReadOnly = isReviewReadOnlyAssignment(row.assignment);
  if (reviewReadOnly && (busy || !supportsAbort)) {
    finishReviewCancellingAsInfra(row, now, deps);
    return 'released';
  }
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

/**
 * Positive proof that the child is not alive in this process: a confirmed idle
 * adapter state, or an adapter that has no room for the run (`state_missing`,
 * the post-restart shape). Ambiguous probes (adapter_error, probe_failed,
 * run_mismatch, adapter_missing, chat_missing) are never proof of death.
 *
 * @param {{ known?: boolean, busy?: boolean, reason?: string } | null | undefined} live
 * @returns {boolean}
 */
export function isChildConfirmedGone(live) {
  if (!live || live.busy === true) return false;
  return live.known === true || live.reason === 'state_missing';
}

const RESTART_INTERRUPT_ERROR = 'The executor run was lost in a server restart. This is not success. Do not retry this record; start a new delegation.';

/**
 * Close a running/cancelling job whose child died with a previous process
 * instance as `interrupted` / `interrupted_restart` and free its slot. The
 * caller must already hold restart evidence and a non-busy probe.
 *
 * @param {DelegationRecord} row
 * @param {{ finishDelegation: Function, drainQueue?: Function }} deps
 * @returns {Record<string, any> | null}
 */
export function finishDelegationInterruptedRestart(row, deps) {
  if (!row?.id) return null;
  const finished = deps.finishDelegation(row, {
    status: 'interrupted',
    interruptCode: DELEGATION_INTERRUPT_RESTARTED,
    error: RESTART_INTERRUPT_ERROR,
    enqueueParentReply: true,
    attemptId: row.attemptId,
    runId: row.runId,
  });
  const base = finished || row;
  if (String(base.status || '') !== 'interrupted') return getDelegationById(row.id) || base;
  // Restart evidence is the stop proof: the room is gone from this process.
  const released = updateDelegationRecord(base.id, { runStoppingAt: '', idleObservedAt: '' }) || base;
  // Drain explicitly: `releaseDelegationRunSlot` returns early once the stopping
  // marker is cleared, which would leave queued siblings stalled.
  if (typeof deps.drainQueue === 'function') deps.drainQueue(released);
  return getDelegationById(released.id) || released;
}

/**
 * Sweep running/waiting/cancelling delegations whose child is not alive in this
 * process and whose latest run carries another process instance's token.
 * Used at boot and by the Watcher tick so a dead child never holds the slot.
 * Run inside `enqueueDelegationStoreWork`.
 *
 * @param {{
 *   rows: DelegationRecord[],
 *   finishDelegation: Function,
 *   drainQueue?: Function,
 *   hasInFlightDelegationStart: Function,
 *   probe: Function,
 *   hasEvidence?: (chatId: string) => boolean,
 * }} input
 * @returns {string[]} ids closed as interrupted_restart
 */
export function interruptDelegationsWithRestartEvidence(input) {
  const hasEvidence = input.hasEvidence || ((chatId) => hasWorkspaceWatcherLeafRestartEvidence(chatId));
  const closed = [];
  for (const row of input.rows) {
    const status = String(row?.status || '');
    if (status !== 'running' && status !== 'waiting_for_input' && status !== 'cancelling') continue;
    if (isTerminalDelegationStatus(status)) continue;
    const chatId = String(row.childChatId || '').trim();
    if (!chatId || input.hasInFlightDelegationStart(row.id)) continue;
    const live = input.probe({ chatId, runId: row.runId });
    if (!isChildConfirmedGone(live)) continue;
    if (!hasEvidence(chatId)) continue;
    const done = finishDelegationInterruptedRestart(row, input);
    if (done && String(done.status || '') === 'interrupted') closed.push(row.id);
  }
  return closed;
}
