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
import { postChatHistory, getChatHistory } from '../core/api/index.js';
import { CHAT_HISTORY_INITIAL_TAIL, CHAT_HISTORY_OLDER_PAGE } from '../config.js';
import { appLogger } from '../core/logging/logger.js';
import { probeStart, probeEnd } from './perfProbe.js';
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
/** Pre-namespaced queue (v1): items carry a clientSeq but no producer. Never replayed; quarantined on first read. */
const PENDING_PUSH_LS_PREFIX = 'cretli-chat-history-pending-push-';
/** Namespaced queue (v3): `{ v, producerId, datasetGeneration, chatEpoch, items, inflight, blocked }`. */
const PENDING_QUEUE_LS_PREFIX = 'cretli-chat-history-pending-queue-';
const PENDING_QUARANTINE_LS_PREFIX = 'cretli-chat-history-pending-quarantine-';
const HISTORY_IDENTITY_LS_PREFIX = 'cretli-chat-history-identity-';

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
 * Typed refusal of the pending push queue: the queue could not be made durable (storage quota/unavailable), so the
 * records were NOT queued and no acknowledgement may be implied. Nothing already queued is touched.
 */
export class PendingQueueStorageError extends Error {
  /** @param {string} message @param {string} [chatId] */
  constructor(message, chatId = '') {
    super(message);
    this.name = 'PendingQueueStorageError';
    this.code = 'pending_queue_storage_failed';
    this.chatId = chatId;
  }
}

/**
 * @typedef {{ rec: unknown, clientSeq: number }} PendingPushItem
 * @typedef {{
 *   v: 3,
 *   producerId: string,
 *   datasetGeneration: string | null,
 *   chatEpoch: string | null,
 *   items: PendingPushItem[],
 *   inflight: { count: number, retryToken: string } | null,
 *   blocked: { code: string, at: string } | null,
 * }} PendingPushQueue
 */

/** Queue bounds: a queue that cannot fit is refused BEFORE it is mutated (the caller keeps its input). */
export const PENDING_QUEUE_MAX_ITEMS = 1000;
export const PENDING_QUEUE_MAX_BYTES = 4 * 1024 * 1024;
/** One POST: at most this many events / UTF-8 wire bytes (backend allows 1024 / 8 MiB; one valid 3 MiB record fits). */
export const PENDING_POST_MAX_EVENTS = 128;
export const PENDING_POST_MAX_BYTES = 3.5 * 1024 * 1024;

/** Typed refusals of the queue, none of which touches what is already queued. */
export class PendingQueueRefusedError extends PendingQueueStorageError {
  /** @param {string} code @param {string} message @param {string} [chatId] */
  constructor(code, message, chatId = '') {
    super(message, chatId);
    this.code = code;
  }
}

const textEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
/** @param {string} text @returns {number} UTF-8 bytes */
const utf8Bytes = (text) => (textEncoder ? textEncoder.encode(text).length : unescape(encodeURIComponent(text)).length);
/** @param {PendingPushItem} item @returns {number} wire bytes of one queued event */
const itemWireBytes = (item) => utf8Bytes(JSON.stringify({ rec: item.rec, clientSeq: item.clientSeq })) + 1;

/** @returns {string} browser queue producer: stable per chat queue, never a server producer */
function newQueueProducerId() {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `queue:${random}`;
}

/** @param {{ datasetGeneration?: string | null, chatEpoch?: string | null } | null} [identity] @returns {PendingPushQueue} */
function emptyPendingQueue(identity = null) {
  return {
    v: 3,
    producerId: newQueueProducerId(),
    datasetGeneration: identity?.datasetGeneration || null,
    chatEpoch: identity?.chatEpoch || null,
    items: [],
    inflight: null,
    blocked: null,
  };
}

/**
 * Serialize every queue mutation (clientSeq allocation, enqueue, ACK, block) across tabs of one origin. The lock is
 * NOT held while a POST is in flight. Without Web Locks there is no safe cross-tab read-modify-write, so the
 * operation is refused with a typed error and the queue is left untouched.
 * @template T
 * @param {string} chatId @param {() => T | Promise<T>} fn @returns {Promise<T>}
 */
async function withQueueLock(chatId, fn) {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks || typeof locks.request !== 'function') {
    throw new PendingQueueRefusedError('pending_queue_lock_unavailable', 'Cross-tab queue locking (Web Locks) is unavailable; the queue was not touched', chatId);
  }
  return locks.request(`cretli-chat-history-queue-${chatId}`, async () => fn());
}

/**
 * Move an un-namespaced v1 queue aside. It is kept (explicit reconcile/diagnosis), never replayed and never
 * dropped: replaying it would write records without a producer identity into whatever generation the chat has now.
 * @param {string} chatId
 */
function quarantineLegacyPendingPush(chatId) {
  const raw = readLocalStorageValue(PENDING_PUSH_LS_PREFIX + chatId);
  if (!raw) return;
  try {
    writeLocalStorageValue(PENDING_QUARANTINE_LS_PREFIX + chatId, raw);
  } catch (error) {
    // Cannot preserve it elsewhere: leave the v1 key untouched (it is not read by anything else) and refuse.
    throw new PendingQueueStorageError(`Could not quarantine the old pending queue: ${String(error?.message || error)}`, chatId);
  }
  removeLocalStorageValue(PENDING_PUSH_LS_PREFIX + chatId);
}

/** @param {unknown} value @returns {value is Record<string, any>} */
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * Strict parse of a stored queue: the WHOLE queue is validated; any malformed part makes it corrupt (never a silent
 * filter that would drop an entry on the next write).
 * @param {string} raw @param {string} chatId @returns {PendingPushQueue}
 */
function parseStoredQueue(raw, chatId) {
  const corrupt = (why) => new PendingQueueRefusedError('pending_queue_corrupt', `The stored pending queue is unreadable (${why}); it was kept as is`, chatId);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw corrupt('invalid JSON');
  }
  if (!isPlainObject(parsed) || (parsed.v !== 2 && parsed.v !== 3) || typeof parsed.producerId !== 'string' || !parsed.producerId || !Array.isArray(parsed.items)) throw corrupt('unexpected shape');
  let last = 0;
  for (const item of parsed.items) {
    if (!isPlainObject(item) || !Number.isSafeInteger(item.clientSeq) || item.clientSeq <= last || !isValidSdkHistoryRecord(item.rec)) throw corrupt('invalid entry');
    last = item.clientSeq;
  }
  const optionalString = (value) => (typeof value === 'string' && value ? value : null);
  if (parsed.inflight !== null && parsed.inflight !== undefined
    && !(isPlainObject(parsed.inflight) && Number.isInteger(parsed.inflight.count) && parsed.inflight.count > 0 && typeof parsed.inflight.retryToken === 'string')) throw corrupt('invalid inflight');
  if (parsed.blocked !== null && parsed.blocked !== undefined && !(isPlainObject(parsed.blocked) && typeof parsed.blocked.code === 'string')) throw corrupt('invalid blocked');
  const queue = {
    v: 3,
    producerId: parsed.producerId,
    datasetGeneration: optionalString(parsed.datasetGeneration),
    chatEpoch: optionalString(parsed.chatEpoch),
    items: parsed.items,
    inflight: parsed.inflight ?? null,
    blocked: parsed.blocked ?? null,
  };
  // An old v2 queue was bound to an epoch only: its records are never replayed on a guess about the generation.
  if (parsed.v === 2 && queue.items.length > 0 && !queue.blocked) queue.blocked = { code: 'history_unbound_queue', at: new Date().toISOString() };
  return queue;
}

/**
 * @param {string} chatId
 * @returns {PendingPushQueue}
 * @throws {PendingQueueStorageError} storage unavailable/denied (typed, never an empty queue) or the stored queue is corrupt
 */
function readPendingQueue(chatId) {
  if (!chatId) return emptyPendingQueue();
  if (typeof localStorage === 'undefined') throw new PendingQueueRefusedError('pending_queue_storage_unavailable', 'localStorage is unavailable; the pending queue cannot be read or written', chatId);
  let raw;
  try {
    quarantineLegacyPendingPush(chatId);
    raw = readLocalStorageValue(PENDING_QUEUE_LS_PREFIX + chatId);
  } catch (error) {
    if (error instanceof PendingQueueStorageError) throw error;
    throw new PendingQueueRefusedError('pending_queue_storage_unavailable', `localStorage could not be read: ${String(error?.message || error)}`, chatId);
  }
  return raw ? parseStoredQueue(raw, chatId) : emptyPendingQueue(readStoredHistoryIdentity(chatId));
}

/**
 * Persist the queue. A storage failure throws `PendingQueueStorageError`: the caller must not treat its records as
 * queued (and must not drop or shorten what is already queued to make room).
 * @param {string} chatId @param {PendingPushQueue} queue
 */
function writePendingQueue(chatId, queue) {
  if (!chatId) return;
  if (typeof localStorage === 'undefined') throw new PendingQueueRefusedError('pending_queue_storage_unavailable', 'localStorage is unavailable; the pending queue cannot be written', chatId);
  try {
    // An empty queue is kept while it carries the identity it was bound to (its producer survives a drain).
    if (queue.items.length === 0 && !queue.inflight && !queue.chatEpoch) {
      removeLocalStorageValue(PENDING_QUEUE_LS_PREFIX + chatId);
      return;
    }
    writeLocalStorageValue(PENDING_QUEUE_LS_PREFIX + chatId, JSON.stringify(queue));
  } catch (error) {
    throw new PendingQueueStorageError(`The pending push queue could not be stored: ${String(error?.message || error)}`, chatId);
  }
}

/**
 * The local chat was cleared: a non-empty queue is set aside in the quarantine key (explicit reconciliation), never
 * silently removed. An empty queue is simply removed. A corrupt or unreadable queue is left where it is.
 * @param {string} chatId
 */
function clearPendingPush(chatId) {
  if (!chatId || typeof localStorage === 'undefined') return;
  try {
    const queue = readPendingQueue(chatId);
    if (queue.items.length > 0) {
      let kept = [];
      try {
        kept = JSON.parse(readLocalStorageValue(PENDING_QUARANTINE_LS_PREFIX + chatId) || '[]');
        if (!Array.isArray(kept)) kept = [{ legacyRaw: String(kept) }];
      } catch {
        kept = [];
      }
      kept.push({ at: new Date().toISOString(), queue });
      writeLocalStorageValue(PENDING_QUARANTINE_LS_PREFIX + chatId, JSON.stringify(kept));
    }
    removeLocalStorageValue(PENDING_QUEUE_LS_PREFIX + chatId);
  } catch {
    // The queue stays where it is (still bound to its producer and identity) when it cannot be set aside.
  }
}

/**
 * Local view of the queue for diagnostics and explicit reconciliation.
 * @param {string} chatId
 * @returns {{ producerId: string | null, datasetGeneration: string | null, chatEpoch: string | null, pending: number, blocked: { code: string, at: string } | null, quarantined: boolean }}
 */
export function getPendingPushState(chatId) {
  let queue;
  try {
    queue = readPendingQueue(chatId);
  } catch (error) {
    return { producerId: null, datasetGeneration: null, chatEpoch: null, pending: 0, blocked: { code: String(/** @type {any} */ (error)?.code || 'pending_queue_unreadable'), at: new Date().toISOString() }, quarantined: false };
  }
  return {
    producerId: queue.producerId,
    datasetGeneration: queue.datasetGeneration,
    chatEpoch: queue.chatEpoch,
    pending: queue.items.length,
    blocked: queue.blocked,
    quarantined: Boolean(readLocalStorageValue(PENDING_QUARANTINE_LS_PREFIX + chatId)),
  };
}

/**
 * Explicit reconciliation of a blocked queue: bind it to the server's CURRENT history identity so the queued records
 * are written into the chat as it is now. This is the user's/operator's decision, never automatic.
 * @param {string} chatId @returns {Promise<void>}
 */
export function adoptPendingPushIdentity(chatId) {
  return withQueueLock(chatId, () => {
    const queue = readPendingQueue(chatId);
    const identity = readStoredHistoryIdentity(chatId);
    if (!isCompleteIdentity(identity)) {
      throw new PendingQueueRefusedError('pending_queue_identity_unknown', 'The server history identity (dataset generation + chat epoch) is not known yet; read the chat from the server first', chatId);
    }
    queue.datasetGeneration = identity.datasetGeneration;
    queue.chatEpoch = identity.chatEpoch;
    queue.blocked = null;
    queue.inflight = null;
    writePendingQueue(chatId, queue);
  });
}

/**
 * Explicit discard of the queue (reconciliation by deletion). Nothing else removes queued records. A corrupt queue is
 * moved to the quarantine key first.
 * @param {string} chatId @returns {Promise<number>} records discarded
 */
export function discardPendingPush(chatId) {
  return withQueueLock(chatId, () => {
    let count = 0;
    try {
      count = readPendingQueue(chatId).items.length;
    } catch (error) {
      if (/** @type {any} */ (error)?.code !== 'pending_queue_corrupt') throw error;
      writeLocalStorageValue(PENDING_QUARANTINE_LS_PREFIX + chatId, JSON.stringify([{ at: new Date().toISOString(), corruptRaw: readLocalStorageValue(PENDING_QUEUE_LS_PREFIX + chatId) }]));
    }
    removeLocalStorageValue(PENDING_QUEUE_LS_PREFIX + chatId);
    return count;
  });
}

/** @param {{ datasetGeneration?: string | null, chatEpoch?: string | null } | null | undefined} identity @returns {identity is { datasetGeneration: string, chatEpoch: string }} */
function isCompleteIdentity(identity) {
  return Boolean(identity && typeof identity.datasetGeneration === 'string' && identity.datasetGeneration && typeof identity.chatEpoch === 'string' && identity.chatEpoch);
}

/** @param {string} chatId @returns {{ datasetGeneration?: string, chatEpoch: string } | null} */
function readStoredHistoryIdentity(chatId) {
  if (!chatId || typeof localStorage === 'undefined') return null;
  try {
    const parsed = JSON.parse(readLocalStorageValue(HISTORY_IDENTITY_LS_PREFIX + chatId) || 'null');
    return parsed && typeof parsed.chatEpoch === 'string' && parsed.chatEpoch ? parsed : null;
  } catch {
    return null;
  }
}

/** @param {PendingPushQueue} queue @param {{ datasetGeneration?: string, chatEpoch?: string } | null | undefined} identity @returns {boolean} */
function queueMatchesIdentity(queue, identity) {
  if (!identity) return true;
  if (queue.chatEpoch && identity.chatEpoch && queue.chatEpoch !== identity.chatEpoch) return false;
  if (queue.datasetGeneration && identity.datasetGeneration && queue.datasetGeneration !== identity.datasetGeneration) return false;
  return true;
}

/**
 * Remember the per-chat identity (dataset generation + chat epoch) a server response carried. A CHANGED identity
 * (reset, fork replacement, restore, other backend generation) means the local cache and the queue belong to a
 * different history:
 *   - the delta cursor is dropped so the next pull starts from scratch instead of gluing two histories together;
 *   - a queue bound to the old identity is blocked (kept, never replayed into the new history, never re-bound here).
 * The queue block is applied under the cross-tab lock; `queueUpdate` settles when it was written.
 *
 * @param {string} chatId
 * @param {{ datasetGeneration?: string, chatEpoch?: string } | null | undefined} identity
 * @returns {{ changed: boolean, queueUpdate: Promise<void> }}
 */
export function noteServerHistoryIdentity(chatId, identity) {
  const unchanged = { changed: false, queueUpdate: Promise.resolve() };
  if (!chatId || !identity || typeof identity.chatEpoch !== 'string' || !identity.chatEpoch) return unchanged;
  const previous = readStoredHistoryIdentity(chatId);
  const changed = Boolean(previous && (previous.chatEpoch !== identity.chatEpoch || (identity.datasetGeneration && previous.datasetGeneration && previous.datasetGeneration !== identity.datasetGeneration)));
  try {
    writeLocalStorageValue(HISTORY_IDENTITY_LS_PREFIX + chatId, JSON.stringify({ datasetGeneration: identity.datasetGeneration, chatEpoch: identity.chatEpoch }));
  } catch {
    /* the identity is re-learned from the next response */
  }
  if (!changed) return unchanged;
  clearLastAckedSeq(chatId);
  const queueUpdate = withQueueLock(chatId, () => {
    const queue = readPendingQueue(chatId);
    if (queue.items.length > 0 && !queue.blocked && !queueMatchesIdentity(queue, identity)) {
      queue.blocked = { code: 'history_stale_client_identity', at: new Date().toISOString() };
      writePendingQueue(chatId, queue);
    }
  }).catch(() => {
    /* the server refuses a stale-identity write anyway */
  });
  return { changed, queueUpdate };
}

/**
 * Append items to the queue under the lock, all or nothing. clientSeq is allocated inside the lock, so two tabs never
 * hand out the same number. Refused (typed, queue untouched) when the queue is blocked-corrupt, full or not storable.
 * @param {string} chatId @param {unknown[]} records @returns {Promise<void>}
 */
function enqueueRecords(chatId, records) {
  // Snapshot of the server identity the caller KNOWS, taken before any await: a fresh queue is bound to it (never to
  // whatever the first acknowledged write happens to report).
  const known = readStoredHistoryIdentity(chatId);
  return withQueueLock(chatId, () => {
    const queue = readPendingQueue(chatId);
    if (queue.items.length === 0 && !queue.inflight && !isCompleteIdentity(queue)) {
      if (!isCompleteIdentity(known)) {
        throw new PendingQueueRefusedError('pending_queue_identity_unknown', 'The server history identity (dataset generation + chat epoch) is not known yet; the records were not queued - read the chat from the server and retry', chatId);
      }
      queue.datasetGeneration = known.datasetGeneration;
      queue.chatEpoch = known.chatEpoch;
    }
    const added = records.map((rec) => ({ rec, clientSeq: 0 }));
    const addedBytes = added.reduce((sum, item) => sum + itemWireBytes({ rec: item.rec, clientSeq: Number.MAX_SAFE_INTEGER }), 0);
    const queuedBytes = queue.items.reduce((sum, item) => sum + itemWireBytes(item), 0);
    if (queue.items.length + added.length > PENDING_QUEUE_MAX_ITEMS || queuedBytes + addedBytes > PENDING_QUEUE_MAX_BYTES) {
      throw new PendingQueueRefusedError('pending_queue_full', 'The pending push queue is full; the new records were not queued', chatId);
    }
    for (const item of added) item.clientSeq = nextClientSeq(chatId);
    queue.items.push(...added);
    writePendingQueue(chatId, queue);
  });
}

/**
 * Queue records for the server and try to send them. The records are durable in the queue (or the call throws a typed
 * `PendingQueueStorageError` and nothing was queued) BEFORE the first POST; nothing is ever dropped to fit a bound.
 *
 * @param {string} chatId
 * @param {string} cursorSessionId
 * @param {unknown | unknown[]} recordOrList
 * @returns {Promise<boolean>} true when the server acknowledged everything queued (or there was nothing to send)
 */
export async function pushChatHistoryBatch(chatId, cursorSessionId, recordOrList) {
  if (!chatId) return false;
  const list = Array.isArray(recordOrList) ? recordOrList : [recordOrList];
  const valid = list.filter((rec) => isValidSdkHistoryRecord(rec));
  if (valid.length === 0) return true;
  await enqueueRecords(chatId, valid);
  return flushPendingPush(chatId, cursorSessionId);
}

/** @type {Map<string, Promise<boolean>>} */
const pushFlushByChatId = new Map();

/**
 * Send the queue to the server. One flush per chat per tab at a time; the server dedupes by (producer, clientSeq).
 * Only the records the server ACKNOWLEDGED leave the queue (selectively, by clientSeq, and only when the queue is still
 * the one that was sent), so records queued while the POST was in flight survive. A refusal or a lost reply keeps
 * everything; a lost reply keeps the SAME batch and its `retryToken` for the next attempt. A stale identity or an
 * un-namespaced old client blocks the queue instead of replaying it. Never rejects: any queue/storage refusal is `false`.
 *
 * @param {string} chatId
 * @param {string} cursorSessionId
 * @returns {Promise<boolean>}
 */
export async function flushPendingPush(chatId, cursorSessionId) {
  if (!chatId) return false;
  const running = pushFlushByChatId.get(chatId);
  if (running) return running;
  const task = drainPendingPush(chatId, cursorSessionId).finally(() => {
    if (pushFlushByChatId.get(chatId) === task) pushFlushByChatId.delete(chatId);
  });
  pushFlushByChatId.set(chatId, task);
  return task;
}

/**
 * Send until the queue is empty or a send did not make the queue shrink (records queued while a POST was in
 * flight are sent by the next round instead of waiting for another trigger).
 * @param {string} chatId @param {string} cursorSessionId @returns {Promise<boolean>}
 */
async function drainPendingPush(chatId, cursorSessionId) {
  try {
    for (let round = 0; round < 200; round += 1) {
      const outcome = await flushPendingPushNow(chatId, cursorSessionId);
      if (outcome !== 'more') return outcome === true;
    }
  } catch {
    /* typed queue refusals (storage, corrupt, no lock) are visible through getPendingPushState; nothing was ACKed */
  }
  return false;
}

/**
 * The next send unit: the frozen in-flight batch, or the head of the queue within the per-POST bounds.
 * @param {PendingPushQueue} queue @returns {number} item count (>= 1 for a non-empty queue)
 */
function nextSendCount(queue) {
  if (queue.inflight) return Math.min(queue.inflight.count, queue.items.length);
  let bytes = 0;
  let count = 0;
  for (const item of queue.items) {
    const size = itemWireBytes(item);
    if (count > 0 && (count >= PENDING_POST_MAX_EVENTS || bytes + size > PENDING_POST_MAX_BYTES)) break;
    bytes += size;
    count += 1;
  }
  return count;
}

/** @param {string} chatId @param {string} cursorSessionId @returns {Promise<boolean | 'more'>} 'more' = acknowledged, records remain */
async function flushPendingPushNow(chatId, cursorSessionId) {
  // Step 1 (locked): freeze exactly what is sent. The lock is released before the network call.
  const plan = await withQueueLock(chatId, () => {
    const queue = readPendingQueue(chatId);
    if (queue.items.length === 0 || queue.blocked) return null;
    if (!isCompleteIdentity(queue)) {
      // An unbound queue (legacy v2 or an older v3) is never adopted automatically: explicit reconciliation only.
      queue.blocked = { code: 'history_identity_unknown', at: new Date().toISOString() };
      writePendingQueue(chatId, queue);
      return null;
    }
    const count = nextSendCount(queue);
    return {
      producerId: queue.producerId,
      datasetGeneration: queue.datasetGeneration,
      chatEpoch: queue.chatEpoch,
      retryToken: queue.inflight ? queue.inflight.retryToken : undefined,
      count,
      sending: queue.items.slice(0, count),
    };
  });
  if (!plan) return readPendingQueueEmpty(chatId);
  let r;
  try {
    r = await postChatHistory(chatId, cursorSessionId || '', plan.sending, {
      queueProducerId: plan.producerId,
      datasetGeneration: plan.datasetGeneration,
      chatEpoch: plan.chatEpoch,
      ...(plan.retryToken ? { retryToken: plan.retryToken } : {}),
    });
  } catch {
    return false;
  }
  // Step 2 (locked): apply the outcome ONLY to the queue that was sent (same producer); a reset/replaced queue is not touched.
  return withQueueLock(chatId, () => {
    const queue = readPendingQueue(chatId);
    // The queue must still be EXACTLY the one that was sent (producer + dataset generation + chat epoch), checked before
    // any filtering or in-flight reset: an explicit adopt may have re-bound the same producer to a new identity while
    // the POST was in flight, and a late ACK of the old identity must not remove records of the new one.
    if (queue.producerId !== plan.producerId || queue.datasetGeneration !== plan.datasetGeneration || queue.chatEpoch !== plan.chatEpoch) return false;
    const block = (code) => {
      queue.blocked = { code, at: new Date().toISOString() };
      writePendingQueue(chatId, queue);
      return false;
    };
    if (r && r.ok) {
      const identity = r.identity && typeof r.identity.chatEpoch === 'string' ? r.identity : null;
      if (identity && !queueMatchesIdentity(queue, identity)) {
        // The ACK reports another identity than the one the batch was pinned to: keep the raw items, block for reconcile.
        return block('history_stale_client_identity');
      }
      const sentSeqs = new Set(plan.sending.map((item) => item.clientSeq));
      queue.items = queue.items.filter((item) => !sentSeqs.has(item.clientSeq));
      queue.inflight = null;
      let mismatch = false;
      if (identity) {
        // Never learn the queue identity from an ACK: the batch was pinned before the write.
        noteServerHistoryIdentity(chatId, identity);
      }
      if (mismatch && queue.items.length > 0) queue.blocked = { code: 'history_stale_client_identity', at: new Date().toISOString() };
      writePendingQueue(chatId, queue);
      if (typeof r.headSeq === 'number') setLastAckedSeq(chatId, r.headSeq);
      if (queue.blocked) return false;
      return queue.items.length === 0 ? true : 'more';
    }
    if (r && (r.code === 'history_stale_client_identity' || r.code === 'history_unnamespaced_input')) return block(r.code);
    if (r && typeof r.retryToken === 'string' && r.retryToken) {
      // The batch may be partly or wholly committed: keep the same items and the token until it is acknowledged.
      queue.inflight = { count: plan.count, retryToken: r.retryToken };
      writePendingQueue(chatId, queue);
    } else if (r && queue.inflight && (r.code === 'history_batch_unknown' || r.code === 'history_batch_mismatch')) {
      // The server no longer knows the token (it finished or was quarantined): stop pretending; block for reconcile.
      return block(r.code);
    }
    return false;
  });
}

/** @param {string} chatId @returns {Promise<boolean>} true only when the queue is verifiably empty (never for a blocked one) */
function readPendingQueueEmpty(chatId) {
  return withQueueLock(chatId, () => readPendingQueue(chatId).items.length === 0);
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
        return { ...rest, historySeq: Number(/** @type {{ seq?: unknown }} */ (e).seq) || 0 };
      }
      return {
        .../** @type {Record<string, unknown>} */ (rec),
        historySeq: Number(/** @type {{ seq?: unknown }} */ (e).seq) || 0,
      };
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
/** @type {Map<string, Promise<unknown>>} */
const historyTailFlights = new Map();

export async function pullChatHistoryTailFromServer(chatId, options = {}) {
  if (!chatId) return null;
  const tail = Number.isFinite(options.tail)
    ? Math.max(1, Number(options.tail))
    : CHAT_HISTORY_INITIAL_TAIL;
  const flightKey = `${chatId}:${tail}`;
  const existing = historyTailFlights.get(flightKey);
  if (existing) return existing;
  const flight = loadChatHistoryTail(chatId, tail);
  historyTailFlights.set(flightKey, flight);
  try {
    return await flight;
  } finally {
    if (historyTailFlights.get(flightKey) === flight) historyTailFlights.delete(flightKey);
  }
}

/**
 * @param {string} chatId
 * @param {number} tail
 */
async function loadChatHistoryTail(chatId, tail) {
  try {
    const fetchProbe = probeStart('chat.history.fetch');
    let r;
    try {
      r = await getChatHistory(chatId, { tail });
    } finally {
      probeEnd(fetchProbe);
    }
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
 * @returns {Promise<{ cursorSessionId: string, events: unknown[], headSeq: number, ackSeq: number, incomplete: boolean } | null>}
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
          events.push({ ...rest, historySeq: Number.isSafeInteger(rowSeq) ? rowSeq : 0 });
        } else {
          events.push({
            .../** @type {Record<string, unknown>} */ (rec),
            historySeq: Number.isSafeInteger(rowSeq) ? rowSeq : 0,
          });
        }
      }

      if (!r.hasMore || rows.length === 0) break;
    }

    return {
      cursorSessionId,
      events,
      headSeq,
      ackSeq: since,
      incomplete: headSeq > since,
    };
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
 * @returns {Promise<{ cursorSessionId: string, events: unknown[], headSeq: number, ackSeq: number, applied: number, incomplete: boolean, status: 'success' | 'partial' } | null>}
 */
export async function syncChatHistoryDeltaFromServer(chatId, cursorSessionId = '', options = {}) {
  const sinceBeforePull = getLastAckedSeq(chatId);
  const serverState = await pullChatHistoryDeltaFromServer(chatId, options);
  if (!serverState) return null;
  return ingestChatHistoryDeltaResponse(chatId, cursorSessionId, serverState, sinceBeforePull);
}

/**
 * Normalize a GET /history or POST /history-batch row into store records.
 *
 * @param {{ events?: unknown[], ackSeq?: number }} page
 * @param {number} [sinceBeforePull]
 * @returns {{ records: unknown[], ackSeq: number }}
 */
function normalizeHistoryDeltaPage(page, sinceBeforePull = 0) {
  const rows = Array.isArray(page?.events) ? page.events : [];
  const records = [];
  let ackSeq = Number.isFinite(Number(page?.ackSeq)) ? Number(page.ackSeq) : sinceBeforePull;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const wrapped = /** @type {{ seq?: unknown, rec?: unknown, historySeq?: unknown }} */ (row);
    if (wrapped.rec != null) {
      const rowSeq = Number(wrapped.seq);
      if (Number.isSafeInteger(rowSeq) && rowSeq > ackSeq) ackSeq = rowSeq;
      const rec = wrapped.rec;
      if (!isValidSdkHistoryRecord(rec)) continue;
      if (rec && typeof rec === 'object' && 'clientSeq' in rec) {
        const { clientSeq: _drop, ...rest } = /** @type {Record<string, unknown>} */ (rec);
        records.push({ ...rest, historySeq: Number.isSafeInteger(rowSeq) ? rowSeq : 0 });
      } else {
        records.push({
          .../** @type {Record<string, unknown>} */ (rec),
          historySeq: Number.isSafeInteger(rowSeq) ? rowSeq : 0,
        });
      }
      continue;
    }
    if (!isValidSdkHistoryRecord(row)) continue;
    const rowSeq = Number(wrapped.historySeq);
    if (Number.isSafeInteger(rowSeq) && rowSeq > ackSeq) ackSeq = rowSeq;
    records.push(row);
  }
  return { records, ackSeq };
}

/**
 * Apply one already-fetched history page (single GET or batch POST row).
 *
 * @param {string} chatId
 * @param {string} [cursorSessionId]
 * @param {{ events?: unknown[], headSeq?: number, cursorSessionId?: string, hasMore?: boolean, ackSeq?: number, incomplete?: boolean }} page
 * @param {number} [sinceBeforePull]
 */
export async function ingestChatHistoryDeltaResponse(chatId, cursorSessionId = '', page, sinceBeforePull = 0) {
  if (!chatId || !page) return null;
  // A different chat epoch/generation than the one this cache was built from (reset, fork replacement, restore):
  // a delta on top of the old cache would glue two histories together. Drop the cursor and ask for a full re-pull.
  const identity = noteServerHistoryIdentity(chatId, page.identity);
  if (identity.changed && sinceBeforePull > 0) {
    return {
      cursorSessionId: cursorSessionId || page.cursorSessionId || '',
      events: [],
      headSeq: typeof page.headSeq === 'number' ? page.headSeq : 0,
      ackSeq: 0,
      applied: 0,
      incomplete: true,
      identityChanged: true,
      status: 'partial',
    };
  }
  const { records, ackSeq } = normalizeHistoryDeltaPage(page, sinceBeforePull);
  const sessionKey = cursorSessionId || page.cursorSessionId || '';
  if (records.length > 0) {
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
  acknowledgeChatHistorySeq(chatId, ackSeq);
  const headSeq = typeof page.headSeq === 'number' ? page.headSeq : ackSeq;
  const incomplete = page.incomplete === true || page.hasMore === true || headSeq > ackSeq;
  return {
    cursorSessionId: sessionKey,
    events: records,
    headSeq,
    ackSeq,
    applied: records.length,
    incomplete,
    status: incomplete ? 'partial' : 'success',
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
  const items = local.events.filter(isValidSdkHistoryRecord).map((rec) => ({ rec }));
  if (items.length === 0) return true;
  await enqueueRecords(chatId, items.map((item) => item.rec));
  return flushPendingPush(chatId, cursorSessionId);
}
