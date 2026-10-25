import {
  readStorageValueWithAlias,
  removeStorageValueWithAlias,
  toCurrentStorageKey,
  toLegacyStorageKey,
  writeStorageValueWithAlias,
} from './storageKeyAlias.js';

const IDB_NAME = 'cretli-chat-buffers';
const IDB_STORE = 'buffers';
const IDB_VERSION = 1;
const LEGACY_MIRROR_MAX_CHARS = 120_000;

/** @type {Promise<IDBDatabase | null> | null} */
let dbOpening = null;
/** @type {Map<string, string>} */
const memoryByChatId = new Map();
/** @type {Set<string>} */
const hydratedChatIds = new Set();

function getIndexedDbFactory() {
  if (typeof indexedDB === 'undefined') return null;
  return indexedDB;
}

function openDbOnce() {
  const factory = getIndexedDbFactory();
  if (!factory) return Promise.resolve(null);
  if (dbOpening) return dbOpening;
  dbOpening = new Promise((resolve) => {
    const req = factory.open(IDB_NAME, IDB_VERSION);
    req.onerror = () => {
      dbOpening = null;
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
  return dbOpening;
}

function mirrorKey(prefix, chatId) {
  return `${prefix}${chatId}`;
}

function resolveCurrentMirrorPrefix(prefix) {
  const probeKey = `${prefix}probe`;
  const normalizedProbe = toCurrentStorageKey(probeKey);
  return normalizedProbe.slice(0, normalizedProbe.length - 'probe'.length);
}

function trimMirrorValue(value) {
  const text = typeof value === 'string' ? value : '';
  if (text.length <= LEGACY_MIRROR_MAX_CHARS) return text;
  return text.slice(-LEGACY_MIRROR_MAX_CHARS);
}

function readLegacyMirror(prefix, chatId) {
  if (!chatId || typeof localStorage === 'undefined') return '';
  try {
    return readStorageValueWithAlias(localStorage, mirrorKey(prefix, chatId), '');
  } catch (_) {
    return '';
  }
}

function writeLegacyMirror(prefix, chatId, value) {
  if (!chatId || typeof localStorage === 'undefined') return;
  const currentPrefix = resolveCurrentMirrorPrefix(prefix);
  const currentKey = mirrorKey(currentPrefix, chatId);
  const trimmed = trimMirrorValue(value);
  try {
    if (!trimmed) {
      removeStorageValueWithAlias(localStorage, currentKey);
      return;
    }
    writeStorageValueWithAlias(localStorage, currentKey, trimmed);
  } catch (_) {}
}

function removeLegacyMirror(prefix, chatId) {
  if (!chatId || typeof localStorage === 'undefined') return;
  const currentKey = mirrorKey(resolveCurrentMirrorPrefix(prefix), chatId);
  try {
    removeStorageValueWithAlias(localStorage, currentKey);
  } catch (_) {}
}

async function readFromIdb(chatId) {
  if (!chatId) return '';
  const db = await openDbOnce();
  if (!db) return '';
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(chatId);
      req.onsuccess = () => {
        const value = req.result;
        resolve(typeof value === 'string' ? value : '');
      };
      req.onerror = () => resolve('');
    } catch (_) {
      resolve('');
    }
  });
}

async function writeToIdb(chatId, value) {
  if (!chatId) return;
  const db = await openDbOnce();
  if (!db) return;
  await new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      if (value) tx.objectStore(IDB_STORE).put(value, chatId);
      else tx.objectStore(IDB_STORE).delete(chatId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch (_) {
      resolve();
    }
  });
}

/**
 * Buffers live in IndexedDB; the localStorage copy only exists to carry data over from
 * older builds (and as the no-IDB fallback), so drop the key once IDB has the value.
 *
 * @param {string} chatId
 * @param {string} value
 * @param {string} legacyPrefix
 * @returns {Promise<boolean>} false when the localStorage copy has to stay
 */
async function moveLegacyMirrorToIdb(chatId, value, legacyPrefix) {
  if (!getIndexedDbFactory()) return false;
  const existing = await readFromIdb(chatId);
  if (existing.length < value.length) await writeToIdb(chatId, value);
  const after = await readFromIdb(chatId);
  if (!after) return false;
  removeLegacyMirror(legacyPrefix, chatId);
  return true;
}

/**
 * @param {string} legacyPrefix
 * @param {string[]} keepChatIds
 * @returns {Promise<{ removedKeys: number, freedChars: number }>}
 */
export async function migrateChatBuffersOutOfLocalStorage(legacyPrefix, keepChatIds) {
  const summary = { removedKeys: 0, freedChars: 0 };
  if (typeof localStorage === 'undefined') return summary;
  const keep = new Set(Array.isArray(keepChatIds) ? keepChatIds : []);
  if (keep.size === 0) return summary;
  if (!getIndexedDbFactory()) return summary;
  const currentPrefix = resolveCurrentMirrorPrefix(legacyPrefix);
  const prefixes = [currentPrefix, toLegacyStorageKey(currentPrefix)]
    .filter((prefix, index, all) => prefix && all.indexOf(prefix) === index);
  /** @type {string[]} */
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key) continue;
    if (!prefixes.some((prefix) => key.startsWith(prefix))) continue;
    keys.push(key);
  }
  for (const key of keys) {
    const prefix = prefixes.find((candidate) => key.startsWith(candidate)) || '';
    const chatId = key.slice(prefix.length);
    let raw = '';
    try {
      raw = localStorage.getItem(key) || '';
    } catch (_) {
      continue;
    }
    if (chatId && raw && keep.has(chatId) && !(await moveLegacyMirrorToIdb(chatId, raw, legacyPrefix))) continue;
    try {
      localStorage.removeItem(key);
    } catch (_) {
      continue;
    }
    summary.removedKeys += 1;
    summary.freedChars += key.length + raw.length;
  }
  return summary;
}

export function readChatBufferSync(chatId, legacyPrefix) {
  if (!chatId) return '';
  if (memoryByChatId.has(chatId)) {
    return memoryByChatId.get(chatId) || '';
  }
  const legacy = readLegacyMirror(legacyPrefix, chatId);
  memoryByChatId.set(chatId, legacy);
  if (legacy) {
    hydratedChatIds.add(chatId);
    void moveLegacyMirrorToIdb(chatId, legacy, legacyPrefix);
    return legacy;
  }
  if (!hydratedChatIds.has(chatId)) {
    void hydrateChatBuffer(chatId, legacyPrefix);
  }
  return '';
}

export async function hydrateChatBuffer(chatId, legacyPrefix) {
  if (!chatId) return '';
  if (hydratedChatIds.has(chatId)) {
    return memoryByChatId.get(chatId) || '';
  }
  const current = memoryByChatId.get(chatId) || '';
  const fromIdb = await readFromIdb(chatId);
  // The mirror is only a leftover from older builds or the no-IDB fallback copy.
  const resolved = fromIdb || current || readLegacyMirror(legacyPrefix, chatId);
  memoryByChatId.set(chatId, resolved);
  hydratedChatIds.add(chatId);
  return resolved;
}

export function persistChatBuffer(chatId, value, legacyPrefix) {
  if (!chatId) return;
  const normalized = typeof value === 'string' ? value : '';
  memoryByChatId.set(chatId, normalized);
  hydratedChatIds.add(chatId);
  if (!getIndexedDbFactory()) {
    writeLegacyMirror(legacyPrefix, chatId, normalized);
    return;
  }
  void writeToIdb(chatId, normalized);
}

export function clearChatBuffer(chatId, legacyPrefix) {
  if (!chatId) return;
  memoryByChatId.delete(chatId);
  hydratedChatIds.delete(chatId);
  removeLegacyMirror(legacyPrefix, chatId);
  void writeToIdb(chatId, '');
}
