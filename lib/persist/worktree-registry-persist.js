/**
 * Durable worktree registry (contract §9.4, O12).
 *
 * `data/worktree-registry.json` shape:
 *   { v: 1, updatedAt, revision, items: { "<todoId>": record } }
 *
 * Writers serialize on the same cross-process SQLite lock discipline as the
 * Workspace Watcher store: BEGIN IMMEDIATE on an empty lock database, then an
 * atomic rename. A crashed writer loses the lock with its file descriptor and
 * can never leave a stale lock that has to be detected or trusted.
 *
 * O12 (side store vs fields on the todo) is OPEN. This store keeps the registry
 * out of the TODO documents so TODO CAS revisions and the patch/human flow are
 * untouched; the file name and schema are provisional and localized here.
 */

import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './atomic-write.js';
import { withWorkspaceWatchersFileLock } from './workspace-watchers-persist.js';
import { resolveDataPath } from '../runtime-paths.js';
import { normalizeWorktreeRecord, WORKTREE_RECORD_VERSION } from '../worktree/worktree-record.js';
import { WORKTREE_ERROR_CODES, WorktreeError } from '../worktree/worktree-errors.js';

export const WORKTREE_REGISTRY_SCHEMA_VERSION = 1;
export const WORKTREE_REGISTRY_FILE_NAME = 'worktree-registry.json';

/**
 * @param {{ dataDir?: string, registryPath?: string }} [options]
 * @returns {string}
 */
export function worktreeRegistryPath(options = {}) {
  const explicit = String(options.registryPath ?? '').trim();
  if (explicit) return path.resolve(explicit);
  const dir = String(options.dataDir ?? '').trim();
  return path.join(dir ? path.resolve(dir) : resolveDataPath(), WORKTREE_REGISTRY_FILE_NAME);
}

/**
 * @returns {{ v: number, updatedAt: string, revision: number, items: Record<string, object> }}
 */
export function emptyWorktreeRegistry() {
  return {
    v: WORKTREE_REGISTRY_SCHEMA_VERSION,
    updatedAt: new Date(0).toISOString(),
    revision: 0,
    items: {},
  };
}

/**
 * @param {unknown} raw
 * @returns {{ v: number, updatedAt: string, revision: number, items: Record<string, object> }}
 */
function sanitizeWorktreeRegistryDoc(raw) {
  if (!raw || typeof raw !== 'object') return emptyWorktreeRegistry();
  const source = /** @type {Record<string, unknown>} */ (raw);
  /** @type {Record<string, object>} */
  const items = {};
  if (source.items && typeof source.items === 'object') {
    for (const value of Object.values(/** @type {Record<string, unknown>} */ (source.items))) {
      const record = normalizeWorktreeRecord(value);
      if (record) items[record.todoId] = record;
    }
  }
  const revision = Number(source.revision);
  return {
    v: WORKTREE_REGISTRY_SCHEMA_VERSION,
    updatedAt: String(source.updatedAt ?? '').trim() || new Date(0).toISOString(),
    revision: Number.isInteger(revision) && revision >= 0 ? revision : 0,
    items,
  };
}

/**
 * Read without taking the lock. Callers that mutate must hold the lock.
 *
 * @param {{ dataDir?: string, registryPath?: string }} [options]
 * @returns {{ v: number, updatedAt: string, revision: number, items: Record<string, object> }}
 */
export function readWorktreeRegistry(options = {}) {
  const filePath = worktreeRegistryPath(options);
  if (!fs.existsSync(filePath)) return emptyWorktreeRegistry();
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    // A corrupt registry is a hard refusal: treating it as "no records" could
    // let a later creation mistake an orphaned directory for a free path.
    throw new WorktreeError(
      WORKTREE_ERROR_CODES.REGISTRY_CONFLICT,
      `Worktree registry is not readable JSON: ${filePath}. Inspect it by hand; nothing was changed.`,
      { cause: error },
    );
  }
  return sanitizeWorktreeRegistryDoc(parsed);
}

/**
 * Write without taking the lock; bumps the document revision.
 *
 * @param {{ v?: number, updatedAt?: string, revision?: number, items?: Record<string, object> }} doc
 * @param {{ dataDir?: string, registryPath?: string }} [options]
 * @returns {{ v: number, updatedAt: string, revision: number, items: Record<string, object> }}
 */
export function writeWorktreeRegistry(doc, options = {}) {
  const normalized = sanitizeWorktreeRegistryDoc(doc);
  const next = {
    v: WORKTREE_REGISTRY_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    revision: normalized.revision + 1,
    items: normalized.items,
  };
  writeJsonAtomic(worktreeRegistryPath(options), next);
  return next;
}

/**
 * Run `work` while holding the registry lock. Re-entrant in-process.
 *
 * @template T
 * @param {() => T} work
 * @param {{ dataDir?: string, registryPath?: string, lockTimeoutMs?: number }} [options]
 * @returns {T}
 */
export function withWorktreeRegistryLock(work, options = {}) {
  const dataDir = String(options.dataDir ?? '').trim();
  const lockOptions = {};
  if (dataDir) lockOptions.dataDir = path.resolve(dataDir);
  else {
    // The registry may sit on an explicit path; reuse the watcher lock in the
    // same directory so two processes never interleave on one document.
    lockOptions.dataDir = path.dirname(worktreeRegistryPath(options));
  }
  if (Number.isFinite(Number(options.lockTimeoutMs)) && Number(options.lockTimeoutMs) >= 0) {
    lockOptions.lockTimeoutMs = Number(options.lockTimeoutMs);
  }
  return withWorkspaceWatchersFileLock(work, lockOptions);
}

/**
 * Locked read-modify-write. `mutator` receives the live document and returns
 * `{ result, changed }`; the document is written only when `changed !== false`.
 *
 * @template T
 * @param {(doc: { v: number, updatedAt: string, revision: number, items: Record<string, object> }) => { result: T, changed?: boolean }} mutator
 * @param {{ dataDir?: string, registryPath?: string, lockTimeoutMs?: number }} [options]
 * @returns {T}
 */
export function mutateWorktreeRegistry(mutator, options = {}) {
  return withWorktreeRegistryLock(() => {
    const doc = readWorktreeRegistry(options);
    const outcome = mutator(doc) || {};
    if (outcome.changed === false) return outcome.result;
    writeWorktreeRegistry(doc, options);
    return outcome.result;
  }, options);
}

/**
 * @param {unknown} todoId
 * @param {{ dataDir?: string, registryPath?: string, lockTimeoutMs?: number }} [options]
 * @returns {object | null}
 */
export function getWorktreeRecord(todoId, options = {}) {
  const id = String(todoId ?? '').trim();
  if (!id) return null;
  return withWorktreeRegistryLock(() => {
    const doc = readWorktreeRegistry(options);
    return doc.items[id] || null;
  }, options);
}

/**
 * @param {{ dataDir?: string, registryPath?: string, lockTimeoutMs?: number }} [options]
 * @returns {object[]}
 */
export function listWorktreeRecords(options = {}) {
  return withWorktreeRegistryLock(() => Object.values(readWorktreeRegistry(options).items), options);
}

export { WORKTREE_RECORD_VERSION };
