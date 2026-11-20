/**
 * Storage coordinator (A2 S6): single-owner lease, fencing high-water mark and
 * restore pause for the consolidated store. Design and limits:
 * lib/storage/coordinator.md.
 *
 * State lives in a small control directory OUTSIDE every restore path:
 *   owner-lease.json   current owner (pid, token, epoch, expiry)
 *   fencing-hwm.json   highest epoch ever granted (never lowered)
 *   restore-pause.json restore-pause marker (survives a crash)
 *   control.lock       short exclusive lock around read-modify-write
 *
 * Every file is replaced atomically (tmp + fsync + rename + directory fsync);
 * a partial `.tmp` is never read. The lock is held only for a synchronous
 * critical section of a few small file operations: it is never held across an
 * `await`, and nothing here blocks on a worker (no Atomics, no sync facade).
 *
 * Lease semantics mirror lib/recovery/recovery-owner-lease.ts (created /
 * renewed / takeover / owner_held, takeover only for a dead owner or an
 * expired lease, generation + 1). That module is bound to the recovery SQLite
 * store, which is itself a restore target, so it is not imported; the PID
 * liveness helpers it uses (lib/delegation-owner-lock.js) are reused.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { StorageError, STORAGE_ERROR_CODES } from './errors.js';
import { toStorageError } from './sqlite-errors.js';
import { getProcessStartTime, isProcessAlive } from '../delegation-owner-lock.js';

export const DEFAULT_LEASE_TTL_MS = 30000;
export const DEFAULT_LOCK_STALE_MS = 10000;
export const DEFAULT_PAUSE_DRAIN_TIMEOUT_MS = 30000;
/** Bounded wait of acquireAsync() for a busy control lock. */
export const DEFAULT_LOCK_WAIT_MS = 1000;
export const DEFAULT_LOCK_POLL_MS = 10;
/** How long a read of the restore-pause marker is reused by the write guard. */
export const DEFAULT_PAUSE_CHECK_MS = 250;

const SCHEMA = 1;
const LEASE_FILE = 'owner-lease.json';
const HWM_FILE = 'fencing-hwm.json';
const PAUSE_FILE = 'restore-pause.json';
const LOCK_FILE = 'control.lock';
const TMP_SUFFIX = '.tmp';

/**
 * @param {string} code
 * @param {string} operation
 * @param {Record<string, unknown>} [extra]
 * @param {string} [message]
 */
function coordinatorError(code, operation, extra = {}, message = undefined) {
  return new StorageError(code, message, { details: { operation, commitState: 'not_committed', ...extra } });
}

/** @param {string} operation @param {string} conflictKind @param {Record<string, unknown>} [extra] */
const fencedError = (operation, conflictKind, extra = {}) => coordinatorError(STORAGE_ERROR_CODES.CONFLICT, operation, { conflictKind, ...extra });

/**
 * @param {unknown} value
 * @returns {number}
 */
function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && /** @type {number} */ (value) >= 0 ? /** @type {number} */ (value) : 0;
}

/** @type {WeakMap<object, import('node:sqlite').StatementSync>} */
const fencingReaders = new WeakMap();

/**
 * Highest fencing mark stored in an open store connection (the `storage_fencing`
 * mirror, schema v2). A store without the singleton row is damaged (the row is
 * seeded by the migration) and fails closed with `corrupt`, never as mark 0.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {number}
 * @throws {StorageError} corrupt (missing row / invalid value), io
 */
export function readFencingHwmFromDb(db) {
  let row;
  try {
    let statement = fencingReaders.get(db);
    if (!statement) {
      statement = db.prepare('SELECT hwm FROM storage_fencing WHERE id = 1');
      fencingReaders.set(db, statement);
    }
    row = statement.get();
  } catch (err) {
    throw toStorageError(err, 'read_fencing');
  }
  const hwm = Number(row?.hwm);
  if (!row || !Number.isSafeInteger(hwm) || hwm < 0) throw coordinatorError(STORAGE_ERROR_CODES.CORRUPT, 'read_fencing');
  return hwm;
}

/**
 * Create a coordinator for one control directory. One instance = one would-be
 * owner (its own token); two instances never share ownership.
 *
 * @param {{
 *   controlDir: string,
 *   now?: () => number,
 *   ttlMs?: number,
 *   lockStaleMs?: number,
 *   pauseCheckMs?: number,
 *   autoRenew?: boolean,
 *   pid?: number,
 *   pidStart?: string,
 *   isOwnerAlive?: (owner: { pid: number, pidStart: string }) => boolean,
 *   timers?: { setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout },
 *   fs?: Pick<typeof fs, 'openSync' | 'writeSync' | 'fsyncSync' | 'closeSync' | 'renameSync' | 'linkSync' | 'readFileSync' | 'unlinkSync' | 'readdirSync' | 'mkdirSync' | 'statSync'>,
 *   onLost?: (info: { reason: string }) => void,
 * }} options `now` is wall-clock milliseconds (the lease is shared between
 *   processes). `lockStaleMs` only ages out a torn lock file; a lock with a live
 *   holder is never broken. `pauseCheckMs` bounds how stale the write guard's
 *   view of the restore-pause marker may be. `fs`, `timers`, `pid*`, `isOwnerAlive` are test seams.
 */
export function createStorageCoordinator(options) {
  const { controlDir } = options || {};
  if (typeof controlDir !== 'string' || !path.isAbsolute(controlDir)) throw new TypeError('controlDir must be an absolute path');
  const now = options.now || Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  const lockStaleMs = options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
  const pauseCheckMs = options.pauseCheckMs ?? DEFAULT_PAUSE_CHECK_MS;
  if (!(ttlMs > 0) || !(lockStaleMs > 0)) throw new TypeError('ttlMs and lockStaleMs must be positive');
  if (!(pauseCheckMs >= 0)) throw new TypeError('pauseCheckMs must be non-negative');
  const autoRenew = options.autoRenew !== false;
  const fsx = options.fs || fs;
  const timers = options.timers || { setTimeout, clearTimeout };
  const pid = options.pid ?? process.pid;
  const pidStart = options.pidStart ?? getProcessStartTime(pid);
  const isOwnerAlive = options.isOwnerAlive || ((owner) => {
    if (!isProcessAlive(owner.pid)) return false;
    // PID reuse: a different start time means the recorded owner is gone.
    const start = owner.pid === pid ? pidStart : getProcessStartTime(owner.pid);
    return !owner.pidStart || !start || owner.pidStart === start;
  });
  const paths = Object.freeze({
    dir: controlDir,
    lease: path.join(controlDir, LEASE_FILE),
    hwm: path.join(controlDir, HWM_FILE),
    pause: path.join(controlDir, PAUSE_FILE),
    lock: path.join(controlDir, LOCK_FILE),
  });
  const ownerToken = randomUUID();

  /** @type {'idle' | 'owner' | 'fenced' | 'released'} */
  let state = 'idle';
  let epoch = 0;
  let expiresAt = 0;
  let paused = false;
  let pauseCheckedAt = Number.NEGATIVE_INFINITY;
  /** Epoch for which activate() completed; a write needs it when fenced. */
  let activatedEpoch = -1;
  let renewTimer = null;
  /** @type {Set<Promise<unknown>>} */
  const inFlight = new Set();

  // ---- atomic file helpers ------------------------------------------------

  function fsyncDir() {
    let fd;
    try {
      fd = fsx.openSync(paths.dir, 'r');
      fsx.fsyncSync(fd);
    } catch (err) {
      // Directory fsync is unsupported on some platforms (EISDIR/EPERM/EINVAL);
      // anything else is a real durability failure.
      const code = /** @type {any} */ (err)?.code;
      if (!['EISDIR', 'EPERM', 'EINVAL', 'ENOTSUP'].includes(code)) throw err;
    } finally {
      if (fd !== undefined) {
        try { fsx.closeSync(fd); } catch { /* best effort */ }
      }
    }
  }

  /**
   * Replace `file` atomically. A throw means "not known to be durable": it can
   * come after the rename when only the directory fsync failed, so the new
   * content may already be visible. That is deliberate (the contract is a
   * durable commit); every caller treats it as a failure and every transition
   * written here is monotonic/idempotent (HWM first, lease owned by token), so
   * a retry or a later reader converges.
   *
   * @param {string} file
   * @param {Record<string, unknown>} value
   */
  function writeAtomic(file, value) {
    const tmp = `${file}.${pid}.${randomUUID().slice(0, 8)}${TMP_SUFFIX}`;
    let fd;
    try {
      fd = fsx.openSync(tmp, 'wx', 0o600);
      fsx.writeSync(fd, `${JSON.stringify({ schema: SCHEMA, ...value })}\n`);
      fsx.fsyncSync(fd);
      fsx.closeSync(fd);
      fd = undefined;
      fsx.renameSync(tmp, file);
      fsyncDir();
    } catch (err) {
      if (fd !== undefined) {
        try { fsx.closeSync(fd); } catch { /* best effort */ }
      }
      try { fsx.unlinkSync(tmp); } catch { /* may not exist */ }
      throw toStorageError(err, 'control_write');
    }
  }

  /**
   * @param {string} file
   * @returns {Record<string, any> | null} null when the file does not exist
   */
  function readJson(file) {
    let raw;
    try {
      raw = fsx.readFileSync(file, 'utf8');
    } catch (err) {
      if (/** @type {any} */ (err)?.code === 'ENOENT') return null;
      throw toStorageError(err, 'control_read');
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    // Fail closed: a damaged control file must never read as "no owner / HWM 0".
    if (!parsed || typeof parsed !== 'object' || parsed.schema !== SCHEMA) {
      throw coordinatorError(STORAGE_ERROR_CODES.CORRUPT, 'control_read');
    }
    return parsed;
  }

  /** @returns {Record<string, any> | null} validated lease; corrupt on garbage fields */
  function readLease() {
    const lease = readJson(paths.lease);
    if (lease === null) return null;
    const valid = typeof lease.ownerToken === 'string' && lease.ownerToken.length > 0
      && Number.isSafeInteger(lease.pid) && lease.pid > 0
      && Number.isSafeInteger(lease.epoch) && lease.epoch >= 1
      && typeof lease.expiresAt === 'number' && Number.isFinite(lease.expiresAt) && lease.expiresAt >= 0
      && (lease.pidStart === undefined || typeof lease.pidStart === 'string');
    if (!valid) throw coordinatorError(STORAGE_ERROR_CODES.CORRUPT, 'control_read');
    return lease;
  }

  /** @param {string} file */
  function removeFile(file) {
    try {
      fsx.unlinkSync(file);
    } catch (err) {
      if (/** @type {any} */ (err)?.code !== 'ENOENT') throw toStorageError(err, 'control_write');
    }
  }

  // ---- control lock (synchronous critical sections only) -----------------

  /**
   * Run `fn` under the exclusive control lock. The lock file carries a unique
   * token; it is removed afterwards only if it still holds that token, and it
   * is broken by someone else only when its holder is dead or the file is torn,
   * never merely because it is old (a stalled but live holder keeps it).
   *
   * @param {() => T} fn
   * @returns {T}
   * @template T
   */
  function withLock(fn) {
    try {
      fsx.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    } catch (err) {
      throw toStorageError(err, 'control_lock');
    }
    const lockToken = randomUUID();
    let acquired = false;
    for (let attempt = 0; attempt < 2 && !acquired; attempt += 1) {
      let fd;
      try {
        fd = fsx.openSync(paths.lock, 'wx', 0o600);
      } catch (err) {
        if (/** @type {any} */ (err)?.code !== 'EEXIST') throw toStorageError(err, 'control_lock');
        if (attempt === 0 && breakStaleLock()) continue;
        throw coordinatorError(STORAGE_ERROR_CODES.BUSY, 'control_lock', { conflictKind: 'control_locked' });
      }
      try {
        fsx.writeSync(fd, JSON.stringify({ pid, pidStart, at: now(), token: lockToken }));
        fsx.closeSync(fd);
        fd = undefined;
      } catch (err) {
        // We created the file, so a failed write must not leave a torn lock.
        if (fd !== undefined) {
          try { fsx.closeSync(fd); } catch { /* best effort */ }
        }
        try { fsx.unlinkSync(paths.lock); } catch { /* already gone */ }
        throw toStorageError(err, 'control_lock');
      }
      acquired = true;
    }
    try {
      // Anything `.tmp` left here is a crash leftover: writers only create
      // tmp files while holding this lock.
      sweepTmp();
      return fn();
    } finally {
      unlockIfOwned(lockToken);
    }
  }

  /** @param {string} lockToken */
  function unlockIfOwned(lockToken) {
    try {
      const holder = JSON.parse(fsx.readFileSync(paths.lock, 'utf8'));
      if (holder?.token === lockToken) fsx.unlinkSync(paths.lock);
    } catch {
      // Gone, replaced by a torn file, or unreadable: never delete what is not
      // provably ours.
    }
  }

  /** @returns {boolean} true when a dead holder's (or torn) lock was removed */
  function breakStaleLock() {
    let judged = null;
    let holder = null;
    try {
      judged = fsx.readFileSync(paths.lock, 'utf8');
    } catch (err) {
      return /** @type {any} */ (err)?.code === 'ENOENT';
    }
    try {
      holder = JSON.parse(judged);
    } catch {
      holder = null;
    }
    if (holder && Number.isSafeInteger(holder.pid)) {
      // Identified holder: break only when it is provably dead.
      if (isOwnerAlive({ pid: holder.pid, pidStart: String(holder.pidStart || '') })) return false;
    } else {
      // Torn/unparsable file (crash between create and write, or the creator is
      // mid-write): only an old one is treated as torn.
      let at;
      try {
        at = fsx.statSync(paths.lock).mtimeMs + (now() - Date.now());
      } catch {
        return true;
      }
      if (now() - at < lockStaleMs) return false;
    }
    // Move the lock aside atomically, then verify what we actually took. Unlike
    // read-compare-unlink there is no gap in which a lock re-created by another
    // process could be deleted unseen.
    const grave = `${paths.lock}.${pid}.${randomUUID().slice(0, 8)}.stale`;
    try {
      fsx.renameSync(paths.lock, grave);
    } catch (err) {
      return /** @type {any} */ (err)?.code === 'ENOENT';
    }
    let taken = null;
    try { taken = fsx.readFileSync(grave, 'utf8'); } catch { /* unreadable: treat as foreign */ }
    if (taken === judged) {
      try { fsx.unlinkSync(grave); } catch { /* best effort */ }
      return true;
    }
    // We moved a lock that is not the one we judged: put it back with link +
    // unlink. link() fails with EEXIST instead of overwriting, so a lock another
    // process created in the meantime always wins.
    try {
      fsx.linkSync(grave, paths.lock);
    } catch { /* a newer lock exists (EEXIST) or the restore failed: never overwrite */ }
    try { fsx.unlinkSync(grave); } catch { /* best effort */ }
    return false;
  }

  function sweepTmp() {
    let names = [];
    try {
      names = fsx.readdirSync(paths.dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(TMP_SUFFIX)) continue;
      try { fsx.unlinkSync(path.join(paths.dir, name)); } catch { /* best effort */ }
    }
  }

  // ---- HWM / lease primitives (call under the lock) -----------------------

  /** @returns {number} */
  function readHwmFile() {
    const file = readJson(paths.hwm);
    if (file === null) return 0;
    // Fail closed: a schema-valid file without a usable mark is damage, not 0.
    if (!Number.isSafeInteger(file.hwm) || file.hwm < 0) throw coordinatorError(STORAGE_ERROR_CODES.CORRUPT, 'control_read');
    return file.hwm;
  }

  /**
   * Under the lock: our lease must still be on disk and not superseded by a
   * higher mark. Otherwise this coordinator is fenced for good.
   *
   * @param {string} operation
   * @returns {Record<string, any>} the lease
   */
  function verifyOwnLease(operation) {
    const lease = readLease();
    const hwm = readHwmFile();
    if (!lease || lease.ownerToken !== ownerToken || lease.epoch !== epoch || hwm > epoch) {
      markLost('lease_lost');
      throw fencedError(operation, 'fenced', { expectedRevision: hwm, actualRevision: epoch });
    }
    return lease;
  }

  /**
   * Refresh the cached view of the restore-pause marker.
   *
   * @param {boolean} [force] ignore the cache window
   */
  function refreshPause(force = false) {
    const at = now();
    if (!force && at - pauseCheckedAt < pauseCheckMs && at >= pauseCheckedAt) return;
    paused = readJson(paths.pause) !== null;
    pauseCheckedAt = at;
  }

  /** @param {number} value */
  function raiseHwmFile(value) {
    if (value > readHwmFile()) writeAtomic(paths.hwm, { hwm: value, updatedAt: now() });
  }

  /** @param {number} grantedEpoch @param {number} at */
  function writeLease(grantedEpoch, at) {
    expiresAt = at + ttlMs;
    writeAtomic(paths.lease, {
      ownerToken, pid, pidStart, epoch: grantedEpoch, acquiredAt: at, heartbeatAt: at, expiresAt,
    });
  }

  function clearRenewTimer() {
    if (renewTimer !== null) {
      timers.clearTimeout(renewTimer);
      renewTimer = null;
    }
  }

  function scheduleRenew() {
    clearRenewTimer();
    if (!autoRenew || state !== 'owner') return;
    renewTimer = timers.setTimeout(() => {
      renewTimer = null;
      try {
        renew();
      } catch {
        // A lost lease is reported through onLost; a transient I/O failure
        // retries at the next beat while the lease is still valid.
        if (state === 'owner') scheduleRenew();
      }
    }, Math.max(1, Math.floor(ttlMs / 3)));
    renewTimer.unref?.();
  }

  /** @param {string} reason */
  function markLost(reason) {
    if (state !== 'owner') return;
    state = 'fenced';
    clearRenewTimer();
    try { options.onLost?.({ reason }); } catch { /* observer must not break the coordinator */ }
  }

  // ---- public API ----------------------------------------------------------

  /** @param {number} ms */
  function sleep(ms) {
    return new Promise((resolve) => {
      timers.setTimeout(resolve, ms);
    });
  }

  /**
   * Like acquire(), but waits for a busy control lock without blocking the event
   * loop: it polls with timer-based sleeps and gives up after `lockWaitMs` with
   * `busy` / `lock_wait_timeout`. Only a held control lock is waited for; a live
   * owner (`owner_held`) is reported immediately.
   *
   * @param {{ dbHwm?: number, lockWaitMs?: number, pollMs?: number }} [acquireOptions]
   * @returns {Promise<ReturnType<typeof acquire>>}
   */
  async function acquireAsync(acquireOptions = {}) {
    const lockWaitMs = acquireOptions.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS;
    const pollMs = acquireOptions.pollMs ?? DEFAULT_LOCK_POLL_MS;
    if (!(lockWaitMs >= 0) || !(pollMs > 0)) throw new TypeError('lockWaitMs must be non-negative and pollMs positive');
    const deadline = Date.now() + lockWaitMs;
    for (;;) {
      try {
        return acquire(acquireOptions);
      } catch (err) {
        const details = /** @type {any} */ (err)?.details;
        if (details?.conflictKind !== 'control_locked') throw err;
        const left = deadline - Date.now();
        if (left <= 0) throw coordinatorError(STORAGE_ERROR_CODES.BUSY, 'control_lock', { conflictKind: 'lock_wait_timeout' });
        await sleep(Math.min(pollMs, left));
      }
    }
  }

  /**
   * Acquire (or refresh) ownership. Returns the granted epoch, which strictly
   * exceeds every epoch ever granted in this control dir (and `dbHwm`, the
   * mark mirrored in the store, when given).
   *
   * @param {{ dbHwm?: number }} [acquireOptions]
   * @returns {{ epoch: number, reason: 'created' | 'renewed' | 'takeover', previousEpoch: number, restorePaused: boolean }}
   * @throws {StorageError} busy (`owner_held` / `control_locked`), corrupt, io
   */
  function acquire(acquireOptions = {}) {
    if (state === 'released') throw coordinatorError(STORAGE_ERROR_CODES.IO, 'acquire', {}, 'Coordinator is closed');
    const dbHwm = nonNegativeInteger(acquireOptions.dbHwm);
    return withLock(() => {
      const at = now();
      // Every read (and validation) happens before the first mutation: a
      // damaged control file must leave no owner state and no lease behind.
      const pauseMarker = readJson(paths.pause);
      const lease = readLease();
      const hwmFile = readHwmFile();
      const known = Math.max(hwmFile, dbHwm);
      if (lease && lease.ownerToken === ownerToken && state === 'owner' && lease.epoch === epoch && epoch >= known) {
        writeLease(epoch, at);
        paused = pauseMarker !== null;
        pauseCheckedAt = at;
        scheduleRenew();
        return { epoch, reason: /** @type {const} */ ('renewed'), previousEpoch: epoch, restorePaused: paused };
      }
      let reason = /** @type {'created' | 'takeover'} */ ('created');
      let previousEpoch = known;
      if (lease) {
        const owner = { pid: nonNegativeInteger(lease.pid), pidStart: String(lease.pidStart || '') };
        const expired = at >= nonNegativeInteger(lease.expiresAt);
        const held = lease.ownerToken !== ownerToken && !expired && isOwnerAlive(owner);
        if (held) throw coordinatorError(STORAGE_ERROR_CODES.BUSY, 'acquire', { conflictKind: 'owner_held' });
        reason = 'takeover';
        previousEpoch = Math.max(known, nonNegativeInteger(lease.epoch));
      }
      const granted = previousEpoch + 1;
      // HWM first: a crash between the two writes only skips an epoch.
      raiseHwmFile(granted);
      writeLease(granted, at);
      epoch = granted;
      state = 'owner';
      paused = pauseMarker !== null;
      pauseCheckedAt = at;
      scheduleRenew();
      return { epoch, reason, previousEpoch, restorePaused: paused };
    });
  }

  /**
   * Extend the lease. A lease that is no longer ours (taken over, replaced, or
   * a higher HWM exists) fences this coordinator permanently.
   *
   * @returns {{ epoch: number, expiresAt: number }}
   * @throws {StorageError} conflict `fenced`
   */
  function renew() {
    if (state !== 'owner') throw fencedError('renew', state === 'fenced' ? 'fenced' : 'not_owner');
    return withLock(() => {
      verifyOwnLease('renew');
      // A restore tool in another process cannot reach our memory: it writes
      // the marker, and the owner learns about it here and on guarded writes.
      refreshPause(true);
      writeLease(epoch, now());
      scheduleRenew();
      return { epoch, expiresAt };
    });
  }

  /**
   * Run a SYNCHRONOUS critical section while this coordinator provably owns the
   * lease: under the control lock the on-disk lease must still be ours and no
   * higher mark may exist (a takeover after TTL expiry fences us here). A lease
   * past its expiry that nobody took over is extended first. `fn` must not
   * await or call coordinator methods that take the control lock.
   *
   * @template T
   * @param {string} operation name used in the refusal details
   * @param {(info: { epoch: number }) => T} fn
   * @returns {T}
   * @throws {StorageError} conflict `fenced` | `not_owner`
   */
  function withOwnedLease(operation, fn) {
    if (state !== 'owner') throw fencedError(operation, state === 'fenced' ? 'fenced' : 'not_owner');
    return withLock(() => {
      const lease = verifyOwnLease(operation);
      if (now() >= lease.expiresAt) writeLease(epoch, now());
      return fn({ epoch });
    });
  }

  /**
   * Give the lease up (the HWM stays, so the next owner gets a higher epoch).
   * Refuses to delete a lease that is not ours.
   */
  function release() {
    clearRenewTimer();
    const wasOwner = state === 'owner';
    state = 'released';
    if (!wasOwner) return false;
    return withLock(() => {
      const lease = readLease();
      if (lease && lease.ownerToken === ownerToken) removeFile(paths.lease);
      return true;
    });
  }

  /**
   * Throws unless this coordinator may write right now: it must own a live
   * lease (a past-expiry lease is renewed first, which fences us if it was
   * taken over) and no restore may be in progress.
   */
  function assertWritable() {
    if (state === 'fenced') throw fencedError('write', 'fenced', { actualRevision: epoch });
    if (state !== 'owner') throw fencedError('write', 'not_owner');
    if (now() >= expiresAt) renew();
    if (activatedEpoch !== epoch) {
      throw fencedError('write', 'not_activated', { actualRevision: epoch });
    }
    refreshPause();
    if (paused) {
      throw coordinatorError(STORAGE_ERROR_CODES.BUSY, 'restore_paused', { conflictKind: 'restore_paused' });
    }
  }

  /** @returns {{ fenceEpoch: number }} request options for a fenced write */
  function fenceOptions() {
    assertWritable();
    return { fenceEpoch: epoch };
  }

  /**
   * Make the store aware of this owner: reconcile the HWM mirrored in the store
   * with the control file (the larger wins), bump our epoch above the store's
   * mark when it was ahead, then raise the store's mark so a zombie owner is
   * fenced before our first real write. Async because the store lives behind
   * the worker; no lock is held while waiting for it.
   *
   * @param {{ control: (op: 'fence', opts?: { fenceEpoch?: number }) => Promise<unknown> }} host
   * @returns {Promise<{ epoch: number, dbHwm: number }>}
   */
  async function activate(host) {
    if (state !== 'owner') throw fencedError('activate', state === 'fenced' ? 'fenced' : 'not_owner');
    const stored = /** @type {{ hwm: number }} */ (await host.control('fence'));
    const dbHwm = nonNegativeInteger(stored?.hwm);
    if (dbHwm >= epoch) bumpEpochAbove(dbHwm);
    else reconcileHwm(dbHwm);
    const raised = /** @type {{ hwm: number }} */ (await host.control('fence', { fenceEpoch: epoch }));
    if (state !== 'owner') throw fencedError('activate', 'fenced');
    activatedEpoch = epoch;
    return { epoch, dbHwm: nonNegativeInteger(raised?.hwm) };
  }

  /** @param {number} floor */
  function bumpEpochAbove(floor) {
    withLock(() => {
      verifyOwnLease('activate');
      const granted = Math.max(floor, readHwmFile(), epoch) + 1;
      raiseHwmFile(granted);
      writeLease(granted, now());
      epoch = granted;
    });
  }

  /**
   * Record a mark seen in the store: the control HWM becomes max(file, dbHwm).
   *
   * @param {number} dbHwm
   * @returns {number} the resolved HWM
   */
  function reconcileHwm(dbHwm) {
    return withLock(() => {
      raiseHwmFile(nonNegativeInteger(dbHwm));
      return readHwmFile();
    });
  }

  /**
   * Run `fn` as a tracked write so a restore pause can wait for it.
   *
   * @param {() => Promise<unknown>} fn
   */
  function trackWrite(fn) {
    let promise;
    try {
      promise = Promise.resolve(fn());
    } catch (err) {
      return Promise.reject(err);
    }
    inFlight.add(promise);
    const forget = () => { inFlight.delete(promise); };
    promise.then(forget, forget);
    return promise;
  }

  /**
   * Wrap a worker host: writes get the owner epoch and are refused while we are
   * fenced, not the owner, or paused for restore; reads and control ops pass
   * through. Wrapping the host is the single place that enforces the lease, so
   * callers (receipts, group commit) just receive this object.
   *
   * @template {{ command: Function, commandBatch: Function, query: Function, control: Function }} H
   * @param {H} host
   * @returns {H}
   */
  function guardHost(host) {
    /** @param {Function} method @param {number} optsIndex */
    const guarded = (method, optsIndex) => (...args) => {
      let fence;
      try {
        fence = fenceOptions();
      } catch (err) {
        return Promise.reject(err);
      }
      const opts = { ...(args[optsIndex] || {}), ...fence };
      const callArgs = [...args];
      callArgs[optsIndex] = opts;
      return trackWrite(() => method.apply(host, callArgs));
    };
    return /** @type {H} */ (Object.freeze({
      ...host,
      command: guarded(host.command, 2),
      commandBatch: guarded(host.commandBatch, 1),
    }));
  }

  /**
   * Block new writes (persisted first, so a crash keeps the pause) and wait for
   * the writes already in flight. Reads stay allowed. On drain timeout the
   * pause stays in force and `busy` is thrown; call again or resume.
   *
   * @param {{ timeoutMs?: number, reason?: string }} [pauseOptions]
   * @returns {Promise<{ drained: number }>}
   */
  async function pauseForRestore(pauseOptions = {}) {
    if (state !== 'owner') throw fencedError('pause', state === 'fenced' ? 'fenced' : 'not_owner');
    const timeoutMs = pauseOptions.timeoutMs ?? DEFAULT_PAUSE_DRAIN_TIMEOUT_MS;
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError('timeoutMs must be a finite positive number');
    }
    withLock(() => {
      // A zombie owner must not write a marker (verified under the lock).
      verifyOwnLease('pause');
      writeAtomic(paths.pause, { pausedAt: now(), epoch, pid, reason: String(pauseOptions.reason || 'restore').slice(0, 100) });
    });
    paused = true;
    pauseCheckedAt = now();
    const pending = [...inFlight];
    if (pending.length === 0) return { drained: 0 };
    let timer;
    const timeout = new Promise((resolve) => {
      timer = timers.setTimeout(() => resolve('timeout'), timeoutMs);
      timer.unref?.();
    });
    try {
      const outcome = await Promise.race([Promise.allSettled(pending).then(() => 'drained'), timeout]);
      if (outcome === 'timeout') {
        throw coordinatorError(STORAGE_ERROR_CODES.BUSY, 'restore_paused', { conflictKind: 'drain_timeout' });
      }
    } finally {
      timers.clearTimeout(timer);
    }
    return { drained: pending.length };
  }

  /**
   * End the pause after a restore. The marker is removed durably; the caller
   * should `activate()` again because a restored store may carry an older mark.
   */
  function resumeAfterRestore() {
    if (state !== 'owner') throw fencedError('resume', state === 'fenced' ? 'fenced' : 'not_owner');
    withLock(() => {
      verifyOwnLease('resume');
      removeFile(paths.pause);
    });
    paused = false;
    pauseCheckedAt = now();
  }

  /** @returns {boolean} whether the marker exists (read from disk) */
  function readRestorePause() {
    return readJson(paths.pause) !== null;
  }

  /** @returns {number} HWM stored in the control directory */
  function readHwm() {
    return readHwmFile();
  }

  function getSnapshot() {
    return {
      state, epoch, expiresAt, paused, inFlightWrites: inFlight.size, renewTimerActive: renewTimer !== null,
    };
  }

  /** Release the lease and stop the renew timer. Safe to call twice. */
  function close() {
    return release();
  }

  return Object.freeze({
    paths,
    acquire,
    acquireAsync,
    renew,
    withOwnedLease,
    release,
    close,
    assertWritable,
    fenceOptions,
    guardHost,
    activate,
    reconcileHwm,
    pauseForRestore,
    resumeAfterRestore,
    readRestorePause,
    readHwm,
    getSnapshot,
    get epoch() { return epoch; },
    get state() { return state; },
  });
}
