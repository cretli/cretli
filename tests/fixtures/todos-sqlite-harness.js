/**
 * Harness of the todos SQLite backend tests: a real storage worker host over a temporary store file,
 * the real todos handlers, the real facade backend. Nothing here touches `data/`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapHistoryStore } from '../../lib/storage/dataset-binding.js';
import { createStorageWorkerHost } from '../../lib/storage/worker-host.js';
import { createTodosStore } from '../../lib/storage/todos-store.js';
import { WRITE_GATE_TEST_EXEMPTION } from '../../lib/storage/maintenance-coordinator.js';
import { createSqliteTodosBackend } from '../../lib/persist/todos-backend-sqlite.js';
import { TODOS_HANDLERS_PATH } from '../../lib/persist/todos-runtime.js';
import { TODOS_SQLITE_FILE } from '../../lib/persist/todos-backend-marker.js';

export const TODOS_GENERATION = 'todos-gen-1';
export const FAULT_HANDLERS = fileURLToPath(new URL('./storage-todos-handlers.js', import.meta.url));

/**
 * @param {{ dataDir: string, handlersPath?: string, faultInjection?: boolean, afterCommitHook?: (key: string) => void | Promise<void>, nudge?: Function, bootstrap?: boolean, wrapStore?: (store: any) => any }} options
 */
export async function openSqliteTodosBackend(options) {
  if (options.bootstrap !== false) bootstrapHistoryStore({ dbDir: options.dataDir, filename: TODOS_SQLITE_FILE, datasetGeneration: TODOS_GENERATION });
  const host = createStorageWorkerHost({
    dbDir: options.dataDir, filename: TODOS_SQLITE_FILE, handlersPath: options.handlersPath ?? TODOS_HANDLERS_PATH, create: false,
    faultInjection: options.faultInjection === true, writeGate: WRITE_GATE_TEST_EXEMPTION, restartBackoffMs: { initial: 5, max: 20 },
  });
  await host.start();
  const rawStore = createTodosStore({ host, datasetGeneration: TODOS_GENERATION });
  const store = options.wrapStore ? options.wrapStore(rawStore) : rawStore;
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'todos-overlay-'));
  const backend = createSqliteTodosBackend({
    store, dataDir: options.dataDir, scratchDir, afterCommitHook: options.afterCommitHook, nudge: /** @type {any} */ (options.nudge),
  });
  return {
    host, store, backend,
    close: async () => {
      backend.close();
      await host.close({ timeoutMs: 1000 }).catch(() => {});
      fs.rmSync(scratchDir, { recursive: true, force: true });
    },
  };
}
