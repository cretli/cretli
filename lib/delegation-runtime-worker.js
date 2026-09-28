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
import { enqueueDelegationStoreWork } from './delegation-store-lock.js';
import { logDelegationEvent } from './delegation-log.js';
import {
  buildDelegationRuntimeHealthSnapshot,
  collectScopedDelegationHealthRows,
} from './delegation-health.js';
import {
  isDelegationRuntimeShuttingDown,
} from './delegation-lifecycle.js';
import {
  DELEGATION_CANCELLING_TIMEOUT_MS,
  DELEGATION_RUNTIME_TICK_MS,
  DELEGATION_RUNNING_ORPHAN_GRACE_MS,
  DELEGATION_STARTING_TIMEOUT_MS,
  MAILBOX_DISPATCHING_TIMEOUT_MS,
  isActiveDelegationStatus,
} from './delegation-status.js';
import { probeChatRunLiveness } from './chat-run-service.js';
import { listDelegationWorkflowsPastDeadline, applyDelegationWorkflowPatch } from './delegation-workflow.js';
import { getDelegationById, listActiveDelegationsForParent, loadDelegations, updateDelegationRecord } from './persist/delegations-persist.js';
import { loadChats } from './persist/chats-persist.js';
import { loadMailboxMessages, updateMailboxMessage } from './persist/delegation-mailbox-persist.js';

const WORKER_RETRY_MS = 5_000;
const WORKER_RETRY_MAX_MS = 60_000;

/** @type {ReturnType<typeof setInterval> | null} */
let timer = null;
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
 *
 * @param {object} row
 * @param {number} now
 */
function timeoutStartingIfSafe(row, now) {
  if (row.status !== 'starting') return;
  if (hasInFlightDelegationStart(row.id)) return;
  if (isChatRunStillActive({ chatId: row.childChatId, runId: row.runId })) return;
  if (ageMs(row.lastTransitionAt || row.startedAt || row.createdAt, now) < DELEGATION_STARTING_TIMEOUT_MS) {
    return;
  }
  const finished = finishDelegation(row, {
    status: 'interrupted',
    error: 'Timed out while starting. The run was not confirmed. This is not success. Retry to continue.',
    enqueueParentReply: true,
  });
  logDelegationEvent('starting-timeout', finished || row);
  return finished;
}

/**
 * @param {object} row
 * @param {number} now
 */
function timeoutCancellingIfSafe(row, now) {
  if (row.status !== 'cancelling') return;
  if (ageMs(row.lastTransitionAt || row.createdAt, now) < DELEGATION_CANCELLING_TIMEOUT_MS) return;
  const live = probeChatRunLiveness({ chatId: row.childChatId, runId: row.runId });
  const busy = live.busy === true || live.known !== true || hasInFlightDelegationStart(row.id);
  if (busy) {
    updateDelegationRecord(row.id, {
      errorAppend: [{
        at: new Date(now).toISOString(),
        code: 'cancel_timeout',
        message: 'Stop requested, but the executor is still running.',
        attemptId: row.attemptId,
      }],
    });
    logDelegationEvent('cancel-timeout-busy', row);
    return;
  }
  const finished = finishDelegation(row, {
    status: 'cancelled',
    error: row.error || 'Stop timed out; executor was idle.',
  });
  logDelegationEvent('cancel-timeout', finished || row);
  return finished;
}

/**
 * Running/waiting without an active run and without end proof: after the
 * grace period counted from the first confirmed idle observation, interrupt
 * and release. Adapter lookup failure or null state is not proof of a lost
 * run, so the slot stays occupied and a duplicate is not started.
 *
 * @param {object} row
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
    error: 'The executor run was lost after the grace period. This is not success. Retry to continue.',
    enqueueParentReply: true,
  });
  releaseDelegationRunSlot(finished || row);
  logDelegationEvent('running-orphan', finished || row);
  return finished;
}

/**
 * Dispatching without a confirmed run becomes uncertain. Never success.
 *
 * @param {object} row
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
  if (next) publishMailboxHistory(next);
  return next;
}

/**
 * @param {unknown} err
 * @param {object} [record]
 */
function noteNonFatalFlushError(err, record = {}) {
  if (isStoreIntegrityError(err)) throw err;
  logDelegationEvent('runtime-flush-error', record, {
    message: err instanceof Error ? err.message : String(err || 'flush_error'),
  });
}

/**
 * @param {object} row
 * @returns {string}
 */
function deadlineCancelFenceKey(row) {
  return `${String(row?.id || '').trim()}:${String(row?.attemptId || '').trim()}`;
}

/**
 * Fire-and-forget adapter cancel. A hung cancel must not hold tickInFlight.
 * Duplicate ticks for the same delegation/attempt share one in-flight promise.
 *
 * @param {object} row
 */
function requestDeadlineCancel(row) {
  const id = String(row?.id || '').trim();
  if (!id) return;
  const key = deadlineCancelFenceKey(row);
  if (inflightDeadlineCancels.has(key)) return;
  inflightDeadlineCancels.set(key, Promise.resolve());
  const attemptId = String(row.attemptId || '').trim();
  const runId = String(row.runId || '').trim();
  /** @type {Promise<void>} */
  let started;
  started = Promise.resolve(delegationService.cancel(id))
    .then((result) => {
      const latest = getDelegationById(id);
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
  for (const row of loadDelegations()) {
    const released = releaseDelegationRunSlot(row);
    const current = released || row;
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
    const latest = orphaned || cancelling || starting || current;
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
  const mailbox = loadMailboxMessages();
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
 * @param {object} row
 * @returns {boolean}
 */
function hasPendingOutbox(row) {
  return Array.isArray(row?.outbox) && row.outbox.some((item) => !String(item?.deliveredAt || '').trim());
}

/**
 * Only chats that still have queued mail need a drain pass.
 *
 * @param {object[]} mailbox
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
 * One runtime pass. Store work stays short. Adapter waits run per recipient
 * without holding the global persist queue.
 *
 * @param {{ now?: number, drainMailbox?: boolean }} [options]
 */
export async function tickDelegationRuntime(options = {}) {
  if (isDelegationRuntimeShuttingDown()) return getDelegationRuntimeHealth();
  if (health.degraded && Date.now() < health.nextRetryAt) {
    return getDelegationRuntimeHealth();
  }
  lastTickStartedAt = Date.now();
  /** @type {string[]} */
  let drainIds = [];
  try {
    drainIds = await enqueueDelegationStoreWork(() => tickDelegationRuntimeUnlocked(options));
    noteWorkerSuccess();
  } catch (err) {
    noteWorkerFailure(err);
    lastTickFinishedAt = Date.now();
    if (!isStoreIntegrityError(err)) throw err;
    return getDelegationRuntimeHealth();
  }
  lastTickFinishedAt = Date.now();
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  try {
    for (const workflow of listDelegationWorkflowsPastDeadline(now)) {
      applyDelegationWorkflowPatch({
        parentChatId: workflow.parentChatId,
        stopReason: 'deadline',
      });
      for (const row of listActiveDelegationsForParent(workflow.parentChatId)) {
        requestDeadlineCancel(row);
      }
    }
  } catch (err) {
    noteNonFatalFlushError(err, { id: 'workflow-deadline' });
  }
  if (options.drainMailbox !== false) {
    for (const chatId of drainIds) {
      void drainRecipientOutsideLock(chatId);
    }
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
  if (isDelegationRuntimeShuttingDown()) return;
  if (health.degraded && Date.now() < health.nextRetryAt) return;
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
