/**
 * Local (per-device) storage for the Web Push notification preferences.
 *
 * This module is the browser glue between the pure contract in
 * `lib/push-preferences.js` and the generic app preferences IndexedDB
 * (`cretli-preferences` / store `kv`, the same database `app_front/lib/favorites.js`
 * uses). It deliberately does NOT touch the push inbox database
 * (`cretli-push-inbox` / `events`, keyPath `chatId`): writing a preferences record
 * keyed by endpoint into the inbox store would overwrite inbox events.
 *
 * Everything here is dependency-injected and import-safe in Node, so the store
 * logic (merge, restart round-trip, save-error propagation) is unit tested
 * without a browser. The actual IndexedDB persistence lives in
 * `createIndexedDbPersistence()`.
 *
 * Design rules:
 * - `load()` never throws: garbage / unreadable storage falls back to the
 *   migrated legacy defaults.
 * - `save()` MUST reject when the write fails; a failed write is never reported
 *   as a success. Callers surface it to the user.
 * - In-app sound volume is a device-level value (not per endpoint), so it is
 *   stored under its own key and is intentionally NOT part of the per-endpoint
 *   push preferences contract.
 */
import { normalizeChatMuteRecord } from '../../../lib/chat-mute.js';
import {
  mergeQuietHours,
  normalizeQuietHours,
} from '../../../lib/push-quiet-hours.js';
import {
  PUSH_PREFERENCES_DB_NAME,
  PUSH_PREFERENCES_SCHEMA_VERSION,
  PUSH_PREFERENCES_STORE_NAME,
  buildPushPreferencesStorageKey,
  mergePushPreferences,
  migrateLegacyPushPreferences,
  validatePushPreferences,
} from '../../../lib/push-preferences.js';

/** Fallback endpoint used until a real push subscription exists. */
export const PUSH_PREFERENCES_DEVICE_ENDPOINT = 'device';

/** Device-level IndexedDB key for quiet hours (vibration/sound only). */
export const PUSH_QUIET_HOURS_KEY = 'push-quiet-hours';

/** Device-level IndexedDB key for per-chat mute list + alert throttle state. */
export const PUSH_MUTED_CHATS_KEY = 'push-muted-chats';

/** Device-level IndexedDB key for the in-app sound volume. */
export const PUSH_IN_APP_VOLUME_KEY = 'push-in-app-volume';
export const PUSH_IN_APP_VOLUME_DEFAULT = 0.6;
export const PUSH_IN_APP_VOLUME_MIN = 0;
export const PUSH_IN_APP_VOLUME_MAX = 1;

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Clamp arbitrary input to the valid volume range. Non-numeric input falls back
 * to the default instead of silently becoming 0.
 *
 * @param {unknown} value
 * @returns {number}
 */
export function clampPushInAppVolume(value) {
  if (value === null || value === undefined || value === '') return PUSH_IN_APP_VOLUME_DEFAULT;
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return PUSH_IN_APP_VOLUME_DEFAULT;
  return Math.min(PUSH_IN_APP_VOLUME_MAX, Math.max(PUSH_IN_APP_VOLUME_MIN, num));
}

/**
 * Resolve the IndexedDB key for an endpoint, falling back to the device-scoped
 * draft key when there is no subscription yet. The returned key is always
 * non-empty so preferences survive a restart before push is enabled.
 *
 * @param {unknown} endpoint
 * @returns {string}
 */
export function resolvePushPreferencesKey(endpoint) {
  const value = typeof endpoint === 'string' ? endpoint.trim() : '';
  return buildPushPreferencesStorageKey(value || PUSH_PREFERENCES_DEVICE_ENDPOINT);
}

/**
 * @typedef {object} PushPreferencesPersistence
 * @property {(key: string) => Promise<unknown>} get
 * @property {(key: string, value: unknown) => Promise<void>} set
 */

/**
 * Create the local preferences store over an injected persistence.
 *
 * @param {PushPreferencesPersistence} persistence
 * @param {{ readLegacyEnabled?: () => unknown }} [options]
 */
export function createPushPreferencesStore(persistence, options = {}) {
  if (
    !persistence
    || typeof persistence.get !== 'function'
    || typeof persistence.set !== 'function'
  ) {
    throw new TypeError('createPushPreferencesStore requires persistence.get()/set()');
  }
  const readLegacyEnabled = typeof options.readLegacyEnabled === 'function'
    ? options.readLegacyEnabled
    : () => '';
  let pendingSave = Promise.resolve();

  /**
   * Reads are best-effort: a broken read must not break the settings panel, and
   * the migration fallback covers the "nothing stored yet" case.
   *
   * @param {string} key
   * @returns {Promise<unknown>}
   */
  async function readRecord(key) {
    try {
      const raw = await persistence.get(key);
      return raw === undefined ? null : raw;
    } catch (_) {
      return null;
    }
  }

  function isStoredContract(record) {
    if (!isPlainObject(record)) return false;
    if (record.schemaVersion !== PUSH_PREFERENCES_SCHEMA_VERSION) return false;
    return validatePushPreferences(record).ok;
  }

  /**
   * Load the full, normalized preferences for one endpoint. When the endpoint
   * has no record yet, the device-scoped draft is used so pre-enable choices are
   * kept; when neither exists, the migrated legacy defaults apply.
   *
   * @param {unknown} endpoint
   * @returns {Promise<ReturnType<typeof mergePushPreferences>>}
   */
  async function load(endpoint) {
    const key = resolvePushPreferencesKey(endpoint);
    let candidate = await readRecord(key);
    const isEndpointScoped = key !== resolvePushPreferencesKey('');
    if (!isStoredContract(candidate) && isEndpointScoped) {
      const draft = await readRecord(resolvePushPreferencesKey(''));
      if (isStoredContract(draft)) candidate = draft;
    }
    if (isStoredContract(candidate)) return validatePushPreferences(candidate).value;
    return migrateLegacyPushPreferences(readLegacyEnabled(), candidate);
  }

  /**
   * Merge a patch over the stored preferences and persist it. Rejects when the
   * write fails — callers must show an error instead of assuming success.
   *
   * @param {unknown} endpoint
   * @param {unknown} patch
   * @returns {Promise<ReturnType<typeof mergePushPreferences>>}
   */
  function save(endpoint, patch) {
    // Rapid edits to separate profiles must merge over the latest completed write.
    const result = pendingSave.catch(() => {}).then(async () => {
      const key = resolvePushPreferencesKey(endpoint);
      const current = await load(endpoint);
      const next = mergePushPreferences(current, patch);
      await persistence.set(key, next);
      return next;
    });
    pendingSave = result;
    return result;
  }

  /**
   * @returns {Promise<number>}
   */
  async function loadVolume() {
    const raw = await readRecord(PUSH_IN_APP_VOLUME_KEY);
    if (raw === null || raw === undefined) return PUSH_IN_APP_VOLUME_DEFAULT;
    return clampPushInAppVolume(raw);
  }

  /**
   * @param {unknown} value
   * @returns {Promise<number>} the clamped value actually persisted
   */
  async function saveVolume(value) {
    const clamped = clampPushInAppVolume(value);
    await persistence.set(PUSH_IN_APP_VOLUME_KEY, clamped);
    return clamped;
  }

  /**
   * @returns {Promise<ReturnType<typeof normalizeQuietHours>>}
   */
  async function loadQuietHours() {
    const raw = await readRecord(PUSH_QUIET_HOURS_KEY);
    return normalizeQuietHours(raw);
  }

  /**
   * @param {unknown} patch
   * @returns {Promise<ReturnType<typeof normalizeQuietHours>>}
   */
  async function saveQuietHours(patch) {
    const current = await loadQuietHours();
    const next = mergeQuietHours(current, patch);
    await persistence.set(PUSH_QUIET_HOURS_KEY, next);
    return next;
  }

  /**
   * @returns {Promise<ReturnType<typeof normalizeChatMuteRecord>>}
   */
  async function loadChatMuteRecord() {
    const raw = await readRecord(PUSH_MUTED_CHATS_KEY);
    return normalizeChatMuteRecord(raw);
  }

  /**
   * @param {unknown} record
   * @returns {Promise<ReturnType<typeof normalizeChatMuteRecord>>}
   */
  async function saveChatMuteRecord(record) {
    const next = normalizeChatMuteRecord(record);
    await persistence.set(PUSH_MUTED_CHATS_KEY, next);
    return next;
  }

  return {
    load,
    save,
    loadVolume,
    saveVolume,
    loadQuietHours,
    saveQuietHours,
    loadChatMuteRecord,
    saveChatMuteRecord,
    resolveKey: resolvePushPreferencesKey,
  };
}

/**
 * IndexedDB persistence over the generic app preferences database. Rejects on
 * write failures so `save()` can propagate them.
 *
 * @param {{ indexedDB?: IDBFactory, dbName?: string, storeName?: string }} [options]
 * @returns {PushPreferencesPersistence}
 */
export function createIndexedDbPersistence(options = {}) {
  const idb = options.indexedDB
    || (typeof indexedDB !== 'undefined' ? indexedDB : null);
  const dbName = options.dbName || PUSH_PREFERENCES_DB_NAME;
  const storeName = options.storeName || PUSH_PREFERENCES_STORE_NAME;
  /** @type {Promise<IDBDatabase | null> | null} */
  let dbPromise = null;

  function open() {
    if (!idb) return Promise.resolve(null);
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      let request;
      try {
        request = idb.open(dbName, 1);
      } catch (err) {
        dbPromise = null;
        reject(err);
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        dbPromise = null;
        reject(request.error || new Error('indexedDB open failed'));
      };
    });
    return dbPromise;
  }

  async function get(key) {
    const db = await open();
    if (!db) return null;
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(storeName, 'readonly');
        const request = tx.objectStore(storeName).get(key);
        request.onsuccess = () => resolve(request.result === undefined ? null : request.result);
        request.onerror = () => reject(request.error || new Error('indexedDB read failed'));
      } catch (err) {
        reject(err);
      }
    });
  }

  async function set(key, value) {
    const db = await open();
    if (!db) throw new Error('indexedDB unavailable');
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('indexedDB write failed'));
        tx.onabort = () => reject(tx.error || new Error('indexedDB write aborted'));
      } catch (err) {
        reject(err);
      }
    });
  }

  return { get, set };
}
