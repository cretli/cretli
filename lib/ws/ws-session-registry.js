/** @type {Map<string, Set<import('ws').WebSocket>>} */
const sessionSockets = new Map();

/**
 * @param {string} sessionId
 * @param {import('ws').WebSocket} ws
 * @returns {void}
 */
export function registerSessionWebSocket(sessionId, ws) {
  if (typeof sessionId !== 'string' || !sessionId || !ws) return;
  let sockets = sessionSockets.get(sessionId);
  if (!sockets) {
    sockets = new Set();
    sessionSockets.set(sessionId, sockets);
  }
  sockets.add(ws);
}

/**
 * @param {string} sessionId
 * @param {import('ws').WebSocket} ws
 * @returns {void}
 */
export function unregisterSessionWebSocket(sessionId, ws) {
  if (typeof sessionId !== 'string' || !sessionId || !ws) return;
  const sockets = sessionSockets.get(sessionId);
  if (!sockets) return;
  sockets.delete(ws);
  if (sockets.size === 0) sessionSockets.delete(sessionId);
}

/**
 * @param {string[]} sessionIds
 * @param {number} [closeCode]
 * @param {string} [closeReason]
 * @returns {number}
 */
export function revokeSessionWebSockets(sessionIds, closeCode = 4401, closeReason = 'session ended') {
  let closedCount = 0;
  for (const sessionId of sessionIds) {
    const sockets = sessionSockets.get(sessionId);
    if (!sockets) continue;
    for (const ws of sockets) {
      try {
        ws.close(closeCode, closeReason);
        closedCount += 1;
      } catch {
        // socket may already be gone
      }
    }
    sessionSockets.delete(sessionId);
  }
  return closedCount;
}

/**
 * @param {number} [closeCode]
 * @param {string} [closeReason]
 * @returns {number}
 */
export function revokeAllSessionWebSockets(closeCode = 4401, closeReason = 'session ended') {
  const sessionIds = [...sessionSockets.keys()];
  return revokeSessionWebSockets(sessionIds, closeCode, closeReason);
}

/**
 * Clears the registry (tests only).
 * @returns {void}
 */
export function __clearSessionWebSocketRegistryForTest() {
  sessionSockets.clear();
}

/**
 * Socket count for tests (one session, or the whole registry when sessionId is omitted).
 * @param {string} [sessionId]
 * @returns {number}
 */
export function __countSessionWebSocketsForTest(sessionId) {
  if (typeof sessionId === 'string' && sessionId) {
    return sessionSockets.get(sessionId)?.size || 0;
  }
  let count = 0;
  for (const sockets of sessionSockets.values()) count += sockets.size;
  return count;
}
