/**
 * Backend marker of `store.todos` (`<dataDir>/todos-backend.json`).
 *
 * Selection rules (ADR docs/storage-todos-worker-decision.md, section 5):
 * - no marker file => the legacy JSON backend (`todos/<key>.json`), nothing else is consulted;
 * - marker `sqlite` => exactly the SQLite store named by the marker. A missing or empty store
 *   file is a refusal (`todos_store_missing`): never an empty store, never a silent fallback to JSON;
 * - marker `legacy-rollback` => the legacy JSON backend over a rollback export that was verified
 *   against its manifest; the marker pins the manifest hash, so a different directory is refused;
 * - an unreadable, unknown or inconsistent marker refuses (`todos_marker_invalid`).
 *
 * Writes are an atomic durable replace guarded by `revision` (compare-and-swap). Nothing here
 * flips a backend implicitly: the migration and rollback tools call `writeTodosBackendMarker`
 * explicitly, after their verification steps.
 */
import fs from 'node:fs';
import path from 'node:path';
import { replaceOwnFileDurable } from '../storage/history-migration-fs.js';
import { DATASET_GENERATION_PATTERN } from '../storage/command-receipts.js';

export const TODOS_BACKEND_MARKER_FILE = 'todos-backend.json';
export const TODOS_BACKEND_MARKER_SCHEMA = 'cretli-todos-backend-v1';
export const TODOS_SQLITE_FILE = 'todos.sqlite';
export const TODOS_BACKENDS = Object.freeze(['sqlite', 'legacy-rollback']);

/** Error of the todos backend selection and migration tooling; `code` is stable for callers. */
export class TodosBackendError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'TodosBackendError';
    this.code = code;
    this.details = details;
  }
}

/**
 * @typedef {{
 *   schema: string, backend: 'legacy' | 'sqlite' | 'legacy-rollback', revision: number,
 *   datasetGeneration: string | null, storeFile: string | null, sourceManifestHash: string | null,
 *   exportManifestHash: string | null, exportDir: string | null, importedDocsHash: string | null, selectedAt: string | null,
 * }} TodosBackendMarker
 */

/** @param {string} dataDir @returns {string} */
export function todosBackendMarkerPath(dataDir) {
  return path.join(path.resolve(dataDir), TODOS_BACKEND_MARKER_FILE);
}

/** @param {string} dataDir @returns {string} */
export function todosSqliteDir(dataDir) {
  return path.resolve(dataDir);
}

/**
 * Read the marker. A missing file is the legacy backend at revision 0.
 *
 * @param {string} dataDir
 * @returns {TodosBackendMarker}
 */
export function readTodosBackendMarker(dataDir) {
  let text;
  try {
    text = fs.readFileSync(todosBackendMarkerPath(dataDir), 'utf8');
  } catch (error) {
    if (/** @type {any} */ (error)?.code === 'ENOENT') {
      return {
        schema: TODOS_BACKEND_MARKER_SCHEMA, backend: 'legacy', revision: 0, datasetGeneration: null, storeFile: null,
        sourceManifestHash: null, exportManifestHash: null, exportDir: null, importedDocsHash: null, selectedAt: null,
      };
    }
    throw new TodosBackendError('todos_marker_invalid', 'The todos backend marker cannot be read');
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new TodosBackendError('todos_marker_invalid', 'The todos backend marker is not valid JSON');
  }
  const bad = !value || value.schema !== TODOS_BACKEND_MARKER_SCHEMA || !TODOS_BACKENDS.includes(value.backend)
    || !Number.isSafeInteger(value.revision) || value.revision < 1;
  if (bad) throw new TodosBackendError('todos_marker_invalid', 'The todos backend marker is inconsistent');
  if (value.backend === 'sqlite') {
    if (typeof value.datasetGeneration !== 'string' || !DATASET_GENERATION_PATTERN.test(value.datasetGeneration)
      || typeof value.storeFile !== 'string' || value.storeFile.includes('/') || value.storeFile.includes('..') || value.storeFile === '') {
      throw new TodosBackendError('todos_marker_invalid', 'The sqlite todos marker needs a dataset generation and a plain store file name');
    }
  }
  if (value.backend === 'legacy-rollback' && (typeof value.exportManifestHash !== 'string' || typeof value.exportDir !== 'string')) {
    throw new TodosBackendError('todos_marker_invalid', 'The rollback todos marker needs the verified export manifest hash and directory');
  }
  return {
    schema: value.schema, backend: value.backend, revision: value.revision,
    datasetGeneration: value.datasetGeneration ?? null, storeFile: value.storeFile ?? null,
    sourceManifestHash: value.sourceManifestHash ?? null, exportManifestHash: value.exportManifestHash ?? null,
    exportDir: value.exportDir ?? null, importedDocsHash: value.importedDocsHash ?? null, selectedAt: typeof value.selectedAt === 'string' ? value.selectedAt : null,
  };
}

/**
 * Publish a marker. Compare-and-swap on `revision`; the caller (a migration/rollback tool) has
 * already verified the data the marker points at.
 *
 * @param {string} dataDir
 * @param {Partial<TodosBackendMarker> & { backend: 'sqlite' | 'legacy-rollback' }} next
 * @param {{ expectedRevision: number, now?: () => Date }} options
 * @returns {TodosBackendMarker}
 */
export function writeTodosBackendMarker(dataDir, next, options) {
  const current = readTodosBackendMarker(dataDir);
  if (current.revision !== options.expectedRevision) {
    throw new TodosBackendError('todos_marker_conflict', 'The todos backend marker changed since it was read', { revision: current.revision });
  }
  /** @type {TodosBackendMarker} */
  const marker = {
    schema: TODOS_BACKEND_MARKER_SCHEMA, backend: next.backend, revision: current.revision + 1,
    datasetGeneration: next.datasetGeneration ?? null, storeFile: next.storeFile ?? null,
    sourceManifestHash: next.sourceManifestHash ?? null, exportManifestHash: next.exportManifestHash ?? null,
    exportDir: next.exportDir ?? null, importedDocsHash: next.importedDocsHash ?? null, selectedAt: (options.now ?? (() => new Date()))().toISOString(),
  };
  fs.mkdirSync(path.resolve(dataDir), { recursive: true });
  replaceOwnFileDurable(todosBackendMarkerPath(dataDir), `${JSON.stringify(marker, null, 2)}\n`);
  // Re-read what is on disk: the marker is only "published" if it parses back to the same selection.
  const written = readTodosBackendMarker(dataDir);
  if (written.revision !== marker.revision || written.backend !== marker.backend) {
    throw new TodosBackendError('todos_marker_invalid', 'The todos backend marker did not read back after the write');
  }
  return written;
}

/**
 * Fail-closed check for the sqlite selection: the store file the marker names must exist and be non-empty.
 *
 * @param {string} dataDir
 * @param {TodosBackendMarker} marker
 * @returns {string} the store file path
 */
export function assertTodosStoreFile(dataDir, marker) {
  const filePath = path.join(todosSqliteDir(dataDir), marker.storeFile ?? TODOS_SQLITE_FILE);
  let size = 0;
  try {
    size = fs.statSync(filePath).size;
  } catch { /* handled below */ }
  if (size <= 0) {
    throw new TodosBackendError(
      'todos_store_missing',
      'The todos marker selects sqlite but the store file is missing or empty; restore it or re-run the migration. An empty store is never created.',
      { storeFile: marker.storeFile },
    );
  }
  return filePath;
}
