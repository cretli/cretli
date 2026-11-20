/**
 * Sidecar-aware legacy backend used under the `legacy-rollback` marker.
 *
 * It wraps the plain legacy JSON backend and honours what the rollback export carries:
 * - startup verifies the pinned manifest, the export documents and receipts, and that every live
 *   document still hashes as the last committed state (`assertRollbackExportMatchesMarker`);
 * - fencing: the opener passes a fence epoch that must be strictly above the recorded high-water mark;
 *   the mark is raised to it and stays monotonic. Every mutation re-checks the mark immediately before
 *   it applies and refuses when a newer owner raised it (`todos_rollback_fenced`);
 * - receipts: EVERY facade mutation goes through one choke point (`guarded`). When a command identity
 *   is in scope (`withTodosCommand`), a recorded receipt returns its stored result without re-applying,
 *   the same id with another digest is refused and a new result is recorded after the mutation. A mutation
 *   without a command identity simply has no ledger entry;
 * - atomicity: open, fence publication and each (fence check, mutation, ledger write) run inside one
 *   cross-process lockfile section, so a lower fence can never overwrite a higher one and an older
 *   owner cannot pass its check and then write after a newer fence was published.
 * After each mutation the live document hashes are re-recorded, so an unrelated writer is detected at
 * the next start. A crash between a document write and that record fails closed at the next start.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createLegacyJsonTodosBackend } from './todos-store.js';
import { TodosBackendError } from './todos-backend-marker.js';
import {
  assertRollbackExportMatchesMarker, hashLiveTodoFiles, readRollbackState, writeRollbackState,
} from '../storage/todos-migration.js';

const MUTATIONS = ['addTodo', 'updateTodo', 'deleteTodo', 'writeTodoReview', 'writeTodoReviewBatch', 'closeTodoLeafIfEligible', 'commitWatcherTodoCommand', 'moveTodo'];
const LOCK_FILE = 'todos-rollback-state.lock';
const LOCK_TIMEOUT_MS = 15_000;
/** Age after which an unparseable (damaged) lock file may be cleared; never applied to a valid lock. */
const LOCK_STALE_MS = 30_000;

/** @type {AsyncLocalStorage<{ datasetGeneration?: string, commandId: string, requestDigest: string, seq: number }>} */
const commandContext = new AsyncLocalStorage();

/**
 * Give every facade mutation started inside `fn` a command identity (`commandId` + `requestDigest`).
 * The rollback backend replays a recorded receipt instead of applying again.
 *
 * @template T
 * @param {{ datasetGeneration?: string, commandId: string, requestDigest: string }} command
 * @param {() => T} fn
 * @returns {T}
 */
export function withTodosCommand(command, fn) {
  return commandContext.run({ ...command, seq: 0 }, fn);
}

/** @param {number} pid @returns {boolean} */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {any} */ (error)?.code === 'EPERM';
  }
}

/**
 * Kernel start time of a process (Linux `/proc/<pid>/stat` field 22), or null when unavailable. It tells a
 * live owner from an unrelated process that reused its PID.
 *
 * @param {number} pid
 * @returns {string | null}
 */
function processStartId(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch {
    return null;
  }
}

/**
 * @param {string} file
 * @returns {{ raw: string, owner: { pid: number, token: string, startId: string | null } | null } | null} null = no such file
 */
function readLockFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const owner = JSON.parse(raw);
    return typeof owner?.token === 'string' && Number.isSafeInteger(owner.pid) ? { raw, owner } : { raw, owner: null };
  } catch {
    return { raw, owner: null };
  }
}

/**
 * A lock is stale ONLY when its owner process is gone, or the PID now belongs to another process (start
 * identity differs). Age never makes a lock stale: a live owner is waited for, never robbed.
 */
function ownerIsDead(owner) {
  if (!pidAlive(owner.pid)) return true;
  const now = owner.startId ? processStartId(owner.pid) : null;
  return Boolean(owner.startId && now && now !== owner.startId);
}

/**
 * Publish `owner` at `file` atomically and exclusively: the content is complete before the name appears
 * (hard link of a private temp file), so a reader never sees a half-written lock.
 *
 * @returns {boolean} false when the name is taken
 */
function tryCreateLock(file, owner) {
  const temp = `${file}.${owner.token}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(owner), { mode: 0o600 });
  try {
    fs.linkSync(temp, file);
    return true;
  } catch (error) {
    if (/** @type {any} */ (error)?.code === 'EEXIST') return false;
    throw error;
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

/** Remove `file` only while it still holds `token`. */
function removeIfOwned(file, token) {
  const current = readLockFile(file);
  if (current?.owner?.token === token) fs.rmSync(file, { force: true });
}

/**
 * Cross-process mutual exclusion (lockfile with a unique owner token). Not reentrant.
 * - Acquisition is an atomic exclusive create of a fully written file.
 * - Release removes the file only if it still carries the holder's token, so a displaced holder can never
 *   delete a newer owner's lock.
 * - A lock of a dead owner (or a reused PID) is taken over under a short-lived takeover guard that re-reads the
 *   lock right before removal, so racing contenders take over exactly once. A live owner is never robbed:
 *   after `timeoutMs` the caller gets `todos_rollback_lock_timeout`.
 *
 * @template T
 * @param {string} dataDir
 * @param {() => T} fn
 * @param {{ timeoutMs?: number, onTakeover?: () => void }} [options]
 * @returns {T}
 */
export function withRollbackStateLockSync(dataDir, fn, options = {}) {
  const lockPath = path.join(path.resolve(dataDir), LOCK_FILE);
  const guardPath = `${lockPath}.takeover`;
  const deadline = Date.now() + (options.timeoutMs ?? LOCK_TIMEOUT_MS);
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const owner = { pid: process.pid, token: randomUUID(), startId: processStartId(process.pid) };
  const wait = () => {
    if (Date.now() > deadline) throw new TodosBackendError('todos_rollback_lock_timeout', 'The rollback state lock is held by a live process');
    Atomics.wait(sleeper, 0, 0, 10);
  };
  for (;;) {
    if (tryCreateLock(lockPath, owner)) break;
    const seen = readLockFile(lockPath);
    if (!seen) continue;
    if (seen.owner && !ownerIsDead(seen.owner)) { wait(); continue; }
    if (!seen.owner) {
      // Cannot happen for a lock written by this code (it appears complete); treat as damage, not as a live owner.
      let aged = false;
      try { aged = Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS; } catch { /* gone */ }
      if (!aged) { wait(); continue; }
    }
    // Takeover: one contender at a time, and only of exactly the lock that was judged stale.
    const guardOwner = { pid: process.pid, token: randomUUID(), startId: owner.startId };
    if (!tryCreateLock(guardPath, guardOwner)) {
      const guard = readLockFile(guardPath);
      if (guard?.owner && ownerIsDead(guard.owner)) removeIfOwned(guardPath, guard.owner.token);
      else wait();
      continue;
    }
    try {
      const again = readLockFile(lockPath);
      if (again && again.raw === seen.raw) {
        fs.rmSync(lockPath, { force: true });
        options.onTakeover?.();
      }
    } finally {
      removeIfOwned(guardPath, guardOwner.token);
    }
  }
  try {
    return fn();
  } finally {
    removeIfOwned(lockPath, owner.token);
  }
}

/**
 * @param {{ dataDir: string, marker: { exportManifestHash: string | null, exportDir: string | null, datasetGeneration?: string | null }, fence: number }} options
 */
export function createRollbackLegacyTodosBackend(options) {
  if (!Number.isSafeInteger(options.fence) || options.fence < 0) {
    throw new TodosBackendError('todos_rollback_fence_required', 'The rollback runtime needs the owner fence epoch');
  }
  const { dataDir } = options;
  // Verification and fence publication are one critical section: concurrent opens see each other's mark.
  withRollbackStateLockSync(dataDir, () => {
    const initial = assertRollbackExportMatchesMarker(dataDir, options.marker);
    if (options.fence <= initial.fence) {
      throw new TodosBackendError('todos_rollback_fenced', 'The fence epoch is not above the recorded high-water mark', { recorded: initial.fence });
    }
    writeRollbackState(dataDir, { ...initial, fence: options.fence });
  });
  const inner = /** @type {Record<string, any>} */ (createLegacyJsonTodosBackend());

  /**
   * The single choke point of every mutation: lock, fence re-check, receipt lookup, apply, record.
   *
   * @param {string} method
   * @param {any[]} args
   */
  function guarded(method, args) {
    const command = commandContext.getStore();
    return withRollbackStateLockSync(dataDir, () => {
      const state = readRollbackState(dataDir);
      if (state.fence > options.fence) throw new TodosBackendError('todos_rollback_fenced', 'A newer owner raised the fencing mark', { recorded: state.fence });
      // Several mutations under one command (a facade batch) get `#n` suffixed ledger keys, in call order.
      if (command) command.seq += 1;
      const key = command
        ? `${command.datasetGeneration ?? options.marker.datasetGeneration ?? ''}\u0000${command.commandId}${command.seq > 1 ? `#${command.seq}` : ''}`
        : null;
      if (key && state.receipts[key]) {
        const known = state.receipts[key];
        if (known.requestDigest !== command?.requestDigest) throw new TodosBackendError('receipt_digest_mismatch', 'The command id was used with another payload');
        return JSON.parse(known.resultJson);
      }
      const result = inner[method](...args);
      if (key && command) {
        // The recorded result must round-trip as JSON; a replay returns exactly this value.
        const resultJson = JSON.stringify(result ?? null);
        state.receipts[key] = { requestDigest: command.requestDigest, resultJson };
      }
      state.files = hashLiveTodoFiles(dataDir);
      writeRollbackState(dataDir, state);
      return result;
    });
  }

  const backend = { ...inner };
  for (const name of MUTATIONS) backend[name] = (...args) => guarded(name, args);
  /**
   * Explicit-identity form of the same choke point.
   *
   * @param {{ datasetGeneration: string, commandId: string, requestDigest: string }} command
   * @param {string} method
   * @param {any[]} args
   * @returns {{ replayed: boolean, result: any }}
   */
  backend.command = (command, method, args) => {
    if (!MUTATIONS.includes(method)) throw new TodosBackendError('todos_rollback_bad_method', 'Unknown mutation');
    const key = `${command.datasetGeneration}\u0000${command.commandId}`;
    const replayed = Boolean(readRollbackState(dataDir).receipts[key]);
    const result = commandContext.run({ ...command, seq: 0 }, () => guarded(method, args));
    return { replayed, result };
  };
  backend.runWithCommand = (command, fn) => withTodosCommand(command, fn);
  backend.fence = options.fence;
  return backend;
}
