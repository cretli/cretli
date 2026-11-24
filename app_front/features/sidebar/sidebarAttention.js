import { resolveFinishedReadMeta } from '../chat/chatStatusMeta.js';

/**
 * What the closed drawer should signal on the hamburger button: finished chats the user has not
 * opened yet. Delegation children and the chat on screen do not count; the sidebar rows use the
 * same finished/unread marker.
 *
 * @param {any[]} chats
 * @param {string | null | undefined} activeChatId
 * @returns {number}
 */
export function countUnseenFinishedChats(chats, activeChatId) {
  let count = 0;
  for (const chat of Array.isArray(chats) ? chats : []) {
    if (!chat || chat.id === activeChatId) continue;
    if (chat.delegationParentChatId || chat.delegationRootChatId) continue;
    if (resolveFinishedReadMeta(chat)?.tone === 'finished') count += 1;
  }
  return count;
}
