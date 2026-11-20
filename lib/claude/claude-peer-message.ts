import { basename } from 'path';
import { peekChatsAsync } from '../persist/chats-persist.js';
import { appendChatHistoryEvents } from '../persist/chat-history-service.js';
import { broadcastChatHistoryUpdate } from '../sdk/sdk-history-updates.ts';

const CHAT_NAME_MARKER = /-chat-([0-9a-f]{8})(?:$|[^0-9a-f])/i;

/**
 * Name other sessions see in `ListAgents` and in a delivered message. It keeps
 * the folder for people and models, and carries the chat id prefix because the
 * CLI reports nothing else that leads back to a Cretli chat.
 */
export function resolveClaudeSessionName(chatId: unknown, cwd: unknown): string {
  const prefix = String(chatId || '').slice(0, 8);
  const folder = basename(String(cwd || '')).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return `${folder ? `${folder}-` : ''}chat-${prefix}`;
}

/** The name is asserted by the sender, so the chat it resolves to is only a link. */
export function resolveClaudePeerChat(fromName: unknown, chats: Array<Record<string, any>>): Record<string, any> | null {
  const prefix = CHAT_NAME_MARKER.exec(String(fromName || ''))?.[1]?.toLowerCase();
  if (!prefix) return null;
  return chats.find((chat) => String(chat?.id || '').startsWith(prefix)) || null;
}

/** Stores the delivery as a mailbox card, the same record delegation messages use. */
export async function recordClaudePeerMessage(
  chatId: string,
  peer: { id: string, fromName: string, body: string },
): Promise<void> {
  const fromChat = resolveClaudePeerChat(peer.fromName, await peekChatsAsync());
  const payload = JSON.stringify({
    id: peer.id,
    kind: 'peer',
    status: 'delivered',
    fromChatId: String(fromChat?.id || ''),
    fromTitle: String(fromChat?.title || '').trim() || peer.fromName,
    toChatId: chatId,
    body: peer.body,
  });
  try {
    const result = await appendChatHistoryEvents(chatId, '', [
      { rec: { kind: 'meta', variant: 'mailbox', payload } },
    ], { priority: 'final' });
    if (result?.ok) broadcastChatHistoryUpdate(chatId, result.appended, result.identity);
  } catch (error) {
    const failure = error as { code?: string, message?: string };
    console.warn(`[claude-peer-message] card for ${chatId} not stored (${failure?.code || 'error'}): ${failure?.message || error}`);
  }
}
