/**
 * Local usage correction for plan windows (D7).
 *
 * Provider readings lag behind reality, so every delegation that really starts
 * reserves an estimated number of percentage points on the windows it burns
 * (five_hour + seven_day of its harness + the matching model window). The
 * picker only READS the reservations (synchronously, through a small in-memory
 * cache) and overlays them on the measured rows; the single writer is
 * `delegation-service` at the confirmed start of a specific attempt. A
 * reservation disappears when a newer measurement arrives, when the window's
 * `resetsAt` changes, or after the TTL (per entry).
 *
 * File: `data/plan-window-reservations.json`
 * Key: `harness|rateLimitType|resetsAt`; idempotency key: `delegationId[:attemptId]`.
 *
 * Safety properties:
 * - read-modify-write runs under a token-owned lockfile, so two processes
 *   never overwrite each other's entries; a held lock skips the write at once
 *   (`skipped: 'lock-timeout'`) instead of blocking a delegation start;
 * - a skipped write is kept in a bounded in-memory queue and retried at the
 *   next delegation start (see `queuePlanWindowReservation`), so the correction
 *   is delayed, not lost;
 * - the store is bounded (entries and bytes); a corrupt, oversized or missing
 *   file reads as empty;
 * - entries stamped in the future (clock skew) are ignored.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveDataPath } from './runtime-paths.js';
import { writeJsonAtomic } from './persist/atomic-write.js';
import {
  PLAN_WINDOW_ESTIMATE_PP,
  PLAN_WINDOW_RESERVATION_TTL_MS,
} from './model-pick-plan-window-gate.js';
import { PLAN_WINDOW_TYPES, selectPlanWindows } from './model-pick-plan-window.js';

const RESERVATIONS_FILE = 'plan-window-reservations.json';
/** Hard caps: the file stays small even if a writer misbehaves. */
export const PLAN_WINDOW_RESERVATION_MAX_ENTRIES = 200;
export const PLAN_WINDOW_RESERVATION_MAX_SLOTS = 40;
export const PLAN_WINDOW_RESERVATION_MAX_FILE_BYTES = 64 * 1024;
/** An entry stamped further in the future than this is clock skew, not usage. */
export const PLAN_WINDOW_RESERVATION_FUTURE_SKEW_MS = 60 * 1000;
/** Lockfile: a held lock is never waited on; a leftover older than this is stolen. */
const LOCK_STALE_MS = 5 * 1000;
/** Picker-side read cache (stat-validated; the TTL bounds staleness). */
const READ_CACHE_TTL_MS = 1000;
const READ_CACHE_MAX_FILES = 8;
/**
 * In-memory retry queue for reservations whose synchronous write lost the lock
 * race. Bounded and drained at the next delegation start, so a lock timeout
 * delays the local usage correction instead of dropping it.
 */
export const PLAN_WINDOW_RESERVATION_QUEUE_MAX = 100;

const CHARGED_TYPES = new Set([
  PLAN_WINDOW_TYPES.FIVE_HOUR,
  PLAN_WINDOW_TYPES.SEVEN_DAY,
  PLAN_WINDOW_TYPES.SEVEN_DAY_OPUS,
  PLAN_WINDOW_TYPES.SEVEN_DAY_SONNET,
]);

/** @type {Map<string, { mtimeNs: bigint, ino: bigint, size: number, loadedAt: number, raw: object }>} */
const readCache = new Map();

/** @type {Map<string, object>} idempotencyKey -> payload awaiting a write */
const reservationQueue = new Map();

/**
 * @param {unknown} dataDir
 * @returns {string}
 */
function resolveFile(dataDir) {
  const override = String(dataDir || '').trim();
  return override ? path.join(override, RESERVATIONS_FILE) : resolveDataPath(RESERVATIONS_FILE);
}

/**
 * @param {string} harness
 * @param {string} rateLimitType
 * @param {string} resetsAt
 * @returns {string}
 */
export function reservationKey(harness, rateLimitType, resetsAt) {
  return `${String(harness).toLowerCase()}|${String(rateLimitType)}|${String(resetsAt)}`;
}

/**
 * @param {string} key
 * @returns {{ harness: string, rateLimitType: string, resetsAt: string }}
 */
function parseKey(key) {
  const [harness = '', rateLimitType = '', ...rest] = String(key).split('|');
  return { harness, rateLimitType, resetsAt: rest.join('|') };
}

/**
 * Drop invalid, expired and future-dated entries and empty slots. Pure.
 *
 * @param {unknown} raw
 * @param {number} now
 * @returns {Record<string, { createdAt?: string, updatedAt?: string, entries: Record<string, { pp: number, at: string }> }>}
 */
function normalizeStore(raw, now) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, slot] of Object.entries(raw)) {
    if (!slot || typeof slot !== 'object' || !slot.entries || typeof slot.entries !== 'object') continue;
    const entries = {};
    for (const [id, entry] of Object.entries(slot.entries)) {
      const at = Date.parse(String(entry?.at || ''));
      const pp = Number(entry?.pp);
      if (!Number.isFinite(at) || !Number.isFinite(pp) || pp <= 0) continue;
      if (at > now + PLAN_WINDOW_RESERVATION_FUTURE_SKEW_MS) continue;
      if (now - at > PLAN_WINDOW_RESERVATION_TTL_MS) continue;
      entries[id] = { pp, at: String(entry.at) };
    }
    if (Object.keys(entries).length === 0) continue;
    out[key] = { createdAt: slot.createdAt, updatedAt: slot.updatedAt, entries };
  }
  return out;
}

/**
 * Keep the newest entries within the entry/slot caps. Pure.
 *
 * @param {Record<string, { entries: Record<string, { pp: number, at: string }> }>} store
 * @returns {void}
 */
function enforceCaps(store) {
  const flat = [];
  for (const [key, slot] of Object.entries(store)) {
    for (const [id, entry] of Object.entries(slot.entries)) {
      flat.push({ key, id, at: Date.parse(entry.at) || 0 });
    }
  }
  flat.sort((a, b) => b.at - a.at);
  const slots = new Set();
  let kept = 0;
  for (const item of flat) {
    const withinSlots = slots.has(item.key) || slots.size < PLAN_WINDOW_RESERVATION_MAX_SLOTS;
    if (kept < PLAN_WINDOW_RESERVATION_MAX_ENTRIES && withinSlots) {
      slots.add(item.key);
      kept += 1;
    } else {
      delete store[item.key].entries[item.id];
    }
  }
  for (const key of Object.keys(store)) {
    if (Object.keys(store[key].entries).length === 0) delete store[key];
  }
}

/**
 * Parsed file content, or `{}` for a missing, corrupt or oversized file.
 * Cached by inode + nanosecond mtime + size for a short TTL so a picker call
 * stays cheap while a same-size rewrite (including an atomic rename that keeps
 * `mtimeMs`) is still seen.
 *
 * @param {string} file
 * @param {number} now
 * @param {{ useCache?: boolean }} [options]
 * @returns {object}
 */
function readRaw(file, now, options = {}) {
  let stat;
  try {
    stat = fs.statSync(file, { bigint: true });
  } catch {
    readCache.delete(file);
    return {};
  }
  const size = Number(stat.size);
  if (!stat.isFile() || size > PLAN_WINDOW_RESERVATION_MAX_FILE_BYTES) return {};
  const cached = readCache.get(file);
  if (
    options.useCache !== false
    && cached
    && cached.mtimeNs === stat.mtimeNs
    && cached.ino === stat.ino
    && cached.size === size
    && now - cached.loadedAt >= 0
    && now - cached.loadedAt < READ_CACHE_TTL_MS
  ) {
    return cached.raw;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const raw = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    if (readCache.size >= READ_CACHE_MAX_FILES && !readCache.has(file)) {
      readCache.delete(readCache.keys().next().value);
    }
    readCache.set(file, { mtimeNs: stat.mtimeNs, ino: stat.ino, size, loadedAt: now, raw });
    return raw;
  } catch {
    readCache.delete(file);
    return {};
  }
}

/**
 * @param {string} lockPath
 * @returns {string} token stored in the lock file, '' when unreadable
 */
function readLockToken(lockPath) {
  try {
    return fs.readFileSync(lockPath, 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * Remove a stale lock without letting two processes both "win" the steal: the
 * lock is renamed away (atomic, only one caller succeeds) and the token of what
 * was actually taken is verified against the one that was judged stale. A
 * fresh lock grabbed by mistake is linked back.
 *
 * @param {string} lockPath
 * @returns {boolean} true when the stale lock was removed by this caller
 */
function stealStaleLock(lockPath) {
  const seenToken = readLockToken(lockPath);
  const grave = `${lockPath}.${process.pid}.${crypto.randomUUID()}.stale`;
  try {
    fs.renameSync(lockPath, grave);
  } catch {
    return false;
  }
  const takenToken = readLockToken(grave);
  if (takenToken !== seenToken) {
    // A live holder replaced the stale lock between the check and the rename.
    try { fs.linkSync(grave, lockPath); } catch { /* someone else already re-locked */ }
  }
  try { fs.unlinkSync(grave); } catch { /* ignore */ }
  return takenToken === seenToken;
}

/**
 * Run `fn` holding the store lockfile. Never waits: when another holder has the
 * lock (and it is not stale) the call returns `{ locked: false }` immediately
 * so the caller skips the write instead of blocking the event loop. The lock
 * file carries a unique token; release only removes a lock that still carries
 * ours.
 *
 * @template T
 * @param {string} file
 * @param {() => T} fn
 * @returns {{ locked: boolean, value?: T }}
 */
function withFileLock(file, fn) {
  const lockPath = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = `${process.pid}:${crypto.randomUUID()}`;
  let fd = null;
  for (let attempt = 0; fd === null && attempt < 2; attempt += 1) {
    try {
      fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, token);
    } catch (err) {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
        try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
        return { locked: false };
      }
      if (err?.code !== 'EEXIST') return { locked: false };
      let age = 0;
      try {
        age = Date.now() - fs.statSync(lockPath).mtimeMs;
      } catch {
        continue;
      }
      if (age <= LOCK_STALE_MS || !stealStaleLock(lockPath)) return { locked: false };
    }
  }
  if (fd === null) return { locked: false };
  try {
    return { locked: true, value: fn() };
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    if (readLockToken(lockPath) === token) {
      try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
    }
  }
}

/**
 * @param {string} role plan | review | implement | fix
 * @returns {number} estimated pp, 0 for an unknown role
 */
export function estimatePlanWindowPp(role) {
  return PLAN_WINDOW_ESTIMATE_PP[String(role || '').trim().toLowerCase()] || 0;
}

/**
 * Remove slots of a window whose `resetsAt` no longer matches the measured
 * row, and entries already covered by a newer measurement.
 *
 * @param {Record<string, { entries: Record<string, { pp: number, at: string }> }>} store
 * @param {object[]} planLimits
 * @returns {void}
 */
function dropSupersededReservations(store, planLimits) {
  for (const row of planLimits) {
    const rowReset = Date.parse(String(row?.resetsAt || ''));
    const harness = String(row?.harness || '').toLowerCase();
    const type = String(row?.rateLimitType || '');
    if (!harness || !type) continue;
    const reading = Date.parse(String(row?.utilizationObservedAt || row?.observedAt || ''));
    for (const key of Object.keys(store)) {
      const parsed = parseKey(key);
      if (parsed.harness !== harness || parsed.rateLimitType !== type) continue;
      if (Number.isFinite(rowReset) && Date.parse(parsed.resetsAt) !== rowReset) {
        delete store[key];
        continue;
      }
      if (!Number.isFinite(reading)) continue;
      for (const [id, entry] of Object.entries(store[key].entries)) {
        if (reading >= Date.parse(entry.at)) delete store[key].entries[id];
      }
      if (Object.keys(store[key].entries).length === 0) delete store[key];
    }
  }
}

/**
 * Record the estimated consumption of one really started delegation.
 * Idempotent per `idempotencyKey`: a repeated request never counts twice,
 * a retry (new attempt id) does. Never throws.
 *
 * @param {{
 *   harness: string,
 *   model: string,
 *   role: string,
 *   idempotencyKey: string,
 *   planLimits: object[],
 *   now?: number,
 *   dataDir?: string,
 * }} input `planLimits` are the CURRENT measured rows (no overlay)
 * @returns {{ recorded: number, keys: string[], skipped?: string }}
 */
export function recordPlanWindowReservation(input) {
  const pp = estimatePlanWindowPp(input.role);
  const idempotencyKey = String(input.idempotencyKey || '').trim();
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  if (pp <= 0 || !idempotencyKey) return { recorded: 0, keys: [] };
  const planLimits = Array.isArray(input.planLimits) ? input.planLimits : [];
  const file = resolveFile(input.dataDir);
  try {
    const result = withFileLock(file, () => {
      const store = normalizeStore(readRaw(file, now, { useCache: false }), now);
      const before = JSON.stringify(store);
      dropSupersededReservations(store, planLimits);
      const keys = [];
      let recorded = 0;
      for (const entry of selectPlanWindows(planLimits, input.harness, input.model)) {
        const { row, type } = entry;
        if (!CHARGED_TYPES.has(type) || row?.stale === true || row?.scopeMismatch === true) continue;
        const resetsAt = Date.parse(String(row?.resetsAt || ''));
        if (!Number.isFinite(resetsAt) || resetsAt <= now) continue;
        const key = reservationKey(input.harness, String(row.rateLimitType), String(row.resetsAt));
        const slot = store[key] || { createdAt: new Date(now).toISOString(), entries: {} };
        keys.push(key);
        store[key] = slot;
        if (Object.prototype.hasOwnProperty.call(slot.entries, idempotencyKey)) continue;
        slot.entries[idempotencyKey] = { pp, at: new Date(now).toISOString() };
        slot.updatedAt = new Date(now).toISOString();
        recorded += 1;
      }
      enforceCaps(store);
      if (JSON.stringify(store) !== before) {
        writeJsonAtomic(file, store);
        readCache.delete(file);
      }
      return { recorded, keys };
    });
    if (!result.locked) return { recorded: 0, keys: [], skipped: 'lock-timeout' };
    return result.value;
  } catch {
    return { recorded: 0, keys: [], skipped: 'io-error' };
  }
}

/**
 * Overlay live reservations on measured plan-limit rows (read-only, sync).
 * A reservation older than the row's reading, with a different `resetsAt`, past
 * the TTL or dated in the future is ignored (the next write cleans the disk).
 * Corrected rows carry `utilizationEstimated: true` and `estimatedPp`; the
 * measured value is kept in `measuredUtilization`.
 *
 * @param {object[]} rows
 * @param {{ now?: number, dataDir?: string }} [options]
 * @returns {object[]}
 */
export function applyPlanWindowReservations(rows, options = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return list;
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  let store;
  try {
    store = normalizeStore(readRaw(resolveFile(options.dataDir), now), now);
  } catch {
    return list;
  }
  if (Object.keys(store).length === 0) return list;
  return list.map((row) => {
    const slot = store[reservationKey(row?.harness, row?.rateLimitType, row?.resetsAt)];
    if (!slot) return row;
    const base = row?.utilization == null || row.utilization === '' ? NaN : Number(row.utilization);
    if (!Number.isFinite(base)) return row;
    const reading = Date.parse(String(row?.utilizationObservedAt || row?.observedAt || ''));
    let extra = 0;
    for (const entry of Object.values(slot.entries)) {
      // A measurement taken after the reservation already includes that usage.
      if (Number.isFinite(reading) && reading >= Date.parse(entry.at)) continue;
      extra += entry.pp;
    }
    if (extra <= 0) return row;
    return {
      ...row,
      utilization: Math.min(100, base + extra),
      measuredUtilization: base,
      utilizationEstimated: true,
      estimatedPp: extra,
    };
  });
}

/** Test helper: forget cached reads. */
export function clearPlanWindowReservationCache() {
  readCache.clear();
}

/**
 * Remember a reservation whose synchronous write was skipped (the store lock
 * was held) so the next delegation start can retry it. Idempotent per
 * `idempotencyKey` (a repeated payload replaces the previous one); the queue is
 * bounded (the oldest entries drop); never throws.
 *
 * @param {{ idempotencyKey?: string }} input same shape as `recordPlanWindowReservation`
 * @returns {boolean} true when the payload was queued
 */
export function queuePlanWindowReservation(input) {
  try {
    const key = String(input?.idempotencyKey || '').trim();
    if (!key) return false;
    // Re-insert so a repeated key also refreshes its position in the bounded queue.
    reservationQueue.delete(key);
    reservationQueue.set(key, { ...input, idempotencyKey: key });
    while (reservationQueue.size > PLAN_WINDOW_RESERVATION_QUEUE_MAX) {
      reservationQueue.delete(reservationQueue.keys().next().value);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Try to persist every queued reservation. An entry that was written, or that
 * can never be written again, leaves the queue; a still-locked store keeps its
 * entry for the next flush. A failure on one entry never stops the rest.
 *
 * @param {{ dataDir?: string, now?: number }} [options] override stored values
 * @returns {{ flushed: number, remaining: number }}
 */
export function flushPlanWindowReservations(options = {}) {
  const override = {};
  if (options && options.dataDir !== undefined) override.dataDir = options.dataDir;
  if (options && Number.isFinite(Number(options.now))) override.now = Number(options.now);
  let flushed = 0;
  for (const [key, payload] of [...reservationQueue]) {
    let result;
    try {
      result = recordPlanWindowReservation({ ...payload, ...override });
    } catch {
      // Unexpected throw: keep the entry and try again on the next flush.
      continue;
    }
    if (result?.skipped === 'lock-timeout' || result?.skipped === 'io-error') continue;
    reservationQueue.delete(key);
    flushed += 1;
  }
  return { flushed, remaining: reservationQueue.size };
}

/** Test helper: drop every queued reservation. */
export function clearPlanWindowReservationQueue() {
  reservationQueue.clear();
}
