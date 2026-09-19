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
import {
  applyFinalReportQuietStopToPayload,
  normalizeSdkRunStatus,
} from './sdk/sdk-run-outcome.js';

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
    } else if (type === 'sdkRunFinished') {
      const status = normalizeSdkRunStatus(payload.status);
      const assistantText = String(room._currentRunAssistantText || '').trim();
      let finished = null;
      if (status === 'completed') {
        finished = finishDelegation(current, {
          status: 'completed',
          report: assistantText,
          attemptId: room.delegationAttemptId,
          enqueueParentReply: true,
        });
        room.serverHold = false;
      } else if (status === 'cancelled') {
        finished = finishDelegation(current, {
          status: 'cancelled',
          report: assistantText,
          attemptId: room.delegationAttemptId,
        });
        room.serverHold = false;
      } else if (status === 'error' || status === 'failed') {
        const error = typeof payload.lastErrorMessage === 'string'
          ? payload.lastErrorMessage
          : typeof payload.result === 'string' ? payload.result : '';
        finished = finishDelegation(current, {
          status: 'failed',
          error,
          report: assistantText,
          attemptId: room.delegationAttemptId,
          enqueueParentReply: true,
        });
        room.serverHold = false;
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
 * @param {any} room
 * @param {object} current
 * @param {unknown} event
 */
function noteInputRequest(room, current, event) {
  if (!event || typeof event !== 'object') return;
  const name = getSdkToolCallName(event).toLowerCase();
  const rec = /** @type {Record<string, unknown>} */ (event);
  const isQuestion =
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
 * @param {any} room
 * @param {{ delegationId?: string, attemptId?: string }} [meta]
 */
export function bindRoomToDelegation(room, meta = {}) {
  if (!room) return;
  const delegationId = String(meta.delegationId || '').trim();
  if (delegationId) room.delegationId = delegationId;
  const attemptId = String(meta.attemptId || '').trim();
  if (attemptId) room.delegationAttemptId = attemptId;
  const assignment = String(meta.assignment || '').trim();
  if (assignment) room.delegationAssignment = assignment;
  if (delegationId) room.serverHold = true;
  syncRoomDelegationAssignment(room);
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
  if (!id) return String(room.delegationAssignment || '').trim();
  const rec = getDelegationById(id);
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
