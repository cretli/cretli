/**
 * Runtime of the decision cards store: `data/decisions/decisions.sqlite`, owned by a storage worker
 * (lib/storage/decisions-store.js). Decisions have no legacy dataset, so unlike the history and todos
 * runtimes this one bootstraps its own file (created and bound to a fixed generation on first use);
 * after that the worker host starts with `create: false`, so a vanished file is a refusal, never a silent empty store.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStorageWorkerHost } from '../storage/worker-host.js';
import { createDecisionsStore } from '../storage/decisions-store.js';
import { WriteGateRegistry } from '../storage/maintenance-coordinator.js';
import { bootstrapHistoryStore } from '../storage/dataset-binding.js';
import { readControlState, resolveControlDir } from '../backup/offline/control-dir.js';

/** Worker handler registry of the decisions store. */
export const DECISIONS_HANDLERS_PATH = fileURLToPath(new URL('../storage/decisions-store.js', import.meta.url));
export const DECISIONS_DATASET_GENERATION = 'decisions-v1';
export const DECISIONS_STORE_FILE = 'decisions.sqlite';

/** @param {string} dataDir */
export function decisionsStoreDir(dataDir) {
  return path.join(dataDir, 'decisions');
}

/**
 * @param {{ dataDir: string, controlDir?: string, writeGate?: unknown, hostOptions?: Record<string, unknown> }} options
 * @returns {Promise<{ store: ReturnType<typeof createDecisionsStore>, close: () => Promise<void> }>}
 */
export async function openDecisionsRuntime(options) {
  const dbDir = decisionsStoreDir(options.dataDir);
  bootstrapHistoryStore({ dbDir, datasetGeneration: DECISIONS_DATASET_GENERATION, filename: DECISIONS_STORE_FILE });
  let writeGate = options.writeGate;
  if (!writeGate) {
    const controlDir = resolveControlDir(options.dataDir, options.controlDir);
    const registry = new WriteGateRegistry();
    registry.startWriter('decisions-runtime', 'store.decisions');
    writeGate = { controlDir, registry, writerId: 'decisions-runtime', fence: readControlState(controlDir).fence };
  }
  const host = createStorageWorkerHost({
    handlersPath: DECISIONS_HANDLERS_PATH, ...options.hostOptions, dbDir, filename: DECISIONS_STORE_FILE, create: false, writeGate,
  });
  try {
    await host.start();
    const store = createDecisionsStore({ host, datasetGeneration: DECISIONS_DATASET_GENERATION, writeGate });
    await store.verifyDataset({ datasetGeneration: DECISIONS_DATASET_GENERATION });
    return { store, close: () => host.close().catch(() => {}) };
  } catch (error) {
    await host.close().catch(() => {});
    throw error;
  }
}
