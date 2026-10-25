/**
 * Runtime factory of the async history adapter (stage 2a): picks the ONE
 * backend the control marker selects and wires it. It never switches a backend,
 * never migrates data and is not called by the server yet (stage 2b converts
 * callers; stage 3 owns the cutover).
 *
 * SQLite wiring order (each step fails closed, no step is skipped):
 *   1. the marker must select `sqlite` for exactly the requested dataset generation;
 *   2. the coordinator must already own a live lease (`acquire()` by the caller);
 *   3. the store file MUST already exist (offline bootstrap/import creates it:
 *      `bootstrapHistoryStore`); the worker host starts with `create: false` on
 *      every (re)start and passes its startup barrier (WAL TRUNCATE under
 *      FULL, integrity/FK checks, F29), then the file's immutable dataset binding
 *      must equal the marker's generation. A failure leaves NO adapter: there is
 *      no READY and therefore no ACK;
 *   4. `coordinator.activate(host)` reconciles/raises the fencing mark, then the
 *      host is wrapped with `guardHost` so every write carries the owner epoch
 *      and a stale or fenced owner is refused;
 *   5. group committer (sized for 256 KiB records), history store, durable
 *      pending buffer, backend;
 *   6. `recoverPending()` replays commands persisted by an earlier run BEFORE
 *      the adapter is returned; any unresolved command refuses the open
 *      (`history_recovery_unresolved`, pending entries preserved, no READY/ACK).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGroupCommitter } from '../storage/group-commit.js';
import { DEFAULT_STORAGE_DB_FILENAME } from '../storage/db-lifecycle.js';
import { createStorageWorkerHost } from '../storage/worker-host.js';
import { createChatHistoryStore, HISTORY_GROUP_MAX_MEMBER_BYTES } from '../storage/chat-history-store.js';
import { WriteGateRegistry } from '../storage/maintenance-coordinator.js';
import { readControlState } from '../backup/offline/control-dir.js';
import { createChatHistoryAdapter } from './chat-history-adapter.js';
import { assertHistoryBackendSelected, readHistoryBackendMarker } from './chat-history-backend-marker.js';
import { createRollbackReadOnlyHistoryBackend } from './chat-history-backend-rollback.js';
import { createSqliteHistoryBackend } from './chat-history-backend-sqlite.js';
import { createHistoryPendingBuffer } from './history-pending-buffer.js';
import { refuseHistory } from './chat-history-errors.js';

/** Worker handler registry for the history store (receipt-wrapped commands and queries). */
export const HISTORY_HANDLERS_PATH = fileURLToPath(new URL('../storage/chat-history-store.js', import.meta.url));

/**
 * @param {{
 *   controlDir: string,
 *   dbDir?: string,
 *   pendingDir?: string,
 *   coordinator?: Record<string, any>,
 *   hostOptions?: Record<string, unknown>,
 *   producerId?: string,
 *   onCommitted?: (event: Record<string, unknown>) => void | Promise<void>,
 *   rollback?: { exportDir: string, storeDir?: string, allowUnverifiedControl?: boolean },
 *   legacyFactory?: () => object,
 * }} options
 * @returns {Promise<{ adapter: ReturnType<typeof createChatHistoryAdapter>, backendKind: string, marker: Record<string, any>, recovery?: Record<string, any>, close: () => Promise<void> }>}
 */
export async function openChatHistoryRuntime(options) {
  // A missing marker is legacy only if neither the witness nor any store/pending footprint says a cutover happened.
  const traceDirs = { dbDir: options.dbDir, pendingDir: options.pendingDir };
  const marker = readHistoryBackendMarker(options.controlDir, { traceDirs });
  if (marker.backend === 'legacy') {
    assertHistoryBackendSelected(options.controlDir, 'legacy', { traceDirs });
    const adapter = options.legacyFactory
      ? options.legacyFactory()
      : (await import('./chat-history-backend-legacy.js')).createDefaultLegacyHistoryAdapter();
    return { adapter, backendKind: 'legacy', marker, close: async () => {} };
  }
  if (marker.backend === 'rollback-readonly') {
    assertHistoryBackendSelected(options.controlDir, 'rollback-readonly');
    if (!options.rollback?.exportDir) refuseHistory('history_rollback_not_verified', 'Rollback read-only mode needs the verified export directory');
    const backend = createRollbackReadOnlyHistoryBackend({
      exportDir: options.rollback.exportDir, storeDir: options.rollback.storeDir, expectedManifestHash: marker.exportManifestHash ?? undefined,
      controlState: options.coordinator, allowUnverifiedControl: options.rollback.allowUnverifiedControl,
    });
    const adapter = createChatHistoryAdapter({ backend, kind: 'rollback-readonly' });
    return { adapter, backendKind: 'rollback-readonly', marker, close: async () => {} };
  }
  const { coordinator, dbDir, pendingDir } = options;
  if (!coordinator || typeof coordinator.activate !== 'function' || typeof coordinator.guardHost !== 'function') {
    throw new TypeError('The sqlite history backend needs an acquired storage coordinator');
  }
  if (typeof dbDir !== 'string' || typeof pendingDir !== 'string') throw new TypeError('The sqlite history backend needs dbDir and pendingDir');
  const datasetGeneration = /** @type {string} */ (marker.datasetGeneration);
  assertHistoryBackendSelected(options.controlDir, 'sqlite', { datasetGeneration });
  assertStoreFileExists(dbDir);
  // `create: false` comes last: no host option can turn the runtime into a store creator.
  const writeGateRegistry = new WriteGateRegistry();
  const writerId = 'chat-history-runtime';
  writeGateRegistry.startWriter(writerId, 'store.chat-history');
  const writeGate = { controlDir: options.controlDir, registry: writeGateRegistry, writerId, fence: readControlState(options.controlDir).fence };
  const host = createStorageWorkerHost({ handlersPath: HISTORY_HANDLERS_PATH, ...options.hostOptions, dbDir, create: false, writeGate });
  /** @type {ReturnType<typeof createGroupCommitter> | null} */
  let committer = null;
  const closeAll = async () => {
    await committer?.close().catch(() => {});
    await host.close().catch(() => {});
  };
  try {
    await host.start();
    await verifyBoundDataset(host, datasetGeneration);
    await coordinator.activate(host);
    const guarded = coordinator.guardHost(host);
    committer = createGroupCommitter({ host: guarded, writeGate, maxMemberBytes: HISTORY_GROUP_MAX_MEMBER_BYTES });
    const store = createChatHistoryStore({ host: guarded, groupCommitter: committer, writeGate });
    const pendingBuffer = createHistoryPendingBuffer({ dir: pendingDir });
    await pendingBuffer.open();
    const backend = createSqliteHistoryBackend({ store, datasetGeneration, pendingBuffer, producerId: options.producerId, onCommitted: options.onCommitted });
    const recovery = await backend.recoverPending();
    // Pending commands whose commit state is unknown stay on disk; serving (and ACKing) new writes on top of them could
    // reorder or duplicate history, so the open fails closed through the normal cleanup below.
    if (recovery.unresolved.length > 0) {
      refuseHistory('history_recovery_unresolved', 'Pending history commands could not be resolved at startup; they stay pending and no adapter is opened', { unresolved: recovery.unresolved.length });
    }
    const adapter = createChatHistoryAdapter({ backend, kind: 'sqlite', close: closeAll });
    return { adapter, backendKind: 'sqlite', marker, recovery, close: closeAll };
  } catch (error) {
    await closeAll();
    throw error;
  }
}

/**
 * The marker selected sqlite: the store file must be there. A removed, moved or
 * mis-mounted directory is a refusal, never an empty store with fresh epochs.
 *
 * @param {string} dbDir
 */
function assertStoreFileExists(dbDir) {
  let size = 0;
  try {
    size = fs.statSync(path.join(dbDir, DEFAULT_STORAGE_DB_FILENAME)).size;
  } catch { /* handled below */ }
  if (size <= 0) refuseHistory('history_store_missing', 'The marker selects sqlite but the store file is missing or empty; restore it or bootstrap/import it offline', { dbDir: path.basename(dbDir) });
}

/**
 * Compare the file's immutable binding with the generation the marker selected,
 * BEFORE the fencing mark is raised or any pending command is replayed.
 *
 * @param {{ query: Function }} host
 * @param {string} datasetGeneration
 */
async function verifyBoundDataset(host, datasetGeneration) {
  try {
    await host.query('history.verifyDataset', { datasetGeneration });
  } catch (error) {
    const kind = /** @type {any} */ (error)?.details?.conflictKind;
    if (kind === 'history_store_unbound') refuseHistory('history_store_unbound', 'The store file is not bound to a dataset generation; bind it offline before it can serve', { datasetGeneration });
    if (kind === 'history_generation_mismatch') refuseHistory('history_generation_mismatch', 'The store file belongs to another dataset generation than the marker selects', { datasetGeneration });
    throw error;
  }
}
