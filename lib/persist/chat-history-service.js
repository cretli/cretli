/**
 * Process-wide async chat-history service (stage 2b).
 *
 * Every production history read/write goes through the functions exported here
 * (same names as the legacy `chat-history-persist.js`, but every one returns a
 * Promise). They delegate to ONE adapter that is either
 *   - opened explicitly at startup by `openChatHistoryService()` from the
 *     reviewed runtime (`chat-history-runtime.js`, marker-selected backend), or
 *   - the legacy-file adapter, but ONLY when the control marker says `legacy`
 *     (a missing marker with no cutover trace is legacy; a marker that selects
 *     another backend, an invalid marker or a cutover trace makes every call
 *     refuse until the runtime was opened: fail closed, no legacy bypass).
 *
 * Nothing here migrates data or switches a backend; the marker owner does.
 * Durable-commit notifications (revision bump, push, websocket broadcast) for
 * the SQLite backend run from `onCommitted`, i.e. strictly AFTER the commit
 * receipt; the legacy backend keeps its historical in-call ordering.
 */
import path from 'node:path';
import { resolveDataPath } from '../runtime-paths.js';
import { broadcastChatHistoryUpdate } from '../sdk/sdk-history-updates.ts';
import { createChatHistoryAdapter } from './chat-history-adapter.js';
import { readHistoryBackendMarker } from './chat-history-backend-marker.js';
import { refuseHistory } from './chat-history-errors.js';
import { bumpChatHistoryRevision, clearChatHistoryRevision } from './chat-history-revisions.js';
import { notifyChatHistoryUpdated } from './chat-history-notify.js';
import { summarizeChatHistoryUsage } from './chat-history-usage.js';

export {
  HISTORY_BATCH_MAX_CHATS,
  HISTORY_PULL_DEFAULT_LIMIT,
  HISTORY_PULL_MAX_LIMIT,
  HISTORY_TAIL_DEFAULT_LIMIT,
  MAX_HISTORY_EVENTS,
} from './chat-history-adapter.js';
export { summarizeChatHistoryUsage };

/**
 * Default locations, identical for every backend (a legacy process computes the
 * same directories the sqlite runtime later uses, so a marker/trace check always
 * looks in the right place).
 *
 * @param {string} [dataDir]
 * @returns {{ controlDir: string, dbDir: string, pendingDir: string }}
 */
export function resolveChatHistoryPaths(dataDir = resolveDataPath()) {
  const base = path.resolve(dataDir);
  return {
    controlDir: path.join(base, 'storage-control'),
    dbDir: path.join(base, 'storage'),
    pendingDir: path.join(base, 'storage-pending'),
  };
}

/** @type {{ adapter: ReturnType<typeof createChatHistoryAdapter>, runtime: { close: () => Promise<void> } | null } | null} */
let current = null;
/** @type {Promise<unknown> | null} */
let opening = null;
/**
 * Post-commit hook of the SQLite backend. A notification failure never turns an
 * acknowledged write into an error (the backend isolates it as well).
 *
 * @param {Record<string, any>} event
 */
async function onHistoryCommitted(event) {
  const chatId = String(event?.chatId || '');
  if (!chatId) return;
  if (event.operation === 'delete') {
    clearChatHistoryRevision(chatId);
    return;
  }
  if (event.operation === 'copy') {
    bumpChatHistoryRevision(chatId, Number(event.headSeq) || 0);
    return;
  }
  if (event.operation === 'append' && Array.isArray(event.appended) && event.appended.length > 0) {
    bumpChatHistoryRevision(chatId, Number(event.headSeq) || 0);
    void notifyChatHistoryUpdated(chatId, Number(event.headSeq) || 0);
  }
}

/** @param {{ release?: () => unknown } | null} coordinator */
async function releaseCoordinator(coordinator) {
  try {
    await coordinator?.release?.();
  } catch {
    // A lease that cannot be released simply expires; closing the backend must not fail because of it.
  }
}

/**
 * Open the runtime selected by the control marker and install it as THE adapter. One backend per process: a
 * second open while one is installed is refused. With `legacy` nothing is created on disk (no coordinator, no
 * store); with `sqlite` the storage coordinator lease is acquired first (a failure leaves NO adapter), the store
 * must already exist and be bound to the marker's generation (see chat-history-runtime.js); `rollback-readonly`
 * serves the verified export read-only and refuses every write.
 *
 * @param {{
 *   dataDir?: string,
 *   openRuntime?: Function,
 *   createCoordinator?: Function,
 *   runtimeOptions?: Record<string, unknown>,
 * }} [options]
 * @returns {Promise<{ backendKind: string, recovery?: Record<string, any> }>}
 */
export async function openChatHistoryService(options = {}) {
  if (opening) await opening.catch(() => {});
  if (current) refuseHistory('history_backend_transition_refused', 'The history service is already open in this process', { backendKind: current.adapter.backendKind });
  const paths = resolveChatHistoryPaths(options.dataDir);
  opening = (async () => {
    const marker = readHistoryBackendMarker(paths.controlDir, { traceDirs: { dbDir: paths.dbDir, pendingDir: paths.pendingDir } });
    let coordinator = null;
    if (marker.backend === 'sqlite') {
      const create = options.createCoordinator || (await import('../storage/coordinator.js')).createStorageCoordinator;
      coordinator = create({ controlDir: paths.controlDir });
      await coordinator.acquire();
    }
    try {
      const open = options.openRuntime || (await import('./chat-history-runtime.js')).openChatHistoryRuntime;
      const runtime = /** @type {any} */ (await open({ ...paths, ...(coordinator ? { coordinator } : {}), onCommitted: onHistoryCommitted, ...options.runtimeOptions }));
      return { runtime, coordinator };
    } catch (error) {
      await releaseCoordinator(coordinator);
      throw error;
    }
  })();
  try {
    const { runtime, coordinator } = /** @type {any} */ (await opening);
    const close = async () => {
      await runtime.close();
      await releaseCoordinator(coordinator);
    };
    current = { adapter: runtime.adapter, runtime: { close } };
    return { backendKind: runtime.backendKind, recovery: runtime.recovery };
  } finally {
    opening = null;
  }
}

/** Close the installed runtime (server shutdown). Safe when nothing is open. */
export async function closeChatHistoryService() {
  const installed = current;
  current = null;
  await installed?.runtime?.close();
}

/**
 * Test seam: install a ready adapter (e.g. over a synthetic store). Production
 * code uses `openChatHistoryService`.
 *
 * @param {ReturnType<typeof createChatHistoryAdapter> | null} adapter
 */
export function setChatHistoryAdapterForTests(adapter) {
  current = adapter ? { adapter, runtime: null } : null;
}

/**
 * The adapter every caller uses. Without an opened runtime the legacy adapter is
 * returned only if the marker (plus cutover trace check) still says legacy.
 *
 * @returns {Promise<ReturnType<typeof createChatHistoryAdapter>>}
 */
export async function getChatHistoryAdapter() {
  if (current) return current.adapter;
  if (opening) await opening.catch(() => {});
  if (current) return current.adapter;
  const paths = resolveChatHistoryPaths();
  const marker = readHistoryBackendMarker(paths.controlDir, { traceDirs: { dbDir: paths.dbDir, pendingDir: paths.pendingDir } });
  if (marker.backend !== 'legacy') {
    refuseHistory('history_backend_mismatch', 'The marker selects another history backend; open the history service at startup before serving', { selected: marker.backend });
  }
  const { createDefaultLegacyHistoryAdapter } = await import('./chat-history-backend-legacy.js');
  if (!current) current = { adapter: createDefaultLegacyHistoryAdapter(), runtime: null };
  return current.adapter;
}

/** @returns {string} 'legacy' | 'sqlite' | 'rollback-readonly' | 'unopened' (diagnostics only) */
export function getChatHistoryBackendKind() {
  return current ? current.adapter.backendKind : 'unopened';
}

/**
 * Legacy-compatible async API. Every function is `await adapter.x(...)`, so a
 * caller can never receive a pending promise as if it were the result.
 */
export async function loadChatHistory(chatId, options) { return (await getChatHistoryAdapter()).loadChatHistory(chatId, options); }

export async function appendChatHistoryEvents(chatId, cursorSessionId, items, callOptions) {
  return (await getChatHistoryAdapter()).appendChatHistoryEvents(chatId, cursorSessionId, items, callOptions);
}

/** Watcher notice: the websocket broadcast follows the durable commit (the legacy backend broadcasts itself). */
export async function appendChatNotice(chatId, text, meta = {}) {
  const adapter = await getChatHistoryAdapter();
  const result = await adapter.appendChatNotice(chatId, text, meta);
  if (adapter.backendKind !== 'legacy' && result?.ok && Array.isArray(result.appended) && result.appended.length > 0) {
    broadcastChatHistoryUpdate(chatId, result.appended, result.identity);
  }
  return result;
}

export async function getChatHistorySince(chatId, since, limit) { return (await getChatHistoryAdapter()).getChatHistorySince(chatId, since, limit); }
export async function readChatHistoryFromHttpQuery(chatId, query) { return (await getChatHistoryAdapter()).readChatHistoryFromHttpQuery(chatId, query); }
export async function readChatHistoryBatch(requests, allowedIds) { return (await getChatHistoryAdapter()).readChatHistoryBatch(requests, allowedIds); }
export async function getChatHistoryEvent(chatId, seq) { return (await getChatHistoryAdapter()).getChatHistoryEvent(chatId, seq); }
export async function getChatHistoryPage(chatId, options) { return (await getChatHistoryAdapter()).getChatHistoryPage(chatId, options); }
export async function copyChatHistory(source, target, cursor, callOptions) {
  return (await getChatHistoryAdapter()).copyChatHistory(source, target, cursor, callOptions);
}
export async function copyChatHistoryUntil(source, target, cursor, upTo, callOptions) {
  return (await getChatHistoryAdapter()).copyChatHistoryUntil(source, target, cursor, upTo, callOptions);
}
export async function deleteChatHistory(chatId, callOptions) {
  return (await getChatHistoryAdapter()).deleteChatHistory(chatId, callOptions);
}
export async function listChatHistoryHeadSeqs() { return (await getChatHistoryAdapter()).listChatHistoryHeadSeqs(); }
export async function getChatHistoryUsage(chatId) { return (await getChatHistoryAdapter()).getChatHistoryUsage(chatId); }
