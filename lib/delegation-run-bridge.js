/**
 * Map harness room events onto the active delegation record.
 */

import {
  finishDelegation,
  isDelegationEventCurrent,
  publishDelegationStatus,
} from './delegation-service.js';
import { drainChatMailbox } from './delegation-mailbox.js';
import { canTransitionDelegationStatus } from './delegation-status.js';
import {
  getDelegationById,
  updateDelegationRecord,
} from './persist/delegations-persist.js';
import { getSdkToolCallName } from './sdk/sdk-plan-guard.js';
import { normalizeSdkRunStatus } from './sdk/sdk-run-outcome.js';

/**
 * @param {any} room
 * @param {Record<string, unknown>} payload
 */
export function noteDelegationRoomEvent(room, payload) {
  if (!payload || typeof payload !== 'object') return;
  const type = typeof payload.type === 'string' ? payload.type : '';
  const delegationId = String(room?.delegationId || '').trim();
  const current = delegationId ? getDelegationById(delegationId) : null;
  const eventRunId = typeof payload.runId === 'string' ? payload.runId : '';
  const isCurrent = current && isDelegationEventCurrent(current, eventRunId, room.delegationAttemptId);
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
      if (status === 'completed') {
        finishDelegation(current, { status: 'completed', report: assistantText });
        room.serverHold = false;
      } else if (status === 'cancelled') {
        finishDelegation(current, { status: 'cancelled', report: assistantText });
        room.serverHold = false;
      } else if (status === 'error' || status === 'failed') {
        const error = typeof payload.lastErrorMessage === 'string'
          ? payload.lastErrorMessage
          : typeof payload.result === 'string' ? payload.result : '';
        finishDelegation(current, { status: 'failed', error, report: assistantText });
        room.serverHold = false;
      }
    }
  }
  if (type === 'sdkRunFinished') {
    const chatId = String(room?.chatId || '').trim();
    if (chatId) void drainChatMailbox(chatId);
  }
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
  if (delegationId) room.serverHold = true;
}
