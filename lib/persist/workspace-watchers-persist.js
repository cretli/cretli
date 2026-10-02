/**
 * Durable per-workspace watcher state for the Workspace Watcher (stage A).
 *
 * `data/workspace-watchers.json` shape:
 *   { v: 1, updatedAt, revision, items: { "<normalizedWorkspaceFolder>": row } }
 *
 * The map is keyed by the normalized workspace folder so a lookup never scans
 * rows. Stage A ticks only in `observe`. `off` and stored `autopilot` are inert
 * until a later stage enables autonomous cycles.
 *
 * Each row carries the singleton lease, policy, bounded decision log and the
 * future-cycle fields so later stages can grow into the same file without a
 * migration.
 *
 * Writers serialize on `workspace-watchers.lock.sqlite` next to the document:
 * an intentionally empty database whose only job is to hold SQLite's write
 * lock across the revision check and the rename, so a crashed writer cannot
 * keep the store locked and a live writer cannot be robbed of the lock.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { writeJsonAtomic } from './atomic-write.js';
import { resolveDataPath } from '../runtime-paths.js';
import { normalizeDelegationWorkspaceKey } from '../delegation-workspace-guard.js';

export const WORKSPACE_WATCHERS_SCHEMA_VERSION = 1;
export const WORKSPACE_WATCHER_MODES = Object.freeze(['off', 'observe', 'autopilot']);
export const WORKSPACE_WATCHER_TICK_MODES = Object.freeze(['observe']);
export const WORKSPACE_WATCHER_MAX_DECISIONS = 50;
export const WORKSPACE_WATCHER_DEFAULT_LEASE_TTL_MS = 30_000;
export const WORKSPACE_WATCHER_PICK_ROLES = Object.freeze(['plan', 'implement', 'review']);
/** How long a writer waits for the cross-process document lock. */
export const WORKSPACE_WATCHERS_LOCK_TIMEOUT_MS = 5_000;
/** Lock database: a namespace for SQLite write locks, never for watcher data. */
const WORKSPACE_WATCHERS_LOCK_DB_NAME = 'workspace-watchers.lock.sqlite';
const WORKSPACE_WATCHERS_LOCK_BUSY_ERRCODE = 5;
const WORKSPACE_WATCHERS_LOCK_BACKOFF_MIN_MS = 2;
const WORKSPACE_WATCHERS_LOCK_BACKOFF_MAX_MS = 50;
const WATCHER_DOCUMENT_CAS_MAX_ATTEMPTS = 8;

export class WorkspaceWatchersCorruptError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'WorkspaceWatchersCorruptError';
    this.code = 'WORKSPACE_WATCHERS_CORRUPT';
  }
}

export class WorkspaceWatchersLockError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'WorkspaceWatchersLockError';
    this.code = 'WORKSPACE_WATCHERS_LOCKED';
  }
}

/**
 * @param {string} raw
 * @returns {boolean}
 */
function isDriveLetterPath(raw) {
  return /^[a-zA-Z]:[/\\]/.test(String(raw || '').trim());
}

/**
 * Canonical workspace folder key (resolve + realpath when possible), with slash
 * normalization so watcher rows and delegation snapshots stay aligned.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeWorkspaceFolder(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (isDriveLetterPath(raw) && process.platform !== 'win32') {
    const collapsed = raw.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
    const trimmed = collapsed.replace(/\/+$/, '');
    return trimmed || '/';
  }
  const canonical = normalizeDelegationWorkspaceKey(raw);
  if (!canonical) {
    const collapsed = raw.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
    const trimmed = collapsed.replace(/\/+$/, '');
    return trimmed || '/';
  }
  const normalized = canonical.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  return normalized || '/';
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function normalizeCount(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
function normalizeStringList(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {string[]} */
  const out = [];
  for (const item of raw) {
    const value = String(item ?? '').trim();
    if (value && !out.includes(value)) out.push(value);
  }
  return out;
}

/**
 * @returns {object}
 */
export function defaultWorkspaceWatcherPolicy() {
  return {
    maxParallel: 1,
    maxCyclesPerDay: 20,
    cooldownMs: 60_000,
    requirePlanApproval: true,
    allowedHarnesses: [],
    pickRoles: [...WORKSPACE_WATCHER_PICK_ROLES],
    quietHours: { start: '', end: '' },
  };
}

/**
 * @param {unknown} raw
 * @returns {object}
 */
export function normalizeWorkspaceWatcherPolicy(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? /** @type {Record<string, unknown>} */ (raw)
    : {};
  const quiet = source.quietHours && typeof source.quietHours === 'object' && !Array.isArray(source.quietHours)
    ? /** @type {Record<string, unknown>} */ (source.quietHours)
    : {};
  const roles = normalizeStringList(source.pickRoles).filter((role) => WORKSPACE_WATCHER_PICK_ROLES.includes(role));
  return {
    maxParallel: Math.max(1, normalizeCount(source.maxParallel, 1)),
    maxCyclesPerDay: normalizeCount(source.maxCyclesPerDay, 20),
    cooldownMs: normalizeCount(source.cooldownMs, 60_000),
    requirePlanApproval: source.requirePlanApproval !== false,
    allowedHarnesses: normalizeStringList(source.allowedHarnesses),
    pickRoles: roles.length ? roles : [...WORKSPACE_WATCHER_PICK_ROLES],
    quietHours: {
      start: String(quiet.start ?? '').trim(),
      end: String(quiet.end ?? '').trim(),
    },
  };
}

/**
 * @param {unknown} raw
 * @returns {{ ownerPid: number, token: string, expiresAt: string }}
 */
export function normalizeWorkspaceWatcherLease(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? /** @type {Record<string, unknown>} */ (raw)
    : {};
  const pid = Number(source.ownerPid);
  return {
    ownerPid: Number.isInteger(pid) && pid > 0 ? pid : 0,
    token: String(source.token ?? '').trim(),
    expiresAt: String(source.expiresAt ?? '').trim(),
  };
}

/**
 * @param {unknown} lease
 * @param {number} [now]
 * @returns {boolean}
 */
export function isWorkspaceWatcherLeaseActive(lease, now = Date.now()) {
  const normalized = normalizeWorkspaceWatcherLease(lease);
  if (!normalized.token) return false;
  const expiresAt = Date.parse(normalized.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

/**
 * Acquire or renew the single-writer lease. A live lease owned by a different
 * token is never stolen; an expired lease is.
 *
 * @param {object} row
 * @param {{ ownerPid?: number, token?: string, ttlMs?: number, now?: number }} [options]
 * @returns {{ acquired: boolean, renewed: boolean, lease: { ownerPid: number, token: string, expiresAt: string } }}
 */
export function acquireWorkspaceWatcherLease(row, options = {}) {
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const token = String(options.token ?? '').trim();
  const current = normalizeWorkspaceWatcherLease(row?.lease);
  if (!token) {
    return { acquired: false, renewed: false, lease: current };
  }
  if (isWorkspaceWatcherLeaseActive(current, now) && current.token !== token) {
    return { acquired: false, renewed: false, lease: current };
  }
  const ttlMs = Number.isFinite(options.ttlMs) && Number(options.ttlMs) > 0
    ? Number(options.ttlMs)
    : WORKSPACE_WATCHER_DEFAULT_LEASE_TTL_MS;
  const ownerPid = Number.isInteger(options.ownerPid) && Number(options.ownerPid) > 0
    ? Number(options.ownerPid)
    : process.pid;
  return {
    acquired: true,
    renewed: isWorkspaceWatcherLeaseActive(current, now) && current.token === token,
    lease: {
      ownerPid,
      token,
      expiresAt: new Date(now + ttlMs).toISOString(),
    },
  };
}

/**
 * Drop the lease only when the caller still owns it.
 *
 * @param {object} row
 * @param {{ token?: string }} [options]
 * @returns {{ ownerPid: number, token: string, expiresAt: string }}
 */
export function releaseWorkspaceWatcherLease(row, options = {}) {
  const current = normalizeWorkspaceWatcherLease(row?.lease);
  const token = String(options.token ?? '').trim();
  if (!token || current.token !== token) return current;
  return { ownerPid: 0, token: '', expiresAt: '' };
}

/**
 * @param {unknown} raw
 * @returns {{ at: string, kind: string, reason: string, readyTodoCount: number, activeAgentCount: number, shouldNotify: boolean, nextTodoId: string } | null}
 */
export function normalizeWorkspaceWatcherDecision(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = /** @type {Record<string, unknown>} */ (raw);
  const at = String(source.at ?? '').trim();
  const kind = String(source.kind ?? '').trim();
  if (!at || !kind) return null;
  return {
    at,
    kind,
    reason: String(source.reason ?? '').trim(),
    readyTodoCount: normalizeCount(source.readyTodoCount, 0),
    activeAgentCount: normalizeCount(source.activeAgentCount, 0),
    shouldNotify: source.shouldNotify === true,
    // Observation only: which todo *would* be claimed. It never changes the
    // todo status; the claim itself is an explicit API call, not a tick.
    nextTodoId: String(source.nextTodoId ?? '').trim(),
  };
}

/**
 * @param {unknown} raw
 * @returns {object[]}
 */
function normalizeDecisionLog(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => normalizeWorkspaceWatcherDecision(entry))
    .filter(Boolean)
    .slice(-WORKSPACE_WATCHER_MAX_DECISIONS);
}

/**
 * @param {unknown} raw
 * @returns {{ todoIds: string[], startedAt: string, chatId: string } | null}
 */
function normalizeActiveCycle(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = /** @type {Record<string, unknown>} */ (raw);
  const todoIds = normalizeStringList(source.todoIds);
  const startedAt = String(source.startedAt ?? '').trim();
  const chatId = String(source.chatId ?? '').trim();
  const runId = String(source.runId ?? '').trim();
  if (!todoIds.length && !startedAt && !chatId) return null;
  return { todoIds, startedAt, chatId, runId };
}

/**
 * @param {unknown} raw
 * @returns {Record<string, number>}
 */
function normalizeFailures(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  /** @type {Record<string, number>} */
  const out = {};
  for (const [key, value] of Object.entries(/** @type {Record<string, unknown>} */ (raw))) {
    const todoId = String(key ?? '').trim();
    const count = normalizeCount(value, 0);
    if (todoId && count > 0) out[todoId] = count;
  }
  return out;
}

/**
 * @param {unknown} raw
 * @returns {object | null}
 */
export function normalizeWorkspaceWatcherRow(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = /** @type {Record<string, unknown>} */ (raw);
  const workspaceFolder = normalizeWorkspaceFolder(source.workspaceFolder);
  if (!workspaceFolder) return null;
  const rawMode = String(source.mode ?? '').trim().toLowerCase();
  const mode = WORKSPACE_WATCHER_MODES.includes(rawMode)
    ? rawMode
    : rawMode
      ? 'off'
      : source.enabled === true
        ? 'observe'
        : 'off';
  return {
    workspaceFolder,
    mode,
    enabled: mode !== 'off',
    orchestratorChatId: String(source.orchestratorChatId ?? '').trim(),
    lease: normalizeWorkspaceWatcherLease(source.lease),
    lastTickAt: String(source.lastTickAt ?? '').trim(),
    lastCycleAt: String(source.lastCycleAt ?? '').trim(),
    cycleCount: normalizeCount(source.cycleCount, 0),
    activeCycle: normalizeActiveCycle(source.activeCycle),
    policy: normalizeWorkspaceWatcherPolicy(source.policy),
    stopReason: String(source.stopReason ?? '').trim(),
    failures: normalizeFailures(source.failures),
    decisions: normalizeDecisionLog(source.decisions),
    updatedAt: String(source.updatedAt ?? '').trim(),
  };
}

/**
 * @param {{ dataDir?: string }} [options]
 * @returns {string}
 */
function dataFilePath(options = {}) {
  const configured = String(options.dataDir ?? '').trim();
  const dir = configured || resolveDataPath();
  return path.join(dir, 'workspace-watchers.json');
}

/**
 * @param {{ dataDir?: string }} [options]
 * @returns {string}
 */
export function getWorkspaceWatchersDataPath(options = {}) {
  return dataFilePath(options);
}

/**
 * @param {string} filePath
 * @returns {void}
 */
function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Re-entrant per-document cross-process mutex.
 *
 * The revision check and the write must not interleave with another process,
 * otherwise two writers can both accept the same revision and the loser
 * silently drops the winner's rows (lost update over the whole map).
 *
 * The mutex is SQLite's write lock. A dedicated database in the data dir is
 * opened only to run `BEGIN IMMEDIATE` ... `COMMIT` around the critical
 * section: BEGIN IMMEDIATE takes the RESERVED lock on that file and keeps it
 * until the transaction ends, so exactly one process is inside at a time and a
 * second one is refused with SQLITE_BUSY. That lock is an OS record lock on an
 * open file descriptor, so a holder that crashes or is killed loses it in the
 * kernel and the next acquirer rolls back the journal by itself. There is no
 * stale-lock detector, no grace period and no owner token to re-check, because
 * nothing here ever removes lock state: a lock kept in a file has to be
 * deleted to be recovered, and in the window between reading an owner token
 * and unlinking it the lock can already belong to a fresh owner.
 *
 * The document CAS check runs inside the same critical section as a second
 * line of defence against a nested mutation in this process.
 */

/** @type {Map<string, DatabaseSync>} */
const watcherLockDbs = new Map();

/** @type {Map<string, number>} */
const heldWatcherLocks = new Map();

/**
 * @param {string} documentPath
 * @returns {string}
 */
function watcherLockDbPath(documentPath) {
  return path.join(path.dirname(documentPath), WORKSPACE_WATCHERS_LOCK_DB_NAME);
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function describeWatcherLockError(error) {
  return error instanceof Error ? error.message : String(error ?? 'unknown error');
}

/**
 * SQLITE_BUSY (5) is the "someone else is inside" answer; `code` is
 * ERR_SQLITE_ERROR for every SQLite failure, so the errcode decides.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
function isWatcherLockBusyError(error) {
  if (!error || typeof error !== 'object') return false;
  const source = /** @type {{ errcode?: unknown, message?: unknown }} */ (error);
  if (Number(source.errcode) === WORKSPACE_WATCHERS_LOCK_BUSY_ERRCODE) return true;
  return /database is locked/i.test(String(source.message ?? ''));
}

/**
 * Open the lock database once per path. SQLite's own busy handler is switched
 * off because this call owns the waiting: the deadline is `lockTimeoutMs`.
 *
 * @param {string} lockDbPath
 * @returns {DatabaseSync}
 */
function openWatcherLockDb(lockDbPath) {
  const cached = watcherLockDbs.get(lockDbPath);
  if (cached) return cached;
  ensureDir(lockDbPath);
  let database = null;
  try {
    database = new DatabaseSync(lockDbPath);
    database.exec('PRAGMA busy_timeout = 0;');
  } catch (error) {
    if (database) {
      try {
        database.close();
      } catch {
        // The connection is already unusable.
      }
    }
    throw new WorkspaceWatchersLockError(
      `Could not open the workspace watcher store lock (${lockDbPath}: ${describeWatcherLockError(error)})`,
    );
  }
  watcherLockDbs.set(lockDbPath, database);
  return database;
}

/**
 * Forget a connection we can no longer reason about. Closing it returns the
 * file descriptor to the OS, which drops the write lock along with it.
 *
 * @param {string} lockDbPath
 * @returns {void}
 */
function dropWatcherLockDb(lockDbPath) {
  const database = watcherLockDbs.get(lockDbPath);
  watcherLockDbs.delete(lockDbPath);
  if (!database) return;
  try {
    database.close();
  } catch {
    // Already closed; the lock left with the descriptor.
  }
}

/**
 * @param {number} ms
 * @returns {void}
 */
function sleepWatcherLock(ms) {
  if (!(ms > 0)) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Begin the transaction that *is* the lock and hand back the release callback.
 * Waiting is this call's job: another process inside the critical section is
 * answered with SQLITE_BUSY, never with a stolen lock.
 *
 * @param {DatabaseSync} database
 * @param {string} lockDbPath
 * @param {{ lockTimeoutMs?: number }} options
 * @returns {() => void}
 */
function acquireWatcherLock(database, lockDbPath, options) {
  const configuredTimeout = Number(options.lockTimeoutMs);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout >= 0
    ? configuredTimeout
    : WORKSPACE_WATCHERS_LOCK_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let backoff = WORKSPACE_WATCHERS_LOCK_BACKOFF_MIN_MS;
  for (;;) {
    try {
      database.exec('BEGIN IMMEDIATE');
      break;
    } catch (error) {
      if (!isWatcherLockBusyError(error)) {
        dropWatcherLockDb(lockDbPath);
        throw new WorkspaceWatchersLockError(
          `Could not acquire the workspace watcher store lock (${lockDbPath}: ${describeWatcherLockError(error)})`,
        );
      }
      if (Date.now() >= deadline) {
        throw new WorkspaceWatchersLockError(
          `Timed out waiting for the workspace watcher store lock (${lockDbPath}).`,
        );
      }
      sleepWatcherLock(backoff);
      backoff = Math.min(WORKSPACE_WATCHERS_LOCK_BACKOFF_MAX_MS, Math.round(backoff * 1.6));
    }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      database.exec('COMMIT');
    } catch (error) {
      // Nothing was written in this database, so a commit failure means the
      // connection itself is unusable. Closing it drops the lock for good.
      dropWatcherLockDb(lockDbPath);
      throw new WorkspaceWatchersLockError(
        `Could not release the workspace watcher store lock (${lockDbPath}: ${describeWatcherLockError(error)})`,
      );
    }
  };
}

/**
 * Run `work` while holding the cross-process lock of the watcher document.
 * Re-entrant inside one process so a mutator may nest another store mutation.
 *
 * @template T
 * @param {() => T} work
 * @param {{ dataDir?: string, lockTimeoutMs?: number }} [options]
 * @returns {T}
 */
export function withWorkspaceWatchersFileLock(work, options = {}) {
  const filePath = dataFilePath(options);
  const held = heldWatcherLocks.get(filePath);
  if (held != null) {
    heldWatcherLocks.set(filePath, held + 1);
    try {
      return work();
    } finally {
      const next = (heldWatcherLocks.get(filePath) || 1) - 1;
      if (next > 0) heldWatcherLocks.set(filePath, next);
      else heldWatcherLocks.delete(filePath);
    }
  }
  const lockDbPath = watcherLockDbPath(filePath);
  const release = acquireWatcherLock(openWatcherLockDb(lockDbPath), lockDbPath, options);
  heldWatcherLocks.set(filePath, 1);
  try {
    return work();
  } finally {
    heldWatcherLocks.delete(filePath);
    release();
  }
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function normalizeDocumentRevision(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return 0;
  return n;
}

/**
 * @param {{ updatedAt?: string, revision?: number }} doc
 * @returns {{ updatedAt: string, revision: number }}
 */
export function workspaceWatchersDocumentCasToken(doc) {
  return {
    updatedAt: String(doc?.updatedAt ?? '').trim(),
    revision: normalizeDocumentRevision(doc?.revision),
  };
}

/**
 * @returns {{ v: number, updatedAt: string, revision: number, items: Record<string, object> }}
 */
function emptyDocument() {
  return { v: WORKSPACE_WATCHERS_SCHEMA_VERSION, updatedAt: '', revision: 0, items: {} };
}

/**
 * The map key of a damaged file is untrusted input, so control characters are
 * flattened and the text is length-capped before it reaches an error message.
 *
 * @param {string} key
 * @returns {string}
 */
function describeWatcherItemKey(key) {
  const raw = String(key ?? '');
  let flat = '';
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    flat += code < 0x20 || code === 0x7f ? ' ' : raw[i];
  }
  return flat.length > 120 ? `${flat.slice(0, 117)}...` : flat;
}

/**
 * Every record of the stored document must be representable: a row that will
 * not normalize is reported instead of being skipped, because the next save
 * would write the loaded rows back and drop the unreadable one silently.
 *
 * @param {{ dataDir?: string }} [options]
 * @returns {{ v: number, updatedAt: string, revision: number, items: Record<string, object> }}
 */
export function loadWorkspaceWatchersDocument(options = {}) {
  const filePath = dataFilePath(options);
  ensureDir(filePath);
  if (!fs.existsSync(filePath)) return emptyDocument();
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new WorkspaceWatchersCorruptError(
      `Could not read workspace watcher store (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new WorkspaceWatchersCorruptError(
      `Workspace watcher file is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new WorkspaceWatchersCorruptError('Workspace watcher file is not an object');
  }
  const rawItems = /** @type {Record<string, unknown>} */ (parsed).items;
  if (rawItems != null && (typeof rawItems !== 'object' || Array.isArray(rawItems))) {
    throw new WorkspaceWatchersCorruptError('Workspace watcher items must be an object keyed by workspace folder');
  }
  /** @type {Record<string, object>} */
  const items = {};
  /** @type {string[]} */
  const unusable = [];
  for (const [key, value] of Object.entries(rawItems || {})) {
    const record = value && typeof value === 'object' && !Array.isArray(value)
      ? /** @type {Record<string, unknown>} */ (value)
      : null;
    const row = record
      ? normalizeWorkspaceWatcherRow({ ...record, workspaceFolder: record.workspaceFolder || key })
      : null;
    if (!row) {
      unusable.push(record
        ? `"${describeWatcherItemKey(key)}" has no usable workspace folder`
        : `"${describeWatcherItemKey(key)}" is ${value === null ? 'null' : `a ${typeof value}`}, not a row`);
      continue;
    }
    if (items[row.workspaceFolder]) {
      throw new WorkspaceWatchersCorruptError(
        `Workspace watcher file has two records for "${row.workspaceFolder}" under different keys; loading one would drop the other`,
      );
    }
    items[row.workspaceFolder] = row;
  }
  if (unusable.length > 0) {
    throw new WorkspaceWatchersCorruptError(
      `Workspace watcher file has ${unusable.length} record(s) that are not watcher rows `
      + `(${unusable.slice(0, 3).join(', ')}); refusing to rewrite it over the next save`,
    );
  }
  return {
    v: WORKSPACE_WATCHERS_SCHEMA_VERSION,
    updatedAt: String(parsed.updatedAt ?? '').trim(),
    revision: normalizeDocumentRevision(parsed.revision),
    items,
  };
}

/**
 * @param {{ dataDir?: string }} [options]
 * @returns {object[]}
 */
export function loadWorkspaceWatchers(options = {}) {
  const doc = loadWorkspaceWatchersDocument(options);
  return Object.keys(doc.items)
    .sort()
    .map((key) => doc.items[key]);
}

/**
 * @param {unknown} workspaceFolder
 * @param {{ dataDir?: string }} [options]
 * @returns {object | null}
 */
export function getWorkspaceWatcher(workspaceFolder, options = {}) {
  const key = normalizeWorkspaceFolder(workspaceFolder);
  if (!key) return null;
  return loadWorkspaceWatchersDocument(options).items[key] || null;
}

/**
 * Revision check plus write under the cross-process lock. The lock makes the
 * check meaningful: without it another process can pass the same check and
 * rename its own document over this one between the read and the write.
 *
 * @param {{ updatedAt: string, revision: number }} expectedCas
 * @param {{ v: number, updatedAt: string, revision: number, items: Record<string, object> }} nextDoc
 * @param {{ dataDir?: string, lockTimeoutMs?: number }} [options]
 * @returns {boolean}
 */
function compareAndSaveWorkspaceWatchersDocument(expectedCas, nextDoc, options = {}) {
  return withWorkspaceWatchersFileLock(() => {
    const filePath = dataFilePath(options);
    ensureDir(filePath);
    const expectedUpdatedAt = String(expectedCas.updatedAt || '').trim();
    const expectedRevision = normalizeDocumentRevision(expectedCas.revision);
    if (fs.existsSync(filePath)) {
      let onDiskUpdatedAt = '';
      let onDiskRevision = 0;
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        onDiskUpdatedAt = String(parsed?.updatedAt ?? '').trim();
        onDiskRevision = normalizeDocumentRevision(parsed?.revision);
      } catch {
        return false;
      }
      if (onDiskRevision !== expectedRevision) return false;
      if (onDiskUpdatedAt !== expectedUpdatedAt) return false;
    } else if (expectedUpdatedAt || expectedRevision > 0) {
      return false;
    }
    writeJsonAtomic(filePath, {
      v: WORKSPACE_WATCHERS_SCHEMA_VERSION,
      updatedAt: nextDoc.updatedAt,
      revision: normalizeDocumentRevision(nextDoc.revision),
      items: nextDoc.items,
    });
    return true;
  }, options);
}

/**
 * Document-level CAS for map-wide changes (for example remove). The whole
 * read-modify-write runs under the cross-process lock so a concurrent row
 * mutation cannot drop or resurrect a map entry.
 *
 * @param {(doc: { v: number, updatedAt: string, revision: number, items: Record<string, object> }) => { items: Record<string, object> } | null | false} mutator
 * @param {{ dataDir?: string, maxAttempts?: number, lockTimeoutMs?: number }} [options]
 * @returns {{ ok: boolean, doc?: object, reason?: string }}
 */
export function mutateWorkspaceWatchersDocument(mutator, options = {}) {
  const maxAttempts = Math.max(1, Number(options.maxAttempts) || WATCHER_DOCUMENT_CAS_MAX_ATTEMPTS);
  return withWorkspaceWatchersFileLock(() => {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const doc = loadWorkspaceWatchersDocument(options);
      const expectedCas = workspaceWatchersDocumentCasToken(doc);
      const patch = mutator(doc);
      if (patch === null) return { ok: false, reason: 'aborted' };
      if (patch === false) return { ok: false, reason: 'skipped' };
      const nextDoc = {
        v: WORKSPACE_WATCHERS_SCHEMA_VERSION,
        updatedAt: new Date().toISOString(),
        revision: expectedCas.revision + 1,
        items: patch.items,
      };
      if (!compareAndSaveWorkspaceWatchersDocument(expectedCas, nextDoc, options)) continue;
      return { ok: true, doc: nextDoc };
    }
    return { ok: false, reason: 'cas_conflict' };
  }, options);
}

/**
 * Read-modify-write one row with document-level CAS so parallel processes cannot
 * clobber the whole map or steal an active lease slot. The load, the mutator and
 * the write all run under the cross-process lock, so a competing process never
 * observes a half-updated document and a CAS conflict can only come from a
 * nested same-process mutation.
 *
 * @param {unknown} workspaceFolder
 * @param {(ctx: { row: object, docUpdatedAt: string, docRevision: number }) => object | null | false} mutator
 * @param {{ dataDir?: string, maxAttempts?: number, lockTimeoutMs?: number }} [options]
 * @returns {{ ok: boolean, row?: object, reason?: string }}
 */
export function mutateWorkspaceWatcherRow(workspaceFolder, mutator, options = {}) {
  const key = normalizeWorkspaceFolder(workspaceFolder);
  if (!key) throw new WorkspaceWatchersCorruptError('workspaceFolder is required');
  const maxAttempts = Math.max(1, Number(options.maxAttempts) || WATCHER_DOCUMENT_CAS_MAX_ATTEMPTS);
  return withWorkspaceWatchersFileLock(() => {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const doc = loadWorkspaceWatchersDocument(options);
      const expectedCas = workspaceWatchersDocumentCasToken(doc);
      const current = doc.items[key] || normalizeWorkspaceWatcherRow({ workspaceFolder: key });
      if (!current) return { ok: false, reason: 'invalid_row' };
      const patch = mutator({ row: current, docUpdatedAt: expectedCas.updatedAt, docRevision: expectedCas.revision });
      if (patch === null) return { ok: false, reason: 'aborted' };
      if (patch === false) return { ok: false, reason: 'skipped' };
      const merged = normalizeWorkspaceWatcherRow({
        ...current,
        ...patch,
        workspaceFolder: key,
        updatedAt: new Date().toISOString(),
      });
      if (!merged) return { ok: false, reason: 'invalid_row' };
      const nextDoc = {
        v: WORKSPACE_WATCHERS_SCHEMA_VERSION,
        updatedAt: new Date().toISOString(),
        revision: expectedCas.revision + 1,
        items: { ...doc.items, [key]: merged },
      };
      if (!compareAndSaveWorkspaceWatchersDocument(expectedCas, nextDoc, options)) continue;
      return { ok: true, row: merged };
    }
    return { ok: false, reason: 'cas_conflict' };
  }, options);
}

/**
 * Merge a patch into the row for one workspace, creating the row (mode off)
 * when it does not exist yet.
 *
 * @param {unknown} workspaceFolder
 * @param {object} [patch]
 * @param {{ dataDir?: string }} [options]
 * @returns {object}
 */
export function upsertWorkspaceWatcher(workspaceFolder, patch = {}, options = {}) {
  const key = normalizeWorkspaceFolder(workspaceFolder || patch?.workspaceFolder);
  if (!key) throw new WorkspaceWatchersCorruptError('workspaceFolder is required');
  const nextPatch = { ...patch };
  if (nextPatch.mode == null && typeof nextPatch.enabled === 'boolean') {
    nextPatch.mode = nextPatch.enabled ? 'observe' : 'off';
  }
  const result = mutateWorkspaceWatcherRow(key, ({ row }) => {
    const merged = normalizeWorkspaceWatcherRow({
      ...row,
      ...nextPatch,
      workspaceFolder: key,
    });
    if (!merged) return false;
    return merged;
  }, options);
  if (!result.ok || !result.row) {
    throw new WorkspaceWatchersCorruptError(String(result.reason || 'cas_conflict'));
  }
  return result.row;
}

/**
 * Append one decision-log entry (bounded). Returns the updated row, or null
 * when no watcher row exists for the workspace.
 *
 * @param {unknown} workspaceFolder
 * @param {object} decision
 * @param {{ dataDir?: string }} [options]
 * @returns {object | null}
 */
export function appendWorkspaceWatcherDecision(workspaceFolder, decision, options = {}) {
  const key = normalizeWorkspaceFolder(workspaceFolder);
  if (!key) return null;
  if (!getWorkspaceWatcher(key, options)) return null;
  const entry = normalizeWorkspaceWatcherDecision(decision);
  if (!entry) return getWorkspaceWatcher(key, options);
  const result = mutateWorkspaceWatcherRow(key, ({ row }) => ({
    decisions: [...row.decisions, entry].slice(-WORKSPACE_WATCHER_MAX_DECISIONS),
  }), options);
  if (!result.ok || !result.row) return null;
  return result.row;
}

/**
 * @param {unknown} workspaceFolder
 * @param {{ dataDir?: string }} [options]
 * @returns {boolean}
 */
export function removeWorkspaceWatcher(workspaceFolder, options = {}) {
  const key = normalizeWorkspaceFolder(workspaceFolder);
  if (!key) return false;
  const result = mutateWorkspaceWatchersDocument((doc) => {
    if (!doc.items[key]) return false;
    const items = { ...doc.items };
    delete items[key];
    return { items };
  }, options);
  return result.ok === true;
}
