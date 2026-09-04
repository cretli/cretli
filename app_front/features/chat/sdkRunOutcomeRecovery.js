import {
  isSdkRunFailureStatus,
  readSdkRoomRunOutcome,
  resolveSdkRunFailureDetail,
} from '../../../lib/sdk/sdk-run-outcome.js';
import { t } from '../../i18n/index.js';

/**
 * @param {Record<string, unknown>} message
 * @returns {Record<string, unknown> | null}
 */
export function extractSdkRunOutcomeSnapshot(message) {
  if (!message || typeof message !== 'object') return null;
  const type = typeof message.type === 'string' ? message.type : '';
  if (type !== 'sdkRoomState' && type !== 'hello') return null;
  const outcome = readSdkRoomRunOutcome(message);
  return {
    type,
    busy: message.busy === true || message.hasCurrentRun === true,
    hasCurrentRun: message.hasCurrentRun === true,
    lastRunId: outcome.lastRunId,
    lastRunStatus: outcome.lastRunStatus,
    lastErrorCode: outcome.lastErrorCode,
    lastErrorMessage: outcome.lastErrorMessage,
    lastRunResult: typeof message.lastRunResult === 'string' ? message.lastRunResult : '',
  };
}

/**
 * Shows a missed failed run in the chat stream after reconnect or history gap.
 *
 * @param {object} chat
 * @param {Record<string, unknown> | null | undefined} snapshot
 * @param {{
 *   onHistorySync?: (chat: object, reason: string) => void,
 * }} [options]
 * @returns {boolean}
 */
export function maybeRecoverMissedSdkRunOutcome(chat, snapshot, options = {}) {
  if (!chat?._sdkRichView || !snapshot || typeof snapshot !== 'object') return false;
  if (snapshot.busy === true || snapshot.hasCurrentRun === true) return false;
  const runId = typeof snapshot.lastRunId === 'string' ? snapshot.lastRunId.trim() : '';
  const status = typeof snapshot.lastRunStatus === 'string' ? snapshot.lastRunStatus.trim() : '';
  if (!status || !isSdkRunFailureStatus(status)) return false;
  if (runId && chat._lastHandledSdkRunFinishedId === runId) return false;
  if (runId) chat._lastHandledSdkRunFinishedId = runId;
  chat._sdkRichView.appendRunFinished(status);
  const failureDetail = resolveSdkRunFailureDetail({
    status,
    result: snapshot.lastRunResult,
    lastErrorMessage: snapshot.lastErrorMessage,
    lastErrorCode: snapshot.lastErrorCode,
  });
  if (failureDetail) {
    const code = typeof snapshot.lastErrorCode === 'string' ? snapshot.lastErrorCode.trim() : '';
    if (code === 'cursor_auth_error') {
      chat._sdkRichView.appendMetaNotice(
        t('chat.sdkAuthError', { detail: failureDetail || snapshot.lastErrorMessage || '' })
      );
    } else if (code === 'cursor_rate_limit') {
      chat._sdkRichView.appendError(
        t('chat.sdkRateLimitError', { detail: failureDetail || snapshot.lastErrorMessage || '' })
      );
    } else if (code === 'qwen_quota' || code === 'qwen_rate_limit') {
      chat._sdkRichView.appendError(
        t('chat.qwenQuotaError', { detail: failureDetail || snapshot.lastErrorMessage || '' })
      );
    } else if (code === 'qwen_auth') {
      chat._sdkRichView.appendError(
        t('chat.qwenAuthError', { detail: failureDetail || snapshot.lastErrorMessage || '' })
      );
    } else {
      chat._sdkRichView.appendMetaNotice(failureDetail);
    }
  }
  const errorMessage =
    typeof snapshot.lastErrorMessage === 'string' ? snapshot.lastErrorMessage.trim() : '';
  const code = typeof snapshot.lastErrorCode === 'string' ? snapshot.lastErrorCode.trim() : '';
  if (
    errorMessage
    && code !== 'cursor_auth_error'
    && code !== 'cursor_rate_limit'
    && code !== 'qwen_quota'
    && code !== 'qwen_rate_limit'
    && code !== 'qwen_auth'
    && errorMessage !== failureDetail
  ) {
    chat._sdkRichView.appendError(errorMessage);
  }
  if (typeof options.onHistorySync === 'function') {
    options.onHistorySync(chat, 'missed_run_outcome');
  }
  return true;
}
