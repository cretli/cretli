/**
 * Ownership registry and shutdown lifecycle for long-lived child processes.
 *
 * The server spawns more than OpenCode: PTY sessions (terminal, task runs,
 * agent runs, the front-build watch), MCP stdio bridges, review-verify test
 * runners and the CLI children of the harness SDKs. On a graceful shutdown
 * (`SIGTERM`/`SIGINT`) the first phase must signal them synchronously; on
 * `SIGKILL`/earlyoom nothing runs, so the next start reclaims the orphans from
 * `data/child-processes.json` — exactly the pattern OpenCode already uses.
 *
 * Ownership is recorded in one place as `{ pid, type, label, startedAt, owner }`.
 * The startup sweep only ever signals PIDs found in this registry and verifies
 * the Linux start time before signalling, so a recycled PID is never killed.
 * The deliberately detached restart helper
 * (`scripts/restart-server-helper.js`) is never registered and is skipped even
 * if a stale entry somehow points at it.
 *
 * `killProcessTree`/`createProcessProbes`/`isRegistryOwnerAlive` are
 * shared with the OpenCode port registry (`process-probes.js`); the child registry adds a
 * recursive descendant kill so a child that is not its own process-group leader
 * cannot leak its grandchildren.
 */

import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import { writeJsonAtomic } from './persist/atomic-write.js';
import { assertExecutorLaunchAllowed } from './executor-launch-gate.js';
import { appendChildExitEvent } from './oom-diagnostics.js';
import { resolveDataPath } from './runtime-paths.js';
import {
  createProcessProbes,
  getProcessStartTime,
  isRegistryOwnerAlive,
  killProcessTree,
} from './process-probes.js';
import { collectProcessTree } from './browser/process-tree.js';

const REGISTRY_FILE = 'child-processes.json';
/** A lock directory older than this is considered abandoned by a crashed writer. */
const REGISTRY_LOCK_STALE_MS = 10000;
/** How long a writer waits for a live holder before giving up. */
const REGISTRY_LOCK_WAIT_MS = 3000;
const REGISTRY_LOCK_POLL_MS = 25;

/** SIGTERM grace of the bounded shutdown phase before the SIGKILL escalation. */
const SHUTDOWN_SIGTERM_GRACE_MS = 800;
/** Time allowed for SIGKILL to be reaped before the phase reports failure. */
const SHUTDOWN_SIGKILL_WAIT_MS = 400;
/** Upper bound of the whole child-process shutdown phase. */
export const CHILD_PROCESS_SHUTDOWN_TOTAL_MS =
  SHUTDOWN_SIGTERM_GRACE_MS + SHUTDOWN_SIGKILL_WAIT_MS;

/** Default interval of the periodic descendant discovery tick. */
export const CHILD_PROCESS_DISCOVERY_INTERVAL_MS = 20000;

/** Upper bound on how long a startup orphan sweep may block boot. */
export const CHILD_PROCESS_SWEEP_TOTAL_BUDGET_MS = 30000;

/** Identity of this Cretli server as recorded in registry entries. */
export const CHILD_PROCESS_REGISTRY_SERVER_TOKEN = randomUUID();

/** Basename of the intentionally detached restart helper. */
const RESTART_HELPER_FILE = 'restart-server-helper.js';

/**
 * @typedef {{
 *   pid: number,
 *   type: string,
 *   label: string,
 *   startedAt: string,
 *   serverPid: number,
 *   serverStartedAt: string,
 *   serverInstanceToken: string,
 *   updatedAt: string,
 * }} ChildProcessEntry
 */

/**
 * @typedef {{
 *   isProcessAlive: (pid: number) => boolean,
 *   getProcessStartTime: (pid: number) => string,
 *   readProcessCmdline: (pid: number) => string,
 *   killProcessTree: (pid: number, signal: string) => boolean,
 * }} ChildProcessProbes
 */

/**
 * @typedef {{
 *   kept: number[],
 *   removed: number[],
 *   killed: number[],
 *   skipped: number[],
 * }} ChildProcessReconcileResult
 */

/** @type {Map<number, ChildProcessEntry>} */
const ownedProcesses = new Map();

/**
 * Phase-1 gate. Once true, the registry has already signalled every known child
 * and a second call must not signal again.
 */
let childProcessShutdownStarted = false;

/**
 * PIDs phase 1 signalled, kept for the bounded phase-2 wait and escalation
 * together with the start time used to detect PID reuse before a second signal.
 *
 * @type {Map<number, { type: string, startedAt: string }>}
 */
const shutdownPendingPids = new Map();

/** @type {Int32Array} */
const lockSleepCell = new Int32Array(new SharedArrayBuffer(4));

/**
 * @returns {string}
 */
export function getChildProcessRegistryPath() {
  return resolveDataPath(REGISTRY_FILE);
}

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
function reclaimStaleLock(lockPath) {
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
function withChildProcessRegistryLock(task) {
  const lockPath = `${getChildProcessRegistryPath()}.lock`;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + REGISTRY_LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lockPath);
      break;
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err)?.code !== 'EEXIST') throw err;
      if (reclaimStaleLock(lockPath)) continue;
      if (Date.now() >= deadline) {
        throw new Error('Timed out waiting for the child process registry lock');
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
 * @returns {Record<string, unknown>}
 */
export function readChildProcessRegistryRaw() {
  const filePath = getChildProcessRegistryPath();
  if (!fs.existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return /** @type {Record<string, unknown>} */ (parsed);
  } catch {
    return {};
  }
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function toPositiveInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Normalize one persisted entry; returns null when it is not an object or
 * carries no usable PID. A corrupt value must never produce a killable entry.
 *
 * @param {unknown} raw
 * @returns {ChildProcessEntry | null}
 */
export function normalizeChildProcessEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = /** @type {Record<string, unknown>} */ (raw);
  const pid = toPositiveInt(record.pid);
  if (!pid) return null;
  return {
    pid,
    type: String(record.type || 'child').trim() || 'child',
    label: String(record.label || '').trim(),
    startedAt: String(record.startedAt || '').trim(),
    serverPid: toPositiveInt(record.serverPid),
    serverStartedAt: String(record.serverStartedAt || '').trim(),
    serverInstanceToken: String(record.serverInstanceToken || '').trim(),
    updatedAt: String(record.updatedAt || '').trim(),
  };
}

/**
 * @param {unknown} value
 * @param {string} key
 * @returns {ChildProcessEntry | null}
 */
function normalizeRegistryValue(value, key) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = /** @type {Record<string, unknown>} */ (value);
  const pid = toPositiveInt(record.pid) || toPositiveInt(key);
  if (!pid) return null;
  return normalizeChildProcessEntry({ ...record, pid });
}

/**
 * Normalized registry keyed by PID.
 *
 * @returns {Record<string, ChildProcessEntry>}
 */
export function readChildProcessRegistry() {
  const raw = readChildProcessRegistryRaw();
  /** @type {Record<string, ChildProcessEntry>} */
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const entry = normalizeRegistryValue(value, key);
    if (!entry) continue;
    out[String(entry.pid)] = entry;
  }
  return out;
}

/**
 * Live in-memory view of the children this process registered.
 *
 * @returns {ChildProcessEntry[]}
 */
export function listRegisteredChildProcesses() {
  return [...ownedProcesses.values()].map((entry) => ({ ...entry }));
}

/**
 * @param {number} pid
 * @returns {boolean}
 */
export function isChildProcessRegistered(pid) {
  return ownedProcesses.has(Number(pid));
}

let cachedServerStartedAt = '';

/**
 * Start time of this server process. It cannot change while the process runs, so
 * the `/proc/<pid>/stat` read happens once; an empty result (non-Linux, read
 * failure) is not cached so a later call can still resolve it.
 *
 * @param {(pid: number) => string} [read] injectable for tests
 * @param {{ fresh?: boolean }} [options] `fresh` ignores and refills the cache
 * @returns {string}
 */
export function resolveServerStartedAt(read = getProcessStartTime, options = {}) {
  if (cachedServerStartedAt && !options.fresh) return cachedServerStartedAt;
  const value = String(read(process.pid) || '');
  cachedServerStartedAt = value;
  return value;
}

/**
 * Build the registry value for a child of this process.
 *
 * @param {{
 *   pid: number,
 *   type?: string,
 *   label?: string,
 *   startedAt?: string,
 * }} input
 * @returns {ChildProcessEntry | null}
 */
export function createChildProcessEntry(input) {
  const pid = toPositiveInt(input?.pid);
  if (!pid || pid === process.pid) return null;
  return {
    pid,
    type: String(input.type || 'child').trim() || 'child',
    label: String(input.label || '').trim().slice(0, 200),
    startedAt: String(input.startedAt || getProcessStartTime(pid) || '').trim(),
    serverPid: process.pid,
    serverStartedAt: resolveServerStartedAt(),
    serverInstanceToken: CHILD_PROCESS_REGISTRY_SERVER_TOKEN,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Persist and remember one child process. Idempotent for the same PID and start
 * time, so the periodic discovery tick does not rewrite the file every time.
 *
 * @param {{
 *   pid: number,
 *   type?: string,
 *   label?: string,
 *   startedAt?: string,
 * }} input
 * @returns {ChildProcessEntry | null}
 */
export function registerChildProcess(input) {
  try {
    const entry = createChildProcessEntry(input);
    if (!entry) return null;
    const existing = ownedProcesses.get(entry.pid);
    if (existing && existing.startedAt === entry.startedAt) return existing;
    withChildProcessRegistryLock(() => {
      const raw = readChildProcessRegistryRaw();
      raw[String(entry.pid)] = entry;
      writeJsonAtomic(getChildProcessRegistryPath(), raw);
    });
    ownedProcesses.set(entry.pid, entry);
    scheduleImmediateServerDescendantDiscovery();
    return entry;
  } catch {
    return null;
  }
}

/**
 * Forget one child process. The persisted entry is removed only when it still
 * belongs to this process, so a concurrent writer is not clobbered.
 *
 * @param {number} pid
 * @returns {boolean} true when an entry was removed
 */
export function unregisterChildProcess(pid) {
  const key = toPositiveInt(pid);
  if (!key) return false;
  ownedProcesses.delete(key);
  shutdownPendingPids.delete(key);
  let removed = false;
  try {
    withChildProcessRegistryLock(() => {
      const raw = readChildProcessRegistryRaw();
      if (!(String(key) in raw)) return;
      delete raw[String(key)];
      writeJsonAtomic(getChildProcessRegistryPath(), raw);
      removed = true;
    });
  } catch {
    // A registry write must never break a child teardown.
    return false;
  }
  return removed;
}

/** PIDs this process deliberately signalled; entries expire if no handle exits. */
const selfSignalledPids = new Map();
const SELF_SIGNALLED_PID_TTL_MS = 60_000;

function pruneSelfSignalledPids(now = Date.now()) {
  for (const [pid, markedAt] of selfSignalledPids) {
    if (now - markedAt > SELF_SIGNALLED_PID_TTL_MS) selfSignalledPids.delete(pid);
  }
}

/**
 * Handles that already have an exit listener, mapped to their release function.
 * The patched `spawn` tracks a child on creation *and* callers such as the tool
 * executor / review verify call `trackChildProcess` explicitly, so the same
 * ChildProcess can be tracked twice. A second `once('exit')` listener would run
 * its own release after the first one already cleared `selfSignalledPids`, and
 * a server-ordered SIGKILL would be recorded as an unexpected death. Keeping one
 * listener (and returning its release from every call) guarantees exactly one
 * exit event per handle.
 *
 * @type {WeakMap<object, () => void>}
 */
let trackedHandles = new WeakMap();

/** Registry entries whose exit was already recorded; a second release is a no-op. */
let recordedExitEntries = new WeakSet();

/**
 * Persist a durable exit event for a child killed by SIGKILL that this server
 * did not ask to stop. The registry entry is about to be removed, so without
 * this a kernel/earlyoom/oomd kill between two monitor samples vanishes.
 * Never throws: accounting must not break teardown.
 *
 * `handle.killed` is the second signal: callers that SIGKILL their own child
 * directly (`child.kill('SIGKILL')`, e.g. a hung probe timeout) do not pass
 * through `killChildProcessTree`, yet that exit was still requested by the
 * server. Only a kill that this process did not send should leave an event.
 *
 * @param {ChildProcessEntry} entry
 * @param {unknown[]} exitArgs `(code, signal)` from ChildProcess or `({ exitCode, signal })` from node-pty
 * @param {{ killed?: boolean } | null | undefined} [handle]
 */
function recordAbnormalChildExit(entry, exitArgs, handle) {
  try {
    pruneSelfSignalledPids();
    if (recordedExitEntries.has(entry)) return;
    recordedExitEntries.add(entry);
    const first = exitArgs[0];
    let code = null;
    let signal = null;
    if (first && typeof first === 'object') {
      code = Number.isInteger(first.exitCode) ? first.exitCode : null;
      signal = first.signal ?? null;
    } else {
      code = Number.isInteger(first) ? first : null;
      signal = exitArgs[1] ?? null;
    }
    // node-pty reports signals as numbers (9 = SIGKILL); a shell reports 137.
    if (signal === 9 || signal === 'SIGKILL' || code === 137) signal = 'SIGKILL';
    else return;
    if (selfSignalledPids.has(entry.pid) || shutdownPendingPids.has(entry.pid)) return;
    if (handle?.killed === true) return;
    appendChildExitEvent(path.dirname(getChildProcessRegistryPath()), {
      pid: entry.pid,
      startedAt: entry.startedAt,
      type: entry.type,
      label: entry.label,
      signal,
      code,
    });
  } catch {
    // best-effort
  } finally {
    selfSignalledPids.delete(entry.pid);
  }
}

/**
 * Register a freshly spawned native child process and return a release
 * function. Works for `child_process.ChildProcess` (`once('exit')`) and for a
 * node-pty handle (`onExit`).
 *
 * Idempotent per handle: calling it for an already tracked child returns the
 * existing release instead of attaching a second listener, so one exit is
 * recorded at most once even when both the patched `spawn` and an explicit
 * caller track the same child (R6A1-F1).
 *
 * @param {{ pid?: number, once?: Function, onExit?: Function } | null | undefined} handle
 * @param {{ type?: string, label?: string }} [meta]
 * @returns {() => void}
 */
export function trackChildProcess(handle, meta = {}) {
  try {
    const pid = toPositiveInt(handle?.pid);
    if (!pid) return () => {};
    const trackable = handle && typeof handle === 'object';
    if (trackable && trackedHandles.has(handle)) return trackedHandles.get(handle);
    const entry = registerChildProcess({ pid, ...meta });
    if (!entry) return () => {};
    let released = false;
    const release = (...exitArgs) => {
      if (released) return;
      released = true;
      recordAbnormalChildExit(entry, exitArgs, handle);
      unregisterChildProcess(pid);
    };
    if (trackable) trackedHandles.set(handle, release);
    if (typeof handle.once === 'function') {
      handle.once('exit', release);
      handle.once('error', release);
    } else if (typeof handle.onExit === 'function') {
      handle.onExit(release);
    }
    return release;
  } catch {
    return () => {};
  }
}

/**
 * True when a cmdline belongs to the intentionally detached restart helper.
 * Such a process must survive the server, so it is never signalled.
 *
 * @param {unknown} cmd
 * @returns {boolean}
 */
export function isRestartHelperCmdline(cmd) {
  const text = String(cmd || '');
  if (!text) return false;
  return new RegExp(`(^|[\\s/\\\\])${RESTART_HELPER_FILE}(\\s|$)`).test(text);
}

/** Harness CLI tokens, including a package path such as `claude-agent-sdk`. */
const HARNESS_CLI_RE = /(^|[\s/\\])(claude|codex|dsh|qwen|codebuddy|cursor-agent|agent)([\s/\\.-]|$)/;

/**
 * Classify a descendant of the server as one of the heavy child categories the
 * registry owns, or '' when it must not be adopted.
 *
 * Chromium (owned by `browserManager`) and `opencode serve` (owned by
 * `opencode-server-manager`) are deliberately excluded to keep one owner per
 * process; the restart helper is excluded so it can outlive the server.
 *
 * @param {unknown} cmdline
 * @returns {string}
 */
export function classifyHeavyChildCmdline(cmdline) {
  const cmd = String(cmdline || '').trim();
  if (!cmd || isRestartHelperCmdline(cmd)) return '';
  if (/(^|[\s/\\])(opencode|chrom|chromium|chrome)([\s/\\.-]|$)/i.test(cmd)) return '';
  if (/cretli-mcp\.js/.test(cmd)) return 'mcp-bridge';
  if (HARNESS_CLI_RE.test(cmd)) return 'harness-cli';
  if (/tests[\\/][^\s]*\.test\.js/.test(cmd)) return 'review-verify';
  if (/\bbash\b\s+-lc\b/i.test(cmd)) return 'tool-shell';
  return '';
}

/**
 * @param {ChildProcessProbes} [probes]
 * @returns {(pid: number) => string}
 */
function cmdlineReader(probes) {
  return probes?.readProcessCmdline || createProcessProbes().readProcessCmdline;
}

/**
 * Heavy descendants of `rootPid`, classified by cmdline. Linux only; returns an
 * empty list elsewhere (no `/proc`).
 *
 * @param {{ rootPid?: number, probes?: ChildProcessProbes }} [input]
 * @returns {Array<{ pid: number, cmdline: string, type: string }>}
 */
export function listServerDescendantProcesses(input = {}) {
  if (process.platform !== 'linux') return [];
  const rootPid = toPositiveInt(input.rootPid) || process.pid;
  const readCmdline = cmdlineReader(input.probes);
  /** @type {Array<{ pid: number, cmdline: string, type: string }>} */
  const out = [];
  for (const pid of collectProcessTree(rootPid)) {
    if (pid === rootPid) continue;
    const cmdline = readCmdline(pid);
    const type = classifyHeavyChildCmdline(cmdline);
    if (!type) continue;
    out.push({ pid, cmdline, type });
  }
  return out;
}

/**
 * Adopt every classified heavy descendant of this server that is not in the
 * registry yet. This is how harness CLI children spawned inside an SDK (whose
 * PID the SDK never exposes) become owned processes.
 *
 * @param {{ rootPid?: number, probes?: ChildProcessProbes }} [input]
 * @returns {ChildProcessEntry[]}
 */
export function registerServerDescendants(input = {}) {
  /** @type {ChildProcessEntry[]} */
  const registered = [];
  let descendants = [];
  try {
    descendants = listServerDescendantProcesses(input);
  } catch {
    return registered;
  }
  for (const { pid, cmdline, type } of descendants) {
    if (ownedProcesses.has(pid)) continue;
    const entry = registerChildProcess({ pid, type, label: cmdline.slice(0, 200) });
    if (entry) registered.push(entry);
  }
  return registered;
}

/**
 * Drop in-memory entries whose PID is gone and persist the pruned file.
 *
 * @returns {number[]} pruned PIDs
 */
export function pruneDeadChildProcesses() {
  /** @type {number[]} */
  const pruned = [];
  for (const pid of [...ownedProcesses.keys()]) {
    if (isProcessAlive(pid)) continue;
    ownedProcesses.delete(pid);
    shutdownPendingPids.delete(pid);
    pruned.push(pid);
  }
  if (pruned.length === 0) return pruned;
  try {
    withChildProcessRegistryLock(() => {
      const raw = readChildProcessRegistryRaw();
      for (const pid of pruned) delete raw[String(pid)];
      writeJsonAtomic(getChildProcessRegistryPath(), raw);
    });
  } catch {
    // Pruning is best-effort; the next sweep reconciles the file.
  }
  return pruned;
}

/**
 * Start the periodic discovery tick that keeps the registry close to the live
 * descendant set, so a later `SIGKILL` leaves reclaimable entries.
 *
 * @param {{ intervalMs?: number, rootPid?: number, probes?: ChildProcessProbes }} [input]
 * @returns {() => void} stop function
 */
/** @type {ReturnType<typeof setTimeout> | null} */
let immediateDiscoveryTimer = null;

/** Debounced one-shot descendant scan after a new child is registered at spawn. */
function scheduleImmediateServerDescendantDiscovery() {
  if (immediateDiscoveryTimer) return;
  immediateDiscoveryTimer = setTimeout(() => {
    immediateDiscoveryTimer = null;
    try {
      registerServerDescendants();
    } catch {
      // Best-effort; the periodic tick retries.
    }
  }, 0);
  if (typeof immediateDiscoveryTimer.unref === 'function') immediateDiscoveryTimer.unref();
}

/** @type {boolean} */
let childProcessSpawnTrackingInstalled = false;

/** @type {typeof childProcess.spawn | null} */
let originalSpawnForTracking = null;

/**
 * @param {unknown} command
 * @param {unknown} args
 * @returns {string}
 */
function spawnCmdlinePreview(command, args) {
  const head = String(command || '').trim();
  const tail = Array.isArray(args) ? args.map((part) => String(part)).join(' ') : '';
  return tail ? `${head} ${tail}` : head;
}

/**
 * Patch `child_process.spawn` so harness CLI and tool-shell children are
 * registered as soon as the SDK (or tool executor) starts them.
 */
// Decision (R17 S8): `spawnSync` / `execFileSync` / `execSync` are deliberately
// NOT patched. They block the event loop until the child exits and are used
// only for short, timeout-bounded probes (`ps`, `journalctl`, `git`, `systemctl`),
// never for the long-lived harness CLI / tool-shell children this registry owns,
// so there is nothing to reclaim after a SIGKILL of the server. The launch gate
// also cannot defer a synchronous call without blocking the whole server.
// Descendant RSS is likewise excluded from the memory accounting: the ledger
// counts the server plus each registered executor's own VmRSS (see
// `measureMemory` in oom-diagnostics.js); grandchildren are an accepted
// under-count, and the host-level `MemAvailable` sample still reflects them.
export function installChildProcessSpawnTracking() {
  if (childProcessSpawnTrackingInstalled) return;
  childProcessSpawnTrackingInstalled = true;
  if (!originalSpawnForTracking) originalSpawnForTracking = childProcess.spawn.bind(childProcess);
  const originalSpawn = originalSpawnForTracking;
  childProcess.spawn = function trackSpawnedChild(command, args, options) {
    let spawnArgs = [];
    let spawnOptions = options;
    if (Array.isArray(args)) {
      spawnArgs = args;
    } else if (args !== undefined) {
      spawnOptions = args;
    }
    const preview = spawnCmdlinePreview(command, spawnArgs);
    const type = classifyHeavyChildCmdline(preview);
    // Pre-flight before the process exists. A refused launch throws here and
    // never reaches `originalSpawn`, so no executor process is created.
    if (type) assertExecutorLaunchAllowed({ type, label: preview.slice(0, 200) });
    const child = originalSpawn(command, spawnArgs, spawnOptions);
    try {
      if (type) {
        trackChildProcess(child, { type, label: preview.slice(0, 200) });
      }
    } catch {
      // Registry accounting must never break a spawn.
    }
    return child;
  };
  // ESM `import { spawn } from 'node:child_process'` (Codex SDK, title runners)
  // binds to the builtin's named export, not to the CJS property patched above.
  // Re-sync the live bindings so those importers reach the gate too.
  syncBuiltinESMExports();
}

export function startChildProcessDiscovery(input = {}) {
  const runDiscovery = () => {
    try {
      pruneDeadChildProcesses();
      registerServerDescendants({ rootPid: input.rootPid, probes: input.probes });
    } catch {
      // A discovery failure must never break the server tick.
    }
  };
  runDiscovery();
  const intervalMs = Number.isFinite(input.intervalMs) && input.intervalMs > 0
    ? Number(input.intervalMs)
    : CHILD_PROCESS_DISCOVERY_INTERVAL_MS;
  const timer = setInterval(runDiscovery, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
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
 * Signal a child's process group, its whole descendant tree and the PID itself.
 * A non-detached child shares the server's process group, so the group kill
 * fails and the recursive tree walk is what stops its grandchildren.
 *
 * @param {number} pid
 * @param {string} signal
 * @returns {boolean}
 */
export function killChildProcessTree(pid, signal) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  pruneSelfSignalledPids();
  selfSignalledPids.set(pid, Date.now());
  let sent = killProcessTree(pid, signal);
  for (const target of collectProcessTree(pid).sort((a, b) => b - a)) {
    if (target === pid) continue;
    try {
      process.kill(target, signal);
      sent = true;
    } catch {
      // already gone
    }
  }
  return sent;
}

/**
 * Real probes. Tests inject their own.
 *
 * @param {Partial<ChildProcessProbes>} [overrides]
 * @returns {ChildProcessProbes}
 */
export function createChildProcessProbes(overrides = {}) {
  return {
    ...createProcessProbes(),
    killProcessTree: killChildProcessTree,
    ...overrides,
  };
}

/**
 * True when a PID can still be signalled for the recorded entry: it is alive
 * and its Linux start time still matches, so a recycled PID is never killed.
 *
 * @param {number} pid
 * @param {string} startedAt
 * @param {ChildProcessProbes} probes
 * @returns {boolean}
 */
function isSignalableTarget(pid, startedAt, probes) {
  if (!probes.isProcessAlive(pid)) return false;
  if (!startedAt) return true;
  const live = probes.getProcessStartTime(pid);
  return !live || live === startedAt;
}

/**
 * First shutdown phase. Synchronous by design: it snapshots every registered
 * child, SIGTERMs each one once and records the PIDs for the bounded phase 2.
 * A second call is a no-op, so a double signal is impossible.
 *
 * @param {{ kill?: (pid: number, signal: string) => boolean }} [options]
 * @returns {{ total: number, signaled: number, alreadyStarted: boolean }}
 */
export function beginChildProcessShutdown(options = {}) {
  if (childProcessShutdownStarted) {
    return { total: shutdownPendingPids.size, signaled: 0, alreadyStarted: true };
  }
  childProcessShutdownStarted = true;
  const kill = typeof options.kill === 'function' ? options.kill : killChildProcessTree;
  const probes = createChildProcessProbes();
  /** @type {Map<number, { type: string, startedAt: string }>} */
  const targets = new Map();
  for (const [pid, entry] of ownedProcesses.entries()) {
    if (!isSignalableTarget(pid, entry.startedAt, probes)) {
      // The child is gone or its PID was recycled; never signal the new owner.
      ownedProcesses.delete(pid);
      continue;
    }
    targets.set(pid, { type: entry.type, startedAt: entry.startedAt });
  }
  for (const [pid, meta] of shutdownPendingPids.entries()) {
    if (!targets.has(pid)) targets.set(pid, meta);
  }
  let signaled = 0;
  for (const [pid, meta] of targets.entries()) {
    shutdownPendingPids.set(pid, meta);
    if (kill(pid, 'SIGTERM')) signaled += 1;
  }
  return { total: targets.size, signaled, alreadyStarted: false };
}

/**
 * Wait until every PID is gone or the budget runs out.
 *
 * @param {Map<number, string>} targets pid -> recorded start time
 * @param {ChildProcessProbes} probes
 * @param {(ms: number) => Promise<void>} sleep
 * @param {number} waitMs
 * @returns {Promise<number[]>} PIDs still signalable
 */
async function waitForChildExit(targets, probes, sleep, waitMs) {
  const deadline = Date.now() + Math.max(0, waitMs);
  for (;;) {
    const alive = [...targets.entries()]
      .filter(([pid, startedAt]) => isSignalableTarget(pid, startedAt, probes))
      .map(([pid]) => pid);
    if (alive.length === 0) return [];
    const remaining = deadline - Date.now();
    if (remaining <= 0) return alive;
    await sleep(Math.min(50, remaining));
  }
}

/**
 * Second shutdown phase: wait a bounded time for the phase-1 SIGTERMs, escalate
 * the survivors to SIGKILL, confirm exit and drop the registry entries of the
 * processes that are really gone. Safe to call without phase 1.
 *
 * @param {{
 *   graceMs?: number,
 *   killWaitMs?: number,
 *   probes?: Partial<ChildProcessProbes>,
 *   sleep?: (ms: number) => Promise<void>,
 * }} [options]
 * @returns {Promise<{
 *   ok: boolean,
 *   timedOut: boolean,
 *   total: number,
 *   escalated: number,
 *   remaining: number[],
 * }>}
 */
export async function finishChildProcessShutdown(options = {}) {
  const probes = createChildProcessProbes(options.probes || {});
  const graceMs = Number.isFinite(options.graceMs) && Number(options.graceMs) >= 0
    ? Number(options.graceMs)
    : SHUTDOWN_SIGTERM_GRACE_MS;
  const killWaitMs = Number.isFinite(options.killWaitMs) && Number(options.killWaitMs) >= 0
    ? Number(options.killWaitMs)
    : SHUTDOWN_SIGKILL_WAIT_MS;
  const sleep = typeof options.sleep === 'function'
    ? options.sleep
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  /** @type {Map<number, string>} */
  const targets = new Map();
  for (const [pid, meta] of shutdownPendingPids.entries()) targets.set(pid, meta.startedAt);
  for (const [pid, entry] of ownedProcesses.entries()) targets.set(pid, entry.startedAt);
  // Re-signal only when phase 1 never ran (direct `finish` call).
  if (!childProcessShutdownStarted) {
    for (const [pid, startedAt] of targets.entries()) {
      if (isSignalableTarget(pid, startedAt, probes)) probes.killProcessTree(pid, 'SIGTERM');
    }
  }
  await waitForChildExit(targets, probes, sleep, graceMs);
  let escalated = 0;
  for (const [pid, startedAt] of targets.entries()) {
    if (!isSignalableTarget(pid, startedAt, probes)) continue;
    probes.killProcessTree(pid, 'SIGKILL');
    escalated += 1;
  }
  const remaining = await waitForChildExit(targets, probes, sleep, killWaitMs);
  for (const [pid, startedAt] of targets.entries()) {
    if (isSignalableTarget(pid, startedAt, probes)) continue;
    ownedProcesses.delete(pid);
    shutdownPendingPids.delete(pid);
  }
  // Remove every confirmed-dead PID from the persisted file in one write.
  const dead = [...targets.entries()]
    .filter(([pid, startedAt]) => !isSignalableTarget(pid, startedAt, probes))
    .map(([pid]) => pid);
  if (dead.length > 0) {
    try {
      withChildProcessRegistryLock(() => {
        const raw = readChildProcessRegistryRaw();
        let changed = false;
        for (const pid of dead) {
          if (String(pid) in raw) {
            delete raw[String(pid)];
            changed = true;
          }
        }
        if (changed) writeJsonAtomic(getChildProcessRegistryPath(), raw);
      });
    } catch {
      // A surviving entry makes the next startup sweep retry.
    }
  }
  return {
    ok: remaining.length === 0,
    timedOut: remaining.length > 0,
    total: targets.size,
    escalated,
    remaining,
  };
}

/**
 * Startup sweep: for every persisted entry decide whether the child is an
 * orphan of a dead Cretli server (kill it) or belongs to a live owner (leave it
 * untouched). PID reuse is detected through the recorded start time. The
 * detached restart helper is never signalled.
 *
 * @param {{
 *   registry?: Record<string, unknown>,
 *   probes?: Partial<ChildProcessProbes>,
 *   self?: { pid?: number, startedAt?: string, instanceToken?: string },
 *   removeEntry?: (pid: number) => void,
 *   log?: (message: string) => void,
 *   killWaitMs?: number,
 *   sweepTotalBudgetMs?: number,
 *   sleep?: (ms: number) => Promise<void>,
 * }} [input]
 * @returns {Promise<ChildProcessReconcileResult>}
 */
export async function reconcileChildProcessRegistry(input = {}) {
  const registry = input.registry && typeof input.registry === 'object'
    ? input.registry
    : readChildProcessRegistryRaw();
  const probes = createChildProcessProbes(input.probes || {});
  const selfPid = Number.isInteger(input.self?.pid) ? Number(input.self.pid) : process.pid;
  const self = {
    pid: selfPid,
    startedAt: input.self?.startedAt ?? probes.getProcessStartTime(selfPid),
    instanceToken: input.self?.instanceToken ?? CHILD_PROCESS_REGISTRY_SERVER_TOKEN,
  };
  const killWaitMs = Number.isFinite(input.killWaitMs) ? Number(input.killWaitMs) : 1500;
  const sweepTotalBudgetMs = Number.isFinite(input.sweepTotalBudgetMs) && input.sweepTotalBudgetMs >= 0
    ? Number(input.sweepTotalBudgetMs)
    : CHILD_PROCESS_SWEEP_TOTAL_BUDGET_MS;
  const sweepStartedAt = Date.now();
  const sleep = typeof input.sleep === 'function'
    ? input.sleep
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const log = typeof input.log === 'function' ? input.log : (message) => console.warn(message);
  const removeEntry = typeof input.removeEntry === 'function'
    ? input.removeEntry
    : (pid) => {
        try {
          withChildProcessRegistryLock(() => {
            const raw = readChildProcessRegistryRaw();
            delete raw[String(pid)];
            writeJsonAtomic(getChildProcessRegistryPath(), raw);
          });
        } catch {
          // Best-effort; the next sweep retries.
        }
      };
  /** @type {ChildProcessReconcileResult} */
  const result = { kept: [], removed: [], killed: [], skipped: [] };
  for (const [rawPid, rawEntry] of Object.entries(registry)) {
    if (Date.now() - sweepStartedAt >= sweepTotalBudgetMs) {
      log('[child-process] orphan sweep budget exhausted; remaining entries stay for the next start');
      break;
    }
    const pid = Number.parseInt(rawPid, 10);
    const entry = normalizeRegistryValue(rawEntry, rawPid);
    if (!entry) {
      if (Number.isInteger(pid) && pid > 0) {
        removeEntry(pid);
        result.removed.push(pid);
      }
      continue;
    }
    if (isRegistryOwnerAlive(entry, self, probes)) {
      result.kept.push(entry.pid);
      continue;
    }
    // The owner server is dead. Clean the entry without ever signalling a
    // recycled PID, an already-exited child or the restart helper.
    if (!probes.isProcessAlive(entry.pid)) {
      removeEntry(entry.pid);
      result.removed.push(entry.pid);
      continue;
    }
    const liveStart = probes.getProcessStartTime(entry.pid);
    if (entry.startedAt && liveStart && liveStart !== entry.startedAt) {
      removeEntry(entry.pid);
      result.removed.push(entry.pid);
      continue;
    }
    if (isRestartHelperCmdline(probes.readProcessCmdline(entry.pid))) {
      result.kept.push(entry.pid);
      result.skipped.push(entry.pid);
      continue;
    }
    probes.killProcessTree(entry.pid, 'SIGTERM');
    await sleep(killWaitMs);
    if (!probes.isProcessAlive(entry.pid)) {
      removeEntry(entry.pid);
      result.killed.push(entry.pid);
      continue;
    }
    probes.killProcessTree(entry.pid, 'SIGKILL');
    await sleep(killWaitMs);
    if (!probes.isProcessAlive(entry.pid)) {
      removeEntry(entry.pid);
      result.killed.push(entry.pid);
      continue;
    }
    result.kept.push(entry.pid);
    log(`[child-process] could not stop orphan pid ${entry.pid} (${entry.type}); keeping its registry entry`);
  }
  return result;
}

/**
 * Test-only: clear in-memory tracking and the shutdown gates, and remove the
 * persisted registry so one test process can run several scenarios.
 */
export function __resetChildProcessRegistryForTest() {
  childProcessShutdownStarted = false;
  childProcessSpawnTrackingInstalled = false;
  if (immediateDiscoveryTimer) {
    clearTimeout(immediateDiscoveryTimer);
    immediateDiscoveryTimer = null;
  }
  if (originalSpawnForTracking) {
    childProcess.spawn = originalSpawnForTracking;
    originalSpawnForTracking = null;
    syncBuiltinESMExports();
  }
  selfSignalledPids.clear();
  ownedProcesses.clear();
  shutdownPendingPids.clear();
  // Weak collections cannot be cleared; replace them so one test process can
  // re-track a handle that a previous scenario already released.
  trackedHandles = new WeakMap();
  recordedExitEntries = new WeakSet();
  try {
    fs.rmSync(getChildProcessRegistryPath(), { force: true });
  } catch {
    // ignore
  }
}
