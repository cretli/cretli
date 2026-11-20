/** Notify connected chat views about history written outside their agent stream. */
type ChatHistoryClient = {
  readyState: number;
  send(data: string): void;
  once(event: string, listener: () => void): unknown;
};

const clientsByChat = new Map<string, Set<ChatHistoryClient>>();

export function hasChatClients(chatId: string): boolean {
  return [...(clientsByChat.get(chatId) || [])].some((ws) => ws.readyState === 1);
}

export function subscribeChatHistoryUpdates(chatId: string, ws: ChatHistoryClient) {
  if (!chatId || !ws) return;
  let clients = clientsByChat.get(chatId);
  if (!clients) clientsByChat.set(chatId, (clients = new Set()));
  if (clients.has(ws)) return;
  clients.add(ws);
  ws.once('close', () => unsubscribeChatHistoryUpdates(chatId, ws));
}

export function unsubscribeChatHistoryUpdates(chatId: string, ws: ChatHistoryClient) {
  const clients = clientsByChat.get(chatId);
  if (!clients) return;
  clients.delete(ws);
  if (clients.size === 0) clientsByChat.delete(chatId);
}

/**
 * @param identity per-chat history identity of the write (SQLite backend); a
 *   client compares it with the one it holds and re-pulls on a change
 */
export function broadcastChatHistoryUpdate(
  chatId: string,
  appended: Array<{ seq: number; rec: Record<string, unknown> }> = [],
  identity: { datasetGeneration?: string; chatEpoch?: string } | null = null,
) {
  const records = appended.map(({ seq, rec }) => ({ ...rec, historySeq: seq }));
  for (const ws of clientsByChat.get(chatId) || []) {
    if (ws.readyState !== 1) continue;
    try {
      ws.send(JSON.stringify({ type: 'sdkHistoryChanged', records, ...(identity ? { identity } : {}) }));
    } catch {
      // The persisted history remains available to reconnect/poll catch-up.
    }
  }
}
