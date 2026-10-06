/**
 * Map harness room events onto the active delegation record.
 */

import {
  finishDelegation,
  flushDelegationOutbox,
  isDelegationEventCurrent,
  publishDelegationStatus,
} from './delegation-service.js';
import { drainChatMailbox } from './delegation-mailbox.js';
import { canTransitionDelegationStatus, isActiveDelegationStatus } from './delegation-status.js';
import {
  getDelegationById,
  updateDelegationRecord,
} from './persist/delegations-persist.js';
import { loadChats, updateChat } from './persist/chats-persist.js';
import { getSdkToolCallName } from './sdk/sdk-plan-guard.js';
import { readReportedTokenCount } from './sdk/sdk-context-advisory.js';
import {
  buildRunMetrics,
  captureGitSnapshot,
  diffGitSnapshots,
  isExecuteAssignment,
} from './delegation-metrics.js';
import {
  applyFinalReportQuietStopToPayload,
  applyFinalReportQuietStopToSdkEvent,
  normalizeSdkRunStatus,
} from './sdk/sdk-run-outcome.js';
import { DELEGATION_ADAPTER_INCOMPLETE_CODE } from './delegation-adapter-error.js';
import { isIncompleteDelegationReport } from './delegation-verdict.js';

/**
 * @param {any} room
 * @param {Record<string, unknown>} payload
 * @returns {Promise<unknown> | void}
 */
export function noteDelegationRoomEvent(room, payload) {
  if (!payload || typeof payload !== 'object') return;
  const type = typeof payload.type === 'string' ? payload.type : '';
  const delegationId = String(room?.delegationId || '').trim();
  const current = delegationId ? getDelegationById(delegationId) : null;
  const eventRunId = typeof payload.runId === 'string' ? payload.runId : '';
  const isCurrent = current && isDelegationEventCurrent(current, eventRunId, room.delegationAttemptId);
  /** @type {Promise<unknown> | null} */
  let pingParent = null;
  if (current && isCurrent) {
    if (type === 'sdkEvent') {
      noteInputRequest(room, current, payload.event);
    } else if (type === 'opencodeQuestionResolved' || type === 'opencodePermissionResolved') {
      if (current.status === 'waiting_for_input' && canTransitionDelegationStatus(current.status, 'running')) {
        const running = updateDelegationRecord(current.id, { status: 'running' });
        if (running) publishDelegationStatus(running, 'running');
      }
    } else if (type === 'sdkPromptStarted') {
      // Snapshot the working tree before the run edits it, so the finish diff
      // attributes only this run's changes (git works for every harness, not
      // just the SDK). Baseline lives on the room; a mid-run restart loses it
      // and the git metrics simply stay null ("no data", never an error).
      captureRoomDelegationGitBase(room, current);
    } else if (type === 'sdkRunFinished') {
      const status = normalizeSdkRunStatus(payload.status);
      const assistantText = String(room._currentRunAssistantText || '').trim();
      const deferFinish = shouldDeferDelegationRunFinish(room, current);
      let finished = null;
      // Collect this run's efficiency metrics once, attached to whichever
      // terminal finish actually writes. A deferred finish keeps nothing for
      // the later (re-bound) run to record.
      const finishMetrics = deferFinish ? null : collectRoomDelegationMetrics(room, current);
      if (status === 'completed') {
        if (!deferFinish) {
          const isReview = String(current.assignment || '').trim() === 'review';
          const incomplete = isReview && isIncompleteDelegationReport(assistantText);
          finished = finishDelegation(current, {
            status: incomplete ? 'failed' : 'completed',
            report: assistantText,
            error: incomplete
              ? `[${DELEGATION_ADAPTER_INCOMPLETE_CODE}] Review ended without a VERDICT report.`
              : '',
            attemptId: room.delegationAttemptId,
            enqueueParentReply: true,
            metrics: finishMetrics,
          });
          room.serverHold = false;
        }
      } else if (status === 'cancelled') {
        if (!deferFinish) {
          finished = finishDelegation(current, {
            status: 'cancelled',
            report: assistantText,
            attemptId: room.delegationAttemptId,
            metrics: finishMetrics,
          });
          room.serverHold = false;
        }
      } else if (status === 'error' || status === 'failed') {
        if (!deferFinish) {
          const error = typeof payload.lastErrorMessage === 'string'
            ? payload.lastErrorMessage
            : typeof payload.result === 'string' ? payload.result : '';
          const errorCode = String(payload.lastErrorCode || '').trim();
          finished = finishDelegation(current, {
            status: 'failed',
            error: errorCode === 'adapter_timeout' && error && !error.includes('adapter_timeout')
              ? `[adapter_timeout] ${error}`
              : error,
            report: assistantText,
            attemptId: room.delegationAttemptId,
            enqueueParentReply: true,
            metrics: finishMetrics,
          });
          room.serverHold = false;
        }
      }
      if (finished) pingParent = flushDelegationOutbox(finished);
    }
  }
  if (type === 'sdkRunFinished') {
    syncRoomDelegationAssignment(room);
    const chatId = String(room?.chatId || '').trim();
    if (chatId) {
      const drain = drainChatMailbox(chatId);
      return pingParent ? Promise.all([pingParent, drain]) : drain;
    }
  }
  return pingParent || undefined;
}

/**
 * @param {any} room
 * @returns {{ jobStatus: string, finalReportAcceptedAt: string, finalReportRunId: string }}
 */
function readDelegationQuietStopMeta(room) {
  let id = String(room?.delegationId || '').trim();
  if (!id) {
    const chatId = String(room?.chatId || '').trim();
    if (chatId) {
      const chat = loadChats().find((row) => row.id === chatId);
      id = String(chat?.delegationId || '').trim();
    }
  }
  if (!id) return { jobStatus: '', finalReportAcceptedAt: '', finalReportRunId: '' };
  const row = getDelegationById(id);
  return {
    jobStatus: String(row?.status || '').trim(),
    finalReportAcceptedAt: String(row?.finalReportAcceptedAt || '').trim(),
    finalReportRunId: String(row?.finalReportRunId || row?.runId || '').trim(),
  };
}

/**
 * Quiet leftover-run cancel after an accepted `final_report`. Mutates payload.
 *
 * @param {any} room
 * @param {Record<string, unknown> | null | undefined} payload
 * @returns {Record<string, unknown> | null | undefined}
 */
export function applyDelegationFinalReportRunFinished(room, payload) {
  if (!payload || payload.type !== 'sdkRunFinished') return payload;
  return applyFinalReportQuietStopToPayload(payload, readDelegationQuietStopMeta(room));
}

/**
 * Quiet leftover-run `status` cancel after an accepted `final_report`.
 *
 * @param {any} room
 * @param {Record<string, unknown> | null | undefined} payload
 * @returns {Record<string, unknown> | null | undefined}
 */
export function applyDelegationFinalReportSdkEvent(room, payload) {
  if (!payload || payload.type !== 'sdkEvent') return payload;
  const event = payload.event;
  if (!event || typeof event !== 'object') return payload;
  applyFinalReportQuietStopToSdkEvent(event, {
    ...readDelegationQuietStopMeta(room),
    runId: event.run_id || event.runId || room?.lastRunId,
  });
  return payload;
}

/**
 * @param {any} room
 * @param {object} current
 * @param {unknown} event
 */
/**
 * @param {any} room
 * @returns {boolean}
 */
function roomHasPendingOpenCodeUserInput(room) {
  if (!room || typeof room !== 'object') return false;
  const questions = room._pendingOpenCodeQuestions instanceof Map && room._pendingOpenCodeQuestions.size > 0;
  const permissions = room._pendingOpenCodePermissions instanceof Map && room._pendingOpenCodePermissions.size > 0;
  return questions || permissions;
}

/**
 * @param {any} room
 * @param {object} current
 * @returns {boolean}
 */
function shouldDeferDelegationRunFinish(room, current) {
  if (current.status === 'waiting_for_input') return true;
  // Codex review aborted one command and already queued a follow-up prompt.
  if (room?._codexReviewGuardResumeQueued === true) return true;
  return roomHasPendingOpenCodeUserInput(room);
}

function noteInputRequest(room, current, event) {
  if (!event || typeof event !== 'object') return;
  const name = getSdkToolCallName(event).toLowerCase();
  const rec = /** @type {Record<string, unknown>} */ (event);
  const eventType = typeof rec.type === 'string' ? rec.type.trim().toLowerCase() : '';
  const isQuestion =
    eventType === 'opencode_question' ||
    eventType === 'opencode_permission' ||
    name.includes('question') ||
    name.includes('permission') ||
    rec.type === 'user_action_required';
  if (!isQuestion) return;
  if (current.status === 'waiting_for_input') return;
  if (!canTransitionDelegationStatus(current.status, 'waiting_for_input')) return;
  const waiting = updateDelegationRecord(current.id, { status: 'waiting_for_input' });
  if (waiting) publishDelegationStatus(waiting, 'waiting_for_input');
}

/**
 * Snapshot the shared working tree so the finish diff can attribute only this
 * run's edits. Skipped for read-only roles (plan/review) — they change no files.
 *
 * @param {any} room
 * @param {object | null} current
 */
function captureRoomDelegationGitBase(room, current) {
  if (!room || typeof room !== 'object') return;
  if (!isExecuteAssignment(current?.assignment)) return;
  const cwd = String(current?.workspaceFolder || room.cwd || '').trim();
  room._delegationGitBase = captureGitSnapshot(cwd);
}

/**
 * Build the `metrics` object stored on the delegation record at close.
 *
 * Sources, kept strictly nullable so "no data" is never an error:
 * - tokens: sdk/qwen/opencode/deepseek rooms track them (`_lastUsagePayload`
 *   carries the run's cumulative usage); other harnesses report none, so that
 *   field stays null. tool calls: only the Cursor SDK room counts them
 *   (`_toolCallsTotal`), so the field stays null elsewhere.
 * - git diff: implement/fix only, from the baseline captured at run start versus
 *   the tree now. A missing baseline (non-repo, restart) yields null.
 *
 * @param {any} room
 * @param {object} current
 * @returns {Record<string, number | null>}
 */
export function collectRoomDelegationMetrics(room, current) {
  const transport = String(current?.executor?.transport || '').trim().toLowerCase();
  let tokensIn = null;
  let tokensOut = null;
  let toolCalls = null;
  if (transport === 'sdk' || transport === 'qwen' || transport === 'opencode' || transport === 'deepseek') {
    const usage = room && typeof room === 'object'
      && room._lastUsagePayload && typeof room._lastUsagePayload === 'object'
      ? room._lastUsagePayload
      : null;
    tokensIn = usage ? readReportedTokenCount(usage.inputTokens) : null;
    tokensOut = usage ? readReportedTokenCount(usage.outputTokens) : null;
    if (transport === 'sdk' && isExecuteAssignment(current?.assignment)) {
      const total = room ? Number(room._toolCallsTotal) : NaN;
      toolCalls = Number.isFinite(total) && total >= 0 ? total : null;
    }
  }
  let filesChanged = null;
  let linesAdded = null;
  let linesRemoved = null;
  if (isExecuteAssignment(current?.assignment)) {
    const base = room && typeof room === 'object' ? room._delegationGitBase : null;
    const head = captureGitSnapshot(String(current?.workspaceFolder || room?.cwd || '').trim());
    const delta = diffGitSnapshots(base, head);
    if (delta) {
      filesChanged = delta.files_changed;
      linesAdded = delta.lines_added;
      linesRemoved = delta.lines_removed;
    }
  }
  const startedAtMs = Date.parse(String(current?.startedAt || ''));
  return buildRunMetrics({
    tokensIn,
    tokensOut,
    toolCalls,
    filesChanged,
    linesAdded,
    linesRemoved,
    startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : null,
    finishedAtMs: Date.now(),
  });
}

/**
 * @param {any} room
 * @param {{ delegationId?: string, attemptId?: string, assignment?: string }} [meta]
 */
export function bindRoomToDelegation(room, meta = {}) {
  if (!room) return;
  const chatId = String(room.chatId || '').trim();
  const metaDelegationId = String(meta.delegationId || '').trim();
  const metaAttemptId = String(meta.attemptId || '').trim();
  const metaAssignment = String(meta.assignment || '').trim();
  let hydrated = null;
  if (!metaDelegationId && !String(room.delegationId || '').trim() && chatId) {
    hydrated = readActiveRoomChatDelegation(chatId);
  }
  const delegationId = metaDelegationId || String(hydrated?.id || '').trim();
  if (delegationId) room.delegationId = delegationId;
  const attemptId = metaAttemptId || String(hydrated?.attemptId || '').trim();
  if (attemptId) room.delegationAttemptId = attemptId;
  const assignment = metaAssignment || String(hydrated?.assignment || '').trim();
  if (assignment) room.delegationAssignment = assignment;
  if (delegationId) room.serverHold = true;
  syncRoomDelegationAssignment(room);
}

/**
 * Reattach hydration: a room recreated without deps meta can recover its job
 * from the persisted child chat, like `readDelegationQuietStopMeta` does.
 * Only a live job that still owns this chat may adopt the room.
 *
 * @param {string} chatId
 * @returns {object | null}
 */
function readActiveRoomChatDelegation(chatId) {
  const chat = loadChats().find((row) => row.id === chatId);
  const delegationId = String(chat?.delegationId || '').trim();
  if (!delegationId) return null;
  const record = getDelegationById(delegationId);
  if (!record || !isActiveDelegationStatus(record.status)) return null;
  if (String(record.childChatId || '').trim() !== chatId) return null;
  return record;
}

/**
 * Review read-only applies only while that job is still active.
 * Follow-up turns in the same child chat use SDK mode after the job ends.
 *
 * @param {any} room
 * @returns {string}
 */
export function syncRoomDelegationAssignment(room) {
  if (!room || typeof room !== 'object') return '';
  const id = String(room.delegationId || '').trim();
  const rec = id ? getDelegationById(id) : null;
  const next = rec && isActiveDelegationStatus(rec.status)
    ? String(rec.assignment || '').trim()
    : '';
  room.delegationAssignment = next;
  persistChatDelegationAssignment(String(room.chatId || '').trim(), next);
  return next;
}

/**
 * @param {any} room
 * @returns {string}
 */
export function readRoomDelegationAssignment(room) {
  return syncRoomDelegationAssignment(room);
}

/**
 * @param {string} chatId
 * @param {string} assignment
 */
function persistChatDelegationAssignment(chatId, assignment) {
  if (!chatId) return;
  const chat = loadChats().find((row) => row.id === chatId);
  if (!chat) return;
  const current = String(chat.delegationAssignment || '').trim();
  if (current === assignment) return;
  updateChat(chatId, { delegationAssignment: assignment || null });
}
