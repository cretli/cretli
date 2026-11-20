/**
 * Generic /proc-based process helpers: start time (PID-reuse guard), liveness,
 * cmdline, listening PID, ancestry, process-group kill, and the ownership check
 * of a registry entry. Shared by the child-process registry and by harness
 * plugins that track the processes they spawn (a harness port registry).
 */

import fs from 'node:fs';

/**
 * @typedef {{
 *   isProcessAlive: (pid: number) => boolean,
 *   getProcessStartTime: (pid: number) => string,
 *   readProcessCmdline: (pid: number) => string,
 *   findListeningPid: (port: number) => number,
 *   listAncestorPids: (pid: number) => number[],
 *   killProcessTree: (pid: number, signal: string) => boolean,
 * }} ProcessProbes
 */

/**
 * Linux starttime (jiffies since boot) of a PID, or '' when unavailable.
 * Matches `/proc/<pid>/stat` field 22; used to detect PID reuse.
 *
 * @param {number} pid
 * @returns {string}
 */
export function getProcessStartTime(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return '';
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    if (close < 0) return '';
    const fields = stat.slice(close + 2).split(' ');
    return String(fields[19] || '').trim();
  } catch {
    return '';
  }
}

/**
 * @param {number} pid
 * @returns {boolean}
 */
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return /** @type {NodeJS.ErrnoException} */ (err)?.code === 'EPERM';
  }
}

/**
 * @param {number} pid
 * @returns {string}
 */
function readProcessCmdline(pid) {
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
 * @returns {number}
 */
function readParentPid(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    if (close < 0) return 0;
    const fields = stat.slice(close + 2).split(' ');
    return Number.parseInt(fields[1], 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * Parent chain (nearest first), excluding the PID itself.
 *
 * @param {number} pid
 * @returns {number[]}
 */
function listAncestorPids(pid) {
  /** @type {number[]} */
  const out = [];
  const seen = new Set([pid]);
  let current = pid;
  for (let depth = 0; depth < 64; depth += 1) {
    const parent = readParentPid(current);
    if (!parent || parent <= 1 || seen.has(parent)) break;
    seen.add(parent);
    out.push(parent);
    current = parent;
  }
  return out;
}

/**
 * Listening socket inodes for a localhost TCP port, from /proc/net/tcp{,6}.
 *
 * @param {number} port
 * @returns {Set<string>}
 */
function listListeningInodesForPort(port) {
  /** @type {Set<string>} */
  const inodes = new Set();
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 10) continue;
      if (cols[3] !== '0A') continue;
      const portHex = cols[1].split(':')[1];
      if (!portHex) continue;
      if (Number.parseInt(portHex, 16) !== port) continue;
      inodes.add(cols[9]);
    }
  }
  return inodes;
}

/**
 * PID of the process listening on `port`, or 0. Only processes whose cmdline
 * contains `cmdlineNeedle` are scanned, which keeps the /proc/fd walk cheap; an
 * empty needle scans every process.
 *
 * @param {number} port
 * @param {string} [cmdlineNeedle]
 * @returns {number}
 */
function findListeningPid(port, cmdlineNeedle = '') {
  const inodes = listListeningInodesForPort(port);
  if (inodes.size === 0) return 0;
  let entries = [];
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number.parseInt(name, 10);
    if (cmdlineNeedle && !readProcessCmdline(pid).includes(cmdlineNeedle)) continue;
    let fds = [];
    try {
      fds = fs.readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      let link = '';
      try {
        link = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
      } catch {
        continue;
      }
      const match = /^socket:\[(\d+)\]$/.exec(link);
      if (match && inodes.has(match[1])) return pid;
    }
  }
  return 0;
}

/**
 * Signal a process group (harness servers are spawned detached, so the PGID equals the
 * PID) and fall back to the single PID when the group is already gone.
 *
 * @param {number} pid
 * @param {string} signal
 * @returns {boolean} true when a signal was delivered
 */
export function killProcessTree(pid, signal) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch (groupErr) {
    if (/** @type {NodeJS.ErrnoException} */ (groupErr)?.code === 'ESRCH') {
      try {
        process.kill(pid, signal);
        return true;
      } catch {
        return false;
      }
    }
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Real /proc-based probes. Tests inject their own.
 *
 * @param {Partial<ProcessProbes>} [overrides]
 * @param {{ cmdlineNeedle?: string }} [options] Narrows `findListeningPid` to processes whose cmdline contains it.
 * @returns {ProcessProbes}
 */
export function createProcessProbes(overrides = {}, options = {}) {
  const cmdlineNeedle = String(options.cmdlineNeedle || '');
  return {
    isProcessAlive,
    getProcessStartTime,
    readProcessCmdline,
    findListeningPid: (/** @type {number} */ port) => findListeningPid(port, cmdlineNeedle),
    listAncestorPids,
    killProcessTree,
    ...overrides,
  };
}

/**
 * True when the recorded Cretli server still owns the entry. PID reuse is
 * detected through the recorded process start time.
 *
 * @param {{ serverPid?: number, serverStartedAt?: string, serverInstanceToken?: string }} entry
 * @param {{ pid: number, startedAt: string, instanceToken: string }} self
 * @param {ProcessProbes} probes
 * @returns {boolean}
 */
export function isRegistryOwnerAlive(entry, self, probes) {
  if (entry.serverInstanceToken && self.instanceToken && entry.serverInstanceToken === self.instanceToken) {
    return true;
  }
  if (!entry.serverPid) return false;
  if (entry.serverPid === self.pid && self.startedAt
    && (!entry.serverStartedAt || entry.serverStartedAt === self.startedAt)) {
    return true;
  }
  if (!probes.isProcessAlive(entry.serverPid)) return false;
  if (!entry.serverStartedAt) return true;
  const liveStart = probes.getProcessStartTime(entry.serverPid);
  if (!liveStart) return true;
  return liveStart === entry.serverStartedAt;
}
