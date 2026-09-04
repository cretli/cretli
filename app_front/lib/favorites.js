import {
  readStorageValueWithAlias,
  toCurrentStorageKey,
  toLegacyStorageKey,
  writeStorageValueWithAlias,
} from './storageKeyAlias.js';

const IDB_NAME = 'cretli-preferences';
const IDB_STORE = 'kv';
const IDB_VERSION = 1;

/** @type {Promise<IDBDatabase | null> | null} */
let favoritesDbOpening = null;

function openFavoritesDbOnce() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (favoritesDbOpening) return favoritesDbOpening;
  favoritesDbOpening = new Promise((resolve) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onerror = () => {
      favoritesDbOpening = null;
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
  return favoritesDbOpening;
}

async function readFavoritesFromIdb(storageKey) {
  const db = await openFavoritesDbOnce();
  if (!db) return null;
  const currentStorageKey = toCurrentStorageKey(storageKey);
  const legacyStorageKey = toLegacyStorageKey(currentStorageKey);
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const store = tx.objectStore(IDB_STORE);
      const req = store.get(currentStorageKey);
      req.onsuccess = () => {
        if (Array.isArray(req.result)) {
          resolve(req.result);
          return;
        }
        if (legacyStorageKey === currentStorageKey) {
          resolve(null);
          return;
        }
        const legacyReq = store.get(legacyStorageKey);
        legacyReq.onsuccess = () => {
          if (Array.isArray(legacyReq.result)) {
            resolve(legacyReq.result);
            return;
          }
          resolve(null);
        };
        legacyReq.onerror = () => resolve(null);
      };
      req.onerror = () => resolve(null);
    } catch (_) {
      resolve(null);
    }
  });
}

async function writeFavoritesToIdb(storageKey, values) {
  const db = await openFavoritesDbOnce();
  if (!db) return;
  const currentStorageKey = toCurrentStorageKey(storageKey);
  const legacyStorageKey = toLegacyStorageKey(currentStorageKey);
  await new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      store.put(values, currentStorageKey);
      if (legacyStorageKey !== currentStorageKey) {
        store.put(values, legacyStorageKey);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch (_) {
      resolve();
    }
  });
}

export function createFavoritesStore(storageKey) {
  const storageKeyCurrent = toCurrentStorageKey(storageKey);
  let memorySet = null;
  let memoryVersion = 0;
  let idbHydrationStarted = false;

  function ensureLoaded() {
    if (memorySet) return;
    memorySet = new Set();
    if (typeof localStorage === 'undefined') return;
    try {
      const raw = readStorageValueWithAlias(localStorage, storageKeyCurrent, '');
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      memorySet = new Set(parsed.filter((x) => typeof x === 'string' && x.trim()));
    } catch (_) {
      // ignore — an empty in-memory set is a fine fallback
    }
    if (idbHydrationStarted) return;
    idbHydrationStarted = true;
    const versionAtStart = memoryVersion;
    void readFavoritesFromIdb(storageKeyCurrent).then((arr) => {
      if (!Array.isArray(arr)) return;
      if (versionAtStart !== memoryVersion) return;
      const hydrated = new Set(arr.filter((x) => typeof x === 'string' && x.trim()));
      memorySet = hydrated;
      try {
        if (typeof localStorage !== 'undefined') {
          writeStorageValueWithAlias(
            localStorage,
            storageKeyCurrent,
            JSON.stringify(Array.from(hydrated))
          );
        }
      } catch (_) {}
    });
  }

  function getSetSnapshot() {
    ensureLoaded();
    return new Set(memorySet || []);
  }

  function commitSet(set) {
    memorySet = new Set(set);
    memoryVersion += 1;
    void writeFavoritesToIdb(storageKeyCurrent, Array.from(memorySet));
    if (typeof localStorage === 'undefined') return;
    try {
      writeStorageValueWithAlias(localStorage, storageKeyCurrent, JSON.stringify(Array.from(set)));
    } catch (_) {}
  }

  function isFavorite(value) {
    if (!value || typeof value !== 'string') return false;
    const set = getSetSnapshot();
    return set.has(value);
  }

  function toggleFavorite(value) {
    if (!value || typeof value !== 'string') return false;
    const set = getSetSnapshot();
    if (set.has(value)) {
      set.delete(value);
      commitSet(set);
      return false;
    }
    set.add(value);
    commitSet(set);
    return true;
  }

  return {
    isFavorite,
    toggleFavorite,
  };
}
