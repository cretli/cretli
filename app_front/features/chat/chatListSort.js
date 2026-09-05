import { getChatActivityAt } from './chatStore.js';

function parseIsoMs(value) {
  if (typeof value !== 'string' || !value.trim()) return 0;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Most recent of server updatedAt, local last-use/activity, and createdAt.
 *
 * @param {object | null | undefined} chat
 * @returns {number}
 */
export function getChatUpdatedAtMs(chat) {
  if (!chat) return 0;
  return Math.max(
    parseIsoMs(chat.updatedAt),
    getChatActivityAt(chat),
    parseIsoMs(chat.createdAt)
  );
}

/**
 * @param {object | null | undefined} chat
 * @returns {number}
 */
export function getChatCreatedAtMs(chat) {
  return parseIsoMs(chat?.createdAt);
}

/**
 * Stable order by creation date (newest first). Deliberately ignores
 * updatedAt / local activity so opening a chat never reorders the list.
 *
 * @param {{ chat: object, idx: number }} a
 * @param {{ chat: object, idx: number }} b
 * @returns {number}
 */
function compareChatsByCreation(a, b) {
  const createdA = getChatCreatedAtMs(a.chat);
  const createdB = getChatCreatedAtMs(b.chat);
  if (createdB !== createdA) return createdB - createdA;
  return a.idx - b.idx;
}

/**
 * Sort chats by creation date (newest first). The order is stable — opening
 * a chat or receiving output does not move it in the list.
 *
 * @param {object[]} chats
 * @returns {object[]}
 */
export function sortChatsByDate(chats) {
  if (!Array.isArray(chats) || !chats.length) return [];
  return chats
    .map((chat, idx) => ({ chat, idx }))
    .sort(compareChatsByCreation)
    .map((entry) => entry.chat);
}

/**
 * Favorites first, then creation order (newest first). Stable regardless of
 * clicks or activity.
 *
 * @param {object[]} chats
 * @param {(chat: object) => boolean} [isFavorite]
 * @returns {object[]}
 */
export function sortChatsByFavoriteThenDate(chats, isFavorite = () => false) {
  if (!Array.isArray(chats) || !chats.length) return [];
  const favoriteOf = typeof isFavorite === 'function' ? isFavorite : () => false;
  return chats
    .map((chat, idx) => ({ chat, idx }))
    .sort((a, b) => {
      const favA = favoriteOf(a.chat) ? 1 : 0;
      const favB = favoriteOf(b.chat) ? 1 : 0;
      if (favA !== favB) return favB - favA;
      return compareChatsByCreation(a, b);
    })
    .map((entry) => entry.chat);
}
