/**
 * Chat title history storage (kept beside chats.json so the chat list stays small).
 * data/chat-title-history.json: { v, chats: { [chatId]: [ { title, source, at, reason?, seq? } ] } }
 * Newest entry last; capped at MAX_TITLE_HISTORY entries per chat.
 */

import fs from 'fs';
import path from 'path';
import { writeJsonAtomic } from './atomic-write.js';
import { resolveDataPath } from '../runtime-paths.js';

const HISTORY_FILE = resolveDataPath('chat-title-history.json');
const STORE_VERSION = 1;
export const MAX_TITLE_HISTORY = 20;

function ensureDir() {
  const dir = path.dirname(HISTORY_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** @returns {Record<string, Array<object>>} */
function loadAll() {
  ensureDir();
  if (!fs.existsSync(HISTORY_FILE)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    return data && typeof data.chats === 'object' && data.chats ? data.chats : {};
  } catch {
    return {};
  }
}

/**
 * @param {string} chatId
 * @returns {Array<{ title: string, source: string, at: string, reason?: string, seq?: number }>}
 */
export function getChatTitleHistory(chatId) {
  const list = loadAll()[chatId];
  return Array.isArray(list) ? list : [];
}

/**
 * Appends an entry; an identical title as the newest entry is deduplicated (returns false).
 *
 * @param {string} chatId
 * @param {{ title: string, source: string, reason?: string, seq?: number }} entry
 * @returns {boolean} whether an entry was written
 */
export function appendChatTitleHistory(chatId, entry) {
  const title = String(entry?.title || '').trim();
  if (!chatId || !title) return false;
  const all = loadAll();
  const list = Array.isArray(all[chatId]) ? all[chatId] : [];
  const last = list[list.length - 1];
  if (last && last.title === title) return false;
  const row = { title, source: String(entry.source || ''), at: new Date().toISOString() };
  if (entry.reason) row.reason = String(entry.reason);
  if (Number.isFinite(entry.seq)) row.seq = entry.seq;
  list.push(row);
  all[chatId] = list.slice(-MAX_TITLE_HISTORY);
  ensureDir();
  writeJsonAtomic(HISTORY_FILE, { v: STORE_VERSION, chats: all });
  return true;
}

/** @param {string} chatId */
export function deleteChatTitleHistory(chatId) {
  const all = loadAll();
  if (!Object.prototype.hasOwnProperty.call(all, chatId)) return;
  delete all[chatId];
  writeJsonAtomic(HISTORY_FILE, { v: STORE_VERSION, chats: all });
}
