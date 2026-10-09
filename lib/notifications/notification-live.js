/**
 * Live fan-out for the in-app notification centre (global chat-list WebSocket channel).
 */

import { listChatListUpdateClients, sendChatListClientMessage } from '../chat-list-updates.js';

/**
 * @param {{ revision: number, reason?: string }} payload
 * @returns {void}
 */
export function broadcastNotificationsChanged(payload) {
  const revision = Number(payload?.revision);
  if (!Number.isFinite(revision) || revision < 0) return;
  const reason = typeof payload?.reason === 'string' && payload.reason.trim()
    ? payload.reason.trim()
    : 'update';
  const message = JSON.stringify({
    type: 'notificationsChanged',
    revision,
    reason,
  });
  for (const [ws] of listChatListUpdateClients()) {
    sendChatListClientMessage(ws, message);
  }
}
