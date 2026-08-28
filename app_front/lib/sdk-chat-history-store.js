/**
 * SDK chat history: stores the same event JSON as the WS stream, so after a reload
 * replayHistoryRecords rebuilds identical DOM (Markdown, tool calls…).
 *
 * IndexedDB is the only store for history documents: localStorage has a ~5MB quota for the
 * whole origin, so mirroring multi-megabyte docs there starved every other key. Live docs are
 * kept in memory (synchronous appends) and flushed to IDB; localStorage is written only when
 * IDB is unavailable, and then with a tight cap.
 *
 * Backend sync: append-only log with server-side seq (lib/persist/chat-history-persist.js).
 * The client keeps clientSeq (monotonic per chat, in LS) + lastAckedSeq.
 */

import { isValidSdkHistoryRecord, cloneSerializableSdkEvent } from '../../lib/persist/chat-history-validate.js';
import { postChatHistory, getChatHistory } from '../api.js';
import { CHAT_HISTORY_INITIAL_TAIL, CHAT_HISTORY_OLDER_PAGE } from '../config.js';
import { appLogger } from '../logger.js';
import {
  readStorageValueWithAlias,
  removeStorageValueWithAlias,
  toCurrentStorageKey,
  writeStorageValueWithAlias,
} from './storageKeyAlias.js';

export { isValidSdkHistoryRecord, cloneSerializableSdkEvent };

/** @type {string} */
export const SDK_CHAT_HISTORY_STORAGE_PREFIX = 'cretli-chat-sdk-history-';
const LEGACY_SDK_CHAT_HISTORY_STORAGE_PREFIX = 'cursor-remote-chat-sdk-history-';
const CLIENTSEQ_LS_PREFIX = 'cretli-chat-history-clientseq-';
const ACKEDSEQ_LS_PREFIX = 'cretli-chat-history-ackedseq-';
const OLDESTSEQ_LS_PREFIX = 'cretli-chat-history-oldestseq-';

/** @type {Map<string, number>} */
const lastAckedSeqMemory = new Map();
/** @type {Map<string, number>} */
const oldestLoadedSeqMemory = new Map();
const PENDING_PUSH_LS_PREFIX = 'cretli-chat-history-pending-push-';
const PENDING_PUSH_MAX = 50;

const STORE_VERSION = 1;
/** @type {number} */
const MAX_RECORDS = 1200;

/** Only used when IndexedDB is unavailable — must stay small enough not to eat the LS quota. */
const LS_FALLBACK_MAX_JSON_CHARS = 200_000;
const IDB_MAX_JSON_CHARS = 16_000_000;

/**
 * Live documents. This is the base for appends, so a page load that starts streaming before
 * hydration finishes still resolves its base from IDB instead of overwriting it (see runFlush).
 * @type {Map<string, { v: number, cursorSessionId: string, events: unknown[] }>}
 */
const docCacheByChatId = new Map();
/** @type {Map<string, { cursorSessionId: string, records: unknown[] }>} */
const pendingWriteByChatId = new Map();
/** @type {Map<string, Promise<void>>} */
const flushChainByChatId = new Map();

const IDB_NAME = 'cretli-sdk-chat';
const IDB_STORE = 'history';
const IDB_VER = 1;

/** @type {Promise<IDBDatabase | null> | null} */
let idbOpening = null;

/**
 * @param {string} key
 * @returns {string}
 */
function readLocalStorageValue(key) {
  if (typeof localStorage === 'undefined') return '';
  return readStorageValueWithAlias(localStorage, key, '');
}

/**
 * @param {string} key
 * @param {string} value
 * @returns {void}
 */
function writeLocalStorageValue(key, value) {
  if (typeof localStorage === 'undefined') return;
  writeStorageValueWithAlias(localStorage, key, value);
}

/**
 * @param {string} key
 * @returns {void}
 */
function removeLocalStorageValue(key) {
  if (typeof localStorage === 'undefined') return;
  removeStorageValueWithAlias(localStorage, key);
}

/**
 * @param {string} chatId
 * @returns {string}
 */
function keyFor(chatId) {
  return SDK_CHAT_HISTORY_STORAGE_PREFIX + chatId;
}

/**
 * @returns {IDBFactory | null}
 */
function getIndexedDbMaybe() {
  if (typeof indexedDB !== 'undefined') return indexedDB;
  return null;
}

/**
 * @returns {Promise<IDBDatabase | null>}
 */
function openSdkHistoryDbOnce() {
  const idb = getIndexedDbMaybe();
  if (!idb) return Promise.resolve(null);
  if (!idbOpening) {
    idbOpening = new Promise((resolve) => {
      const req = idb.open(IDB_NAME, IDB_VER);
      req.onerror = () => {
        idbOpening = null;
        resolve(null);
      };
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
    });
  }
  return idbOpening;
}

/**
 * @param {unknown} raw
 * @returns {{ v: number, cursorSessionId: string, events: unknown[] } | null}
 */
function parseAndSanitizeStoredDoc(raw) {
  const doc =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? /** @type {Record<string, unknown>} */ (raw)
      : null;
  if (!doc || doc.v !== STORE_VERSION || typeof doc.cursorSessionId !== 'string' || !Array.isArray(doc.events)) {
    return null;
  }
  const events = doc.events.filter(isValidSdkHistoryRecord);
  return { v: STORE_VERSION, cursorSessionId: doc.cursorSessionId, events };
}

/**
 * @param {string} chatId
 * @returns {{ v: number, cursorSessionId: string, events: unknown[] } | null}
 */
function readSdkChatHistoryFromLocalStorage(chatId) {
  if (!chatId || typeof localStorage === 'undefined') return null;
  let raw;
  try {
    raw = readLocalStorageValue(keyFor(chatId));
  } catch {
    return null;
  }
  if (!raw || !raw.trim()) return null;
  try {
    const doc = JSON.parse(raw);
    return parseAndSanitizeStoredDoc(doc);
  } catch {
    return null;
  }
}

/**
 * @param {string} chatId
 */
function removeLegacyLocalStorageKey(chatId) {
  if (!chatId || typeof localStorage === 'undefined') return;
  try {
    removeLocalStorageValue(keyFor(chatId));
  } catch {
    /* ignore */
  }
}

/**
 * @param {{ events: unknown[] }} doc
 * @param {number} maxJsonChars
 */
function trimDoc(doc, maxJsonChars) {
  if (!doc || !Array.isArray(doc.events)) return;
  while (doc.events.length > MAX_RECORDS) {
    doc.events.shift();
  }
  while (doc.events.length > 0) {
    let json;
    try {
      json = JSON.stringify(doc);
    } catch {
      return;
    }
    if (json.length <= maxJsonChars) return;
    const drop = Math.max(1, Math.floor(doc.events.length * 0.12));
    doc.events.splice(0, drop);
  }
}

/**
 * Drops localStorage history keys for chats that are no longer on the chat list.
 * Runs on quota failure in the no-IDB fallback path.
 *
 * @param {Set<string>} keepChatIds
 * @returns {void}
 */
function evictOrphanedSdkChatHistoryKeys(keepChatIds) {
  if (typeof localStorage === 'undefined') return;
  const prefix = SDK_CHAT_HISTORY_STORAGE_PREFIX;
  const bufferPrefix = toCurrentStorageKey('cretli-chat-buffer-probe').slice(0, -'probe'.length);
  const legacyBufferPrefix = 'cretli-chat-buffer-';
  const toRemove = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key) continue;
    if (
      !key.startsWith(prefix)
      && !key.startsWith(legacyBufferPrefix)
      && !key.startsWith(bufferPrefix)
    ) continue;
    const chatId = key.startsWith(prefix)
      ? key.slice(prefix.length)
      : key.startsWith(bufferPrefix)
        ? key.slice(bufferPrefix.length)
        : key.slice(legacyBufferPrefix.length);
    if (!keepChatIds.has(chatId)) toRemove.push(key);
  }
  for (const key of toRemove) {
    try {
      removeLocalStorageValue(key);
    } catch {
      /* ignore */
    }
  }
}

/**
 * @param {string[]} prefixes
 * @returns {string[]}
 */
function collectLocalStorageKeys(prefixes) {
  /** @type {string[]} */
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key) continue;
    if (!prefixes.some((prefix) => key.startsWith(prefix))) continue;
    keys.push(key);
  }
  return keys;
}

/**
 * @param {string} chatId
 * @param {string} raw
 * @returns {Promise<boolean>} false when the localStorage copy is still the better one
 */
async function moveHistoryDocToIndexedDb(chatId, raw) {
  /** @type {{ v: number, cursorSessionId: string, events: unknown[] } | null} */
  let doc = null;
  try {
    doc = parseAndSanitizeStoredDoc(JSON.parse(raw));
  } catch {
    return true;
  }
  if (!doc || doc.events.length === 0) return true;
  const existing = await readSdkChatHistoryFromIndexedDb(chatId);
  const existingCount = existing && existing.cursorSessionId === doc.cursorSessionId
    ? existing.events.length
    : 0;
  if (existingCount >= doc.events.length) return true;
  await persistDocToIndexedDb(chatId, doc);
  const after = await readSdkChatHistoryFromIndexedDb(chatId);
  return Boolean(after && after.events.length > 0);
}

/**
 * One-time cleanup after history moved to IndexedDB: earlier builds mirrored whole docs into
 * localStorage (up to 2.4MB per chat) and left `cursor-remote-*` keys behind after the rename,
 * which together ate most of the ~5MB origin quota.
 *
 * Docs of chats that no longer exist are dropped instead of migrated. Nothing is removed
 * unless IndexedDB holds the data, so a browser without IDB keeps its fallback copies.
 *
 * @param {string[]} keepChatIds
 * @returns {Promise<{ removedKeys: number, freedChars: number }>}
 */
export async function migrateSdkChatHistoryOutOfLocalStorage(keepChatIds) {
  const summary = { removedKeys: 0, freedChars: 0 };
  if (typeof localStorage === 'undefined') return summary;
  const keep = new Set(Array.isArray(keepChatIds) ? keepChatIds : []);
  if (keep.size === 0) return summary;
  const db = await openSdkHistoryDbOnce();
  if (!db) return summary;
  const prefixes = [SDK_CHAT_HISTORY_STORAGE_PREFIX, LEGACY_SDK_CHAT_HISTORY_STORAGE_PREFIX];
  for (const key of collectLocalStorageKeys(prefixes)) {
    const prefix = prefixes.find((candidate) => key.startsWith(candidate)) || '';
    const chatId = key.slice(prefix.length);
    let raw = '';
    try {
      raw = localStorage.getItem(key) || '';
    } catch {
      continue;
    }
    if (chatId && keep.has(chatId) && !(await moveHistoryDocToIndexedDb(chatId, raw))) continue;
    try {
      localStorage.removeItem(key);
    } catch {
      continue;
    }
    summary.removedKeys += 1;
    summary.freedChars += key.length + raw.length;
  }
  return summary;
}

/** @type {Set<string>} */
let keepChatIdsForEviction = new Set();

/**
 * Sets the list of live chat ids — used when evicting LS keys on quota failure.
 * @param {string[]} ids
 * @returns {void}
 */
export function setActiveChatIdsForEviction(ids) {
  keepChatIdsForEviction = new Set(Array.isArray(ids) ? ids : []);
}

/**
 * Fallback for browsers/contexts without IndexedDB. Keeps only a short tail of the log.
 *
 * @param {string} chatId
 * @param {string} cursorSessionId
 * @param {unknown[]} events
 */
function writeSdkChatHistoryLocalStorageFallback(chatId, cursorSessionId, events) {
  if (!chatId || typeof localStorage === 'undefined') return;
  /** @type {{ v: number, cursorSessionId: string, events: unknown[] }} */
  const doc = {
    v: STORE_VERSION,
    cursorSessionId: cursorSessionId || '',
    events: Array.isArray(events) ? events.slice() : [],
  };
  trimDoc(doc, LS_FALLBACK_MAX_JSON_CHARS);
  try {
    writeLocalStorageValue(keyFor(chatId), JSON.stringify(doc));
    return;
  } catch {
    // Quota failure — evict orphaned history keys and retry with a shorter doc.
  }
  evictOrphanedSdkChatHistoryKeys(keepChatIdsForEviction);
  while (doc.events.length > 80) {
    doc.events.splice(0, 40);
    try {
      writeLocalStorageValue(keyFor(chatId), JSON.stringify(doc));
      return;
    } catch {
      /* shrink more */
    }
  }
}


/**
 * @param {IDBDatabase} db
 * @param {string} chatId
 * @param {unknown} value
 */
function idbPutWithTransactionDone(db, chatId, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(value, chatId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('idb'));
    tx.onabort = () => reject(tx.error ?? new Error('idb'));
  });
}

async function persistDocToIndexedDb(chatId, doc) {
  let working = JSON.parse(JSON.stringify(doc));
  if (!working || typeof working !== 'object' || Array.isArray(working)) return;
  for (let attempt = 0; attempt < 8; attempt++) {
    trimDoc(/** @type {{ events: unknown[] }} */ (working), IDB_MAX_JSON_CHARS);
    try {
      const db = await openSdkHistoryDbOnce();
      if (!db) throw new Error('no idb');
      await idbPutWithTransactionDone(db, chatId, working);
      return;
    } catch {
      const ev = /** @type {{ events?: unknown[] }} */ (working).events;
      if (!Array.isArray(ev) || ev.length < 2) break;
      ev.splice(0, Math.max(1, Math.floor(ev.length * 0.15)));
    }
  }
}

/**
 * @param {string} chatId
 * @returns {Promise<{ v: number, cursorSessionId: string, events: unknown[] } | null>}
 */
async function readSdkChatHistoryFromIndexedDb(chatId) {
  if (!chatId) return null;
  const db = await openSdkHistoryDbOnce();
  if (!db) return null;
  try {
    const raw = await new Promise((resolve) => {
      try {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const r = tx.objectStore(IDB_STORE).get(chatId);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => resolve(undefined);
      } catch {
        resolve(undefined);
      }
    });
    return parseAndSanitizeStoredDoc(raw);
  } catch {
    return null;
  }
}

/**
 * Reads IDB and falls back to a localStorage doc left by an older build (or by the
 * no-IDB fallback path). The LS doc can only ever be a short tail, so IDB wins on ties.
 *
 * @param {string} chatId
 * @returns {Promise<{ v: number, cursorSessionId: string, events: unknown[] } | null>}
 */
async function readStoredDoc(chatId) {
  const fromIdb = await readSdkChatHistoryFromIndexedDb(chatId);
  if (fromIdb) return fromIdb;
  return readSdkChatHistoryFromLocalStorage(chatId);
}

/**
 * @param {string} chatId
 * @returns {Promise<{ v: number, cursorSessionId: string, events: unknown[] } | null>}
 */
export async function readSdkChatHistoryStateAsync(chatId) {
  if (!chatId) return null;
  await flushSdkChatHistoryWrites(chatId);
  const cached = docCacheByChatId.get(chatId);
  if (cached) {
    return { v: STORE_VERSION, cursorSessionId: cached.cursorSessionId, events: cached.events.slice() };
  }
  const stored = await readStoredDoc(chatId);
  if (stored) docCacheByChatId.set(chatId, stored);
  if (!stored) return null;
  return { v: STORE_VERSION, cursorSessionId: stored.cursorSessionId, events: stored.events.slice() };
}

/**
 * @param {string} chatId
 * @param {string} cursorSessionId
 * @param {unknown[]} events
 */
async function writeStoredDocUnified(chatId, cursorSessionId, events) {
  if (!chatId) return;
  const sid = cursorSessionId || '';
  const eventsArr = Array.isArray(events) ? events.slice() : [];
  docCacheByChatId.set(chatId, { v: STORE_VERSION, cursorSessionId: sid, events: eventsArr });
  const db = await openSdkHistoryDbOnce();
  if (db) {
    await persistDocToIndexedDb(chatId, { v: STORE_VERSION, cursorSessionId: sid, events: eventsArr.slice() });
    return;
  }
  writeSdkChatHistoryLocalStorageFallback(chatId, sid, eventsArr);
}

/**
 * @param {string} chatId
 * @param {string} cursorSessionId
 * @returns {Promise<{ v: number, cursorSessionId: string, events: unknown[] }>}
 */
async function resolveBaseDoc(chatId, cursorSessionId) {
  const cached = docCacheByChatId.get(chatId);
  if (cached && cached.cursorSessionId === cursorSessionId) return cached;
  const stored = await readStoredDoc(chatId);
  if (stored && stored.cursorSessionId === cursorSessionId) return stored;
  return { v: STORE_VERSION, cursorSessionId, events: [] };
}

/**
 * Appends records and persists them (throttling is the caller's job).
 *
 * @param {string} chatId
 * @param {string} cursorSessionId
 * @param {unknown | unknown[]} recordOrList
 * @returns {Promise<void>}
 */
export async function appendSdkChatHistoryRecords(chatId, cursorSessionId, recordOrList) {
  if (!chatId) return;
  appendSdkChatHistoryRecordsSync(chatId, cursorSessionId, recordOrList);
  await flushSdkChatHistoryWrites(chatId);
}

/**
 * Flushes records queued by the synchronous append into IndexedDB.
 *
 * Kept under a per-chat promise chain so overlapping flushes cannot each resolve the same
 * base doc and write over one another.
 *
 * @param {string} chatId
 * @returns {Promise<void>}
 */
export function flushSdkChatHistoryWrites(chatId) {
  if (!chatId) return Promise.resolve();
  if (!pendingWriteByChatId.has(chatId)) return flushChainByChatId.get(chatId) || Promise.resolve();
  const previous = flushChainByChatId.get(chatId) || Promise.resolve();
  const next = previous.then(() => runQueuedHistoryWrite(chatId)).catch(() => {});
  flushChainByChatId.set(chatId, next);
  return next;
}

/**
 * @param {string} chatId
 * @returns {Promise<void>}
 */
async function runQueuedHistoryWrite(chatId) {
  const queued = pendingWriteByChatId.get(chatId);
  if (!queued || queued.records.length === 0) {
    pendingWriteByChatId.delete(chatId);
    return;
  }
  pendingWriteByChatId.delete(chatId);
  const base = await resolveBaseDoc(chatId, queued.cursorSessionId);
  const doc = { v: STORE_VERSION, cursorSessionId: queued.cursorSessionId, events: base.events.slice() };
  for (const rec of queued.records) doc.events.push(rec);
  trimDoc(doc, IDB_MAX_JSON_CHARS);
  await writeStoredDocUnified(chatId, doc.cursorSessionId, doc.events);
}

/**
 * Kept for the call sites that flush right before a refresh/pagehide.
 * @param {string} chatId
 * @returns {Promise<void>}
 */
export async function mirrorSdkChatHistoryToIndexedDb(chatId) {
  await flushSdkChatHistoryWrites(chatId);
}

/**
 * Queues records synchronously (no serialization, no storage write) so the streaming path
 * never blocks the main thread. The actual write happens in flushSdkChatHistoryWrites.
 *
 * @param {string} chatId
 * @param {string} cursorSessionId
 * @param {unknown | unknown[]} recordOrList
 * @returns {void}
 */
export function appendSdkChatHistoryRecordsSync(chatId, cursorSessionId, recordOrList) {
  if (!chatId) return;
  const sid = typeof cursorSessionId === 'string' ? cursorSessionId : '';
  const list = Array.isArray(recordOrList) ? recordOrList : [recordOrList];
  const valid = list.filter(isValidSdkHistoryRecord);
  if (valid.length === 0) return;
  const queued = pendingWriteByChatId.get(chatId);
  if (!queued || queued.cursorSessionId !== sid) {
    pendingWriteByChatId.set(chatId, { cursorSessionId: sid, records: valid });
    return;
  }
  for (const rec of valid) queued.records.push(rec);
}

/**
 * Snapshot from the API (e.g. Agent.messages.list).
 *
 * The snapshot supersedes anything still queued: re-appending those records afterwards
 * would duplicate turns that the snapshot already contains.
 *
 * @param {string} chatId
 * @param {string} cursorSessionId
 * @param {unknown[]} events
 * @returns {Promise<void>}
 */
export async function replaceSdkChatHistoryRecords(chatId, cursorSessionId, events) {
  if (!chatId) return;
  const sid = typeof cursorSessionId === 'string' ? cursorSessionId : '';
  const clean = (Array.isArray(events) ? events : []).filter(isValidSdkHistoryRecord);
  pendingWriteByChatId.delete(chatId);
  await writeStoredDocUnified(chatId, sid, clean);
}

/**
 * Builds sdk records from Agent.messages.list rows.
 *
 * @param {Array<Record<string, unknown>>} rows
 * @returns {Array<{ kind: 'sdk', event: Record<string, unknown> }>}
 */
export function sdkHistoryRecordsFromAgentMessageRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  /** @type {Array<{ kind: 'sdk', event: Record<string, unknown> }>} */
  const out = [];
  /**
   * @param {unknown} text
   * @returns {Record<string, unknown> | null}
   */
  const userEventFromText = (text) => {
    if (typeof text !== 'string' || !text.trim()) return null;
    return {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text }],
      },
    };
  };
  /**
   * @param {unknown} text
   * @returns {Record<string, unknown> | null}
   */
  const assistantEventFromText = (text) => {
    if (typeof text !== 'string' || !text.trim()) return null;
    return {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text }],
      },
    };
  };
  /**
   * @param {string} rawKey
   * @returns {string}
   */
  const normalizeToolName = (rawKey) => {
    const k = String(rawKey || '').trim();
    if (!k) return 'tool';
    const base = k.endsWith('ToolCall') ? k.slice(0, -8) : k;
    return base.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  };
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const turn =
      row.message &&
      typeof row.message === 'object' &&
      row.message.agentConversationTurn &&
      typeof row.message.agentConversationTurn === 'object'
        ? row.message.agentConversationTurn
        : null;
    if (turn) {
      const userEv = userEventFromText(turn.userMessage?.text);
      if (userEv) out.push({ kind: 'sdk', event: userEv });
      const steps = Array.isArray(turn.steps) ? turn.steps : [];
      for (const step of steps) {
        if (!step || typeof step !== 'object') continue;
        const assistantEv = assistantEventFromText(step.assistantMessage?.text);
        if (assistantEv) out.push({ kind: 'sdk', event: assistantEv });
        if (step.thinkingMessage?.text) {
          out.push({
            kind: 'sdk',
            event: { type: 'thinking', text: String(step.thinkingMessage.text) },
          });
        }
        if (step.statusMessage?.text) {
          out.push({
            kind: 'sdk',
            event: { type: 'status', status: String(step.statusMessage.text) },
          });
        }
        const tc = step.toolCall;
        if (tc && typeof tc === 'object' && !Array.isArray(tc)) {
          const keys = Object.keys(tc);
          for (const key of keys) {
            const payload = tc[key];
            if (!payload || typeof payload !== 'object') continue;
            const result = payload.result;
            const status = result && typeof result === 'object' && result.error ? 'error' : 'completed';
            out.push({
              kind: 'sdk',
              event: {
                type: 'tool_call',
                name: normalizeToolName(key),
                status,
                args: payload.args && typeof payload.args === 'object' ? payload.args : {},
                result: result && typeof result === 'object' ? result : undefined,
                call_id: typeof payload.toolCallId === 'string' ? payload.toolCallId : undefined,
              },
            });
          }
        }
      }
      continue;
    }
    const ev = cloneSerializableSdkEvent(row);
    if (!ev) continue;
    const tt = typeof ev.type === 'string' ? ev.type.toLowerCase() : '';
    if (
      tt !== 'system' &&
      tt !== 'user' &&
      tt !== 'assistant' &&
      tt !== 'thinking' &&
      tt !== 'tool_call' &&
      tt !== 'status' &&
      tt !== 'task' &&
      tt !== 'request'
    ) {
      continue;
    }
    out.push({ kind: 'sdk', event: ev });
  }
  return out;
}

/**
 * @param {string} chatId
 * @returns {Promise<void>}
 */
export async function clearSdkChatHistory(chatId) {
  docCacheByChatId.delete(chatId);
  pendingWriteByChatId.delete(chatId);
  removeLegacyLocalStorageKey(chatId);
  clearLastAckedSeq(chatId);
  clearOldestLoadedSeq(chatId);
  clearPendingPush(chatId);
  clearClientSeq(chatId);
  try {
    const db = await openSdkHistoryDbOnce();
    if (!db) return;
    await new Promise((resolve) => {
      try {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).delete(chatId);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  } catch {
    /* ignore */
  }
}

/* ============================ BACKEND SYNC ============================ */

/**
 * Monotonic per-chat clientSeq (LS). Makes pushes idempotent.
 * @param {string} chatId
 * @returns {number}
 */
export function nextClientSeq(chatId) {
  if (!chatId || typeof localStorage === 'undefined') return Date.now();
  const key = CLIENTSEQ_LS_PREFIX + chatId;
  let n = 0;
  try {
    n = Number.parseInt(readLocalStorageValue(key) || '0', 10) || 0;
  } catch {
    n = 0;
  }
  n += 1;
  try {
    writeLocalStorageValue(key, String(n));
  } catch {
    /* ignore */
  }
  return n;
}

/** @param {string} chatId */
function clearClientSeq(chatId) {
  if (!chatId || typeof localStorage === 'undefined') return;
  try { removeLocalStorageValue(CLIENTSEQ_LS_PREFIX + chatId); } catch { /* ignore */ }
}

/** @param {string} chatId @returns {number} */
export function getLastAckedSeq(chatId) {
  if (!chatId) return 0;
  if (lastAckedSeqMemory.has(chatId)) {
    return lastAckedSeqMemory.get(chatId) || 0;
  }
  if (typeof localStorage === 'undefined') return 0;
  try {
    const stored = Number.parseInt(readLocalStorageValue(ACKEDSEQ_LS_PREFIX + chatId) || '0', 10) || 0;
    lastAckedSeqMemory.set(chatId, stored);
    return stored;
  } catch {
    return lastAckedSeqMemory.get(chatId) || 0;
  }
}

/** @param {string} chatId @param {number} seq */
function setLastAckedSeq(chatId, seq) {
  if (!chatId || !Number.isSafeInteger(seq) || seq < 0) return;
  lastAckedSeqMemory.set(chatId, seq);
  if (typeof localStorage === 'undefined') return;
  try { writeLocalStorageValue(ACKEDSEQ_LS_PREFIX + chatId, String(seq)); } catch { /* ignore */ }
}

/** @param {string} chatId */
function clearLastAckedSeq(chatId) {
  if (!chatId) return;
  lastAckedSeqMemory.delete(chatId);
  if (typeof localStorage === 'undefined') return;
  try { removeLocalStorageValue(ACKEDSEQ_LS_PREFIX + chatId); } catch { /* ignore */ }
}

/**
 * Seq of the oldest history event held in the local cache — the cursor for paging further back.
 * @param {string} chatId
 * @returns {number}
 */
export function getOldestLoadedSeq(chatId) {
  if (!chatId) return 0;
  if (oldestLoadedSeqMemory.has(chatId)) {
    return oldestLoadedSeqMemory.get(chatId) || 0;
  }
  if (typeof localStorage === 'undefined') return 0;
  try {
    const stored = Number.parseInt(readLocalStorageValue(OLDESTSEQ_LS_PREFIX + chatId) || '0', 10) || 0;
    oldestLoadedSeqMemory.set(chatId, stored);
    return stored;
  } catch {
    return oldestLoadedSeqMemory.get(chatId) || 0;
  }
}

/** @param {string} chatId @param {number} seq */
function setOldestLoadedSeq(chatId, seq) {
  if (!chatId || !Number.isSafeInteger(seq) || seq < 0) return;
  oldestLoadedSeqMemory.set(chatId, seq);
  if (typeof localStorage === 'undefined') return;
  try { writeLocalStorageValue(OLDESTSEQ_LS_PREFIX + chatId, String(seq)); } catch { /* ignore */ }
}

/** @param {string} chatId */
function clearOldestLoadedSeq(chatId) {
  if (!chatId) return;
  oldestLoadedSeqMemory.delete(chatId);
  if (typeof localStorage === 'undefined') return;
  try { removeLocalStorageValue(OLDESTSEQ_LS_PREFIX + chatId); } catch { /* ignore */ }
}

/**
 * Resets in-memory ack cache (tests only).
 */
export function resetLastAckedSeqMemoryForTests() {
  lastAckedSeqMemory.clear();
  oldestLoadedSeqMemory.clear();
}

/**
 * Pending push queue (offline) kept in LS — records with a clientSeq the server has not acked yet.
 * @param {string} chatId
 * @returns {Array<{ rec: unknown, clientSeq: number }>}
 */
function readPendingPush(chatId) {
  if (!chatId || typeof localStorage === 'undefined') return [];
  try {
    const raw = readLocalStorageValue(PENDING_PUSH_LS_PREFIX + chatId);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** @param {string} chatId @param {Array<{ rec: unknown, clientSeq: number }>} items */
function writePendingPush(chatId, items) {
  if (!chatId || typeof localStorage === 'undefined') return;
  try {
    writeLocalStorageValue(PENDING_PUSH_LS_PREFIX + chatId, JSON.stringify(items.slice(-PENDING_PUSH_MAX * 4)));
  } catch {
    /* quota — retry with a shorter queue */
    try {
      writeLocalStorageValue(PENDING_PUSH_LS_PREFIX + chatId, JSON.stringify(items.slice(-PENDING_PUSH_MAX)));
    } catch {
      /* ignore */
    }
  }
}

/** @param {string} chatId */
function clearPendingPush(chatId) {
  if (!chatId || typeof localStorage === 'undefined') return;
  try { removeLocalStorageValue(PENDING_PUSH_LS_PREFIX + chatId); } catch { /* ignore */ }
}

/**
 * Pushes a batch of events to the server: assigns clientSeq, queues the items as pending,
 * then tries the POST. On success updates lastAckedSeq and clears the acked items.
 *
 * @param {string} chatId
 * @param {string} cursorSessionId
 * @param {unknown | unknown[]} recordOrList
 * @returns {Promise<boolean>} — true when the push succeeded (or there was nothing to send)
 */
export async function pushChatHistoryBatch(chatId, cursorSessionId, recordOrList) {
  if (!chatId) return false;
  const list = Array.isArray(recordOrList) ? recordOrList : [recordOrList];
  const newItems = [];
  for (const rec of list) {
    if (!isValidSdkHistoryRecord(rec)) continue;
    newItems.push({ rec, clientSeq: nextClientSeq(chatId) });
  }
  if (newItems.length === 0) return true;

  const pending = readPendingPush(chatId).concat(newItems);
  writePendingPush(chatId, pending);

  return flushPendingPush(chatId, cursorSessionId);
}

/**
 * Tries to send the pending queue to the server. Idempotent (the server dedupes by clientSeq).
 * @param {string} chatId
 * @param {string} cursorSessionId
 * @returns {Promise<boolean>}
 */
export async function flushPendingPush(chatId, cursorSessionId) {
  if (!chatId) return false;
  const pending = readPendingPush(chatId);
  if (pending.length === 0) return true;

  try {
    const r = await postChatHistory(chatId, cursorSessionId || '', pending);
    if (!r || !r.ok) return false;
    // Success — clear the queue; clientSeq dedupe on the server guards against a double write.
    clearPendingPush(chatId);
    if (typeof r.headSeq === 'number') setLastAckedSeq(chatId, r.headSeq);
    return true;
  } catch {
    return false;
  }
}

/**
 * Maps server rows to replay records, dropping clientSeq (sync metadata, not part of the schema).
 *
 * @param {unknown[]} rows
 * @returns {unknown[]}
 */
function historyRecordsFromServerRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((e) => {
      if (!e || typeof e !== 'object') return null;
      const rec = /** @type {{ rec?: unknown }} */ (e).rec;
      if (!isValidSdkHistoryRecord(rec)) return null;
      if (rec && typeof rec === 'object' && 'clientSeq' in rec) {
        const { clientSeq: _drop, ...rest } = /** @type {Record<string, unknown>} */ (rec);
        return rest;
      }
      return rec;
    })
    .filter(Boolean);
}

/**
 * @param {unknown[]} rows
 * @returns {number} seq of the first (oldest) row, 0 when empty
 */
function firstRowSeq(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const seq = Number(/** @type {{ seq?: unknown }} */ (rows[0]).seq);
  return Number.isSafeInteger(seq) ? seq : 0;
}

/**
 * Pulls the newest window of the log (cold open). Older events stay on the server until
 * the user scrolls up — see pullChatHistoryOlderFromServer.
 *
 * @param {string} chatId
 * @param {{ tail?: number }} [options]
 * @returns {Promise<{ cursorSessionId: string, events: unknown[], headSeq: number, oldestLoadedSeq: number, hasOlder: boolean } | null>}
 */
export async function pullChatHistoryTailFromServer(chatId, options = {}) {
  if (!chatId) return null;
  const tail = Number.isFinite(options.tail)
    ? Math.max(1, Number(options.tail))
    : CHAT_HISTORY_INITIAL_TAIL;
  try {
    const r = await getChatHistory(chatId, { tail });
    if (!r || !r.ok) return null;
    const rows = Array.isArray(r.events) ? r.events : [];
    const oldestLoadedSeq = firstRowSeq(rows);
    if (typeof r.headSeq === 'number') setLastAckedSeq(chatId, r.headSeq);
    // 0 doubles as "nothing older on the server" — the cursor is only meaningful while paging back.
    setOldestLoadedSeq(chatId, r.hasOlder === true ? oldestLoadedSeq : 0);
    return {
      cursorSessionId: r.cursorSessionId || '',
      events: historyRecordsFromServerRows(rows),
      headSeq: r.headSeq || 0,
      oldestLoadedSeq,
      hasOlder: r.hasOlder === true,
    };
  } catch (err) {
    appLogger.log('chat-history-pull', 'tail history pull failed', {
      chatId,
      error: String(err?.message || err),
    });
    return null;
  }
}

/**
 * Fetches one page of events older than `beforeSeq`. Render-only: it does not touch the ack
 * cursor nor the local cache, which mirrors the rendered window.
 *
 * @param {string} chatId
 * @param {{ beforeSeq: number, limit?: number }} options
 * @returns {Promise<{ events: unknown[], oldestLoadedSeq: number, hasOlder: boolean } | null>}
 */
export async function pullChatHistoryOlderFromServer(chatId, options) {
  if (!chatId) return null;
  const beforeSeq = Math.max(0, Number(options?.beforeSeq) || 0);
  if (beforeSeq <= 0) return { events: [], oldestLoadedSeq: 0, hasOlder: false };
  const limit = Number.isFinite(options?.limit)
    ? Math.max(1, Number(options.limit))
    : CHAT_HISTORY_OLDER_PAGE;
  try {
    const r = await getChatHistory(chatId, { before: beforeSeq, tail: limit });
    if (!r || !r.ok) return null;
    const rows = Array.isArray(r.events) ? r.events : [];
    return {
      events: historyRecordsFromServerRows(rows),
      oldestLoadedSeq: firstRowSeq(rows),
      hasOlder: r.hasOlder === true,
    };
  } catch (err) {
    appLogger.log('chat-history-pull', 'older history pull failed', {
      chatId,
      error: String(err?.message || err),
    });
    return null;
  }
}

/**
 * Pulls history for a chat that is being opened: always the newest window.
 *
 * A delta pull (since=lastAckedSeq) cannot answer "where does my window start", because cached
 * records carry no seq — so on chats that already had an ack the paging cursor would stay unset
 * and scrolling up would dead-end at the local cache. The tail pull defines both the rendered
 * window and the cursor, and it is cheap (80 events instead of the whole log).
 *
 * @param {string} chatId
 * @param {{ tail?: number }} [options]
 * @returns {Promise<{ cursorSessionId: string, events: unknown[], headSeq: number, oldestLoadedSeq: number, hasOlder: boolean } | null>}
 */
export async function pullChatHistoryFromServer(chatId, options = {}) {
  if (!chatId) return null;
  return pullChatHistoryTailFromServer(chatId, options);
}

/**
 * Fetches records appended since the last acknowledged server seq.
 * Does not advance the cursor — the caller acks it only once the records are rendered.
 *
 * @param {string} chatId
 * @param {{ pageLimit?: number, maxPages?: number }} [options]
 * @returns {Promise<{ cursorSessionId: string, events: unknown[], headSeq: number, ackSeq: number } | null>}
 */
export async function pullChatHistoryDeltaFromServer(chatId, options = {}) {
  if (!chatId) return null;
  const pageLimit = Number.isFinite(options.pageLimit) ? Math.max(1, options.pageLimit) : 2000;
  const maxPages = Number.isFinite(options.maxPages) ? Math.max(1, options.maxPages) : 5;

  let since = getLastAckedSeq(chatId);
  let headSeq = since;
  let cursorSessionId = '';
  const events = [];

  try {
    for (let page = 0; page < maxPages; page += 1) {
      const r = await getChatHistory(chatId, { since, limit: pageLimit });
      if (!r || !r.ok) return null;
      cursorSessionId = r.cursorSessionId || cursorSessionId;
      headSeq = typeof r.headSeq === 'number' ? r.headSeq : headSeq;
      const rows = Array.isArray(r.events) ? r.events : [];

      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const rowSeq = Number(row.seq);
        if (Number.isSafeInteger(rowSeq) && rowSeq > since) since = rowSeq;
        const rec = row.rec;
        if (!isValidSdkHistoryRecord(rec)) continue;
        if (rec && typeof rec === 'object' && 'clientSeq' in rec) {
          const { clientSeq: _drop, ...rest } = /** @type {Record<string, unknown>} */ (rec);
          events.push(rest);
        } else {
          events.push(rec);
        }
      }

      if (!r.hasMore || rows.length === 0) break;
    }

    return { cursorSessionId, events, headSeq, ackSeq: since };
  } catch (err) {
    appLogger.log('chat-history-pull', 'delta history pull failed', {
      chatId,
      error: String(err?.message || err),
    });
    return null;
  }
}

/**
 * @param {string} chatId
 * @param {number} seq
 */
export function acknowledgeChatHistorySeq(chatId, seq) {
  if (!Number.isSafeInteger(seq) || seq < 0) return;
  setLastAckedSeq(chatId, seq);
}

/**
 * Pulls server history delta into the local cache (IndexedDB) without requiring rich view.
 *
 * @param {string} chatId
 * @param {string} [cursorSessionId]
 * @param {{ pageLimit?: number, maxPages?: number }} [options]
 * @returns {Promise<{ cursorSessionId: string, events: unknown[], headSeq: number, ackSeq: number, applied: number } | null>}
 */
export async function syncChatHistoryDeltaFromServer(chatId, cursorSessionId = '', options = {}) {
  const sinceBeforePull = getLastAckedSeq(chatId);
  const serverState = await pullChatHistoryDeltaFromServer(chatId, options);
  if (!serverState) return null;
  const records = Array.isArray(serverState.events) ? serverState.events : [];
  const sessionKey = cursorSessionId || serverState.cursorSessionId || '';
  if (records.length > 0) {
    // A zero ack means the batch is a full rebuild, not a suffix — appending it
    // after a local tail stores last night's turns below tonight's.
    if (sinceBeforePull === 0) {
      await replaceSdkChatHistoryRecords(chatId, sessionKey, records);
    } else {
      appendSdkChatHistoryRecordsSync(chatId, sessionKey, records);
      void mirrorSdkChatHistoryToIndexedDb(chatId).catch((err) => {
        appLogger.log('chat-history-sync', 'IDB mirror failed', {
          chatId,
          error: String(err?.message || err),
        });
      });
    }
  }
  acknowledgeChatHistorySeq(chatId, serverState.ackSeq);
  return {
    cursorSessionId: sessionKey,
    events: records,
    headSeq: serverState.headSeq,
    ackSeq: serverState.ackSeq,
    applied: records.length,
  };
}

/**
 * Backfill: pushes the whole local history to the server (one-off, for pre-existing chats).
 * @param {string} chatId
 * @param {string} cursorSessionId
 * @returns {Promise<boolean>}
 */
export async function backfillChatHistoryToServer(chatId, cursorSessionId) {
  if (!chatId) return false;
  const local = await readSdkChatHistoryStateAsync(chatId);
  if (!local || !Array.isArray(local.events) || local.events.length === 0) return true;
  const items = local.events
    .filter(isValidSdkHistoryRecord)
    .map((rec) => ({ rec, clientSeq: nextClientSeq(chatId) }));
  if (items.length === 0) return true;
  writePendingPush(chatId, items);
  return flushPendingPush(chatId, cursorSessionId);
}
