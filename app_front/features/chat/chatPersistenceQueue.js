/**
 * Single debounced persistence queue for chat metadata (task 2.3).
 *
 * Coalesces durable changes (boot snapshot, activity/last-used maps) through the
 * shared persistence adapter from task 2.1. Revision/dirty is evaluated before
 * building a boot-cache snapshot so repeated renders and pending-only UI churn
 * never bump `cache.builds` or write storage.
 *
 * Session generation from the activity store gates every flush: logout/401 rotates
 * the session and invalidates the queue so a stale timer cannot resurrect cache.
 *
 * Stage 5.2: IndexedDB backend via `chat-metadata-idb` adapter — one queue, async
 * flush, merged dirty chat ids, bounded IDB batches, retry/backoff, IDB epoch guards.
 *
 * DOM-free for `node:test`.
 */

import {
  CHAT_ACTIVITY_STORAGE_KEY,
  CHAT_LAST_USED_STORAGE_KEY,
  serializeTimestampMap,
} from './chatPersistenceAdapter.js';
import {
  CHAT_LOCAL_BOOT_CACHE_KEY,
  clearChatLocalBootCache,
  resetChatLocalBootCacheRevision,
  writeChatLocalBootCacheToAdapter,
  writeChatLocalBootCacheToAdapterAsync,
  writeChatLocalBootSyncFromFullDoc,
} from './chatLocalBootCache.js';
import { clearChatLocalBootSync } from './chatLocalBootSync.js';
import { migrateLegacyLocalBootCacheToIdb } from './chatLocalBootLegacyMigration.js';
import {
  getChatMetadataIdbOperationEpoch,
} from './chatMetadataIdb.js';
import {
  isChatMetadataIdbPersistenceAdapter,
} from './chatPersistenceIdbAdapter.js';

/** Default coalesce window for durable writes (ms). */
export const CHAT_PERSISTENCE_QUEUE_DEBOUNCE_MS = 50;

/**
 * @typedef {object} ChatPersistenceQueueSession
 * @property {string} sessionId
 * @property {number} generation
 */

/**
 * @typedef {object} ChatPersistenceActivityDirtyDetail
 * @property {string[]} [activityIds]
 * @property {string[]} [lastUsedIds]
 */

/**
 * @typedef {object} ChatPersistenceQueueStats
 * @property {number} bootCacheBuilds
 * @property {number} bootCacheWrites
 * @property {number} activityFlushes
 * @property {number} flushRuns
 * @property {number} invalidatedFlushes
 */

/**
 * @param {{
 *   adapter: import('./chatPersistenceAdapter.js').ChatPersistenceAdapter,
 *   getSession: () => ChatPersistenceQueueSession,
 *   getBootCacheInput?: () => (Parameters<typeof writeChatLocalBootCacheToAdapter>[1] | null),
 *   getActivitySnapshots?: () => ({ activity: Record<string, number>, lastUsed: Record<string, number> }),
 *   getIdbEpoch?: () => number,
 *   debounceMs?: number,
 *   now?: () => number,
 *   schedule?: (fn: () => void, delayMs: number) => unknown,
 *   cancelSchedule?: (handle: unknown) => void,
 *   onDurableFlush?: (detail: {
 *     sessionId: string,
 *     generation: number,
 *     idbEpoch: number,
 *     revision: string,
 *     activityIds: string[],
 *     lastUsedIds: string[],
 *   }) => void,
 * }} options
 */
export function createChatPersistenceQueue(options) {
  const adapter = options.adapter;
  const getSession = options.getSession;
  const getBootCacheInput = typeof options.getBootCacheInput === 'function'
    ? options.getBootCacheInput
    : () => null;
  const getActivitySnapshots = typeof options.getActivitySnapshots === 'function'
    ? options.getActivitySnapshots
    : () => ({ activity: {}, lastUsed: {} });
  const getIdbEpoch = typeof options.getIdbEpoch === 'function'
    ? options.getIdbEpoch
    : () => getChatMetadataIdbOperationEpoch();
  const debounceMs = Number.isFinite(Number(options.debounceMs))
    ? Math.max(0, Number(options.debounceMs))
    : CHAT_PERSISTENCE_QUEUE_DEBOUNCE_MS;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const schedule = options.schedule
    || ((fn, delay) => setTimeout(fn, delay));
  const cancelSchedule = options.cancelSchedule
    || ((handle) => clearTimeout(/** @type {ReturnType<typeof setTimeout>} */ (handle)));
  const onDurableFlush = typeof options.onDurableFlush === 'function' ? options.onDurableFlush : null;

  /** @type {{ lastSignature: string }} */
  const bootRevision = { lastSignature: '' };
  let bootDirty = false;
  /** @type {Set<string>} */
  const dirtyActivityIds = new Set();
  /** @type {Set<string>} */
  const dirtyLastUsedIds = new Set();
  /** @type {({ sessionId: string, generation: number, epoch: number, idbEpoch: number }) | null} */
  let scheduledScope = null;
  /** @type {unknown} */
  let timerHandle = null;
  let queueEpoch = 0;
  let pendingTransactions = 0;
  /** @type {Promise<void>} */
  let flushChain = Promise.resolve();
  /** @type {ChatPersistenceQueueStats} */
  const stats = {
    bootCacheBuilds: 0,
    bootCacheWrites: 0,
    activityFlushes: 0,
    flushRuns: 0,
    invalidatedFlushes: 0,
  };

  function cancelTimer() {
    if (timerHandle == null) return;
    cancelSchedule(timerHandle);
    timerHandle = null;
  }

  function isScopeCurrent(scope) {
    if (!scope) return false;
    const current = getSession();
    return scope.sessionId === current.sessionId && scope.generation === current.generation;
  }

  function isEpochCurrent(scope) {
    if (!scope) return false;
    if (queueEpoch !== scope.epoch) return false;
    if (scope.idbEpoch !== getIdbEpoch()) return false;
    return true;
  }

  /**
   * @param {ChatPersistenceActivityDirtyDetail | void} detail
   */
  function mergeActivityDirty(detail) {
    const activityIds = Array.isArray(detail?.activityIds) ? detail.activityIds : [];
    const lastUsedIds = Array.isArray(detail?.lastUsedIds) ? detail.lastUsedIds : [];
    if (activityIds.length === 0 && lastUsedIds.length === 0) {
      dirtyActivityIds.add('__full__');
      dirtyLastUsedIds.add('__full__');
      return;
    }
    for (const id of activityIds) {
      const chatId = typeof id === 'string' ? id.trim() : '';
      if (chatId) dirtyActivityIds.add(chatId);
    }
    for (const id of lastUsedIds) {
      const chatId = typeof id === 'string' ? id.trim() : '';
      if (chatId) dirtyLastUsedIds.add(chatId);
    }
  }

  function resolveDirtyIdList(set, snapshots) {
    if (set.has('__full__')) return Object.keys(snapshots);
    return [...set];
  }

  /**
   * @param {{ sessionId: string, generation: number, epoch: number, idbEpoch: number }} scope
   * @returns {Promise<{ ok: boolean, reason: string }>}
   */
  async function runFlush(scope) {
    stats.flushRuns += 1;
    if (!isEpochCurrent(scope)) {
      stats.invalidatedFlushes += 1;
      dirtyActivityIds.clear();
      dirtyLastUsedIds.clear();
      return { ok: false, reason: 'invalidated' };
    }
    if (!isScopeCurrent(scope)) {
      stats.invalidatedFlushes += 1;
      bootDirty = false;
      dirtyActivityIds.clear();
      dirtyLastUsedIds.clear();
      return { ok: false, reason: 'stale-session' };
    }
    const shouldWriteBoot = bootDirty;
    const activityIds = resolveDirtyIdList(dirtyActivityIds, getActivitySnapshots().activity);
    const lastUsedIds = resolveDirtyIdList(dirtyLastUsedIds, getActivitySnapshots().lastUsed);
    const shouldWriteActivity = activityIds.length > 0 || lastUsedIds.length > 0;
    let flushRevision = bootRevision.lastSignature;
    bootDirty = false;
    dirtyActivityIds.clear();
    dirtyLastUsedIds.clear();
    if (!shouldWriteBoot && !shouldWriteActivity) {
      return { ok: true, reason: '' };
    }
    pendingTransactions += 1;
    try {
      if (shouldWriteBoot) {
        const input = getBootCacheInput();
        if (input) {
          const result = await writeChatLocalBootCacheToAdapterAsync(adapter, input, bootRevision, {
            isApplyFresh: () => isEpochCurrent(scope) && isScopeCurrent(scope),
            canPersist: () => isEpochCurrent(scope) && isScopeCurrent(scope),
          });
          if (result.built) stats.bootCacheBuilds += 1;
          if (result.cancelled || !isEpochCurrent(scope) || !isScopeCurrent(scope)) {
            stats.invalidatedFlushes += 1;
            bootDirty = true;
            return { ok: false, reason: 'invalidated' };
          }
          if (result.built && result.signature) {
            flushRevision = result.signature;
            const storage = typeof localStorage !== 'undefined' ? localStorage : null;
            if (result.doc && storage) {
              writeChatLocalBootSyncFromFullDoc(storage, result.doc, result.signature);
            }
            const payload = adapter.read(CHAT_LOCAL_BOOT_CACHE_KEY);
            if (payload && isChatMetadataIdbPersistenceAdapter(adapter)) {
              const written = await adapter.persistKv(
                CHAT_LOCAL_BOOT_CACHE_KEY,
                payload,
                { epoch: scope.idbEpoch, queueEpoch: scope.epoch }
              );
              if (written) {
                stats.bootCacheWrites += 1;
                if (storage) {
                  await migrateLegacyLocalBootCacheToIdb({
                    storage,
                    adapter,
                    getIdbEpoch: () => scope.idbEpoch,
                  });
                }
              } else if (isEpochCurrent(scope) && isScopeCurrent(scope)) {
                bootDirty = true;
                return { ok: false, reason: 'idb-boot-failed' };
              }
            } else if (result.written) {
              stats.bootCacheWrites += 1;
            }
          }
        }
      }
      if (shouldWriteActivity) {
        if (!isEpochCurrent(scope) || !isScopeCurrent(scope)) {
          stats.invalidatedFlushes += 1;
          mergeActivityDirty({ activityIds, lastUsedIds });
          return { ok: false, reason: 'invalidated' };
        }
        const snapshots = getActivitySnapshots();
        const { sessionId, generation } = getSession();
        void sessionId;
        void generation;
        void now;
        if (isChatMetadataIdbPersistenceAdapter(adapter)) {
          const deltaResult = await adapter.persistActivityDeltas({
            activity: snapshots.activity,
            lastUsed: snapshots.lastUsed,
            activityIds,
            lastUsedIds,
            epoch: scope.idbEpoch,
            queueEpoch: scope.epoch,
          });
          if (deltaResult.ok) {
            stats.activityFlushes += 1;
          } else if (isEpochCurrent(scope) && isScopeCurrent(scope)) {
            mergeActivityDirty({
              activityIds: deltaResult.failedActivityIds,
              lastUsedIds: deltaResult.failedLastUsedIds,
            });
            return { ok: false, reason: 'idb-activity-failed' };
          }
        } else {
          const meta = { sessionId: getSession().sessionId, generation: getSession().generation, updatedAt: now() };
          adapter.write(
            CHAT_ACTIVITY_STORAGE_KEY,
            serializeTimestampMap(snapshots.activity, meta)
          );
          adapter.write(
            CHAT_LAST_USED_STORAGE_KEY,
            serializeTimestampMap(snapshots.lastUsed, meta)
          );
          stats.activityFlushes += 1;
        }
      }
      if (onDurableFlush && isEpochCurrent(scope) && isScopeCurrent(scope)) {
        onDurableFlush({
          sessionId: scope.sessionId,
          generation: scope.generation,
          idbEpoch: scope.idbEpoch,
          revision: flushRevision || '',
          activityIds: shouldWriteActivity ? activityIds : [],
          lastUsedIds: shouldWriteActivity ? lastUsedIds : [],
        });
      }
      return { ok: true, reason: '' };
    } finally {
      pendingTransactions = Math.max(0, pendingTransactions - 1);
    }
  }

  function flushNow() {
    cancelTimer();
    const scope = scheduledScope ?? {
      ...getSession(),
      epoch: queueEpoch,
      idbEpoch: getIdbEpoch(),
    };
    scheduledScope = null;
    flushChain = flushChain.then(() => runFlush(scope)).catch(() => ({ ok: false, reason: 'flush-error' }));
    return flushChain;
  }

  function armTimer() {
    if (timerHandle != null) return;
    const session = getSession();
    scheduledScope = {
      sessionId: session.sessionId,
      generation: session.generation,
      epoch: queueEpoch,
      idbEpoch: getIdbEpoch(),
    };
    if (debounceMs <= 0) {
      void flushNow();
      return;
    }
    timerHandle = schedule(() => {
      timerHandle = null;
      void flushNow();
    }, debounceMs);
  }

  function markBootCacheDirty() {
    bootDirty = true;
    armTimer();
  }

  /**
   * @param {ChatPersistenceActivityDirtyDetail | void} [detail]
   */
  function markActivityDirty(detail) {
    mergeActivityDirty(detail);
    armTimer();
  }

  /**
   * @param {{ clearBootRevision?: boolean, clearStoredBootCache?: boolean, storage?: Storage | null }} [options]
   */
  function invalidate(options = {}) {
    queueEpoch += 1;
    cancelTimer();
    scheduledScope = null;
    bootDirty = false;
    dirtyActivityIds.clear();
    dirtyLastUsedIds.clear();
    if (options.clearBootRevision !== false) {
      bootRevision.lastSignature = '';
    }
    if (options.clearStoredBootCache === true && options.storage) {
      clearChatLocalBootCache(options.storage);
      clearChatLocalBootSync(options.storage);
      resetChatLocalBootCacheRevision(options.storage);
    }
  }

  return {
    markBootCacheDirty,
    markActivityDirty,
    flushNow,
    invalidate,
    getStats: () => ({ ...stats }),
    getBootRevision: () => bootRevision.lastSignature,
    getPendingTransactionCount: () => pendingTransactions,
    /** @param {EventTarget | null | undefined} [target] @param {Window | null | undefined} [win] */
    installLifecycleFlushHooks(target, win) {
      const doc = target || (typeof document !== 'undefined' ? document : null);
      const windowRef = win || (typeof window !== 'undefined' ? window : null);
      if (doc && typeof doc.addEventListener === 'function') {
        doc.addEventListener('visibilitychange', () => {
          if (doc.hidden === true) void flushNow();
        });
      }
      if (windowRef && typeof windowRef.addEventListener === 'function') {
        windowRef.addEventListener('pagehide', () => void flushNow());
      }
    },
  };
}

/** @type {ReturnType<typeof createChatPersistenceQueue> | null} */
let sharedQueue = null;

/**
 * @param {Parameters<typeof createChatPersistenceQueue>[0]} options
 * @returns {ReturnType<typeof createChatPersistenceQueue>}
 */
export function installChatPersistenceQueue(options) {
  sharedQueue = createChatPersistenceQueue(options);
  return sharedQueue;
}

/** @returns {ReturnType<typeof createChatPersistenceQueue> | null} */
export function getChatPersistenceQueue() {
  return sharedQueue;
}

/**
 * @param {{ clearBootRevision?: boolean, clearStoredBootCache?: boolean, storage?: Storage | null }} [options]
 */
export function invalidateChatPersistenceQueue(options) {
  sharedQueue?.invalidate(options);
}

/** @param {ReturnType<typeof createChatPersistenceQueue> | null} [queue] */
export function __setChatPersistenceQueueForTest(queue) {
  sharedQueue = queue || null;
}

export function __resetChatPersistenceQueueForTest() {
  sharedQueue = null;
}
