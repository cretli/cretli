/**
 * Periodic delegation runtime: outbox flush, starting/cancelling/dispatching
 * timeouts, and mailbox drain. This is not boot reconciliation and must not
 * interrupt an in-flight start as if the process had just restarted.
 *
 * Timer errors stay inside this worker. A corrupt store degrades the worker
 * and retries with backoff; it does not crash the process or rewrite the file.
 */

import { drainChatMailbox, publishMailboxHistory } from './delegation-mailbox.js';
import {
  flushDelegationOutboxUnlocked,
  finishDelegation,
  hasDurableAttemptEndProof,
  hasInFlightDelegationStart,
  isChatRunStillActive,
  releaseDelegationRunSlot,
  delegationService,
} from './delegation-service.js';
import { resolveCancellingDeadline } from './delegation-cancelling-deadline.js';
import { enqueueDelegationStoreWork } from './delegation-store-lock.js';
import { logDelegationEvent } from './delegation-log.js';
import {
  buildDelegationRuntimeHealthSnapshot,
  collectScopedDelegationHealthRows,
} from './delegation-health.js';
import {
  isBootReconciliationComplete,
  isDelegationRuntimeShuttingDown,
} from './delegation-lifecycle.js';
import {
  readDelegationCancellingTimeoutMs,
  DELEGATION_RUNTIME_TICK_MS,
  DELEGATION_RUNNING_ORPHAN_GRACE_MS,
  DELEGATION_STARTING_TIMEOUT_MS,
  MAILBOX_DISPATCHING_TIMEOUT_MS,
  isActiveDelegationStatus,
} from './delegation-status.js';
import { cancelChatRun, probeChatRunLiveness } from './chat-run-service.js';
import { runDueBootReprobes } from './recovery/recovery-boot.ts';
import { runWorkspaceWatcherHeartbeat } from './workspace-watcher.js';
import { runWorkspaceWatcherAutopilot } from './workspace-watcher-cycle.js';
import { timeJobAsync } from './periodic-job-runner.js';
import { runWorkspaceWatcherScoutPass } from './workspace-watcher-scout.js';
import { runFeedbackTriagePass } from './feedback-triage.js';
import {
  listDelegationsPendingRunDeadlineCancel,
  markDelegationRunDeadlineCancelRequested,
} from './delegation-run-deadline.js';
import { listDelegationWorkflowsPendingDeadlineCancel, applyDelegationWorkflowPatch } from './delegation-workflow.js';
import { delegationBelongsToWorkflowLeaf } from './delegation-workflow-leaf.js';
import { getDelegationById, listActiveDelegations, listActiveDelegationsForController, updateDelegationRecord } from './persist/delegations-persist.js';
import { loadChats } from './persist/chats-persist.js';
import { listMailboxByStatus, updateMailboxMessage } from './persist/delegation-mailbox-persist.js';
import { resolveDelegationEnv } from './delegation-settings.js';

/** @typedef {import('./shared-types/index.js').DelegationRecord} DelegationRecord */

const WORKER_RETRY_MS = 5_000;
const WORKER_RETRY_MAX_MS = 60_000;

/** @type {ReturnType<typeof setInterval> | null} */
let timer = null;
/** Local retry fence for due boot re-probes after a failed pass. */
let bootReprobeRetryAfter = 0;
const BOOT_REPROBE_FAILURE_BACKOFF_MS = 30000;
let workerGeneration = 0;
let tickInFlight = false;
let dispatchInFlight = 0;
let workerStartedAt = '';
let lastTickStartedAt = 0;
let lastTickFinishedAt = 0;
/** @type {Set<string>} */
const drainingRecipients = new Set();
/** @type {Map<string, Promise<void>>} */
const inflightDeadlineCancels = new Map();

/**
 * @returns {{
 *   ok: boolean,
 *   degraded: boolean,
 *   code: string,
 *   message: string,
 *   at: string,
 *   consecutiveErrors: number,
 *   nextRetryAt: number,
 * }}
 */
function createHealthyState() {
  return {
    ok: true,
    degraded: false,
    code: '',
    message: '',
    at: '',
    consecutiveErrors: 0,
    nextRetryAt: 0,
  };
}

let health = createHealthyState();
let lastDegradedLogAt = 0;

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isStoreIntegrityError(err) {
  const code = String(err && typeof err === 'object' && 'code' in err ? err.code : '');
  return code === 'DELEGATIONS_CORRUPT'
    || code === 'DELEGATIONS_IO'
    || code === 'DELEGATIONS_SCHEMA'
    || code === 'DELEGATION_OWNER_LOCKED'
    || code === 'MAILBOX_CORRUPT'
    || code === 'MAILBOX_IO'
    || code === 'MAILBOX_SCHEMA';
}

/**
 * @param {unknown} err
 */
function noteWorkerFailure(err) {
  const code = String(err && typeof err === 'object' && 'code' in err ? err.code : '') || 'DELEGATION_RUNTIME';
  const message = err instanceof Error ? err.message : String(err || 'runtime_error');
  const consecutiveErrors = health.consecutiveErrors + 1;
  const backoff = Math.min(WORKER_RETRY_MAX_MS, WORKER_RETRY_MS * (2 ** Math.min(8, consecutiveErrors - 1)));
  health = {
    ok: false,
    degraded: true,
    code,
    message,
    at: new Date().toISOString(),
    consecutiveErrors,
    nextRetryAt: Date.now() + backoff,
  };
  const now = Date.now();
  if (consecutiveErrors === 1 || now - lastDegradedLogAt >= backoff) {
    lastDegradedLogAt = now;
    logDelegationEvent('runtime-degraded', {}, {
      code,
      message,
      consecutiveErrors,
      nextRetryAt: health.nextRetryAt,
    });
  }
}

function noteWorkerSuccess() {
  if (!health.degraded) return;
  logDelegationEvent('runtime-recovered', {}, { previousCode: health.code });
  health = createHealthyState();
}

export function getDelegationRuntimeWorkerStats() {
  return {
    running: timer != null,
    tickInFlight,
    dispatchInFlight,
    startedAt: workerStartedAt,
    lastTickStartedAt,
    lastTickFinishedAt,
    degraded: health.degraded,
    ok: health.ok,
    code: health.code,
    message: health.message,
    at: health.at,
    consecutiveErrors: health.consecutiveErrors,
    nextRetryAt: health.nextRetryAt,
  };
}

/**
 * @returns {ReturnType<typeof buildDelegationRuntimeHealthSnapshot>}
 */
export function getDelegationRuntimeHealth() {
  const scoped = collectScopedDelegationHealthRows();
  return buildDelegationRuntimeHealthSnapshot({
    worker: getDelegationRuntimeWorkerStats(),
    delegations: scoped.delegations,
    mailbox: scoped.mailbox,
    storeError: scoped.storeError,
  });
}

export function resetDelegationRuntimeHealth() {
  health = createHealthyState();
  lastDegradedLogAt = 0;
  lastTickStartedAt = 0;
  lastTickFinishedAt = 0;
  dispatchInFlight = 0;
  inflightDeadlineCancels.clear();
}

/**
 * @returns {boolean}
 */
export function isDelegationRuntimeWorkerRunning() {
  return timer != null;
}

/**
 * @returns {boolean}
 */
export function isDelegationRuntimeTickInFlight() {
  return tickInFlight || dispatchInFlight > 0;
}

/**
 * @returns {number}
 */
export function getDelegationRuntimeDispatchInFlight() {
  return dispatchInFlight;
}

/**
 * @param {unknown} value
 * @param {number} [now]
 * @returns {number}
 */
function ageMs(value, now = Date.now()) {
  const parsed = Date.parse(String(value || ''));
  if (!Number.isFinite(parsed)) return Number.POSITIVE_INFINITY;
  return now - parsed;
}

/**
 * Timeout stuck starting jobs that are not in this process's accept wait.
 * The timeout needs a confirmed idle adapter; an unknown liveness state
 * (missing adapter, null getState, adapter exception) is not idle.
 *
 * @param {Record<string, any>} row
 * @param {number} now
 */
function timeoutStartingIfSafe(row, now) {
  if (row.status !== 'starting') return;
  if (hasInFlightDelegationStart(row.id)) return;
  const live = probeChatRunLiveness({ chatId: row.childChatId, runId: row.runId });
  if (live.known !== true || live.busy === true) return;
  if (ageMs(row.lastTransitionAt || row.startedAt || row.createdAt, now) < DELEGATION_STARTING_TIMEOUT_MS) {
    return;
  }
  const finished = finishDelegation(row, {
    status: 'interrupted',
    interruptCode: 'starting_timeout',
    error: 'Timed out while starting. The run was not confirmed. This is not success. Do not retry this record; start a new delegation.',
    enqueueParentReply: true,
  });
  logDelegationEvent('starting-timeout', finished || row);
  return finished;
}

/** Minimum gap between adapter stop retries for one stuck `cancelling` job. */
const CANCEL_RETRY_MIN_GAP_MS = 30_000;
/** Minimum gap between `cancel_timeout` error entries for one stuck `cancelling` job. */
const CANCEL_TIMEOUT_ERROR_MIN_GAP_MS = 5 * 60_000;
/** @type {Map<string, number>} */
const lastCancelRetryAt = new Map();

/**
 * A single adapter stop can fail or be lost (aborted tool, dropped event
 * stream). Re-send it for a run that is still known busy. Never frees the slot:
 * the job stays `cancelling` until the run is confirmed stopped. Unknown
 * liveness is not retried, since the adapter has no room to stop.
 *
 * @param {DelegationRecord} row
 * @param {{ known?: boolean, busy?: boolean }} live
 * @param {number} now
 */
function retryCancellingAdapterStop(row, live, now) {
  if (live.known !== true || live.busy !== true) return;
  const previous = lastCancelRetryAt.get(row.id) || 0;
  if (now - previous < CANCEL_RETRY_MIN_GAP_MS) return;
  lastCancelRetryAt.set(row.id, now);
  if (lastCancelRetryAt.size > 256) lastCancelRetryAt.delete(lastCancelRetryAt.keys().next().value);
  void cancelChatRun({ chatId: row.childChatId, runId: String(row.runId || '').trim() })
    .catch(() => {});
}

/**
 * @param {Record<string, any>} row
 * @param {number} now
 */
function timeoutCancellingIfSafe(row, now) {
  if (row.status !== 'cancelling') return;
  if (ageMs(row.lastTransitionAt || row.createdAt, now) < readDelegationCancellingTimeoutMs(resolveDelegationEnv(row.workspaceFolder))) return;
  let live = probeChatRunLiveness({ chatId: row.childChatId, runId: row.runId });
  const busyBeforeRetry = live.busy === true || live.known !== true || hasInFlightDelegationStart(row.id);
  if (busyBeforeRetry) retryCancellingAdapterStop(row, live, now);
  live = probeChatRunLiveness({ chatId: row.childChatId, runId: row.runId });
  const busy = live.busy === true || live.known !== true || hasInFlightDelegationStart(row.id);
  const lastError = Array.isArray(row.errors) ? row.errors[row.errors.length - 1] : null;
  const outcome = resolveCancellingDeadline(row, now, {
    busy,
    known: live.known === true,
    appendCancelTimeoutError: true,
    lastCancelTimeoutErrorAt: lastError?.code === 'cancel_timeout' ? lastError.at : '',
    cancelTimeoutErrorMinGapMs: CANCEL_TIMEOUT_ERROR_MIN_GAP_MS,
  }, { finishDelegation, hasInFlightDelegationStart });
  if (outcome === 'escalated') {
    logDelegationEvent('cancel-unconfirmed', getDelegationById(row.id) || row);
    return getDelegationById(row.id) || row;
  }
  if (outcome === 'released') {
    const finished = getDelegationById(row.id) || row;
    logDelegationEvent('cancel-timeout', finished);
    return finished;
  }
  if (busy) logDelegationEvent('cancel-timeout-busy', row);
}

/**
 * Running/waiting without an active run and without end proof: after the
 * grace period counted from the first confirmed idle observation, interrupt
 * and release. Adapter lookup failure or null state is not proof of a lost
 * run, so the slot stays occupied and a duplicate is not started.
 *
 * @param {Record<string, any>} row
 * @param {number} now
 */
function recoverOrphanedRunningIfSafe(row, now) {
  if (row.status !== 'running' && row.status !== 'waiting_for_input') return;
  if (hasInFlightDelegationStart(row.id)) return;
  if (hasDurableAttemptEndProof(row)) return;
  const live = probeChatRunLiveness({ chatId: row.childChatId, runId: row.runId });
  if (!live.known) return;
  if (live.busy) {
    if (String(row.idleObservedAt || '').trim()) {
      updateDelegationRecord(row.id, { idleObservedAt: '' });
    }
    return;
  }
  const observed = String(row.idleObservedAt || '').trim();
  if (!observed) {
    updateDelegationRecord(row.id, { idleObservedAt: new Date(now).toISOString() });
    return;
  }
  if (ageMs(observed, now) < DELEGATION_RUNNING_ORPHAN_GRACE_MS) return;
  const finished = finishDelegation(row, {
    status: 'interrupted',
    interruptCode: 'running_orphan',
    error: 'The executor run was lost after the grace period. This is not success. Do not retry this record; start a new delegation.',
    enqueueParentReply: true,
  });
  releaseDelegationRunSlot(finished || row);
  logDelegationEvent('running-orphan', finished || row);
  return finished;
}

/**
 * Dispatching without a confirmed run becomes uncertain. Never success.
 *
 * @param {Record<string, any>} row
 * @param {number} now
 */
function timeoutDispatchingMailbox(row, now) {
  if (String(row.status || '') !== 'dispatching') return;
  const startedAt = row.dispatchingAt || row.createdAt;
  if (ageMs(startedAt, now) < MAILBOX_DISPATCHING_TIMEOUT_MS) return;
  const next = updateMailboxMessage(row.id, {
    status: 'uncertain',
    delivery: 'uncertain',
    error: row.error || 'Dispatching timed out; prompt acceptance is unconfirmed.',
  });
  // The history card is published asynchronously; a failure leaves `historyDeliveredAt` unset, so the next mailbox
  // pass publishes it again (the card is deduplicated by message id and status).
  if (next) {
    void publishMailboxHistory(next).catch((err) => {
      try {
        noteNonFatalFlushError(err, next);
      } catch (fatal) {
        console.error('[delegation-runtime] mailbox history publish failed:', fatal?.message || fatal);
      }
    });
  }
  return next;
}

/**
 * @param {unknown} err
 * @param {Record<string, any>} [record]
 */
function noteNonFatalFlushError(err, record = {}) {
  if (isStoreIntegrityError(err)) throw err;
  logDelegationEvent('runtime-flush-error', record, {
    message: err instanceof Error ? err.message : String(err || 'flush_error'),
  });
}

/**
 * @param {DelegationRecord} row
 * @returns {string}
 */
function deadlineCancelFenceKey(row) {
  return `${String(row?.id || '').trim()}:${String(row?.attemptId || '').trim()}`;
}

/**
 * Fire-and-forget adapter cancel. A hung cancel must not hold tickInFlight.
 * Duplicate ticks for the same delegation/attempt share one in-flight promise.
 *
 * @param {Record<string, any>} row
 * @param {{ runLimitOverrun?: boolean }} [options]
 */
function requestDeadlineCancel(row, options = {}) {
  const id = String(row?.id || '').trim();
  if (!id) return;
  const key = deadlineCancelFenceKey(row);
  if (inflightDeadlineCancels.has(key)) return;
  inflightDeadlineCancels.set(key, Promise.resolve());
  if (options.runLimitOverrun === true) markDelegationRunDeadlineCancelRequested(row);
  const attemptId = String(row.attemptId || '').trim();
  const runId = String(row.runId || '').trim();
  /** @type {Promise<void>} */
  let started;
  started = Promise.resolve(delegationService.cancel(id))
    .then((result) => {
      const latest = /** @type {DelegationRecord | null} */ (getDelegationById(id));
      if (!latest) return;
      if (attemptId && String(latest.attemptId || '').trim() !== attemptId) return;
      if (runId && String(latest.runId || '').trim() && String(latest.runId || '').trim() !== runId) return;
      const live = probeChatRunLiveness({ chatId: latest.childChatId, runId: latest.runId });
      if (live.known !== true) return;
      if (result?.delegation) releaseDelegationRunSlot(getDelegationById(id) || latest);
    })
    .catch((err) => {
      noteNonFatalFlushError(err, row);
    })
    .finally(() => {
      if (inflightDeadlineCancels.get(key) === started) inflightDeadlineCancels.delete(key);
    });
  inflightDeadlineCancels.set(key, started);
}

/**
 * @param {{ now?: number, drainMailbox?: boolean }} [options]
 */
async function tickDelegationRuntimeUnlocked(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const drainMailbox = options.drainMailbox !== false;
  for (const row of listActiveDelegations()) {
    const released = releaseDelegationRunSlot(row);
    const current = /** @type {Record<string, any>} */ (released || row);
    if (
      isActiveDelegationStatus(current.status)
      && hasDurableAttemptEndProof(current)
      && current.status !== 'cancelling'
    ) {
      const repaired = finishDelegation(current, {
        status: 'completed',
        report: current.report,
        enqueueParentReply: false,
      });
      if (repaired && isChatRunStillActive({ chatId: repaired.childChatId, runId: repaired.runId })) {
        updateDelegationRecord(repaired.id, { runStoppingAt: repaired.runStoppingAt || new Date().toISOString() });
      } else if (repaired) {
        releaseDelegationRunSlot(repaired);
      }
    }
    const starting = timeoutStartingIfSafe(current, now);
    const cancelling = timeoutCancellingIfSafe(starting || current, now);
    const orphaned = recoverOrphanedRunningIfSafe(cancelling || starting || current, now);
    const latest = /** @type {Record<string, any>} */ (orphaned || cancelling || starting || current);
    if (isActiveDelegationStatus(latest.status) && latest.status === 'starting' && hasInFlightDelegationStart(latest.id)) {
      continue;
    }
    if (!hasPendingOutbox(latest)) continue;
    try {
      await flushDelegationOutboxUnlocked(latest, { now });
    } catch (err) {
      noteNonFatalFlushError(err, latest);
    }
  }
  const mailbox = listMailboxByStatus(['queued', 'dispatching']);
  for (const row of mailbox) {
    timeoutDispatchingMailbox(row, now);
  }
  if (!drainMailbox) return [];
  return listQueuedRecipientIds(mailbox);
}

/**
 * Every flush re-reads the whole store, so the tick skips records with
 * nothing left to deliver.
 *
 * @param {Record<string, any>} row
 * @returns {boolean}
 */
function hasPendingOutbox(row) {
  return Array.isArray(row?.outbox) && row.outbox.some((item) => !String(item?.deliveredAt || '').trim());
}

/**
 * Only chats that still have queued mail need a drain pass.
 *
 * @param {Record<string, any>[]} mailbox
 * @returns {string[]}
 */
function listQueuedRecipientIds(mailbox) {
  const knownChatIds = new Set(loadChats().map((chat) => String(chat.id || '').trim()).filter(Boolean));
  const recipients = mailbox
    .filter((row) => row.status === 'queued')
    .map((row) => String(row.toChatId || '').trim())
    .filter((id) => knownChatIds.has(id));
  return [...new Set(recipients)];
}

/**
 * @param {string} chatId
 */
async function drainRecipientOutsideLock(chatId) {
  const id = String(chatId || '').trim();
  if (!id || drainingRecipients.has(id)) return;
  drainingRecipients.add(id);
  dispatchInFlight += 1;
  try {
    await drainChatMailbox(id);
  } catch (err) {
    noteNonFatalFlushError(err, { id });
  } finally {
    drainingRecipients.delete(id);
    dispatchInFlight = Math.max(0, dispatchInFlight - 1);
  }
}

/**
 * Heartbeat triggers are coalesced: one pass in flight, and at least this long
 * between full tick/autopilot passes (env `CRETLI_WATCHER_HEARTBEAT_MIN_INTERVAL_MS`).
 */
const WATCHER_HEARTBEAT_MIN_INTERVAL_MS = Math.max(0, Number(process.env.CRETLI_WATCHER_HEARTBEAT_MIN_INTERVAL_MS ?? 5000) || 0);
/** Scout pass runs less often than the decision tick (env `CRETLI_WATCHER_SCOUT_MIN_INTERVAL_MS`). */
const WATCHER_SCOUT_MIN_INTERVAL_MS = Math.max(0, Number(process.env.CRETLI_WATCHER_SCOUT_MIN_INTERVAL_MS ?? 30000) || 0);
let watcherHeartbeatInFlight = false;
let watcherHeartbeatLastRunAt = 0;
let watcherScoutLastRunAt = 0;

/**
 * @param {number} [now]
 * @param {Parameters<typeof runWorkspaceWatcherHeartbeat>[0]} [watcherOptions]
 */
async function runWorkspaceWatcherHeartbeatSafely(now, watcherOptions = {}, coalesce = false) {
  if (!coalesce) {
    await runWorkspaceWatcherHeartbeatPasses(now, watcherOptions, false);
    return;
  }
  const started = Date.now();
  if (watcherHeartbeatInFlight) return;
  if (started - watcherHeartbeatLastRunAt < WATCHER_HEARTBEAT_MIN_INTERVAL_MS) return;
  watcherHeartbeatInFlight = true;
  watcherHeartbeatLastRunAt = started;
  try {
    await runWorkspaceWatcherHeartbeatPasses(now, watcherOptions, true);
  } finally {
    watcherHeartbeatInFlight = false;
    watcherHeartbeatLastRunAt = Date.now();
  }
}

/** Test hook: forget the coalescing state. */
export function resetWorkspaceWatcherHeartbeatThrottle() {
  watcherHeartbeatInFlight = false;
  watcherHeartbeatLastRunAt = 0;
  watcherScoutLastRunAt = 0;
}

/**
 * @param {number} [now]
 * @param {Parameters<typeof runWorkspaceWatcherHeartbeat>[0]} [watcherOptions]
 */
async function runWorkspaceWatcherHeartbeatPasses(now, watcherOptions = {}, throttleScout = false) {
  try {
    await runWorkspaceWatcherHeartbeat({
      ...watcherOptions,
      now: Number.isFinite(now) ? now : Date.now(),
    });
  } catch (err) {
    noteNonFatalFlushError(err, { id: 'workspace-watcher' });
  }
  // The autopilot pass may start one chat run per eligible workspace; it runs
  // after the observe pass so a slow adapter never delays the decision log.
  try {
    await runWorkspaceWatcherAutopilot({
      ...watcherOptions,
      now: Number.isFinite(now) ? now : Date.now(),
    });
  } catch (err) {
    noteNonFatalFlushError(err, { id: 'workspace-watcher-autopilot' });
  }
  try {
    await timeJobAsync('feedbackTriagePass', () => runFeedbackTriagePass({
      ...watcherOptions,
      now: Number.isFinite(now) ? now : Date.now(),
    }));
  } catch (err) {
    noteNonFatalFlushError(err, { id: 'feedback-triage' });
  }
  // Scout is its own periodic job, not a watcher cycle: it has a separate
  // schedule/budget, never consumes `activeCycles`/`maxCyclesPerDay`, and only
  // proposes work. Running it after autopilot keeps a slow scan off the cycle
  // path.
  try {
    if (throttleScout) {
      if (Date.now() - watcherScoutLastRunAt < WATCHER_SCOUT_MIN_INTERVAL_MS) return;
      watcherScoutLastRunAt = Date.now();
    }
    await timeJobAsync('workspaceWatcherScoutPass', () => runWorkspaceWatcherScoutPass({
      ...watcherOptions,
      now: Number.isFinite(now) ? now : Date.now(),
    }));
  } catch (err) {
    noteNonFatalFlushError(err, { id: 'workspace-watcher-scout' });
  }
}

/**
 * One runtime pass. Store work stays short. Adapter waits run per recipient
 * without holding the global persist queue.
 *
 * @param {{ now?: number, drainMailbox?: boolean, workspaceWatcher?: Parameters<typeof runWorkspaceWatcherHeartbeat>[0] }} [options]
 */
export async function tickDelegationRuntime(options = {}) {
  if (isDelegationRuntimeShuttingDown()) return getDelegationRuntimeHealth();
  // Boot readiness gate (leaf R8): manual/public ticks obey it too, so nothing
  // is processed while initializing or degraded.
  if (!isBootReconciliationComplete()) return getDelegationRuntimeHealth();
  const nowForSkip = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const watcherOptions = options.workspaceWatcher || {};
  if (health.degraded && Date.now() < health.nextRetryAt) {
    await runWorkspaceWatcherHeartbeatSafely(
      nowForSkip,
      { ...watcherOptions, throttleLeaseRenewal: false },
      !Number.isFinite(options.now),
    );
    return getDelegationRuntimeHealth();
  }
  lastTickStartedAt = Date.now();
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  /** @type {string[]} */
  let drainIds = [];
  try {
    drainIds = await enqueueDelegationStoreWork(() => tickDelegationRuntimeUnlocked(options));
    noteWorkerSuccess();
    try {
      for (const workflow of listDelegationWorkflowsPendingDeadlineCancel(now)) {
        // Cancel only the jobs attributed to this expired leaf. A chat-wide
        // legacy row (no leaf) still covers its own unattributed jobs, but it
        // must never cancel work that belongs to an explicit sibling leaf.
        for (const row of listActiveDelegationsForController(workflow.parentChatId)) {
          if (delegationBelongsToWorkflowLeaf(row, workflow.leafId)) requestDeadlineCancel(row);
        }
        // Fence on the exact deadline so a still-expired row is not processed
        // (and its cancel re-requested) on every following tick. A later
        // deadline change clears the fence in applyDelegationWorkflowPatch.
        applyDelegationWorkflowPatch({
          parentChatId: workflow.parentChatId,
          leafId: workflow.leafId,
          stopReason: 'deadline',
          deadlineCancelKey: String(workflow.deadlineAt || '').trim() || 'deadline',
        });
      }
      for (const row of listDelegationsPendingRunDeadlineCancel(now)) {
        requestDeadlineCancel(row, { runLimitOverrun: true });
      }
    } catch (err) {
      noteNonFatalFlushError(err, { id: 'workflow-deadline' });
    }
    // Execute due `unknown` boot re-probes (bounded per tick, best effort).
    try {
      if (now >= bootReprobeRetryAfter) {
        const reprobe = runDueBootReprobes({
          now,
          limit: 5,
          probeLiveness: (/** @type {Record<string, any>} */ run) => probeChatRunLiveness({
            chatId: run.chatId,
            runId: run.acceptance?.adapterRunId || run.adapterRunId,
          }),
        });
        if (reprobe && reprobe.ok === false) {
          // A persistent write failure never updates the stored backoff, so
          // the same due run would be retried every tick: back off locally.
          bootReprobeRetryAfter = now + BOOT_REPROBE_FAILURE_BACKOFF_MS;
          logDelegationEvent('recovery-boot-reprobe-failed', {}, {
            reason: reprobe.reason,
            errors: JSON.stringify(reprobe.errors || []).slice(0, 500),
          });
        }
      }
    } catch (err) {
      noteNonFatalFlushError(err, { id: 'boot-reprobe' });
    }
    // Resume any FIFO-queued delegations whose parent slot freed since the
    // last pass. Best effort and non-blocking for the watcher heartbeat.
    void delegationService.drainQueue({}).catch((err) => {
      noteNonFatalFlushError(err, { id: 'delegation-queue' });
    });
    if (options.drainMailbox !== false) {
      for (const chatId of drainIds) {
        void drainRecipientOutsideLock(chatId);
      }
    }
  } catch (err) {
    noteWorkerFailure(err);
    if (!isStoreIntegrityError(err)) throw err;
  } finally {
    lastTickFinishedAt = Date.now();
    // Workspace Watcher heartbeat runs even when the delegation store tick
    // failed, so observe rows still snapshot safely without blocking on store I/O.
    await runWorkspaceWatcherHeartbeatSafely(now, watcherOptions, !Number.isFinite(options.now));
  }
  return getDelegationRuntimeHealth();
}

/**
 * Interval callback. Never leaves a rejection unhandled. Store ticks do not
 * wait for a hung adapter.
 *
 * @param {number} generation
 */
async function runScheduledTick(generation) {
  if (generation !== workerGeneration) return;
  if (tickInFlight) return;
  // Boot readiness gate (leaf R8): a scheduled tick never runs before boot
  // reconciliation finished, even when a caller started the worker directly.
  if (!isBootReconciliationComplete()) return;
  if (isDelegationRuntimeShuttingDown()) return;
  if (health.degraded && Date.now() < health.nextRetryAt) {
    await runWorkspaceWatcherHeartbeatSafely(undefined, { throttleLeaseRenewal: false }, true);
    return;
  }
  tickInFlight = true;
  try {
    await tickDelegationRuntime();
  } catch (err) {
    noteWorkerFailure(err);
  } finally {
    tickInFlight = false;
  }
}

/**
 * @param {{ intervalMs?: number }} [options]
 */
export function startDelegationRuntimeWorker(options = {}) {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  workerGeneration += 1;
  const generation = workerGeneration;
  workerStartedAt = new Date().toISOString();
  const intervalMs = Number(options.intervalMs) > 0
    ? Number(options.intervalMs)
    : DELEGATION_RUNTIME_TICK_MS;
  timer = setInterval(() => {
    void runScheduledTick(generation);
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
}

export function stopDelegationRuntimeWorker() {
  workerGeneration += 1;
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
