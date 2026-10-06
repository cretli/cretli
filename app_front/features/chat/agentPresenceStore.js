/**
 * Agent presence remembered per chat id.
 *
 * Presence used to live only as `_serverRunState` on a chat object, and every apply walked
 * the *current* `chats` array, so any id the client did not have yet was dropped: the
 * subscription snapshot lands while `GET /api/chats` is still in flight, a delegation
 * sub-chat is appended a moment later, and the server re-sends a row only when its
 * fingerprint changes. This store keeps what the server said about every id, so a chat
 * object created afterwards can be painted synchronously — before the sidebar renders it.
 *
 * Never persisted. After a reload the server snapshot is the only source of truth, and a
 * cached "busy" would be worse than a momentary absence.
 */

/**
 * @typedef {object} AgentPresenceRow
 * @property {object | null} state
 * @property {number} at
 */

/** @type {Map<string, AgentPresenceRow>} */
const rows = new Map();

/**
 * Presence identity: two rows with the same key render the same sidebar status, so a frame
 * that changes nothing visible must not mark a chat row dirty.
 *
 * @param {object | null | undefined} row
 * @returns {string}
 */
export function agentRunStateDedupeKey(row) {
  if (!row) return '';
  return [
    row.state || '',
    row.delegationId || '',
    row.attention === true ? '1' : '0',
    String(row.waitingAgentCount || 0),
    row.activityKey || '',
    row.activityArg || '',
    String(row.inFlightChildCount ?? 0),
  ].join(':');
}

/**
 * @param {unknown} chatId
 * @returns {string}
 */
function readChatId(chatId) {
  return String(chatId || '').trim();
}

/**
 * @param {unknown} now
 * @returns {number}
 */
function readAt(now) {
  const value = Number(now);
  return Number.isFinite(value) && value > 0 ? value : Date.now();
}

/**
 * @param {Record<string, object> | null | undefined} states
 * @returns {Record<string, object>}
 */
function readStates(states) {
  return states && typeof states === 'object' ? states : {};
}

/**
 * Records a complete map from an authoritative source (the WS subscription snapshot or the
 * full `GET /api/chats/agent-states` response). An id the map does not name is idle.
 *
 * The replacement covers the whole store, not only the chats currently in the list, and an
 * absent id keeps a stamped idle row rather than losing its entry: `_serverRunStateAt` is the
 * watermark that rejects an older push-inbox record, so it has to outlive the chat being
 * unknown to this client.
 *
 * @param {Record<string, object> | null | undefined} states
 * @param {number} [now] watermark shared with the chat objects painted in the same pass
 * @param {{ ifRowAtOrBefore?: number }} [options] when set, ids whose remembered row is newer
 *   than the given time are left alone: an HTTP snapshot requested before a later WS frame
 *   must not roll that frame back.
 * @returns {number} the watermark every touched id now carries
 */
export function applySnapshot(states, now = Date.now(), options = {}) {
  const at = readAt(now);
  const incoming = readStates(states);
  const floor = Number(options?.ifRowAtOrBefore);
  const hasFloor = Number.isFinite(floor) && floor > 0;
  const named = new Set();
  for (const rawId of Object.keys(incoming)) {
    const id = readChatId(rawId);
    if (!id) continue;
    if (hasFloor && (rows.get(id)?.at || 0) > floor) continue;
    named.add(id);
    rows.set(id, { state: incoming[rawId] || null, at });
  }
  for (const [id, row] of rows) {
    if (named.has(id)) continue;
    if (hasFloor && row.at > floor) continue;
    row.state = null;
    row.at = at;
  }
  return at;
}

/**
 * The HTTP agent-states response is a complete authoritative map too, so it shares the
 * snapshot semantics. Kept as its own name because it is a different producer.
 *
 * `options.ifRowAtOrBefore` carries the HTTP request start time for the gap fallback:
 * a chat that received a newer WS frame while the request was in flight keeps it.
 *
 * @param {Record<string, object> | null | undefined} states
 * @param {number} [now]
 * @param {{ ifRowAtOrBefore?: number }} [options]
 * @returns {number}
 */
export function applyHttpStates(states, now = Date.now(), options = {}) {
  return applySnapshot(states, now, options);
}

/**
 * Records a WS delta. Only the named ids move; ids this client has never heard of are still
 * remembered, so their row lands on the chat object the moment that object exists.
 *
 * @param {Record<string, object> | null | undefined} states
 * @param {string[] | null | undefined} cleared
 * @param {number} [now]
 * @returns {number}
 */
export function applyDelta(states, cleared, now = Date.now()) {
  const at = readAt(now);
  const incoming = readStates(states);
  for (const rawId of Object.keys(incoming)) {
    const id = readChatId(rawId);
    if (!id) continue;
    rows.set(id, { state: incoming[rawId] || null, at });
  }
  for (const rawId of Array.isArray(cleared) ? cleared : []) {
    const id = readChatId(rawId);
    if (!id) continue;
    rows.set(id, { state: null, at });
  }
  return at;
}

/**
 * @param {string} chatId
 * @returns {object | null} the remembered presence; `null` when the server says idle
 */
export function get(chatId) {
  const row = rows.get(readChatId(chatId));
  return row ? row.state : null;
}

/**
 * Paints the remembered presence onto a chat object that was just built (a server list row or
 * a boot-cache row). Returns whether the visible status changed so the caller can refresh
 * exactly those sidebar rows — the list fingerprint ignores `_serverRunState`, so a hydrating
 * reload can otherwise skip the repaint entirely.
 *
 * @param {object | null | undefined} chat
 * @returns {boolean}
 */
export function hydrateChat(chat) {
  if (!chat || typeof chat !== 'object') return false;
  const id = readChatId(chat.id);
  if (!id) return false;
  const row = rows.get(id);
  if (!row) return false;
  const localAt = Number(chat._serverRunStateAt);
  if (Number.isFinite(localAt) && localAt > 0 && localAt >= row.at) return false;
  chat._serverRunStateAt = row.at;
  if (agentRunStateDedupeKey(chat._serverRunState) === agentRunStateDedupeKey(row.state)) {
    return false;
  }
  chat._serverRunState = row.state;
  return true;
}

/**
 * A deleted chat has no presence left to remember.
 *
 * @param {string} chatId
 * @returns {boolean} true when an entry was dropped
 */
export function forget(chatId) {
  return rows.delete(readChatId(chatId));
}

/**
 * Tests only.
 * @returns {void}
 */
export function __resetAgentPresenceStoreForTest() {
  rows.clear();
}
