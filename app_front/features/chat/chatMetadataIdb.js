/**
 * Chat metadata IndexedDB — schema, session epoch, quota / upgrade handling (task 5.1).
 *
 * DOM-free helpers are in chatMetadataIdbSchema.js. SDK history uses `cretli-sdk-chat`
 * and is never cleared from this module.
 */

import {
  CHAT_METADATA_IDB_NAME,
  CHAT_METADATA_IDB_VERSION,
  CHAT_METADATA_INDEX_ARCHIVED,
  CHAT_METADATA_INDEX_RANKING,
  CHAT_METADATA_INDEX_WORKSPACE,
  CHAT_METADATA_STORE_CHATS,
  CHAT_METADATA_STORE_META,
  buildChatMetadataRecord,
  isChatMetadataRecord,
  selectChatMetadataRetentionDeletes,
} from './chatMetadataIdbSchema.js';

/** @typedef {{ sessionId: string, generation: number }} ChatMetadataSessionScope */

/** @typedef {'ok' | 'unavailable' | 'quota' | 'versionchange' | 'blocked' | 'aborted' | 'stale-session'} ChatMetadataIdbStatus */

let dbPromise = /** @type {Promise<IDBDatabase | null> | null} */ (null);
/** @type {ChatMetadataIdbStatus} */
let lastStatus = 'ok';
/** Monotonic epoch bumped on auth boundary — stale async work must not commit. */
let operationEpoch = 0;
/** @type {ChatMetadataSessionScope | null} */
let activeScope = null;

/**
 * @returns {() => IDBFactory | null}
 */
function resolveIdbFactory(getter) {
  if (typeof getter === 'function') return getter;
  return () => (typeof indexedDB !== 'undefined' ? indexedDB : null);
}

/**
 * @param {ChatMetadataIdbStatus} status
 */
function setStatus(status) {
  lastStatus = status;
}

/**
 * @returns {ChatMetadataIdbStatus}
 */
export function getChatMetadataIdbStatus() {
  return lastStatus;
}

/**
 * @returns {number}
 */
export function getChatMetadataIdbOperationEpoch() {
  return operationEpoch;
}

/**
 * @param {ChatMetadataSessionScope | null} scope
 */
export function setChatMetadataIdbSessionScope(scope) {
  if (!scope || !scope.sessionId) {
    activeScope = null;
    return;
  }
  activeScope = {
    sessionId: String(scope.sessionId),
    generation: Number.isFinite(Number(scope.generation)) ? Math.floor(Number(scope.generation)) : 1,
  };
}

/**
 * @param {ChatMetadataSessionScope} scope
 * @returns {boolean}
 */
export function isChatMetadataSessionScopeCurrent(scope) {
  if (!activeScope || !scope) return false;
  return scope.sessionId === activeScope.sessionId && scope.generation === activeScope.generation;
}

/**
 * @param {number} epoch
 * @param {ChatMetadataSessionScope | null} [scope]
 * @returns {boolean}
 */
function isOperationStillValid(epoch, scope = null) {
  if (epoch !== operationEpoch) {
    setStatus('stale-session');
    return false;
  }
  if (scope && !isChatMetadataSessionScopeCurrent(scope)) {
    setStatus('stale-session');
    return false;
  }
  return true;
}

/**
 * @param {DOMException | Error | null | undefined} err
 * @returns {ChatMetadataIdbStatus}
 */
function statusFromTransactionError(err) {
  if (!err) return 'aborted';
  if (err.name === 'QuotaExceededError') return 'quota';
  if (err.name === 'AbortError') return 'aborted';
  return 'unavailable';
}

/**
 * @param {IDBTransaction} tx
 * @param {() => void} finish
 * @returns {(status: ChatMetadataIdbStatus) => void}
 */
function attachTransactionFailureHandlers(tx, finish) {
  /** @type {ChatMetadataIdbStatus | null} */
  let failureStatus = null;
  const markFailure = (status) => {
    if (failureStatus) return;
    failureStatus = status;
    setStatus(status);
  };
  tx.onabort = () => {
    if (!failureStatus) markFailure(statusFromTransactionError(tx.error));
    finish();
  };
  tx.onerror = () => {
    const err = tx.error;
    if (err) markFailure(statusFromTransactionError(err));
    if (failureStatus) finish();
  };
  return markFailure;
}

/**
 * Invalidate in-flight IDB work after logout / 401 / clear-local-data.
 *
 * @param {string} [_reason]
 * @returns {Promise<void>}
 */
export async function invalidateChatMetadataIdbSession(_reason = '') {
  operationEpoch += 1;
  activeScope = null;
  const db = await dbPromise;
  dbPromise = null;
  if (db) {
    try {
      db.close();
    } catch (_) {
      /* ignore */
    }
  }
}

/**
 * @param {IDBFactory | null} factory
 * @returns {Promise<IDBDatabase | null>}
 */
function openDatabase(factory, version = CHAT_METADATA_IDB_VERSION, hooks = {}) {
  if (!factory) {
    setStatus('unavailable');
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    let settled = false;
    let blockedDuringOpen = false;
    /** @param {IDBDatabase | null} db */
    const finish = (db) => {
      if (settled) return;
      settled = true;
      resolve(db);
    };
    try {
      const req = factory.open(CHAT_METADATA_IDB_NAME, version);
      req.onerror = () => {
        setStatus('unavailable');
        finish(null);
      };
      req.onblocked = () => {
        blockedDuringOpen = true;
        setStatus('blocked');
        dbPromise = null;
        if (typeof hooks.onBlocked === 'function') hooks.onBlocked();
        finish(null);
      };
      req.onupgradeneeded = (event) => {
        const db = req.result;
        if (!db.objectStoreNames.contains(CHAT_METADATA_STORE_META)) {
          db.createObjectStore(CHAT_METADATA_STORE_META, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(CHAT_METADATA_STORE_CHATS)) {
          const store = db.createObjectStore(CHAT_METADATA_STORE_CHATS, { keyPath: 'id' });
          store.createIndex(CHAT_METADATA_INDEX_WORKSPACE, 'workspaceKey', { unique: false });
          store.createIndex(CHAT_METADATA_INDEX_ARCHIVED, 'archivedFlag', { unique: false });
          store.createIndex(CHAT_METADATA_INDEX_RANKING, 'rankingUpdatedAtMs', { unique: false });
        }
        void event;
      };
      req.onsuccess = () => {
        if (blockedDuringOpen) {
          setStatus('blocked');
          try {
            req.result.close();
          } catch (_) {
            /* ignore */
          }
          return;
        }
        if (settled) return;
        const db = req.result;
        db.onversionchange = () => {
          setStatus('versionchange');
          try {
            db.close();
          } catch (_) {
            /* ignore */
          }
          dbPromise = null;
        };
        if (lastStatus !== 'versionchange' && lastStatus !== 'blocked') {
          setStatus('ok');
        }
        finish(db);
      };
    } catch (_) {
      setStatus('unavailable');
      finish(null);
    }
  });
}

/**
 * @param {{ idb?: () => (IDBFactory | null) }} [options]
 * @returns {Promise<IDBDatabase | null>}
 */
export async function getChatMetadataDb(options = {}) {
  const getFactory = resolveIdbFactory(options.idb);
  if (!getFactory()) {
    setStatus('unavailable');
    return null;
  }
  if (!dbPromise) dbPromise = openDatabase(getFactory());
  return dbPromise;
}

/**
 * @param {IDBDatabase} db
 * @param {string} storeName
 * @param {IDBTransactionMode} mode
 * @param {number} epoch
 * @returns {IDBTransaction | null}
 */
function beginTransaction(db, storeName, mode, epoch) {
  if (epoch !== operationEpoch) {
    setStatus('stale-session');
    return null;
  }
  try {
    return db.transaction(storeName, mode);
  } catch (_) {
    setStatus('unavailable');
    return null;
  }
}

/**
 * @param {IDBDatabase} db
 * @param {number} epoch
 * @returns {Promise<boolean>}
 */
async function clearAllStores(db, epoch) {
  if (epoch !== operationEpoch) return false;
  return new Promise((resolve) => {
    let names = [];
    try {
      names = [CHAT_METADATA_STORE_META, CHAT_METADATA_STORE_CHATS].filter((name) =>
        db.objectStoreNames.contains(name)
      );
    } catch (_) {
      resolve(false);
      return;
    }
    if (names.length === 0) {
      resolve(true);
      return;
    }
    /** @type {IDBTransaction | null} */
    let tx = null;
    try {
      tx = epoch === operationEpoch ? db.transaction(names, 'readwrite') : null;
    } catch (_) {
      tx = null;
    }
    if (!tx) {
      setStatus(epoch !== operationEpoch ? 'stale-session' : 'unavailable');
      resolve(false);
      return;
    }
    attachTransactionFailureHandlers(tx, () => resolve(false));
    tx.oncomplete = () => resolve(true);
    for (const name of names) {
      try {
        tx.objectStore(name).clear();
      } catch (_) {
        /* ignore single store */
      }
    }
  });
}

/**
 * Wipe metadata DB contents on auth session boundary (does not delete SDK DB).
 *
 * @param {{ idb?: () => (IDBFactory | null) }} [options]
 * @returns {Promise<boolean>}
 */
export async function clearChatMetadataDbContents(options = {}) {
  const epoch = operationEpoch;
  const db = await getChatMetadataDb(options);
  if (!db) return false;
  return clearAllStores(db, epoch);
}

/**
 * @param {string} key
 * @param {string} value
 * @param {ChatMetadataSessionScope} scope
 * @param {{ idb?: () => (IDBFactory | null), now?: () => number }} [options]
 * @returns {Promise<boolean>}
 */
/**
 * @typedef {{ key: string, value: string }} ChatMetadataKvEntry
 */

/**
 * Write many meta rows in bounded transactions. Re-checks epoch before each batch
 * and on transaction completion — aborted/quota batches are not treated as success.
 *
 * @param {ChatMetadataKvEntry[]} entries
 * @param {ChatMetadataSessionScope} scope
 * @param {{ idb?: () => (IDBFactory | null), now?: () => number, maxBatchSize?: number }} [options]
 * @returns {Promise<{ ok: boolean, written: number, status: ChatMetadataIdbStatus }>}
 */
export async function putChatMetadataKvBatch(entries, scope, options = {}) {
  if (!isChatMetadataSessionScopeCurrent(scope)) {
    setStatus('stale-session');
    return { ok: false, written: 0, status: 'stale-session' };
  }
  const list = Array.isArray(entries) ? entries.filter((row) => row && row.key) : [];
  if (list.length === 0) return { ok: true, written: 0, status: 'ok' };
  const maxBatch = Number.isFinite(Number(options.maxBatchSize)) && Number(options.maxBatchSize) > 0
    ? Math.floor(Number(options.maxBatchSize))
    : 100;
  const db = await getChatMetadataDb(options);
  if (!db) return { ok: false, written: 0, status: getChatMetadataIdbStatus() };
  let written = 0;
  for (let offset = 0; offset < list.length; offset += maxBatch) {
    const epoch = operationEpoch;
    if (!isOperationStillValid(epoch, scope)) {
      return { ok: false, written, status: getChatMetadataIdbStatus() };
    }
    const slice = list.slice(offset, offset + maxBatch);
    const batchOk = await new Promise((resolve) => {
      const tx = beginTransaction(db, CHAT_METADATA_STORE_META, 'readwrite', epoch);
      if (!tx) {
        resolve(false);
        return;
      }
      let failed = false;
      const markFailure = attachTransactionFailureHandlers(tx, () => {
        failed = true;
        resolve(false);
      });
      tx.oncomplete = () => {
        if (!isOperationStillValid(epoch, scope)) {
          setStatus('stale-session');
          resolve(false);
          return;
        }
        if (failed) {
          resolve(false);
          return;
        }
        resolve(true);
      };
      const store = tx.objectStore(CHAT_METADATA_STORE_META);
      const savedAt = typeof options.now === 'function' ? options.now() : Date.now();
      try {
        for (const row of slice) {
          const textKey = typeof row.key === 'string' ? row.key.trim() : '';
          if (!textKey) continue;
          store.put({
            key: textKey,
            value: String(row.value),
            sessionId: scope.sessionId,
            generation: scope.generation,
            savedAt,
          });
        }
      } catch (err) {
        if (err && typeof err === 'object' && err.name === 'QuotaExceededError') markFailure('quota');
        else markFailure('unavailable');
        try {
          tx.abort();
        } catch (_) {
          /* ignore */
        }
        resolve(false);
      }
    });
    if (!batchOk) return { ok: false, written, status: getChatMetadataIdbStatus() };
    written += slice.length;
  }
  return { ok: true, written, status: 'ok' };
}

/**
 * @param {ChatMetadataSessionScope} scope
 * @param {{ idb?: () => (IDBFactory | null), keyPrefix?: string }} [options]
 * @returns {Promise<Array<{ key: string, value: string }>>}
 */
/**
 * Read one meta row by key before session scope is known (IDB prime / reload bootstrap).
 *
 * @param {string} key
 * @param {{ idb?: () => (IDBFactory | null) }} [options]
 * @returns {Promise<{ key: string, value: string, sessionId: string, generation: number } | null>}
 */
export async function peekChatMetadataMetaKv(key, options = {}) {
  const epoch = operationEpoch;
  const db = await getChatMetadataDb(options);
  if (!db) return null;
  const textKey = typeof key === 'string' ? key.trim() : '';
  if (!textKey) return null;
  return new Promise((resolve) => {
    const tx = beginTransaction(db, CHAT_METADATA_STORE_META, 'readonly', epoch);
    if (!tx) {
      resolve(null);
      return;
    }
    attachTransactionFailureHandlers(tx, () => resolve(null));
    const req = tx.objectStore(CHAT_METADATA_STORE_META).get(textKey);
    req.onsuccess = () => {
      if (!isOperationStillValid(epoch, null)) {
        resolve(null);
        return;
      }
      const row = req.result;
      if (!row || typeof row !== 'object' || typeof row.key !== 'string') {
        resolve(null);
        return;
      }
      resolve({
        key: row.key,
        value: typeof row.value === 'string' ? row.value : String(row.value ?? ''),
        sessionId: typeof row.sessionId === 'string' ? row.sessionId : '',
        generation: Number.isFinite(Number(row.generation)) ? Math.floor(Number(row.generation)) : 1,
      });
    };
    req.onerror = () => resolve(null);
  });
}

export async function listChatMetadataMetaKv(scope, options = {}) {
  const epoch = operationEpoch;
  if (!isChatMetadataSessionScopeCurrent(scope)) return [];
  const db = await getChatMetadataDb(options);
  if (!db) return [];
  const prefix = typeof options.keyPrefix === 'string' ? options.keyPrefix : '';
  return new Promise((resolve) => {
    const tx = beginTransaction(db, CHAT_METADATA_STORE_META, 'readonly', epoch);
    if (!tx) {
      resolve([]);
      return;
    }
    /** @type {Array<{ key: string, value: string }>} */
    const out = [];
    attachTransactionFailureHandlers(tx, () => resolve([]));
    const req = tx.objectStore(CHAT_METADATA_STORE_META).openCursor();
    req.onsuccess = () => {
      if (!isOperationStillValid(epoch, scope)) {
        resolve([]);
        return;
      }
      const cursor = req.result;
      if (!cursor) {
        resolve(out);
        return;
      }
      const row = cursor.value;
      if (row && typeof row === 'object' && typeof row.key === 'string') {
        if (row.sessionId && row.sessionId !== scope.sessionId) {
          cursor.continue();
          return;
        }
        if (Number.isFinite(Number(row.generation)) && Number(row.generation) < scope.generation) {
          cursor.continue();
          return;
        }
        if (!prefix || row.key.startsWith(prefix)) {
          out.push({
            key: row.key,
            value: typeof row.value === 'string' ? row.value : String(row.value ?? ''),
          });
        }
      }
      cursor.continue();
    };
    req.onerror = () => resolve(out);
  });
}

export async function putChatMetadataKv(key, value, scope, options = {}) {
  const epoch = operationEpoch;
  if (!isChatMetadataSessionScopeCurrent(scope)) {
    setStatus('stale-session');
    return false;
  }
  const db = await getChatMetadataDb(options);
  if (!db) return false;
  const textKey = typeof key === 'string' ? key.trim() : '';
  if (!textKey) return false;
  return new Promise((resolve) => {
    const tx = beginTransaction(db, CHAT_METADATA_STORE_META, 'readwrite', epoch);
    if (!tx) {
      resolve(false);
      return;
    }
    const markFailure = attachTransactionFailureHandlers(tx, () => resolve(false));
    tx.oncomplete = () => {
      if (!isOperationStillValid(epoch, scope)) {
        resolve(false);
        return;
      }
      resolve(true);
    };
    try {
      tx.objectStore(CHAT_METADATA_STORE_META).put({
        key: textKey,
        value: String(value),
        sessionId: scope.sessionId,
        generation: scope.generation,
        savedAt: typeof options.now === 'function' ? options.now() : Date.now(),
      });
    } catch (err) {
      if (err && typeof err === 'object' && err.name === 'QuotaExceededError') markFailure('quota');
      else markFailure('unavailable');
      try {
        tx.abort();
      } catch (_) {
        /* ignore */
      }
      resolve(false);
    }
  });
}

/**
 * @param {string} key
 * @param {ChatMetadataSessionScope} scope
 * @param {{ idb?: () => (IDBFactory | null) }} [options]
 * @returns {Promise<string | null>}
 */
export async function getChatMetadataKv(key, scope, options = {}) {
  const epoch = operationEpoch;
  if (!isChatMetadataSessionScopeCurrent(scope)) {
    setStatus('stale-session');
    return null;
  }
  const db = await getChatMetadataDb(options);
  if (!db) return null;
  const textKey = typeof key === 'string' ? key.trim() : '';
  if (!textKey) return null;
  return new Promise((resolve) => {
    const tx = beginTransaction(db, CHAT_METADATA_STORE_META, 'readonly', epoch);
    if (!tx) {
      resolve(null);
      return;
    }
    attachTransactionFailureHandlers(tx, () => resolve(null));
    const req = tx.objectStore(CHAT_METADATA_STORE_META).get(textKey);
    req.onsuccess = () => {
      if (!isOperationStillValid(epoch, scope)) {
        resolve(null);
        return;
      }
      const row = req.result;
      if (!row || typeof row !== 'object') {
        resolve(null);
        return;
      }
      if (row.sessionId && row.sessionId !== scope.sessionId) {
        resolve(null);
        return;
      }
      if (Number.isFinite(Number(row.generation)) && Number(row.generation) < scope.generation) {
        resolve(null);
        return;
      }
      if (!isOperationStillValid(epoch, scope)) {
        resolve(null);
        return;
      }
      resolve(typeof row.value === 'string' ? row.value : null);
    };
    req.onerror = () => resolve(null);
  });
}

/**
 * Read many meta rows in one readonly transaction (cross-tab timestamp merge).
 *
 * @param {string[]} keys
 * @param {ChatMetadataSessionScope} scope
 * @param {{ idb?: () => (IDBFactory | null) }} [options]
 * @returns {Promise<Record<string, string> | null>} null when scope/epoch is stale
 */
export async function getChatMetadataKvBatch(keys, scope, options = {}) {
  const epoch = operationEpoch;
  if (!isChatMetadataSessionScopeCurrent(scope)) {
    setStatus('stale-session');
    return null;
  }
  const db = await getChatMetadataDb(options);
  if (!db) return null;
  const textKeys = Array.isArray(keys)
    ? keys.map((key) => (typeof key === 'string' ? key.trim() : '')).filter(Boolean)
    : [];
  if (textKeys.length === 0) return {};
  return new Promise((resolve) => {
    const tx = beginTransaction(db, CHAT_METADATA_STORE_META, 'readonly', epoch);
    if (!tx) {
      resolve(null);
      return;
    }
    /** @type {Record<string, string>} */
    const out = Object.create(null);
    let pending = textKeys.length;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (!isOperationStillValid(epoch, scope)) {
        resolve(null);
        return;
      }
      resolve(out);
    };
    attachTransactionFailureHandlers(tx, () => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    });
    const store = tx.objectStore(CHAT_METADATA_STORE_META);
    for (const textKey of textKeys) {
      const req = store.get(textKey);
      req.onsuccess = () => {
        if (!isOperationStillValid(epoch, scope)) {
          finish();
          return;
        }
        const row = req.result;
        if (row && typeof row === 'object') {
          if (row.sessionId && row.sessionId !== scope.sessionId) {
            pending -= 1;
            if (pending === 0) finish();
            return;
          }
          if (Number.isFinite(Number(row.generation)) && Number(row.generation) < scope.generation) {
            pending -= 1;
            if (pending === 0) finish();
            return;
          }
          if (typeof row.value === 'string') out[textKey] = row.value;
        }
        pending -= 1;
        if (pending === 0) finish();
      };
      req.onerror = () => {
        pending -= 1;
        if (pending === 0) finish();
      };
    }
  });
}

/**
 * @param {unknown} chat
 * @param {ChatMetadataSessionScope} scope
 * @param {{ idb?: () => (IDBFactory | null), now?: () => number }} [options]
 * @returns {Promise<boolean>}
 */
export async function putChatMetadataChatRecord(chat, scope, options = {}) {
  const epoch = operationEpoch;
  if (!isChatMetadataSessionScopeCurrent(scope)) {
    setStatus('stale-session');
    return false;
  }
  const record = buildChatMetadataRecord(chat, {
    sessionId: scope.sessionId,
    generation: scope.generation,
    savedAt: typeof options.now === 'function' ? options.now() : Date.now(),
  });
  if (!isChatMetadataRecord(record)) return false;
  const db = await getChatMetadataDb(options);
  if (!db) return false;
  const written = await new Promise((resolve) => {
    const tx = beginTransaction(db, CHAT_METADATA_STORE_CHATS, 'readwrite', epoch);
    if (!tx) {
      resolve(false);
      return;
    }
    const markFailure = attachTransactionFailureHandlers(tx, () => resolve(false));
    tx.oncomplete = () => resolve(true);
    try {
      tx.objectStore(CHAT_METADATA_STORE_CHATS).put(record);
    } catch (err) {
      if (err && typeof err === 'object' && err.name === 'QuotaExceededError') markFailure('quota');
      else markFailure('unavailable');
      try {
        tx.abort();
      } catch (_) {
        /* ignore */
      }
      resolve(false);
    }
  });
  if (!written) return false;
  await enforceChatMetadataRetention(scope, options);
  return true;
}

/**
 * @param {ChatMetadataSessionScope} scope
 * @param {{ idb?: () => (IDBFactory | null) }} [options]
 * @returns {Promise<boolean>}
 */
export async function enforceChatMetadataRetention(scope, options = {}) {
  const epoch = operationEpoch;
  if (!isChatMetadataSessionScopeCurrent(scope)) return false;
  const db = await getChatMetadataDb(options);
  if (!db) return false;
  const rows = await listChatMetadataChatRecords(scope, options);
  const deleteIds = selectChatMetadataRetentionDeletes(rows);
  if (deleteIds.length === 0) return true;
  return new Promise((resolve) => {
    const tx = beginTransaction(db, CHAT_METADATA_STORE_CHATS, 'readwrite', epoch);
    if (!tx) {
      resolve(false);
      return;
    }
    attachTransactionFailureHandlers(tx, () => resolve(false));
    tx.oncomplete = () => resolve(true);
    const store = tx.objectStore(CHAT_METADATA_STORE_CHATS);
    for (const id of deleteIds) {
      try {
        store.delete(id);
      } catch (_) {
        /* ignore */
      }
    }
  });
}

/**
 * @param {ChatMetadataSessionScope} scope
 * @param {{ idb?: () => (IDBFactory | null), workspaceKey?: string, archivedOnly?: boolean }} [options]
 * @returns {Promise<object[]>}
 */
export async function listChatMetadataChatRecords(scope, options = {}) {
  const epoch = operationEpoch;
  if (!isChatMetadataSessionScopeCurrent(scope)) return [];
  const db = await getChatMetadataDb(options);
  if (!db) return [];
  const workspaceKey = typeof options.workspaceKey === 'string' ? options.workspaceKey : '';
  const archivedOnly = options.archivedOnly === true;
  return new Promise((resolve) => {
    const tx = beginTransaction(db, CHAT_METADATA_STORE_CHATS, 'readonly', epoch);
    if (!tx) {
      resolve([]);
      return;
    }
    /** @type {object[]} */
    const out = [];
    attachTransactionFailureHandlers(tx, () => resolve([]));
    const store = tx.objectStore(CHAT_METADATA_STORE_CHATS);
    let source = store.openCursor();
    if (workspaceKey && store.indexNames.contains(CHAT_METADATA_INDEX_WORKSPACE)) {
      source = store.index(CHAT_METADATA_INDEX_WORKSPACE).openCursor(IDBKeyRange.only(workspaceKey));
    } else if (archivedOnly && store.indexNames.contains(CHAT_METADATA_INDEX_ARCHIVED)) {
      source = store.index(CHAT_METADATA_INDEX_ARCHIVED).openCursor(IDBKeyRange.only(1));
    }
    source.onsuccess = () => {
      if (!isOperationStillValid(epoch, scope)) {
        resolve([]);
        return;
      }
      const cursor = source.result;
      if (!cursor) {
        if (!isOperationStillValid(epoch, scope)) {
          resolve([]);
          return;
        }
        resolve(out);
        return;
      }
      const value = cursor.value;
      if (value && typeof value === 'object') {
        if (value.sessionId && value.sessionId !== scope.sessionId) {
          cursor.continue();
          return;
        }
        if (archivedOnly && value.archivedFlag !== 1) {
          cursor.continue();
          return;
        }
        out.push(value);
      }
      cursor.continue();
    };
    source.onerror = () => resolve(out);
  });
}

/**
 * Test seam: open metadata DB at an explicit version (does not reuse cached dbPromise).
 *
 * @param {{ idb?: () => (IDBFactory | null) }} [options]
 * @param {number} [version]
 * @returns {Promise<IDBDatabase | null>}
 */
export async function __testOpenChatMetadataDatabase(options = {}, version = CHAT_METADATA_IDB_VERSION) {
  const getFactory = resolveIdbFactory(options.idb);
  const factory = getFactory();
  if (!factory) {
    setStatus('unavailable');
    return null;
  }
  const onBlocked = typeof options.onBlocked === 'function' ? options.onBlocked : undefined;
  return openDatabase(factory, version, { onBlocked });
}

/**
 * Test seam: abort a metadata write transaction and return module status.
 *
 * @param {{ idb?: () => (IDBFactory | null) }} [options]
 * @returns {Promise<ChatMetadataIdbStatus>}
 */
export async function __testAbortMetadataWriteTransaction(options = {}) {
  const epoch = operationEpoch;
  const db = await getChatMetadataDb(options);
  if (!db) return getChatMetadataIdbStatus();
  return new Promise((resolve) => {
    const tx = beginTransaction(db, CHAT_METADATA_STORE_META, 'readwrite', epoch);
    if (!tx) {
      resolve(getChatMetadataIdbStatus());
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(getChatMetadataIdbStatus());
    };
    attachTransactionFailureHandlers(tx, finish);
    try {
      tx.objectStore(CHAT_METADATA_STORE_META).put({
        key: '__abort_probe__',
        value: 'x',
        sessionId: 'probe',
        generation: 1,
        savedAt: 0,
      });
    } catch (_) {
      finish();
      return;
    }
    try {
      tx.abort();
    } catch (_) {
      finish();
    }
  });
}

/**
 * Test seam: fire only `onabort` with `tx.error` set (browser quota-at-commit path).
 *
 * @param {{ name: string }} error
 * @returns {ChatMetadataIdbStatus}
 */
export function __testTransactionFailureOnAbortOnlyForTest(error) {
  /** @type {IDBTransaction} */
  const tx = {
    error,
    onabort: null,
    onerror: null,
  };
  attachTransactionFailureHandlers(tx, () => {});
  if (typeof tx.onabort === 'function') tx.onabort();
  return getChatMetadataIdbStatus();
}

/** Test seam: reset module singleton state. */
export function __resetChatMetadataIdbForTest() {
  dbPromise = null;
  lastStatus = 'ok';
  operationEpoch = 0;
  activeScope = null;
}
