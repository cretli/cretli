/**
 * Clickable parent/child chat links stored in chat history.
 * Written when a harness creates a child, forks a conversation, or nests a chat.
 */

import { appendChatHistoryEvents, loadChatHistory } from './persist/chat-history-service.js';
import { markChatHasPendingDelegation } from './persist/chat-history-revisions.js';
import { broadcastChatHistoryUpdate } from './sdk/sdk-history-updates.ts';
import { parseRelatedChatPayload } from './chat-relation-payload.js';

export { parseRelatedChatPayload };

/**
 * @param {Record<string, any> | null | undefined} chat
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
 * @returns {Promise<boolean>}
 */
async function hasRelatedChatHistoryEvent(chatId, query) {
  const events = (await loadChatHistory(chatId))?.events || [];
  return events.some((row) => {
    if (row.rec?.variant !== 'relatedChat') return false;
    const data = parseRelatedChatPayload(row.rec.payload);
    if (!data) return false;
    return data.role === query.role && data.chatId === query.relatedChatId;
  });
}

/**
 * @param {Record<string, any>} chat
 * @param {{ role: 'parent' | 'child', chatId: string, title: string, reason: string }} link
 */
async function appendRelatedChatEvent(chat, link) {
  const chatId = String(chat?.id || '').trim();
  if (!chatId) return;
  if (await hasRelatedChatHistoryEvent(chatId, { role: link.role, relatedChatId: link.chatId })) return;
  let result;
  try {
    result = await appendChatHistoryEvents(chatId, String(chat.cursorSessionId || ''), [
      {
        rec: {
          kind: 'meta',
          variant: 'relatedChat',
          payload: JSON.stringify(link),
        },
      },
    ]);
  } catch (error) {
    // The link card is derived metadata and deduplicated by its content: a later fork/relink writes it again.
    console.warn(`[chat-relation-history] link card for ${chatId} not stored (${error?.code || 'error'}): ${error?.message || error}`);
    return;
  }
  if (result?.ok) {
    markChatHasPendingDelegation(chatId);
    broadcastChatHistoryUpdate(chatId, result.appended, result.identity);
  }
}

/**
 * Persist a child-chat link on the parent and a parent-chat link on the child.
 *
 * @param {{
 *   parentChat?: Record<string, any>,
 *   childChat?: Record<string, any>,
 *   reason?: string,
 * }} input
 * @returns {Promise<{ ok: boolean }>}
 */
export async function appendRelatedChatHistoryLinks(input = {}) {
  const parentChat = input.parentChat;
  const childChat = input.childChat;
  const parentId = String(parentChat?.id || '').trim();
  const childId = String(childChat?.id || '').trim();
  if (!parentId || !childId || parentId === childId) return { ok: false };
  if (shouldSkipRelatedChat(parentChat) || shouldSkipRelatedChat(childChat)) return { ok: false };
  const reason = String(input.reason || childChat.forkKind || 'fork').trim() || 'fork';
  await appendRelatedChatEvent(parentChat, {
    role: 'child',
    chatId: childId,
    title: String(childChat.title || '').trim(),
    reason,
  });
  await appendRelatedChatEvent(childChat, {
    role: 'parent',
    chatId: parentId,
    title: String(parentChat.title || '').trim(),
    reason,
  });
  return { ok: true };
}
