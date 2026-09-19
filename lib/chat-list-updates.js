/**
 * Notify connected chat UIs when the chat list changes outside their own
 * HTTP request (MCP archive, CLI, another device).
 */

/** @type {Set<import('ws').WebSocket>} */
const clients = new Set();

/**
 * @param {import('ws').WebSocket} ws
 * @returns {void}
 */
export function subscribeChatListUpdates(ws) {
  if (!ws) return;
  if (clients.has(ws)) return;
  clients.add(ws);
  ws.once('close', () => unsubscribeChatListUpdates(ws));
}

/**
 * @param {import('ws').WebSocket} ws
 * @returns {void}
 */
export function unsubscribeChatListUpdates(ws) {
  clients.delete(ws);
}

/**
 * @param {{ reason?: string, chatId?: string|null }} [payload]
 * @returns {void}
 */
export function broadcastChatListChanged(payload = {}) {
  const reason = typeof payload.reason === 'string' && payload.reason.trim()
    ? payload.reason.trim()
    : 'update';
  const chatId = typeof payload.chatId === 'string' && payload.chatId.trim()
    ? payload.chatId.trim()
    : null;
  const message = JSON.stringify({ type: 'chatsChanged', reason, chatId });
  for (const ws of clients) {
    if (ws.readyState !== 1) continue;
    try {
      ws.send(message);
    } catch {
      // The persisted list remains available on the next GET /api/chats.
    }
  }
}

/**
 * Clears subscribers (tests only).
 * @returns {void}
 */
export function __clearChatListUpdateClientsForTest() {
  clients.clear();
}
