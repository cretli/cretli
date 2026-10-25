/**
 * Atomic JSON write: write to a temporary file, then rename.
 * Prevents data loss on concurrent writes and on a crash mid-write.
 *
 * Every write is also counted in an in-memory aggregate (see `getWriteStats`)
 * so a live server can show which files cost the most synchronous main-thread
 * time. The counters never touch disk and never change what is written.
 */

import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { resolveDataPath } from '../runtime-paths.js';

const MAX_STAT_KEYS = 200;
const OTHER_KEY = '(other)';
const HASH_SEGMENT_RE = /^(?:[0-9a-f]{8,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=\.|$)/i;

/** @type {Map<string, {writes:number, bytes:number, stringifyMs:number, ioMs:number, maxMs:number, identicalWrites:number, skippedWrites:number, coalesced:number}>} */
const stats = new Map();
let statsSince = Date.now();
let statsEnabled = true;

/**
 * Test hook: disable counting (used by the overhead micro-benchmark).
 * @param {unknown} enabled
 */
export function setWriteStatsEnabled(enabled) {
  statsEnabled = Boolean(enabled);
}

/** @param {unknown} filePath */
function normalizeStatKey(filePath) {
  try {
    const abs = path.resolve(String(filePath));
    const dataDir = resolveDataPath();
    const rel = path.relative(dataDir, abs);
    const inside = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
    // Outside the data directory only the base name is kept: never leak an
    // absolute path or a home directory into diagnostics.
    const segments = inside ? rel.split(path.sep) : [path.basename(abs)];
    return segments
      .map((segment) => segment.replace(HASH_SEGMENT_RE, '*'))
      .join('/');
  } catch {
    return OTHER_KEY;
  }
}

/**
 * @param {{ filePath: string, bytes?: number, stringifyMs?: number, ioMs?: number, identical?: boolean, skipped?: boolean, coalesced?: number }} sample
 */
export function recordWriteStat({ filePath, bytes = 0, stringifyMs = 0, ioMs = 0, identical = false, skipped = false, coalesced = 0 }) {
  if (!statsEnabled) return;
  let key = normalizeStatKey(filePath);
  if (!stats.has(key) && stats.size >= MAX_STAT_KEYS) key = OTHER_KEY;
  let row = stats.get(key);
  if (!row) {
    row = { writes: 0, bytes: 0, stringifyMs: 0, ioMs: 0, maxMs: 0, identicalWrites: 0, skippedWrites: 0, coalesced: 0 };
    stats.set(key, row);
  }
  if (identical) row.identicalWrites += 1;
  row.coalesced += Math.max(0, Math.floor(Number(coalesced) || 0));
  if (coalesced > 0 && skipped) return;
  if (skipped) {
    // Nothing reached the disk: do not inflate writes/bytes/maxMs.
    row.skippedWrites += 1;
    row.stringifyMs += stringifyMs;
    return;
  }
  row.writes += 1;
  row.bytes += bytes;
  row.stringifyMs += stringifyMs;
  row.ioMs += ioMs;
  row.maxMs = Math.max(row.maxMs, stringifyMs + ioMs);
}

/** @returns {{ since: number, rows: Array<{key:string, writes:number, bytes:number, stringifyMs:number, ioMs:number, maxMs:number, identicalWrites:number, skippedWrites:number,coalesced:number}> }} */
export function getWriteStats() {
  const rows = [];
  for (const [key, row] of stats) rows.push({ key, ...row });
  return { since: statsSince, rows };
}

export function resetWriteStats() {
  stats.clear();
  statsSince = Date.now();
}

/** @param {bigint} startNs */
function elapsedMs(startNs) {
  return Number(process.hrtime.bigint() - startNs) / 1e6;
}

/**
 * Last written state per path, for `identicalWrites` accounting and the opt-in
 * `skipIfUnchanged`. Only a digest + length + file signature is kept, never the
 * text, so a 30 MB store costs a few dozen bytes of memory.
 * @type {Map<string, { length: number, size: number, mtimeMs: number, bareDigest: string }>}
 */
const lastWritten = new Map();
const MAX_LAST_WRITTEN = 400;

/** @param {string} text */
function digestOf(text) {
  return crypto.createHash('sha1').update(text).digest('hex');
}

/**
 * Serialization of `data` without the given top-level envelope keys. Used only
 * to detect "nothing but the envelope changed"; it is never written to disk.
 *
 * @param {unknown} data
 * @param {string[]} ignoreKeys
 * @param {number | undefined} indent
 */
function serializeWithoutKeys(data, ignoreKeys, indent) {
  if (!ignoreKeys.length || !data || typeof data !== 'object' || Array.isArray(data)) {
    return JSON.stringify(data, null, indent);
  }
  const copy = /** @type {Record<string, unknown>} */ ({ ...data });
  for (const key of ignoreKeys) delete copy[key];
  return JSON.stringify(copy, null, indent);
}

/**
 * @param {string} filePath
 * @returns {{ size: number, mtimeMs: number } | null}
 */
function statSignature(filePath) {
  try {
    const st = fs.statSync(filePath);
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

/** Test hook: forget the remembered last-written state. */
export function resetWriteMemory() {
  lastWritten.clear();
}

const DEFAULT_COALESCED_DELAY_MS = 5000;
const MAX_COALESCED_DELAY_MS = 10000;
const MIN_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 5000;

/**
 * Pending writes are keyed by resolved path. The latest value is intentionally
 * kept by reference and serialized only at flush time.
 * @type {Map<string, {filePath:string, data:unknown, encoding:BufferEncoding, options:Record<string, any>, timer:NodeJS.Timeout|null, retryDelayMs:number}>}
 */
const coalescedWrites = new Map();

/** @param {Record<string, any>} options @param {string} key */
function notifyCoalescedFlush(options, key) {
  try {
    options.onFlushed?.(key);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[cretli] coalesced write flush hook failed for ${path.basename(key)}: ${message}`);
  }
}

/** @param {string} key @param {number} delayMs */
function armCoalescedTimer(key, delayMs) {
  const pending = coalescedWrites.get(key);
  if (!pending || pending.timer) return;
  pending.timer = setTimeout(() => {
    pending.timer = null;
    const result = flushCoalescedWrite(key);
    if (!result.written && result.failed) {
      console.error(`[cretli] coalesced write failed for ${path.basename(pending.filePath)}; retry scheduled`);
    }
  }, delayMs);
  if (typeof pending.timer.unref === 'function') pending.timer.unref();
}

/**
 * Schedule one atomic JSON write no later than `maxDelayMs` after the first
 * pending call. Subsequent calls replace the pending reference without moving
 * the deadline. Set CRETLI_COALESCED_WRITES=0 to write immediately.
 *
 * @param {string} filePath
 * @param {unknown} data
 * @param {BufferEncoding} [encoding='utf8']
 * @param {{ maxDelayMs?:number, compact?:boolean, skipIfUnchanged?:boolean, ignoreKeys?:string[], onFlushed?:(filePath:string)=>void }} [options]
 * @returns {{ pending:boolean, immediate:boolean }}
 */
export function writeJsonCoalesced(filePath, data, encoding = 'utf8', options = {}) {
  const key = path.resolve(filePath);
  if (process.env.CRETLI_COALESCED_WRITES === '0') {
    writeJsonAtomic(filePath, data, encoding, options);
    notifyCoalescedFlush(options, key);
    return { pending: false, immediate: true };
  }
  const existing = coalescedWrites.get(key);
  if (existing) {
    existing.data = data;
    existing.encoding = encoding;
    existing.options = options;
    recordWriteStat({ filePath: key, coalesced: 1, skipped: true });
    return { pending: true, immediate: false };
  }
  const requestedDelay = Number(options.maxDelayMs);
  const maxDelayMs = Number.isFinite(requestedDelay)
    ? Math.max(0, Math.min(MAX_COALESCED_DELAY_MS, requestedDelay))
    : DEFAULT_COALESCED_DELAY_MS;
  coalescedWrites.set(key, {
    filePath: key,
    data,
    encoding,
    options,
    timer: null,
    retryDelayMs: MIN_RETRY_DELAY_MS,
  });
  armCoalescedTimer(key, maxDelayMs);
  return { pending: true, immediate: false };
}

/**
 * Flush one pending write synchronously. Failures keep the latest value and
 * re-arm a bounded retry timer.
 * @param {string} filePath
 * @returns {{ written:number, failed:number }}
 */
export function flushCoalescedWrite(filePath) {
  const key = path.resolve(filePath);
  const pending = coalescedWrites.get(key);
  if (!pending) return { written: 0, failed: 0 };
  if (pending.timer) clearTimeout(pending.timer);
  pending.timer = null;
  try {
    writeJsonAtomic(pending.filePath, pending.data, pending.encoding, pending.options);
    coalescedWrites.delete(key);
    notifyCoalescedFlush(pending.options, key);
    return { written: 1, failed: 0 };
  } catch {
    armCoalescedTimer(key, pending.retryDelayMs);
    pending.retryDelayMs = Math.min(MAX_RETRY_DELAY_MS, Math.max(MIN_RETRY_DELAY_MS, pending.retryDelayMs * 2));
    return { written: 0, failed: 1 };
  }
}

/** Flush every pending coalesced write synchronously. */
export function flushCoalescedWrites() {
  const result = { written: 0, failed: 0 };
  for (const key of [...coalescedWrites.keys()]) {
    const one = flushCoalescedWrite(key);
    result.written += one.written;
    result.failed += one.failed;
  }
  return result;
}

/** @param {string} filePath */
export function hasPendingCoalescedWrite(filePath) {
  return coalescedWrites.has(path.resolve(filePath));
}

/**
 * Atomic JSON write. Default behaviour (2-space indent, always writes) is
 * unchanged; everything in `options` is opt-in.
 *
 * - `compact`: no indentation. Only for stores read exclusively through
 *   `JSON.parse`; indented files written earlier still parse.
 * - `skipIfUnchanged`: skip the write and rename when the serialization (minus
 *   the top-level `ignoreKeys`) equals the one last written to this path by
 *   this process AND the file on disk still has the size and mtime we left
 *   behind (so an external edit or deletion forces a rewrite). A skipped write
 *   means envelope fields such as `updatedAt` do not advance on disk: opt-in
 *   callers must not treat them as "last write attempt" time. Do not enable it
 *   for documents guarded by a CAS on those fields, or for stores with several
 *   writer processes that rely on every write landing.
 *
 * @param {string} filePath - destination path
 * @param {unknown} data - value to serialize
 * @param {BufferEncoding} [encoding='utf8']
 * @param {{ compact?: boolean, skipIfUnchanged?: boolean, ignoreKeys?: string[] }} [options]
 * @returns {{ skipped: boolean }}
 */
export function writeJsonAtomic(filePath, data, encoding = 'utf8', options = {}) {
  let bytes = 0;
  let stringifyMs = 0;
  let ioMs = 0;
  let identical = false;
  let skipped = false;
  try {
    const indent = options.compact === true ? undefined : 2;
    const ignoreKeys = Array.isArray(options.ignoreKeys) ? options.ignoreKeys : [];
    const dir = path.dirname(filePath);
    const ioStart = process.hrtime.bigint();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    ioMs += elapsedMs(ioStart);
    const sStart = process.hrtime.bigint();
    const text = JSON.stringify(data, null, indent);
    const trackMemory = statsEnabled || options.skipIfUnchanged === true;
    const bareText = ignoreKeys.length && trackMemory ? serializeWithoutKeys(data, ignoreKeys, indent) : text;
    const bareDigest = trackMemory ? digestOf(bareText) : '';
    stringifyMs = elapsedMs(sStart);
    const previous = lastWritten.get(filePath);
    identical = Boolean(previous && previous.bareDigest === bareDigest && previous.length === bareText.length);
    if (options.skipIfUnchanged === true && identical && previous) {
      const sig = statSignature(filePath);
      if (sig && sig.size === previous.size && sig.mtimeMs === previous.mtimeMs) {
        skipped = true;
        return { skipped };
      }
    }
    const wStart = process.hrtime.bigint();
    fs.writeFileSync(tmp, text, encoding);
    fs.renameSync(tmp, filePath);
    ioMs += elapsedMs(wStart);
    bytes = text.length;
    if (trackMemory) {
      const sig = statSignature(filePath);
      if (sig) {
        if (!lastWritten.has(filePath) && lastWritten.size >= MAX_LAST_WRITTEN) lastWritten.clear();
        lastWritten.set(filePath, {
          length: bareText.length,
          size: sig.size,
          mtimeMs: sig.mtimeMs,
          bareDigest,
        });
      } else {
        lastWritten.delete(filePath);
      }
    }
    return { skipped };
  } finally {
    recordWriteStat({ filePath, bytes, stringifyMs, ioMs, identical, skipped });
  }
}

/**
 * Atomic text write (patch artifacts, logs): write to a temporary file, then
 * rename so a crash mid-write cannot leave a truncated artifact.
 *
 * @param {string} filePath - destination path
 * @param {string} text
 * @param {BufferEncoding} [encoding='utf8']
 */
export function writeTextAtomic(filePath, text, encoding = 'utf8') {
  let bytes = 0;
  let ioMs = 0;
  try {
    const ioStart = process.hrtime.bigint();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    const body = String(text ?? '');
    fs.writeFileSync(tmp, body, encoding);
    fs.renameSync(tmp, filePath);
    bytes = body.length;
    ioMs = elapsedMs(ioStart);
  } finally {
    recordWriteStat({ filePath, bytes, stringifyMs: 0, ioMs });
  }
}
