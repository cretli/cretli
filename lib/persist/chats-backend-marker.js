/**
 * Backend marker of `store.chats` (`<dataDir>/chats-backend.json`).
 *
 * Selection rules (ADR docs/storage-chats-metadata-decision.md, section 4), same semantics as the todos marker:
 * - no marker file => the legacy JSON backend (`chats.json`), nothing else is consulted;
 * - marker `sqlite` => exactly the SQLite store named by the marker, bound to the marker's dataset generation.
 *   A missing or empty store file is a refusal (`chats_store_missing`): never an empty store, never a fallback to JSON;
 * - marker `legacy-rollback` => legacy JSON over a verified rollback export pinned by its manifest hash. The marker
 *   is parsed and validated here; ACTIVATING it is leaf C (the runtime refuses it with `chats_backend_unsupported`);
 * - an unreadable, unknown or inconsistent marker refuses (`chats_marker_invalid`).
 *
 * Writes are an atomic durable replace guarded by `revision` (compare-and-swap).
 */
import fs from 'node:fs';
import path from 'node:path';
import { replaceOwnFileDurable } from '../storage/history-migration-fs.js';
import { DATASET_GENERATION_PATTERN } from '../storage/command-receipts.js';

export const CHATS_BACKEND_MARKER_FILE = 'chats-backend.json';
export const CHATS_BACKEND_MARKER_SCHEMA = 'cretli-chats-backend-v1';
export const CHATS_SQLITE_FILE = 'chats.sqlite';
export const CHATS_BACKENDS = Object.freeze(['sqlite', 'legacy-rollback']);

/** Error of the chats backend selection and runtime; `code` is stable for callers. */
export class ChatsBackendError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ChatsBackendError';
    this.code = code;
    this.details = details;
  }
}

/**
 * @typedef {{
 *   schema: string, backend: 'legacy' | 'sqlite' | 'legacy-rollback', revision: number,
 *   datasetGeneration: string | null, storeFile: string | null, sourceManifestHash: string | null,
 *   exportManifestHash: string | null, exportDir: string | null, importedChatsHash: string | null, selectedAt: string | null,
 * }} ChatsBackendMarker
 */

/** @param {string} dataDir @returns {string} */
export function chatsBackendMarkerPath(dataDir) {
  return path.join(path.resolve(dataDir), CHATS_BACKEND_MARKER_FILE);
}

/** @param {string} dataDir @returns {string} */
export function chatsSqliteDir(dataDir) {
  return path.resolve(dataDir);
}

/**
 * Read the marker. A missing file is the legacy backend at revision 0.
 *
 * @param {string} dataDir
 * @returns {ChatsBackendMarker}
 */
export function readChatsBackendMarker(dataDir) {
  let text;
  try {
    text = fs.readFileSync(chatsBackendMarkerPath(dataDir), 'utf8');
  } catch (error) {
    if (/** @type {any} */ (error)?.code === 'ENOENT') {
      return {
        schema: CHATS_BACKEND_MARKER_SCHEMA, backend: 'legacy', revision: 0, datasetGeneration: null, storeFile: null,
        sourceManifestHash: null, exportManifestHash: null, exportDir: null, importedChatsHash: null, selectedAt: null,
      };
    }
    throw new ChatsBackendError('chats_marker_invalid', 'The chats backend marker cannot be read');
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ChatsBackendError('chats_marker_invalid', 'The chats backend marker is not valid JSON');
  }
  const bad = !value || value.schema !== CHATS_BACKEND_MARKER_SCHEMA || !CHATS_BACKENDS.includes(value.backend)
    || !Number.isSafeInteger(value.revision) || value.revision < 1;
  if (bad) throw new ChatsBackendError('chats_marker_invalid', 'The chats backend marker is inconsistent');
  if (value.backend === 'sqlite') {
    if (typeof value.datasetGeneration !== 'string' || !DATASET_GENERATION_PATTERN.test(value.datasetGeneration)
      || typeof value.storeFile !== 'string' || value.storeFile.includes('/') || value.storeFile.includes('\\')
      || value.storeFile.includes('..') || value.storeFile === '') {
      throw new ChatsBackendError('chats_marker_invalid', 'The sqlite chats marker needs a dataset generation and a plain store file name');
    }
  }
  if (value.backend === 'legacy-rollback' && (typeof value.exportManifestHash !== 'string' || typeof value.exportDir !== 'string')) {
    throw new ChatsBackendError('chats_marker_invalid', 'The rollback chats marker needs the verified export manifest hash and directory');
  }
  return {
    schema: value.schema, backend: value.backend, revision: value.revision,
    datasetGeneration: value.datasetGeneration ?? null, storeFile: value.storeFile ?? null,
    sourceManifestHash: value.sourceManifestHash ?? null, exportManifestHash: value.exportManifestHash ?? null,
    exportDir: value.exportDir ?? null, importedChatsHash: value.importedChatsHash ?? null,
    selectedAt: typeof value.selectedAt === 'string' ? value.selectedAt : null,
  };
}

/**
 * Publish a marker. Compare-and-swap on `revision`; the caller (a migration/rollback tool) has already verified
 * the data the marker points at.
 *
 * @param {string} dataDir
 * @param {Partial<ChatsBackendMarker> & { backend: 'sqlite' | 'legacy-rollback' }} next
 * @param {{ expectedRevision: number, now?: () => Date }} options
 * @returns {ChatsBackendMarker}
 */
export function writeChatsBackendMarker(dataDir, next, options) {
  const current = readChatsBackendMarker(dataDir);
  if (current.revision !== options.expectedRevision) {
    throw new ChatsBackendError('chats_marker_conflict', 'The chats backend marker changed since it was read', { revision: current.revision });
  }
  /** @type {ChatsBackendMarker} */
  const marker = {
    schema: CHATS_BACKEND_MARKER_SCHEMA, backend: next.backend, revision: current.revision + 1,
    datasetGeneration: next.datasetGeneration ?? null, storeFile: next.storeFile ?? null,
    sourceManifestHash: next.sourceManifestHash ?? null, exportManifestHash: next.exportManifestHash ?? null,
    exportDir: next.exportDir ?? null, importedChatsHash: next.importedChatsHash ?? null,
    selectedAt: (options.now ?? (() => new Date()))().toISOString(),
  };
  fs.mkdirSync(path.resolve(dataDir), { recursive: true });
  replaceOwnFileDurable(chatsBackendMarkerPath(dataDir), `${JSON.stringify(marker, null, 2)}\n`);
  // Re-read what is on disk: the marker is only "published" if it parses back to the same selection.
  const written = readChatsBackendMarker(dataDir);
  if (written.revision !== marker.revision || written.backend !== marker.backend) {
    throw new ChatsBackendError('chats_marker_invalid', 'The chats backend marker did not read back after the write');
  }
  return written;
}

/**
 * Fail-closed check for the sqlite selection: the store file the marker names must exist and be non-empty.
 *
 * @param {string} dataDir
 * @param {ChatsBackendMarker} marker
 * @returns {string} the store file path
 */
export function assertChatsStoreFile(dataDir, marker) {
  const filePath = path.join(chatsSqliteDir(dataDir), marker.storeFile ?? CHATS_SQLITE_FILE);
  let size = 0;
  try {
    size = fs.statSync(filePath).size;
  } catch { /* handled below */ }
  if (size <= 0) {
    throw new ChatsBackendError(
      'chats_store_missing',
      'The chats marker selects sqlite but the store file is missing or empty; restore it or re-run the migration. An empty store is never created.',
      { storeFile: marker.storeFile },
    );
  }
  return filePath;
}
