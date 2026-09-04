/**
 * Chat history storage (append-only log with server-assigned seq numbers).
 * data/chat-history/<chatId>.json: { v, chatId, cursorSessionId, headSeq, updatedAt, events: [{seq, rec}] }
 *
 * Cross-device sync: the server is the source of truth, the client is a cache plus an offline queue.
 */

import fs from 'fs';
import path from 'path';
import { writeJsonAtomic } from './atomic-write.js';
import { isValidSdkHistoryRecord } from './chat-history-validate.js';
import { bumpChatHistoryRevision, clearChatHistoryRevision } from './chat-history-revisions.js';
import { notifyChatHistoryUpdated } from './chat-history-notify.js';
import { resolveDataPath } from '../runtime-paths.js';
import {
  coalesceSdkHistoryItems,
  extendHistorySliceToStreamBoundary,
  mergeSdkHistoryStreamText,
  readSdkHistoryStreamKind,
  readSdkHistoryStreamText,
  withSdkHistoryStreamText,
} from '../sdk/sdk-history-stream-coalesce.js';

/**
 * @param {unknown} rec
 * @returns {Record<string, unknown>}
 */
function asHistoryRecord(rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return {};
  return /** @type {Record<string, unknown>} */ (rec);
}

const HISTORY_DIR = resolveDataPath('chat-history');

const STORE_VERSION = 1;
export const MAX_HISTORY_EVENTS = 2000;
export const HISTORY_PULL_DEFAULT_LIMIT = 1000;
export const HISTORY_PULL_MAX_LIMIT = 2000;
export const HISTORY_TAIL_DEFAULT_LIMIT = 80;

function ensureDir() {
  if (!fs.existsSync(HISTORY_DIR)) {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
  }
}

function filePathFor(chatId) {
  return path.join(HISTORY_DIR, `${chatId}.json`);
}

/**
 * Validates a chatId (uuid) — guards against path traversal.
 * @param {string} chatId
 * @returns {boolean}
 */
function isValidChatId(chatId) {
  return typeof chatId === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(chatId);
}

/**
 * @param {string} chatId
 * @returns {{ v: number, chatId: string, cursorSessionId: string, headSeq: number, updatedAt: string, events: Array<{ seq: number, rec: unknown }> } | null}
 */
export function loadChatHistory(chatId) {
  if (!isValidChatId(chatId)) return null;
  ensureDir();
  const fp = filePathFor(chatId);
  if (!fs.existsSync(fp)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
    if (!data || typeof data !== 'object' || data.v !== STORE_VERSION) return null;
    return {
      v: STORE_VERSION,
      chatId: String(data.chatId || chatId),
      cursorSessionId: String(data.cursorSessionId || ''),
      headSeq: Number(data.headSeq) || 0,
      updatedAt: String(data.updatedAt || ''),
      events: Array.isArray(data.events) ? data.events.filter((e) => e && typeof e.seq === 'number' && isValidSdkHistoryRecord(e.rec)) : [],
    };
  } catch {
    return null;
  }
}

/**
 * @param {string} chatId
 * @param {{ v?: number, chatId?: string, cursorSessionId?: string, headSeq?: number, updatedAt?: string, events?: unknown[] }} doc
 */
function saveChatHistory(chatId, doc) {
  if (!isValidChatId(chatId)) return;
  ensureDir();
  writeJsonAtomic(filePathFor(chatId), doc);
}

/**
 * Appends events to the log, assigning seq = headSeq+1..n.
 * Idempotency: records whose `clientSeq` is already in the log are skipped and their existing seq is returned.
 *
 * @param {string} chatId
 * @param {string} cursorSessionId
 * @param {Array<{ rec: unknown, clientSeq?: number }>} items
 * @returns {{ ok: true, headSeq: number, appended: Array<{ seq: number, rec: unknown }> }}
 */
export function appendChatHistoryEvents(chatId, cursorSessionId, items) {
  if (!isValidChatId(chatId)) {
    return { ok: false, error: 'Invalid chatId' };
  }
  const doc = loadChatHistory(chatId) || {
    v: STORE_VERSION,
    chatId,
    cursorSessionId: cursorSessionId || '',
    headSeq: 0,
    updatedAt: '',
    events: [],
  };

  if (cursorSessionId && doc.cursorSessionId !== cursorSessionId) {
    doc.cursorSessionId = cursorSessionId;
  }

  // clientSeq → seq index for idempotency (only client records carry clientSeq).
  /** @type {Map<number, number>} */
  const existingClientSeq = new Map();
  for (const e of doc.events) {
    const cs = e.rec && typeof e.rec === 'object' ? /** @type {any} */ (e.rec).clientSeq : undefined;
    if (typeof cs === 'number') existingClientSeq.set(cs, e.seq);
  }

  const appended = [];
  const list = coalesceSdkHistoryItems(Array.isArray(items) ? items : []);
  if (list.length > 0 && doc.events.length > 0) {
    const lastStored = doc.events[doc.events.length - 1];
    const firstIncoming = list[0];
    const lastKind = readSdkHistoryStreamKind(lastStored?.rec);
    const firstKind = readSdkHistoryStreamKind(firstIncoming?.rec);
    if (lastKind && lastKind === firstKind) {
      lastStored.rec = withSdkHistoryStreamText(
        asHistoryRecord(lastStored.rec),
        mergeSdkHistoryStreamText(
          readSdkHistoryStreamText(lastStored.rec),
          readSdkHistoryStreamText(firstIncoming.rec),
        ),
      );
      list.shift();
      appended.push({ seq: lastStored.seq, rec: lastStored.rec });
    }
  }
  for (const item of list) {
    if (!item || !isValidSdkHistoryRecord(item.rec)) continue;
    const rec = item.rec;
    const clientSeq = typeof item.clientSeq === 'number' ? item.clientSeq : undefined;

    // Same clientSeq already in the log — skip the append and return the existing seq.
    if (clientSeq !== undefined && existingClientSeq.has(clientSeq)) {
      const seq = /** @type {number} */ (existingClientSeq.get(clientSeq));
      appended.push({ seq, rec });
      continue;
    }

    doc.headSeq += 1;
    const seq = doc.headSeq;
    const cleanRec = { ...rec };
    if (clientSeq !== undefined) {
      existingClientSeq.set(clientSeq, seq);
      // Keep clientSeq in the record so the client can match lastAckedSeq during replay.
      cleanRec.clientSeq = clientSeq;
    }
    doc.events.push({ seq, rec: cleanRec });
    appended.push({ seq, rec: cleanRec });
  }

  // Trim the oldest events; headSeq stays monotonic.
  if (doc.events.length > MAX_HISTORY_EVENTS) {
    doc.events = doc.events.slice(doc.events.length - MAX_HISTORY_EVENTS);
  }

  doc.updatedAt = new Date().toISOString();
  saveChatHistory(chatId, doc);
  if (appended.length > 0) {
    bumpChatHistoryRevision(chatId, doc.headSeq);
    void notifyChatHistoryUpdated(chatId, doc.headSeq);
  }
  return { ok: true, headSeq: doc.headSeq, appended };
}

/**
 * @param {string} chatId
 * @param {number} sinceSeq
 * @param {number} limit
 * @returns {{ ok: true, chatId: string, cursorSessionId: string, headSeq: number, events: Array<{ seq: number, rec: unknown }>, hasMore: boolean } | { ok: false, error: string }}
 */
export function getChatHistorySince(chatId, sinceSeq = 0, limit = HISTORY_PULL_DEFAULT_LIMIT) {
  const doc = loadChatHistory(chatId);
  if (!doc) {
    return { ok: true, chatId, cursorSessionId: '', headSeq: 0, events: [], hasMore: false };
  }
  const since = Math.max(0, Number(sinceSeq) || 0);
  const lim = Math.min(HISTORY_PULL_MAX_LIMIT, Math.max(1, Number(limit) || HISTORY_PULL_DEFAULT_LIMIT));
  const tail = doc.events.filter((e) => e.seq > since);
  const slice = tail.slice(0, lim);
  return {
    ok: true,
    chatId: doc.chatId,
    cursorSessionId: doc.cursorSessionId,
    headSeq: doc.headSeq,
    events: slice,
    hasMore: tail.length > slice.length,
  };
}

/**
 * Backwards pagination: returns the newest `limit` events, optionally those older than `beforeSeq`.
 * Used by the client to render a window of the conversation instead of the whole log.
 *
 * @param {string} chatId
 * @param {{ beforeSeq?: number, limit?: number }} [options]
 * @returns {{ ok: true, chatId: string, cursorSessionId: string, headSeq: number, events: Array<{ seq: number, rec: unknown }>, oldestSeq: number, hasOlder: boolean }}
 */
export function getChatHistoryPage(chatId, options = {}) {
  const doc = loadChatHistory(chatId);
  if (!doc) {
    return { ok: true, chatId, cursorSessionId: '', headSeq: 0, events: [], oldestSeq: 0, hasOlder: false };
  }
  const beforeSeq = Math.max(0, Number(options.beforeSeq) || 0);
  const lim = Math.min(
    HISTORY_PULL_MAX_LIMIT,
    Math.max(1, Number(options.limit) || HISTORY_TAIL_DEFAULT_LIMIT),
  );
  const pool = beforeSeq > 0 ? doc.events.filter((e) => e.seq < beforeSeq) : doc.events;
  const slice = extendHistorySliceToStreamBoundary(
    pool,
    pool.slice(-lim),
    HISTORY_PULL_MAX_LIMIT,
  );
  const oldestSeq = doc.events.length > 0 ? doc.events[0].seq : 0;
  return {
    ok: true,
    chatId: doc.chatId,
    cursorSessionId: doc.cursorSessionId,
    headSeq: doc.headSeq,
    events: slice,
    oldestSeq,
    hasOlder: slice.length > 0 && slice[0].seq > oldestSeq,
  };
}

/**
 * Copies the full history into a persistent conversation fork.
 * @param {string} sourceChatId
 * @param {string} targetChatId
 * @param {string} targetCursorSessionId
 * @returns {{ ok: boolean, headSeq?: number, error?: string }}
 */
export function copyChatHistory(sourceChatId, targetChatId, targetCursorSessionId) {
  if (!isValidChatId(sourceChatId) || !isValidChatId(targetChatId)) {
    return { ok: false, error: 'Invalid chatId' };
  }
  const source = loadChatHistory(sourceChatId);
  const events = source?.events
    ? source.events.map((event) => {
        const cloned = JSON.parse(JSON.stringify(event.rec));
        if (cloned && typeof cloned === 'object') delete cloned.clientSeq;
        return {
          seq: event.seq,
          rec: cloned,
        };
      })
    : [];
  const headSeq = source?.headSeq || 0;
  saveChatHistory(targetChatId, {
    v: STORE_VERSION,
    chatId: targetChatId,
    cursorSessionId: targetCursorSessionId || '',
    headSeq,
    updatedAt: new Date().toISOString(),
    events,
  });
  return { ok: true, headSeq };
}

/**
 * @param {string} chatId
 * @returns {void}
 */
export function deleteChatHistory(chatId) {
  if (!isValidChatId(chatId)) return;
  ensureDir();
  const fp = filePathFor(chatId);
  if (fs.existsSync(fp)) {
    try {
      fs.unlinkSync(fp);
    } catch {
      /* ignore */
    }
  }
  clearChatHistoryRevision(chatId);
}

/**
 * Returns headSeq metadata for all persisted chat history files (startup revision seed).
 *
 * @returns {Record<string, { headSeq: number, updatedAt: string }>}
 */
export function listChatHistoryHeadSeqs() {
  ensureDir();
  /** @type {Record<string, { headSeq: number, updatedAt: string }>} */
  const out = {};
  let names = [];
  try {
    names = fs.readdirSync(HISTORY_DIR);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const chatId = name.slice(0, -5);
    const doc = loadChatHistory(chatId);
    if (!doc) continue;
    out[chatId] = {
      headSeq: doc.headSeq,
      updatedAt: doc.updatedAt || '',
    };
  }
  return out;
}
