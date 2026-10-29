import { listChatListUpdateClients, sendChatListClientMessage } from '../chat-list-updates.js';

export function broadcastDecisionsChanged({ revision }) {
  if (!Number.isSafeInteger(revision) || revision < 0) return;
  const message = JSON.stringify({ type: 'decisionsChanged', revision });
  for (const [ws, client] of listChatListUpdateClients()) {
    if (client.scope.kind === 'session') sendChatListClientMessage(ws, message);
  }
}
