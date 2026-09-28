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
  'targetDirectory',
  'target_directory',
];

const SDK_OPEN_TOOL_STATUSES = new Set([
  'running',
  'pending',
  'in_progress',
  'started',
]);

/**
 * @param {string} runKey
 * @returns {string}
 */
function normalizeRunKey(runKey) {
  return String(runKey || '').trim();
}

const SDK_TOOL_STATUS_COMPLETED_ALIASES = new Set(['success', 'ok', 'done', 'finished']);

/**
 * @param {unknown} status
 * @returns {string}
 */
export function normalizeSdkToolStatus(status) {
  return String(status || '').trim().toLowerCase();
}

/**
 * @param {unknown} status
 * @returns {'error' | 'cancelled' | ''}
 */
function readExplicitSdkToolFailureStatus(status) {
  const normalized = normalizeSdkToolStatus(status);
  if (normalized === 'error') return 'error';
  if (normalized === 'cancelled' || normalized === 'canceled') return 'cancelled';
  return '';
}

/**
 * Map event-status aliases onto the terminal CSS/spinner vocabulary.
 * Does not treat `result.success` as a boolean — harvest never did.
 *
 * @param {{ status?: unknown, result?: unknown }} input
 * @returns {string}
 */
export function canonicalizeSdkToolStatus(input = {}) {
  const eventFailure = readExplicitSdkToolFailureStatus(input.status);
  if (eventFailure) return eventFailure;
  const eventStatus = normalizeSdkToolStatus(input.status);
  const normalizedEventStatus = SDK_TOOL_STATUS_COMPLETED_ALIASES.has(eventStatus)
    ? 'completed'
    : eventStatus;
  const result = input.result;
  if (result == null || result === '') return normalizedEventStatus;
  if (typeof result === 'object' && !Array.isArray(result)) {
    const row = /** @type {Record<string, unknown>} */ (result);
    const resultFailure = readExplicitSdkToolFailureStatus(row.status);
    if (resultFailure === 'error' || row.error != null) return 'error';
    if (resultFailure === 'cancelled') return 'cancelled';
  }
  return 'completed';
}

/**
 * @param {string} status
 * @returns {boolean}
 */
export function isRunningSdkToolStatus(status) {
  const normalized = normalizeSdkToolStatus(status);
  return SDK_OPEN_TOOL_STATUSES.has(normalized) && normalized !== 'pending';
}

/**
 * Open tool tile: still waiting for a terminal SDK status.
 *
 * @param {unknown} status
 * @returns {boolean}
 */
export function isOpenSdkToolStatus(status) {
  const normalized = normalizeSdkToolStatus(status);
  return !normalized || SDK_OPEN_TOOL_STATUSES.has(normalized);
}

/**
 * Cursor sometimes concatenates two ids with a newline. Keep the first line so
 * running/completed snapshots still merge.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeSdkCallId(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || text;
}

/**
 * Unwrap local-run envelope events so collectors see the inner SDKMessage.
 *
 * @param {unknown} event
 * @returns {Record<string, unknown> | null}
 */
export function unwrapSdkStreamMessage(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  const row = /** @type {Record<string, unknown>} */ (event);
  if (row.type === 'sdk_message' && row.message && typeof row.message === 'object' && !Array.isArray(row.message)) {
    return /** @type {Record<string, unknown>} */ (row.message);
  }
  return row;
}

/**
 * @param {unknown} event
 * @returns {string}
 */
export function readSdkToolCallId(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return '';
  const row = /** @type {Record<string, unknown>} */ (event);
  if (typeof row.call_id === 'string' && row.call_id.trim()) return normalizeSdkCallId(row.call_id);
  if (typeof row.toolCallId === 'string' && row.toolCallId.trim()) return normalizeSdkCallId(row.toolCallId);
  if (typeof row.callId === 'string' && row.callId.trim()) return normalizeSdkCallId(row.callId);
  if (typeof row.tool_use_id === 'string' && row.tool_use_id.trim()) {
    return normalizeSdkCallId(row.tool_use_id);
  }
  const type = typeof row.type === 'string' ? row.type.trim().toLowerCase() : '';
  if (type === 'tool_use' && typeof row.id === 'string' && row.id.trim()) {
    return normalizeSdkCallId(row.id);
  }
  return '';
}

/**
 * Map tool_use / tool_result onto the tool_call shape the rich view already renders.
 *
 * @param {unknown} event
 * @returns {Record<string, unknown> | null}
 */
export function normalizeSdkToolStreamEvent(event) {
  const unwrapped = unwrapSdkStreamMessage(event);
  if (!unwrapped) return null;
  const type = typeof unwrapped.type === 'string' ? unwrapped.type.trim().toLowerCase() : '';
  if (type === 'tool_use') {
    const args = unwrapped.input && typeof unwrapped.input === 'object' && !Array.isArray(unwrapped.input)
      ? unwrapped.input
      : unwrapped.args;
    return {
      ...unwrapped,
      type: 'tool_call',
      name: unwrapped.name,
      args,
      status: unwrapped.status || 'running',
      call_id: readSdkToolCallId(unwrapped),
    };
  }
  if (type === 'tool_result') {
    const result = unwrapped.result !== undefined ? unwrapped.result : unwrapped.content;
    return {
      ...unwrapped,
      type: 'tool_call',
      call_id: readSdkToolCallId(unwrapped),
      result,
      status: unwrapped.status,
    };
  }
  return unwrapped;
}

/**
 * @param {unknown} args
 * @returns {string}
 */
export function readSdkToolIdentityKey(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return '';
  const row = /** @type {Record<string, unknown>} */ (args);
  const identity = [];
  for (const key of SDK_TOOL_IDENTITY_ARG_KEYS) {
    if (typeof row[key] === 'string' && row[key].trim()) {
      identity.push(`${key}:${row[key].trim()}`);
    }
  }
  if (Array.isArray(row.paths)) {
    for (const path of row.paths) {
      if (typeof path === 'string' && path.trim()) identity.push(`paths:${path.trim()}`);
    }
  }
  return identity.join('|');
}

/**
 * @param {unknown} prevArgs
 * @param {unknown} incomingArgs
 * @returns {boolean}
 */
export function sdkToolArgsCompatible(prevArgs, incomingArgs) {
  if (prevArgs == null || incomingArgs == null) return true;
  const left = readSdkToolIdentityKey(prevArgs);
  const right = readSdkToolIdentityKey(incomingArgs);
  if (left && right && left !== right) return false;
  return true;
}

/**
 * Pair a later completed (or id-less) tool event with an open tile.
 * Exact call_id always wins. Parallel running calls with distinct ids stay separate.
 *
 * @param {Iterable<{ callId?: string, runKey?: string, event?: { name?: unknown, args?: unknown, status?: unknown, result?: unknown } }>} records
 * @param {{ callId?: string, name?: string, args?: unknown, runKey?: string, status?: unknown, result?: unknown }} incoming
 * @returns {object | null}
 */
export function findOpenSdkToolRecord(records, incoming = {}) {
  const callId = String(incoming.callId || '').trim();
  const runKey = String(incoming.runKey || '').trim();
  const name = String(incoming.name || '').trim().toLowerCase();
  const incomingStatus = canonicalizeSdkToolStatus({
    status: incoming.status,
    result: incoming.result,
  });
  let lastOpenSameIdentity = null;
  for (const record of records) {
    if (!record) continue;
    if (runKey && record.runKey && String(record.runKey) !== runKey) continue;
    if (callId && String(record.callId || '').trim() === callId) return record;
    const prevStatus = record.event && typeof record.event === 'object'
      ? record.event.status
      : '';
    if (!isOpenSdkToolStatus(prevStatus)) continue;
    const prevName = record.event && typeof record.event.name === 'string'
      ? record.event.name.trim().toLowerCase()
      : '';
    if (name && prevName && prevName !== name) continue;
    const prevArgs = record.event && typeof record.event === 'object' ? record.event.args : null;
    if (!sdkToolArgsCompatible(prevArgs, incoming.args)) continue;
    if (!lastOpenSameIdentity) lastOpenSameIdentity = record;
  }
  if (callId && !isTerminalSdkToolStatus(incomingStatus)) return null;
  return lastOpenSameIdentity;
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
 * Thinking spinner stays only while this run is still live.
 *
 * `isLiveTurn: false` wins: after FINISHED / harness idle, late thinking
 * events (or a stream reset that changes local-run-*) must not revive it.
 *
 * @param {{
 *   runKey?: unknown,
 *   activeKind?: unknown,
 *   activeThinkingRunKey?: unknown,
 *   suppressHistoryPersist?: boolean,
 *   runStatus?: unknown,
 *   hasRunningTools?: boolean,
 *   isLiveTurn?: boolean,
 * }} input
 * @returns {boolean}
 */
export function shouldKeepSdkThinkingSpinner(input = {}) {
  if (input.isLiveTurn === false) return false;
  if (isTerminalSdkRunStatus(input.runStatus)) return false;
  const key = normalizeRunKey(input.runKey);
  if (!key) return input.hasRunningTools === true;
  if (
    input.activeKind === 'thinking'
    && normalizeRunKey(input.activeThinkingRunKey) === key
    && input.suppressHistoryPersist !== true
  ) {
    return true;
  }
  return input.hasRunningTools === true;
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
  const callId = readSdkToolCallId(event);
  if (callId) return callId;
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
  if (type && type !== 'tool_call' && type !== 'tool_result' && type !== 'tool_use') return false;
  if (readSdkToolCallId(ev)) return false;
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
  const identity = readSdkToolIdentityKey(ev.args);
  return `${normalizeRunKey(runKey)}:${name}:${identity}`;
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
