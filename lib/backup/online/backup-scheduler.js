/**
 * Opt-in scheduler for online backups (B6). Off by default.
 *
 * Policy and run state live in the control directory (outside every restore-managed path and never
 * archived), so a restore can neither enable the scheduler nor roll its bookkeeping back. The target
 * directory must be outside the data directory (ideally another disk) so a backup can never be part of
 * a later backup or be replaced by a restore. One job at a time, enforced by a restart-safe lease file:
 * a lease whose owner process is gone (or whose TTL ran out) is taken over, a live one is respected.
 *
 * Proposed defaults once enabled: daily, keep the 7 newest successful scheduled archives. An external
 * restore pause pauses the scheduler too.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isPidAlive, isRestorePaused, readJsonStrict, writeJsonDurable } from '../offline/control-dir.js';
import { OfflineDataError } from '../offline/offline-errors.js';
import { applyRetention } from './retention.js';

export const DEFAULT_POLICY = Object.freeze({ enabled: false, intervalHours: 24, keep: 7, targetDir: '', encrypt: true });
export const JOB_LEASE_TTL_MS = 6 * 60 * 60 * 1000;
export const DEFER_RETRY_MS = 15 * 60 * 1000;
export const FAILURE_RETRY_MS = 60 * 60 * 1000;
const POLICY_FILE = 'online-backup-policy.json';
const STATE_FILE = 'online-backup-state.json';
const LEASE_FILE = 'online-backup-job-lease.json';

/**
 * @param {string} p
 * @returns {string} realpath of the nearest existing ancestor joined with the remaining tail
 */
function realish(p) {
  let cur = path.resolve(p);
  const tail = [];
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...tail.reverse()); } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * @param {string} child
 * @param {string} parent
 */
function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Target must not be inside (or equal to) the data directory or the control directory, and must not
 * contain either of them.
 *
 * @param {string} targetDir
 * @param {{ dataDir: string, controlDir: string }} dirs
 * @returns {string} resolved real path
 * @throws {OfflineDataError} TARGET_INVALID
 */
export function validateTargetDir(targetDir, dirs) {
  const raw = String(targetDir || '').trim();
  if (!raw || !path.isAbsolute(raw)) throw new OfflineDataError('TARGET_INVALID', 'backup target must be an absolute directory path');
  const target = realish(raw);
  for (const [name, dir] of [['data', dirs.dataDir], ['control', dirs.controlDir]]) {
    const real = realish(dir);
    if (isInside(target, real) || isInside(real, target)) {
      throw new OfflineDataError('TARGET_INVALID', `backup target must be separate from the ${name} directory (restore paths and archive scope)`);
    }
  }
  return target;
}

/**
 * @param {unknown} raw
 * @returns {{ enabled: boolean, intervalHours: number, keep: number, targetDir: string, encrypt: boolean }}
 */
export function normalizePolicy(raw) {
  const p = raw && typeof raw === 'object' ? /** @type {Record<string, any>} */ (raw) : {};
  const intervalHours = p.intervalHours === undefined ? DEFAULT_POLICY.intervalHours : Number(p.intervalHours);
  const keep = p.keep === undefined ? DEFAULT_POLICY.keep : Number(p.keep);
  if (!Number.isFinite(intervalHours) || intervalHours < 1 || intervalHours > 24 * 30) throw new OfflineDataError('POLICY_INVALID', 'intervalHours must be between 1 and 720');
  if (!Number.isInteger(keep) || keep < 1 || keep > 365) throw new OfflineDataError('POLICY_INVALID', 'keep must be an integer between 1 and 365');
  return {
    enabled: p.enabled === true,
    intervalHours,
    keep,
    targetDir: typeof p.targetDir === 'string' ? p.targetDir.trim() : '',
    encrypt: p.encrypt !== false,
  };
}

/**
 * @param {{
 *   controlDir: string, dataDir: string,
 *   runBackup: (opts: { destRoot: string, password?: string }) => Promise<{ id: string, path: string, kind: string, bytes: number, createdAt: string }>,
 *   capability: () => { enabled: boolean, reasons: object[] },
 *   passwordProvider?: () => string | undefined,
 *   now?: () => number,
 *   isPidAlive?: (pid: number) => boolean,
 *   setTimer?: typeof setInterval,
 *   clearTimer?: typeof clearInterval,
 * }} options
 */
export function createBackupScheduler(options) {
  const now = options.now || Date.now;
  const alive = options.isPidAlive || isPidAlive;
  const policyFile = path.join(options.controlDir, POLICY_FILE);
  const stateFile = path.join(options.controlDir, STATE_FILE);
  const leaseFile = path.join(options.controlDir, LEASE_FILE);
  /** @type {any} */
  let timer = null;

  function readPolicy() {
    const raw = readJsonStrict(policyFile);
    return raw ? normalizePolicy(raw) : { ...DEFAULT_POLICY };
  }

  /** @returns {any} a corrupt state file throws (fail closed: no retention on unknown history) */
  function readState() {
    const raw = readJsonStrict(stateFile);
    if (!raw) return { schema: 1, archives: [], lastSuccess: null, lastFailure: null, lastDeferral: null, nextAttemptAt: 0, consecutiveFailures: 0 };
    if (raw.schema !== 1 || !Array.isArray(raw.archives)) throw new OfflineDataError('CONTROL_CORRUPT', 'unsupported online backup state');
    return raw;
  }

  function writeState(state) {
    fs.mkdirSync(options.controlDir, { recursive: true, mode: 0o700 });
    writeJsonDurable(stateFile, state);
  }

  /**
   * Single-job lease. `wx` create; a stale one (dead pid on this host, or past its TTL) is replaced.
   * @returns {{ token: string, release: () => void } | null} null when a live job holds it
   */
  function acquireJobLease() {
    fs.mkdirSync(options.controlDir, { recursive: true, mode: 0o700 });
    const token = crypto.randomUUID();
    const body = () => JSON.stringify({ token, pid: process.pid, host: os.hostname(), acquiredAt: new Date(now()).toISOString(), expiresAt: now() + JOB_LEASE_TTL_MS });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        fs.writeFileSync(leaseFile, body(), { flag: 'wx', mode: 0o600 });
        return {
          token,
          release() {
            try {
              if (JSON.parse(fs.readFileSync(leaseFile, 'utf8')).token === token) fs.unlinkSync(leaseFile);
            } catch { /* already gone */ }
          },
        };
      } catch (err) {
        if (/** @type {any} */ (err)?.code !== 'EEXIST') throw err;
      }
      let cur = null;
      try { cur = JSON.parse(fs.readFileSync(leaseFile, 'utf8')); } catch { /* unreadable */ }
      const expired = cur && Number(cur.expiresAt) <= now();
      const ownerGone = cur && cur.host === os.hostname() && !alive(Number(cur.pid));
      if (!cur || (!expired && !ownerGone)) return null; // live (or unknown) owner: respect it
      try { fs.unlinkSync(leaseFile); } catch { /* raced with another taker; the retry decides */ }
    }
    return null;
  }

  /**
   * @param {{ origin: 'scheduled' | 'manual', force?: boolean }} spec
   */
  async function execute(spec) {
    const policy = readPolicy();
    if (spec.origin === 'scheduled' && !policy.enabled) return { status: 'disabled' };
    if (isRestorePaused(options.controlDir)) return { status: 'paused' };
    const cap = options.capability();
    if (!cap.enabled) return { status: 'unavailable', reasons: cap.reasons };
    const state = readState();
    const t = now();
    const intervalMs = policy.intervalHours * 3600 * 1000;
    if (spec.origin === 'scheduled') {
      if (t < Number(state.nextAttemptAt || 0)) return { status: 'waiting', nextAttemptAt: state.nextAttemptAt };
      const slot = Math.floor(t / intervalMs);
      if (state.lastSuccess && (state.lastSuccess.slot === slot || t < Date.parse(state.lastSuccess.at) + intervalMs)) {
        return { status: 'not_due' };
      }
    }
    const lease = acquireJobLease();
    if (!lease) return { status: 'busy' };
    try {
      let target;
      try {
        target = validateTargetDir(policy.targetDir, { dataDir: options.dataDir, controlDir: options.controlDir });
      } catch (err) {
        return recordFailure(state, err, spec);
      }
      let password;
      if (policy.encrypt) {
        password = options.passwordProvider?.();
        if (!password) return recordFailure(state, new OfflineDataError('KEY_MISSING', 'scheduled encryption needs the operator-provided key; no backup was made'), spec);
      }
      /** @type {Awaited<ReturnType<typeof options.runBackup>>} */
      let made;
      try {
        made = await options.runBackup({ destRoot: target, password });
      } catch (err) {
        return recordFailure(state, err, spec);
      }
      const fresh = readState(); // another process may have updated bookkeeping; never overwrite it blindly
      const record = { id: made.id, name: path.basename(made.path), origin: spec.origin, verifiedAt: new Date(now()).toISOString(), kind: made.kind, bytes: made.bytes };
      fresh.archives.push(record);
      fresh.lastSuccess = { id: made.id, at: record.verifiedAt, slot: Math.floor(now() / intervalMs), origin: spec.origin };
      fresh.consecutiveFailures = 0;
      fresh.nextAttemptAt = 0;
      fresh.lastFailure = null;
      fresh.lastDeferral = null;
      // Retention: only for scheduled runs and only now that the new backup is recorded as verified.
      let retention = null;
      if (spec.origin === 'scheduled') {
        try {
          const r = applyRetention({ targetDir: target, archives: fresh.archives, keep: policy.keep, newId: made.id });
          fresh.archives = r.archives;
          retention = { deleted: r.deleted.length, skipped: r.skipped || null };
        } catch (err) {
          retention = { error: String(/** @type {any} */ (err)?.message || err) };
        }
      }
      writeState(fresh);
      return { status: 'succeeded', id: made.id, retention };
    } finally {
      lease.release();
    }
  }

  /**
   * A failure never touches retention or the archive list.
   * @param {any} state
   * @param {any} err
   * @param {{ origin: string }} spec
   */
  function recordFailure(state, err, spec) {
    const code = String(err?.code || 'BACKUP_FAILED');
    const deferred = err?.deferred === true;
    const message = String(err?.message || err).slice(0, 300);
    if (deferred) {
      state.lastDeferral = { at: new Date(now()).toISOString(), code, message };
      if (spec.origin === 'scheduled') state.nextAttemptAt = now() + DEFER_RETRY_MS;
    } else {
      state.lastFailure = { at: new Date(now()).toISOString(), code, message };
      state.consecutiveFailures = Number(state.consecutiveFailures || 0) + 1;
      if (spec.origin === 'scheduled') state.nextAttemptAt = now() + FAILURE_RETRY_MS;
    }
    try { writeState(state); } catch { /* the original failure is what matters */ }
    return { status: deferred ? 'deferred' : 'failed', code, message };
  }

  return Object.freeze({
    getPolicy: readPolicy,
    /** @param {unknown} patch */
    setPolicy(patch) {
      const next = normalizePolicy({ ...readPolicy(), ...(patch && typeof patch === 'object' ? patch : {}) });
      if (next.enabled) validateTargetDir(next.targetDir, { dataDir: options.dataDir, controlDir: options.controlDir });
      fs.mkdirSync(options.controlDir, { recursive: true, mode: 0o700 });
      writeJsonDurable(policyFile, next);
      return next;
    },
    status() {
      const state = readState();
      return {
        policy: readPolicy(),
        paused: isRestorePaused(options.controlDir),
        capability: options.capability(),
        lastSuccess: state.lastSuccess,
        lastFailure: state.lastFailure,
        lastDeferral: state.lastDeferral,
        nextAttemptAt: state.nextAttemptAt || 0,
        archives: state.archives.map((a) => ({ id: a.id, origin: a.origin, verifiedAt: a.verifiedAt, kind: a.kind, bytes: a.bytes })),
      };
    },
    /** One scheduler pass; safe to call concurrently (the job lease admits one). */
    tick: () => execute({ origin: 'scheduled' }),
    /** Manual online backup into the configured target; never pruned by retention. */
    runNow: () => execute({ origin: 'manual' }),
    start(intervalMs = 60000) {
      if (timer) return;
      const set = options.setTimer || setInterval;
      timer = set(() => { void execute({ origin: 'scheduled' }).catch(() => {}); }, intervalMs);
      timer?.unref?.();
    },
    stop() {
      if (timer) (options.clearTimer || clearInterval)(timer);
      timer = null;
    },
  });
}
