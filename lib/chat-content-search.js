/**
 * Bounded content search across the chats of ONE workspace (voice `chat_ops search`).
 *
 * No index: each candidate chat contributes only the newest page of its persisted
 * history, and only the message text (user + assistant), never tool args/results.
 * Every dimension is capped (query length, chats scanned, events and characters per
 * chat, results, wall-clock budget), so a call costs at most a fixed amount of work
 * however large the workspace is. Snippets are untrusted text: trimmed, whitespace
 * collapsed and never interpreted here.
 */

import { readEventField, unwrapHistoryEntry } from './mcp/builtin/chat-history-format.js';
import { buildSearchSnippet } from './mcp/builtin/chat-search.js';

export const CONTENT_SEARCH_MIN_QUERY_CHARS = 2;
export const CONTENT_SEARCH_MAX_QUERY_CHARS = 80;
export const CONTENT_SEARCH_MAX_RESULTS = 8;
export const CONTENT_SEARCH_MAX_CHATS = 40;
export const CONTENT_SEARCH_EVENTS_PER_CHAT = 120;
export const CONTENT_SEARCH_CHARS_PER_CHAT = 120_000;
export const CONTENT_SEARCH_BUDGET_MS = 1500;
export const CONTENT_SEARCH_SNIPPET_CHARS = 160;

/**
 * @param {unknown} raw
 * @returns {{ ok: true, query: string } | { ok: false, error: string }}
 */
export function validateContentQuery(raw) {
  const query = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  if (query.length < CONTENT_SEARCH_MIN_QUERY_CHARS) {
    return { ok: false, error: `q must be at least ${CONTENT_SEARCH_MIN_QUERY_CHARS} characters.` };
  }
  if (query.length > CONTENT_SEARCH_MAX_QUERY_CHARS) {
    return { ok: false, error: `q must be at most ${CONTENT_SEARCH_MAX_QUERY_CHARS} characters.` };
  }
  return { ok: true, query };
}

/**
 * @param {Record<string, any>} chat
 * @returns {number}
 */
function chatRecency(chat) {
  const stamp = Date.parse(String(chat.lastActivityAt || chat.updatedAt || chat.createdAt || ''));
  return Number.isFinite(stamp) ? stamp : 0;
}

/**
 * Persisted history rows carry no per-event timestamp in either backend, so a hit is
 * dated by the chat's last activity when the row itself has none.
 *
 * @param {Record<string, any>} chat
 * @returns {string} ISO time, '' when unknown
 */
function chatStamp(chat) {
  const stamp = chatRecency(chat);
  return stamp > 0 ? new Date(stamp).toISOString() : '';
}

/**
 * @param {unknown} entry raw history row
 * @param {Record<string, unknown>} rec
 * @returns {string} ISO time of the event, '' when unknown
 */
function eventTime(entry, rec) {
  const row = /** @type {Record<string, any>} */ (entry && typeof entry === 'object' ? entry : {});
  const raw = row.createdAt ?? row.at ?? row.ts ?? rec.createdAt ?? rec.at ?? rec.ts;
  const stamp = typeof raw === 'number' ? raw : Date.parse(String(raw || ''));
  return Number.isFinite(stamp) && stamp > 0 ? new Date(stamp).toISOString() : '';
}

/**
 * First match in the newest events of one chat (newest first), message text only.
 * Each message is clipped to the remaining character budget BEFORE it is lowercased
 * and searched, so one huge message cannot exceed the per-chat work bound.
 *
 * @param {unknown[]} events oldest -> newest
 * @param {string} query
 * @param {{ isExpired?: () => boolean }} [options] stops between events once true
 * @returns {{ snippet: string, at: string, seq: number } | null}
 */
export function findContentMatch(events, query, options = {}) {
  const needle = query.toLowerCase();
  const rows = Array.isArray(events) ? events : [];
  let remaining = CONTENT_SEARCH_CHARS_PER_CHAT;
  for (let index = rows.length - 1; index >= 0 && remaining > 0; index -= 1) {
    if (options.isExpired?.()) break;
    const entry = unwrapHistoryEntry(rows[index]);
    if (entry.seq <= 0) continue;
    const full = readEventField(entry.rec, 'text');
    if (typeof full !== 'string' || !full) continue;
    const text = full.length > remaining ? full.slice(0, remaining) : full;
    remaining -= text.length;
    const found = text.toLowerCase().indexOf(needle);
    if (found >= 0) {
      return {
        snippet: buildSearchSnippet(text, found, needle.length, CONTENT_SEARCH_SNIPPET_CHARS),
        at: eventTime(rows[index], entry.rec),
        seq: entry.seq,
      };
    }
  }
  return null;
}

/**
 * Resolves with the promise's value, or with TIMED_OUT once `ms` elapsed (timer always cleared).
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T | typeof TIMED_OUT>}
 */
function raceDeadline(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, ms)); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const TIMED_OUT = Symbol('timed-out');

/**
 * @param {{
 *   chats: Array<Record<string, any>>,
 *   query: string,
 *   readPage: (chatId: string, limit: number) => Promise<{ events?: unknown[] } | null | undefined>,
 *   maxResults?: number,
 *   maxChats?: number,
 *   budgetMs?: number,
 *   now?: () => number,
 * }} input chats must already be scoped to the caller's workspace and visibility
 * @returns {Promise<{ results: Array<{ chatId: string, title: string, snippet: string, at: string }>, scannedChats: number, truncated: boolean, timedOut: boolean }>}
 */
export async function searchChatContents(input) {
  const now = typeof input.now === 'function' ? input.now : Date.now;
  const maxResults = Math.max(1, Math.min(CONTENT_SEARCH_MAX_RESULTS, Number(input.maxResults) || CONTENT_SEARCH_MAX_RESULTS));
  const maxChats = Math.max(1, Math.min(CONTENT_SEARCH_MAX_CHATS, Number(input.maxChats) || CONTENT_SEARCH_MAX_CHATS));
  const budgetMs = Math.max(1, Number(input.budgetMs) || CONTENT_SEARCH_BUDGET_MS);
  const deadline = now() + budgetMs;
  const ordered = [...input.chats].sort((left, right) => chatRecency(right) - chatRecency(left));
  const results = [];
  let scannedChats = 0;
  let truncated = ordered.length > maxChats;
  let timedOut = false;
  for (const chat of ordered.slice(0, maxChats)) {
    if (results.length >= maxResults) { truncated = true; break; }
    if (now() >= deadline) { truncated = true; timedOut = true; break; }
    scannedChats += 1;
    let page = null;
    try {
      // A stuck read must not outlive the budget: the wall-clock timer is the bound, not the injected clock.
      page = await raceDeadline(Promise.resolve(input.readPage(String(chat.id), CONTENT_SEARCH_EVENTS_PER_CHAT)), deadline - now());
    } catch {
      continue;
    }
    if (page === TIMED_OUT) { truncated = true; timedOut = true; break; }
    const hit = findContentMatch(page?.events || [], input.query, { isExpired: () => now() >= deadline });
    if (hit) {
      results.push({ chatId: String(chat.id), title: String(chat.title || '').slice(0, 120), snippet: hit.snippet, at: hit.at || chatStamp(chat) });
    }
  }
  return { results, scannedChats, truncated, timedOut };
}
