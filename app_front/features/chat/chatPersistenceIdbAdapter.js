/**
 * IndexedDB persistence adapter for the shared chat metadata queue (task 5.2).
 *
 * Durable KV lives in `cretli-chat-metadata` / `meta`. Per-chat activity timestamps
 * use small entry keys so a single UI change does not rewrite whole timestamp maps.
 * Synchronous `read()` serves an in-memory cache only — no IDB in render/comparator paths.
 */

import {
  CHAT_ACTIVITY_STORAGE_KEY,
  CHAT_LAST_USED_STORAGE_KEY,
  CHAT_PERSISTENCE_CONTRACT_VERSION,
  CHAT_PERSISTENCE_SESSION_KEY,
  parseTimestampMapPayload,
  serializeTimestampMap,
} from './chatPersistenceAdapter.js';
import { CHAT_LOCAL_BOOT_CACHE_KEY } from './chatLocalBootCache.js';
import {
  getChatMetadataIdbOperationEpoch,
  getChatMetadataIdbStatus,
  getChatMetadataKv,
  listChatMetadataMetaKv,
  peekChatMetadataMetaKv,
  putChatMetadataKv,
  putChatMetadataKvBatch,
  setChatMetadataIdbSessionScope,
} from './chatMetadataIdb.js';

/** Prefix for one chat activity timestamp row in meta store. */
export const CHAT_IDB_ACTIVITY_TS_PREFIX = 'cretli-act-ts:';

/** Prefix for one chat last-used timestamp row in meta store. */
export const CHAT_IDB_LASTUSED_TS_PREFIX = 'cretli-lu-ts:';

/** Default batch size for IDB write transactions. */
export const CHAT_PERSISTENCE_IDB_BATCH_SIZE = 100;

/** Max retries for transient IDB failures during queue flush. */
export const CHAT_PERSISTENCE_IDB_MAX_RETRIES = 3;

/** Base backoff (ms) between flush retries. */
export const CHAT_PERSISTENCE_IDB_RETRY_BASE_MS = 25;

/**
 * @param {string} chatId
 * @returns {string}
 */
export function chatIdbActivityEntryKey(chatId) {
  return `${CHAT_IDB_ACTIVITY_TS_PREFIX}${String(chatId || '').trim()}`;
}

/**
 * @param {string} chatId
 * @returns {string}
 */
export function chatIdbLastUsedEntryKey(chatId) {
  return `${CHAT_IDB_LASTUSED_TS_PREFIX}${String(chatId || '').trim()}`;
}

/**
 * @param {string} entryKey
 * @returns {string}
 */
function chatIdFromEntryKey(entryKey, prefix) {
  if (typeof entryKey !== 'string' || !entryKey.startsWith(prefix)) return '';
  return entryKey.slice(prefix.length).trim();
}

/**
 * @param {Record<string, string>} cache
 * @param {string} prefix
 * @param {Record<string, number>} target
 */
function mergeEntryPrefixIntoMap(cache, prefix, target) {
  for (const [key, rawValue] of Object.entries(cache)) {
    if (!key.startsWith(prefix)) continue;
    const id = chatIdFromEntryKey(key, prefix);
    const ts = Number(rawValue);
    if (!id || !Number.isFinite(ts) || ts <= 0) continue;
    const prev = target[id] || 0;
    if (ts > prev) target[id] = ts;
  }
}

/**
 * @param {{
 *   getSession: () => { sessionId: string, generation: number },
 *   idb?: () => (IDBFactory | null),
 *   now?: () => number,
 * }} options
 */
export function createChatMetadataIdbPersistenceAdapter(options) {
  const getSession = options.getSession;
  const idb = typeof options.idb === 'function' ? options.idb : () => (typeof indexedDB !== 'undefined' ? indexedDB : null);
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  /** @type {Record<string, string>} */
  const cache = Object.create(null);
  /** @type {Promise<void> | null} */
  let primePromise = null;
  let cacheReady = false;
  let sessionMarkerDirty = false;

  /** @param {string} key @param {string | null} value */
  function setCache(key, value) {
    if (value == null) delete cache[key];
    else cache[key] = String(value);
  }

  /**
   * @param {string} key
   * @returns {string | null}
   */
  function read(key) {
    return Object.prototype.hasOwnProperty.call(cache, key) ? cache[key] : null;
  }

  /**
   * @param {string} key
   * @param {string} value
   * @returns {boolean}
   */
  function write(key, value) {
    setCache(key, String(value));
    if (key === CHAT_PERSISTENCE_SESSION_KEY) {
      sessionMarkerDirty = true;
    }
    return true;
  }

  /** @param {string} key */
  function remove(key) {
    delete cache[key];
  }

  function rebuildWrappedMapKeysFromEntries() {
    const session = getSession();
    /** @type {Record<string, number>} */
    const activity = {};
    /** @type {Record<string, number>} */
    const lastUsed = {};
    mergeEntryPrefixIntoMap(cache, CHAT_IDB_ACTIVITY_TS_PREFIX, activity);
    mergeEntryPrefixIntoMap(cache, CHAT_IDB_LASTUSED_TS_PREFIX, lastUsed);
    const meta = { sessionId: session.sessionId, generation: session.generation, updatedAt: now() };
    if (Object.keys(activity).length > 0) {
      setCache(CHAT_ACTIVITY_STORAGE_KEY, serializeTimestampMap(activity, meta));
    }
    if (Object.keys(lastUsed).length > 0) {
      setCache(CHAT_LAST_USED_STORAGE_KEY, serializeTimestampMap(lastUsed, meta));
    }
  }

  async function primeCacheFromIdb() {
    const markerPeek = await peekChatMetadataMetaKv(CHAT_PERSISTENCE_SESSION_KEY, { idb });
    if (markerPeek?.value) {
      setCache(CHAT_PERSISTENCE_SESSION_KEY, markerPeek.value);
    }
    const scope = getSession();
    if (!scope.sessionId) return;
    setChatMetadataIdbSessionScope(scope);
    const rows = await listChatMetadataMetaKv(scope, { idb });
    for (const row of rows) {
      if (!row.key) continue;
      if (row.key.startsWith(CHAT_IDB_ACTIVITY_TS_PREFIX) || row.key.startsWith(CHAT_IDB_LASTUSED_TS_PREFIX)) {
        setCache(row.key, row.value);
        continue;
      }
      if (
        row.key === CHAT_ACTIVITY_STORAGE_KEY
        || row.key === CHAT_LAST_USED_STORAGE_KEY
        || row.key === CHAT_LOCAL_BOOT_CACHE_KEY
        || row.key === CHAT_PERSISTENCE_SESSION_KEY
      ) {
        setCache(row.key, row.value);
      }
    }
    rebuildWrappedMapKeysFromEntries();
    cacheReady = true;
    if (sessionMarkerDirty) {
      await persistPendingSessionMarker({ epoch: getChatMetadataIdbOperationEpoch() });
    }
  }

  /**
   * @param {{ epoch: number, queueEpoch?: number }} guard
   * @returns {Promise<boolean>}
   */
  async function persistPendingSessionMarker(guard) {
    if (!sessionMarkerDirty) return true;
    const payload = read(CHAT_PERSISTENCE_SESSION_KEY);
    if (!payload) {
      sessionMarkerDirty = false;
      return true;
    }
    const ok = await persistKv(CHAT_PERSISTENCE_SESSION_KEY, payload, guard);
    if (ok) sessionMarkerDirty = false;
    return ok;
  }

  /**
   * @returns {Promise<void>}
   */
  function ensurePrime() {
    if (cacheReady) return Promise.resolve();
    if (!primePromise) {
      primePromise = primeCacheFromIdb()
        .catch(() => {})
        .finally(() => {
          if (!cacheReady) primePromise = null;
        });
    }
    return primePromise;
  }

  /**
   * Re-read one meta key from IDB into the in-memory cache (peer boot / cross-tab).
   *
   * @param {string} key
   * @returns {Promise<boolean>}
   */
  async function refreshMetaKeyFromIdb(key) {
    const textKey = typeof key === 'string' ? key.trim() : '';
    if (!textKey) return false;
    const scope = getSession();
    if (!scope.sessionId) return false;
    const epoch = getChatMetadataIdbOperationEpoch();
    const value = await getChatMetadataKv(textKey, scope, { idb });
    if (value == null) return false;
    if (epoch !== getChatMetadataIdbOperationEpoch()) return false;
    setCache(textKey, value);
    if (
      textKey.startsWith(CHAT_IDB_ACTIVITY_TS_PREFIX)
      || textKey.startsWith(CHAT_IDB_LASTUSED_TS_PREFIX)
    ) {
      rebuildWrappedMapKeysFromEntries();
    }
    return true;
  }

  /**
   * @param {number} epoch
   * @param {number} [queueEpoch]
   * @returns {boolean}
   */
  function isFlushEpochCurrent(idbEpoch) {
    return idbEpoch === getChatMetadataIdbOperationEpoch();
  }

  /**
   * @param {string} key
   * @param {string} value
   * @param {{ epoch: number, queueEpoch?: number }} guard
   * @returns {Promise<boolean>}
   */
  async function persistKv(key, value, guard) {
    const scope = getSession();
    if (!isFlushEpochCurrent(guard.epoch)) return false;
    if (!scope.sessionId) return false;
    const ok = await putChatMetadataKv(key, value, scope, { idb, now });
    if (!ok) return false;
    if (!isFlushEpochCurrent(guard.epoch)) return false;
    return getChatMetadataIdbStatus() === 'ok';
  }

  /**
   * @param {Array<{ key: string, value: string }>} entries
   * @param {{ epoch: number, queueEpoch?: number }} guard
   * @returns {Promise<boolean>}
   */
  async function persistEntryBatch(entries, guard) {
    const scope = getSession();
    if (!isFlushEpochCurrent(guard.epoch)) return false;
    if (!scope.sessionId || entries.length === 0) return true;
    let attempt = 0;
    while (attempt <= CHAT_PERSISTENCE_IDB_MAX_RETRIES) {
      if (!isFlushEpochCurrent(guard.epoch)) return false;
      const result = await putChatMetadataKvBatch(entries, scope, {
        idb,
        now,
        maxBatchSize: CHAT_PERSISTENCE_IDB_BATCH_SIZE,
      });
      if (result.ok && isFlushEpochCurrent(guard.epoch)) return true;
      const status = result.status || getChatMetadataIdbStatus();
      if (status === 'quota' || status === 'stale-session') return false;
      attempt += 1;
      if (attempt > CHAT_PERSISTENCE_IDB_MAX_RETRIES) return false;
      const delay = CHAT_PERSISTENCE_IDB_RETRY_BASE_MS * (2 ** (attempt - 1));
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    return false;
  }

  /**
   * @param {{
   *   activity: Record<string, number>,
   *   lastUsed: Record<string, number>,
   *   activityIds: string[],
   *   lastUsedIds: string[],
   *   epoch: number,
   *   queueEpoch?: number,
   * }} payload
   * @returns {Promise<{ ok: boolean, failedActivityIds: string[], failedLastUsedIds: string[] }>}
   */
  async function persistActivityDeltas(payload) {
    /** @type {Array<{ key: string, value: string }>} */
    const entries = [];
    /** @type {string[]} */
    const failedActivityIds = [];
    /** @type {string[]} */
    const failedLastUsedIds = [];
    for (const id of payload.activityIds) {
      const chatId = String(id || '').trim();
      const ts = payload.activity[chatId];
      if (!chatId || !Number.isFinite(Number(ts)) || Number(ts) <= 0) continue;
      entries.push({ key: chatIdbActivityEntryKey(chatId), value: String(ts) });
    }
    for (const id of payload.lastUsedIds) {
      const chatId = String(id || '').trim();
      const ts = payload.lastUsed[chatId];
      if (!chatId || !Number.isFinite(Number(ts)) || Number(ts) <= 0) continue;
      entries.push({ key: chatIdbLastUsedEntryKey(chatId), value: String(ts) });
    }
    if (entries.length === 0) return { ok: true, failedActivityIds, failedLastUsedIds };
    const ok = await persistEntryBatch(entries, { epoch: payload.epoch });
    if (ok) {
      for (const row of entries) setCache(row.key, row.value);
      rebuildWrappedMapKeysFromEntries();
      return { ok: true, failedActivityIds, failedLastUsedIds };
    }
    if (!isFlushEpochCurrent(payload.epoch)) {
      return { ok: false, failedActivityIds: payload.activityIds, failedLastUsedIds: payload.lastUsedIds };
    }
    return {
      ok: false,
      failedActivityIds: payload.activityIds,
      failedLastUsedIds: payload.lastUsedIds,
    };
  }

  return {
    contractVersion: CHAT_PERSISTENCE_CONTRACT_VERSION,
    kind: 'chat-metadata-idb',
    read,
    write,
    remove,
    ensurePrime,
    refreshMetaKeyFromIdb,
    isCacheReady: () => cacheReady,
    /** @param {string} key @param {string} value @param {{ epoch: number, queueEpoch?: number }} guard */
    persistKv,
    persistPendingSessionMarker,
    persistActivityDeltas,
    /** Test seam */
    _dumpCache: () => ({ ...cache }),
    /** Test seam: import wrapped map payloads into cache without IDB. */
    _importWrappedMapsForTest(rawActivity, rawLastUsed) {
      const activityPayload = parseTimestampMapPayload(rawActivity);
      const lastUsedPayload = parseTimestampMapPayload(rawLastUsed);
      if (activityPayload?.values) {
        for (const [id, ts] of Object.entries(activityPayload.values)) {
          setCache(chatIdbActivityEntryKey(id), String(ts));
        }
      }
      if (lastUsedPayload?.values) {
        for (const [id, ts] of Object.entries(lastUsedPayload.values)) {
          setCache(chatIdbLastUsedEntryKey(id), String(ts));
        }
      }
      rebuildWrappedMapKeysFromEntries();
      cacheReady = true;
    },
  };
}

/**
 * @param {unknown} adapter
 * @returns {adapter is ReturnType<typeof createChatMetadataIdbPersistenceAdapter>}
 */
export function isChatMetadataIdbPersistenceAdapter(adapter) {
  return Boolean(
    adapter
    && typeof adapter === 'object'
    && adapter.kind === 'chat-metadata-idb'
    && typeof adapter.persistActivityDeltas === 'function'
    && typeof adapter.persistKv === 'function'
  );
}
