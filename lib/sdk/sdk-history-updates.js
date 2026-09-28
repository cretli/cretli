/** Notify connected chat views about history written outside their agent stream. */
const clientsByChat = new Map();

export function subscribeChatHistoryUpdates(chatId, ws) {
  if (!chatId || !ws) return;
  let clients = clientsByChat.get(chatId);
  if (!clients) clientsByChat.set(chatId, (clients = new Set()));
  if (clients.has(ws)) return;
  clients.add(ws);
  ws.once('close', () => unsubscribeChatHistoryUpdates(chatId, ws));
}

export function unsubscribeChatHistoryUpdates(chatId, ws) {
  const clients = clientsByChat.get(chatId);
  if (!clients) return;
  clients.delete(ws);
  if (clients.size === 0) clientsByChat.delete(chatId);
}

export function broadcastChatHistoryUpdate(chatId, appended = []) {
  const records = appended.map(({ seq, rec }) => ({ ...rec, historySeq: seq }));
  for (const ws of clientsByChat.get(chatId) || []) {
    if (ws.readyState !== 1) continue;
    try {
      ws.send(JSON.stringify({ type: 'sdkHistoryChanged', records }));
    } catch {
      // The persisted history remains available to reconnect/poll catch-up.
    }
  }
}
