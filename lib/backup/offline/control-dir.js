/**
 * Control directory of the offline backup/restore tooling.
 *
 * It lives OUTSIDE every restore-managed path (never archived, never replaced) and holds the
 * exclusive lease, the restore pause flag, the dataset generation/fence and the restore journal.
 * Default location: `<dataDir>/.cretli-control`; override it (e.g. when the data root is a mount
 * point that must not hold control state) with `CRETLI_CONTROL_DIR` or an explicit option.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFileDurable } from '../durable-write.js';
import { OfflineDataError } from './offline-errors.js';

export const CONTROL_DIR_NAME = '.cretli-control';
const STATE_FILE = 'state.json';
const LEASE_FILE = 'lease.json';
const JOURNAL_FILE = 'restore-journal.json';

/**
 * Real path of a possibly missing location: the deepest existing ancestor is resolved through
 * symlinks and the missing tail is appended as spelled.
 *
 * @param {string} target absolute path
 * @returns {string}
 */
function realpathLoose(target) {
  const tail = [];
  let cur = target;
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...tail.reverse());
    } catch (err) {
      const parent = path.dirname(cur);
      if (/** @type {any} */ (err)?.code !== 'ENOENT' || parent === cur) throw err;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * @param {string} parent
 * @param {string} child
 * @returns {boolean} true when `child` equals or lies inside `parent`
 */
function isWithin(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Returns the REAL path of the control directory. The control directory must live outside every
 * restore path, so a location (or a symlink) that resolves into the data directory - other than the
 * default `<dataDir>/.cretli-control` - or that contains the data directory is rejected.
 *
 * @param {string} dataDir
 * @param {string} [override]
 * @returns {string}
 * @throws {OfflineDataError} CONTROL_DIR_INVALID
 */
export function resolveControlDir(dataDir, override) {
  const configured = String(override || process.env.CRETLI_CONTROL_DIR || '').trim();
  const realData = realpathLoose(path.resolve(dataDir));
  const real = realpathLoose(path.resolve(configured || path.join(dataDir, CONTROL_DIR_NAME)));
  const defaultDir = path.join(realData, CONTROL_DIR_NAME);
  const insideData = isWithin(realData, real) && !isWithin(defaultDir, real);
  if (insideData || isWithin(real, realData)) {
    throw new OfflineDataError('CONTROL_DIR_INVALID', 'control directory resolves into (or over) a restore path; it must live outside the data directory', { controlDir: real, dataDir: realData });
  }
  return real;
}

/**
 * @param {string} controlDir
 * @returns {{ state: string, lease: string, journal: string, preRestore: string }}
 */
export function controlPaths(controlDir) {
  return {
    state: path.join(controlDir, STATE_FILE),
    lease: path.join(controlDir, LEASE_FILE),
    journal: path.join(controlDir, JOURNAL_FILE),
    preRestore: path.join(controlDir, 'pre-restore'),
  };
}

/**
 * @param {string} file
 * @returns {any | null} null when the file is absent; throws on corrupt JSON
 */
export function readJsonStrict(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (/** @type {any} */ (err)?.code === 'ENOENT') return null;
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new OfflineDataError('CONTROL_CORRUPT', `corrupt control file ${file}: ${/** @type {Error} */ (err).message}`, { file });
  }
}

/**
 * @param {string} file
 * @param {unknown} value
 */
export function writeJsonDurable(file, value) {
  writeFileDurable(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * @typedef {{
 *   schema: 1,
 *   datasetGeneration: string | null,
 *   fence: number,
 *   highWater: number,
 *   paused: boolean,
 *   pauseReason: string,
 *   updatedAt: string,
 * }} ControlState
 */

/**
 * @param {string} controlDir
 * @returns {ControlState}
 */
export function readControlState(controlDir) {
  const raw = readJsonStrict(controlPaths(controlDir).state);
  if (!raw) {
    return { schema: 1, datasetGeneration: null, fence: 0, highWater: 0, paused: false, pauseReason: '', updatedAt: '' };
  }
  if (raw.schema !== 1) {
    throw new OfflineDataError('CONTROL_UNSUPPORTED', `unsupported control state schema ${raw.schema}`);
  }
  return {
    schema: 1,
    datasetGeneration: typeof raw.datasetGeneration === 'string' ? raw.datasetGeneration : null,
    fence: Number(raw.fence) || 0,
    highWater: Math.max(Number(raw.highWater) || 0, Number(raw.fence) || 0),
    paused: raw.paused === true,
    pauseReason: String(raw.pauseReason || ''),
    updatedAt: String(raw.updatedAt || ''),
  };
}

/**
 * @param {string} controlDir
 * @param {Partial<ControlState>} patch
 * @returns {ControlState}
 */
export function writeControlState(controlDir, patch) {
  /** @type {ControlState} */
  const next = /** @type {any} */ ({ ...readControlState(controlDir), ...patch, schema: 1, updatedAt: new Date().toISOString() });
  next.highWater = Math.max(next.highWater, next.fence);
  fs.mkdirSync(controlDir, { recursive: true, mode: 0o700 });
  writeJsonDurable(controlPaths(controlDir).state, next);
  return next;
}

/**
 * True while a restore left the dataset paused. Servers must not start watcher/Scout, recovery,
 * mailbox/outbox, title/archive work, schedulers, push delivery or MCP auto-start while it holds.
 *
 * @param {string} controlDir
 * @returns {boolean}
 */
export function isRestorePaused(controlDir) {
  return readControlState(controlDir).paused;
}

/**
 * Fresh generation whose fence is strictly above every known high-water mark.
 *
 * @param {string} controlDir
 * @param {number[]} [extraHighWater] source-archive fence, external high-water, ...
 * @returns {{ datasetGeneration: string, fence: number }}
 */
export function allocateGeneration(controlDir, extraHighWater = []) {
  const state = readControlState(controlDir);
  const base = Math.max(state.fence, state.highWater, ...extraHighWater.map((n) => Number(n) || 0));
  return { datasetGeneration: crypto.randomUUID(), fence: base + 1 };
}

/**
 * @param {number} pid
 * @returns {boolean}
 */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return /** @type {any} */ (err)?.code === 'EPERM';
  }
}

/**
 * Exclusive instance/store ownership for one offline operation.
 * A lease held by a live process, by another host, or an unreadable lease is refused.
 *
 * @param {string} controlDir
 * @param {string} purpose
 * @returns {{ token: string, release: () => void }}
 */
export function acquireLease(controlDir, purpose) {
  fs.mkdirSync(controlDir, { recursive: true, mode: 0o700 });
  const file = controlPaths(controlDir).lease;
  const token = crypto.randomUUID();
  const body = JSON.stringify({ token, pid: process.pid, host: os.hostname(), purpose, acquiredAt: new Date().toISOString() });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(file, body, { flag: 'wx', mode: 0o600 });
      return {
        token,
        release() {
          try {
            const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (cur.token === token) fs.unlinkSync(file);
          } catch { /* already gone */ }
        },
      };
    } catch (err) {
      if (/** @type {any} */ (err)?.code !== 'EEXIST') throw err;
    }
    let cur = null;
    try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* unreadable */ }
    if (!cur || cur.host !== os.hostname() || isPidAlive(Number(cur.pid))) {
      throw new OfflineDataError('LEASE_HELD', 'another process (or an unknown owner) holds the exclusive instance lease', { lease: cur });
    }
    // Same host, owner pid is dead: the lease is stale and may be taken over.
    try { fs.unlinkSync(file); } catch { /* raced */ }
  }
  throw new OfflineDataError('LEASE_HELD', 'could not acquire the exclusive instance lease');
}

/**
 * Server-side generation gate for history HTTP/WS/replay writes after a restore allocated a fresh
 * dataset generation. Missing or stale generations are rejected; before any restore (no generation
 * assigned) legacy callers without a generation are accepted.
 *
 * @param {string} controlDir
 * @param {unknown} presented generation sent by the client
 * @returns {{ ok: true } | { ok: false, code: 'generation_missing' | 'generation_stale', current: string }}
 */
export function checkDatasetGeneration(controlDir, presented) {
  const { datasetGeneration } = readControlState(controlDir);
  if (!datasetGeneration) return { ok: true };
  const value = typeof presented === 'string' ? presented.trim() : '';
  if (!value) return { ok: false, code: 'generation_missing', current: datasetGeneration };
  if (value !== datasetGeneration) return { ok: false, code: 'generation_stale', current: datasetGeneration };
  return { ok: true };
}
