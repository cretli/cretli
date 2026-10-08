/**
 * Durable, cross-process owner lease + monotonic generation fencing for the
 * recovery registry (leaf R3).
 *
 * This module is a *primitive*: it only answers "who owns the recovery registry
 * right now, under which fencing generation, and is a given callback still
 * allowed to act?". It deliberately does NOT implement recovery policy and does
 * not wire itself into the runtime (`chat-run-service.js`,
 * `delegation-service.js`, `workspace-watcher*.js`, routes). Later leaves
 * (R10 shared recovery owner, R12 manual resume) build on top of it.
 *
 * The lease lives in its own singleton row in the recovery SQLite store
 * (`recovery_owner_lease`, schema version 2), so it is shared by every process
 * that opens the same `recovery.sqlite`. Every mutation runs in a single
 * `BEGIN IMMEDIATE` transaction:
 *
 * - a missing row is claimed with `generation = 1` (`created`),
 * - the same `ownerId` + `ownerToken` refreshes the heartbeat (`renewed`),
 * - a dead owner (PID gone or PID reuse via /proc starttime) or an expired
 *   heartbeat performs a `takeover` with `generation + 1`,
 * - a live, unexpired foreign owner is reported as `owner_held` — never thrown.
 *
 * PID liveness and PID-reuse detection are shared with
 * `lib/delegation-owner-lock.js` (`isProcessAlive`, `getProcessStartTime`,
 * `isKillProbeAlive`); this module never re-reads `/proc` itself.
 *
 * `serverInstanceToken` / `instanceToken` is a diagnostic server identity, not a
 * lock and not a fencing token: it is ignored by every function here. The only
 * ownership proof is the server-generated `ownerToken` combined with the
 * `generation`.
 */

import { randomUUID } from 'node:crypto';

import {
  closeRecoveryStore,
  getRecoveryStoreDatabase,
  isRecoveryStoreError,
  openRecoveryStore,
} from './recovery-store.js';
import {
  getProcessStartTime,
  isKillProbeAlive,
  isProcessAlive,
} from '../delegation-owner-lock.js';

/** Default lease time-to-live in milliseconds. */
export const RECOVERY_OWNER_LEASE_DEFAULT_TTL_MS = 30_000;

/** Persisted shape version of the lease row's `json` payload. */
export const RECOVERY_OWNER_LEASE_SCHEMA_VERSION = 1;

/** The lease is a singleton row; this is its fixed primary key. */
export const RECOVERY_OWNER_LEASE_ROW_ID = 1;

/** Name of the singleton table created by the recovery store migration. */
export const RECOVERY_OWNER_LEASE_TABLE = 'recovery_owner_lease';

/** Stable `reason` values returned by `acquireRecoveryOwnerLease`. */
export const RECOVERY_OWNER_LEASE_ACQUIRE_REASONS = Object.freeze([
  'created',
  'renewed',
  'takeover',
  'owner_held',
]);

/** Stable `reason` values returned by `checkRecoveryOwnerFence`. */
export const RECOVERY_OWNER_LEASE_FENCE_REASONS = Object.freeze([
  'no_lease',
  'stale_owner',
  'generation_mismatch',
  'lease_expired',
  'owner_dead',
]);

/**
 * Lease-level failure. `.code` is a stable machine code; `invalid_owner` is the
 * only code the task contract pins. Logical contention (`owner_held`, a lost
 * fence) is NOT an error and is returned as a value.
 */
export class RecoveryOwnerLeaseError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, details?: object }} [options]
   */
  constructor(message, { code = 'recovery_owner_lease_error', details = {} } = {}) {
    super(String(message));
    this.name = 'RecoveryOwnerLeaseError';
    this.code = String(code);
    this.details = details && typeof details === 'object' ? details : {};
  }
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
export function isRecoveryOwnerLeaseError(err) {
  return err instanceof RecoveryOwnerLeaseError;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return String(value ?? '').trim();
}

/**
 * @param {unknown} value
 * @returns {number} a non-negative integer, or 0
 */
function normalizeGeneration(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number} a positive integer, or `fallback`
 */
function normalizePositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return Math.floor(fallback);
  return Math.floor(parsed);
}

/**
 * @param {unknown} value
 * @returns {number} epoch milliseconds (`Date.now()` when unusable)
 */
function resolveNowMs(value) {
  if (value === undefined || value === null || value === '') return Date.now();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = new Date(String(value));
  return Number.isFinite(parsed.getTime()) ? parsed.getTime() : Date.now();
}

/**
 * @param {number} ms
 * @returns {string}
 */
function toIso(ms) {
  return new Date(ms).toISOString();
}

/**
 * TTL of an *existing* lease. The owner's persisted TTL is authoritative so a
 * later caller cannot keep an incumbent lease alive by passing a larger
 * `ttlMs`; a caller-supplied TTL is only a fallback for legacy rows that carry
 * none.
 *
 * @param {object} row
 * @param {unknown} requested
 * @returns {number}
 */
function leaseTtlMs(row, requested) {
  const stored = storedTtlMs(row);
  if (stored > 0) return stored;
  const requestedMs = Number(requested);
  if (Number.isFinite(requestedMs) && requestedMs > 0) return Math.floor(requestedMs);
  return RECOVERY_OWNER_LEASE_DEFAULT_TTL_MS;
}

/**
 * TTL to persist for a lease being written: an explicit `ttlMs` wins, otherwise
 * the previous TTL is kept, otherwise the default.
 *
 * @param {unknown} requested
 * @param {unknown} stored
 * @returns {number}
 */
function newLeaseTtlMs(requested, stored) {
  const requestedMs = Number(requested);
  if (Number.isFinite(requestedMs) && requestedMs > 0) return Math.floor(requestedMs);
  const storedMs = Number(stored);
  if (Number.isFinite(storedMs) && storedMs > 0) return Math.floor(storedMs);
  return RECOVERY_OWNER_LEASE_DEFAULT_TTL_MS;
}

/**
 * Liveness of a persisted lease owner. Two failures count as "dead": the PID no
 * longer exists, or its `/proc/<pid>/stat` starttime no longer matches the
 * stored one (PID reuse). `isProcessAlive` already folds the raw kill-probe
 * policy (no error / `EPERM` = alive) and `getProcessStartTime` is the shared
 * `/proc` reader, so no PID logic is duplicated here.
 *
 * @param {unknown} pid
 * @param {unknown} pidStart
 * @returns {boolean}
 */
export function isRecoveryOwnerProcessAlive(pid, pidStart = '') {
  const numericPid = normalizePositiveInteger(pid, 0);
  if (!isProcessAlive(numericPid)) return false;
  const storedStart = text(pidStart);
  if (!storedStart) return true;
  const liveStart = getProcessStartTime(numericPid);
  // An unreadable /proc is not proof of death; only a readable, different
  // starttime is.
  if (!liveStart) return true;
  return storedStart === liveStart;
}

/**
 * Same kill-probe classification as the delegation owner lock, exposed for
 * callers that already hold the raw `process.kill` error (`EPERM` = alive,
 * `ESRCH` = dead, no error = alive).
 *
 * @param {NodeJS.ErrnoException | null | undefined} err
 * @returns {boolean}
 */
export function isRecoveryOwnerKillProbeAlive(err) {
  return isKillProbeAlive(err);
}

// ---------------------------------------------------------------------------
// Store plumbing
// ---------------------------------------------------------------------------

/**
 * Resolve the recovery database handle. An injected open `store` is used as-is;
 * a bare `dataDir` opens (and later closes) a private store; otherwise the
 * process default store is used.
 *
 * Note: `openRecoveryStore` installs the store it opens as the process default,
 * so the `dataDir` convenience path temporarily replaces (and, after closing,
 * clears) the process default. Callers that rely on a process-wide default store
 * should pass an explicit `store` handle instead.
 *
 * @param {object} options
 * @returns {{ store: object | undefined, owned: boolean }}
 */
function resolveLeaseStore(options) {
  const opts = options && typeof options === 'object' ? options : {};
  if (opts.store && typeof opts.store === 'object') return { store: opts.store, owned: false };
  const dataDir = text(opts.dataDir);
  if (dataDir) return { store: openRecoveryStore({ dataDir }), owned: true };
  return { store: undefined, owned: false };
}

/**
 * @param {object} options
 * @param {(db: import('node:sqlite').DatabaseSync) => T} work
 * @returns {T}
 * @template T
 */
function withLeaseStore(options, work) {
  const { store, owned } = resolveLeaseStore(options);
  try {
    /** @type {import('node:sqlite').DatabaseSync} */
    let db;
    try {
      db = getRecoveryStoreDatabase(store);
    } catch (err) {
      if (isRecoveryStoreError(err) && err.code === 'store_not_open') {
        throw new RecoveryOwnerLeaseError(
          'Recovery owner lease requires an open recovery store',
          { code: 'store_unavailable', details: { cause: err.code } }
        );
      }
      throw err;
    }
    return work(db);
  } finally {
    if (owned) closeRecoveryStore(store);
  }
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {() => T} work
 * @returns {T}
 * @template T
 */
function withImmediateTransaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Rollback may fail when the transaction never started.
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {object | null}
 */
function readLeaseRow(db) {
  const row = db
    .prepare(
      `SELECT owner_id, owner_token, pid, pid_start, generation, started_at, heartbeat_at, json
       FROM ${RECOVERY_OWNER_LEASE_TABLE} WHERE id = ?`
    )
    .get(RECOVERY_OWNER_LEASE_ROW_ID);
  return row || null;
}

/**
 * @param {object} row
 * @returns {object}
 */
function parseStoredRecord(row) {
  try {
    const parsed = JSON.parse(String(row.json));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * @param {object} row
 * @returns {number}
 */
function storedTtlMs(row) {
  const record = parseStoredRecord(row);
  const ttl = Number(record.ttlMs);
  return Number.isFinite(ttl) && ttl > 0 ? Math.floor(ttl) : 0;
}

/**
 * @param {object} row
 * @param {number} nowMs
 * @param {number} ttlMs
 * @returns {boolean}
 */
function isLeaseExpired(row, nowMs, ttlMs) {
  const heartbeatMs = Date.parse(text(row.heartbeat_at));
  if (!Number.isFinite(heartbeatMs)) return true;
  return heartbeatMs + ttlMs <= nowMs;
}

/**
 * Public projection of one lease row. `live` is the fencing-relevant bit: the
 * owner process is alive (no PID reuse) and the heartbeat has not expired.
 *
 * @param {object} row
 * @param {number} nowMs
 * @param {unknown} requestedTtl
 * @returns {object}
 */
function buildLeaseView(row, nowMs, requestedTtl) {
  const ttlMs = leaseTtlMs(row, requestedTtl);
  const heartbeatMs = Date.parse(text(row.heartbeat_at));
  const hasHeartbeat = Number.isFinite(heartbeatMs);
  const expiresAtMs = hasHeartbeat ? heartbeatMs + ttlMs : Number.NaN;
  const expired = !hasHeartbeat || expiresAtMs <= nowMs;
  const pid = normalizePositiveInteger(row.pid, 0);
  const ownerAlive = isRecoveryOwnerProcessAlive(pid, row.pid_start);
  return {
    ownerId: text(row.owner_id),
    ownerToken: text(row.owner_token),
    pid,
    pidStart: text(row.pid_start),
    generation: normalizeGeneration(row.generation),
    startedAt: text(row.started_at),
    heartbeatAt: text(row.heartbeat_at),
    expiresAt: Number.isFinite(expiresAtMs) ? toIso(expiresAtMs) : '',
    ttlMs,
    expired,
    pidAlive: isProcessAlive(pid),
    live: ownerAlive && !expired,
  };
}

/**
 * Upsert the singleton lease row.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   ownerId: string,
 *   ownerToken: string,
 *   pid: number,
 *   pidStart: string,
 *   generation: number,
 *   startedAt: string,
 *   heartbeatAt: string,
 *   ttlMs: number,
 * }} lease
 */
function writeLeaseRow(db, lease) {
  const record = {
    schemaVersion: RECOVERY_OWNER_LEASE_SCHEMA_VERSION,
    ownerId: text(lease.ownerId),
    ownerToken: text(lease.ownerToken),
    pid: normalizePositiveInteger(lease.pid, 0),
    pidStart: text(lease.pidStart),
    generation: normalizeGeneration(lease.generation),
    startedAt: text(lease.startedAt),
    heartbeatAt: text(lease.heartbeatAt),
    ttlMs: newLeaseTtlMs(lease.ttlMs, 0),
  };
  db.prepare(
    `INSERT INTO ${RECOVERY_OWNER_LEASE_TABLE}(
       id, owner_id, owner_token, pid, pid_start, generation, started_at, heartbeat_at, json
     ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       owner_id = excluded.owner_id,
       owner_token = excluded.owner_token,
       pid = excluded.pid,
       pid_start = excluded.pid_start,
       generation = excluded.generation,
       started_at = excluded.started_at,
       heartbeat_at = excluded.heartbeat_at,
       json = excluded.json`
  ).run(
    RECOVERY_OWNER_LEASE_ROW_ID,
    record.ownerId,
    record.ownerToken,
    record.pid,
    record.pidStart,
    record.generation,
    record.startedAt,
    record.heartbeatAt,
    JSON.stringify(record)
  );
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 */
function deleteLeaseRow(db) {
  db.prepare(`DELETE FROM ${RECOVERY_OWNER_LEASE_TABLE} WHERE id = ?`).run(
    RECOVERY_OWNER_LEASE_ROW_ID
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Acquire, renew or take over the recovery owner lease.
 *
 * `ownerToken` is generated server-side when omitted; the caller's `pid` and
 * `pidStart` default to this process. A `serverInstanceToken` / `instanceToken`
 * passed in the options object is ignored — it is not an ownership proof.
 *
 * @param {{
 *   dataDir?: string,
 *   store?: object,
 *   ownerId: string,
 *   ownerToken?: string,
 *   pid?: number,
 *   pidStart?: string,
 *   now?: number|string,
 *   ttlMs?: number,
 * }} options
 * @returns {{
 *   acquired: boolean,
 *   renewed: boolean,
 *   takeover: boolean,
 *   reason: string,
 *   ownerToken: string,
 *   generation: number,
 *   lease: object,
 * }}
 * @throws {RecoveryOwnerLeaseError} `invalid_owner` when `ownerId` is empty
 */
export function acquireRecoveryOwnerLease(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const ownerId = text(opts.ownerId);
  if (!ownerId) {
    throw new RecoveryOwnerLeaseError('ownerId is required and must be non-empty', {
      code: 'invalid_owner',
      details: { field: 'ownerId' },
    });
  }
  const ownerToken = text(opts.ownerToken) || randomUUID();
  const pid = normalizePositiveInteger(opts.pid, process.pid);
  const pidStart =
    opts.pidStart === undefined || opts.pidStart === null
      ? getProcessStartTime(pid)
      : text(opts.pidStart);
  const nowMs = resolveNowMs(opts.now);
  const at = toIso(nowMs);

  return withLeaseStore(opts, (db) =>
    withImmediateTransaction(db, () => {
      const row = readLeaseRow(db);

      if (!row) {
        const ttlMs = newLeaseTtlMs(opts.ttlMs, 0);
        writeLeaseRow(db, {
          ownerId,
          ownerToken,
          pid,
          pidStart,
          generation: 1,
          startedAt: at,
          heartbeatAt: at,
          ttlMs,
        });
        const lease = buildLeaseView(readLeaseRow(db), nowMs, ttlMs);
        return {
          acquired: true,
          renewed: false,
          takeover: false,
          reason: 'created',
          ownerToken: lease.ownerToken,
          generation: lease.generation,
          lease,
        };
      }

      const storedTtl = storedTtlMs(row);
      const writeTtl = newLeaseTtlMs(opts.ttlMs, storedTtl);

      if (text(row.owner_token) === ownerToken && text(row.owner_id) === ownerId) {
        writeLeaseRow(db, {
          ownerId,
          ownerToken,
          pid,
          pidStart: pidStart || text(row.pid_start),
          generation: normalizeGeneration(row.generation),
          startedAt: text(row.started_at),
          heartbeatAt: at,
          ttlMs: writeTtl,
        });
        const lease = buildLeaseView(readLeaseRow(db), nowMs, writeTtl);
        return {
          acquired: true,
          renewed: true,
          takeover: false,
          reason: 'renewed',
          ownerToken: lease.ownerToken,
          generation: lease.generation,
          lease,
        };
      }

      const expired = isLeaseExpired(row, nowMs, leaseTtlMs(row, opts.ttlMs));
      const ownerAlive = isRecoveryOwnerProcessAlive(row.pid, row.pid_start);
      if (!ownerAlive || expired) {
        const generation = normalizeGeneration(row.generation) + 1;
        writeLeaseRow(db, {
          ownerId,
          ownerToken,
          pid,
          pidStart,
          generation,
          startedAt: at,
          heartbeatAt: at,
          ttlMs: writeTtl,
        });
        const lease = buildLeaseView(readLeaseRow(db), nowMs, writeTtl);
        return {
          acquired: true,
          renewed: false,
          takeover: true,
          reason: 'takeover',
          ownerToken: lease.ownerToken,
          generation: lease.generation,
          lease,
        };
      }

      const lease = buildLeaseView(row, nowMs, opts.ttlMs);
      return {
        acquired: false,
        renewed: false,
        takeover: false,
        reason: 'owner_held',
        // The candidate token, not the current holder's token: only
        // `acquired:true` makes a token valid, and a naive caller that reuses
        // this value must fail the fence instead of passing it.
        ownerToken,
        generation: lease.generation,
        lease,
      };
    })
  );
}

/**
 * Refresh the heartbeat of an owned lease. Succeeds only when both the
 * `ownerToken` and the `generation` still match the persisted row.
 *
 * @param {{
 *   dataDir?: string,
 *   store?: object,
 *   ownerToken: string,
 *   generation: number,
 *   now?: number|string,
 *   ttlMs?: number,
 * }} options
 * @returns {{ ok: true, lease: object } | { ok: false, reason: string }}
 */
export function renewRecoveryOwnerLease(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const ownerToken = text(opts.ownerToken);
  const generation = normalizeGeneration(opts.generation);
  const nowMs = resolveNowMs(opts.now);
  const at = toIso(nowMs);

  return withLeaseStore(opts, (db) =>
    withImmediateTransaction(db, () => {
      const row = readLeaseRow(db);
      if (!row) return { ok: false, reason: 'no_lease' };
      if (!ownerToken || text(row.owner_token) !== ownerToken) {
        return { ok: false, reason: 'stale_owner' };
      }
      if (normalizeGeneration(row.generation) !== generation) {
        return { ok: false, reason: 'generation_mismatch' };
      }
      const ttlMs = newLeaseTtlMs(opts.ttlMs, storedTtlMs(row));
      writeLeaseRow(db, {
        ownerId: text(row.owner_id),
        ownerToken,
        pid: normalizePositiveInteger(row.pid, 0),
        pidStart: text(row.pid_start),
        generation,
        startedAt: text(row.started_at),
        heartbeatAt: at,
        ttlMs,
      });
      return { ok: true, lease: buildLeaseView(readLeaseRow(db), nowMs, ttlMs) };
    })
  );
}

/**
 * Describe the current lease without mutating it.
 *
 * @param {{
 *   dataDir?: string,
 *   store?: object,
 *   now?: number|string,
 *   ttlMs?: number,
 * }} [options]
 * @returns {{ held: false } | ({ held: true } & object)}
 */
export function getRecoveryOwnerLease(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const nowMs = resolveNowMs(opts.now);
  return withLeaseStore(opts, (db) => {
    const row = readLeaseRow(db);
    if (!row) return { held: false };
    return { held: true, ...buildLeaseView(row, nowMs, opts.ttlMs) };
  });
}

/**
 * Gate a callback against the current owner. Returns `{ ok:true }` only when the
 * row exists, the token and generation match, and the lease is live (owner
 * process alive, heartbeat unexpired). Any callback issued before a takeover is
 * therefore rejected.
 *
 * @param {{
 *   dataDir?: string,
 *   store?: object,
 *   ownerToken: string,
 *   generation: number,
 *   now?: number|string,
 *   ttlMs?: number,
 * }} options
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function checkRecoveryOwnerFence(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const ownerToken = text(opts.ownerToken);
  const generation = normalizeGeneration(opts.generation);
  const nowMs = resolveNowMs(opts.now);

  return withLeaseStore(opts, (db) => {
    const row = readLeaseRow(db);
    if (!row) return { ok: false, reason: 'no_lease' };
    if (!ownerToken || text(row.owner_token) !== ownerToken) {
      return { ok: false, reason: 'stale_owner' };
    }
    if (normalizeGeneration(row.generation) !== generation) {
      return { ok: false, reason: 'generation_mismatch' };
    }
    const ttlMs = leaseTtlMs(row, opts.ttlMs);
    if (isLeaseExpired(row, nowMs, ttlMs)) return { ok: false, reason: 'lease_expired' };
    if (!isRecoveryOwnerProcessAlive(row.pid, row.pid_start)) {
      return { ok: false, reason: 'owner_dead' };
    }
    return { ok: true };
  });
}

/**
 * Drop the singleton lease, but only when the caller still owns it. A foreign or
 * stale token can neither delete nor take over another owner's lease.
 *
 * @param {{
 *   dataDir?: string,
 *   store?: object,
 *   ownerToken: string,
 *   generation?: number,
 * }} options
 * @returns {{ released: boolean, reason: string }}
 */
export function releaseRecoveryOwnerLease(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const ownerToken = text(opts.ownerToken);
  const hasGeneration =
    opts.generation !== undefined && opts.generation !== null && opts.generation !== '';
  const generation = normalizeGeneration(opts.generation);

  return withLeaseStore(opts, (db) =>
    withImmediateTransaction(db, () => {
      const row = readLeaseRow(db);
      if (!row) return { released: false, reason: 'no_lease' };
      if (!ownerToken || text(row.owner_token) !== ownerToken) {
        return { released: false, reason: 'stale_owner' };
      }
      if (hasGeneration && normalizeGeneration(row.generation) !== generation) {
        return { released: false, reason: 'generation_mismatch' };
      }
      deleteLeaseRow(db);
      return { released: true, reason: 'released' };
    })
  );
}
