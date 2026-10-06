/**
 * Shared persistence adapter + session generation for the chat RAM stores.
 *
 * Task 2.1 defines this contract once so that:
 * - the activity/last-used RAM store can hydrate/merge/persist without knowing
 *   whether the backend is localStorage (P0, legacy) or IndexedDB (stage 5), and
 * - the single persistence queue from task 2.3 can reuse the same adapter and the
 *   same session id, instead of growing a second, competing transport.
 *
 * Contract (all methods synchronous for the P0 localStorage backend; the stage-5
 * IndexedDB adapter may return promises and the queue will await them):
 *
 *   ChatPersistenceAdapter = {
 *     contractVersion: number,
 *     kind: 'local-storage' | 'memory' | 'noop' | string,
 *     read(key): string | null,
 *     write(key, value): boolean,
 *     remove(key): void,
 *   }
 *
 * Session generation:
 * - `CHAT_PERSISTENCE_SESSION_KEY` holds a small JSON marker `{ id, generation,
 *   updatedAt, reason }` shared by every tab of the same browser profile.
 * - Every persisted timestamp-map payload carries the `sessionId` that wrote it.
 *   A payload whose `sessionId` differs from the current marker is stale data
 *   from a previous session and must be rejected (task 2.1 acceptance), and the
 *   same id is what the 2.3 queue checks before applying a delayed write.
 *
 * The module is DOM-free so it can be unit-tested under `node`.
 */

import {
  readStorageValueWithAlias,
  removeStorageValueWithAlias,
  writeStorageValueWithAlias,
} from '../../lib/storageKeyAlias.js';

/** Version of the adapter interface itself. */
export const CHAT_PERSISTENCE_CONTRACT_VERSION = 1;

/** Version of the wrapped timestamp-map payload written by the RAM store. */
export const CHAT_PERSISTENCE_PAYLOAD_VERSION = 1;

/** localStorage key holding the per-chat activity timestamps. */
export const CHAT_ACTIVITY_STORAGE_KEY = 'cretli-chat-activity';

/** localStorage key holding the per-chat last-used timestamps. */
export const CHAT_LAST_USED_STORAGE_KEY = 'cretli-chat-last-used';

/** localStorage key holding the shared session marker. */
export const CHAT_PERSISTENCE_SESSION_KEY = 'cretli-chat-persistence-session-v1';

/** localStorage key used to invalidate another tab's RAM without a new session. */
export const CHAT_PERSISTENCE_INVALIDATION_KEY = 'cretli-chat-persistence-invalidate-v1';

/**
 * @typedef {object} ChatPersistenceAdapter
 * @property {number} contractVersion
 * @property {string} kind
 * @property {(key: string) => (string | null)} read
 * @property {(key: string, value: string) => boolean} write
 * @property {(key: string) => void} remove
 */

/**
 * Accept either a Storage-like object or a resolver function. Tests and the app
 * both swap `globalThis.localStorage`, so a resolver is the safe form.
 *
 * @param {Storage | (() => (Storage | null | undefined)) | null | undefined} source
 * @returns {() => (Storage | null)}
 */
function resolveStorageSource(source) {
  if (typeof source === 'function') {
    return () => {
      try {
        return source() || null;
      } catch (_) {
        return null;
      }
    };
  }
  return () => source || null;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isPersistenceAdapter(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && Number(value.contractVersion) === CHAT_PERSISTENCE_CONTRACT_VERSION
    && typeof value.read === 'function'
    && typeof value.write === 'function'
    && typeof value.remove === 'function'
  );
}

/**
 * Adapter over the P0 localStorage backend. Uses the `cretli-`/`cursor-remote-`
 * alias helper so legacy activity keys are still migrated transparently.
 *
 * @param {Storage | (() => (Storage | null | undefined)) | null | undefined} source
 * @param {{ useAliases?: boolean }} [options]
 * @returns {ChatPersistenceAdapter}
 */
export function createStoragePersistenceAdapter(source, options = {}) {
  const getStorage = resolveStorageSource(source);
  const useAliases = options.useAliases !== false;

  /** @param {string} key @returns {string | null} */
  function readRaw(key) {
    const storage = getStorage();
    if (!storage || typeof storage.getItem !== 'function') return null;
    return useAliases
      ? readStorageValueWithAlias(storage, key, '') || null
      : storage.getItem(key);
  }

  return {
    contractVersion: CHAT_PERSISTENCE_CONTRACT_VERSION,
    kind: 'local-storage',
    /** @param {string} key @returns {string | null} */
    read(key) {
      try {
        return readRaw(key);
      } catch (_) {
        return null;
      }
    },
    /** @param {string} key @param {string} value @returns {boolean} */
    write(key, value) {
      const storage = getStorage();
      if (!storage || typeof storage.setItem !== 'function') return false;
      try {
        if (useAliases) writeStorageValueWithAlias(storage, key, String(value));
        else storage.setItem(key, String(value));
        return true;
      } catch (_) {
        return false;
      }
    },
    /** @param {string} key @returns {void} */
    remove(key) {
      const storage = getStorage();
      if (!storage || typeof storage.removeItem !== 'function') return;
      try {
        if (useAliases) removeStorageValueWithAlias(storage, key);
        else storage.removeItem(key);
      } catch (_) {
        /* best effort */
      }
    },
  };
}

/**
 * In-memory adapter used by unit tests and as the shape reference for the
 * stage-5 IndexedDB backend.
 *
 * @param {Record<string, string>} [seed]
 * @returns {ChatPersistenceAdapter & { _dump: () => Record<string, string> }}
 */
export function createMemoryPersistenceAdapter(seed = {}) {
  /** @type {Map<string, string>} */
  const map = new Map(Object.entries(seed));
  return {
    contractVersion: CHAT_PERSISTENCE_CONTRACT_VERSION,
    kind: 'memory',
    read(key) {
      return map.has(key) ? map.get(key) : null;
    },
    write(key, value) {
      map.set(String(key), String(value));
      return true;
    },
    remove(key) {
      map.delete(String(key));
    },
    _dump() {
      return Object.fromEntries(map.entries());
    },
  };
}

/**
 * Adapter that drops everything (no storage / private mode). The store keeps
 * working from RAM and simply cannot persist.
 *
 * @returns {ChatPersistenceAdapter}
 */
export function createNoopPersistenceAdapter() {
  return {
    contractVersion: CHAT_PERSISTENCE_CONTRACT_VERSION,
    kind: 'noop',
    read() {
      return null;
    },
    write() {
      return false;
    },
    remove() {
      /* no-op */
    },
  };
}

/**
 * Opaque, collision-resistant session id shared through the session marker.
 *
 * @param {() => number} [now]
 * @param {() => number} [random]
 * @returns {string}
 */
export function createSessionId(now = () => Date.now(), random = () => Math.random()) {
  const time = Math.max(0, Math.floor(Number(now()) || 0)).toString(36);
  const noise = Math.floor(Math.abs(Number(random()) || 0) * 0x100000000).toString(36);
  return `s-${time}-${noise}`;
}

/**
 * @param {unknown} raw
 * @returns {{ id: string, generation: number, updatedAt: number, reason: string } | null}
 */
export function normalizeSessionMarker(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const id = typeof parsed.id === 'string' ? parsed.id.trim() : '';
  if (!id) return null;
  const generation = Number.isFinite(Number(parsed.generation)) && Number(parsed.generation) > 0
    ? Math.floor(Number(parsed.generation))
    : 1;
  return {
    id,
    generation,
    updatedAt: Number.isFinite(Number(parsed.updatedAt)) ? Number(parsed.updatedAt) : 0,
    reason: typeof parsed.reason === 'string' ? parsed.reason : '',
  };
}

/**
 * @param {{ id: string, generation?: number, updatedAt?: number, reason?: string }} marker
 * @returns {string}
 */
export function serializeSessionMarker(marker) {
  return JSON.stringify({
    id: String(marker?.id || ''),
    generation: Number.isFinite(Number(marker?.generation)) ? Math.floor(Number(marker.generation)) : 1,
    updatedAt: Number.isFinite(Number(marker?.updatedAt)) ? Number(marker.updatedAt) : 0,
    reason: typeof marker?.reason === 'string' ? marker.reason : '',
  });
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function normalizeTimestamp(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : 0;
}

/**
 * @param {unknown} input
 * @returns {Array<[string, unknown]>}
 */
function toEntries(input) {
  if (input instanceof Map) return [...input.entries()];
  if (Array.isArray(input)) return input;
  if (input && typeof input === 'object') return Object.entries(input);
  return [];
}

/**
 * Serialize a timestamp map with the session metadata the merge/rejection logic
 * needs. The `values` object stays a plain `{ chatId: ms }` map.
 *
 * @param {Map<string, number> | Record<string, number> | Array<[string, number]>} values
 * @param {{ sessionId?: string, generation?: number, updatedAt?: number }} [meta]
 * @returns {string}
 */
export function serializeTimestampMap(values, meta = {}) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const [rawId, rawValue] of toEntries(values)) {
    const id = typeof rawId === 'string' ? rawId.trim() : '';
    const value = normalizeTimestamp(rawValue);
    if (!id || !value) continue;
    out[id] = value;
  }
  return JSON.stringify({
    v: CHAT_PERSISTENCE_PAYLOAD_VERSION,
    sessionId: typeof meta.sessionId === 'string' ? meta.sessionId : '',
    generation: Number.isFinite(Number(meta.generation)) ? Math.floor(Number(meta.generation)) : 1,
    updatedAt: Number.isFinite(Number(meta.updatedAt)) ? Number(meta.updatedAt) : 0,
    values: out,
  });
}

/**
 * Parse either the wrapped payload written by task 2.1 or the legacy raw
 * `{ chatId: ms }` object written before it. Returns `null` for absent or
 * malformed data.
 *
 * @param {unknown} raw
 * @returns {{ values: Record<string, number>, sessionId: string, generation: number, wrapped: boolean } | null}
 */
export function parseTimestampMapPayload(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const wrapped = Number(parsed.v) === CHAT_PERSISTENCE_PAYLOAD_VERSION
    && parsed.values
    && typeof parsed.values === 'object'
    && !Array.isArray(parsed.values);
  const source = wrapped ? parsed.values : parsed;

  /** @type {Record<string, number>} */
  const values = {};
  for (const [rawId, rawValue] of Object.entries(source)) {
    const id = typeof rawId === 'string' ? rawId.trim() : '';
    const value = normalizeTimestamp(rawValue);
    if (!id || !value) continue;
    values[id] = value;
  }
  return {
    values,
    sessionId: wrapped && typeof parsed.sessionId === 'string' ? parsed.sessionId : '',
    generation: wrapped && Number.isFinite(Number(parsed.generation)) ? Math.floor(Number(parsed.generation)) : 0,
    wrapped: Boolean(wrapped),
  };
}
