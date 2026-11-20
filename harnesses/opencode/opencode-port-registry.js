/**
 * Ownership registry for OpenCode `serve` processes.
 *
 * `data/opencode-ports.json` maps a TCP port to the process that owns the
 * OpenCode instance listening on it. Keys stay ports because the Browser
 * bridge reads them as ports (`server.js` `readInternalBrowserPorts`); values
 * carry the instance key, the OpenCode PID/start time and the owning Cretli
 * server PID/start time/token, so a later startup can tell its own orphan from
 * another live server's instance.
 *
 * Legacy files store `port -> instanceKey`; `normalizeOpenCodePortOwner`
 * upgrades them on read so a rolling upgrade keeps working.
 *
 * All reads/writes go through an exclusive lock directory so two Cretli
 * servers (dev + e2e/worktree) cannot overwrite each other's entries.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeJsonAtomic } from '../../lib/persist/atomic-write.js';
import { resolveDataPath } from '../../lib/runtime-paths.js';
import {
  createProcessProbes,
  getProcessStartTime,
  isRegistryOwnerAlive,
  killProcessTree,
} from '../../lib/process-probes.js';

// The generic /proc helpers are core (child-process registry); these names stay
// exported here for the OpenCode callers and tests.
export { getProcessStartTime, isRegistryOwnerAlive, killProcessTree };

/**
 * Real /proc probes; the listening-port lookup only scans `opencode` processes.
 *
 * @param {Partial<import('../../lib/process-probes.js').ProcessProbes>} [overrides]
 */
export const createOpenCodeProcessProbes = (overrides = {}) => createProcessProbes(overrides, { cmdlineNeedle: 'opencode' });

const REGISTRY_FILE = 'opencode-ports.json';
/** A lock directory older than this is considered abandoned by a crashed writer. */
const REGISTRY_LOCK_STALE_MS = 10000;
/** How long a writer waits for a live holder before giving up. */
const REGISTRY_LOCK_WAIT_MS = 3000;
const REGISTRY_LOCK_POLL_MS = 25;

/** Identity of this Cretli server as recorded in registry entries. */
export const OPENCODE_REGISTRY_SERVER_TOKEN = randomUUID();

/**
 * @typedef {{
 *   instanceKey: string,
 *   opencodePid: number,
 *   opencodeStartedAt: string,
 *   serverPid: number,
 *   serverStartedAt: string,
 *   serverInstanceToken: string,
 *   updatedAt: string,
 * }} OpenCodePortOwner
 */

/** @typedef {import('../../lib/process-probes.js').ProcessProbes} OpenCodeProcessProbes */

/**
 * @typedef {{
 *   kept: number[],
 *   removed: number[],
 *   killed: number[],
 *   skipped: number[],
 * }} OpenCodeReconcileResult
 */

/**
 * @returns {string}
 */
export function getOpenCodePortRegistryPath() {
  return resolveDataPath(REGISTRY_FILE);
}

/** @type {Int32Array} */
const lockSleepCell = new Int32Array(new SharedArrayBuffer(4));

/**
 * Blocking sleep without a timer handle. Only used for the short registry lock
 * spin; the caller is a synchronous read-modify-write on a tiny JSON file.
 *
 * @param {number} ms
 */
function sleepSync(ms) {
  Atomics.wait(lockSleepCell, 0, 0, Math.max(0, ms));
}

/**
 * @param {string} lockPath
 * @returns {boolean} true when the stale lock directory was reclaimed
 */
function reclaimStaleRegistryLock(lockPath) {
  try {
    const stat = fs.statSync(lockPath);
    if (Date.now() - stat.mtimeMs <= REGISTRY_LOCK_STALE_MS) return false;
  } catch {
    // The lock vanished; the next mkdir attempt will succeed.
    return true;
  }
  try {
    fs.rmdirSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run `task` while holding the registry lock. The lock is an exclusive
 * directory; a crashed holder is reclaimed after `REGISTRY_LOCK_STALE_MS`.
 *
 * @param {() => T} task
 * @returns {T}
 * @template T
 */
function withOpenCodePortRegistryLock(task) {
  const lockPath = `${getOpenCodePortRegistryPath()}.lock`;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + REGISTRY_LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lockPath);
      break;
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err)?.code !== 'EEXIST') throw err;
      if (reclaimStaleRegistryLock(lockPath)) continue;
      if (Date.now() >= deadline) {
        throw new Error('Timed out waiting for the OpenCode port registry lock');
      }
      sleepSync(REGISTRY_LOCK_POLL_MS);
    }
  }
  try {
    return task();
  } finally {
    try {
      fs.rmdirSync(lockPath);
    } catch {
      // Already released by a stale-lock reclaim; nothing to do.
    }
  }
}

/**
 * Read the raw JSON object without normalizing values. Returns an empty object
 * for a missing or corrupt file so a broken registry never blocks a spawn.
 *
 * @param {string} [filePath] explicit registry path; defaults to the server's
 *   data directory. The memory monitor passes a fixture path so it can run
 *   against a copied registry instead of the live one.
 * @returns {Record<string, unknown>}
 */
export function readOpenCodePortRegistryRaw(filePath = getOpenCodePortRegistryPath()) {
  const resolvedPath = String(filePath || '').trim() || getOpenCodePortRegistryPath();
  if (!fs.existsSync(resolvedPath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return /** @type {Record<string, unknown>} */ (parsed);
  } catch {
    return {};
  }
}

/**
 * Normalize one registry value. Accepts the legacy `instanceKey` string and the
 * object format. Returns null for values that carry no instance key.
 *
 * @param {unknown} raw
 * @returns {OpenCodePortOwner | null}
 */
export function normalizeOpenCodePortOwner(raw) {
  if (typeof raw === 'string') {
    const instanceKey = raw.trim();
    if (!instanceKey) return null;
    return emptyOwner({ instanceKey });
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = /** @type {Record<string, unknown>} */ (raw);
  const instanceKey = String(record.instanceKey || '').trim();
  if (!instanceKey) return null;
  return {
    instanceKey,
    opencodePid: toPositiveInt(record.opencodePid),
    opencodeStartedAt: String(record.opencodeStartedAt || '').trim(),
    serverPid: toPositiveInt(record.serverPid),
    serverStartedAt: String(record.serverStartedAt || '').trim(),
    serverInstanceToken: String(record.serverInstanceToken || '').trim(),
    updatedAt: String(record.updatedAt || '').trim(),
  };
}

/**
 * @param {number} value
 * @returns {number}
 */
function toPositiveInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * @param {{ instanceKey: string }} input
 * @returns {OpenCodePortOwner}
 */
function emptyOwner(input) {
  return {
    instanceKey: input.instanceKey,
    opencodePid: 0,
    opencodeStartedAt: '',
    serverPid: 0,
    serverStartedAt: '',
    serverInstanceToken: '',
    updatedAt: '',
  };
}

/**
 * Normalized registry keyed by port string.
 *
 * @returns {Record<string, OpenCodePortOwner>}
 */
export function readOpenCodePortRegistry() {
  const raw = readOpenCodePortRegistryRaw();
  /** @type {Record<string, OpenCodePortOwner>} */
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const port = Number.parseInt(key, 10);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
    const entry = normalizeOpenCodePortOwner(value);
    if (!entry) continue;
    out[String(port)] = entry;
  }
  return out;
}

/**
 * Legacy `port -> instanceKey` view used by diagnostics.
 *
 * @returns {Record<string, string>}
 */
export function readOpenCodePortOwners() {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [port, entry] of Object.entries(readOpenCodePortRegistry())) {
    out[port] = entry.instanceKey;
  }
  return out;
}

/**
 * @param {string | number} port
 * @returns {string | null}
 */
export function readOpenCodePortOwner(port) {
  const entry = readOpenCodePortRegistry()[String(port)];
  return entry ? entry.instanceKey : null;
}

/**
 * Build the registry value for an instance started by this process.
 *
 * @param {{
 *   instanceKey: string,
 *   opencodePid?: number,
 *   opencodeStartedAt?: string,
 *   serverPid?: number,
 *   serverStartedAt?: string,
 *   serverInstanceToken?: string,
 * }} input
 * @returns {OpenCodePortOwner}
 */
export function createOpenCodePortOwnerEntry(input) {
  return {
    instanceKey: String(input.instanceKey || '').trim(),
    opencodePid: toPositiveInt(input.opencodePid),
    opencodeStartedAt: String(input.opencodeStartedAt || '').trim(),
    serverPid: toPositiveInt(input.serverPid ?? process.pid),
    serverStartedAt: String(input.serverStartedAt ?? getProcessStartTime(process.pid)).trim(),
    serverInstanceToken: String(input.serverInstanceToken || OPENCODE_REGISTRY_SERVER_TOKEN).trim(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Insert/replace one port entry. Read-modify-write happens under the registry
 * lock so entries belonging to another server survive.
 *
 * @param {number} port
 * @param {OpenCodePortOwner} entry
 */
export function writeOpenCodePortOwner(port, entry) {
  const key = String(port);
  withOpenCodePortRegistryLock(() => {
    const raw = readOpenCodePortRegistryRaw();
    raw[key] = normalizeOpenCodePortOwner(entry) || entry;
    writeJsonAtomic(getOpenCodePortRegistryPath(), raw);
  });
}

/**
 * Remove one port entry. When `instanceKey` is given, the entry is removed only
 * when it still belongs to that instance, so a concurrent server that already
 * claimed the port is not clobbered.
 *
 * @param {number} port
 * @param {string | null} [instanceKey]
 * @returns {boolean} true when an entry was removed
 */
export function removeOpenCodePortOwner(port, instanceKey = null) {
  const key = String(port);
  let removed = false;
  withOpenCodePortRegistryLock(() => {
    const raw = readOpenCodePortRegistryRaw();
    if (!(key in raw)) return;
    const entry = normalizeOpenCodePortOwner(raw[key]);
    const expected = String(instanceKey || '').trim();
    if (expected && entry && entry.instanceKey !== expected) return;
    delete raw[key];
    writeJsonAtomic(getOpenCodePortRegistryPath(), raw);
    removed = true;
  });
  return removed;
}

/**
 * True when `cmd` is an OpenCode `serve` process started for exactly `port`.
 * The port is anchored so `--port=414` cannot match `--port=4146`.
 *
 * @param {string} cmd
 * @param {number} port
 * @returns {boolean}
 */
export function isOpenCodeServeCmdline(cmd, port) {
  const text = String(cmd || '');
  if (!text.includes('opencode')) return false;
  if (!/(^|\s)serve(\s|$)/.test(text)) return false;
  return new RegExp(`(^|\\s)--port=${port}(\\s|$)`).test(text);
}

/**
 * True when a cmdline looks like a live Cretli server. `process.title =
 * 'cretli'` (server.js) can zero the rest of `/proc/<pid>/cmdline`, so a bare
 * `cretli` title also counts.
 *
 * @param {string} cmd
 * @returns {boolean}
 */
export function isCretliServerCmdline(cmd) {
  const text = String(cmd || '').trim();
  if (!text) return false;
  if (/(^|[\s/\\])server\.js(\s|$)/.test(text)) {
    return /(^|[\s/\\])node(\.exe)?(\s|$)/i.test(text) || /(^|[\s/\\])cretli(\s|$)/.test(text);
  }
  return /^cretli(\s|$)/.test(text);
}

/**
 * True when any ancestor of `pid` looks like a live Cretli server process.
 * Used only for legacy entries that carry no owner PID.
 *
 * @param {number} pid
 * @param {OpenCodeProcessProbes} probes
 * @returns {boolean}
 */
export function hasLiveCretliServerAncestor(pid, probes) {
  for (const ancestorPid of probes.listAncestorPids(pid)) {
    if (!probes.isProcessAlive(ancestorPid)) continue;
    if (isCretliServerCmdline(probes.readProcessCmdline(ancestorPid))) return true;
  }
  return false;
}

/**
 * SIGTERM the process group, then SIGKILL it when it is still alive. Returns
 * true only after the process is confirmed gone.
 *
 * @param {number} pid
 * @param {OpenCodeProcessProbes} probes
 * @param {number} killWaitMs
 * @param {(ms: number) => Promise<void>} sleep
 * @returns {Promise<boolean>}
 */
export async function terminateOpenCodeProcess(pid, probes, killWaitMs, sleep) {
  if (!probes.isProcessAlive(pid)) return true;
  probes.killProcessTree(pid, 'SIGTERM');
  await sleep(killWaitMs);
  if (!probes.isProcessAlive(pid)) return true;
  probes.killProcessTree(pid, 'SIGKILL');
  await sleep(killWaitMs);
  return !probes.isProcessAlive(pid);
}

/**
 * Reconcile one recorded (new-format) entry whose owner is dead.
 *
 * @param {{
 *   entry: OpenCodePortOwner,
 *   port: number,
 *   probes: OpenCodeProcessProbes,
 *   result: OpenCodeReconcileResult,
 *   removeEntry: (port: number, instanceKey: string | null) => void,
 *   log: (message: string) => void,
 *   killWaitMs: number,
 *   sleep: (ms: number) => Promise<void>,
 * }} input
 * @returns {Promise<void>}
 */
async function reconcileRecordedOwner(input) {
  const { entry, port, probes, result, removeEntry, log, killWaitMs, sleep } = input;
  if (!probes.isProcessAlive(entry.opencodePid)) {
    removeEntry(port, entry.instanceKey);
    result.removed.push(port);
    return;
  }
  const startMatches = !entry.opencodeStartedAt
    || probes.getProcessStartTime(entry.opencodePid) === entry.opencodeStartedAt;
  const cmdline = probes.readProcessCmdline(entry.opencodePid);
  if (!startMatches || !isOpenCodeServeCmdline(cmdline, port)) {
    // The recorded OpenCode is gone and the PID was reused by something else:
    // drop the stale entry without ever signalling the new process.
    removeEntry(port, entry.instanceKey);
    result.removed.push(port);
    return;
  }
  const exited = await terminateOpenCodeProcess(entry.opencodePid, probes, killWaitMs, sleep);
  if (exited) {
    removeEntry(port, entry.instanceKey);
    result.killed.push(port);
    return;
  }
  result.kept.push(port);
  log(`[opencode] could not stop orphan pid ${entry.opencodePid} on port ${port}; keeping its registry entry`);
}

/**
 * Reconcile a legacy entry (string value or object without owner/PID data).
 *
 * @param {{
 *   entry: OpenCodePortOwner,
 *   port: number,
 *   probes: OpenCodeProcessProbes,
 *   result: OpenCodeReconcileResult,
 *   removeEntry: (port: number, instanceKey: string | null) => void,
 *   log: (message: string) => void,
 *   killWaitMs: number,
 *   sleep: (ms: number) => Promise<void>,
 * }} input
 * @returns {Promise<void>}
 */
async function reconcileLegacyOwner(input) {
  const { entry, port, probes, result, removeEntry, log, killWaitMs, sleep } = input;
  const listenerPid = probes.findListeningPid(port);
  if (!listenerPid) {
    removeEntry(port, entry.instanceKey);
    result.removed.push(port);
    return;
  }
  const cmdline = probes.readProcessCmdline(listenerPid);
  if (!isOpenCodeServeCmdline(cmdline, port) || hasLiveCretliServerAncestor(listenerPid, probes)) {
    result.kept.push(port);
    result.skipped.push(port);
    log(`[opencode] legacy registry entry for port ${port} left alone (pid ${listenerPid} belongs to a live Cretli server or a foreign process)`);
    return;
  }
  const exited = await terminateOpenCodeProcess(listenerPid, probes, killWaitMs, sleep);
  if (exited) {
    removeEntry(port, entry.instanceKey);
    result.killed.push(port);
    return;
  }
  result.kept.push(port);
  log(`[opencode] could not stop legacy orphan pid ${listenerPid} on port ${port}; keeping its registry entry`);
}

/**
 * Startup sweep: for every registry entry decide whether its OpenCode process
 * is an orphan of a dead Cretli server (kill it) or belongs to a live owner
 * (leave it untouched). Runs before the first instance of this process exists.
 *
 * @param {{
 *   registry?: Record<string, unknown>,
 *   probes?: OpenCodeProcessProbes,
 *   self?: { pid?: number, startedAt?: string, instanceToken?: string },
 *   removeEntry?: (port: number, instanceKey: string | null) => void,
 *   log?: (message: string) => void,
 *   killWaitMs?: number,
 *   sleep?: (ms: number) => Promise<void>,
 * }} [input]
 * @returns {Promise<OpenCodeReconcileResult>}
 */
export async function reconcileOpenCodePortRegistry(input = {}) {
  const registry = input.registry && typeof input.registry === 'object'
    ? input.registry
    : readOpenCodePortRegistryRaw();
  const probes = input.probes || createOpenCodeProcessProbes();
  const selfPid = Number.isInteger(input.self?.pid) ? Number(input.self.pid) : process.pid;
  const self = {
    pid: selfPid,
    startedAt: input.self?.startedAt ?? probes.getProcessStartTime(selfPid),
    instanceToken: input.self?.instanceToken ?? OPENCODE_REGISTRY_SERVER_TOKEN,
  };
  const killWaitMs = Number.isFinite(input.killWaitMs) ? Number(input.killWaitMs) : 1500;
  const sleep = typeof input.sleep === 'function'
    ? input.sleep
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const log = typeof input.log === 'function' ? input.log : (message) => console.warn(message);
  const removeEntry = typeof input.removeEntry === 'function'
    ? input.removeEntry
    : (port, instanceKey) => {
        removeOpenCodePortOwner(port, instanceKey);
      };
  /** @type {OpenCodeReconcileResult} */
  const result = { kept: [], removed: [], killed: [], skipped: [] };
  for (const [rawPort, rawOwner] of Object.entries(registry)) {
    const port = Number.parseInt(rawPort, 10);
    const entry = normalizeOpenCodePortOwner(rawOwner);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
    if (!entry) {
      removeEntry(port, null);
      result.removed.push(port);
      continue;
    }
    if (isRegistryOwnerAlive(entry, self, probes)) {
      result.kept.push(port);
      continue;
    }
    const shared = { entry, port, probes, result, removeEntry, log, killWaitMs, sleep };
    if (entry.opencodePid > 0) {
      await reconcileRecordedOwner(shared);
    } else {
      await reconcileLegacyOwner(shared);
    }
  }
  return result;
}
