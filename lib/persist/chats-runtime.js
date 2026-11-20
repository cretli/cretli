/**
 * Runtime of the chats facade: the async API over one backend adapter, the active-runtime holder, and the
 * marker-driven factory (`openChatsRuntime`).
 *
 * Mixed phase (ADR docs/storage-chats-metadata-decision.md, B1-B4):
 * - the global runtime is the legacy adapter. `openChatsRuntime` can select SQLite ONLY when the code constant
 *   `CHATS_SQLITE_RUNTIME_ENABLED` is on; B5 flips it after the sync API is gone. A sqlite marker with the gate off
 *   is the explicit error `chats_sqlite_not_enabled`, never a fallback to JSON.
 * - adapters and converted callers are tested through an injected, isolated runtime (`createChatsRuntime({ backend })`),
 *   never through the global marker.
 * - the sync API of `chats-persist.js` throws `chats_sync_api_unavailable` while the active runtime is not legacy.
 *
 * The facade never blocks the event loop on a worker (no `Atomics.wait`) and never holds a lock across an `await`:
 * every adapter write is a version-checked command, not a held lock.
 */
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { ChatsBackendError, assertChatsStoreFile, chatsSqliteDir, readChatsBackendMarker } from './chats-backend-marker.js';
import { conversationForkArgs, temporaryForkTitle } from './chats-backend-domain.js';
import { CHATS_BACKEND_OPERATIONS } from './chats-backend-legacy.js';
import { deleteChatHistory } from './chat-history-service.js';
import { discardBufferedHistory, settleHistoryFlushes } from './history-room-flusher.js';
import { deleteChatTitleHistory } from './chat-title-history-persist.js';
import { deleteContextSendManifests } from './context-send-manifests-persist.js';
import { removeBrowserScreenshots } from '../browser/screenshot-file.js';
import { removeChatMedia } from '../chat-media.js';
import { broadcastChatListChanged } from '../chat-list-updates.js';
import { noteChatRowsForScoutIndex } from '../scout-chat-registry.js';
import { getOperatorIndexGeneration, noteChatRowsForOperatorIndex } from '../operator/operator-run-chat-registry.js';

/** Feeds both synchronous read-only indexes (Scout and operator runs) with every row the facade hands out. */
const seen = (value) => noteChatRowsForOperatorIndex(noteChatRowsForScoutIndex(value));

/**
 * The chat catalog re-reads every page (50k chats = 100 pages) on each list request. The operator
 * index records every normal chat too, so re-indexing identical pages cost ~8 ms per list page at
 * 50k chats. A page whose store revision, query and index generation were already indexed carries
 * the same rows and is skipped; any write changes the revision and clears the memo.
 */
let indexedPages = { revision: '', generation: -1, keys: new Set() };

/**
 * @param {Record<string, any>} query
 * @param {Record<string, any> | null | undefined} result
 */
function seenPage(query, result) {
  const revision = String(result?.revision ?? result?.storeRevision ?? '');
  const generation = getOperatorIndexGeneration();
  if (!revision) return seen(result?.chats);
  if (indexedPages.revision !== revision || indexedPages.generation !== generation) {
    indexedPages = { revision, generation, keys: new Set() };
  }
  // The whole query is the key: two different queries must never share a memo entry.
  const key = JSON.stringify(query ?? {});
  if (indexedPages.keys.has(key)) return noteChatRowsForScoutIndex(result?.chats);
  indexedPages.keys.add(key);
  return seen(result?.chats);
}

/**
 * Global switch of the SQLite runtime. A constant in code, OFF by default; only B5 (after the sync API is removed)
 * turns it on. Tests reach a sqlite runtime through the explicit test hook below, never by editing this value.
 */
export const CHATS_SQLITE_RUNTIME_ENABLED = false;

/** Key of the test-only options object that overrides the gate for one `openChatsRuntime` call. */
export const CHATS_RUNTIME_TEST_HOOK = Symbol.for('cretli.chats.runtime.testHook');

/** Worker handler registry of the chats store. */
export const CHATS_HANDLERS_PATH = fileURLToPath(new URL('../storage/chats-store.js', import.meta.url));

/** Cleanup steps of a full chat delete; injectable so an isolated runtime test does not touch real files. */
const defaultDeleteDeps = Object.freeze({
  settleHistoryFlushes,
  deleteChatHistory,
  discardBufferedHistory,
  deleteChatTitleHistory,
  deleteContextSendManifests,
  removeBrowserScreenshots,
  removeChatMedia,
  broadcast: broadcastChatListChanged,
});

/** Facade operation -> backend session field, for the server-owned session-id setters. */
const SESSION_SETTERS = Object.freeze({
  setChatSdkAgentIdAsync: 'sdkAgentId',
  setChatOpenCodeSessionIdAsync: 'opencodeSessionId',
  setChatCodeBuddySessionIdAsync: 'codebuddySessionId',
  setChatDeepSeekSessionIdAsync: 'deepseekSessionId',
  setChatCodexThreadIdAsync: 'codexThreadId',
  setChatQwenSessionIdAsync: 'qwenSessionId',
  setChatClaudeSessionIdAsync: 'claudeSessionId',
});

/**
 * The complete async API (the sync export name + `Async`) over one adapter.
 *
 * @param {Record<string, (...args: any[]) => Promise<any>>} backend
 * @param {Partial<typeof defaultDeleteDeps>} [deps]
 */
export function createChatsFacade(backend, deps = {}) {
  for (const name of CHATS_BACKEND_OPERATIONS) {
    if (typeof backend?.[name] !== 'function') throw new TypeError(`Chats backend is missing ${name}`);
  }
  const d = { ...defaultDeleteDeps, ...deps };
  const api = {
    // Rows handed out here feed the synchronous Scout read-only index (lib/scout-chat-registry.js).
    loadChatsAsync: async () => seen(await backend.loadChats()),
    loadChatsSnapshotAsync: async () => { const snapshot = await backend.loadChatsSnapshot(); seen(snapshot?.chats); return snapshot; },
    readChatsStrictAsync: async () => backend.readChatsStrict(),
    peekChatsSnapshotAsync: async () => { const snapshot = await backend.peekChatsSnapshot(); seen(snapshot?.chats); return snapshot; },
    pageChatsAsync: async (query) => { const result = await backend.pageChats(query); seenPage(query, result); return result; },
    chatCountsAsync: (query) => backend.chatCounts(query),
    peekChatsAsync: async () => seen(await backend.peekChats()),
    peekChatsByIdsAsync: async (ids) => seen(await backend.peekChatsByIds(ids)),
    getChatByIdAsync: async (id) => seen(await backend.getChatById(id)),
    getChatByCursorSessionIdAsync: async (cursorSessionId) => seen(await backend.getChatByCursorSessionId(cursorSessionId)),
    saveChatsAsync: async (chats) => { const result = await backend.saveChats(chats); seen(chats); return result; },
    addChatAsync: async (...args) => seen(await backend.addChat(...args)),
    createConversationForkChatAsync: async (parentChat, overrides = null) => seen(await backend.addChat(...conversationForkArgs(parentChat, overrides))),
    createTemporaryForkChatAsync: async (parentChatId, forkKind, workspaceFile, workspaceFolder, model) => {
      await backend.deleteTemporaryForkChats(parentChatId, forkKind);
      return backend.addChat(randomUUID(), temporaryForkTitle(forkKind), workspaceFile, workspaceFolder, model || undefined, {
        isTemporary: true, forkParentChatId: parentChatId, forkKind, sdkMode: 'agent',
      });
    },
    deleteTemporaryForkChatsAsync: (parentChatId, forkKind) => backend.deleteTemporaryForkChats(parentChatId, forkKind),
    removeChatAsync: (id) => backend.removeChat(id),
    /**
     * Full chat removal. The durable history delete runs FIRST: when it fails the list entry and the other metadata
     * are untouched, so the caller can retry with the same `retryToken`. Afterwards the removals are idempotent.
     */
    deleteChatAsync: async (id, options = {}) => {
      await d.settleHistoryFlushes(id);
      await d.deleteChatHistory(id, options.retryToken === undefined ? undefined : { retryToken: options.retryToken });
      d.discardBufferedHistory(id);
      await backend.removeChat(id);
      d.deleteChatTitleHistory(id);
      d.deleteContextSendManifests(id);
      d.removeBrowserScreenshots(id);
      d.removeChatMedia(id);
      d.broadcast({ reason: 'delete', chatId: id });
    },
    updateChatAsync: (id, updates) => backend.updateChat(id, updates),
    /**
     * Archives chats in order, stopping at the first failure. One write when the backend has a batch path,
     * otherwise one `updateChat` per id.
     */
    archiveChatsAsync: async (ids) => {
      if (typeof backend.archiveChats === 'function') return backend.archiveChats(ids);
      const archived = [];
      for (const id of ids) {
        try {
          if (!await backend.updateChat(id, { archived: true })) return { archived, failed: true };
          archived.push(id);
        } catch {
          return { archived, failed: true };
        }
      }
      return { archived, failed: false };
    },
    markChatReadStateAsync: (id, marks = {}) => backend.markChatReadState(id, marks),
    applyAutoTitleAsync: (id, title, options = {}) => backend.applyAutoTitle(id, title, options),
    setChatTitleLockedAsync: (id, locked) => backend.setChatTitleLocked(id, locked),
    rotateChatSdkSessionAsync: (id) => backend.rotateChatSdkSession(id),
    migrateChatWorkspaceIdsAsync: (settings, options = {}) => backend.migrateChatWorkspaceIds(settings, options),
    importChatsBatchAsync: async (entries) => {
      const result = await backend.importChatsBatch(entries);
      if (result.added > 0) {
        // Read-only filter: the zero-copy snapshot avoids copying every row just to pick the imported ones.
        const snapshot = await backend.peekChatsSnapshot();
        const importedIds = new Set(result.addedIds || []);
        const importedRows = snapshot.chats.filter((chat) => importedIds.has(String(chat.id)));
        seen(importedRows);
        for (const entry of importedRows) broadcastChatListChanged({ reason: 'import', chatId: String(entry.id) });
      }
      return result;
    },
    rollbackImportedChatsAsync: (ids) => backend.rollbackImportedChats(ids),
  };
  for (const [name, field] of Object.entries(SESSION_SETTERS)) {
    api[name] = (id, value) => backend.setChatSessionField(id, field, value);
  }
  return Object.freeze(api);
}

/**
 * @typedef {{
 *   backend: Record<string, (...args: any[]) => Promise<any>>,
 *   backendKind: 'legacy' | 'sqlite',
 *   api: ReturnType<typeof createChatsFacade>,
 *   close: () => Promise<void>,
 * }} ChatsRuntime
 */

/**
 * Wraps an adapter into a runtime. This is the isolated-runtime entry point of the tests: it reads no marker and
 * touches no global state.
 *
 * @param {{ backend: Record<string, any>, backendKind?: 'legacy' | 'sqlite', deps?: Partial<typeof defaultDeleteDeps>, close?: () => Promise<void> }} options
 * @returns {ChatsRuntime}
 */
export function createChatsRuntime(options) {
  const backend = options.backend;
  return Object.freeze({
    backend,
    backendKind: options.backendKind ?? 'legacy',
    api: createChatsFacade(backend, options.deps),
    close: options.close ?? (async () => {}),
  });
}

/** @type {ChatsRuntime | null} */
let activeRuntime = null;
/** @type {(() => ChatsRuntime) | null} */
let defaultFactory = null;

/**
 * The runtime the `*Async` exports of `chats-persist.js` use. Defaults to the legacy adapter.
 *
 * @returns {ChatsRuntime}
 */
export function getActiveChatsRuntime() {
  if (!activeRuntime) {
    if (!defaultFactory) throw new ChatsBackendError('chats_runtime_unavailable', 'The chats runtime is not initialised yet');
    activeRuntime = defaultFactory();
  }
  return activeRuntime;
}

/** Called once by `chats-persist.js` to register the legacy runtime as the default. */
getActiveChatsRuntime.installDefault = (/** @type {() => ChatsRuntime} */ factory) => {
  defaultFactory = factory;
};

/**
 * Replace the global runtime (server start after `openChatsRuntime`, or a test). Returns the previous one.
 *
 * @param {ChatsRuntime | null} runtime null restores the legacy default
 * @returns {ChatsRuntime | null}
 */
export function setActiveChatsRuntime(runtime) {
  const previous = activeRuntime;
  activeRuntime = runtime;
  return previous;
}

/** Guard of the synchronous API: only the legacy runtime has one. */
export function assertSyncChatsApi() {
  if (activeRuntime && activeRuntime.backendKind !== 'legacy') {
    throw new ChatsBackendError(
      'chats_sync_api_unavailable',
      'The synchronous chats API is unavailable on the sqlite runtime; use the *Async functions',
    );
  }
}

/**
 * Start EXACTLY the backend the `chats-backend.json` marker selects. It never creates a store and never migrates:
 *
 *   no marker           -> legacy JSON
 *   marker sqlite       -> only when the gate is on; the store file must already exist (the worker starts with
 *                          `create: false`) and be bound to the marker's generation. Any failure leaves NO runtime.
 *   marker legacy-rollback -> refused (`chats_backend_unsupported`) until leaf C implements the rollback runtime.
 *
 * @param {{
 *   dataDir: string,
 *   controlDir?: string,
 *   writeGate?: unknown,
 *   coordinator?: Record<string, any>,
 *   hostOptions?: Record<string, unknown>,
 *   handlersPath?: string,
 *   deps?: Partial<typeof defaultDeleteDeps>,
 *   [CHATS_RUNTIME_TEST_HOOK]?: { sqliteEnabled?: boolean },
 * }} options
 * @returns {Promise<ChatsRuntime & { marker: Record<string, any> }>}
 */
export async function openChatsRuntime(options) {
  const marker = readChatsBackendMarker(options.dataDir);
  if (marker.backend === 'legacy') {
    const { legacyChatsBackend } = await import('./chats-persist.js');
    return { ...createChatsRuntime({ backend: legacyChatsBackend, backendKind: 'legacy', deps: options.deps }), marker };
  }
  if (marker.backend === 'legacy-rollback') {
    throw new ChatsBackendError('chats_backend_unsupported', 'The legacy-rollback chats backend is not available before the rollback leaf', { backend: marker.backend });
  }
  const enabled = options[CHATS_RUNTIME_TEST_HOOK]?.sqliteEnabled ?? CHATS_SQLITE_RUNTIME_ENABLED;
  if (enabled !== true) {
    throw new ChatsBackendError('chats_sqlite_not_enabled', 'The chats marker selects sqlite but the sqlite runtime is not enabled in this build; it is never replaced by the JSON store');
  }
  assertChatsStoreFile(options.dataDir, marker);
  const datasetGeneration = /** @type {string} */ (marker.datasetGeneration);
  const [{ createStorageWorkerHost }, { createChatsStore }, { WriteGateRegistry }, { readControlState }, { createSqliteChatsBackend }] = await Promise.all([
    import('../storage/worker-host.js'),
    import('../storage/chats-store.js'),
    import('../storage/maintenance-coordinator.js'),
    import('../backup/offline/control-dir.js'),
    import('./chats-backend-sqlite.js'),
  ]);
  let writeGate = options.writeGate;
  if (!writeGate) {
    if (typeof options.controlDir !== 'string') throw new TypeError('The sqlite chats backend needs controlDir (or a test writeGate)');
    const registry = new WriteGateRegistry();
    registry.startWriter('chats-runtime', 'store.chats');
    writeGate = { controlDir: options.controlDir, registry, writerId: 'chats-runtime', fence: readControlState(options.controlDir).fence };
  }
  // `create: false` comes last: no host option can turn the runtime into a store creator.
  const host = createStorageWorkerHost({
    handlersPath: options.handlersPath ?? CHATS_HANDLERS_PATH, ...options.hostOptions,
    dbDir: chatsSqliteDir(options.dataDir), filename: /** @type {string} */ (marker.storeFile), create: false, writeGate,
  });
  try {
    await host.start();
    const probe = createChatsStore({ host, datasetGeneration, writeGate });
    try {
      await probe.verifyDataset({ datasetGeneration });
    } catch (error) {
      const kind = /** @type {any} */ (error)?.details?.conflictKind;
      if (kind === 'chat_store_unbound') throw new ChatsBackendError('chats_store_unbound', 'The chats store file is not bound to any dataset generation', { datasetGeneration });
      if (kind === 'chat_generation_mismatch') throw new ChatsBackendError('chats_generation_mismatch', 'The chats store file is bound to another dataset generation than the marker selects', { datasetGeneration });
      throw error;
    }
    let guarded = host;
    if (options.coordinator) {
      await options.coordinator.activate(host);
      guarded = options.coordinator.guardHost(host);
    }
    const store = createChatsStore({ host: guarded, datasetGeneration, writeGate });
    const backend = createSqliteChatsBackend({ store });
    return {
      ...createChatsRuntime({ backend, backendKind: 'sqlite', deps: options.deps, close: async () => { await host.close().catch(() => {}); } }),
      marker,
    };
  } catch (error) {
    await host.close().catch(() => {});
    throw error;
  }
}

/**
 * Server-start helper: opens the marker-selected runtime and makes it the global one.
 *
 * @param {Parameters<typeof openChatsRuntime>[0]} options
 * @returns {Promise<ChatsRuntime>}
 */
export async function activateChatsRuntime(options) {
  const runtime = await openChatsRuntime(options);
  setActiveChatsRuntime(runtime);
  return runtime;
}
