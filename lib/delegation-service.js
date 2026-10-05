/**
 * Create, start, cancel, and retry plan-execution delegations.
 */

import { randomUUID } from 'crypto';
import { addChat, loadChats } from './persist/chats-persist.js';
import { linkTodoChat } from './persist/todos-persist.js';
import { appendChatHistoryEvents, loadChatHistory } from './persist/chat-history-persist.js';
import { markChatHasPendingDelegation } from './persist/chat-history-revisions.js';
import { broadcastChatHistoryUpdate } from './sdk/sdk-history-updates.js';
import {
  createDelegationRecord,
  findDelegationByIdempotencyKey,
  getDelegationById,
  listActiveDelegationsForParent,
  listDelegationsForParent,
  loadDelegations,
  updateDelegationRecord,
} from './persist/delegations-persist.js';
import { resolveDelegationParentWidth } from './delegation-width.js';
import { assertReviewAdapterAllowed } from './delegation-adapter-capabilities.js';
import { inspectDelegationWorkflowStart } from './delegation-workflow.js';
import {
  listOccupiedDelegations,
  resolveDelegationGlobalLimit,
  resolveDelegationWorkspaceWriteConflict,
} from './delegation-workspace-guard.js';
import { readChatPlanDocument } from './chat-plan-persist.js';
import { cancelChatRun, getChatRunState, hasChatRunAdapter, isChatRunConfirmedIdle, probeChatRunLiveness, startChatRun } from './chat-run-service.js';
import { buildDelegationExecutorPrompt } from './delegation-prompt.js';
import { resolveHistoryMessageSource } from './delegation-source.js';
import {
  buildDelegationRequestHash,
  hashDelegationContent,
  normalizeDelegationAssignment,
  resolveDelegationChildExecutionMode,
  normalizeDelegationSourceKind,
  normalizeDelegationPickReason,
  isDelegationPickReasonTooLong,
  MAX_DELEGATION_PICK_REASON_LENGTH,
} from './delegation-request.js';
import { drainChatMailbox, ensureDelegationParentMailboxReply, reconcileMailboxOnBoot } from './delegation-mailbox.js';
import { enqueueDelegationStoreWork } from './delegation-store-lock.js';
import { snapshotDelegationAttempt, countDelegationAttempts, listDelegationAttempts } from './delegation-attempt.js';
import { logDelegationEvent } from './delegation-log.js';
import { resolveDataPath } from './runtime-paths.js';
import { isDelegationRuntimeAcceptingWork, getDelegationLifecycleState } from './delegation-lifecycle.js';
import {
  canTransitionDelegationStatus,
  DELEGATION_CANCELLING_TIMEOUT_MS,
  DELEGATION_INTERRUPT_RUNNING_ORPHAN,
  DELEGATION_INTERRUPT_SERVER_RESTART,
  DELEGATION_INTERRUPT_STARTING_TIMEOUT,
  DELEGATION_OUTBOX_BACKOFF_MAX_MS,
  DELEGATION_OUTBOX_BACKOFF_MS,
  DELEGATION_RUNNING_ORPHAN_GRACE_MS,
  DELEGATION_SLOT_REASONS,
  DELEGATION_STARTING_TIMEOUT_MS,
  isActiveDelegationStatus,
  isDelegationSlotOccupied,
  isStaleTerminalRunStopping,
  isTerminalDelegationStatus,
  normalizeDelegationInterruptCode,
  normalizeDelegationTaskOutcome,
} from './delegation-status.js';
import { findMailboxFinalReplyForAttempt } from './persist/delegation-mailbox-persist.js';
import {
  describeUnavailableDelegationModel,
  isDelegationModelAvailable,
  resolveDelegationModel,
} from './delegation-executor.js';
import { appendRelatedChatHistoryLinks } from './chat-relation-history.js';
import { normalizeAgentTransport } from './agent-transport.js';
import { resolveSdkCwdForChat } from './workspace.js';
import { isAskSdkMode } from './sdk/sdk-mode.js';
// The leaf module, not `sdk-plan-guard.js`: that one imports the MCP policy,
// which imports the builtin tool catalog, which imports the delegation tools
// and would close an import cycle back into this file.
import { ASK_GUARD_USER_MESSAGE } from './sdk/sdk-guard-messages.js';
import { decodeModelValue } from './model-catalog.js';
import { delegationPersistedRole } from './model-pick-history.js';
import {
  DELEGATION_RATING_RATERS,
  delegationRatingCardSnapshot,
  fingerprintDelegationRating,
  normalizeDelegationRatingPayload,
  normalizeDelegationRatingRater,
} from './delegation-ratings.js';
import {
  appendDelegationRating,
  findDelegationRating,
} from './persist/delegation-ratings-persist.js';

/** @type {Map<string, Promise<unknown>>} */
const parentLocks = new Map();

/** @type {Map<string, { attemptId: string, childChatId: string }>} */
const inFlightStarts = new Map();

/** @type {Map<string, Promise<object>>} */
const retryJobInFlight = new Map();

/** @type {null | ((phase: string, record: object) => void)} */
let crashHook = null;

/**
 * Interrupt messages. Only `server_restart` is retryable (once); the other
 * codes must not invite another run of the same record.
 */
const SERVER_RESTART_ERROR = 'Server restarted before this run could be confirmed. This is not success. Retry this record once to continue.';
const STARTING_TIMEOUT_ERROR = 'Timed out while starting. The run was not confirmed. This is not success. Do not retry this record; start a new delegation.';
const RUNNING_ORPHAN_ERROR = 'The executor run was lost after the grace period. This is not success. Do not retry this record; start a new delegation.';

/**
 * True while create/retry is awaiting adapter accept. Idle getState is not "no run".
 *
 * @param {unknown} delegationId
 * @returns {boolean}
 */
export function hasInFlightDelegationStart(delegationId) {
  return inFlightStarts.has(String(delegationId || '').trim());
}

/**
 * @param {unknown} delegationId
 * @param {{ attemptId?: string, childChatId?: string }} meta
 */
function rememberInFlightStart(delegationId, meta = {}) {
  const id = String(delegationId || '').trim();
  if (!id) return;
  inFlightStarts.set(id, {
    attemptId: String(meta.attemptId || '').trim(),
    childChatId: String(meta.childChatId || '').trim(),
  });
}

/**
 * @param {unknown} delegationId
 */
function forgetInFlightStart(delegationId) {
  inFlightStarts.delete(String(delegationId || '').trim());
}

/**
 * Test hook: throw or delay a lifecycle phase (crash injection / slow adapter).
 *
 * @param {null | ((phase: string, record: object) => (void | Promise<void>))} fn
 */
export function setDelegationCrashHook(fn) {
  crashHook = typeof fn === 'function' ? fn : null;
}

/**
 * @param {string} phase
 * @param {object} [record]
 * @returns {void | Promise<void>}
 */
export function runDelegationCrashHook(phase, record = {}) {
  if (!crashHook) return undefined;
  return crashHook(String(phase || ''), record);
}

/**
 * Mark a start/retry result that ran review without a hard write guarantee
 * (`CRETLI_DELEGATION_REVIEW_ALLOW_UNCERTIFIED=1`).
 *
 * @param {object} result
 * @param {unknown} reviewUncertified
 * @returns {object}
 */
function tagReviewUncertified(result, reviewUncertified) {
  if (reviewUncertified !== true || !result || typeof result !== 'object') return result;
  return { ...result, reviewUncertified: true };
}

/**
 * Only an `interrupted` job with a durable `server_restart` code may be
 * continued, and at most once per record. Other interrupt codes and legacy
 * rows without a code are stop-only.
 *
 * @param {object} row
 * @returns {{ ok: true } | { ok: false, status: number, code: string, error: string, delegation: object }}
 */
function inspectInterruptedRetryGate(row) {
  if (String(row?.status || '') !== 'interrupted') return { ok: true };
  const code = normalizeDelegationInterruptCode(row?.interruptCode);
  if (code !== DELEGATION_INTERRUPT_SERVER_RESTART) {
    return {
      ok: false,
      status: 409,
      code: 'interrupted_no_retry',
      error: 'This interrupted job was not caused by a server restart. Do not retry this record; review the report or start a new delegation.',
      delegation: row,
    };
  }
  if (String(row?.interruptContinuedAt || '').trim()) {
    return {
      ok: false,
      status: 409,
      code: 'interrupted_retry_exhausted',
      error: 'This interrupted job already used its single server-restart continuation. Do not retry this record again.',
      delegation: row,
    };
  }
  return { ok: true };
}

/**
 * @param {string} parentChatId
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 * @template T
 */
async function withParentLock(parentChatId, task) {
  const key = String(parentChatId || '').trim();
  const previous = parentLocks.get(key) || Promise.resolve();
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const chain = previous.then(() => gate, () => gate);
  parentLocks.set(key, chain);
  await previous.catch(() => {});
  try {
    return await task();
  } finally {
    release();
    if (parentLocks.get(key) === chain) parentLocks.delete(key);
  }
}

/**
 * @param {object} delegation
 * @param {string} status
 * @param {Record<string, unknown>} [patch]
 * @param {{ expectedRevision?: number, expectedAttemptId?: string }} [options]
 */
function transition(delegation, status, patch = {}, options = {}) {
  const current = getDelegationById(delegation?.id) || delegation;
  if (!current?.id) return null;
  const expectedAttempt = String(options.expectedAttemptId || '').trim();
  if (expectedAttempt && String(current.attemptId || '') !== expectedAttempt) {
    return current;
  }
  if (!canTransitionDelegationStatus(current.status, status) && current.status !== status) {
    return current;
  }
  const next = updateDelegationRecord(current.id, { status, ...patch }, {
    expectedRevision: options.expectedRevision,
    expectedAttemptId: options.expectedAttemptId,
  });
  return next || getDelegationById(current.id) || current;
}

/**
 * @param {unknown} payload
 * @returns {Record<string, unknown> | null}
 */
function parseDelegationHistoryPayload(payload) {
  if (payload && typeof payload === 'object') return /** @type {Record<string, unknown>} */ (payload);
  if (typeof payload !== 'string' || !payload.trim()) return null;
  try {
    const parsed = JSON.parse(payload);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * @param {string} parentChatId
 * @param {{ id: string, event?: string, attemptId?: string, eventId?: string }} query
 * @returns {boolean}
 */
function hasDelegationHistoryEvent(parentChatId, query) {
  const store = loadChatHistory(parentChatId);
  const events = store?.events || [];
  const wantedEventId = String(query.eventId || '');
  const wantedAttempt = String(query.attemptId || '');
  return events.some((row) => {
    if (row.rec?.variant !== 'delegation') return false;
    const data = parseDelegationHistoryPayload(row.rec.payload);
    if (!data) return false;
    if (String(data.id || '') !== query.id) return false;
    if (String(data.event || '') !== String(query.event || '')) return false;
    const storedAttempt = String(data.attemptId || '');
    if (storedAttempt !== wantedAttempt) return false;
    // Acknowledgement shares the terminal status revision, but is a distinct
    // history event. Deduplicate delivery, not all events of that revision.
    return !wantedEventId || String(data.eventId || '') === wantedEventId;
  });
}

/**
 * Append a parent-history card after the disk write succeeds. Terminal
 * `finished` events set historyDeliveredAt only after a successful append
 * of the current attempt.
 *
 * @param {object} delegation
 * @param {string} event
 * @param {Record<string, unknown> | null} [snapshot]
 * @returns {object | null}
 */
export function publishDelegationStatus(delegation, event, snapshot = null) {
  const current = getDelegationById(delegation?.id) || delegation;
  if (!current?.id || !current.parentChatId) return current || null;
  const eventName = String(event || '').trim();
  if (!eventName) return current;
  const view = snapshot && typeof snapshot === 'object'
    ? { ...current, ...snapshot }
    : current;
  const attemptId = String(view.attemptId || '');
  const eventId = String(view.eventId || current.eventId || '');
  const already = hasDelegationHistoryEvent(current.parentChatId, {
    id: current.id,
    event: eventName,
    attemptId,
    eventId,
  });
  const snapshotIsCurrentAttempt = !attemptId || attemptId === String(current.attemptId || '');
  if (already) {
    if (eventName === 'finished' && snapshotIsCurrentAttempt && !String(current.historyDeliveredAt || '').trim()) {
      return updateDelegationRecord(current.id, { historyDeliveredAt: new Date().toISOString() });
    }
    return current;
  }
  const executor = view.executor && typeof view.executor === 'object' ? view.executor : {};
  const payload = JSON.stringify({
    id: current.id,
    status: view.status,
    childChatId: view.childChatId || current.childChatId,
    executor: view.executor || current.executor,
    report: view.report || '',
    error: view.error || '',
    unverified: view.unverified !== false,
    acknowledgedAt: view.acknowledgedAt || '',
    acknowledgedAttemptId: view.acknowledgedAttemptId || '',
    // Persisted user rating for the card (metadata only, never the report).
    // Read fresh on every publish so a later event keeps the rated state.
    userRating: delegationRatingCardSnapshot(findDelegationRating(current.id, 'user')),
    attemptId,
    attemptNumber: countDelegationAttempts(view.attempts ? view : current),
    event: eventName,
    eventId,
    sourceKind: view.sourceKind || current.sourceKind || '',
    assignment: view.assignment || current.assignment || '',
    pickReason: String(view.pickReason || current.pickReason || '').trim(),
    interruptCode: normalizeDelegationInterruptCode(view.interruptCode || current.interruptCode),
    model: executor.model || '',
    startedAt: view.startedAt || '',
    finishedAt: view.finishedAt || '',
    historyDeliveredAt: view.historyDeliveredAt || '',
    reportDeliveredAt: view.reportDeliveredAt || '',
    attempts: Array.isArray(view.attempts) ? view.attempts : (Array.isArray(current.attempts) ? current.attempts : []),
  });
  const result = appendChatHistoryEvents(current.parentChatId, '', [
    { rec: { kind: 'meta', variant: 'delegation', payload } },
  ]);
  if (!result?.ok) return current;
  markChatHasPendingDelegation(current.parentChatId);
  broadcastChatHistoryUpdate(current.parentChatId, result.appended);
  const patch = {};
  if (snapshotIsCurrentAttempt) {
    patch.lastPublishedStatus = view.status;
    patch.lastPublishedEvent = eventName;
    patch.lastPublishedEventId = eventId;
    if (eventName === 'finished') {
      patch.historyDeliveredAt = new Date().toISOString();
    }
  }
  if (Object.keys(patch).length === 0) return current;
  return updateDelegationRecord(current.id, patch) || current;
}

/**
 * @param {object} record
 * @returns {Record<string, unknown>}
 */
function buildFinishOutboxSnapshot(record) {
  return {
    status: record.status,
    report: record.report || '',
    error: record.error || '',
    attemptId: record.attemptId,
    eventId: record.eventId,
    parentChatId: record.parentChatId,
    childChatId: record.childChatId,
    unverified: record.unverified !== false,
    interruptCode: normalizeDelegationInterruptCode(record.interruptCode),
    startedAt: record.startedAt || '',
    finishedAt: record.finishedAt || '',
    executor: record.executor,
    sourceKind: record.sourceKind || '',
    assignment: record.assignment || '',
    attempts: Array.isArray(record.attempts) ? record.attempts : [],
  };
}

/**
 * @param {Record<string, unknown>} snapshot
 * @param {boolean} enqueueParentReply
 * @returns {object[]}
 */
function buildFinishOutboxItems(snapshot, enqueueParentReply) {
  const createdAt = new Date().toISOString();
  const items = [{
    id: randomUUID(),
    type: 'history',
    event: 'finished',
    attemptId: snapshot.attemptId,
    createdAt,
    deliveredAt: '',
    tryCount: 0,
    nextAttemptAt: '',
    snapshot,
  }];
  if (enqueueParentReply === true) {
    items.push({
      id: randomUUID(),
      type: 'mailbox',
      event: 'parent_reply',
      attemptId: snapshot.attemptId,
      createdAt,
      deliveredAt: '',
      tryCount: 0,
      nextAttemptAt: '',
      snapshot,
    });
  }
  return items;
}

/**
 * @param {object} delegation
 * @param {{
 *   report?: string,
 *   error?: string,
 *   status: string,
 *   enqueueParentReply?: boolean,
 *   attemptId?: string,
 *   runId?: string,
 *   taskOutcome?: string,
 *   interruptCode?: string,
 *   metrics?: Record<string, number | null>,
 * }} outcome
 */
export function finishDelegation(delegation, outcome) {
  const current = getDelegationById(delegation.id);
  if (!current) return null;
  if (!isDelegationEventCurrent(current, outcome?.runId, outcome?.attemptId)) {
    return current;
  }
  if (isTerminalDelegationStatus(current.status) && current.status !== 'cancelling') {
    if (outcome?.error) {
      return updateDelegationRecord(current.id, {
        errorAppend: [{
          at: new Date().toISOString(),
          code: 'adapter_after_terminal',
          message: String(outcome.error),
          attemptId: current.attemptId,
        }],
      }) || current;
    }
    if (!String(current.historyDeliveredAt || '').trim()) {
      return publishDelegationStatus(current, 'finished');
    }
    return current;
  }
  const finishedAt = new Date().toISOString();
  const next = transition(current, outcome.status, {
    report: outcome.report || current.report || '',
    error: outcome.error || current.error || '',
    finishedAt,
    taskOutcome: normalizeDelegationTaskOutcome(outcome.taskOutcome || current.taskOutcome),
    interruptCode: String(outcome.status || '') === 'interrupted'
      ? normalizeDelegationInterruptCode(outcome.interruptCode)
      : '',
    ...(outcome.metrics && typeof outcome.metrics === 'object' ? { metrics: outcome.metrics } : {}),
  }, { expectedAttemptId: current.attemptId });
  if (!next) return null;
  const snapshot = buildFinishOutboxSnapshot(next);
  const withOutbox = updateDelegationRecord(next.id, {
    outboxAppend: buildFinishOutboxItems(snapshot, outcome.enqueueParentReply === true),
  }) || next;
  logDelegationEvent('finished', withOutbox);
  runDelegationCrashHook('after-result-write', withOutbox);
  const published = publishDelegationStatus(withOutbox, 'finished', snapshot);
  const historyItem = (published?.outbox || withOutbox.outbox || [])
    .find((row) => row.type === 'history' && row.event === 'finished' && row.attemptId === snapshot.attemptId && !row.deliveredAt);
  if (historyItem && isHistoryOutboxSuccess(published || withOutbox, historyItem)) {
    markOutboxItemDelivered(published || withOutbox, historyItem.id);
  }
  return getDelegationById(next.id) || published;
}

/** Persist the host-owned review runner result for the current delegation attempt. */
export function recordDelegationVerifyResult(input = {}) {
  const id = String(input.delegationId || '').trim();
  const attemptId = String(input.attemptId || '').trim();
  const current = id ? getDelegationById(id) : null;
  if (!current || !attemptId || attemptId !== String(current.attemptId || '').trim()) return null;
  const result = input.result && typeof input.result === 'object' ? input.result : {};
  return updateDelegationRecord(id, {
    verifyResult: {
      status: result.ok === true ? 'passed' : 'failed',
      dataDir: String(result.dataDir || ''),
      recordedAt: new Date().toISOString(),
      attemptId,
    },
  });
}

/**
 * Patch one outbox intent on the latest record. Never rewrite the whole
 * snapshot from a stale in-memory array — concurrent appends must survive.
 *
 * @param {object} record
 * @param {string} itemId
 * @param {Record<string, unknown>} patch
 */
function patchOutboxItem(record, itemId, patch) {
  const id = String(record?.id || '').trim();
  const targetId = String(itemId || '').trim();
  if (!id || !targetId) return record;
  const latest = getDelegationById(id);
  if (!latest) return record;
  const item = (latest.outbox || []).find((row) => String(row.id || '') === targetId);
  if (!item) return latest;
  return updateDelegationRecord(id, {
    outboxItemPatch: {
      id: targetId,
      expectedAttemptId: String(item.attemptId || '').trim(),
      patch,
    },
  }) || latest;
}

/**
 * @param {object} record
 * @param {string} itemId
 */
function markOutboxItemDelivered(record, itemId) {
  return patchOutboxItem(record, itemId, {
    deliveredAt: new Date().toISOString(),
    nextAttemptAt: '',
    lastError: '',
  });
}

/**
 * @param {number} tryCount
 * @returns {number}
 */
function computeOutboxBackoffMs(tryCount) {
  const exp = Math.min(8, Math.max(0, Number(tryCount) || 0));
  return Math.min(DELEGATION_OUTBOX_BACKOFF_MAX_MS, DELEGATION_OUTBOX_BACKOFF_MS * (2 ** exp));
}

/**
 * @param {object} record
 * @param {object} item
 * @param {string} error
 * @param {number} [now]
 */
function markOutboxItemRetry(record, item, error, now = Date.now()) {
  const tryCount = (Number(item.tryCount) || 0) + 1;
  const nextAttemptAt = new Date(now + computeOutboxBackoffMs(tryCount)).toISOString();
  const patched = patchOutboxItem(record, item.id, {
    tryCount,
    nextAttemptAt,
    lastError: String(error || 'delivery_failed'),
  });
  return updateDelegationRecord(patched.id, {
    errorAppend: [{
      at: new Date(now).toISOString(),
      code: 'outbox_retry',
      message: String(error || 'delivery_failed'),
      attemptId: item.attemptId,
      outboxId: item.id,
    }],
  }) || patched;
}

/**
 * @param {object} record
 * @param {object} item
 * @returns {boolean}
 */
function isHistoryOutboxSuccess(record, item) {
  const snapshotAttempt = String(item?.snapshot?.attemptId || item?.attemptId || '');
  const currentAttempt = String(record?.attemptId || '');
  if (snapshotAttempt && currentAttempt && snapshotAttempt === currentAttempt) {
    return Boolean(String(record?.historyDeliveredAt || '').trim());
  }
  return hasDelegationHistoryEvent(record.parentChatId, {
    id: record.id,
    event: item.event || 'finished',
    attemptId: snapshotAttempt,
    eventId: String(item?.snapshot?.eventId || ''),
  });
}

/**
 * @param {unknown} result
 * @returns {boolean}
 */
function isMailboxOutboxSuccess(result) {
  if (!result || result.ok === false) return false;
  return Boolean(result.message);
}

/**
 * Flush without taking the store lock. Callers that already hold
 * `enqueueDelegationStoreWork` must use this to avoid deadlock.
 *
 * @param {object} delegation
 * @param {{ now?: number }} [options]
 * @returns {Promise<object | null>}
 */
export async function flushDelegationOutboxUnlocked(delegation, options = {}) {
  let current = getDelegationById(delegation?.id) || delegation;
  if (!current?.id) return current || null;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const pending = Array.isArray(current.outbox)
    ? current.outbox.filter((row) => !String(row.deliveredAt || '').trim())
    : [];
  for (const item of pending) {
    current = getDelegationById(current.id) || current;
    const dueAt = Date.parse(String(item.nextAttemptAt || ''));
    if (Number.isFinite(dueAt) && dueAt > now) continue;
    await Promise.resolve().then(() => runDelegationCrashHook(`outbox:${item.type}`, current));
    const snapshot = item.snapshot && typeof item.snapshot === 'object' ? item.snapshot : null;
    if (item.type === 'history') {
      const published = publishDelegationStatus(current, item.event || 'updated', snapshot);
      current = published || current;
      if (isHistoryOutboxSuccess(current, item)) {
        current = markOutboxItemDelivered(current, item.id) || current;
      } else {
        current = markOutboxItemRetry(current, item, 'history_append_failed', now) || current;
      }
      continue;
    }
    if (item.type !== 'mailbox') continue;
    await Promise.resolve().then(() => runDelegationCrashHook('before-mailbox', current));
    const result = await ensureDelegationParentMailboxReply(current, snapshot, { deferDelivery: true });
    if (isMailboxOutboxSuccess(result)) {
      current = markOutboxItemDelivered(current, item.id) || current;
    } else {
      const reason = result?.error || (result == null ? 'mailbox_skipped' : 'mailbox_failed');
      current = markOutboxItemRetry(current, item, reason, now) || current;
    }
  }
  return getDelegationById(current.id) || current;
}

/**
 * Deliver pending history/mailbox intents after a crash or restart.
 * Marks only the specific outbox id, and only after a confirmed result.
 *
 * @param {object} delegation
 * @param {{ now?: number }} [options]
 * @returns {Promise<object | null>}
 */
export async function flushDelegationOutbox(delegation, options = {}) {
  const flushed = await enqueueDelegationStoreWork(() => flushDelegationOutboxUnlocked(delegation, options));
  const parentChatId = String(flushed?.parentChatId || delegation?.parentChatId || '').trim();
  if (parentChatId) {
    await drainChatMailbox(parentChatId);
  }
  return getDelegationById(delegation?.id) || flushed;
}

/**
 * @param {object} delegation
 * @param {string} runId
 * @param {string} attemptId
 * @param {string} eventRunId
 * @param {string} eventAttemptId
 * @returns {boolean}
 */
export function isDelegationEventCurrent(delegation, eventRunId, eventAttemptId) {
  if (!delegation) return false;
  const attemptId = String(delegation.attemptId || '').trim();
  const runId = String(delegation.runId || '').trim();
  const incomingAttempt = String(eventAttemptId || '').trim();
  const incomingRun = String(eventRunId || '').trim();
  if (incomingAttempt && attemptId && incomingAttempt !== attemptId) return false;
  if (incomingRun && runId && incomingRun !== runId) return false;
  return true;
}

/**
 * @param {object | null | undefined} row
 * @returns {{ attemptId: string, runId: string, childChatId: string }}
 */
function readDelegationCancelFence(row) {
  return {
    attemptId: String(row?.attemptId || '').trim(),
    runId: String(row?.runId || '').trim(),
    childChatId: String(row?.childChatId || '').trim(),
  };
}

/**
 * @param {object | null | undefined} latest
 * @param {{ attemptId?: string, runId?: string }} fence
 * @returns {{ ok: true, status: number, skipped: true, stale: true, delegation: object } | null}
 */
function staleDelegationCancelResult(latest, fence) {
  if (isDelegationEventCurrent(latest, fence?.runId, fence?.attemptId)) return null;
  return { ok: true, status: 200, skipped: true, stale: true, delegation: latest };
}

/**
 * @param {{ chatId?: string, runId?: string }} input
 * @returns {boolean}
 */
export function isChatRunStillActive(input) {
  let state = null;
  try {
    state = getChatRunState(input);
  } catch {
    state = null;
  }
  return !!(state?.busy || state?.waitingForInput);
}

/**
 * Durable end of this attempt: a fenced final_report, adapter finish, or
 * stored finishedAt for the same attemptId. Age or a null getState is not proof.
 *
 * @param {object | null | undefined} row
 * @param {string} [attemptId]
 * @returns {boolean}
 */
export function hasDurableAttemptEndProof(row, attemptId) {
  if (!row) return false;
  const wanted = String(attemptId || row.attemptId || '').trim();
  if (!wanted) return false;
  const finalReply = findMailboxFinalReplyForAttempt(row.id, wanted);
  if (finalReply) return true;
  const storedFinalAttempt = String(row.finalReportAttemptId || '').trim();
  if (storedFinalAttempt && storedFinalAttempt === wanted && String(row.finalReportAcceptedAt || '').trim()) {
    return true;
  }
  if (isTerminalDelegationStatus(row.status) && String(row.attemptId || '').trim() === wanted) {
    if (String(row.finishedAt || '').trim()) return true;
  }
  const archived = listDelegationAttempts(row);
  return archived.some((item) => {
    if (String(item.attemptId || '').trim() !== wanted) return false;
    return Boolean(String(item.finishedAt || '').trim());
  });
}

/**
 * @param {object | null | undefined} row
 * @returns {{ occupied: boolean, reason: string, code: string, delegationId: string, attemptId: string }}
 */
export function inspectDelegationSlot(row) {
  const delegationId = String(row?.id || '').trim();
  const attemptId = String(row?.attemptId || '').trim();
  const empty = { occupied: false, reason: '', code: '', delegationId, attemptId };
  if (!row || !delegationId) return empty;
  const inFlight = hasInFlightDelegationStart(delegationId);
  const live = probeChatRunLiveness({ chatId: row.childChatId, runId: row.runId });
  const runBusy = live.busy === true;
  const runStateKnown = live.known === true;
  const pendingAccept = String(row.acceptState || '') === 'pending';
  const stopping = Boolean(String(row.runStoppingAt || '').trim())
    && !isStaleTerminalRunStopping(row);
  const hasProof = hasDurableAttemptEndProof(row, attemptId);
  const active = isActiveDelegationStatus(row.status);
  if (stopping) {
    return {
      occupied: true,
      reason: DELEGATION_SLOT_REASONS.RUN_STOPPING,
      code: 'run_stopping',
      delegationId,
      attemptId,
    };
  }
  if (inFlight || pendingAccept || row.status === 'waiting_for_input' || row.status === 'cancelling' || (active && runBusy)) {
    return {
      occupied: true,
      reason: DELEGATION_SLOT_REASONS.JOB_IN_PROGRESS,
      code: active && row.status !== 'cancelling' ? 'still_active' : 'job_in_progress',
      delegationId,
      attemptId,
    };
  }
  if (active && hasProof) {
    return {
      occupied: true,
      reason: DELEGATION_SLOT_REASONS.STALE_RUNNING,
      code: 'stale_running',
      delegationId,
      attemptId,
    };
  }
  if (active && !runStateKnown) {
    return {
      occupied: true,
      reason: DELEGATION_SLOT_REASONS.UNKNOWN,
      code: 'unknown',
      delegationId,
      attemptId,
    };
  }
  if (active) {
    return {
      occupied: true,
      reason: DELEGATION_SLOT_REASONS.UNKNOWN,
      code: 'unknown',
      delegationId,
      attemptId,
    };
  }
  if (isDelegationSlotOccupied(row)) {
    return {
      occupied: true,
      reason: DELEGATION_SLOT_REASONS.RUN_STOPPING,
      code: 'run_stopping',
      delegationId,
      attemptId,
    };
  }
  return empty;
}

/**
 * @param {object} blocker
 * @param {string} fallbackCode
 * @param {string} fallbackError
 */
function slotConflict(blocker, fallbackCode, fallbackError) {
  return {
    ok: false,
    status: 409,
    error: fallbackError,
    code: blocker.code || fallbackCode,
    reason: blocker.reason || '',
    delegationId: blocker.delegationId || '',
    attemptId: blocker.attemptId || '',
    id: blocker.delegationId || '',
  };
}

/**
 * Shared start/retry width. Same-job resume is exempt via resumeDelegationId.
 *
 * @param {{
 *   parentChatId: string,
 *   incomingAssignment: unknown,
 *   resumeDelegationId?: string,
 *   gate: 'start' | 'retry',
 *   workspaceFolder?: string,
 * }} input
 */
function parentWidthConflict(input) {
  const width = resolveDelegationParentWidth({
    active: listActiveDelegationsForParent(input.parentChatId),
    incomingAssignment: input.incomingAssignment,
    resumeDelegationId: input.resumeDelegationId,
    gate: input.gate,
  });
  if (!width.ok) {
    const inspected = inspectDelegationSlot(width.blocker);
    return {
      ...slotConflict(inspected, width.code, width.error),
      code: width.code,
      delegation: width.blocker,
    };
  }
  const occupied = listOccupiedDelegations();
  const workspace = resolveDelegationWorkspaceWriteConflict({
    active: occupied,
    workspaceFolder: input.workspaceFolder,
    parentChatId: input.parentChatId,
    incomingAssignment: input.incomingAssignment,
    resumeDelegationId: input.resumeDelegationId,
  });
  if (!workspace.ok) {
    const inspected = inspectDelegationSlot(workspace.blocker);
    return {
      ...slotConflict(inspected, workspace.code, workspace.error),
      code: workspace.code,
      delegation: workspace.blocker,
    };
  }
  const global = resolveDelegationGlobalLimit({
    active: occupied,
    resumeDelegationId: input.resumeDelegationId,
  });
  if (!global.ok) {
    const inspected = inspectDelegationSlot(global.blocker);
    return {
      ...slotConflict(inspected, global.code, global.error),
      code: global.code,
      delegation: global.blocker,
    };
  }
  return null;
}

/**
 * Clear the parent slot after the child run is confirmed idle.
 *
 * @param {object | null | undefined} row
 * @returns {object | null}
 */
export function releaseDelegationRunSlot(row) {
  if (!row?.id) return row || null;
  if (!String(row.runStoppingAt || '').trim()) return row;
  if (hasInFlightDelegationStart(row.id)) return row;
  const idle = isChatRunConfirmedIdle({ chatId: row.childChatId, runId: row.runId });
  const staleTerminal = isTerminalDelegationStatus(row.status) && isStaleTerminalRunStopping(row);
  if (!idle && !staleTerminal) return row;
  return updateDelegationRecord(row.id, { runStoppingAt: '', idleObservedAt: '' }) || row;
}

/** @type {Map<string, { timer: ReturnType<typeof setTimeout>, runId: string }>} */
const pendingChildRunStops = new Map();

/**
 * Ingest window for Cursor to receive the MCP `delegation_reply` tool result
 * before Cretli aborts the leftover executor run. This is not an SLA: quiet
 * rewrite hides `runCancelled` independently of the timer. The timer stores
 * `{ timer, runId }` and adapters fence on that runId / `finalReportRunId`.
 * `setImmediate` still races the MCP return and leaves the tool card running
 * while the UI shows a cancelled-run error.
 */
export const DELEGATION_CHILD_STOP_GRACE_MS = 2500;

/**
 * Stop the child run after the current MCP/HTTP turn. Awaiting cancel inside
 * `delegation_reply` deadlocks: the SDK run waits for the tool result, and
 * cancel waits for that same run.
 *
 * @param {{ chatId?: string, runId?: string, delegationId?: string }} input
 */
export function scheduleDelegationChildRunStop(input) {
  const chatId = String(input?.chatId || '').trim();
  const runId = String(input?.runId || '').trim();
  const delegationId = String(input?.delegationId || '').trim();
  if (!chatId) return;
  const previous = pendingChildRunStops.get(chatId);
  if (previous?.timer) clearTimeout(previous.timer);
  const timer = setTimeout(() => {
    const pending = pendingChildRunStops.get(chatId);
    pendingChildRunStops.delete(chatId);
    if (pending && runId && pending.runId && pending.runId !== runId) return;
    if (!isChatRunStillActive({ chatId, runId })) {
      if (delegationId) releaseDelegationRunSlot(getDelegationById(delegationId));
      return;
    }
    void cancelChatRun({ chatId, runId })
      .catch(() => {})
      .finally(() => {
        if (!delegationId) return;
        releaseDelegationRunSlot(getDelegationById(delegationId));
      });
  }, DELEGATION_CHILD_STOP_GRACE_MS);
  timer.unref?.();
  pendingChildRunStops.set(chatId, { timer, runId });
}

/**
 * Persist a child final_report: complete this attempt, keep the slot until
 * the run is idle, and never auto-ack reviewed.
 *
 * @param {{
 *   delegationId: string,
 *   attemptId: string,
 *   runId?: string,
 *   report?: string,
 *   taskOutcome?: string,
 *   mutateCurrent?: boolean,
 * }} input
 */
export async function acceptDelegationFinalReport(input) {
  const id = String(input?.delegationId || '').trim();
  const attemptId = String(input?.attemptId || '').trim();
  const current = id ? getDelegationById(id) : null;
  if (!current) return { ok: false, status: 404, error: 'Delegation not found.', code: 'not_found' };
  if (!attemptId) return { ok: true, skipped: true, reason: 'unassigned', delegation: current };
  if (input?.mutateCurrent === false || attemptId !== String(current.attemptId || '').trim()) {
    return { ok: true, skipped: true, reason: 'stale_attempt', delegation: current };
  }
  if (current.status === 'cancelled') {
    return { ok: true, skipped: true, reason: 'already_cancelled', delegation: current };
  }
  if (isTerminalDelegationStatus(current.status) && current.status !== 'cancelling') {
    return { ok: true, skipped: true, reason: 'already_terminal', delegation: current };
  }
  const finished = finishDelegation(current, {
    status: 'completed',
    report: input.report,
    taskOutcome: input.taskOutcome,
    enqueueParentReply: false,
  });
  const holding = updateDelegationRecord(current.id, {
    runStoppingAt: new Date().toISOString(),
    finalReportAcceptedAt: new Date().toISOString(),
    finalReportAttemptId: attemptId,
    finalReportRunId: String(input.runId || current.runId || '').trim(),
  }) || finished || current;
  await Promise.resolve().then(() => runDelegationCrashHook('after-final-report-result', holding));
  return {
    ok: true,
    skipped: false,
    delegation: getDelegationById(current.id) || holding,
  };
}

/**
 * Shared start/retry gates. Must run before the record is mutated.
 *
 * @param {{
 *   parent: object | null,
 *   executor?: { transport?: unknown, model?: unknown },
 *   isModelAvailable: (input: { transport: string, model: string }) => boolean,
 *   resolveCwd: (chat: object) => string,
 * }} input
 */
function validateDelegationExecutorStart(input) {
  const parent = input.parent;
  if (!parent) {
    return { ok: false, status: 404, error: 'Parent chat not found.', code: 'chat_not_found' };
  }
  if (isAskSdkMode(parent.sdkMode)) {
    return {
      ok: false,
      status: 409,
      error: ASK_GUARD_USER_MESSAGE,
      code: 'ask_mode_denied',
    };
  }
  if (String(parent.delegationParentChatId || '').trim()) {
    return {
      ok: false,
      status: 409,
      error: 'Child chats cannot start another delegation. Return the report to the parent instead.',
      code: 'nested_delegation_denied',
    };
  }
  const cwd = input.resolveCwd(parent);
  if (!cwd) {
    return { ok: false, status: 400, error: 'Workspace folder is missing.', code: 'no_workspace' };
  }
  const transport = normalizeAgentTransport(input.executor?.transport);
  if (!hasChatRunAdapter(transport)) {
    return {
      ok: false,
      status: 400,
      error: `Executor ${transport} cannot run without an open browser in this version.`,
      code: 'executor_unavailable',
    };
  }
  const requestedModel = String(input.executor?.model || '').trim();
  const model = resolveDelegationModel({ transport, model: requestedModel });
  if (!model || input.isModelAvailable({ transport, model }) === false) {
    return {
      ok: false,
      status: 400,
      error: describeUnavailableDelegationModel({ transport }),
      code: 'model_unavailable',
    };
  }
  return { ok: true, cwd, transport, model };
}

/**
 * @param {{ latest: object, started?: { runId?: string }, childChatId: string }} input
 * @returns {Promise<object>}
 */
async function stopAcceptedRunIfObsolete(input) {
  const latest = input.latest;
  const childChatId = String(input.childChatId || latest?.childChatId || '').trim();
  const runId = String(input.started?.runId || latest?.runId || '').trim();
  if (!latest?.id || !childChatId) return latest;
  const shouldStop = isTerminalDelegationStatus(latest.status) || latest.status === 'cancelling';
  if (!shouldStop) return latest;
  try {
    await cancelChatRun({ chatId: childChatId, runId });
  } catch {
    // Best-effort stop of a late accept after cancel/finish.
  }
  const after = getDelegationById(latest.id) || latest;
  const stillBusy = isChatRunStillActive({ chatId: childChatId, runId });
  if (after.status === 'cancelling' && !stillBusy) {
    return finishDelegation(after, { status: 'cancelled' }) || after;
  }
  return after;
}

/**
 * @param {object} deps
 */
export function createDelegationService(deps = {}) {
  const resolveCwd = typeof deps.workspaceDirForAgent === 'function'
    ? (chat) => resolveSdkCwdForChat(chat, deps.workspaceDirForAgent)
    : (chat) => String(chat?.workspaceFolder || '').trim();
  const isModelAvailable = typeof deps.isModelAvailable === 'function'
    ? deps.isModelAvailable
    : isDelegationModelAvailable;

  /**
   * Best-effort: record the executor chat in the parent todo's chat history.
   * Linking never bumps the todo revision.
   *
   * @param {object} child
   * @param {object} parent
   */
  function linkChildChatToTodo(child, parent) {
    const todoId = String(parent?.todoId || '').trim();
    const dataDir = String(deps.dataDir || '').trim();
    if (!todoId || !child?.id || !dataDir) return;
    const cwd = resolveCwd(child);
    if (!cwd) return;
    try {
      linkTodoChat(dataDir, cwd, todoId, child.id);
    } catch {
      // Linking is bookkeeping; a failure must not abort the delegation.
    }
  }

  /**
   * @param {{
   *   parentChatId: string,
   *   executor: { transport: string, model: string, options?: object },
   *   planRevision: number,
   *   idempotencyKey: string,
   *   extraInstructions?: string,
   *   title?: string,
   *   sourceKind?: string,
   *   historySeq?: number,
   *   contentHash?: string,
   *   taskText?: string,
   *   executionMode?: string,
   *   assignment?: string,
   * }} input
   */
  async function createAndStart(input) {
    if (!isDelegationRuntimeAcceptingWork()) {
      return {
        ok: false,
        status: 503,
        error: 'Delegation runtime is not ready to accept new jobs.',
        code: 'runtime_not_ready',
        state: getDelegationLifecycleState(),
      };
    }
    const parentChatId = String(input?.parentChatId || '').trim();
    const idempotencyKey = String(input?.idempotencyKey || '').trim();
    if (!parentChatId) {
      return { ok: false, status: 400, error: 'Parent chat is required.', code: 'parent_required' };
    }
    if (isDelegationPickReasonTooLong(input?.pickReason)) {
      return {
        ok: false,
        status: 400,
        error: `pickReason must be at most ${MAX_DELEGATION_PICK_REASON_LENGTH} characters.`,
        code: 'pick_reason_too_long',
      };
    }
    const pickReason = normalizeDelegationPickReason(input?.pickReason);
    return withParentLock(parentChatId, async () => {
      const parent = loadChats().find((row) => row.id === parentChatId);
      const startGate = validateDelegationExecutorStart({
        parent,
        executor: input?.executor,
        isModelAvailable,
        resolveCwd,
      });
      if (!startGate.ok) {
        return parent ? startGate : { ok: false, status: 404, error: 'Chat not found.', code: 'chat_not_found' };
      }
      const { validateWorkspaceWatcherParentDelegation } = await import('./workspace-watcher-delegation-guard.js');
      const watcherGate = validateWorkspaceWatcherParentDelegation({
        parentChatId,
        executor: input?.executor,
        assignment: normalizeDelegationAssignment(
          input?.assignment,
          input?.executionMode || parent.sdkMode,
        ),
        dataDir: resolveDataPath(),
      });
      if (!watcherGate.ok) {
        return watcherGate;
      }
      const cwd = startGate.cwd;
      const sourceKind = normalizeDelegationSourceKind(input?.sourceKind);
      const requestedExecutionMode = input?.executionMode;
      const requestedAssignment = normalizeDelegationAssignment(
        input?.assignment,
        requestedExecutionMode || parent.sdkMode,
      );
      const executionMode = resolveDelegationChildExecutionMode(
        requestedExecutionMode,
        requestedAssignment,
        parent.sdkMode,
      );
      const assignment = requestedAssignment;
      let planDoc = { revision: 0, contentHash: '', body: '' };
      let sourceHistorySeq = 0;
      let sourceCreatedAt = '';
      let sourceText = '';
      let sourceHash = '';
      if (sourceKind === 'message') {
        const found = resolveHistoryMessageSource(parentChatId, {
          historySeq: input.historySeq,
          contentHash: input.contentHash,
        });
        if (!found.ok) {
          return { ok: false, status: 409, error: found.error, code: found.code };
        }
        sourceHistorySeq = found.seq;
        const rec = found.rec && typeof found.rec === 'object'
          ? /** @type {Record<string, unknown>} */ (found.rec)
          : null;
        sourceCreatedAt = rec && typeof rec.createdAt === 'string' ? rec.createdAt : '';
        sourceText = found.text;
        sourceHash = found.contentHash;
      } else if (sourceKind === 'text') {
        sourceText = String(input?.taskText || '').trim();
        if (!sourceText) {
          return {
            ok: false,
            status: 400,
            error: 'task_text is required for a text delegation.',
            code: 'source_unavailable',
          };
        }
        sourceHash = hashDelegationContent(sourceText);
        const expected = String(input?.contentHash || '').trim();
        if (expected && expected !== sourceHash) {
          return {
            ok: false,
            status: 409,
            error: 'The task text changed. Refresh and try again.',
            code: 'source_changed',
          };
        }
      } else {
        planDoc = readChatPlanDocument({ cwd, chatId: parentChatId });
        if (!planDoc.body) {
          return { ok: false, status: 400, error: 'No complete plan is saved for this chat.', code: 'plan_missing' };
        }
        const expectedRevision = Number(input.planRevision);
        if (Number.isFinite(expectedRevision) && expectedRevision > 0 && planDoc.revision !== expectedRevision) {
          return {
            ok: false,
            status: 409,
            error: 'The plan changed. Refresh the preview and try again.',
            code: 'plan_revision_conflict',
            plan: planDoc,
          };
        }
        sourceHash = String(planDoc.contentHash || '').trim() || hashDelegationContent(planDoc.body);
        sourceText = '';
      }
      const transport = startGate.transport;
      const requestedModel = String(input?.executor?.model || '').trim();
      const model = startGate.model;
      const requestHash = buildDelegationRequestHash({
        parentChatId,
        sourceKind,
        sourceHistorySeq,
        planRevision: sourceKind === 'plan' ? planDoc.revision : 0,
        sourceHash,
        harness: transport,
        model: requestedModel,
        executionMode,
        assignment,
        extraInstructions: input.extraInstructions,
      });
      if (idempotencyKey) {
        const existing = findDelegationByIdempotencyKey(idempotencyKey);
        if (existing) {
          if (existing.parentChatId !== parentChatId) {
            return {
              ok: false,
              status: 409,
              error: 'Idempotency key belongs to another chat.',
              code: 'idempotency_conflict',
            };
          }
          const storedHash = String(existing.requestHash || '').trim();
          if (storedHash && storedHash !== requestHash) {
            return {
              ok: false,
              status: 409,
              error: 'Idempotency key was used with different parameters.',
              code: 'idempotency_conflict',
            };
          }
          return resumeExistingDelegation(existing, parent, {
            cwd,
            sourceKind,
            sourceText: existing.sourceText || sourceText,
            planMarkdown: existing.planMarkdown || planDoc.body,
            extraInstructions: existing.extraInstructions,
            executionMode: existing.executionMode || executionMode,
            assignment: existing.assignment || assignment,
          });
        }
      }
      const promptBuilt = buildDelegationExecutorPrompt({
        sourceKind,
        planMarkdown: planDoc.body,
        taskText: sourceText,
        parentChatId,
        sourceHistorySeq,
        workspaceFolder: cwd,
        extraInstructions: input.extraInstructions,
        executionMode,
        assignment,
      });
      if (!promptBuilt.ok) {
        return { ok: false, status: 400, error: promptBuilt.error, code: promptBuilt.code };
      }
      const reviewGate = assignment === 'review'
        ? assertReviewAdapterAllowed(transport)
        : { ok: true };
      if (!reviewGate.ok) return reviewGate;
      const workflowGate = inspectDelegationWorkflowStart({ parentChatId, assignment });
      if (!workflowGate.ok) return workflowGate;
      const widthBlock = parentWidthConflict({
        parentChatId,
        incomingAssignment: assignment,
        gate: 'start',
        workspaceFolder: cwd,
      });
      if (widthBlock) return widthBlock;
      const childChatId = randomUUID();
      const attemptId = randomUUID();
      const title = String(input.title || '').trim()
        || `${parent.title || 'Chat'} (${assignment === 'review' ? 'review' : sourceKind === 'plan' ? 'build' : 'task'})`;
      let record = createDelegationRecord({
        parentChatId,
        childChatId,
        workspaceFolder: cwd,
        planRevision: planDoc.revision,
        planHash: planDoc.contentHash,
        planMarkdown: planDoc.body,
        executor: {
          transport,
          model,
          options: input?.executor?.options && typeof input.executor.options === 'object'
            ? input.executor.options
            : {},
        },
        status: 'queued',
        attemptId,
        idempotencyKey,
        extraInstructions: input.extraInstructions,
        // Not part of requestHash on purpose: adding it must not invalidate
        // in-flight/replayed starts created before the field existed.
        pickReason,
        sourceKind,
        sourceChatId: parentChatId,
        sourceHistorySeq,
        sourceCreatedAt,
        sourceText,
        sourceHash,
        requestHash,
        executionMode,
        assignment,
      });
      runDelegationCrashHook('after-record-create', record);
      logDelegationEvent('queued', record);
      const startPromise = startDelegationChildRun(record, parent, {
        childChatId,
        title,
        transport,
        model,
        cwd,
        sourceKind,
        sourceText,
        planMarkdown: planDoc.body,
        extraInstructions: input.extraInstructions,
        executionMode,
        assignment,
        createdStatus: 201,
        replayed: false,
      });
      const pendingStart = getDelegationById(record.id) || record;
      if (input?.returnWhenStarting === true && pendingStart.status === 'starting') {
        // MCP callers have a short HTTP request deadline. The start routine
        // synchronously persists the child and transitions the delegation to
        // `starting` before awaiting adapter acceptance, so it is safe to
        // acknowledge here and let the existing status/wait APIs track it.
        void startPromise.catch((err) => {
          try {
            const latest = getDelegationById(record.id) || record;
            if (!isTerminalDelegationStatus(latest.status)) {
              finishDelegation(latest, {
                status: 'failed',
                error: err?.message || String(err),
              });
            }
          } catch {
            // The runtime worker will reconcile a persisted starting record.
          }
        });
        const starting = getDelegationById(record.id) || pendingStart;
        const child = loadChats().find((row) => row.id === childChatId) || null;
        return tagReviewUncertified({
          ok: true,
          status: 202,
          delegation: starting,
          chat: child,
          replayed: false,
        }, reviewGate.reviewUncertified);
      }
      const started = await startPromise;
      return tagReviewUncertified(started, reviewGate.reviewUncertified);
    });
  }

  /**
   * @param {object} existing
   * @param {object} parent
   * @param {object} ctx
   */
  async function resumeExistingDelegation(existing, parent, ctx) {
    const assignment = normalizeDelegationAssignment(
      existing.assignment || ctx.assignment,
      existing.executionMode || ctx.executionMode,
    );
    const executionMode = resolveDelegationChildExecutionMode(
      existing.executionMode || ctx.executionMode,
      assignment,
      parent.sdkMode,
    );
    if (existing.assignment !== assignment || existing.executionMode !== executionMode) {
      existing = updateDelegationRecord(existing.id, { assignment, executionMode }) || existing;
    }
    const childChatId = String(existing.childChatId || '').trim() || randomUUID();
    if (!String(existing.childChatId || '').trim()) {
      updateDelegationRecord(existing.id, { childChatId });
    }
    let child = loadChats().find((row) => row.id === childChatId) || null;
    if (!child) {
      const executor = existing.executor && typeof existing.executor === 'object' ? existing.executor : {};
      child = addChat(randomUUID(), `${parent.title || 'Chat'} (${assignment === 'review' ? 'review' : 'task'})`, parent.workspaceFile, parent.workspaceFolder, executor.model, {
        id: childChatId,
        agentTransport: executor.transport,
        sdkMode: executionMode,
        sdkUiMode: parent.sdkUiMode,
        todoId: parent.todoId,
        forkParentChatId: parent.id,
        forkKind: 'delegation',
        delegationParentChatId: parent.id,
        delegationId: existing.id,
        delegationAssignment: assignment,
        widgetInstallationId: parent.widgetInstallationId,
      });
    }
    appendRelatedChatHistoryLinks({
      parentChat: parent,
      childChat: child,
      reason: 'delegation',
    });
    linkChildChatToTodo(child, parent);
    if (!hasDelegationHistoryEvent(parent.id, { id: existing.id, event: 'started', attemptId: existing.attemptId })) {
      publishDelegationStatus(existing, 'started');
    }
    const replay = {
      ok: true,
      status: 200,
      delegation: getDelegationById(existing.id) || existing,
      chat: child,
      replayed: true,
      reviewUncertified: assignment === 'review'
        && assertReviewAdapterAllowed(existing.executor?.transport).reviewUncertified === true,
    };
    if (hasInFlightDelegationStart(existing.id)) return replay;
    const live = probeChatRunLiveness({ chatId: childChatId, runId: existing.runId });
    if (live.busy) return replay;
    if (existing.status !== 'queued' && existing.status !== 'starting') return replay;
    const resumeGate = inspectQueuedDelegationResume(existing, parent, ctx, assignment);
    if (!resumeGate.ok) return resumeGate;
    const resumed = await startDelegationChildRun(getDelegationById(existing.id) || existing, parent, {
      childChatId,
      title: child.title,
      transport: existing.executor?.transport,
      model: existing.executor?.model,
      cwd: ctx.cwd,
      sourceKind: ctx.sourceKind,
      sourceText: ctx.sourceText,
      planMarkdown: ctx.planMarkdown,
      extraInstructions: ctx.extraInstructions,
      executionMode,
      assignment,
      createdStatus: 200,
      replayed: true,
    });
    return tagReviewUncertified(resumed, resumeGate.reviewUncertified);
  }

  /**
   * Replaying a queued/starting job must pass the same gates as a new start.
   *
   * @param {object} existing
   * @param {object} parent
   * @param {object} ctx
   * @param {string} assignment
   */
  function inspectQueuedDelegationResume(existing, parent, ctx, assignment) {
    const reviewGate = assignment === 'review'
      ? assertReviewAdapterAllowed(existing.executor?.transport)
      : { ok: true };
    if (!reviewGate.ok) return reviewGate;
    const workflowGate = inspectDelegationWorkflowStart({
      parentChatId: parent.id,
      assignment,
    });
    if (!workflowGate.ok) return workflowGate;
    const widthBlock = parentWidthConflict({
      parentChatId: parent.id,
      incomingAssignment: assignment,
      resumeDelegationId: existing.id,
      gate: 'start',
      workspaceFolder: ctx.cwd || existing.workspaceFolder,
    });
    if (widthBlock) return widthBlock;
    return { ok: true, reviewUncertified: reviewGate.reviewUncertified === true };
  }

  /**
   * @param {object} record
   * @param {object} parent
   * @param {object} ctx
   */
  async function startDelegationChildRun(record, parent, ctx) {
    const promptBuilt = buildDelegationExecutorPrompt({
      sourceKind: ctx.sourceKind,
      planMarkdown: ctx.planMarkdown,
      taskText: ctx.sourceText,
      parentChatId: parent.id,
      delegationId: record.id,
      sourceHistorySeq: record.sourceHistorySeq,
      workspaceFolder: ctx.cwd,
      extraInstructions: ctx.extraInstructions,
      executionMode: ctx.executionMode,
      assignment: ctx.assignment,
    });
    if (!promptBuilt.ok) {
      const failed = finishDelegation(record, {
        status: 'failed',
        error: promptBuilt.error,
      });
      return { ok: false, status: 400, error: promptBuilt.error, code: promptBuilt.code, delegation: failed };
    }
    let child = loadChats().find((row) => row.id === ctx.childChatId) || null;
    if (!child) {
      try {
        child = addChat(randomUUID(), ctx.title, parent.workspaceFile, parent.workspaceFolder, ctx.model, {
          id: ctx.childChatId,
          agentTransport: ctx.transport,
          sdkMode: ctx.executionMode,
          sdkUiMode: parent.sdkUiMode,
          todoId: parent.todoId,
          forkParentChatId: parent.id,
          forkKind: 'delegation',
          delegationParentChatId: parent.id,
          delegationId: record.id,
          delegationAssignment: ctx.assignment,
          widgetInstallationId: parent.widgetInstallationId,
        });
      } catch (err) {
        const failed = finishDelegation(record, {
          status: 'failed',
          error: err?.message || String(err),
        });
        return { ok: false, status: 500, error: 'Could not create the executor chat.', code: 'child_create_failed', delegation: failed };
      }
    }
    appendRelatedChatHistoryLinks({
      parentChat: parent,
      childChat: child,
      reason: 'delegation',
    });
    linkChildChatToTodo(child, parent);
    record = transition(record, 'starting', {
      childChatId: child.id,
      acceptRequestId: record.acceptRequestId || randomUUID(),
      acceptState: 'pending',
    }) || record;
    publishDelegationStatus(record, 'started');
    rememberInFlightStart(record.id, { attemptId: record.attemptId, childChatId: child.id });
    try {
      const started = await startChatRun({
        chatId: child.id,
        prompt: promptBuilt.prompt,
        mode: ctx.executionMode,
        requestId: record.acceptRequestId || record.attemptId,
        displayText: promptBuilt.displayText,
        deps: {
          workspaceDirForAgent: deps.workspaceDirForAgent,
          todoSyncDataDir: deps.dataDir || '',
          ...(deps.chatRunDeps || {}),
          delegationId: record.id,
          attemptId: record.attemptId,
          assignment: ctx.assignment,
        },
      });
      runDelegationCrashHook('after-prompt-accept', record);
      const latest = await stopAcceptedRunIfObsolete({
        latest: getDelegationById(record.id) || record,
        started,
        childChatId: child.id,
      });
      if (isTerminalDelegationStatus(latest.status)) {
        const failed = latest.status === 'failed';
        logDelegationEvent('start-already-terminal', latest);
        return {
          ok: !failed,
          status: failed ? 500 : (ctx.createdStatus || 201),
          error: failed ? (latest.error || 'Could not start the executor.') : undefined,
          code: failed ? 'start_failed' : undefined,
          delegation: latest,
          chat: child,
          replayed: ctx.replayed === true,
        };
      }
      if (String(latest.attemptId || '') !== String(record.attemptId || '')) {
        return {
          ok: true,
          status: ctx.createdStatus || 201,
          delegation: latest,
          chat: child,
          replayed: ctx.replayed === true,
        };
      }
      const running = transition(latest, 'running', {
        runId: started.runId,
        startedAt: latest.startedAt || new Date().toISOString(),
        runningAt: new Date().toISOString(),
        acceptState: 'accepted',
      }, {
        expectedRevision: latest.revision,
        expectedAttemptId: latest.attemptId,
      });
      logDelegationEvent('running', running || latest);
      return {
        ok: true,
        status: ctx.createdStatus || 201,
        delegation: running || latest,
        chat: child,
        replayed: ctx.replayed === true,
      };
    } catch (err) {
      const latest = await stopAcceptedRunIfObsolete({
        latest: getDelegationById(record.id) || record,
        childChatId: child.id,
      });
      if (isTerminalDelegationStatus(latest.status)) {
        return {
          ok: false,
          status: 500,
          error: latest.error || err?.message || 'Could not start the executor.',
          code: err?.code || 'start_failed',
          delegation: latest,
        };
      }
      const failed = finishDelegation(latest, {
        status: 'failed',
        error: err?.message || String(err),
      });
      try {
        await cancelChatRun({ chatId: child.id });
      } catch {
        // Best-effort stop after a failed accept path.
      }
      return {
        ok: false,
        status: 500,
        error: failed?.error || 'Could not start the executor.',
        code: err?.code || 'start_failed',
        delegation: failed,
      };
    } finally {
      forgetInFlightStart(record.id);
    }
  }

  /**
   * @param {string} id
   */
  async function cancel(id) {
    const current = getDelegationById(id);
    if (!current) return { ok: false, status: 404, error: 'Delegation not found.', code: 'not_found' };
    const fence = readDelegationCancelFence(current);
    if (isTerminalDelegationStatus(current.status)) {
      const stopping = Boolean(String(current.runStoppingAt || '').trim())
        || isChatRunStillActive({ chatId: fence.childChatId, runId: fence.runId });
      if (!stopping) return { ok: true, status: 200, delegation: current };
      try {
        await cancelChatRun({ chatId: fence.childChatId, runId: fence.runId });
      } catch {
        // Keep the terminal result; stop is best-effort.
      }
      const latest = getDelegationById(id) || current;
      const stale = staleDelegationCancelResult(latest, fence);
      if (stale) return stale;
      const live = probeChatRunLiveness({ chatId: fence.childChatId, runId: fence.runId });
      if (live.known !== true || live.busy === true) {
        return { ok: true, status: 202, pending: true, delegation: latest };
      }
      const released = releaseDelegationRunSlot(latest);
      return { ok: true, status: 200, delegation: released };
    }
    const cancelling = current.status === 'cancelling'
      ? current
      : transition(current, 'cancelling', {}, { expectedAttemptId: fence.attemptId });
    if (!cancelling) {
      return { ok: false, status: 409, error: 'This delegation cannot be stopped.', code: 'cancel_blocked' };
    }
    const staleBeforeAdapter = staleDelegationCancelResult(cancelling, fence);
    if (staleBeforeAdapter) return staleBeforeAdapter;
    publishDelegationStatus(cancelling, 'cancelling');
    let cancelFailed = false;
    try {
      await cancelChatRun({ chatId: fence.childChatId, runId: fence.runId });
    } catch {
      cancelFailed = true;
    }
    const latest = getDelegationById(id) || cancelling;
    const staleAfterAdapter = staleDelegationCancelResult(latest, fence);
    if (staleAfterAdapter) return staleAfterAdapter;
    const live = probeChatRunLiveness({ chatId: fence.childChatId, runId: fence.runId });
    const stillBusy = cancelFailed || live.busy === true || live.known !== true;
    const startInFlight = hasInFlightDelegationStart(id);
    if (stillBusy || startInFlight) {
      return {
        ok: true,
        status: 202,
        pending: true,
        delegation: latest,
      };
    }
    const cancelled = finishDelegation(latest, {
      status: 'cancelled',
      attemptId: fence.attemptId,
      runId: fence.runId,
    });
    return { ok: true, status: 200, delegation: cancelled };
  }

  /**
   * @param {string} id
   * @param {{ reason?: string }} [input]
   */
  function acknowledge(id, input = {}) {
    const current = getDelegationById(id);
    if (!current) return { ok: false, status: 404, error: 'Delegation not found.', code: 'not_found' };
    const reason = String(input.reason || 'reviewed').trim() || 'reviewed';
    const status = current.status;
    const isWaiting = status === 'waiting_for_input';
    const isTerminalAttention = status === 'completed' || status === 'failed' || status === 'interrupted';
    if (reason === 'open_child') {
      if (!isWaiting) return { ok: true, status: 200, delegation: current, skipped: true };
      const next = updateDelegationRecord(current.id, { acknowledgedAt: new Date().toISOString() });
      return { ok: true, status: 200, delegation: next };
    }
    if (!isWaiting && !isTerminalAttention) {
      return { ok: true, status: 200, delegation: current, skipped: true };
    }
    const next = updateDelegationRecord(current.id, {
      acknowledgedAt: new Date().toISOString(),
      acknowledgedAttemptId: current.attemptId || '',
      unverified: isTerminalAttention ? false : current.unverified,
    });
    if (isTerminalAttention && next) publishDelegationStatus(next, 'acknowledged');
    return { ok: true, status: 200, delegation: next || current };
  }

  /**
   * Base model id used for the anti-bias check. `''` for missing/Auto values
   * so an unknown parent model skips the check instead of blocking a rating.
   *
   * @param {unknown} value
   * @returns {string}
   */
  function baseModelIdOf(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const decoded = decodeModelValue(raw);
    const id = String(decoded.modelId || '').trim().toLowerCase();
    return !id || id === 'auto' ? '' : id;
  }

  /**
   * Anti-bias: a parent must not rate a job whose executor runs the parent's
   * own base model (the rating would be self-confirming). Comparison is on the
   * base id only, so the same model on another harness is still denied. The
   * check applies to `parent` ratings; the app-wide `user` rater has no model.
   *
   * @param {object} row
   * @returns {{ ok: true } | { ok: false, status: number, code: string, error: string }}
   */
  function inspectParentRatingBias(row) {
    const parent = loadChats().find((chat) => chat.id === row.parentChatId);
    const parentBase = baseModelIdOf(parent?.model);
    const executorBase = baseModelIdOf(row.executor?.model);
    if (!parentBase || !executorBase || parentBase !== executorBase) return { ok: true };
    return {
      ok: false,
      status: 409,
      code: 'self_model_rating_denied',
      error: 'A parent cannot rate a job on its own base model. Rate a job run by another model.',
    };
  }

  /**
   * Store one rating. The rater comes from the transport (MCP = parent, card
   * HTTP = user) and is validated here; callers must not forward an
   * input-supplied rater. Ratings are immutable per (job, rater): an identical
   * payload replays as success, a changed one conflicts.
   *
   * @param {string} id
   * @param {{ rater?: unknown, score?: unknown, tags?: unknown, note?: unknown }} input
   * @returns {{ ok: boolean, status: number, code?: string, error?: string,
   *   replayed?: boolean, rating?: object | null, delegation?: object }}
   */
  function rate(id, input = {}) {
    const current = getDelegationById(id);
    if (!current) return { ok: false, status: 404, error: 'Delegation not found.', code: 'not_found' };
    if (!isTerminalDelegationStatus(current.status)) {
      return {
        ok: false,
        status: 409,
        error: 'Only a finished job can be rated.',
        code: 'not_terminal',
      };
    }
    const rater = normalizeDelegationRatingRater(input.rater);
    if (!rater) {
      return {
        ok: false,
        status: 400,
        error: `rater must be one of: ${DELEGATION_RATING_RATERS.join(', ')}.`,
        code: 'invalid_rater',
      };
    }
    const payload = normalizeDelegationRatingPayload(input);
    if (!payload.ok) return { ok: false, status: payload.status, error: payload.error, code: payload.code };
    const fingerprint = fingerprintDelegationRating(payload.value);
    const existing = findDelegationRating(current.id, rater);
    if (existing) {
      if (String(existing.fingerprint || '') === fingerprint) {
        return { ok: true, status: 200, replayed: true, rating: existing, delegation: current };
      }
      return {
        ok: false,
        status: 409,
        error: 'This job already has a rating from this rater. Ratings are immutable.',
        code: 'idempotency_conflict',
      };
    }
    if (rater === 'parent') {
      const bias = inspectParentRatingBias(current);
      if (!bias.ok) return { ...bias, delegation: current };
    }
    const executor = current.executor && typeof current.executor === 'object' ? current.executor : {};
    const model = String(executor.model || '').trim();
    const record = {
      delegationId: current.id,
      parentChatId: String(current.parentChatId || '').trim(),
      harness: String(executor.transport || '').trim().toLowerCase(),
      model: model ? baseModelIdOf(model) : '',
      role: delegationPersistedRole(current),
      rater,
      score: payload.value.score,
      tags: payload.value.tags,
      note: payload.value.note,
      ts: new Date().toISOString(),
      fingerprint,
    };
    if (!appendDelegationRating(record)) {
      return {
        ok: false,
        status: 500,
        error: 'Could not persist the rating.',
        code: 'rating_write_failed',
      };
    }
    let latest = getDelegationById(current.id) || current;
    if (rater === 'user') {
      // The card reads its rating from the history payload, so the user rating
      // publishes a (metadata-only) card event; a parent rating does not.
      const published = publishDelegationStatus(latest, 'rated');
      latest = published || latest;
    }
    return {
      ok: true,
      status: 200,
      replayed: false,
      rating: record,
      delegation: getDelegationById(current.id) || latest,
    };
  }

  /**
   * @param {string} chatId
   */
  async function cancelForDeletedChat(chatId) {
    const id = String(chatId || '').trim();
    if (!id) return { ok: true };
    const rows = loadDelegations().filter((row) => {
      if (row.childChatId !== id && row.parentChatId !== id) return false;
      return isActiveDelegationStatus(row.status);
    });
    for (const row of rows) {
      const result = await cancel(row.id);
      if (!result.ok) {
        return {
          ok: false,
          status: 409,
          error: result.error || 'Could not stop the executor run.',
          code: result.code || 'cancel_failed',
        };
      }
      if (!result.pending) continue;
      await new Promise((resolve) => setTimeout(resolve, 400));
      if (isChatRunStillActive({ chatId: row.childChatId, runId: row.runId })) {
        return {
          ok: false,
          status: 409,
          error: 'Could not stop the executor run.',
          code: 'cancel_pending',
        };
      }
      const latest = getDelegationById(row.id);
      if (latest && isActiveDelegationStatus(latest.status)) {
        finishDelegation(latest, { status: 'cancelled' });
      }
    }
    return { ok: true };
  }

  /**
   * @param {string} id
   */
  async function retry(id) {
    const wantedId = String(id || '').trim();
    if (!wantedId) return { ok: false, status: 404, error: 'Delegation not found.', code: 'not_found' };
    const existingRetry = retryJobInFlight.get(wantedId);
    if (existingRetry) return existingRetry;
    let settle;
    const pending = new Promise((resolve, reject) => {
      settle = { resolve, reject };
    });
    retryJobInFlight.set(wantedId, pending);
    retryUnlocked(wantedId).then(settle.resolve, settle.reject).finally(() => {
      if (retryJobInFlight.get(wantedId) === pending) retryJobInFlight.delete(wantedId);
    });
    return pending;
  }

  /**
   * @param {string} id
   */
  async function retryUnlocked(id) {
    if (!isDelegationRuntimeAcceptingWork()) {
      return {
        ok: false,
        status: 503,
        error: 'Delegation runtime is not ready to accept new jobs.',
        code: 'runtime_not_ready',
        state: getDelegationLifecycleState(),
      };
    }
    const current = getDelegationById(id);
    if (!current) return { ok: false, status: 404, error: 'Delegation not found.', code: 'not_found' };
    return withParentLock(current.parentChatId, async () => {
      const latest = getDelegationById(id);
      if (!latest) return { ok: false, status: 404, error: 'Delegation not found.', code: 'not_found' };
      if (isActiveDelegationStatus(latest.status) || isDelegationSlotOccupied(latest)) {
        const blocker = inspectDelegationSlot(latest);
        return slotConflict(blocker, 'still_active', 'This delegation is still active.');
      }
      const interruptedGate = inspectInterruptedRetryGate(latest);
      if (!interruptedGate.ok) return interruptedGate;
      const parent = loadChats().find((row) => row.id === latest.parentChatId);
      const startGate = validateDelegationExecutorStart({
        parent,
        executor: latest.executor,
        isModelAvailable,
        resolveCwd,
      });
      if (!startGate.ok) return startGate;
      const previousAttemptSummary = [latest.report, latest.error].filter(Boolean).join('\n');
      const assignment = normalizeDelegationAssignment(latest.assignment, latest.executionMode);
      const executionMode = resolveDelegationChildExecutionMode(
        latest.executionMode,
        assignment,
        parent.sdkMode,
      );
      const promptBuilt = buildDelegationExecutorPrompt({
        sourceKind: latest.sourceKind,
        planMarkdown: latest.planMarkdown,
        taskText: latest.sourceText,
        parentChatId: latest.parentChatId,
        delegationId: latest.id,
        sourceHistorySeq: latest.sourceHistorySeq,
        workspaceFolder: startGate.cwd || latest.workspaceFolder,
        extraInstructions: latest.extraInstructions,
        previousAttemptSummary,
        executionMode,
        assignment,
      });
      if (!promptBuilt.ok) {
        return { ok: false, status: 400, error: promptBuilt.error, code: promptBuilt.code };
      }
      const reviewGate = assignment === 'review'
        ? assertReviewAdapterAllowed(startGate.transport)
        : { ok: true };
      if (!reviewGate.ok) return reviewGate;
      const workflowGate = inspectDelegationWorkflowStart({
        parentChatId: latest.parentChatId,
        assignment,
      });
      if (!workflowGate.ok) return workflowGate;
      const widthBlock = parentWidthConflict({
        parentChatId: latest.parentChatId,
        incomingAssignment: latest.assignment,
        resumeDelegationId: latest.id,
        gate: 'retry',
        workspaceFolder: startGate.cwd || latest.workspaceFolder,
      });
      if (widthBlock) return widthBlock;
      const attemptId = randomUUID();
      const acceptRequestId = randomUUID();
      const archived = snapshotDelegationAttempt(latest);
      const usedServerRestartContinuation = normalizeDelegationInterruptCode(latest.interruptCode) === DELEGATION_INTERRUPT_SERVER_RESTART;
      const starting = transition(latest, 'starting', {
        executionMode,
        assignment,
        attemptId,
        acceptRequestId,
        acceptState: 'pending',
        runId: '',
        finishedAt: '',
        error: '',
        report: '',
        historyDeliveredAt: '',
        reportDeliveredAt: '',
        reportDeliveryId: '',
        taskOutcome: 'unspecified',
        interruptCode: '',
        interruptContinuedAt: usedServerRestartContinuation
          ? new Date().toISOString()
          : String(latest.interruptContinuedAt || '').trim(),
        runStoppingAt: '',
        finalReportAcceptedAt: '',
        finalReportAttemptId: '',
        finalReportRunId: '',
        unverified: true,
        acknowledgedAt: '',
        acknowledgedAttemptId: '',
        attempts: [...(Array.isArray(latest.attempts) ? latest.attempts : []), archived],
      });
      logDelegationEvent('retry', starting || latest, { attemptId });
      rememberInFlightStart(latest.id, { attemptId, childChatId: latest.childChatId });
      try {
        const started = await startChatRun({
          chatId: latest.childChatId,
          prompt: promptBuilt.prompt,
          mode: executionMode,
          requestId: acceptRequestId,
          displayText: promptBuilt.displayText,
          deps: {
            workspaceDirForAgent: deps.workspaceDirForAgent,
            todoSyncDataDir: deps.dataDir || '',
            ...(deps.chatRunDeps || {}),
            delegationId: latest.id,
            attemptId,
            assignment,
          },
        });
        runDelegationCrashHook('after-prompt-accept', starting || latest);
        const afterStart = await stopAcceptedRunIfObsolete({
          latest: getDelegationById(latest.id) || starting || latest,
          started,
          childChatId: latest.childChatId,
        });
        if (isTerminalDelegationStatus(afterStart.status)) {
          const failed = afterStart.status === 'failed';
          return tagReviewUncertified({
            ok: !failed,
            status: failed ? 500 : 200,
            error: failed ? (afterStart.error || 'Retry failed.') : undefined,
            code: failed ? 'start_failed' : undefined,
            delegation: afterStart,
          }, reviewGate.reviewUncertified);
        }
        if (String(afterStart.attemptId || '') !== attemptId) {
          return tagReviewUncertified({ ok: true, status: 200, delegation: afterStart }, reviewGate.reviewUncertified);
        }
        const running = transition(afterStart, 'running', {
          runId: started.runId,
          startedAt: new Date().toISOString(),
          runningAt: new Date().toISOString(),
          acceptState: 'accepted',
        }, {
          expectedRevision: afterStart.revision,
          expectedAttemptId: attemptId,
        });
        publishDelegationStatus(running || afterStart, 'retry');
        return tagReviewUncertified({ ok: true, status: 200, delegation: running || afterStart }, reviewGate.reviewUncertified);
      } catch (err) {
        const afterErr = await stopAcceptedRunIfObsolete({
          latest: getDelegationById(latest.id) || latest,
          childChatId: latest.childChatId,
        });
        if (isTerminalDelegationStatus(afterErr.status)) {
          return tagReviewUncertified({
            ok: false,
            status: 500,
            error: afterErr.error || err?.message || 'Retry failed.',
            code: err?.code || 'start_failed',
            delegation: afterErr,
          }, reviewGate.reviewUncertified);
        }
        const failed = finishDelegation(afterErr, {
          status: 'failed',
          error: err?.message || String(err),
        });
        try {
          await cancelChatRun({ chatId: latest.childChatId });
        } catch {
          // Best-effort stop after a failed retry accept path.
        }
        return tagReviewUncertified({
          ok: false,
          status: 500,
          error: failed?.error || 'Retry failed.',
          code: err?.code || 'start_failed',
          delegation: failed,
        }, reviewGate.reviewUncertified);
      } finally {
        forgetInFlightStart(latest.id);
      }
    });
  }

  return {
    createAndStart,
    cancel,
    retry,
    acknowledge,
    rate,
    cancelForDeletedChat,
    getById: getDelegationById,
    listForParent: listDelegationsForParent,
  };
}

/**
 * After a process restart, do not silently resume work.
 * Unconfirmed active jobs become interrupted. Missing history cards are retried.
 *
 * Liveness comes from `probeChatRunLiveness`: an unknown state (missing
 * adapter, null/undefined getState, adapter exception) is never proof that the
 * run ended, so the slot stays occupied. Confirmed idle running/waiting jobs
 * get the same 60s orphan grace as the worker.
 */
export async function reconcileDelegationsOnBoot() {
  return enqueueDelegationStoreWork(async () => {
    const now = Date.now();
    for (const row of loadDelegations()) {
      let current = row;
      if (isTerminalDelegationStatus(current.status) && String(current.runStoppingAt || '').trim()) {
        current = releaseDelegationRunSlot(current) || current;
      }
      await flushDelegationOutboxUnlocked(current);
      const live = probeChatRunLiveness({ chatId: current.childChatId, runId: current.runId });
      const known = live.known === true;
      const busy = live.busy === true;
      const age = now - Date.parse(String(row.lastTransitionAt || row.startedAt || row.createdAt || ''));
      const timedOut = Number.isFinite(age) && age >= DELEGATION_STARTING_TIMEOUT_MS;

      if (row.status === 'starting') {
        if (hasDurableAttemptEndProof(row)) {
          const repaired = finishDelegation(row, {
            status: 'completed',
            report: row.report,
            enqueueParentReply: false,
          });
          if (repaired) {
            if (busy) updateDelegationRecord(repaired.id, { runStoppingAt: new Date().toISOString() });
            else releaseDelegationRunSlot(repaired);
          }
          continue;
        }
        if (busy) continue;
        // The starting timeout needs a confirmed idle adapter in boot too.
        if (known && timedOut) {
          const finished = finishDelegation(row, {
            status: 'interrupted',
            interruptCode: DELEGATION_INTERRUPT_STARTING_TIMEOUT,
            error: STARTING_TIMEOUT_ERROR,
            enqueueParentReply: true,
          });
          await flushDelegationOutboxUnlocked(finished || row);
          continue;
        }
        // Confirmed idle adapter: the restart leaves the start unconfirmed.
        // Unknown liveness (missing run id or not) keeps the slot because the
        // adapter may have accepted a run before restart.
        if (known) {
          const finished = finishDelegation(row, {
            status: 'interrupted',
            interruptCode: DELEGATION_INTERRUPT_SERVER_RESTART,
            error: SERVER_RESTART_ERROR,
            enqueueParentReply: true,
          });
          await flushDelegationOutboxUnlocked(finished || row);
        }
        continue;
      }

      if (row.status === 'cancelling') {
        const cancelAge = now - Date.parse(String(row.lastTransitionAt || row.createdAt || ''));
        if (Number.isFinite(cancelAge) && cancelAge >= DELEGATION_CANCELLING_TIMEOUT_MS) {
          if (busy || !known) {
            updateDelegationRecord(row.id, {
              errorAppend: [{
                at: new Date(now).toISOString(),
                code: 'cancel_timeout',
                message: busy
                  ? 'Stop requested, but the executor is still running.'
                  : 'Stop requested, but the executor state is unknown.',
                attemptId: row.attemptId,
              }],
            });
            continue;
          }
          finishDelegation(row, { status: 'cancelled', error: row.error || 'Stop timed out; executor was idle.' });
        }
        continue;
      }

      if (isActiveDelegationStatus(row.status)) {
        if (hasDurableAttemptEndProof(row)) {
          const repaired = finishDelegation(row, {
            status: 'completed',
            report: row.report,
            enqueueParentReply: false,
          });
          if (repaired) {
            if (busy) updateDelegationRecord(repaired.id, { runStoppingAt: new Date().toISOString() });
            else releaseDelegationRunSlot(repaired);
          }
          continue;
        }
        if (busy) continue;
        // Unknown liveness is not proof of a lost run: keep the occupied slot.
        if (!known) continue;
        if (row.status === 'running' || row.status === 'waiting_for_input') {
          const observed = String(row.idleObservedAt || '').trim();
          if (!observed) {
            updateDelegationRecord(row.id, { idleObservedAt: new Date(now).toISOString() });
            continue;
          }
          if (now - Date.parse(observed) < DELEGATION_RUNNING_ORPHAN_GRACE_MS) continue;
          const finished = finishDelegation(row, {
            status: 'interrupted',
            interruptCode: DELEGATION_INTERRUPT_RUNNING_ORPHAN,
            error: RUNNING_ORPHAN_ERROR,
            enqueueParentReply: true,
          });
          releaseDelegationRunSlot(finished || row);
          await flushDelegationOutboxUnlocked(finished || row);
          continue;
        }
        // queued and other pre-run active states: the restart makes the start
        // unconfirmed.
        const finished = finishDelegation(row, {
          status: 'interrupted',
          interruptCode: DELEGATION_INTERRUPT_SERVER_RESTART,
          error: SERVER_RESTART_ERROR,
          enqueueParentReply: true,
        });
        await flushDelegationOutboxUnlocked(finished || row);
        continue;
      }

      if (isTerminalDelegationStatus(row.status) && !String(row.historyDeliveredAt || '').trim()) {
        publishDelegationStatus(row, 'finished');
      }
    }
    reconcileMailboxOnBoot();
    for (const chat of loadChats()) {
      await drainChatMailbox(chat.id);
    }
  });
}

export const delegationService = createDelegationService();
