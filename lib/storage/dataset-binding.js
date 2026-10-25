/**
 * Dataset binding of a storage file (schema v5, `storage_dataset_binding`).
 *
 * `bindDatasetGeneration` is the OFFLINE bootstrap/upgrade primitive: it creates
 * nothing but the binding row, refuses a file whose data already belongs to
 * another generation and never rewrites an existing binding. The server never
 * calls it: the history runtime only READS the binding (`history.verifyDataset`
 * in the worker) and refuses an unbound or differently bound file.
 */
import fs from 'node:fs';
import { StorageError, STORAGE_ERROR_CODES } from './errors.js';
import { DATASET_GENERATION_PATTERN } from './command-receipts.js';
import { DEFAULT_STORAGE_DB_FILENAME, openStorageDb } from './db-lifecycle.js';

/** @param {string} kind @param {Record<string, unknown>} [details] @returns {never} */
function refuse(kind, details = {}) {
  throw new StorageError(STORAGE_ERROR_CODES.CONFLICT, 'Dataset binding refused', {
    details: { operation: 'dataset_binding', conflictKind: kind, commitState: 'not_committed', ...details },
  });
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {string | null} the bound generation, null when the file is unbound
 */
export function readDatasetBinding(db) {
  const row = db.prepare('SELECT dataset_generation FROM storage_dataset_binding WHERE id = 1').get();
  return row ? String(row.dataset_generation) : null;
}

/**
 * Bind (or confirm the binding of) an open store connection.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} datasetGeneration
 * @param {{ now?: () => number }} [options]
 * @returns {{ datasetGeneration: string, created: boolean }}
 */
export function bindDatasetGeneration(db, datasetGeneration, options = {}) {
  if (typeof datasetGeneration !== 'string' || !DATASET_GENERATION_PATTERN.test(datasetGeneration)) refuse('dataset_generation_invalid');
  const bound = readDatasetBinding(db);
  if (bound !== null) {
    if (bound !== datasetGeneration) refuse('history_generation_mismatch', { bound, requested: datasetGeneration });
    return { datasetGeneration, created: false };
  }
  const foreign = db.prepare('SELECT DISTINCT dataset_generation AS g FROM chat_history_state WHERE dataset_generation <> ?').all(datasetGeneration);
  if (foreign.length > 0) refuse('history_generation_mismatch', { foreign: foreign.length, requested: datasetGeneration });
  db.prepare('INSERT INTO storage_dataset_binding (id, dataset_generation, bound_at) VALUES (1, ?, ?)').run(datasetGeneration, (options.now ?? Date.now)());
  return { datasetGeneration, created: true };
}

/**
 * Offline bootstrap: create the store file when it is absent, migrate it and
 * bind it to `datasetGeneration`. This is the ONLY place a history store file
 * is created; the runtime never creates one.
 *
 * @param {{ dbDir: string, datasetGeneration: string, filename?: string }} options
 * @returns {{ datasetGeneration: string, created: boolean, filePath: string, schemaVersion: number }}
 */
export function bootstrapHistoryStore(options) {
  fs.mkdirSync(options.dbDir, { recursive: true, mode: 0o700 });
  const handle = openStorageDb({ dir: options.dbDir, filename: options.filename ?? DEFAULT_STORAGE_DB_FILENAME, create: true });
  try {
    const result = bindDatasetGeneration(handle.db, options.datasetGeneration);
    return { ...result, filePath: handle.filePath, schemaVersion: handle.schemaVersion };
  } finally {
    handle.close();
  }
}
