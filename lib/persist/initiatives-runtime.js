/**
 * Runtime of the initiatives store: `data/initiatives/initiatives.sqlite`, owned by a storage worker
 * (lib/storage/initiatives-store.js).
 *
 * Unlike the decisions runtime, a vanished file is never recreated from `fs.stat` alone. The expected dataset is
 * declared durably in the control dir (outside restore-managed paths): `initiatives-dataset.json` records the dataset
 * generation and the control-state generation (`readControlState().datasetGeneration`, moved by every restore) at
 * the time of the declaration.
 *  - No declaration and no file: first install, bootstrap and declare.
 *  - No declaration, file present: verify the dataset, then declare.
 *  - Declaration current, file missing: refusal (`INITIATIVES_STORE_MISSING`), never a silent empty store.
 *  - Declaration older than the control generation (a full restore happened since): the restore decides. A restored
 *    file is verified; an archive that predates the domain leaves no file, which explicitly allows a fresh empty
 *    bootstrap. Either way the declaration is rewritten for the new control generation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStorageWorkerHost } from '../storage/worker-host.js';
import { createInitiativesStore } from '../storage/initiatives-store.js';
import { WriteGateRegistry } from '../storage/maintenance-coordinator.js';
import { bootstrapHistoryStore } from '../storage/dataset-binding.js';
import { createReceiptsRetention } from '../storage/receipts-retention.js';
import { controlPaths, readControlState, readJsonStrict, resolveControlDir, writeJsonDurable } from '../backup/offline/control-dir.js';
import { OfflineDataError } from '../backup/offline/offline-errors.js';

export const INITIATIVES_HANDLERS_PATH = fileURLToPath(new URL('../storage/initiatives-store.js', import.meta.url));
export const INITIATIVES_DATASET_GENERATION = 'initiatives-v1';
export const INITIATIVES_STORE_FILE = 'initiatives.sqlite';
export const INITIATIVES_DECLARATION_FILE = 'initiatives-dataset.json';

/** @param {string} filePath */
function hasStoreData(filePath) {
  try {
    return fs.statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

/** @param {string} dataDir */
export function initiativesStoreDir(dataDir) {
  return path.join(dataDir, 'initiatives');
}

/** @param {string} controlDir */
export function initiativesDeclarationPath(controlDir) {
  return path.join(path.dirname(controlPaths(controlDir).state), INITIATIVES_DECLARATION_FILE);
}

/**
 * Decides whether the store file may be (re)created and keeps the control-dir declaration in step.
 *
 * @param {{ dataDir: string, controlDir: string }} options
 * @returns {{ bootstrap: boolean }}
 * @throws {OfflineDataError} INITIATIVES_STORE_MISSING
 */
export function reconcileInitiativesDeclaration({ dataDir, controlDir }) {
  fs.mkdirSync(controlDir, { recursive: true, mode: 0o700 });
  const file = path.join(initiativesStoreDir(dataDir), INITIATIVES_STORE_FILE);
  const declPath = initiativesDeclarationPath(controlDir);
  const declaration = readJsonStrict(declPath);
  const controlGeneration = readControlState(controlDir).datasetGeneration ?? null;
  const present = hasStoreData(file);
  const write = () => writeJsonDurable(declPath, {
    schema: 1, datasetGeneration: INITIATIVES_DATASET_GENERATION, controlGeneration, declaredAt: new Date().toISOString(),
  });
  if (!declaration) {
    write();
    return { bootstrap: !present };
  }
  if (declaration.datasetGeneration !== INITIATIVES_DATASET_GENERATION) {
    throw new OfflineDataError('INITIATIVES_DATASET_MISMATCH', `initiatives dataset declaration is ${String(declaration.datasetGeneration)}, expected ${INITIATIVES_DATASET_GENERATION}`);
  }
  if (present) {
    if ((declaration.controlGeneration ?? null) !== controlGeneration) write();
    return { bootstrap: false };
  }
  if ((declaration.controlGeneration ?? null) !== controlGeneration) {
    // A full restore of an archive that predates the domain: an explicit, journaled reason to start empty.
    write();
    return { bootstrap: true };
  }
  throw new OfflineDataError('INITIATIVES_STORE_MISSING', 'initiatives store file is missing although the dataset is declared; restore it from a backup', { file });
}

/**
 * @param {{ dataDir: string, controlDir?: string, writeGate?: unknown, hostOptions?: Record<string, unknown> }} options
 * @returns {Promise<{ store: ReturnType<typeof createInitiativesStore>, retention: ReturnType<typeof createReceiptsRetention>, close: () => Promise<void> }>}
 */
export async function openInitiativesRuntime(options) {
  const dbDir = initiativesStoreDir(options.dataDir);
  const controlDir = resolveControlDir(options.dataDir, options.controlDir);
  const { bootstrap } = reconcileInitiativesDeclaration({ dataDir: options.dataDir, controlDir });
  if (bootstrap) bootstrapHistoryStore({ dbDir, datasetGeneration: INITIATIVES_DATASET_GENERATION, filename: INITIATIVES_STORE_FILE });
  let writeGate = options.writeGate;
  if (!writeGate) {
    const registry = new WriteGateRegistry();
    registry.startWriter('initiatives-runtime', 'store.initiatives');
    writeGate = { controlDir, registry, writerId: 'initiatives-runtime', fence: readControlState(controlDir).fence };
  }
  const host = createStorageWorkerHost({
    handlersPath: INITIATIVES_HANDLERS_PATH, ...options.hostOptions, dbDir, filename: INITIATIVES_STORE_FILE, create: false, writeGate,
  });
  try {
    await host.start();
    const store = createInitiativesStore({ host, datasetGeneration: INITIATIVES_DATASET_GENERATION, writeGate });
    await /** @type {any} */ (store).verifyDataset({ datasetGeneration: INITIATIVES_DATASET_GENERATION });
    const retention = createReceiptsRetention({
      host, dbPath: path.join(dbDir, INITIATIVES_STORE_FILE), backupDir: path.join(options.dataDir, 'backups', 'storage'), writeGate,
    });
    if (process.env.CRETLI_RECEIPTS_RETENTION !== '0' && !options.hostOptions?.noReceiptsRetention) retention.start();
    return { store, retention, close: () => { retention.stop(); return host.close().catch(() => {}); } };
  } catch (error) {
    await host.close().catch(() => {});
    throw error;
  }
}
