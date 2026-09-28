/**
 * Inspect DeepSeekHarness.run() results.
 *
 * Reusing a persisted sessionId on a new dsh process collides with the session
 * log on disk. The SDK then returns idle with an empty finalResponse instead of
 * throwing, and Cretli used to mark the turn completed.
 *
 * A run observes the whole session tree, so every helper here is scoped to the
 * root session: workflow subagents share the tree and their turn/end must never
 * be mistaken for the main turn's outcome.
 *
 * TurnEndReason (dsh-session/lib/types/types.d.ts) is a merge-extensible sum:
 * completed | aborted | blocked | error | max-tokens | interrupted.
 */

export const DEEPSEEK_EMPTY_RUN_ERROR = 'DeepSeek run ended without a response.';
export const DEEPSEEK_INCOMPLETE_RUN_PREFIX = 'DeepSeek run ended before delivering a response';

const SUCCESS_REASON_KINDS = new Set(['completed']);
const CANCEL_REASON_KINDS = new Set(['aborted']);
const FAILURE_REASON_KINDS = new Set(['error', 'blocked', 'max-tokens', 'interrupted']);

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function asRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * Accept either a bare root session id or a `{ rootSessionId }` scope object.
 * @param {unknown} scope
 * @returns {string}
 */
function normalizeRootSessionId(scope) {
  if (typeof scope === 'string') return scope.trim();
  const rec = asRecord(scope);
  return rec ? String(rec.rootSessionId ?? '').trim() : '';
}

/**
 * DSH `run()` returns the handle id as `result.sessionId` (the parent). Prefer
 * an already-pinned room root, then the id used for this turn, and never a
 * known child id — a child must not persist or decide the parent outcome.
 *
 * @param {{
 *   roomRootId?: unknown,
 *   usedSessionId?: unknown,
 *   resultSessionId?: unknown,
 *   childSessionIds?: Set<string> | string[],
 * }} [input]
 * @returns {string}
 */
export function pinDeepSeekRootSessionId(input = {}) {
  const roomRootId = String(input.roomRootId || '').trim();
  const usedSessionId = String(input.usedSessionId || '').trim();
  const resultSessionId = String(input.resultSessionId || '').trim();
  const childIds = input.childSessionIds;
  const isKnownChild = (id) => {
    if (!id) return false;
    if (childIds instanceof Set) return childIds.has(id);
    if (Array.isArray(childIds)) return childIds.includes(id);
    return false;
  };
  if (roomRootId && !isKnownChild(roomRootId)) return roomRootId;
  if (usedSessionId && !isKnownChild(usedSessionId)) return usedSessionId;
  if (resultSessionId && !isKnownChild(resultSessionId)) return resultSessionId;
  return roomRootId || usedSessionId || '';
}

/**
 * Scope helpers to the parent session. `result.sessionId` is the SDK handle id
 * (root), so an omitted scope still drops child notifications.
 * @param {unknown} result
 * @param {unknown} [scope]
 * @returns {string}
 */
function resolveScopedRootId(result, scope) {
  const pinned = normalizeRootSessionId(scope);
  if (pinned) return pinned;
  const rec = asRecord(result);
  return rec ? String(rec.sessionId || '').trim() : '';
}

/**
 * @param {unknown} event
 * @returns {Record<string, unknown> | null}
 */
function readTurnEndReason(event) {
  const rec = asRecord(event);
  if (!rec || rec.type !== 'turn/end') return null;
  const data = asRecord(rec.data);
  return asRecord(data?.reason) || asRecord(rec.reason);
}

/**
 * @param {Record<string, unknown> | null} reason
 * @returns {string}
 */
function readErrorMessageFromReason(reason) {
  if (!reason || reason.kind !== 'error') return '';
  const failure = asRecord(reason.error) || asRecord(reason.failure);
  if (failure && typeof failure.message === 'string' && failure.message.trim()) {
    return failure.message.trim();
  }
  if (typeof reason.message === 'string' && reason.message.trim()) return reason.message.trim();
  return '';
}

/**
 * @param {Record<string, unknown> | null} reason
 * @returns {string}
 */
function readCancelMessage(reason) {
  const raw = reason?.reason;
  const cause = typeof raw === 'string' ? raw.trim() : String(asRecord(raw)?.kind || '').trim();
  return cause ? `DeepSeek turn was cancelled (${cause}).` : 'DeepSeek turn was cancelled.';
}

/**
 * @param {Record<string, unknown> | null} reason
 * @returns {string}
 */
function readFailureMessage(reason) {
  if (!reason) return '';
  const direct = readErrorMessageFromReason(reason);
  if (direct) return direct;
  switch (String(reason.kind || '')) {
    case 'blocked':
      return `${DEEPSEEK_INCOMPLETE_RUN_PREFIX}: the turn was blocked.`;
    case 'max-tokens':
      return `${DEEPSEEK_INCOMPLETE_RUN_PREFIX}: the output-token limit was reached.`;
    case 'interrupted':
      return `${DEEPSEEK_INCOMPLETE_RUN_PREFIX}: the turn was interrupted by crash recovery.`;
    default:
      return '';
  }
}

/**
 * Unwrap one SDK notification into a session event, dropping child sessions.
 * `result.events` already holds root events only; this is for `result.notifications`,
 * which covers the whole subscription tree.
 *
 * @param {unknown} notification
 * @param {string} rootSessionId
 * @returns {unknown}
 */
function readNotificationEvent(notification, rootSessionId) {
  const rec = asRecord(notification);
  if (!rec) return null;
  if (rec.method === 'session.event') {
    const params = asRecord(rec.params);
    const sessionId = params ? String(params.sessionId ?? '').trim() : '';
    if (rootSessionId && sessionId && sessionId !== rootSessionId) return null;
    return params?.event ?? null;
  }
  return rec.event ?? rec;
}

/**
 * @param {unknown} result
 * @param {string} rootSessionId
 * @returns {unknown[]}
 */
function listRunEvents(result, rootSessionId) {
  const rec = asRecord(result);
  if (!rec) return [];
  const events = Array.isArray(rec.events) ? rec.events : [];
  const notifications = Array.isArray(rec.notifications) ? rec.notifications : [];
  const out = [...events];
  for (const notification of notifications) {
    const event = readNotificationEvent(notification, rootSessionId);
    if (event) out.push(event);
  }
  return out;
}

/**
 * Last terminal turn/end of the root session, or null when the turn never ended.
 * @param {unknown} result
 * @param {unknown} [scope]
 * @returns {Record<string, unknown> | null}
 */
export function readDeepSeekTurnEndReason(result, scope = {}) {
  const rootSessionId = resolveScopedRootId(result, scope);
  const events = listRunEvents(result, rootSessionId);
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const reason = readTurnEndReason(events[i]);
    if (reason) return reason;
  }
  return null;
}

/**
 * Failure message of the terminal turn/end, or '' when it did not fail.
 * @param {unknown} result
 * @param {unknown} [scope]
 * @returns {string}
 */
export function readDeepSeekTurnEndError(result, scope = {}) {
  const reason = readDeepSeekTurnEndReason(result, scope);
  const kind = String(reason?.kind || '');
  if (!FAILURE_REASON_KINDS.has(kind)) return '';
  return readFailureMessage(reason) || `${DEEPSEEK_INCOMPLETE_RUN_PREFIX} (${kind}).`;
}

/**
 * @param {unknown} message
 * @returns {boolean}
 */
export function isDeepSeekSessionCollision(message) {
  const text = String(message || '').toLowerCase();
  if (!text) return false;
  return text.includes('id collision') || text.includes('already has a persisted log');
}

/**
 * A delivered assistant answer — the only trustworthy success signal when the
 * terminal reason is missing or unknown.
 * @param {unknown} result
 * @param {unknown} [scope]
 * @returns {boolean}
 */
export function hasDeepSeekAssistantText(result, scope = {}) {
  const rec = asRecord(result);
  if (rec && typeof rec.finalResponse === 'string' && rec.finalResponse.trim()) return true;
  const events = listRunEvents(result, resolveScopedRootId(result, scope));
  return events.some((event) => {
    const item = asRecord(event);
    if (!item || item.type !== 'assistant/message') return false;
    const message = asRecord(asRecord(item.data)?.message);
    const content = Array.isArray(message?.content) ? message.content : [];
    return content.some((block) => {
      const rec2 = asRecord(block);
      return rec2?.type === 'text' && String(rec2.text || '').trim();
    });
  });
}

/**
 * Whether the root turn produced side effects that must not be replayed.
 * Chunks (including reasoning deltas) are deliberately excluded.
 * @param {unknown} result
 * @param {unknown} [scope]
 * @returns {boolean}
 */
export function hasDeepSeekTurnWork(result, scope = {}) {
  const events = listRunEvents(result, resolveScopedRootId(result, scope));
  return events.some((event) => {
    const type = String(asRecord(event)?.type || '');
    return type === 'assistant/message' || type === 'tool/call' || type === 'tool/result';
  });
}

/**
 * Retry only on a proven session collision, once, and only when the root turn
 * produced no side effects. An empty idle with no collision is an error, not a
 * reason to replay the user's prompt.
 *
 * @param {unknown} result
 * @param {string} [usedSessionId]
 * @param {unknown} [scope]
 * @returns {boolean}
 */
export function shouldRetryDeepSeekRunWithoutSession(result, usedSessionId = '', scope = {}) {
  if (!String(usedSessionId || '').trim()) return false;
  const rootSessionId = resolveScopedRootId(result, scope) || String(usedSessionId).trim();
  const reason = readDeepSeekTurnEndReason(result, { rootSessionId });
  if (String(reason?.kind || '') !== 'error') return false;
  if (!isDeepSeekSessionCollision(readErrorMessageFromReason(reason))) return false;
  if (hasDeepSeekTurnWork(result, { rootSessionId })) return false;
  return true;
}

/**
 * @param {unknown} result
 * @param {unknown} [scope]
 * @returns {{ status: 'completed' | 'error' | 'cancelled', errorMessage: string, reasonKind: string, isSessionCollision: boolean }}
 */
export function resolveDeepSeekRunStatus(result, scope = {}) {
  const rootSessionId = resolveScopedRootId(result, scope);
  const scoped = rootSessionId ? { rootSessionId } : {};
  const reason = readDeepSeekTurnEndReason(result, scoped);
  const kind = String(reason?.kind || '');

  if (SUCCESS_REASON_KINDS.has(kind)) {
    return { status: 'completed', errorMessage: '', reasonKind: kind, isSessionCollision: false };
  }
  if (CANCEL_REASON_KINDS.has(kind)) {
    return { status: 'cancelled', errorMessage: readCancelMessage(reason), reasonKind: kind, isSessionCollision: false };
  }
  if (FAILURE_REASON_KINDS.has(kind)) {
    const errorMessage = readFailureMessage(reason) || `${DEEPSEEK_INCOMPLETE_RUN_PREFIX} (${kind}).`;
    return {
      status: 'error',
      errorMessage,
      reasonKind: kind,
      isSessionCollision: isDeepSeekSessionCollision(errorMessage),
    };
  }
  if (kind) {
    // Protocol is merge-extensible: an unknown kind is only a success when an
    // answer was actually delivered, otherwise it must surface as a failure.
    if (hasDeepSeekAssistantText(result, scoped)) {
      return { status: 'completed', errorMessage: '', reasonKind: kind, isSessionCollision: false };
    }
    return {
      status: 'error',
      errorMessage: `${DEEPSEEK_INCOMPLETE_RUN_PREFIX} (unknown reason "${kind}").`,
      reasonKind: kind,
      isSessionCollision: false,
    };
  }
  if (hasDeepSeekAssistantText(result, scoped)) {
    return { status: 'completed', errorMessage: '', reasonKind: '', isSessionCollision: false };
  }
  return { status: 'error', errorMessage: DEEPSEEK_EMPTY_RUN_ERROR, reasonKind: '', isSessionCollision: false };
}
