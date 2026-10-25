/**
 * Offline cold-start seed: rebuild the synchronous localStorage bootstrap from the
 * durable IndexedDB boot snapshot when the localStorage copy is missing.
 *
 * Context (todo 1a336b36): the durable chat boot snapshot (`cretli-chat-boot-cache-v1`)
 * is persisted in `cretli-chat-metadata`/`meta`. The synchronous cold-start bootstrap
 * (`cretli-chat-boot-sync-v1` in localStorage) is the only source
 * `chatController.hydrateChatListFromLocalBootCache()` reads before paint. When it is
 * absent the SPA has no chat list to select the requested `?chat=<id>` from, and the
 * IDB fallback is never scheduled (the controller returns before
 * `scheduleAsyncBootCacheHydration()`).
 *
 * On an offline cold start we therefore read the durable snapshot straight from
 * IndexedDB and write it back into the synchronous localStorage document, so the
 * normal hydration path works without touching the service worker `/api/*` contract.
 *
 * The IDB read is intentionally raw (no session-scope filtering): at this point the
 * app has not established its chat session scope yet, and the snapshot is local data
 * that outlives a session boundary. Reads only — this module never creates the DB.
 */

import {
  CHAT_LOCAL_BOOT_CACHE_KEY,
  parseChatLocalBootCache,
} from './chatLocalBootCache.js';
import { buildChatLocalBootSyncDoc, hasLocalChatBootCacheForColdStart, writeChatLocalBootSync } from './chatLocalBootSync.js';
import {
  CHAT_METADATA_IDB_NAME,
  CHAT_METADATA_STORE_META,
} from './chatMetadataIdbSchema.js';

/** Max time to wait for the raw IDB read during an offline boot decision. */
export const OFFLINE_BOOT_IDB_READ_TIMEOUT_MS = 1500;

/**
 * @param {IDBRequest | null | undefined} request
 * @returns {Promise<unknown>}
 */
function requestResult(request) {
  return new Promise((resolve, reject) => {
    if (!request) {
      reject(new Error('no-request'));
      return;
    }
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('idb-request-error'));
  });
}

/**
 * @param {IDBFactory | null | undefined} idbFactory
 * @returns {Promise<IDBDatabase | null>}
 */
function openMetadataDb(idbFactory) {
  return new Promise((resolve) => {
    if (!idbFactory || typeof idbFactory.open !== 'function') {
      resolve(null);
      return;
    }
    let request;
    try {
      request = idbFactory.open(CHAT_METADATA_IDB_NAME);
    } catch (_) {
      resolve(null);
      return;
    }
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

/**
 * Whether `cretli-chat-metadata` exists, without creating it.
 *
 * @param {IDBFactory | null | undefined} idbFactory
 * @returns {Promise<boolean>}
 */
async function metadataDbExists(idbFactory) {
  if (!idbFactory || typeof idbFactory.databases !== 'function') return false;
  try {
    const dbs = await idbFactory.databases();
    return Array.isArray(dbs) && dbs.some((db) => db && db.name === CHAT_METADATA_IDB_NAME);
  } catch (_) {
    return false;
  }
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} timeoutMs
 * @returns {Promise<T | null>}
 */
function withTimeout(promise, timeoutMs) {
  if (!(timeoutMs > 0)) return promise;
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer != null) clearTimeout(timer);
  });
}

/**
 * Read the durable full boot snapshot from IndexedDB. Never creates the database.
 *
 * @param {{ idbFactory?: IDBFactory | null, timeoutMs?: number }} [options]
 * @returns {Promise<ReturnType<typeof parseChatLocalBootCache> | null>}
 */
export async function readLocalBootCacheDocFromIdb(options = {}) {
  const idbFactory = options.idbFactory === undefined
    ? (typeof indexedDB !== 'undefined' ? indexedDB : null)
    : options.idbFactory;
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(0, Number(options.timeoutMs))
    : OFFLINE_BOOT_IDB_READ_TIMEOUT_MS;

  if (!(await metadataDbExists(idbFactory))) return null;

  /** @type {IDBDatabase | null} */
  let db = null;
  try {
    const read = (async () => {
      db = await openMetadataDb(idbFactory);
      if (!db) return null;
      if (db.objectStoreNames && !db.objectStoreNames.contains(CHAT_METADATA_STORE_META)) return null;
      const tx = db.transaction(CHAT_METADATA_STORE_META, 'readonly');
      const row = await requestResult(tx.objectStore(CHAT_METADATA_STORE_META).get(CHAT_LOCAL_BOOT_CACHE_KEY));
      if (!row || typeof row !== 'object') return null;
      const raw = typeof row.value === 'string' ? row.value : '';
      return parseChatLocalBootCache(raw);
    })();
    return await withTimeout(read, timeoutMs);
  } catch (_) {
    return null;
  } finally {
    try {
      db?.close?.();
    } catch (_) {}
  }
}

/**
 * Whether this client has local chat data to hydrate from — the synchronous
 * localStorage snapshot, or the durable IndexedDB snapshot.
 *
 * @param {{ storage?: Storage | null, idbFactory?: IDBFactory | null, timeoutMs?: number }} [options]
 * @returns {Promise<boolean>}
 */
export async function hasLocalBootCacheForOfflineBoot(options = {}) {
  const storage = options.storage === undefined
    ? (typeof localStorage !== 'undefined' ? localStorage : null)
    : options.storage;
  if (hasLocalChatBootCacheForColdStart(storage)) return true;
  const doc = await readLocalBootCacheDocFromIdb(options);
  return !!(doc && Array.isArray(doc.chats) && doc.chats.length > 0);
}

/**
 * Make sure the synchronous localStorage bootstrap exists for an offline boot.
 * Writes the durable IDB snapshot back into the sync document when needed.
 *
 * The write goes through `writeChatLocalBootSync` without the full-document
 * signature: `writeChatLocalBootSyncFromFullDoc` embeds that (tens of KB) signature
 * into the 64 KB sync document, which used to reject the write entirely.
 *
 * @param {{
 *   storage?: Storage | null,
 *   idbFactory?: IDBFactory | null,
 *   timeoutMs?: number,
 *   preferChatId?: string,
 * }} [options]
 * @returns {Promise<boolean>} whether a non-empty sync snapshot is available afterwards
 */
export async function seedLocalBootSyncFromIdbBootCache(options = {}) {
  const storage = options.storage === undefined
    ? (typeof localStorage !== 'undefined' ? localStorage : null)
    : options.storage;
  const preferChatId = typeof options.preferChatId === 'string' ? options.preferChatId.trim() : '';
  if (hasLocalChatBootCacheForColdStart(storage)) return true;
  if (!storage || typeof storage.setItem !== 'function') return false;
  const doc = await readLocalBootCacheDocFromIdb(options);
  if (!doc || !Array.isArray(doc.chats) || doc.chats.length === 0) return false;
  const input = {
    savedAt: doc.savedAt,
    activeChatId: doc.activeChatId,
    preferChatId,
    workspaceContext: doc.workspaceContext,
    workspaces: doc.workspaces,
    chats: doc.chats,
  };
  // buildChatLocalBootSyncDoc first is only a guard that the snapshot is writable.
  if (!buildChatLocalBootSyncDoc(input)) return false;
  writeChatLocalBootSync(storage, input);
  return hasLocalChatBootCacheForColdStart(storage);
}
