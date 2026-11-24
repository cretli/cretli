/** Ordering of the flat "all chats" view: most recently opened first. */

import { getChatLastUsedAt } from '../chat/chatStore.js';

/**
 * When the chat was last opened: the server-synced `lastSeenAt` (stamped on open,
 * shared by every device) or this device's own last-used time, whichever is newer.
 * Generic activity is deliberately not used: it also counts background agent output,
 * which would float old chats with a running agent to the top.
 *
 * @param {any} chat
 * @returns {number}
 */
export function chatOpenedMs(chat) {
  const seen = typeof chat?.lastSeenAt === 'string' ? Date.parse(chat.lastSeenAt) : 0;
  return Math.max(Number.isFinite(seen) ? seen : 0, getChatLastUsedAt(chat?.id));
}

/**
 * @param {any} chat
 * @returns {number}
 */
function changedMs(chat) {
  const parse = (value) => {
    const ms = typeof value === 'string' && value ? Date.parse(value) : 0;
    return Number.isFinite(ms) ? ms : 0;
  };
  return Math.max(parse(chat?.updatedAt), parse(chat?.createdAt));
}

/**
 * Newest-opened first; chats never opened fall back to the server change time.
 * Favorites go first when `isFavorite` says so.
 *
 * @param {any[]} chats
 * @param {(chat: any) => boolean} [isFavorite]
 * @returns {any[]}
 */
export function sortChatsByOpened(chats, isFavorite = () => false) {
  return chats
    .map((chat, idx) => ({ chat, idx, fav: isFavorite(chat) ? 1 : 0, opened: chatOpenedMs(chat), changed: changedMs(chat) }))
    .sort((a, b) => (b.fav - a.fav) || (b.opened - a.opened) || (b.changed - a.changed) || (a.idx - b.idx))
    .map((entry) => entry.chat);
}
