import { resetSdkStreamState } from '../../../lib/sdk-chat-format.js';
import { resolveSdkRunFailureDetail } from '../../../../lib/sdk/sdk-run-outcome.ts';
import { noteLiveInAppSignal } from '../../pwa/inAppSignals.js';
import { t } from '../../../i18n/index.js';

/** Replayed frame types whose live handler asserts "the harness is working". */
export const REPLAY_BUSY_ASSERTING_TYPES = new Set([
  'sdkEvent',
  'sdkQueued',
  'sdkPromptStarted',
  'sdkRunProgress',
  'sdkBusy',
]);

/**
 * @param {object} chat
 */
export function sdkStreamReset(chat) {
  resetSdkStreamState(chat);
  chat._sdkRichView?.onStreamReset?.();
}

/**
 * @param {Record<string, unknown>} msg
 * @returns {string}
 */
export function resolveSdkRunFailureNotice(msg) {
  const failureDetail = resolveSdkRunFailureDetail({
    status: msg.status,
    result: msg.result,
    lastErrorMessage: msg.lastErrorMessage,
    lastErrorCode: msg.lastErrorCode,
  });
  const code = typeof msg.lastErrorCode === 'string' ? msg.lastErrorCode.trim() : '';
  const status = typeof msg.status === 'string' ? msg.status.trim().toLowerCase() : '';
  if (
    code === 'cursor_auth_error'
    || code === 'cursor_rate_limit'
    || code === 'qwen_quota'
    || code === 'qwen_rate_limit'
    || code === 'qwen_auth'
    || code === 'opencode_error'
    || code === 'claude_error'
  ) {
    return '';
  }
  if (status === 'plan_guard_cancelled') {
    return '';
  }
  if (status === 'cancelled') {
    if (code === 'run_stuck_auto_recovery') {
      return t('chat.runStuckAutoRecovery');
    }
    if (code === 'delegation_final_report') {
      return '';
    }
    return t('chat.runCancelled', { detail: failureDetail || '' });
  }
  return failureDetail;
}

/**
 * Emit an in-app signal only for a genuinely live transport frame. The
 * `replayBatch` branch re-delivers room history through this same handler with
 * `replay: true`, so a replayed finished/question/permission must stay silent.
 *
 * @param {any} msg
 * @param {'finished'|'question'|'permission'} eventType
 * @param {unknown} eventId
 * @param {object} chat owning chat, including ancestry for the notification profile
 */
export function noteInAppSignalIfLive(msg, eventType, eventId, chat) {
  if (!msg || msg.replay === true) return;
  noteLiveInAppSignal({
    eventType,
    eventId: typeof eventId === 'string' ? eventId : '',
    chatId: chat?.id || '',
    notificationScope: chat?.delegationParentChatId || chat?.forkParentChatId ? 'subchat' : 'chat',
  });
}
