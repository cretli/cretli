/**
 * Chat title history storage (kept beside chats.json so the chat list stays small).
 * data/chat-title-history.json: { v, chats: { [chatId]: [ { title, source, at, reason?, seq? } ] } }
 * Newest entry last; capped at MAX_TITLE_HISTORY entries per chat.
 */

import fs from 'fs';
import path from 'path';
import { writeJsonCoalesced } from './atomic-write.js';
import { resolveDataPath } from '../runtime-paths.js';

const HISTORY_FILE = resolveDataPath('chat-title-history.json');
const STORE_VERSION = 1;
export const MAX_TITLE_HISTORY = 20;
/** Upper bound on how long a title-history change may stay in memory before it reaches disk. */
export const TITLE_HISTORY_MAX_DELAY_MS = 2000;

/**
 * Document handed to the write coalescer and not flushed yet. Reads go through it so a
 * delayed write is never invisible to the next read-modify-write (which would drop the entry).
 * @type {{ v: number, chats: Record<string, Array<Record<string, any>>> } | null}
 */
let pendingDoc = null;

/**
 * Title history is advisory (an audit trail next to chats.json), and one rename writes it twice
 * (entry, then the history `seq`), so the whole-file rewrite is delayed and merged. Process exit
 * and graceful shutdown flush it through `flushCoalescedWrites`.
 * @param {Record<string, Array<Record<string, any>>>} all
 */
function persistAll(all) {
  const doc = { v: STORE_VERSION, chats: all };
  pendingDoc = doc;
  writeJsonCoalesced(HISTORY_FILE, doc, 'utf8', {
    maxDelayMs: TITLE_HISTORY_MAX_DELAY_MS,
    onFlushed: () => { if (pendingDoc === doc) pendingDoc = null; },
  });
}

function ensureDir() {
  const dir = path.dirname(HISTORY_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** @returns {Record<string, Array<Record<string, any>>>} */
function loadAll() {
  if (pendingDoc) return pendingDoc.chats;
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
  persistAll(all);
  return true;
}

/**
 * Attach the history head `seq` to the newest entry with this title when it has none yet (see
 * `annotateTitleHistorySeq` in chats-persist: the head is read asynchronously after the rename).
 *
 * @param {string} chatId
 * @param {string} title
 * @param {number} seq
 * @returns {boolean} whether an entry was updated
 */
export function setChatTitleHistorySeq(chatId, title, seq) {
  if (!chatId || !Number.isFinite(seq)) return false;
  const all = loadAll();
  const list = Array.isArray(all[chatId]) ? all[chatId] : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index].title !== title) continue;
    if (Number.isFinite(list[index].seq)) return false;
    list[index].seq = seq;
    ensureDir();
    persistAll(all);
    return true;
  }
  return false;
}

/** @param {string} chatId */
export function deleteChatTitleHistory(chatId) {
  const all = loadAll();
  if (!Object.prototype.hasOwnProperty.call(all, chatId)) return;
  delete all[chatId];
  persistAll(all);
}
