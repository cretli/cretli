/**
 * Exclusive lock for long-lived `webpack --config …` CLI watch processes.
 * Lock files live under `data/` (never under webpack `output.path`). HMR in the
 * server imports the webpack config without touching this module.
 *
 * Orphan cleanup uses PIDs stored in the lock record (wrapper, child, process
 * group) and `/proc` parent/child links — not broad cmdline substring scans.
 * Each signal compares the live Linux start time to the value stored in the
 * record; a mismatch drops the lock without signalling (PID reuse / earlyoom).
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  getProcessStartTime,
  isProcessAlive,
} from './delegation-owner-lock.js';
import { resolveDataPath, resolveProjectPath } from './runtime-paths.js';

/** @typedef {'webpack-watch.dev' | 'webpack-watch.widget'} WebpackCliWatchLockId */

/** @typedef {{
 *   lockId: WebpackCliWatchLockId,
 *   pid: number,
 *   pidStart: string,
 *   startedAtMs: number,
 *   projectRootRealpath: string,
 *   configRealpath: string,
 *   childPid?: number,
 *   childPidStart?: string,
 *   childPgid?: number,
 * }} WebpackCliWatchLockRecord */

const LOCK_FILE_BY_ID = Object.freeze({
  'webpack-watch.dev': 'webpack-cli-watch.dev.lock',
  'webpack-watch.widget': 'webpack-cli-watch.widget.lock',
});

/**
 * @param {WebpackCliWatchLockId} lockId
 * @param {{ dataDir?: string }} [options]
 * @returns {string}
 */
export function getWebpackCliWatchLockPath(lockId, options = {}) {
  const fileName = LOCK_FILE_BY_ID[lockId];
  if (!fileName) {
    throw new Error(`Unknown webpack CLI watch lock id: ${lockId}`);
  }
  const configured = String(options.dataDir || '').trim();
  const base = configured || resolveDataPath();
  return path.join(base, fileName);
}

/**
 * @param {string} configPath absolute or relative to app_front
 * @param {string} [appFrontDir]
 * @returns {string}
 */
export function resolveWebpackConfigRealpath(configPath, appFrontDir = resolveProjectPath('app_front')) {
  const resolved = path.isAbsolute(configPath)
    ? configPath
    : path.resolve(appFrontDir, configPath);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * @returns {string}
 */
export function resolveCretliProjectRootRealpath() {
  try {
    return fs.realpathSync(resolveProjectPath());
  } catch {
    return resolveProjectPath();
  }
}

/**
 * @param {unknown} value
 * @returns {WebpackCliWatchLockRecord | null}
 */
export function parseWebpackCliWatchLockRecord(value) {
  if (!value || typeof value !== 'object') return null;
  const record = /** @type {Record<string, unknown>} */ (value);
  const lockId = String(record.lockId || '').trim();
  if (lockId !== 'webpack-watch.dev' && lockId !== 'webpack-watch.widget') return null;
  const pid = Number(record.pid);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const childPid = Number(record.childPid);
  const childPgid = Number(record.childPgid);
  /** @type {WebpackCliWatchLockRecord} */
  const parsed = {
    lockId: /** @type {WebpackCliWatchLockId} */ (lockId),
    pid,
    pidStart: String(record.pidStart || '').trim(),
    startedAtMs: Number(record.startedAtMs) || 0,
    projectRootRealpath: String(record.projectRootRealpath || '').trim(),
    configRealpath: String(record.configRealpath || '').trim(),
  };
  if (Number.isInteger(childPid) && childPid > 0) {
    parsed.childPid = childPid;
    parsed.childPidStart = String(record.childPidStart || '').trim();
  }
  if (Number.isInteger(childPgid) && childPgid > 0) {
    parsed.childPgid = childPgid;
  }
  return parsed;
}

/**
 * @param {string} lockPath
 * @returns {WebpackCliWatchLockRecord | null}
 */
export function readWebpackCliWatchLock(lockPath) {
  if (!fs.existsSync(lockPath)) return null;
  try {
    return parseWebpackCliWatchLockRecord(JSON.parse(fs.readFileSync(lockPath, 'utf8')));
  } catch {
    return null;
  }
}

/**
 * Live lock when the wrapper pid exists and Linux starttime still matches.
 * On non-Linux, `getProcessStartTime` is empty so PID reuse is not detected
 * (an alive pid with stored pidStart is treated as held).
 *
 * @param {WebpackCliWatchLockRecord | null | undefined} record
 * @param {{ now?: () => number, isAlive?: (pid: number) => boolean, getStartTime?: (pid: number) => string }} [probes]
 * @returns {boolean}
 */
export function isWebpackCliWatchLockStale(record, probes = {}) {
  if (!record) return true;
  const isAlive = probes.isAlive || isProcessAlive;
  const getStartTime = probes.getStartTime || getProcessStartTime;
  if (!isAlive(record.pid)) return true;
  const storedStart = String(record.pidStart || '').trim();
  if (!storedStart) return false;
  const liveStart = getStartTime(record.pid);
  if (!liveStart) return false;
  return storedStart !== liveStart;
}

/**
 * @param {WebpackCliWatchLockRecord | null | undefined} record
 * @param {{ isAlive?: (pid: number) => boolean, getStartTime?: (pid: number) => string }} [probes]
 * @returns {boolean}
 */
export function isWebpackCliWatchLockHeld(record, probes = {}) {
  if (!record) return false;
  return !isWebpackCliWatchLockStale(record, probes);
}

/**
 * @param {string} lockPath
 * @returns {void}
 */
export function removeWebpackCliWatchLockFile(lockPath) {
  try {
    fs.unlinkSync(lockPath);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err)?.code !== 'ENOENT') throw err;
  }
}

/**
 * @param {string} lockPath
 * @param {WebpackCliWatchLockRecord} owner
 * @param {Partial<Pick<WebpackCliWatchLockRecord, 'childPid' | 'childPidStart' | 'childPgid'>>} patch
 * @returns {WebpackCliWatchLockRecord | null}
 */
export function updateWebpackCliWatchLockRecord(lockPath, owner, patch) {
  const current = readWebpackCliWatchLock(lockPath);
  if (!current || current.pid !== owner.pid) return null;
  const storedStart = String(current.pidStart || '').trim();
  const ownerStart = String(owner.pidStart || '').trim();
  if (storedStart && ownerStart && storedStart !== ownerStart) return null;
  /** @type {WebpackCliWatchLockRecord} */
  const merged = { ...current, ...patch };
  fs.writeFileSync(lockPath, `${JSON.stringify(merged)}\n`, 'utf8');
  return merged;
}

/**
 * @param {number} pid
 * @returns {string}
 */
export function readProcessCmdline(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return '';
  try {
    return fs
      .readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      .split('\u0000')
      .filter(Boolean)
      .join(' ')
      .trim();
  } catch {
    return '';
  }
}

/**
 * @param {number} pid
 * @returns {string}
 */
export function readProcessCwd(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return '';
  try {
    return fs.readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return '';
  }
}

/**
 * @param {number} pid
 * @returns {number}
 */
export function readProcessPpid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return 0;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    if (close < 0) return 0;
    const fields = stat.slice(close + 2).split(' ');
    const ppid = Number.parseInt(fields[1] || '', 10);
    return Number.isInteger(ppid) && ppid > 0 ? ppid : 0;
  } catch {
    return 0;
  }
}

/**
 * @returns {number[]}
 */
export function listProcPids() {
  if (process.platform === 'win32') return [];
  try {
    return fs
      .readdirSync('/proc')
      .map((name) => Number.parseInt(name, 10))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

/**
 * Direct children of `parentPid` (Linux /proc).
 *
 * @param {number} parentPid
 * @param {{ listPids?: () => number[], readPpid?: (pid: number) => number }} [options]
 * @returns {number[]}
 */
export function listChildPids(parentPid, options = {}) {
  const listPids = options.listPids || listProcPids;
  const readPpid = options.readPpid || readProcessPpid;
  if (!Number.isInteger(parentPid) || parentPid <= 0) return [];
  return listPids().filter((pid) => readPpid(pid) === parentPid);
}

/**
 * @param {number} rootPid
 * @param {{ listPids?: () => number[], readPpid?: (pid: number) => number }} [options]
 * @returns {number[]}
 */
export function listDescendantPids(rootPid, options = {}) {
  const listPids = options.listPids || listProcPids;
  const readPpid = options.readPpid || readProcessPpid;
  if (!Number.isInteger(rootPid) || rootPid <= 0) return [];
  /** @type {number[]} */
  const descendants = [];
  /** @type {number[]} */
  const queue = [rootPid];
  const seen = new Set([rootPid]);
  while (queue.length > 0) {
    const parent = queue.shift();
    if (parent === undefined) break;
    for (const pid of listPids()) {
      if (readPpid(pid) !== parent) continue;
      if (seen.has(pid)) continue;
      seen.add(pid);
      descendants.push(pid);
      queue.push(pid);
    }
  }
  return descendants;
}

/**
 * Exact wrapper match for diagnostics/tests only — not used for broad orphan sweeps.
 *
 * @param {number} pid
 * @param {string} configRealpath
 * @param {string} projectRootRealpath
 * @returns {boolean}
 */
export function isMatchingWebpackCliWatchProcess(pid, configRealpath, projectRootRealpath) {
  if (pid === process.pid) return false;
  const cmdline = readProcessCmdline(pid);
  if (!cmdline.includes('webpack-cli-watch.mjs')) return false;
  if (!cmdline.includes('--config')) return false;
  const configNeedle = configRealpath;
  if (!cmdline.includes(configNeedle) && !cmdline.includes(path.basename(configRealpath))) {
    return false;
  }
  let cwdReal = readProcessCwd(pid);
  try {
    cwdReal = fs.realpathSync(cwdReal);
  } catch {
    // keep best-effort cwd
  }
  const appFrontDir = path.join(projectRootRealpath, 'app_front');
  return cwdReal === appFrontDir || cwdReal.startsWith(`${appFrontDir}${path.sep}`);
}

/**
 * @param {number} pid
 * @param {string | undefined} storedStart
 * @param {{ isAlive?: (pid: number) => boolean, getStartTime?: (pid: number) => string }} [probes]
 * @returns {'alive' | 'dead' | 'reused'}
 */
export function classifyWebpackCliWatchPid(pid, storedStart, probes = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return 'dead';
  const isAlive = probes.isAlive || isProcessAlive;
  const getStartTime = probes.getStartTime || getProcessStartTime;
  if (!isAlive(pid)) return 'dead';
  const stored = String(storedStart || '').trim();
  if (!stored) return 'alive';
  const live = getStartTime(pid);
  if (!live) return 'alive';
  return live === stored ? 'alive' : 'reused';
}

/**
 * Terminate the lock's watch wrapper and its webpack child, one verified PID at
 * a time. Start times are classified independently for the wrapper and the
 * child, so a match on one PID never vouches for the other.
 *
 * Signalling policy (PID reuse safety):
 * - wrapper `reused` or child `reused` → no signal at all; the caller only drops
 *   the stale lock record.
 * - `-pgid` is sent only while the wrapper is verified `alive`: then the process
 *   group belongs to this lock's wrapper. The stored PGID is never trusted when
 *   the wrapper is `reused` or `dead`, because it could name an unrelated group.
 * - wrapper `dead` + child verified `alive` → signal the child PID directly,
 *   never `-pgid`.
 *
 * Every signal is best-effort: a throwing `killProcess` is swallowed and never
 * aborts the remaining cleanup or the caller's lock release, so a surviving
 * process cannot keep the lock held forever.
 *
 * @param {WebpackCliWatchLockRecord} record
 * @param {(pid: number, signal: NodeJS.Signals) => void} killProcess
 * @param {{ isAlive?: (pid: number) => boolean, getStartTime?: (pid: number) => string }} [probes]
 * @returns {{ killed: number[], pidReuseDetected: boolean }}
 */
export function killWebpackCliWatchProcessTree(record, killProcess, probes = {}) {
  if (process.platform === 'win32') {
    return { killed: [], pidReuseDetected: false };
  }
  const wrapperClass = classifyWebpackCliWatchPid(record.pid, record.pidStart, probes);
  if (wrapperClass === 'reused') {
    return { killed: [], pidReuseDetected: true };
  }
  const childPid = Number(record.childPid) || 0;
  const childClass = childPid > 0
    ? classifyWebpackCliWatchPid(childPid, record.childPidStart, probes)
    : 'dead';
  if (childClass === 'reused') {
    return { killed: [], pidReuseDetected: true };
  }
  /** @type {number[]} */
  const killed = [];
  const signalVerifiedPid = (pid) => {
    if (!Number.isInteger(pid) || pid <= 0) return;
    try {
      killProcess(pid, 'SIGTERM');
      killed.push(pid);
    } catch {
      // already gone
    }
  };
  // The process group is only owned by this lock while the wrapper is verified
  // alive. With a dead/reused wrapper the stored PGID is unverified, so a group
  // signal could hit an unrelated process group — signal the child PID instead.
  const pgid = Number(record.childPgid) || childPid || 0;
  if (pgid > 0 && wrapperClass === 'alive') {
    try {
      killProcess(-pgid, 'SIGTERM');
      killed.push(-pgid);
    } catch {
      // group gone
    }
  }
  if (wrapperClass === 'alive') {
    signalVerifiedPid(record.pid);
    for (const descendant of listDescendantPids(record.pid)) {
      signalVerifiedPid(descendant);
    }
  }
  if (childClass === 'alive' && childPid > 0 && childPid !== record.pid) {
    signalVerifiedPid(childPid);
  }
  return { killed, pidReuseDetected: false };
}

/**
 * @param {{
 *   lockId: WebpackCliWatchLockId,
 *   configRealpath: string,
 *   projectRootRealpath: string,
 *   dataDir?: string,
 *   excludePid?: number,
 *   killProcess?: (pid: number, signal: NodeJS.Signals) => void,
 * }} input
 * @returns {{ killed: number[], skipped: number[] }}
 */
export function sweepOrphanWebpackCliWatchers(input) {
  if (process.platform === 'win32') {
    return { killed: [], skipped: [] };
  }
  const killProcess =
    input.killProcess
    || ((pid, signal) => {
      try {
        process.kill(pid, signal);
      } catch {
        // already gone
      }
    });
  const lockPath = getWebpackCliWatchLockPath(input.lockId, { dataDir: input.dataDir });
  const lockRecord = readWebpackCliWatchLock(lockPath);
  /** @type {number[]} */
  const killed = [];
  /** @type {number[]} */
  const skipped = [];
  if (!lockRecord) {
    return { killed, skipped };
  }
  const configMatches = lockRecord.configRealpath === input.configRealpath;
  const projectMatches = lockRecord.projectRootRealpath === input.projectRootRealpath;
  const held = isWebpackCliWatchLockHeld(lockRecord);
  const holderIsSelf = input.excludePid && lockRecord.pid === input.excludePid;
  if (held && configMatches && projectMatches && !holderIsSelf) {
    skipped.push(lockRecord.pid);
    if (lockRecord.childPid) skipped.push(lockRecord.childPid);
    return { killed, skipped };
  }
  const treeResult = killWebpackCliWatchProcessTree(lockRecord, killProcess);
  killed.push(...treeResult.killed);
  if (treeResult.pidReuseDetected || !held || !configMatches || !projectMatches) {
    removeWebpackCliWatchLockFile(lockPath);
  }
  return { killed, skipped };
}

/**
 * @param {{
 *   lockId: WebpackCliWatchLockId,
 *   configRealpath: string,
 *   projectRootRealpath?: string,
 *   dataDir?: string,
 *   pid?: number,
 *   pidStart?: string,
 *   startedAtMs?: number,
 * }} input
 * @returns {{ acquired: true, lockPath: string, record: WebpackCliWatchLockRecord } | { acquired: false, lockPath: string, holder: WebpackCliWatchLockRecord | null, message: string }}
 */
export function tryAcquireWebpackCliWatchLock(input) {
  const lockPath = getWebpackCliWatchLockPath(input.lockId, { dataDir: input.dataDir });
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const pid = Number.isInteger(input.pid) ? input.pid : process.pid;
  const pidStart = String(input.pidStart || getProcessStartTime(pid)).trim();
  const projectRootRealpath = input.projectRootRealpath || resolveCretliProjectRootRealpath();
  /** @type {WebpackCliWatchLockRecord} */
  const record = {
    lockId: input.lockId,
    pid,
    pidStart,
    startedAtMs: Number.isFinite(input.startedAtMs) ? input.startedAtMs : Date.now(),
    projectRootRealpath,
    configRealpath: input.configRealpath,
  };
  const payload = `${JSON.stringify(record)}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeFileSync(fd, payload, 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      return { acquired: true, lockPath, record };
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err)?.code;
      if (code !== 'EEXIST') {
        throw err;
      }
    }
    const existing = readWebpackCliWatchLock(lockPath);
    if (!existing || isWebpackCliWatchLockStale(existing)) {
      if (existing) {
        const treeResult = killWebpackCliWatchProcessTree(existing, (targetPid, signal) => {
          try {
            process.kill(targetPid, signal);
          } catch {
            // gone
          }
        });
        if (treeResult.pidReuseDetected) {
          removeWebpackCliWatchLockFile(lockPath);
          continue;
        }
      }
      removeWebpackCliWatchLockFile(lockPath);
      continue;
    }
    break;
  }
  const existing = readWebpackCliWatchLock(lockPath);
  const holderPid = existing?.pid || 0;
  const message =
    `Another Cretli frontend webpack watch is already running (pid ${holderPid}). `
    + 'Stop the existing watcher or use npm run build:front for a one-time build.';
  return { acquired: false, lockPath, holder: existing, message };
}

/**
 * @param {string} lockPath
 * @param {WebpackCliWatchLockRecord} owner
 * @returns {boolean}
 */
export function releaseWebpackCliWatchLock(lockPath, owner) {
  const current = readWebpackCliWatchLock(lockPath);
  if (!current) return false;
  if (current.pid !== owner.pid) return false;
  const storedStart = String(current.pidStart || '').trim();
  const ownerStart = String(owner.pidStart || '').trim();
  if (storedStart && ownerStart && storedStart !== ownerStart) return false;
  removeWebpackCliWatchLockFile(lockPath);
  return true;
}

/**
 * @param {string} configRealpath
 * @returns {WebpackCliWatchLockId}
 */
export function lockIdForWebpackConfig(configRealpath) {
  const base = path.basename(configRealpath);
  if (base === 'webpack.widget.dev.js') return 'webpack-watch.widget';
  return 'webpack-watch.dev';
}
