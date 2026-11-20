/**
 * Runtime factory of the todos facade backend: starts EXACTLY the backend the
 * `todos-backend.json` marker selects (lib/persist/todos-backend-marker.js).
 * It never creates a store, never migrates and is not called by the server yet:
 * production stays on the legacy JSON backend until an operator publishes a marker.
 *
 *   no marker          -> legacy JSON (`todos/<key>.json`)
 *   marker sqlite      -> the store file must already exist (offline migration creates it); the worker
 *                         host starts with `create: false`, the file's dataset binding must equal the
 *                         marker's generation, then the committed cache is rebuilt lazily from the rows.
 *                         Any failure leaves NO backend: there is no empty-store fallback.
 *   marker legacy-rollback -> legacy JSON over the verified rollback export (manifest hash pinned).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStorageWorkerHost } from '../storage/worker-host.js';
import { createTodosStore } from '../storage/todos-store.js';
import { WriteGateRegistry } from '../storage/maintenance-coordinator.js';
import { readControlState } from '../backup/offline/control-dir.js';
import { createLegacyJsonTodosBackend } from './todos-store.js';
import { createSqliteTodosBackend } from './todos-backend-sqlite.js';
import { assertTodosStoreFile, readTodosBackendMarker, TodosBackendError, todosSqliteDir } from './todos-backend-marker.js';
import { createRollbackLegacyTodosBackend } from './todos-backend-rollback.js';

/** Worker handler registry of the todos store. */
export const TODOS_HANDLERS_PATH = fileURLToPath(new URL('../storage/todos-store.js', import.meta.url));

/**
 * @param {{
 *   dataDir: string,
 *   controlDir?: string,
 *   writeGate?: unknown,
 *   coordinator?: Record<string, any>,
 *   hostOptions?: Record<string, unknown>,
 *   handlersPath?: string,
 *   fence?: number,
 * }} options `fence`: owner epoch, required (and strictly above the recorded mark) under the legacy-rollback marker; `writeGate` overrides the registry-backed gate (tests); production passes `controlDir`
 * @returns {Promise<{ backend: import('./todos-store.js').TodosBackend, backendKind: 'legacy' | 'sqlite' | 'legacy-rollback', marker: Record<string, any>, close: () => Promise<void> }>}
 */
export async function openTodosRuntime(options) {
  const marker = readTodosBackendMarker(options.dataDir);
  if (marker.backend === 'legacy') {
    return { backend: createLegacyJsonTodosBackend(), backendKind: 'legacy', marker, close: async () => {} };
  }
  if (marker.backend === 'legacy-rollback') {
    const backend = /** @type {any} */ (createRollbackLegacyTodosBackend)({ dataDir: options.dataDir, marker, fence: /** @type {number} */ (options.fence) });
    return { backend, backendKind: 'legacy-rollback', marker, close: async () => {} };
  }
  assertTodosStoreFile(options.dataDir, marker);
  const datasetGeneration = /** @type {string} */ (marker.datasetGeneration);
  let writeGate = options.writeGate;
  if (!writeGate) {
    if (typeof options.controlDir !== 'string') throw new TypeError('The sqlite todos backend needs controlDir (or a test writeGate)');
    const registry = new WriteGateRegistry();
    registry.startWriter('todos-runtime', 'store.todos');
    writeGate = { controlDir: options.controlDir, registry, writerId: 'todos-runtime', fence: readControlState(options.controlDir).fence };
  }
  // `create: false` comes last: no host option can turn the runtime into a store creator.
  const host = createStorageWorkerHost({
    handlersPath: options.handlersPath ?? TODOS_HANDLERS_PATH, ...options.hostOptions,
    dbDir: todosSqliteDir(options.dataDir), filename: /** @type {string} */ (marker.storeFile), create: false, writeGate,
  });
  /** @type {ReturnType<typeof createSqliteTodosBackend> | null} */
  let backend = null;
  const closeAll = async () => {
    backend?.close();
    await host.close().catch(() => {});
  };
  try {
    await host.start();
    const probe = createTodosStore({ host, datasetGeneration, writeGate });
    try {
      await probe.verifyDataset({ datasetGeneration });
    } catch (error) {
      const kind = /** @type {any} */ (error)?.details?.conflictKind;
      if (kind === 'todo_store_unbound' || kind === 'todo_generation_mismatch') {
        throw new TodosBackendError(kind, 'The todos store file is not bound to the dataset generation the marker selects', { datasetGeneration });
      }
      throw error;
    }
    let guarded = host;
    if (options.coordinator) {
      await options.coordinator.activate(host);
      guarded = options.coordinator.guardHost(host);
    }
    const store = createTodosStore({ host: guarded, datasetGeneration, writeGate });
    const overlay = fs.mkdtempSync(path.join(path.resolve(options.dataDir), '.todos-overlay-'));
    backend = createSqliteTodosBackend({ store, dataDir: options.dataDir, scratchDir: overlay });
    return {
      backend, backendKind: 'sqlite', marker,
      close: async () => { fs.rmSync(overlay, { recursive: true, force: true }); await closeAll(); },
    };
  } catch (error) {
    await closeAll();
    throw error;
  }
}
