/**
 * Browser lifecycle helpers (P2c): resolved production limits, bounded
 * per-workspace metrics, a respawn/backoff controller and a file-backed
 * Chromium PID store.
 *
 * Everything here is injectable (`now`, timers, liveness probes) so the session
 * manager can be exercised without a real Chromium, and nothing throws: a
 * lifecycle failure must never take the Browser module down with it.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { BROWSER_LIMITS } from './constants.js';

/** File name of the crash-surviving Chromium PID store. */
export const BROWSER_PID_STORE_FILENAME = 'browser-chromium-pids.json';

/** Longest error code stored in the metrics (a code is a short identifier). */
const METRICS_ERROR_CODE_MAX = 64;

/**
 * Parses a positive integer and falls back for anything absent, non-numeric or
 * non-positive. A zero/negative env override must not be able to disable a cap
 * silently, so it is treated as "not set".
 * @param {unknown} raw
 * @param {unknown} fallback
 * @returns {number|undefined}
 */
function positiveInt(raw, fallback) {
  const value = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? '').trim(), 10);
  if (Number.isInteger(value) && value > 0) return value;
  return Number.isInteger(fallback) && fallback > 0 ? fallback : undefined;
}

/**
 * Resolves the P2c lifecycle limits: env overrides first, constant defaults
 * second, never a non-positive or unparsable value.
 * @param {Record<string, string|undefined>} [env]
 * @param {Record<string, any>} [base]
 * @returns {{ maxSessionsGlobal: number|undefined, maxSessionsPerWorkspace: number|undefined, respawnMaxAttempts: number|undefined, respawnBaseDelayMs: number|undefined, respawnMaxDelayMs: number|undefined, respawnWindowMs: number|undefined, metricsMaxWorkspaces: number|undefined }}
 */
export function resolveLifecycleLimits(env = process.env, base = BROWSER_LIMITS) {
  const fromEnv = env || {};
  const fromBase = base || {};
  return {
    maxSessionsGlobal: positiveInt(fromEnv.CRETLI_BROWSER_MAX_SESSIONS_GLOBAL, fromBase.MAX_SESSIONS_GLOBAL),
    maxSessionsPerWorkspace: positiveInt(fromEnv.CRETLI_BROWSER_MAX_SESSIONS_PER_WORKSPACE, fromBase.MAX_SESSIONS_PER_WORKSPACE),
    respawnMaxAttempts: positiveInt(fromEnv.CRETLI_BROWSER_RESPAWN_MAX_ATTEMPTS, fromBase.RESPAWN_MAX_ATTEMPTS),
    respawnBaseDelayMs: positiveInt(fromEnv.CRETLI_BROWSER_RESPAWN_BASE_DELAY_MS, fromBase.RESPAWN_BASE_DELAY_MS),
    respawnMaxDelayMs: positiveInt(fromEnv.CRETLI_BROWSER_RESPAWN_MAX_DELAY_MS, fromBase.RESPAWN_MAX_DELAY_MS),
    respawnWindowMs: positiveInt(fromEnv.CRETLI_BROWSER_RESPAWN_WINDOW_MS, fromBase.RESPAWN_WINDOW_MS),
    metricsMaxWorkspaces: positiveInt(fromEnv.CRETLI_BROWSER_METRICS_MAX_WORKSPACES, fromBase.METRICS_MAX_WORKSPACES),
  };
}

/**
 * Default liveness probe: `process.kill(pid, 0)` succeeds for a live process and
 * raises `EPERM` when it exists but is owned by another user (still alive).
 * @param {unknown} pid
 * @returns {boolean}
 */
export function defaultIsProcessAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/**
 * Default Chromium probe: on Linux the process `comm` must match /chrom/i. On a
 * non-Linux host, or when `/proc` cannot be read, the answer is `true` so an
 * orphan is still swept rather than silently kept.
 * @param {unknown} pid
 * @returns {boolean}
 */
export function defaultLooksLikeChromium(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  if (process.platform !== 'linux') return true;
  try {
    const comm = readFileSync(`/proc/${value}/comm`, 'utf8').trim();
    return /chrom/i.test(comm);
  } catch {
    return true;
  }
}

/** @returns {object} a fresh metrics bucket with all counters at zero. */
function createMetricsBucket() {
  return {
    sessionsStarted: 0,
    sessionsClosed: 0,
    sessionErrors: 0,
    tabsOpened: 0,
    respawns: 0,
    respawnFailures: 0,
    orphanSweeps: 0,
    orphansKilled: 0,
    lifetimeMsTotal: 0,
    lifetimeMsMax: 0,
    lastSessionAt: null,
    lastTouchedAt: 0,
    lastErrorCode: null,
  };
}

/**
 * Coerces a value into a non-negative finite counter/duration.
 * @param {unknown} value
 * @returns {number}
 */
function safeCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Bounded per-workspace Browser metrics.
 *
 * Only counts, durations, timestamps, workspace keys and short error-code
 * strings are stored — never URLs, headers, cookies, tokens or error messages.
 * At most `maxWorkspaces` workspace buckets are kept; the least-recently-used
 * one is evicted when a new workspace appears.
 */
export class BrowserMetrics {
  /**
   * @param {{ maxWorkspaces?: number, now?: () => number }} [options]
   */
  constructor({ maxWorkspaces = 100, now = () => Date.now() } = {}) {
    this.maxWorkspaces = Number.isInteger(maxWorkspaces) && maxWorkspaces > 0 ? maxWorkspaces : 100;
    this.now = typeof now === 'function' ? now : () => Date.now();
    /** @type {Map<string, ReturnType<typeof createMetricsBucket>>} */
    this.workspaces = new Map();
    this.global = createMetricsBucket();
  }

  /**
   * @param {unknown} at
   * @returns {number}
   */
  _timestamp(at) {
    const value = Number(at);
    if (Number.isFinite(value)) return value;
    try {
      const fallback = Number(this.now());
      return Number.isFinite(fallback) ? fallback : Date.now();
    } catch {
      return Date.now();
    }
  }

  /**
   * Returns the bucket for a workspace, creating (and LRU-evicting) as needed.
   * @param {unknown} workspaceKey
   * @param {number} at
   */
  _bucket(workspaceKey, at) {
    const key = String(workspaceKey ?? '');
    let bucket = this.workspaces.get(key);
    if (!bucket) {
      if (this.workspaces.size >= this.maxWorkspaces) this._evictLeastRecent();
      bucket = createMetricsBucket();
      this.workspaces.set(key, bucket);
    }
    bucket.lastTouchedAt = at;
    return bucket;
  }

  /** Drops the least-recently-used workspace bucket. */
  _evictLeastRecent() {
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [key, bucket] of this.workspaces) {
      if (bucket.lastTouchedAt < oldestAt) {
        oldestAt = bucket.lastTouchedAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== null) this.workspaces.delete(oldestKey);
  }

  /**
   * @param {unknown} workspaceKey
   * @param {number} [at]
   */
  recordSessionStart(workspaceKey, at) {
    const ts = this._timestamp(at);
    const bucket = this._bucket(workspaceKey, ts);
    bucket.sessionsStarted += 1;
    bucket.lastSessionAt = ts;
    this.global.sessionsStarted += 1;
    this.global.lastSessionAt = ts;
  }

  /**
   * @param {unknown} workspaceKey
   * @param {{ lifetimeMs?: number, at?: number }} [input]
   */
  recordSessionClose(workspaceKey, { lifetimeMs = 0, at } = {}) {
    const ts = this._timestamp(at);
    const duration = safeCount(lifetimeMs);
    const bucket = this._bucket(workspaceKey, ts);
    bucket.sessionsClosed += 1;
    bucket.lifetimeMsTotal += duration;
    bucket.lifetimeMsMax = Math.max(bucket.lifetimeMsMax, duration);
    bucket.lastSessionAt = ts;
    this.global.sessionsClosed += 1;
    this.global.lifetimeMsTotal += duration;
    this.global.lifetimeMsMax = Math.max(this.global.lifetimeMsMax, duration);
    this.global.lastSessionAt = ts;
  }

  /**
   * @param {unknown} workspaceKey
   * @param {unknown} code
   * @param {number} [at]
   */
  recordSessionError(workspaceKey, code, at) {
    const ts = this._timestamp(at);
    const bucket = this._bucket(workspaceKey, ts);
    const errorCode = code == null ? null : String(code).slice(0, METRICS_ERROR_CODE_MAX);
    bucket.sessionErrors += 1;
    bucket.lastErrorCode = errorCode;
    this.global.sessionErrors += 1;
    this.global.lastErrorCode = errorCode;
  }

  /**
   * @param {unknown} workspaceKey
   * @param {number} [at]
   */
  recordTabOpen(workspaceKey, at) {
    const ts = this._timestamp(at);
    const bucket = this._bucket(workspaceKey, ts);
    bucket.tabsOpened += 1;
    this.global.tabsOpened += 1;
  }

  /**
   * @param {unknown} workspaceKey
   * @param {{ ok?: boolean, at?: number }} [input]
   */
  recordRespawn(workspaceKey, { ok = false, at } = {}) {
    const ts = this._timestamp(at);
    const bucket = this._bucket(workspaceKey, ts);
    bucket.respawns += 1;
    if (!ok) bucket.respawnFailures += 1;
    this.global.respawns += 1;
    if (!ok) this.global.respawnFailures += 1;
  }

  /**
   * @param {{ killed?: number, checked?: number }} [input]
   */
  recordOrphanSweep({ killed = 0, checked = 0 } = {}) {
    void checked;
    this.global.orphanSweeps += 1;
    this.global.orphansKilled += safeCount(killed);
  }

  /** @returns {object} a JSON-safe snapshot (no secrets, bounded workspaces). */
  snapshot() {
    const generatedAt = this._timestamp(undefined);
    const workspaces = [...this.workspaces.entries()]
      .map(([workspaceKey, bucket]) => ({
        workspaceKey,
        sessionsStarted: bucket.sessionsStarted,
        sessionsClosed: bucket.sessionsClosed,
        sessionErrors: bucket.sessionErrors,
        tabsOpened: bucket.tabsOpened,
        respawns: bucket.respawns,
        respawnFailures: bucket.respawnFailures,
        lifetimeMsTotal: bucket.lifetimeMsTotal,
        lifetimeMsMax: bucket.lifetimeMsMax,
        lastSessionAt: bucket.lastSessionAt,
      }))
      .sort((a, b) => (Number(b.lastSessionAt) || 0) - (Number(a.lastSessionAt) || 0));
    return {
      generatedAt,
      global: {
        sessionsStarted: this.global.sessionsStarted,
        sessionsClosed: this.global.sessionsClosed,
        sessionErrors: this.global.sessionErrors,
        tabsOpened: this.global.tabsOpened,
        respawns: this.global.respawns,
        respawnFailures: this.global.respawnFailures,
        orphanSweeps: this.global.orphanSweeps,
        orphansKilled: this.global.orphansKilled,
        lifetimeMsTotal: this.global.lifetimeMsTotal,
        lifetimeMsMax: this.global.lifetimeMsMax,
        lastSessionAt: this.global.lastSessionAt,
      },
      workspaces,
    };
  }
}

/**
 * Bounded exponential-backoff controller for relaunching a crashed driver.
 *
 * `schedule()` resolves `true` only when `launch()` resolved. At most
 * `maxAttempts` launches are allowed inside a sliding `windowMs`; once that is
 * exceeded the controller reports `exhausted` and refuses to launch until
 * `reset()` clears the window.
 * @param {{
 *   launch?: () => Promise<unknown>|unknown,
 *   maxAttempts?: number,
 *   baseDelayMs?: number,
 *   maxDelayMs?: number,
 *   windowMs?: number,
 *   now?: () => number,
 *   setTimeoutFn?: (fn: () => void, delayMs: number) => unknown,
 *   onEvent?: (event: object) => void,
 * }} [options]
 * @returns {{ schedule: (reason?: unknown) => Promise<boolean>, reset: () => void, status: () => object }}
 */
export function createRespawnController(options = {}) {
  const launch = typeof options.launch === 'function' ? options.launch : async () => {};
  const maxAttempts = positiveInt(options.maxAttempts, BROWSER_LIMITS.RESPAWN_MAX_ATTEMPTS) ?? 3;
  const baseDelayMs = positiveInt(options.baseDelayMs, BROWSER_LIMITS.RESPAWN_BASE_DELAY_MS) ?? 1000;
  const maxDelayMs = positiveInt(options.maxDelayMs, BROWSER_LIMITS.RESPAWN_MAX_DELAY_MS) ?? 30000;
  const windowMs = positiveInt(options.windowMs, BROWSER_LIMITS.RESPAWN_WINDOW_MS) ?? 600000;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const setTimeoutFn = typeof options.setTimeoutFn === 'function' ? options.setTimeoutFn : setTimeout;
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : null;

  /** @type {number[]} schedule timestamps still inside the sliding window. */
  const attempts = [];
  let lastReason = null;
  let lastAttemptAt = null;
  let lastOkAt = null;
  let exhausted = false;

  const clock = () => {
    try {
      const value = Number(now());
      return Number.isFinite(value) ? value : Date.now();
    } catch {
      return Date.now();
    }
  };

  const emit = (event) => {
    if (!onEvent) return;
    try {
      onEvent(event);
    } catch {
      // Observers must not be able to break the backoff controller.
    }
  };

  const prune = (at) => {
    const cutoff = at - windowMs;
    while (attempts.length > 0 && attempts[0] <= cutoff) attempts.shift();
  };

  const delayFor = (index) => Math.min(maxDelayMs, baseDelayMs * (2 ** Math.max(0, index)));

  const status = () => ({
    attempts: attempts.length,
    lastReason,
    lastAttemptAt,
    lastOkAt,
    exhausted,
    nextDelayMs: delayFor(attempts.length),
  });

  /**
   * @param {unknown} [reason]
   * @returns {Promise<boolean>}
   */
  const schedule = (reason) => new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const at = clock();
      prune(at);
      lastReason = reason == null ? null : String(reason);
      if (attempts.length >= maxAttempts) {
        exhausted = true;
        emit({ type: 'exhausted', reason: lastReason, attempts: attempts.length });
        finish(false);
        return;
      }
      const index = attempts.length;
      const delay = delayFor(index);
      // Reserve the slot before the async delay so two concurrent callers cannot
      // both pass the window check.
      attempts.push(at);
      exhausted = false;
      const run = () => {
        const attemptAt = clock();
        lastAttemptAt = attemptAt;
        emit({ type: 'attempt', reason: lastReason, attempt: index + 1, delayMs: delay });
        let result;
        try {
          result = launch();
        } catch (err) {
          result = Promise.reject(err);
        }
        Promise.resolve(result).then(
          () => {
            lastOkAt = clock();
            emit({ type: 'ok', reason: lastReason, attempt: index + 1 });
            finish(true);
          },
          () => {
            emit({ type: 'fail', reason: lastReason, attempt: index + 1 });
            finish(false);
          },
        );
      };
      try {
        if (delay > 0) setTimeoutFn(run, delay);
        else run();
      } catch {
        finish(false);
      }
    } catch {
      finish(false);
    }
  });

  const reset = () => {
    attempts.length = 0;
    exhausted = false;
    emit({ type: 'reset' });
  };

  return { schedule, reset, status };
}

/**
 * Creates a small JSON store for Chromium root PIDs that must survive a server
 * restart. With an empty `dataDir` it is an in-memory store only. Every method
 * is best-effort and never throws.
 * @param {string} [dataDir]
 * @returns {{ read: () => Array<{ pid: number, executablePath: string, recordedAt: number }>, write: (entries: unknown) => boolean, clear: () => boolean, file: string }}
 */
export function createPidStore(dataDir) {
  const dir = String(dataDir || '');
  const file = dir ? path.join(dir, BROWSER_PID_STORE_FILENAME) : '';
  /** @type {Array<{ pid: number, executablePath: string, recordedAt: number }>} */
  let memory = [];

  /**
   * @param {unknown} entries
   * @returns {Array<{ pid: number, executablePath: string, recordedAt: number }>}
   */
  const sanitize = (entries) => {
    if (!Array.isArray(entries)) return [];
    const clean = [];
    for (const entry of entries) {
      const pid = Number.parseInt(String(entry?.pid ?? ''), 10);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      const recordedAt = Number(entry?.recordedAt);
      clean.push({
        pid,
        executablePath: entry?.executablePath == null ? '' : String(entry.executablePath).slice(0, 1024),
        recordedAt: Number.isFinite(recordedAt) && recordedAt > 0 ? recordedAt : 0,
      });
    }
    return clean;
  };

  const read = () => {
    if (!file) return memory.map((entry) => ({ ...entry }));
    try {
      return sanitize(JSON.parse(readFileSync(file, 'utf8')));
    } catch {
      return [];
    }
  };

  const write = (entries) => {
    const clean = sanitize(entries);
    if (!file) {
      memory = clean;
      return true;
    }
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, `${JSON.stringify(clean, null, 2)}\n`, { mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  };

  const clear = () => {
    if (!file) {
      memory = [];
      return true;
    }
    try {
      if (existsSync(file)) rmSync(file, { force: true });
      return true;
    } catch {
      return false;
    }
  };

  return { read, write, clear, file };
}
