/**
 * RAM store for per-chat activity / last-used timestamps (task 2.1).
 *
 * Before this module `chatStore.getChatActivityAt` called `localStorage.getItem`
 * + `JSON.parse` on *every* comparator call, which the 2026-10-05 trace blamed
 * for ~10 s of the UI freeze. The store keeps both maps in memory and exposes
 * them to the sorter/background policy without any storage access.
 *
 * Contract:
 * - `hydrateLegacyOnce()` reads the persisted maps at most once per session and
 *   only when the payload belongs to the current session. It never runs inside a
 *   write loop; the lazy accessors (`getActivityAt`/`getLastUsedAt`) hydrate on
 *   their first call and are storage-free afterwards.
 * - Incoming changes (HTTP/WS payloads, another tab through a `storage` event,
 *   the future 2.3 queue) merge **per key by max timestamp**. A whole map never
 *   overwrites another whole map.
 * - `resetSession()` invalidates the in-memory maps and rotates the shared
 *   session id; any later update that carries the old session id/generation is
 *   rejected. Another tab's `storage` event does the same locally.
 * - `pruneToKnownIds(ids, { authoritative: true })` may drop timestamps for
 *   chats that no longer exist, but a limited boot snapshot (not authoritative)
 *   must never drop activity of chats that simply have not been loaded yet.
 *
 * The module is DOM-free so it can be unit-tested under `node`.
 */

import { getUiFreezeCounters } from '../../lib/uiFreezeCounters.js';
import {
  CHAT_ACTIVITY_STORAGE_KEY,
  CHAT_LAST_USED_STORAGE_KEY,
  CHAT_PERSISTENCE_INVALIDATION_KEY,
  CHAT_PERSISTENCE_SESSION_KEY,
  createSessionId,
  createStoragePersistenceAdapter,
  normalizeSessionMarker,
  parseTimestampMapPayload,
  serializeSessionMarker,
  serializeTimestampMap,
} from './chatPersistenceAdapter.js';

/**
 * @param {unknown} value
 * @returns {number}
 */
function normalizeTimestamp(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : 0;
}

/**
 * @param {unknown} id
 * @returns {string}
 */
function normalizeId(id) {
  return typeof id === 'string' ? id.trim() : '';
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
 * @typedef {object} ChatActivityUpdateResult
 * @property {number} applied
 * @property {string[]} changedIds
 * @property {boolean} rejected
 */

/**
 * @param {{
 *   adapter?: import('./chatPersistenceAdapter.js').ChatPersistenceAdapter,
 *   storage?: Storage | (() => (Storage | null | undefined)) | null,
 *   now?: () => number,
 *   createSessionId?: () => string,
 * }} [options]
 */
export function createChatActivityStore(options = {}) {
  const adapter = options.adapter
    || createStoragePersistenceAdapter(
      options.storage === undefined
        ? () => (typeof localStorage !== 'undefined' ? localStorage : null)
        : options.storage
    );
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const sessionIdFactory = typeof options.createSessionId === 'function'
    ? options.createSessionId
    : createSessionId;

  /** @type {Map<string, number>} */
  const activity = new Map();
  /** @type {Map<string, number>} */
  const lastUsed = new Map();
  /** @type {Set<(event: object) => void>} */
  const listeners = new Set();

  let hydrated = false;
  /** Raw (unwrapped) legacy payloads are only accepted before the first boundary. */
  let allowLegacyImport = true;
  let generation = 1;
  let sessionId = '';
  let authoritativeIndexSeen = false;

  function bump(name) {
    getUiFreezeCounters()?.bump(name);
  }

  /** @param {object} event */
  function notify(event) {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (_) {
        /* listeners are advisory; never let one break persistence */
      }
    }
  }

  function ensureSession() {
    if (sessionId) return sessionId;
    const marker = normalizeSessionMarker(adapter.read(CHAT_PERSISTENCE_SESSION_KEY));
    if (marker && marker.id) {
      sessionId = marker.id;
      generation = Math.max(generation, marker.generation || 1);
      return sessionId;
    }
    sessionId = String(sessionIdFactory());
    writeSessionMarker('create');
    return sessionId;
  }

  /** @param {string} [reason] */
  function writeSessionMarker(reason = '') {
    try {
      adapter.write(
        CHAT_PERSISTENCE_SESSION_KEY,
        serializeSessionMarker({ id: sessionId, generation, updatedAt: now(), reason })
      );
    } catch (_) {
      /* session marker is best effort; RAM stays authoritative in this tab */
    }
  }

  /**
   * Merge a timestamp map into `target` keeping the maximum per key.
   *
   * @param {Map<string, number>} target
   * @param {unknown} input
   * @returns {{ applied: number, changedIds: string[] }}
   */
  function mergeMap(target, input) {
    let applied = 0;
    /** @type {string[]} */
    const changedIds = [];
    for (const [rawId, rawValue] of toEntries(input)) {
      const id = normalizeId(rawId);
      if (!id) continue;
      const value = normalizeTimestamp(rawValue);
      if (!value) continue;
      const previous = target.get(id) || 0;
      if (value <= previous) continue;
      target.set(id, value);
      applied += 1;
      changedIds.push(id);
    }
    return { applied, changedIds };
  }

  function persistMapsImmediate() {
    try {
      ensureSession();
      const meta = { sessionId, generation, updatedAt: now() };
      adapter.write(CHAT_ACTIVITY_STORAGE_KEY, serializeTimestampMap(activity, meta));
      adapter.write(CHAT_LAST_USED_STORAGE_KEY, serializeTimestampMap(lastUsed, meta));
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * @param {{ activityIds?: string[], lastUsedIds?: string[] }} [detail]
   */
  function persistMaps(detail) {
    if (activityPersistenceSink) {
      activityPersistenceSink(detail);
      return true;
    }
    return persistMapsImmediate();
  }

  /**
   * True when a decoded payload may be applied to this session.
   *
   * @param {{ sessionId: string, wrapped: boolean }} payload
   * @returns {boolean}
   */
  function isPayloadAcceptable(payload) {
    if (!payload) return false;
    if (payload.sessionId) return payload.sessionId === sessionId;
    return payload.wrapped === false && allowLegacyImport;
  }

  /**
   * Reject updates produced by a session that has already been replaced.
   *
   * @param {{ sessionId?: string, generation?: number }} [scope]
   * @returns {boolean}
   */
  function isCurrentScope(scope = {}) {
    if (scope.sessionId && scope.sessionId !== sessionId) return false;
    if (Number.isFinite(Number(scope.generation)) && Number(scope.generation) < generation) {
      return false;
    }
    return true;
  }

  /**
   * Read the legacy/wrapped maps exactly once per session.
   *
   * @returns {{ hydrated: boolean, reason: string, activity: number, lastUsed: number }}
   */
  function hydrateLegacyOnce() {
    if (hydrated) return { hydrated: false, reason: 'already', activity: 0, lastUsed: 0 };
    hydrated = true;
    // A raw (unwrapped) map is only a first-migration input: once a session
    // marker exists, a raw map cannot be attributed to the current session and
    // must not be resurrected. Wrapped maps are still imported when their
    // session id matches (so a reload after a reset keeps its own data).
    const existingMarker = normalizeSessionMarker(safeRead(CHAT_PERSISTENCE_SESSION_KEY));
    ensureSession();
    allowLegacyImport = allowLegacyImport && !existingMarker;
    const reason = allowLegacyImport ? 'legacy' : 'session';
    bump('storage.reads');
    const activityPayload = parseTimestampMapPayload(safeRead(CHAT_ACTIVITY_STORAGE_KEY));
    const lastUsedPayload = parseTimestampMapPayload(safeRead(CHAT_LAST_USED_STORAGE_KEY));
    let activityApplied = 0;
    let lastUsedApplied = 0;
    if (isPayloadAcceptable(activityPayload)) {
      activityApplied = mergeMap(activity, activityPayload.values).applied;
    }
    if (isPayloadAcceptable(lastUsedPayload)) {
      lastUsedApplied = mergeMap(lastUsed, lastUsedPayload.values).applied;
    }
    // After the first hydrate only the current written payload is legitimate.
    allowLegacyImport = false;
    // First migration: normalise the legacy raw maps into the wrapped,
    // session-tagged form so the next reload can attribute them and does not
    // re-import them as an anonymous legacy map.
    if (reason === 'legacy') persistMaps({ activityIds: [], lastUsedIds: [] });
    return {
      hydrated: true,
      reason,
      activity: activityApplied,
      lastUsed: lastUsedApplied,
    };
  }

  /** @param {string} key @returns {string | null} */
  function safeRead(key) {
    try {
      return adapter.read(key);
    } catch (_) {
      return null;
    }
  }

  /**
   * @param {string} field
   * @param {unknown} raw
   * @returns {ChatActivityUpdateResult}
   */
  function applyPayloadFromStorage(field, raw) {
    // A storage event can arrive before the first local read (the listener is
    // installed at boot). Hydrate first so the session id exists and the
    // payload can be attributed instead of being rejected as anonymous.
    hydrateLegacyOnce();
    const payload = parseTimestampMapPayload(raw);
    if (!payload) return { applied: 0, changedIds: [], rejected: false };
    if (!isPayloadAcceptable(payload)) return { applied: 0, changedIds: [], rejected: true };
    const target = field === 'lastUsed' ? lastUsed : activity;
    const result = mergeMap(target, payload.values);
    if (result.applied > 0) {
      notify({ type: field, changedIds: result.changedIds, source: 'storage' });
    }
    return { applied: result.applied, changedIds: result.changedIds, rejected: false };
  }

  /** @returns {Record<string, number>} */
  function snapshotActivity() {
    hydrateLegacyOnce();
    return Object.fromEntries(activity.entries());
  }

  /** @returns {Record<string, number>} */
  function snapshotLastUsed() {
    hydrateLegacyOnce();
    return Object.fromEntries(lastUsed.entries());
  }

  /** @param {string} chatId @returns {number} */
  function getActivityAt(chatId) {
    const id = normalizeId(chatId);
    if (!id) return 0;
    hydrateLegacyOnce();
    return activity.get(id) || 0;
  }

  /** @param {string} chatId @returns {number} */
  function getLastUsedAt(chatId) {
    const id = normalizeId(chatId);
    if (!id) return 0;
    hydrateLegacyOnce();
    return lastUsed.get(id) || 0;
  }

  /**
   * @param {string} chatId
   * @param {number} [at]
   * @returns {number}
   */
  function recordActivity(chatId, at) {
    const id = normalizeId(chatId);
    if (!id) return 0;
    hydrateLegacyOnce();
    const value = normalizeTimestamp(at) || now();
    const previous = activity.get(id) || 0;
    if (value <= previous) return previous;
    activity.set(id, value);
    persistMaps({ activityIds: [id] });
    notify({ type: 'activity', changedIds: [id], source: 'local' });
    return value;
  }

  /**
   * @param {string} chatId
   * @param {number} [at]
   * @returns {number}
   */
  function recordLastUsed(chatId, at) {
    const id = normalizeId(chatId);
    if (!id) return 0;
    hydrateLegacyOnce();
    const value = normalizeTimestamp(at) || now();
    const previous = lastUsed.get(id) || 0;
    if (value <= previous) return previous;
    lastUsed.set(id, value);
    persistMaps({ lastUsedIds: [id] });
    notify({ type: 'lastUsed', changedIds: [id], source: 'local' });
    return value;
  }

  /**
   * Merge an externally supplied activity map (HTTP/WS/queue/other tab).
   *
   * @param {unknown} input
   * @param {{ sessionId?: string, generation?: number, source?: string, force?: boolean }} [scope]
   * @returns {ChatActivityUpdateResult}
   */
  function mergeActivity(input, scope = {}) {
    hydrateLegacyOnce();
    if (scope.force !== true && !isCurrentScope(scope)) {
      return { applied: 0, changedIds: [], rejected: true };
    }
    const result = mergeMap(activity, input);
    if (result.applied > 0) {
      if (scope.persist !== false) {
        persistMaps({ activityIds: result.changedIds });
      }
      if (scope.notify !== false) {
        notify({ type: 'activity', changedIds: result.changedIds, source: scope.source || 'merge' });
      }
    }
    return { applied: result.applied, changedIds: result.changedIds, rejected: false };
  }

  /**
   * @param {unknown} input
   * @param {{ sessionId?: string, generation?: number, source?: string, force?: boolean }} [scope]
   * @returns {ChatActivityUpdateResult}
   */
  function mergeLastUsed(input, scope = {}) {
    hydrateLegacyOnce();
    if (scope.force !== true && !isCurrentScope(scope)) {
      return { applied: 0, changedIds: [], rejected: true };
    }
    const result = mergeMap(lastUsed, input);
    if (result.applied > 0) {
      if (scope.persist !== false) {
        persistMaps({ lastUsedIds: result.changedIds });
      }
      if (scope.notify !== false) {
        notify({ type: 'lastUsed', changedIds: result.changedIds, source: scope.source || 'merge' });
      }
    }
    return { applied: result.applied, changedIds: result.changedIds, rejected: false };
  }

  /**
   * Cross-tab invalidation / hydration. Returns what the event did so a caller
   * can assert (and so the 2.3 queue can react) without reading internals.
   *
   * @param {{ key?: unknown, newValue?: unknown }} event
   * @returns {{ handled: boolean, reset?: boolean, rejected?: boolean, applied?: number }}
   */
  function handleStorageEvent(event) {
    const key = event && typeof event.key === 'string' ? event.key : '';
    if (!key) return { handled: false };
    if (key === CHAT_PERSISTENCE_SESSION_KEY) {
      if (event.newValue == null) {
        dropRamForBoundary('session-removed');
        return { handled: true, reset: true };
      }
      const marker = normalizeSessionMarker(event.newValue);
      const reset = adoptSessionMarker(marker, 'storage-session');
      return { handled: true, reset };
    }
    if (key === CHAT_PERSISTENCE_INVALIDATION_KEY) {
      dropRamForBoundary('storage-invalidate');
      return { handled: true, reset: true };
    }
    if (key === CHAT_ACTIVITY_STORAGE_KEY) {
      const result = applyPayloadFromStorage('activity', event.newValue);
      return { handled: true, ...result };
    }
    if (key === CHAT_LAST_USED_STORAGE_KEY) {
      const result = applyPayloadFromStorage('lastUsed', event.newValue);
      return { handled: true, ...result };
    }
    return { handled: false };
  }

  /** @param {string} reason */
  function dropRamForBoundary(reason) {
    generation += 1;
    activity.clear();
    lastUsed.clear();
    hydrated = true;
    allowLegacyImport = false;
    authoritativeIndexSeen = false;
    sessionId = '';
    notify({ type: 'reset', reason, sessionId, generation });
  }

  /**
   * @param {{ id: string, generation?: number } | null} marker
   * @param {string} reason
   * @returns {boolean}
   */
  function adoptSessionMarker(marker, reason) {
    if (!marker || !marker.id || marker.id === sessionId) return false;
    generation = Math.max(generation + 1, Number(marker.generation) || 0);
    activity.clear();
    lastUsed.clear();
    hydrated = true;
    allowLegacyImport = false;
    authoritativeIndexSeen = false;
    sessionId = marker.id;
    notify({ type: 'reset', reason, sessionId, generation });
    return true;
  }

  /**
   * Rotate the session id and drop all RAM data. Deliberately does not re-import
   * the previous session's legacy maps: logout/401 must not resurrect them.
   *
   * @param {{ persist?: boolean, reason?: string }} [options]
   * @returns {{ sessionId: string, generation: number, reason: string }}
   */
  function resetSession(options = {}) {
    const persist = options.persist !== false;
    const reason = typeof options.reason === 'string' ? options.reason : '';
    generation += 1;
    activity.clear();
    lastUsed.clear();
    hydrated = true;
    allowLegacyImport = false;
    authoritativeIndexSeen = false;
    sessionId = String(sessionIdFactory());
    if (persist) writeSessionMarker(reason);
    notify({ type: 'reset', reason, sessionId, generation });
    return { sessionId, generation, reason };
  }

  /**
   * Prune timestamps for chats that are known to be gone. Only an authoritative
   * full index may do this; a limited boot snapshot must not delete activity of
   * chats that simply have not been fetched yet.
   *
   * @param {Iterable<string> | string[]} knownIds
   * @param {{ authoritative?: boolean }} [options]
   * @returns {{ pruned: number, skipped: boolean, authoritative: boolean }}
   */
  function pruneToKnownIds(knownIds, options = {}) {
    if (options.authoritative !== true) {
      return { pruned: 0, skipped: true, authoritative: false };
    }
    hydrateLegacyOnce();
    const known = knownIds instanceof Set
      ? knownIds
      : new Set(knownIds == null ? [] : (Array.isArray(knownIds) ? knownIds : [...knownIds]));
    let pruned = 0;
    for (const id of [...activity.keys()]) {
      if (!known.has(id)) {
        activity.delete(id);
        pruned += 1;
      }
    }
    for (const id of [...lastUsed.keys()]) {
      if (!known.has(id)) {
        lastUsed.delete(id);
        pruned += 1;
      }
    }
    authoritativeIndexSeen = true;
    if (pruned > 0) {
      persistMaps();
      notify({ type: 'prune', pruned });
    }
    return { pruned, skipped: false, authoritative: true };
  }

  /**
   * Rotate the shared session, clear persisted maps, and publish a storage
   * invalidation so every tab (including this one) drops RAM. Stale wrapped
   * payloads from before the rotation cannot be re-applied.
   *
   * @param {string} [reason]
   * @returns {{ at: number, sessionId: string, reason: string, generation: number }}
   */
  function broadcastInvalidation(reason = '') {
    const reset = resetSession({
      reason: typeof reason === 'string' && reason.trim() ? reason.trim() : 'broadcast-invalidate',
      persist: true,
    });
    const marker = { at: now(), sessionId: reset.sessionId, reason: reset.reason, generation: reset.generation };
    try {
      persistMaps();
      adapter.write(CHAT_PERSISTENCE_INVALIDATION_KEY, JSON.stringify(marker));
    } catch (_) {
      /* best effort */
    }
    return marker;
  }

  /** @param {(event: object) => void} listener @returns {() => void} */
  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return {
    adapter,
    hydrateLegacyOnce,
    snapshotActivity,
    snapshotLastUsed,
    getActivityAt,
    getLastUsedAt,
    recordActivity,
    recordLastUsed,
    mergeActivity,
    mergeLastUsed,
    handleStorageEvent,
    resetSession,
    pruneToKnownIds,
    broadcastInvalidation,
    subscribe,
    /** @returns {{ sessionId: string, generation: number }} */
    getSession() {
      ensureSession();
      return { sessionId, generation };
    },
    /** Session scope without creating a new id (IDB scope wiring before prime). */
    peekSessionScope() {
      return { sessionId: sessionId || '', generation };
    },
    /** @returns {boolean} */
    hasAuthoritativeIndex() {
      return authoritativeIndexSeen;
    },
    /** @returns {boolean} */
    isHydrated() {
      return hydrated;
    },
  };
}

/** Optional sink installed by the 2.3 persistence queue (falls back to immediate writes). */
/** @type {(() => void) | null} */
let activityPersistenceSink = null;

/**
 * @param {(() => void) | null} sink
 */
export function setChatActivityPersistenceSink(sink) {
  activityPersistenceSink = typeof sink === 'function' ? sink : null;
}

/** @type {ReturnType<typeof createChatActivityStore> | null} */
let sharedStore = null;

/**
 * Shared RAM store used by `chatStore` and the app wiring. Storage is resolved
 * lazily so a test (or a late `globalThis.localStorage`) is picked up on use.
 *
 * @returns {ReturnType<typeof createChatActivityStore>}
 */
export function getChatActivityStore() {
  if (!sharedStore) sharedStore = createChatActivityStore();
  return sharedStore;
}

/**
 * Install the shared RAM store with an explicit persistence adapter (task 5.2 IDB wiring).
 *
 * @param {Parameters<typeof createChatActivityStore>[0]} [options]
 * @returns {ReturnType<typeof createChatActivityStore>}
 */
export function installChatActivityStore(options = {}) {
  sharedStore = createChatActivityStore(options);
  return sharedStore;
}

/**
 * Install the cross-tab `storage` listener. Called once at boot; harmless when
 * `target` has no addEventListener (node tests).
 *
 * @param {EventTarget | null | undefined} [target]
 * @returns {() => void}
 */
export function installChatActivityStorageListener(target = typeof window !== 'undefined' ? window : null) {
  if (!target || typeof target.addEventListener !== 'function') return () => {};
  const handler = (event) => {
    getChatActivityStore().handleStorageEvent(event);
  };
  target.addEventListener('storage', handler);
  return () => {
    if (typeof target.removeEventListener === 'function') target.removeEventListener('storage', handler);
  };
}

/** @param {{ persist?: boolean, reason?: string }} [options] */
export function resetChatActivitySession(options) {
  return getChatActivityStore().resetSession(options);
}

/** @param {Iterable<string> | string[]} knownIds @param {{ authoritative?: boolean }} [options] */
export function pruneChatActivityToKnownIds(knownIds, options) {
  return getChatActivityStore().pruneToKnownIds(knownIds, options);
}

/** @param {unknown} input @param {object} [scope] */
export function mergeChatActivity(input, scope) {
  return getChatActivityStore().mergeActivity(input, scope);
}

/** @param {unknown} input @param {object} [scope] */
export function mergeChatLastUsed(input, scope) {
  return getChatActivityStore().mergeLastUsed(input, scope);
}

/** @param {(event: object) => void} listener */
export function subscribeChatActivity(listener) {
  return getChatActivityStore().subscribe(listener);
}

/**
 * Test seam: replace/reset the singleton so a test can inject a counting adapter
 * or a fresh session.
 *
 * @param {ReturnType<typeof createChatActivityStore> | null} [store]
 */
export function __setChatActivityStoreForTest(store) {
  sharedStore = store || null;
}

export function __resetChatActivityStoreForTest() {
  sharedStore = null;
  activityPersistenceSink = null;
}
