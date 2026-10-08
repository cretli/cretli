/**
 * Durable per-workspace memory — facts that survive the short-lived orchestrator
 * cycles of the Workspace Watcher.
 *
 * File: `data/workspace-memory/<workspaceKey>.json`, where `workspaceKey` is
 * `workspaceKeyFromCwd(workspaceFolder)` (the sha256 of the realpath), the same
 * identity the todo store uses. No new `workspaceId` is introduced: the folder
 * (through its stable hash) is the whole key.
 *
 * Document shape:
 *   { v: 1, workspaceFolder, updatedAt, revision, entries: [entry] }
 *
 * An entry is `{ id, type, key, value, createdAt, updatedAt, expiresAt, source? }`.
 * `expiresAt` empty means permanent; a TTL is stamped once at write time and the
 * entry disappears lazily: `listWorkspaceMemory` filters expired entries on every
 * read, so no timer has to run. `pruneWorkspaceMemory` is the explicit write-side
 * compaction for callers that want the file itself cleaned. A write is an upsert
 * on `type` + normalized key; a recognized transient blocker key defaults to a
 * 24 h TTL unless an explicit TTL or `permanent: true` is given.
 *
 * Writers serialize on the shared cross-process watcher lock (the same SQLite
 * record lock todos/watchers use) and re-check both `revision` and `updatedAt`
 * on disk before the atomic rename. Two parallel cycles can therefore append
 * facts without dropping each other's rows, which is the multi-slot safety
 * requirement. The lock is re-entrant inside one process, so a nested mutation
 * retries on the CAS instead of deadlocking.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeJsonAtomic } from './atomic-write.js';
import { resolveDataPath } from '../runtime-paths.js';
import { workspaceKeyFromCwd } from './todos-persist.js';
import { withWorkspaceWatchersFileLock } from './workspace-watchers-persist.js';
import {
  isTransientBlockerCause,
  memoryEntryDedupKey,
  normalizeMemoryKey,
  parseBlockerKey,
} from '../workspace-memory-key.js';

export const WORKSPACE_MEMORY_SCHEMA_VERSION = 1;
/** The five fact kinds an orchestrator may record. */
export const WORKSPACE_MEMORY_TYPES = Object.freeze(['decision', 'pattern', 'finding', 'blocker', 'context']);
export const WORKSPACE_MEMORY_MAX_ENTRIES = 500;
export const WORKSPACE_MEMORY_MAX_KEY_LENGTH = 200;
export const WORKSPACE_MEMORY_MAX_VALUE_LENGTH = 8000;
/** Ten years; a TTL longer than that is a typo, not an intent. */
export const WORKSPACE_MEMORY_MAX_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000;
/**
 * Default lifetime of a recognized transient blocker (`quota`, `rate_limit`,
 * `slot_busy`, `model_unavailable`) written without an explicit TTL. Unknown or
 * legacy keys stay permanent for backward compatibility.
 */
export const WORKSPACE_MEMORY_DEFAULT_TRANSIENT_BLOCKER_TTL_MS = 24 * 60 * 60 * 1000;
export const WORKSPACE_MEMORY_DIR_NAME = 'workspace-memory';
const MEMORY_DOCUMENT_CAS_MAX_ATTEMPTS = 8;

export class WorkspaceMemoryCorruptError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'WorkspaceMemoryCorruptError';
    this.code = 'WORKSPACE_MEMORY_CORRUPT';
  }
}

export class WorkspaceMemoryValidationError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'WorkspaceMemoryValidationError';
    this.code = 'VALIDATION';
  }
}

/**
 * Stable file key for a workspace folder: sha256 of its realpath.
 *
 * @param {unknown} workspaceFolder
 * @returns {string}
 */
export function workspaceMemoryKey(workspaceFolder) {
  const raw = String(workspaceFolder ?? '').trim();
  if (!raw) return '';
  return workspaceKeyFromCwd(raw) || '';
}

/**
 * @param {{ dataDir?: string }} [options]
 * @returns {string}
 */
function memoryDir(options = {}) {
  const configured = String(options.dataDir ?? '').trim();
  const dir = configured || resolveDataPath();
  return path.join(dir, WORKSPACE_MEMORY_DIR_NAME);
}

/**
 * @param {unknown} workspaceFolder
 * @param {{ dataDir?: string }} [options]
 * @returns {string}
 */
export function getWorkspaceMemoryDataPath(workspaceFolder, options = {}) {
  const key = workspaceMemoryKey(workspaceFolder);
  if (!key) {
    throw new WorkspaceMemoryValidationError('workspaceFolder is required');
  }
  return path.join(memoryDir(options), `${key}.json`);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeIsoTimestamp(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return '';
  return new Date(parsed).toISOString();
}

/**
 * Newest-first time of an entry, preferring `updatedAt` and falling back to
 * `createdAt`; a missing/invalid timestamp sorts oldest.
 *
 * @param {{ updatedAt?: unknown, createdAt?: unknown }} entry
 * @returns {number} epoch milliseconds, 0 when neither timestamp parses
 */
export function workspaceMemoryEntryTime(entry) {
  const updated = timestampOf(entry?.updatedAt);
  if (updated > 0) return updated;
  return timestampOf(entry?.createdAt);
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function timestampOf(value) {
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Newest first (updatedAt with createdAt fallback), stable id tie-break where
 * the higher id wins — the same order readers use for the prompt and listings.
 *
 * @param {{ id?: unknown, updatedAt?: unknown, createdAt?: unknown }} a
 * @param {{ id?: unknown, updatedAt?: unknown, createdAt?: unknown }} b
 * @returns {number}
 */
function compareWorkspaceMemoryNewest(a, b) {
  const diff = workspaceMemoryEntryTime(b) - workspaceMemoryEntryTime(a);
  if (diff !== 0) return diff;
  return String(b?.id ?? '').localeCompare(String(a?.id ?? ''));
}

/**
 * Oldest first, for eviction: the least recently updated record leaves first,
 * with the lower id losing an exact timestamp tie.
 *
 * @param {{ id?: unknown, updatedAt?: unknown, createdAt?: unknown }} a
 * @param {{ id?: unknown, updatedAt?: unknown, createdAt?: unknown }} b
 * @returns {number}
 */
function compareWorkspaceMemoryOldestFirst(a, b) {
  const diff = workspaceMemoryEntryTime(a) - workspaceMemoryEntryTime(b);
  if (diff !== 0) return diff;
  return String(a?.id ?? '').localeCompare(String(b?.id ?? ''));
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeMemoryType(value) {
  const type = String(value ?? '').trim().toLowerCase();
  return WORKSPACE_MEMORY_TYPES.includes(type) ? type : '';
}

/**
 * One stored entry, normalized. Returns null for a record that cannot be
 * represented (missing id/type/key/value) so the loader can drop it instead of
 * failing the whole store.
 *
 * @param {unknown} raw
 * @returns {object | null}
 */
export function normalizeWorkspaceMemoryEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = /** @type {Record<string, unknown>} */ (raw);
  const id = String(source.id ?? '').trim();
  const type = normalizeMemoryType(source.type);
  const key = String(source.key ?? '').trim();
  const value = String(source.value ?? '');
  if (!id || !type || !key || !value.trim()) return null;
  const createdAt = normalizeIsoTimestamp(source.createdAt);
  const updatedAt = normalizeIsoTimestamp(source.updatedAt) || createdAt;
  const expiresAt = normalizeIsoTimestamp(source.expiresAt);
  const entry = {
    id,
    type,
    key: key.length > WORKSPACE_MEMORY_MAX_KEY_LENGTH ? key.slice(0, WORKSPACE_MEMORY_MAX_KEY_LENGTH) : key,
    value: value.length > WORKSPACE_MEMORY_MAX_VALUE_LENGTH ? value.slice(0, WORKSPACE_MEMORY_MAX_VALUE_LENGTH) : value,
    createdAt,
    updatedAt,
    expiresAt,
  };
  const sourceRaw = source.source;
  if (sourceRaw && typeof sourceRaw === 'object' && !Array.isArray(sourceRaw)) {
    const chatId = String(/** @type {Record<string, unknown>} */ (sourceRaw).chatId ?? '').trim();
    const cycleId = String(/** @type {Record<string, unknown>} */ (sourceRaw).cycleId ?? '').trim();
    if (chatId || cycleId) entry.source = { chatId, cycleId };
  }
  return entry;
}

/**
 * @param {object | null | undefined} entry
 * @param {number} [now]
 * @returns {boolean}
 */
export function isWorkspaceMemoryEntryExpired(entry, now = Date.now()) {
  const expiresAt = String(entry?.expiresAt ?? '').trim();
  if (!expiresAt) return false;
  const parsed = Date.parse(expiresAt);
  if (!Number.isFinite(parsed)) return false;
  return parsed <= now;
}

/**
 * @param {unknown} workspaceFolder
 * @returns {object}
 */
function emptyWorkspaceMemoryDocument(workspaceFolder) {
  return {
    v: WORKSPACE_MEMORY_SCHEMA_VERSION,
    workspaceFolder: path.resolve(String(workspaceFolder ?? '').trim() || '.'),
    updatedAt: '',
    revision: 0,
    entries: [],
  };
}

/**
 * Read + normalize one workspace file. A document that is not valid JSON, is not
 * an object, or has a non-array `entries` fails loudly: silently reading it as
 * empty and then rewriting would delete every stored fact. Individual entries
 * that cannot be normalized are dropped.
 *
 * @param {unknown} workspaceFolder
 * @param {{ dataDir?: string }} [options]
 * @returns {{ v: number, workspaceFolder: string, updatedAt: string, revision: number, entries: object[] }}
 */
export function loadWorkspaceMemoryDocument(workspaceFolder, options = {}) {
  const filePath = getWorkspaceMemoryDataPath(workspaceFolder, options);
  const resolvedFolder = path.resolve(String(workspaceFolder ?? '').trim() || '.');
  if (!fs.existsSync(filePath)) return emptyWorkspaceMemoryDocument(resolvedFolder);
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new WorkspaceMemoryCorruptError(
      `Could not read workspace memory (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new WorkspaceMemoryCorruptError(
      `Workspace memory file is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new WorkspaceMemoryCorruptError('Workspace memory file is not an object');
  }
  if (!Array.isArray(parsed.entries)) {
    throw new WorkspaceMemoryCorruptError('Workspace memory file is missing its entries array');
  }
  /** @type {object[]} */
  const entries = [];
  for (const item of parsed.entries) {
    const entry = normalizeWorkspaceMemoryEntry(item);
    if (entry) entries.push(entry);
  }
  const revision = Number(parsed.revision);
  return {
    v: WORKSPACE_MEMORY_SCHEMA_VERSION,
    workspaceFolder: String(parsed.workspaceFolder ?? '').trim() || resolvedFolder,
    updatedAt: String(parsed.updatedAt ?? '').trim(),
    revision: Number.isInteger(revision) && revision >= 0 ? revision : 0,
    entries,
  };
}

/**
 * Live (non-expired) entries for one workspace, newest first. `types` narrows to
 * a subset of `WORKSPACE_MEMORY_TYPES`. Lazy eviction happens here: nothing is
 * written, the expired records are simply never returned.
 *
 * @param {unknown} workspaceFolder
 * @param {{ dataDir?: string, types?: string[], now?: number }} [options]
 * @returns {object[]}
 */
export function listWorkspaceMemory(workspaceFolder, options = {}) {
  const doc = loadWorkspaceMemoryDocument(workspaceFolder, options);
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const requested = Array.isArray(options.types)
    ? options.types.map((type) => normalizeMemoryType(type)).filter(Boolean)
    : [];
  return doc.entries
    .filter((entry) => !isWorkspaceMemoryEntryExpired(entry, now))
    .filter((entry) => requested.length === 0 || requested.includes(entry.type))
    .sort(compareWorkspaceMemoryNewest);
}

/**
 * Cross-process CAS over one workspace document. The read, the mutator and the
 * on-disk revision re-check all run under the shared file lock, so a concurrent
 * cycle can never interleave between the check and the atomic rename.
 *
 * @param {unknown} workspaceFolder
 * @param {(doc: object) => { entries: object[] } | null | false} mutator
 * @param {{ dataDir?: string, now?: number, maxAttempts?: number, lockTimeoutMs?: number }} [options]
 * @returns {{ ok: boolean, doc?: object, reason?: string }}
 */
export function mutateWorkspaceMemoryDocument(workspaceFolder, mutator, options = {}) {
  const filePath = getWorkspaceMemoryDataPath(workspaceFolder, options);
  const maxAttempts = Math.max(1, Number(options.maxAttempts) || MEMORY_DOCUMENT_CAS_MAX_ATTEMPTS);
  const stamp = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  return withWorkspaceWatchersFileLock(() => {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const doc = loadWorkspaceMemoryDocument(workspaceFolder, options);
      const patch = mutator(doc);
      if (patch === null) return { ok: false, reason: 'aborted' };
      if (patch === false) return { ok: false, reason: 'skipped' };
      const nextDoc = {
        v: WORKSPACE_MEMORY_SCHEMA_VERSION,
        workspaceFolder: doc.workspaceFolder,
        updatedAt: new Date(stamp).toISOString(),
        revision: doc.revision + 1,
        entries: Array.isArray(patch.entries) ? patch.entries : doc.entries,
      };
      // Re-read under the same lock: a nested same-process mutation may have
      // advanced the document since `doc` was loaded; then this attempt restarts.
      const onDisk = loadWorkspaceMemoryDocument(workspaceFolder, options);
      if (onDisk.revision !== doc.revision || onDisk.updatedAt !== doc.updatedAt) continue;
      writeJsonAtomic(filePath, nextDoc);
      return { ok: true, doc: nextDoc };
    }
    return { ok: false, reason: 'cas_conflict' };
  }, options);
}

/**
 * Resolve the `expiresAt` timestamp for a write. Priority:
 *   1. `permanent: true` → no expiry (an explicit TTL at the same time conflicts),
 *   2. explicit positive `ttl_ms`/`ttlMs`/`ttl` → now + ttl,
 *   3. a recognized transient blocker key → the 24 h default,
 *   4. anything else (including legacy/unknown keys) → permanent.
 *
 * @param {{ type: string, key: string, ttlRaw?: unknown, permanent?: unknown, now: number }} input
 * @returns {string}
 */
function resolveWorkspaceMemoryExpiresAt(input) {
  const permanent = input.permanent === true;
  const hasTtl = input.ttlRaw != null && input.ttlRaw !== '';
  if (permanent && hasTtl) {
    throw new WorkspaceMemoryValidationError('permanent and ttl_ms are mutually exclusive');
  }
  if (permanent) return '';
  if (hasTtl) {
    const ttlMs = Number(input.ttlRaw);
    if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
      throw new WorkspaceMemoryValidationError('ttl_ms must be a positive integer of milliseconds');
    }
    if (ttlMs > WORKSPACE_MEMORY_MAX_TTL_MS) {
      throw new WorkspaceMemoryValidationError(`ttl_ms must not exceed ${WORKSPACE_MEMORY_MAX_TTL_MS}`);
    }
    return new Date(input.now + ttlMs).toISOString();
  }
  if (input.type === 'blocker') {
    const parsed = parseBlockerKey(input.key);
    if (parsed && isTransientBlockerCause(parsed.cause)) {
      return new Date(input.now + WORKSPACE_MEMORY_DEFAULT_TRANSIENT_BLOCKER_TTL_MS).toISOString();
    }
  }
  return '';
}

/**
 * Store one fact. Entry identity is `type` + normalized key (recognized blocker
 * keys collapse on the scope + cause identity, so two causes of one todo stay
 * separate). A write with an existing identity updates that entry atomically —
 * preserving its `id` and `createdAt`, stamping `updatedAt`, and dropping any
 * older duplicates of the same identity — instead of appending a new row.
 *
 * `ttlMs` (aliases `ttl_ms`, `ttl`) is an optional positive millisecond
 * lifetime; `permanent: true` forces a permanent entry. Recognized transient
 * blocker keys default to 24 h; unknown/legacy keys stay permanent.
 *
 * @param {unknown} workspaceFolder
 * @param {{ type?: string, key?: string, value?: string, ttlMs?: number, ttl_ms?: number, ttl?: number, permanent?: boolean, source?: { chatId?: string, cycleId?: string } }} input
 * @param {{ dataDir?: string, now?: number }} [options]
 * @returns {object} the stored entry
 */
export function addWorkspaceMemory(workspaceFolder, input = {}, options = {}) {
  const type = normalizeMemoryType(input.type);
  if (!type) {
    throw new WorkspaceMemoryValidationError(`type must be one of: ${WORKSPACE_MEMORY_TYPES.join(', ')}`);
  }
  const key = normalizeMemoryKey(input.key);
  if (!key) throw new WorkspaceMemoryValidationError('key is required');
  const storedKey = key.length > WORKSPACE_MEMORY_MAX_KEY_LENGTH ? key.slice(0, WORKSPACE_MEMORY_MAX_KEY_LENGTH) : key;
  const value = String(input.value ?? '');
  if (!value.trim()) throw new WorkspaceMemoryValidationError('value is required');
  const storedValue = value.length > WORKSPACE_MEMORY_MAX_VALUE_LENGTH
    ? value.slice(0, WORKSPACE_MEMORY_MAX_VALUE_LENGTH)
    : value;
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const expiresAt = resolveWorkspaceMemoryExpiresAt({
    type,
    key: storedKey,
    ttlRaw: input.ttlMs ?? input.ttl_ms ?? input.ttl,
    permanent: input.permanent,
    now,
  });
  const source = input.source && typeof input.source === 'object' ? input.source : null;
  const chatId = String(source?.chatId ?? '').trim();
  const cycleId = String(source?.cycleId ?? '').trim();
  const sourceEntry = chatId || cycleId ? { chatId, cycleId } : null;
  const identity = memoryEntryDedupKey({ type, key: storedKey });
  const nowIso = new Date(now).toISOString();
  /** @type {object | null} */
  let stored = null;

  const result = mutateWorkspaceMemoryDocument(workspaceFolder, (doc) => {
    // Expired records are dropped on every write as well, so a workspace that
    // keeps adding facts never hits the cap because of dead entries.
    const live = doc.entries.filter((row) => !isWorkspaceMemoryEntryExpired(row, now));
    const sameTopic = live
      .filter((row) => memoryEntryDedupKey(row) === identity)
      .sort(compareWorkspaceMemoryNewest);
    let next;
    if (sameTopic.length > 0) {
      // Update in place: keep the newest duplicate's id/createdAt, refresh the
      // payload and drop the remaining historical duplicates of this identity.
      const newest = sameTopic[0];
      stored = {
        id: newest.id,
        type,
        key: newest.key,
        value: storedValue,
        createdAt: newest.createdAt,
        updatedAt: nowIso,
        expiresAt,
      };
      if (sourceEntry) stored.source = sourceEntry;
      const duplicateIds = new Set(sameTopic.slice(1).map((row) => row.id));
      next = live
        .filter((row) => !duplicateIds.has(row.id))
        .map((row) => (row.id === newest.id ? stored : row));
    } else {
      stored = {
        id: randomUUID(),
        type,
        key: storedKey,
        value: storedValue,
        createdAt: nowIso,
        updatedAt: nowIso,
        expiresAt,
      };
      if (sourceEntry) stored.source = sourceEntry;
      next = [...live, stored];
    }
    if (next.length > WORKSPACE_MEMORY_MAX_ENTRIES) {
      const overflow = next.length - WORKSPACE_MEMORY_MAX_ENTRIES;
      // The entry just written is the most recently updated one and must survive
      // its own write; candidates are sorted by updatedAt (createdAt fallback)
      // with the lower id losing an exact tie.
      const doomed = new Set(
        next
          .filter((row) => !stored || row.id !== stored.id)
          .sort(compareWorkspaceMemoryOldestFirst)
          .slice(0, overflow)
          .map((row) => row.id),
      );
      next = next.filter((row) => !doomed.has(row.id));
    }
    return { entries: next };
  }, options);
  if (!result.ok) {
    throw new WorkspaceMemoryCorruptError(`Could not store the memory entry (${result.reason || 'unknown'})`);
  }
  if (!stored) {
    throw new WorkspaceMemoryCorruptError('Could not store the memory entry (evicted)');
  }
  return stored;
}

/**
 * Delete one entry by id.
 *
 * @param {unknown} workspaceFolder
 * @param {unknown} id
 * @param {{ dataDir?: string, now?: number }} [options]
 * @returns {{ deleted: boolean, entry: object | null }}
 */
export function deleteWorkspaceMemory(workspaceFolder, id, options = {}) {
  const target = String(id ?? '').trim();
  if (!target) throw new WorkspaceMemoryValidationError('id is required');
  let removed = null;
  const result = mutateWorkspaceMemoryDocument(workspaceFolder, (doc) => {
    const found = doc.entries.find((row) => row.id === target) || null;
    if (!found) return null;
    removed = found;
    return { entries: doc.entries.filter((row) => row.id !== target) };
  }, options);
  if (result.reason === 'aborted') return { deleted: false, entry: null };
  if (!result.ok) {
    throw new WorkspaceMemoryCorruptError(`Could not delete the memory entry (${result.reason || 'unknown'})`);
  }
  return { deleted: removed !== null, entry: removed };
}

/**
 * Remove every expired entry and rewrite the file. Returns the removed count.
 * `listWorkspaceMemory` already hides expired entries; this is only for callers
 * that want the on-disk file compacted too.
 *
 * @param {unknown} workspaceFolder
 * @param {{ dataDir?: string, now?: number }} [options]
 * @returns {{ removed: number, total: number }}
 */
export function pruneWorkspaceMemory(workspaceFolder, options = {}) {
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  let removed = 0;
  const result = mutateWorkspaceMemoryDocument(workspaceFolder, (doc) => {
    const live = doc.entries.filter((row) => !isWorkspaceMemoryEntryExpired(row, now));
    removed = doc.entries.length - live.length;
    if (removed === 0) return false;
    return { entries: live };
  }, options);
  if (result.reason === 'skipped') {
    return { removed: 0, total: listWorkspaceMemory(workspaceFolder, { ...options, now }).length };
  }
  if (!result.ok) {
    throw new WorkspaceMemoryCorruptError(`Could not prune workspace memory (${result.reason || 'unknown'})`);
  }
  return { removed, total: result.doc.entries.length };
}
