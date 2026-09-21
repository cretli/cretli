import {
  CHAT_BACKGROUND_MONITOR_WINDOW_MS,
  CHAT_BACKGROUND_WS_MAX,
} from '../../config.js';
import { isMobileLikeClient } from '../../lib/mobileClient.js';
import { hasLiveHarnessWork } from './chatStatusMeta.js';
import { isPendingContextCompressionChat } from './chatContextCompressionRecovery.js';

/**
 * @param {object | null | undefined} chat
 * @param {(chat: object) => number} getChatActivityAt
 * @param {number} [now]
 * @returns {boolean}
 */
export function isRecentlyActiveChat(chat, getChatActivityAt, now = Date.now()) {
  if (!chat?.cursorSessionId) return false;
  const lastActivityAt = getChatActivityAt(chat);
  if (!Number.isFinite(lastActivityAt) || lastActivityAt <= 0) return false;
  return now - lastActivityAt <= CHAT_BACKGROUND_MONITOR_WINDOW_MS;
}

/**
 * Temporary summary-fork chats must keep WS until the callback agent finishes.
 *
 * @param {object | null | undefined} chat
 * @returns {boolean}
 */
export function isPendingSummaryForkChat(chat) {
  if (!chat?.id || !chat?.cursorSessionId) return false;
  if (chat.isTemporary !== true) return false;
  return chat.forkKind === 'summary';
}

/**
 * Chats with a live harness run must keep WS / monitoring after the user switches away.
 *
 * @param {object | null | undefined} chat
 * @returns {boolean}
 */
export function isLiveAgentChat(chat) {
  if (!chat?.id || !chat?.cursorSessionId) return false;
  return hasLiveHarnessWork(chat);
}

/**
 * @param {object[] | null | undefined} chats
 * @param {string | null | undefined} chatId
 * @returns {boolean}
 */
export function isListedChat(chats, chatId) {
  if (!chatId || !Array.isArray(chats)) return false;
  return chats.some((chat) => chat?.id === chatId);
}

/**
 * @param {object | null | undefined} chat
 * @param {object[] | null | undefined} chats
 * @returns {boolean}
 */
export function shouldKeepChatSocket(chat, chats) {
  if (!chat?.id || chat._remoteDeleted === true) return false;
  return isListedChat(chats, chat.id);
}

/**
 * Chat ids that should keep a live WebSocket (active chat + top recent background slots).
 *
 * @param {object[]} chats
 * @param {() => string | null} getActiveChatId
 * @param {(chat: object) => number} getChatActivityAt
 * @param {number} [now]
 * @returns {Set<string>}
 */
export function selectBackgroundWsChatIds(chats, getActiveChatId, getChatActivityAt, now = Date.now()) {
  const wsChatIds = new Set();
  const activeChatId = getActiveChatId();
  if (activeChatId && isListedChat(chats, activeChatId)) wsChatIds.add(activeChatId);
  const backgroundWsMax = isMobileLikeClient() ? 0 : CHAT_BACKGROUND_WS_MAX;
  const candidates = chats
    .filter((chat) => chat?.id && chat?.cursorSessionId && chat.id !== activeChatId)
    .filter((chat) => isRecentlyActiveChat(chat, getChatActivityAt, now))
    .sort((left, right) => getChatActivityAt(right) - getChatActivityAt(left))
    .slice(0, backgroundWsMax);
  for (const chat of candidates) {
    wsChatIds.add(chat.id);
  }
  for (const chat of chats) {
    if (!isPendingSummaryForkChat(chat)) continue;
    wsChatIds.add(chat.id);
  }
  for (const chat of chats) {
    if (!isPendingContextCompressionChat(chat)) continue;
    wsChatIds.add(chat.id);
  }
  for (const chat of chats) {
    if (!isLiveAgentChat(chat)) continue;
    wsChatIds.add(chat.id);
  }
  return wsChatIds;
}

/**
 * Background history-batch: keep live/active chats even when their workspace
 * is collapsed; skip idle rows that are not in the sidebar DOM.
 *
 * @param {Set<string>} monitoredChatIds
 * @param {object[]} chats
 * @param {{
 *   activeChatId?: string | null,
 *   visibleChatIds?: Set<string> | null,
 * }} [options]
 * @returns {Set<string>}
 */
export function selectHistoryHttpChatIds(monitoredChatIds, chats, options = {}) {
  const monitored = monitoredChatIds instanceof Set ? monitoredChatIds : new Set();
  const visible = options.visibleChatIds instanceof Set ? options.visibleChatIds : new Set();
  const activeChatId = typeof options.activeChatId === 'string' ? options.activeChatId : '';
  const out = new Set();
  for (const chat of Array.isArray(chats) ? chats : []) {
    if (!chat?.id || !monitored.has(chat.id)) continue;
    const isPriority =
      chat.id === activeChatId
      || isLiveAgentChat(chat)
      || chat._serverRunState?.state === 'busy'
      || chat._serverRunState?.state === 'waiting'
      || chat._serverRunState?.state === 'attention';
    if (isPriority || (visible.size > 0 && visible.has(chat.id))) {
      out.add(chat.id);
    }
  }
  return out;
}

/**
 * Chat ids monitored via HTTP history revisions (active + recently active window).
 *
 * @param {object[]} chats
 * @param {() => string | null} getActiveChatId
 * @param {(chat: object) => number} getChatActivityAt
 * @param {number} [now]
 * @returns {Set<string>}
 */
export function selectMonitoredChatIds(chats, getActiveChatId, getChatActivityAt, now = Date.now()) {
  const monitoredChatIds = new Set();
  const activeChatId = getActiveChatId();
  for (const chat of chats) {
    if (!chat?.id || !chat?.cursorSessionId) continue;
    if (
      chat.id === activeChatId
      || isRecentlyActiveChat(chat, getChatActivityAt, now)
      || isLiveAgentChat(chat)
      || chat._serverRunState?.state === 'busy'
      || chat._serverRunState?.state === 'waiting'
      || chat._serverRunState?.state === 'attention'
    ) {
      monitoredChatIds.add(chat.id);
    }
  }
  return monitoredChatIds;
}

/**
 * @param {object | null | undefined} chat
 * @param {Set<string>} wsChatIds
 * @param {Set<string>} monitoredChatIds
 * @param {string | null} activeChatId
 * @returns {'ws-active' | 'ws' | 'poll' | 'none'}
 */
export function resolveBackgroundMonitorMode(chat, wsChatIds, monitoredChatIds, activeChatId) {
  if (!chat?.id) return 'none';
  if (wsChatIds.has(chat.id)) {
    return chat.id === activeChatId ? 'ws-active' : 'ws';
  }
  if (monitoredChatIds.has(chat.id)) return 'poll';
  return 'none';
}

/**
 * Skip HTTP history pull when a live WS already covers this background chat.
 * Pending delegation still forces HTTP even with an open socket.
 *
 * @param {{ monitorMode?: string, hasPendingDelegation?: boolean }} [input]
 * @returns {boolean}
 */
export function shouldSkipBackgroundHistoryHttp(input = {}) {
  if (input.hasPendingDelegation === true) return false;
  const mode = String(input.monitorMode || '');
  return mode === 'ws' || mode === 'ws-active';
}

export const HISTORY_HTTP_MAX_POSTS_PER_POLL = 2;

/**
 * Cap background history-batch posts per poll cycle (chunkSize × maxPosts).
 *
 * @param {unknown[]} jobs
 * @param {{ chunkSize?: number, maxPosts?: number }} [options]
 * @returns {unknown[]}
 */
export function capHistoryHttpJobs(jobs, options = {}) {
  if (!Array.isArray(jobs) || jobs.length === 0) return [];
  const chunkSize = Math.max(1, Number(options.chunkSize) || 16);
  const maxPosts = Math.max(1, Number(options.maxPosts) || HISTORY_HTTP_MAX_POSTS_PER_POLL);
  return jobs.slice(0, chunkSize * maxPosts);
}
