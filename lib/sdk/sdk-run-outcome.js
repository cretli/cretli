const SDK_RUN_FAILURE_STATUSES = new Set([
  'error',
  'run_failed',
  'idle_timeout',
  'plan_guard_cancelled',
  'run_setup_failed',
  'run_setup_cancelled',
]);

const SDK_RUN_CANCELLED_MESSAGE =
  'Run was cancelled before completion. You can send your message again.';
const SDK_RUN_STUCK_RECOVERY_CANCELLED_MESSAGE =
  'Run exceeded the idle budget and was cancelled for auto-recovery. You can send your message again.';

/**
 * @param {unknown} status
 * @returns {string}
 */
export function normalizeSdkRunStatus(status) {
  const normalized = String(status || '').trim().toLowerCase();
  if (!normalized) return '';
  if (normalized === 'finished' || normalized === 'completed' || normalized === 'success') {
    return 'completed';
  }
  if (
    normalized === 'cancelled' ||
    normalized === 'plan_guard_cancelled' ||
    normalized === 'run_setup_cancelled' ||
    normalized.includes('cancel')
  ) {
    return 'cancelled';
  }
  if (
    normalized === 'error' ||
    normalized === 'run_failed' ||
    normalized === 'run_setup_failed' ||
    normalized === 'idle_timeout' ||
    normalized.includes('fail') ||
    normalized.includes('error')
  ) {
    return 'error';
  }
  return normalized;
}

/**
 * @param {unknown} status
 * @returns {boolean}
 */
export function isSdkRunFailureStatus(status) {
  const normalized = normalizeSdkRunStatus(status);
  if (!normalized) return false;
  if (normalized === 'completed') return false;
  if (normalized === 'error' || normalized === 'cancelled') return true;
  if (SDK_RUN_FAILURE_STATUSES.has(normalized)) return true;
  return normalized.includes('error') || normalized.includes('fail') || normalized.includes('cancel');
}

/**
 * @param {unknown} event
 * @returns {string}
 */
export function extractSdkStreamStatusError(event) {
  if (!event || typeof event !== 'object') return '';
  const record = /** @type {Record<string, unknown>} */ (event);
  if (record.type !== 'status') return '';
  const status = typeof record.status === 'string' ? record.status.trim().toUpperCase() : '';
  if (status !== 'ERROR') return '';
  return typeof record.message === 'string' ? record.message.trim() : '';
}

/**
 * @param {unknown} status
 * @param {unknown} result
 * @param {{ lastErrorCode?: unknown }} [options]
 * @returns {string}
 */
export function buildSdkRunFailureDetail(status, result, options = {}) {
  const normalizedStatus = String(status || '').trim().toLowerCase();
  if (!normalizedStatus || normalizedStatus === 'finished' || normalizedStatus === 'completed') {
    return '';
  }
  const rawResult = typeof result === 'string' ? result.trim() : '';
  if (rawResult) {
    if (rawResult.length <= 600) return rawResult;
    return `${rawResult.slice(0, 600)}…`;
  }
  if (normalizedStatus === 'plan_guard_cancelled') {
    return '';
  }
  if (normalizedStatus === 'cancelled') {
    const errorCode =
      typeof options.lastErrorCode === 'string' ? options.lastErrorCode.trim().toLowerCase() : '';
    if (errorCode === 'run_stuck_auto_recovery') {
      return SDK_RUN_STUCK_RECOVERY_CANCELLED_MESSAGE;
    }
    return SDK_RUN_CANCELLED_MESSAGE;
  }
  if (isSdkRunFailureStatus(normalizedStatus)) {
    return 'Run ended with error, but SDK returned no details.';
  }
  return '';
}

/**
 * Resolves the best available run failure message from SDK payloads.
 *
 * @param {{
 *   status?: unknown,
 *   result?: unknown,
 *   statusErrorMessage?: unknown,
 *   lastErrorMessage?: unknown,
 *   lastErrorCode?: unknown,
 * }} [input]
 * @returns {string}
 */
export function resolveSdkRunFailureDetail(input = {}) {
  const status = input.status;
  const options = { lastErrorCode: input.lastErrorCode };
  const rawResult = typeof input.result === 'string' ? input.result.trim() : '';
  if (rawResult) return buildSdkRunFailureDetail(status, rawResult, options);
  const statusErrorMessage =
    typeof input.statusErrorMessage === 'string' ? input.statusErrorMessage.trim() : '';
  if (statusErrorMessage) return buildSdkRunFailureDetail(status, statusErrorMessage, options);
  const lastErrorMessage =
    typeof input.lastErrorMessage === 'string' ? input.lastErrorMessage.trim() : '';
  if (lastErrorMessage) return buildSdkRunFailureDetail(status, lastErrorMessage, options);
  return buildSdkRunFailureDetail(status, '', options);
}

/**
 * @param {unknown} room
 * @returns {{
 *   lastRunId: string,
 *   lastRunStatus: string,
 *   lastErrorCode: string,
 *   lastErrorMessage: string,
 * }}
 */
export function readSdkRoomRunOutcome(room) {
  const lastRunStatus = typeof room?.lastRunStatus === 'string' ? room.lastRunStatus.trim() : '';
  return {
    lastRunId: typeof room?.lastRunId === 'string' ? room.lastRunId.trim() : '',
    lastRunStatus,
    lastRunStatusNormalized: normalizeSdkRunStatus(lastRunStatus),
    lastErrorCode: typeof room?.lastErrorCode === 'string' ? room.lastErrorCode.trim() : '',
    lastErrorMessage:
      typeof room?.lastErrorMessage === 'string' ? room.lastErrorMessage.trim() : '',
  };
}

/**
 * @param {any} room
 * @param {Record<string, unknown>} payload
 */
export function trackSdkRoomRunOutcome(room, payload) {
  if (!room || !payload || typeof payload !== 'object') return;
  const type = typeof payload.type === 'string' ? payload.type : '';
  if (type === 'sdkRunFinished') {
    const runId = typeof payload.runId === 'string' ? payload.runId.trim() : '';
    const status = typeof payload.status === 'string' ? payload.status.trim() : '';
    const result = typeof payload.result === 'string' ? payload.result.trim() : '';
    const errorCode =
      typeof payload.lastErrorCode === 'string' ? payload.lastErrorCode.trim() : '';
    const errorMessage =
      typeof payload.lastErrorMessage === 'string' ? payload.lastErrorMessage.trim() : '';
    if (runId) room.lastRunId = runId;
    if (status) room.lastRunStatus = status;
    if (errorCode) room.lastErrorCode = errorCode;
    if (errorMessage) {
      room.lastErrorMessage = errorMessage;
    } else if (result && isSdkRunFailureStatus(status)) {
      room.lastErrorMessage = result;
    }
    return;
  }
  if (type !== 'sdkError') return;
  const code = typeof payload.code === 'string' ? payload.code.trim() : '';
  const message = typeof payload.message === 'string' ? payload.message.trim() : '';
  if (code === 'run_setup_cancelled') {
    room.lastRunStatus = 'cancelled';
  } else {
    room.lastRunStatus = 'error';
  }
  if (code && room.lastErrorCode !== 'cursor_auth_error') {
    room.lastErrorCode = code;
  }
  if (message && room.lastErrorCode !== 'cursor_auth_error') {
    room.lastErrorMessage = message;
  }
}
