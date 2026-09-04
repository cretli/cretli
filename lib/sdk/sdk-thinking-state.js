const SDK_TOOL_IDENTITY_ARG_KEYS = [
  'path',
  'file_path',
  'target_file',
  'filePath',
  'filename',
  'globPattern',
  'pattern',
  'command',
  'query',
];

/**
 * @param {string} runKey
 * @returns {string}
 */
function normalizeRunKey(runKey) {
  return String(runKey || '').trim();
}

/**
 * @param {unknown} status
 * @returns {string}
 */
export function normalizeSdkToolStatus(status) {
  return String(status || '').trim().toLowerCase();
}

/**
 * @param {string} status
 * @returns {boolean}
 */
export function isRunningSdkToolStatus(status) {
  return normalizeSdkToolStatus(status) === 'running';
}

/**
 * Open tool tile: still waiting for a terminal SDK status.
 *
 * @param {unknown} status
 * @returns {boolean}
 */
export function isOpenSdkToolStatus(status) {
  const normalized = normalizeSdkToolStatus(status);
  return !normalized || normalized === 'running' || normalized === 'pending';
}

/**
 * @param {unknown} status
 * @returns {boolean}
 */
export function isTerminalSdkToolStatus(status) {
  const normalized = normalizeSdkToolStatus(status);
  return normalized === 'completed' || normalized === 'error' || normalized === 'cancelled';
}

/**
 * @param {unknown} status
 * @returns {boolean}
 */
export function isTerminalSdkRunStatus(status) {
  const normalized = normalizeSdkToolStatus(status);
  return (
    normalized === 'finished' ||
    normalized === 'completed' ||
    normalized === 'error' ||
    normalized === 'cancelled'
  );
}

/**
 * Status for tools still running when the run itself has already ended.
 *
 * @param {unknown} runStatus
 * @returns {'cancelled' | 'error'}
 */
export function resolveAbandonedToolStatus(runStatus) {
  const normalized = normalizeSdkToolStatus(runStatus);
  if (normalized === 'error' || normalized === 'cancelled') return 'error';
  return 'cancelled';
}

/**
 * Tool status is monotonic: completed/error stay put; cancelled can upgrade.
 *
 * @param {unknown} prevStatus
 * @param {unknown} nextStatus
 * @returns {boolean}
 */
export function shouldAcceptSdkToolStatus(prevStatus, nextStatus) {
  const next = normalizeSdkToolStatus(nextStatus);
  if (!next) return false;
  const prev = normalizeSdkToolStatus(prevStatus);
  if (!isTerminalSdkToolStatus(prev)) return true;
  if (isOpenSdkToolStatus(next)) return false;
  if (prev === 'cancelled' && (next === 'completed' || next === 'error')) return true;
  if (prev === 'completed' && next === 'error') return true;
  return prev === next;
}

/**
 * @param {unknown} event
 * @param {string} [fallback]
 * @returns {string}
 */
export function resolveSdkToolCallId(event, fallback = '') {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return String(fallback || '');
  }
  const ev = /** @type {Record<string, unknown>} */ (event);
  if (typeof ev.call_id === 'string' && ev.call_id.trim()) return ev.call_id.trim();
  if (typeof ev.toolCallId === 'string' && ev.toolCallId.trim()) return ev.toolCallId.trim();
  return String(fallback || '');
}

/**
 * Empty leftover from a tool/result that had no call id, name, args, or output.
 * @param {unknown} event
 * @returns {boolean}
 */
export function isEmptyGenericSdkToolEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
  const ev = /** @type {Record<string, unknown>} */ (event);
  const type = typeof ev.type === 'string' ? ev.type.trim() : '';
  if (type && type !== 'tool_call') return false;
  const callId = typeof ev.call_id === 'string' ? ev.call_id.trim() : '';
  if (callId) return false;
  const name = typeof ev.name === 'string' ? ev.name.trim().toLowerCase() : '';
  if (name && name !== 'tool' && name !== '?') return false;
  const args = ev.args && typeof ev.args === 'object' && !Array.isArray(ev.args)
    ? /** @type {Record<string, unknown>} */ (ev.args)
    : null;
  if (args && Object.keys(args).length > 0) return false;
  if (ev.result !== undefined && ev.result !== null && ev.result !== '') return false;
  return true;
}

/**
 * Stable id when SDK omits call_id, so running/completed still share one tile.
 *
 * @param {unknown} event
 * @param {string} [runKey]
 * @returns {string}
 */
export function buildStableSdkToolCallFallback(event, runKey = '') {
  const ev = event && typeof event === 'object' && !Array.isArray(event)
    ? /** @type {Record<string, unknown>} */ (event)
    : {};
  const name = typeof ev.name === 'string' && ev.name.trim() ? ev.name.trim() : 'tool';
  const args = ev.args && typeof ev.args === 'object' && !Array.isArray(ev.args)
    ? /** @type {Record<string, unknown>} */ (ev.args)
    : {};
  const identity = [];
  for (const key of SDK_TOOL_IDENTITY_ARG_KEYS) {
    if (typeof args[key] === 'string' && args[key].trim()) {
      identity.push(`${key}:${args[key].trim()}`);
    }
  }
  if (Array.isArray(args.paths)) {
    for (const path of args.paths) {
      if (typeof path === 'string' && path.trim()) identity.push(`paths:${path.trim()}`);
    }
  }
  return `${normalizeRunKey(runKey)}:${name}:${identity.join('|')}`;
}

/**
 * @param {Map<string, number>} runningToolCallsByRun
 * @param {string} runKey
 * @returns {number}
 */
export function getRunningSdkToolCallCount(runningToolCallsByRun, runKey) {
  const key = normalizeRunKey(runKey);
  if (!key) return 0;
  return Number(runningToolCallsByRun.get(key) || 0);
}

/**
 * @param {Map<string, number>} runningToolCallsByRun
 * @param {string} runKey
 * @returns {boolean}
 */
export function hasRunningSdkTools(runningToolCallsByRun, runKey) {
  return getRunningSdkToolCallCount(runningToolCallsByRun, runKey) > 0;
}

/**
 * @param {Map<string, number>} runningToolCallsByRun
 * @param {string} runKey
 * @param {number} nextCount
 * @returns {void}
 */
export function setRunningSdkToolCallCount(runningToolCallsByRun, runKey, nextCount) {
  const key = normalizeRunKey(runKey);
  if (!key) return;
  const safeCount = Math.max(0, Number(nextCount) || 0);
  if (safeCount === 0) {
    runningToolCallsByRun.delete(key);
    return;
  }
  runningToolCallsByRun.set(key, safeCount);
}

/**
 * @param {Map<string, number>} runningToolCallsByRun
 * @param {string} runKey
 * @param {string} prevStatus
 * @param {string} nextStatus
 * @returns {void}
 */
export function updateRunningSdkToolState(
  runningToolCallsByRun,
  runKey,
  prevStatus,
  nextStatus
) {
  const key = normalizeRunKey(runKey);
  if (!key) return;
  const wasRunning = isRunningSdkToolStatus(prevStatus);
  const isRunning = isRunningSdkToolStatus(nextStatus);
  if (wasRunning === isRunning) return;
  const currentCount = getRunningSdkToolCallCount(runningToolCallsByRun, key);
  const nextCount = isRunning ? currentCount + 1 : currentCount - 1;
  setRunningSdkToolCallCount(runningToolCallsByRun, key, nextCount);
}
