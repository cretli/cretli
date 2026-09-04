import { getChatActivityAt } from './chatStore.js';

function parseIsoMs(value) {
  if (typeof value !== 'string' || !value.trim()) return 0;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * @param {object | null | undefined} chat
 * @returns {number}
 */
export function getChatUpdatedAtMs(chat) {
  if (!chat) return 0;
  const updatedAt = parseIsoMs(chat.updatedAt);
  if (updatedAt > 0) return updatedAt;
  const activityAt = getChatActivityAt(chat);
  if (activityAt > 0) return activityAt;
  return parseIsoMs(chat.createdAt);
}

/**
 * @param {object | null | undefined} chat
 * @returns {number}
 */
export function getChatCreatedAtMs(chat) {
  return parseIsoMs(chat?.createdAt);
}

/**
 * Sort chats by modification date, then creation date (newest first).
 * Favorites do not affect order.
 *
 * @param {object[]} chats
 * @returns {object[]}
 */
export function sortChatsByDate(chats) {
  if (!Array.isArray(chats) || !chats.length) return [];
  return chats
    .map((chat, idx) => ({ chat, idx }))
    .sort((a, b) => {
      const updatedA = getChatUpdatedAtMs(a.chat);
      const updatedB = getChatUpdatedAtMs(b.chat);
      if (updatedB !== updatedA) return updatedB - updatedA;
      const createdA = getChatCreatedAtMs(a.chat);
      const createdB = getChatCreatedAtMs(b.chat);
      if (createdB !== createdA) return createdB - createdA;
      return a.idx - b.idx;
    })
    .map((entry) => entry.chat);
}
