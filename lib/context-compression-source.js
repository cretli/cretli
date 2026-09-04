/**
 * Resolve full chat text for context compression (server-side).
 * Prefers persisted SDK history over truncated client buffer.
 */

import { getChatHistorySince, HISTORY_PULL_MAX_LIMIT } from './persist/chat-history-persist.js';
import { formatSdkAgentMessagesToBuffer } from './sdk/sdk-chat-history.js';
import { formatChatHistoryEventsToText } from './context-compression.js';
import { getEffectiveCursorApiKey } from './sdk/cursor-api-key.js';
import { loadCursorSdk } from './sdk/cursor-sdk.js';
import { loadChats } from './persist/chats-persist.js';
import { MIN_FORK_TEXT_LEN } from './fork-chat-text.js';

/**
 * @param {string} chatId
 * @returns {Array<{ seq: number, rec: unknown }>}
 */
export function loadAllChatHistoryEvents(chatId) {
  /** @type {Array<{ seq: number, rec: unknown }>} */
  const allEvents = [];
  let since = 0;
  for (let page = 0; page < 20; page += 1) {
    const pageResult = getChatHistorySince(chatId, since, HISTORY_PULL_MAX_LIMIT);
    if (!pageResult.ok) break;
    const batch = Array.isArray(pageResult.events) ? pageResult.events : [];
    if (batch.length === 0) break;
    for (const event of batch) {
      if (event && typeof event.seq === 'number') allEvents.push(event);
    }
    if (pageResult.hasMore !== true) break;
    const lastSeq = batch[batch.length - 1]?.seq;
    if (typeof lastSeq !== 'number') break;
    since = lastSeq;
  }
  return allEvents;
}

/**
 * @param {string} chatId
 * @returns {string}
 */
export function loadChatHistoryPlainText(chatId) {
  return formatChatHistoryEventsToText(loadAllChatHistoryEvents(chatId));
}

/**
 * @param {string} chatId
 * @returns {Promise<string>}
 */
async function loadSdkAgentPlainText(chatId) {
  const chat = loadChats().find((entry) => entry?.id === chatId);
  const agentId = chat?.sdkAgentId && String(chat.sdkAgentId).trim();
  if (!agentId || !getEffectiveCursorApiKey()) return '';
  try {
    const { Agent } = await loadCursorSdk();
    const rows = await Agent.messages.list(agentId, { limit: 200, offset: 0 });
    return formatSdkAgentMessagesToBuffer(Array.isArray(rows) ? rows : '').trim();
  } catch {
    return '';
  }
}

/**
 * @param {string} chatId
 * @param {string} clientText
 * @returns {Promise<string>}
 */
export async function resolveCompressionSourceText(chatId, clientText) {
  const trimmedClient = typeof clientText === 'string' ? clientText.trim() : '';
  const fromHistory = loadChatHistoryPlainText(chatId).trim();
  const fromSdk = (await loadSdkAgentPlainText(chatId)).trim();
  /** @type {string[]} */
  const candidates = [fromHistory, fromSdk, trimmedClient].filter(
    (value) => typeof value === 'string' && value.length >= MIN_FORK_TEXT_LEN,
  );
  if (candidates.length === 0) {
    return trimmedClient || fromHistory || fromSdk;
  }
  return candidates.reduce((longest, current) => (current.length > longest.length ? current : longest));
}
