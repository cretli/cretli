/**
 * Single-writer lock for the JSON delegation store.
 * A claim file (O_EXCL) is taken before mkdir so a metadata gap cannot be
 * stolen. Missing owner.json does not mean the owner is dead. Release checks
 * the owner token. PID reuse is detected via /proc starttime; EPERM means live.
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveDataPath } from './runtime-paths.js';

const SOCKET_PROBE_MS = 80;
const ACQUIRE_ATTEMPTS = 4;

export class DelegationOwnerLockError extends Error {
  /**
   * @param {string} message
   * @param {{ ownerPid?: number }} [details]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = 'DelegationOwnerLockError';
    this.code = 'DELEGATION_OWNER_LOCKED';
    this.ownerPid = Number(details.ownerPid) || 0;
  }
}

/**
 * @typedef {{
 *   pid: number,
 *   ownerToken: string,
 *   startedAt: string,
 *   pidStart: string,
 *   lockDir: string,
 *   sockPath: string,
 *   metaPath: string,
 *   claimPath: string,
 *   server: import('node:net').Server | null,
 * }} DelegationOwnerLock
 */

/** @type {Map<string, DelegationOwnerLock>} */
const heldByDir = new Map();

/**
 * @param {{ dataDir?: string }} [options]
 * @returns {string}
 */
export function getDelegationOwnerLockDir(options = {}) {
  const configured = String(options.dataDir || '').trim();
  return configured || resolveDataPath();
}

/**
 * @param {{ dataDir?: string }} [options]
 * @returns {{ lockDir: string, sockPath: string, metaPath: string, claimPath: string }}
 */
export function getDelegationOwnerLockPaths(options = {}) {
  const dir = getDelegationOwnerLockDir(options);
  const lockDir = path.join(dir, 'delegation-owner.lock');
  return {
    lockDir,
    sockPath: path.join(lockDir, 'owner.sock'),
    metaPath: path.join(lockDir, 'owner.json'),
    claimPath: path.join(dir, 'delegation-owner.lock.claim'),
  };
}

/**
 * kill(pid, 0) with no error or EPERM means the process exists.
 * ESRCH means it does not. EPERM must not be treated as dead.
 *
 * @param {NodeJS.ErrnoException | null | undefined} err
 * @returns {boolean}
 */
export function isKillProbeAlive(err) {
  if (!err) return true;
  return err.code === 'EPERM';
}

/**
 * @param {number} pid
 * @returns {boolean}
 */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return isKillProbeAlive(err);
  }
}

/**
 * Linux starttime from /proc/<pid>/stat field 22. Empty when unavailable.
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
 * @param {string} filePath
 * @returns {{ pid: number, ownerToken: string, startedAt: string, pidStart: string } | null}
 */
function readLockMeta(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      pid: Number(parsed.pid) || 0,
      ownerToken: String(parsed.ownerToken || '').trim(),
      startedAt: String(parsed.startedAt || '').trim(),
      pidStart: String(parsed.pidStart || '').trim(),
    };
  } catch {
    return null;
  }
}

/**
 * @param {string} sockPath
 * @returns {boolean}
 */
export function isLockSocketLive(sockPath) {
  if (!sockPath || !fs.existsSync(sockPath)) return false;
  try {
    if (!fs.statSync(sockPath).isSocket()) return false;
  } catch {
    return false;
  }
  const flag = new Int32Array(new SharedArrayBuffer(4));
  const socket = net.createConnection({ path: sockPath });
  socket.unref();
  socket.on('connect', () => {
    Atomics.store(flag, 0, 1);
    Atomics.notify(flag, 0);
    socket.end();
  });
  socket.on('error', () => {
    Atomics.store(flag, 0, 2);
    Atomics.notify(flag, 0);
  });
  Atomics.wait(flag, 0, 0, SOCKET_PROBE_MS);
  socket.removeAllListeners();
  socket.destroy();
  return Atomics.load(flag, 0) === 1;
}

/**
 * Missing metadata does not authorize a steal. Socket liveness wins.
 * A live PID with a different starttime is treated as PID reuse (dead owner).
 *
 * @param {{ pid?: number, pidStart?: string } | null} meta
 * @param {string} sockPath
 * @returns {boolean}
 */
export function isStoredOwnerLive(meta, sockPath) {
  if (isLockSocketLive(sockPath)) return true;
  if (!meta || !meta.pid) return true;
  if (!isProcessAlive(meta.pid)) return false;
  const storedStart = String(meta.pidStart || '').trim();
  if (!storedStart) return true;
  const liveStart = getProcessStartTime(meta.pid);
  if (!liveStart) return true;
  return storedStart === liveStart;
}

/**
 * @param {string} lockDir
 */
function removeStaleLockDir(lockDir) {
  fs.rmSync(lockDir, { recursive: true, force: true });
}

/**
 * @param {string} claimPath
 * @param {string} ownerToken
 */
function discardOwnClaim(claimPath, ownerToken) {
  const claim = readLockMeta(claimPath);
  if (!claim || claim.ownerToken !== ownerToken) return;
  try {
    fs.rmSync(claimPath, { force: true });
  } catch {
    // Claim may already be gone.
  }
}

/**
 * @param {string} claimPath
 * @param {object} payload
 */
function writeClaimExclusive(claimPath, payload) {
  const fd = fs.openSync(claimPath, 'wx');
  try {
    fs.writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * @param {string} sockPath
 */
function listenUnixSocket(sockPath) {
  const server = net.createServer();
  server.on('error', () => {});
  try {
    server.listen(sockPath);
    if (typeof server.unref === 'function') server.unref();
    return server;
  } catch {
    try {
      server.close();
    } catch {
      // Ignore listen failure; claim and PID file still own the directory.
    }
    return null;
  }
}

/**
 * @returns {DelegationOwnerLock | null}
 */
export function getHeldDelegationOwnerLock(options = {}) {
  return heldByDir.get(getDelegationOwnerLockDir(options)) || null;
}

/**
 * @param {{ dataDir?: string }} [options]
 * @returns {DelegationOwnerLock}
 */
export function acquireDelegationOwnerLock(options = {}) {
  const dir = getDelegationOwnerLockDir(options);
  const existingHeld = heldByDir.get(dir);
  if (existingHeld) return existingHeld;
  fs.mkdirSync(dir, { recursive: true });
  const { lockDir, sockPath, metaPath, claimPath } = getDelegationOwnerLockPaths({ dataDir: dir });
  const ownerToken = randomUUID();
  const startedAt = new Date().toISOString();
  const payload = {
    pid: process.pid,
    ownerToken,
    startedAt,
    pidStart: getProcessStartTime(process.pid),
  };
  let stealEmptyLockDir = false;
  for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt += 1) {
    const claim = takeClaimOrRetry({
      claimPath,
      sockPath,
      payload,
    });
    if (!claim.ok) {
      stealEmptyLockDir = stealEmptyLockDir || claim.reclaimedDead;
      continue;
    }
    const lock = finishAcquireAfterClaim({
      dir,
      lockDir,
      sockPath,
      metaPath,
      claimPath,
      payload,
      stealEmptyLockDir,
    });
    if (lock) return lock;
  }
  discardOwnClaim(claimPath, ownerToken);
  throw new DelegationOwnerLockError('Could not acquire the delegation store lock.');
}

/**
 * @param {{
 *   dir: string,
 *   lockDir: string,
 *   sockPath: string,
 *   metaPath: string,
 *   claimPath: string,
 *   payload: { pid: number, ownerToken: string, startedAt: string, pidStart: string },
 *   stealEmptyLockDir: boolean,
 * }} input
 * @returns {DelegationOwnerLock | null}
 */
function finishAcquireAfterClaim(input) {
  const { dir, lockDir, sockPath, metaPath, claimPath, payload, stealEmptyLockDir } = input;
  if (!tryTakeLockDir({ lockDir, sockPath, metaPath, claimPath, payload, stealEmptyLockDir })) {
    return null;
  }
  fs.writeFileSync(metaPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  const server = listenUnixSocket(sockPath);
  discardOwnClaim(claimPath, payload.ownerToken);
  heldByDir.set(dir, {
    ...payload,
    lockDir,
    sockPath,
    metaPath,
    claimPath,
    server,
  });
  return heldByDir.get(dir);
}

/**
 * @param {{ claimPath: string, sockPath: string, payload: { ownerToken: string, pid: number } }} input
 * @returns {{ ok: boolean, reclaimedDead: boolean }}
 */
function takeClaimOrRetry(input) {
  try {
    writeClaimExclusive(input.claimPath, input.payload);
    return { ok: true, reclaimedDead: false };
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
    if (code !== 'EEXIST') throw err;
    const claim = readLockMeta(input.claimPath);
    if (isStoredOwnerLive(claim, input.sockPath)) {
      throw new DelegationOwnerLockError(
        `Delegation store is owned by PID ${claim?.pid || 0}.`,
        { ownerPid: claim?.pid || 0 },
      );
    }
    try {
      fs.rmSync(input.claimPath, { force: true });
    } catch {
      // Next attempt will retry exclusive create.
    }
    return { ok: false, reclaimedDead: true };
  }
}

/**
 * @param {{
 *   lockDir: string,
 *   sockPath: string,
 *   metaPath: string,
 *   claimPath: string,
 *   payload: { ownerToken: string, pid: number },
 *   stealEmptyLockDir?: boolean,
 * }} input
 * @returns {boolean}
 */
function tryTakeLockDir(input) {
  try {
    fs.mkdirSync(input.lockDir);
    return true;
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
    if (code !== 'EEXIST') {
      discardOwnClaim(input.claimPath, input.payload.ownerToken);
      throw err;
    }
    const existing = readLockMeta(input.metaPath);
    const missingMeta = !existing;
    if (missingMeta && !input.stealEmptyLockDir) {
      discardOwnClaim(input.claimPath, input.payload.ownerToken);
      throw new DelegationOwnerLockError(
        'Delegation store lock exists without owner metadata; refusing to steal.',
      );
    }
    if (!missingMeta && isStoredOwnerLive(existing, input.sockPath)) {
      discardOwnClaim(input.claimPath, input.payload.ownerToken);
      throw new DelegationOwnerLockError(
        `Delegation store is owned by PID ${existing?.pid || 0}.`,
        { ownerPid: existing?.pid || 0 },
      );
    }
    removeStaleLockDir(input.lockDir);
    try {
      fs.mkdirSync(input.lockDir);
      return true;
    } catch (retryErr) {
      discardOwnClaim(input.claimPath, input.payload.ownerToken);
      const retryCode = retryErr && typeof retryErr === 'object' && 'code' in retryErr
        ? String(retryErr.code)
        : '';
      if (retryCode === 'EEXIST') {
        throw new DelegationOwnerLockError('Could not acquire the delegation store lock.');
      }
      throw retryErr;
    }
  }
}

/**
 * @param {{ dataDir?: string }} [options]
 * @returns {DelegationOwnerLock}
 */
export function ensureDelegationOwnerLock(options = {}) {
  const dir = getDelegationOwnerLockDir(options);
  const existingHeld = heldByDir.get(dir);
  if (existingHeld) return existingHeld;
  return acquireDelegationOwnerLock(options);
}

/**
 * @param {{ dataDir?: string }} [options]
 * @returns {{ held: boolean, pid: number, ownerToken: string, startedAt: string }}
 */
export function getDelegationOwnerLockInfo(options = {}) {
  const current = heldByDir.get(getDelegationOwnerLockDir(options));
  if (!current) {
    return { held: false, pid: 0, ownerToken: '', startedAt: '' };
  }
  return {
    held: true,
    pid: current.pid,
    ownerToken: current.ownerToken,
    startedAt: current.startedAt,
  };
}

/**
 * Release only the lock this process still owns. A mismatched token means
 * another writer recovered the directory; do not delete it.
 *
 * @param {{ dataDir?: string }} [options]
 */
export function releaseDelegationOwnerLock(options = {}) {
  const dir = getDelegationOwnerLockDir(options);
  const current = heldByDir.get(dir);
  if (!current) return;
  heldByDir.delete(dir);
  try {
    current.server?.close();
  } catch {
    // Ignore close errors during shutdown.
  }
  const onDisk = readLockMeta(current.metaPath);
  if (!onDisk || onDisk.ownerToken !== current.ownerToken) {
    discardOwnClaim(current.claimPath, current.ownerToken);
    return;
  }
  try {
    fs.rmSync(current.lockDir, { recursive: true, force: true });
  } catch {
    // Directory may already be gone.
  }
  discardOwnClaim(current.claimPath, current.ownerToken);
}
