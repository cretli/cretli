/**
 * Idempotent migration of the legacy full boot snapshot from localStorage to IDB (task 5.3).
 *
 * The legacy key `cretli-chat-boot-cache-v1` is removed only after a successful IDB commit.
 * Interrupted migrations keep the source so the next attempt can retry.
 */

import {
  readStorageValueWithAlias,
  removeStorageValueWithAlias,
} from '../../lib/storageKeyAlias.js';
import {
  CHAT_LOCAL_BOOT_CACHE_KEY,
  chatLocalBootCacheContentSignature,
  parseChatLocalBootCache,
  shouldReplaceChatLocalBootCacheDoc,
} from './chatLocalBootCache.js';
import { getChatMetadataIdbStatus } from './chatMetadataIdb.js';
import { isChatMetadataIdbPersistenceAdapter } from './chatPersistenceIdbAdapter.js';

/**
 * @param {Storage | null | undefined} storage
 * @returns {string}
 */
export function readLegacyLocalBootCacheRaw(storage) {
  if (!storage || typeof storage.getItem !== 'function') return '';
  try {
    return readStorageValueWithAlias(storage, CHAT_LOCAL_BOOT_CACHE_KEY, '');
  } catch (_) {
    return '';
  }
}

/**
 * @param {Storage | null | undefined} storage
 * @returns {ReturnType<typeof parseChatLocalBootCache>}
 */
export function readLegacyLocalBootCacheDoc(storage) {
  return parseChatLocalBootCache(readLegacyLocalBootCacheRaw(storage));
}

/**
 * @param {Storage | null | undefined} storage
 */
export function removeLegacyLocalBootCacheFromStorage(storage) {
  if (!storage || typeof storage.removeItem !== 'function') return;
  try {
    removeStorageValueWithAlias(storage, CHAT_LOCAL_BOOT_CACHE_KEY);
  } catch (_) {}
}

/**
 * @param {{
 *   storage?: Storage | null,
 *   adapter: import('./chatPersistenceAdapter.js').ChatPersistenceAdapter,
 *   getIdbEpoch?: () => number,
 *   persistKv?: (key: string, value: string, guard: { epoch: number }) => Promise<boolean>,
 * }} options
 * @returns {Promise<{ ok: boolean, reason: string, removedLegacy: boolean }>}
 */
export async function migrateLegacyLocalBootCacheToIdb(options) {
  const storage = options.storage === undefined
    ? (typeof localStorage !== 'undefined' ? localStorage : null)
    : options.storage;
  const adapter = options.adapter;
  if (!adapter || typeof adapter.read !== 'function') {
    return { ok: false, reason: 'no-adapter', removedLegacy: false };
  }
  const rawLegacy = readLegacyLocalBootCacheRaw(storage);
  if (!rawLegacy.trim()) {
    return { ok: true, reason: 'absent', removedLegacy: false };
  }
  const legacyDoc = parseChatLocalBootCache(rawLegacy);
  if (!legacyDoc) {
    return { ok: false, reason: 'invalid-legacy', removedLegacy: false };
  }
  if (!isChatMetadataIdbPersistenceAdapter(adapter)) {
    return { ok: true, reason: 'non-idb-adapter', removedLegacy: false };
  }
  if (getChatMetadataIdbStatus() !== 'ok') {
    return { ok: false, reason: 'idb-unavailable', removedLegacy: false };
  }
  const epoch = typeof options.getIdbEpoch === 'function'
    ? options.getIdbEpoch()
    : 0;
  const persistKv = typeof options.persistKv === 'function'
    ? options.persistKv
    : (key, value, guard) => adapter.persistKv(key, value, guard);
  const existingRaw = adapter.read(CHAT_LOCAL_BOOT_CACHE_KEY);
  const existingDoc = parseChatLocalBootCache(existingRaw);
  if (existingDoc && !shouldReplaceChatLocalBootCacheDoc(existingDoc, legacyDoc)) {
    if (
      chatLocalBootCacheContentSignature(existingDoc) === chatLocalBootCacheContentSignature(legacyDoc)
    ) {
      if (readLegacyLocalBootCacheRaw(storage) !== rawLegacy) {
        return { ok: false, reason: 'legacy-changed-during-migration', removedLegacy: false };
      }
      removeLegacyLocalBootCacheFromStorage(storage);
      return { ok: true, reason: 'already-in-idb', removedLegacy: true };
    }
    return { ok: true, reason: 'idb-newer', removedLegacy: false };
  }
  const payload = rawLegacy.trim();
  adapter.write(CHAT_LOCAL_BOOT_CACHE_KEY, payload);
  const committed = await persistKv(CHAT_LOCAL_BOOT_CACHE_KEY, payload, { epoch });
  if (!committed) {
    return { ok: false, reason: 'idb-commit-failed', removedLegacy: false };
  }
  if (readLegacyLocalBootCacheRaw(storage) !== rawLegacy) {
    return { ok: false, reason: 'legacy-changed-during-migration', removedLegacy: false };
  }
  removeLegacyLocalBootCacheFromStorage(storage);
  return { ok: true, reason: 'migrated', removedLegacy: true };
}
