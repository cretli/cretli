/**
 * Clickable parent/child chat links stored in chat history.
 * Written when a harness creates a child, forks a conversation, or nests a chat.
 */

import { appendChatHistoryEvents, loadChatHistory } from './persist/chat-history-persist.js';
import { markChatHasPendingDelegation } from './persist/chat-history-revisions.js';
import { parseRelatedChatPayload } from './chat-relation-payload.js';

export { parseRelatedChatPayload };

/**
 * @param {unknown} chat
 * @returns {boolean}
 */
function shouldSkipRelatedChat(chat) {
  if (!chat || typeof chat !== 'object') return true;
  if (chat.isTemporary === true) return true;
  const forkKind = String(chat.forkKind || '').trim();
  return forkKind === 'title' || forkKind === 'summary';
}

/**
 * @param {string} chatId
 * @param {{ role: string, relatedChatId: string }} query
 * @returns {boolean}
 */
function hasRelatedChatHistoryEvent(chatId, query) {
  const events = loadChatHistory(chatId)?.events || [];
  return events.some((row) => {
    if (row.rec?.variant !== 'relatedChat') return false;
    const data = parseRelatedChatPayload(row.rec.payload);
    if (!data) return false;
    return data.role === query.role && data.chatId === query.relatedChatId;
  });
}

/**
 * @param {object} chat
 * @param {{ role: 'parent' | 'child', chatId: string, title: string, reason: string }} link
 */
function appendRelatedChatEvent(chat, link) {
  const chatId = String(chat?.id || '').trim();
  if (!chatId) return;
  if (hasRelatedChatHistoryEvent(chatId, { role: link.role, relatedChatId: link.chatId })) return;
  const result = appendChatHistoryEvents(chatId, String(chat.cursorSessionId || ''), [
    {
      rec: {
        kind: 'meta',
        variant: 'relatedChat',
        payload: JSON.stringify(link),
      },
    },
  ]);
  if (result?.ok) markChatHasPendingDelegation(chatId);
}

/**
 * Persist a child-chat link on the parent and a parent-chat link on the child.
 *
 * @param {{
 *   parentChat?: object,
 *   childChat?: object,
 *   reason?: string,
 * }} input
 * @returns {{ ok: boolean }}
 */
export function appendRelatedChatHistoryLinks(input = {}) {
  const parentChat = input.parentChat;
  const childChat = input.childChat;
  const parentId = String(parentChat?.id || '').trim();
  const childId = String(childChat?.id || '').trim();
  if (!parentId || !childId || parentId === childId) return { ok: false };
  if (shouldSkipRelatedChat(parentChat) || shouldSkipRelatedChat(childChat)) return { ok: false };
  const reason = String(input.reason || childChat.forkKind || 'fork').trim() || 'fork';
  appendRelatedChatEvent(parentChat, {
    role: 'child',
    chatId: childId,
    title: String(childChat.title || '').trim(),
    reason,
  });
  appendRelatedChatEvent(childChat, {
    role: 'parent',
    chatId: parentId,
    title: String(parentChat.title || '').trim(),
    reason,
  });
  return { ok: true };
}
