/**
 * One OpenCode server instance per workspace folder (lazy init, ref-count, idle shutdown).
 */

import { createHash } from 'crypto';
import fs from 'fs';
import net from 'net';
import { spawn } from 'child_process';
import { createOpencodeClient } from '@opencode-ai/sdk';
import {
  createOpenCodePortOwnerEntry,
  createOpenCodeProcessProbes,
  getProcessStartTime,
  killProcessTree,
  removeOpenCodePortOwner,
  writeOpenCodePortOwner,
} from './opencode-port-registry.js';
import { readEnvAlias } from '../env-alias.js';
import { getEffectiveOpenCodeApiKey, hasOpenCodeCredentials } from './opencode-api-key.js';
import { getEffectiveOpenCodeZaiApiKey, getOpenCodeZaiProvider } from './opencode-zai-api-key.js';
import {
  getEffectiveOpenCodeMimoApiKey,
  getEffectiveOpenCodeMimoBaseUrl,
  OPENCODE_MIMO_PROVIDER_ID,
} from './opencode-mimo-api-key.js';
import { dedupeOpenCodeModelsForChat } from './opencode-model-resolve.js';
import { buildOpenCodeServerConfig } from './opencode-compaction-config.js';
import {
  applyOpenCodeSpawnPath,
  resolveOpenCodeHomeDirs,
  resolveOpenCodeUserHome,
} from './opencode-spawn-path.js';
import { loadSettings } from '../persist/settings.js';

/** Startup/shutdown sweep over the OpenCode ownership registry. */
export { reconcileOpenCodePortRegistry } from './opencode-port-registry.js';

const OPENCODE_HOSTNAME = '127.0.0.1';
const PORT_PROBE_TIMEOUT_MS = 400;
const OPENCODE_ZEN_PROVIDER_IDS = ['opencode', 'opencode-go'];

function buildOpenCodeMimoProviderConfig(apiKey, baseURL) {
  return {
    [OPENCODE_MIMO_PROVIDER_ID]: {
      npm: '@ai-sdk/openai-compatible',
      name: 'Xiaomi MiMo',
      options: { baseURL, apiKey },
      models: {
        'mimo-v2.6-pro': {
          name: 'MiMo V2.6 Pro', reasoning: true, tool_call: true,
          compatibility: { reasoningField: 'reasoning_content' },
          attachment: true,
          modalities: { input: ['text', 'image', 'audio', 'video'], output: ['text'] },
          limit: { context: 1000000, output: 128000 },
        },
        'mimo-v2.6-flash': {
          name: 'MiMo V2.6 Flash', reasoning: true, tool_call: true,
          compatibility: { reasoningField: 'reasoning_content' },
          attachment: true,
          modalities: { input: ['text', 'image', 'audio', 'video'], output: ['text'] },
          limit: { context: 1000000, output: 128000 },
        },
      },
    },
  };
}

const IDLE_SHUTDOWN_MS = 90000;
/**
 * Opt-in hard cap on simultaneously live OpenCode instances. A missing, zero
 * or non-positive value means "no limit", so the historical behaviour is the
 * default and operators enable the cap deliberately.
 */
export const OPENCODE_MAX_INSTANCES_ENV = 'CRETLI_OPENCODE_MAX_INSTANCES';
/**
 * Opt-in shorter idle window for delegation-child instances. Zero/absent keeps
 * `IDLE_SHUTDOWN_MS` for those instances too; normal chats are never affected.
 */
export const OPENCODE_DELEGATION_IDLE_MS_ENV = 'CRETLI_OPENCODE_DELEGATION_IDLE_MS';
/** Stable error code for a refused create at the cap (surfaced to the UI). */
export const OPENCODE_INSTANCE_LIMIT_CODE = 'opencode_instance_limit';
const DEFAULT_PORT_BASE = 4096;
export const OPENCODE_PORT_SPAN = 2000;
const DEFAULT_START_TIMEOUT_MS = 120000;
/**
 * SIGTERM -> SIGKILL escalation for the graceful shutdown phase. Kept below the
 * 2 s window `scripts/task-restart-server.sh` used to allow between `kill` and
 * `kill -9`; the script now waits longer still, so the escalation always wins.
 */
const SHUTDOWN_SIGTERM_GRACE_MS = 1200;
/** Time allowed for SIGKILL to be reaped before the shutdown phase reports failure. */
const SHUTDOWN_SIGKILL_WAIT_MS = 400;
/** Upper bound of the whole OpenCode shutdown phase (1200 + 400 = 1600 ms). */
export const OPENCODE_SHUTDOWN_TOTAL_MS = SHUTDOWN_SIGTERM_GRACE_MS + SHUTDOWN_SIGKILL_WAIT_MS;
/** SIGKILL escalation owned by `startOpenCodeServer().close()`. */
const INSTANCE_CLOSE_SIGKILL_MS = 1500;

/** @type {Map<number, string>} */
const reservedPorts = new Map();

/**
 * OpenCode MCP is instance-wide. Isolate the runtime when a Cretli chat needs
 * its own Plan/Agent bridge context.
 *
 * @param {{ workspaceFolder?: unknown, sessionKey?: unknown }} options
 * @returns {string}
 */
export function opencodeInstanceKey(options) {
  const workspaceFolder = String(options?.workspaceFolder || '').trim();
  const sessionKey = String(options?.sessionKey || '').trim();
  if (!workspaceFolder) return '';
  if (!sessionKey) return `workspace:${workspaceFolder}`;
  return `session:${workspaceFolder}\0${sessionKey}`;
}

/**
 * @param {string} instanceKey
 * @returns {number}
 */
export function preferredOpenCodePortOffset(instanceKey) {
  const hash = createHash('sha256').update(String(instanceKey || '')).digest();
  return hash.readUInt16BE(0) % OPENCODE_PORT_SPAN;
}

/**
 * Pick a listen port that is not already in use by any live process.
 *
 * There is deliberately no attach path: a busy port always means "take the
 * next one". A Cretli server owns exactly the OpenCode instances it spawned
 * itself, so it can always close them.
 *
 * @param {{
 *   instanceKey: string,
 *   portBase?: number,
 *   span?: number,
 *   preferredOffset?: number,
 *   occupied?: Map<number, string>,
 *   isOccupied?: (port: number) => boolean | Promise<boolean>,
 * }} input
 * @returns {Promise<{ port: number }>}
 */
export async function chooseOpenCodeListenPort(input) {
  const instanceKey = String(input?.instanceKey || '').trim();
  if (!instanceKey) throw new Error('OpenCode instance key is required');
  const base = Number.isInteger(input.portBase) && input.portBase > 0 ? input.portBase : DEFAULT_PORT_BASE;
  const span = Number.isInteger(input.span) && input.span > 0 ? input.span : OPENCODE_PORT_SPAN;
  const preferred = Number.isInteger(input.preferredOffset)
    ? input.preferredOffset
    : preferredOpenCodePortOffset(instanceKey);
  const occupied = input.occupied instanceof Map ? input.occupied : new Map();
  const isOccupied = typeof input.isOccupied === 'function' ? input.isOccupied : () => false;
  for (let step = 0; step < span; step += 1) {
    const port = base + ((preferred + step) % span);
    const memOwner = occupied.get(port);
    if (memOwner && memOwner !== instanceKey) continue;
    if (await isOccupied(port)) continue;
    return { port };
  }
  throw new Error('No free OpenCode port');
}

/**
 * True when some process already listens on the localhost OpenCode port.
 * A connection refused means the port is free; a timeout is treated as busy
 * so a slow listener is never reused by accident.
 *
 * @param {number} port
 * @returns {Promise<boolean>}
 */
export function isOpenCodePortOccupied(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: OPENCODE_HOSTNAME, port });
    let settled = false;
    const finish = (occupied) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(occupied);
    };
    socket.setTimeout(PORT_PROBE_TIMEOUT_MS);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function occupiedOpenCodePorts() {
  /** @type {Map<number, string>} */
  const occupied = new Map(reservedPorts);
  for (const [key, entry] of instances.entries()) {
    if (!Number.isInteger(entry?.port)) continue;
    occupied.set(entry.port, key);
  }
  return occupied;
}

/** @type {Promise<void>} */
let portPickChain = Promise.resolve();

/**
 * Serialize pick+reserve so two instance starts cannot claim the same port.
 *
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 * @template T
 */
function enqueueOpenCodePortPick(task) {
  const run = portPickChain.then(task, task);
  portPickChain = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * Choose a listen port and reserve it before the next waiter runs.
 *
 * @param {Parameters<typeof chooseOpenCodeListenPort>[0] & { reserve?: boolean }} input
 * @returns {Promise<{ port: number }>}
 */
export async function pickAndReserveOpenCodeListenPort(input) {
  const instanceKey = String(input?.instanceKey || '').trim();
  if (!instanceKey) throw new Error('OpenCode instance key is required');
  return enqueueOpenCodePortPick(async () => {
    const occupied = input.occupied instanceof Map ? input.occupied : occupiedOpenCodePorts();
    const chosen = await chooseOpenCodeListenPort({ ...input, instanceKey, occupied });
    occupied.set(chosen.port, instanceKey);
    if (input.reserve !== false) reservedPorts.set(chosen.port, instanceKey);
    return chosen;
  });
}

/** @type {Map<string, {
 *   client: import('@opencode-ai/sdk').OpencodeClient,
 *   server: { url: string, pid: number, startedAt: string, close(): void },
 *   baseUrl: string,
 *   refCount: number,
 *   port: number,
 *   opencodePid: number,
 *   workspaceFolder: string,
 *   sessionKey: string,
 *   _idleTimer: ReturnType<typeof setTimeout> | null,
 *   _lastUsedAt: number,
 *   idleShutdownMs: number,
 * }>} */
const instances = new Map();

/** @type {Map<string, Promise<void>>} */
const pendingCreates = new Map();

/**
 * Phase-1 gate. Once true, no new instance may be created and an in-flight
 * start closes the instance it just spawned instead of publishing it.
 */
let openCodeShutdownStarted = false;

/**
 * Bumped by `disposeAllOpenCodeInstances` so an in-flight start can close the
 * instance it spawned after the map was drained, without a permanent gate
 * (an API key change must not block future instances).
 */
let openCodeInstanceGeneration = 0;

/**
 * OpenCode PIDs whose create promise has not published an `instances` entry
 * yet, keyed by instance key.
 *
 * @type {Map<string, number>}
 */
const startingPids = new Map();

/**
 * PIDs the shutdown phase must confirm dead, keyed by instance key. Populated
 * from `instances` and `startingPids` at phase 1.
 *
 * @type {Map<number, string>}
 */
const shutdownPendingPids = new Map();

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * OpenCode PID recorded on an instance entry, or 0.
 *
 * @param {{ opencodePid?: unknown, server?: { pid?: unknown } } | null | undefined} entry
 * @returns {number}
 */
function openCodePidOf(entry) {
  const pid = Number(entry?.opencodePid || entry?.server?.pid || 0);
  return Number.isInteger(pid) && pid > 0 ? pid : 0;
}

/**
 * @returns {Error & { code: string }}
 */
function createOpenCodeShuttingDownError() {
  const error = /** @type {Error & { code: string }} */ (new Error('OpenCode instance creation is blocked during shutdown.'));
  error.code = 'opencode_shutting_down';
  return error;
}

/**
 * Test-only: clear the shutdown gate, tracking maps and instance/port state so
 * one test process can run several scenarios. Production callers never use it.
 */
export function __resetOpenCodeShutdownForTest() {
  openCodeShutdownStarted = false;
  openCodeInstanceGeneration = 0;
  startingPids.clear();
  shutdownPendingPids.clear();
  for (const entry of instances.values()) {
    if (entry._idleTimer) clearTimeout(entry._idleTimer);
  }
  instances.clear();
  reservedPorts.clear();
}

let loggedOpenCodeBin = '';

/**
 * When the process runs with a non-root UID and HOME incorrectly points to /root,
 * OpenCode may fail to create its local state directory.
 *
 * @param {{ uid?: number | null, home?: string, fallbackHome?: string }} [options]
 * @returns {string}
 */
export function resolveOpenCodeRuntimeHome(options = {}) {
  const uid = Number.isFinite(options.uid) ? Number(options.uid) : null;
  const home = String(options.home || '').trim();
  const fallbackHome = String(options.fallbackHome || '').trim();
  if (uid !== null && uid !== 0 && home.startsWith('/root') && fallbackHome) {
    return fallbackHome;
  }
  return home;
}

function applyOpenCodeRuntimeEnvironment() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const uidLabel = Number.isFinite(uid) ? String(uid) : 'unknown';
  /**
   * @param {string} homePath
   * @returns {boolean}
   */
  const ensureOpenCodeHomeWritable = (homePath) => {
    const normalizedHome = String(homePath || '').trim();
    if (!normalizedHome) return false;
    try {
      fs.mkdirSync(normalizedHome, { recursive: true });
      fs.mkdirSync(`${normalizedHome}/.local/state`, { recursive: true });
      return true;
    } catch {
      return false;
    }
  };
  const currentHome = String(process.env.HOME || '').trim();
  const fallbackHome = readEnvAlias({
    current: 'CRETLI_RUNTIME_HOME',
    legacy: 'CURSOR_REMOTE_RUNTIME_HOME',
    defaultValue: resolveOpenCodeUserHome(),
  }).trim();
  const resolvedHome = resolveOpenCodeRuntimeHome({
    uid,
    home: currentHome,
    fallbackHome,
  });
  if (resolvedHome && resolvedHome !== currentHome) {
    process.env.HOME = resolvedHome;
  }
  let effectiveHome = String(process.env.HOME || '').trim();
  if (uid !== 0 && !ensureOpenCodeHomeWritable(effectiveHome)) {
    const fallbackCandidates = [fallbackHome, `/tmp/cretli-home-${uidLabel}`];
    for (const candidate of fallbackCandidates) {
      if (!candidate) continue;
      if (!ensureOpenCodeHomeWritable(candidate)) continue;
      process.env.HOME = candidate;
      effectiveHome = candidate;
      break;
    }
  }
  const configuredDataHome = String(
    readEnvAlias({ current: 'CRETLI_OPENCODE_DATA_HOME', legacy: 'CURSOR_REMOTE_OPENCODE_DATA_HOME' }) || process.env.XDG_DATA_HOME || ''
  ).trim();
  const preferredDataHome = configuredDataHome || (effectiveHome ? `${effectiveHome}/.opencode-data` : '');
  if (preferredDataHome) {
    try {
      fs.mkdirSync(preferredDataHome, { recursive: true });
      process.env.XDG_DATA_HOME = preferredDataHome;
      return;
    } catch {
      // fall through to fallback
    }
  }
  const tmpFallbackDataHome = `/tmp/cretli-opencode-${uidLabel}`;
  fs.mkdirSync(tmpFallbackDataHome, { recursive: true });
  process.env.XDG_DATA_HOME = tmpFallbackDataHome;
}

const OPENCODE_SERVER_LISTEN_LINE = 'opencode server listening';
const OPENCODE_SERVER_URL_RE = /on\s+(https?:\/\/[^\s]+)/;

/**
 * Start `opencode serve` ourselves instead of going through `createOpencode`.
 *
 * The SDK returns only `{ url, close }`, and its `stop()` on Linux is a plain
 * `proc.kill()` that leaves OpenCode's children (LSP servers etc.) behind. A
 * detached spawn gives us the PID, a private process group and a close() that
 * tears the whole group down — everything the ownership registry needs.
 *
 * @param {{
 *   bin?: string,
 *   hostname?: string,
 *   port: number,
 *   timeout?: number,
 *   config?: Record<string, unknown>,
 *   onSpawn?: (pid: number) => void,
 * }} options
 * @returns {Promise<{ url: string, pid: number, startedAt: string, close(): void }>}
 */
export function startOpenCodeServer(options) {
  const hostname = String(options?.hostname || OPENCODE_HOSTNAME);
  const port = Number(options?.port);
  const timeout = Number(options?.timeout) > 0 ? Number(options.timeout) : DEFAULT_START_TIMEOUT_MS;
  const bin = String(options?.bin || 'opencode');
  const config = options?.config && typeof options.config === 'object' ? options.config : {};
  if (!Number.isInteger(port) || port <= 0) {
    return Promise.reject(new Error('OpenCode port is required'));
  }
  const args = ['serve', `--hostname=${hostname}`, `--port=${port}`];
  if (config.logLevel) args.push(`--log-level=${config.logLevel}`);
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      detached: true,
      env: { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      // The owner learns the PID before the listen line, so a shutdown that
      // starts mid-boot can still signal the process group.
      options?.onSpawn?.(child.pid);
    } catch {
      // A tracking callback must never break the spawn.
    }
    let output = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killProcessTree(child.pid, 'SIGKILL');
      reject(new Error(`Timeout waiting for OpenCode server on port ${port} after ${timeout}ms`));
    }, timeout);
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle(value);
    };
    child.stdout?.on('data', (chunk) => {
      if (settled) return;
      output += chunk.toString();
      for (const line of output.split('\n')) {
        if (!line.startsWith(OPENCODE_SERVER_LISTEN_LINE)) continue;
        const match = line.match(OPENCODE_SERVER_URL_RE);
        if (!match) {
          killProcessTree(child.pid, 'SIGKILL');
          finish(reject, new Error(`Failed to parse OpenCode server url from output: ${line}`));
          return;
        }
        finish(resolve, {
          url: match[1],
          pid: child.pid,
          startedAt: getProcessStartTime(child.pid),
          close() {
            killProcessTree(child.pid, 'SIGTERM');
            const killTimer = setTimeout(() => killProcessTree(child.pid, 'SIGKILL'), INSTANCE_CLOSE_SIGKILL_MS);
            if (typeof killTimer.unref === 'function') killTimer.unref();
          },
        });
        return;
      }
    });
    child.stderr?.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.once('error', (err) => finish(reject, err));
    child.once('exit', (code) => {
      const tail = output.trim() ? `\nServer output: ${output.trim()}` : '';
      finish(reject, new Error(`OpenCode server exited with code ${code ?? 'unknown'}${tail}`));
    });
  });
}

/**
 * @param {string} workspaceFolder
 * @param {number} port
 * @param {number} timeout
 * @returns {Promise<void>}
 */
async function createOpenCodeInstanceEntry(instanceKey, workspaceFolder, timeout, sessionKey, options = {}) {
  const existing = instances.get(instanceKey);
  if (existing?.client) return;
  if (openCodeShutdownStarted) throw createOpenCodeShuttingDownError();
  // Opt-in cap. Runs before any await, so the count cannot change underneath.
  enforceOpenCodeInstanceLimit();
  const delegation = options.delegation === true;
  const delegationIdleMs = delegation ? resolveOpenCodeDelegationIdleMs() : 0;
  // Capture the generation: a `disposeAllOpenCodeInstances` (API key change)
  // that lands while the child boots must invalidate this start too.
  const generation = openCodeInstanceGeneration;
  applyOpenCodeRuntimeEnvironment();
  const settings = loadSettings();
  const opencodeBin = typeof settings.opencodeBin === 'string' ? settings.opencodeBin.trim() : '';
  const resolvedBin = applyOpenCodeSpawnPath({
    configuredBin: opencodeBin,
    homeDirs: resolveOpenCodeHomeDirs(),
  });
  if (resolvedBin && resolvedBin !== loggedOpenCodeBin) {
    loggedOpenCodeBin = resolvedBin;
    console.log(`[opencode] using ${resolvedBin}`);
  }
  const apiKey = getEffectiveOpenCodeApiKey();
  if (apiKey) {
    process.env.OPENCODE_API_KEY = apiKey;
  }
  const zaiApiKey = getEffectiveOpenCodeZaiApiKey();
  const mimoApiKey = getEffectiveOpenCodeMimoApiKey();
  const mimoBaseUrl = getEffectiveOpenCodeMimoBaseUrl();
  // Native compaction: prune old tool output deterministically and keep
  // auto/reserved configurable. Passed with the spawn config (and reused for
  // the runtime config update) so it applies to every managed instance.
  const serverConfig = buildOpenCodeServerConfig({
    settings,
    provider: mimoApiKey ? buildOpenCodeMimoProviderConfig(mimoApiKey, mimoBaseUrl) : null,
  });
  const chosen = await pickAndReserveOpenCodeListenPort({
    instanceKey,
    portBase: resolvePortBase(),
    isOccupied: isOpenCodePortOccupied,
  });
  const port = chosen.port;
  /** @type {{ url: string, pid: number, startedAt: string, close(): void } | null} */
  let server = null;
  try {
    server = await startOpenCodeServer({
      bin: resolvedBin || 'opencode',
      hostname: OPENCODE_HOSTNAME,
      port,
      timeout,
      config: serverConfig,
      onSpawn: (pid) => {
        if (!Number.isInteger(pid) || pid <= 0) return;
        startingPids.set(instanceKey, pid);
        if (openCodeShutdownStarted) {
          // A shutdown that began while this child was booting must not leave
          // it behind: record it for phase 2 and signal it immediately.
          shutdownPendingPids.set(pid, instanceKey);
          killProcessTree(pid, 'SIGTERM');
        }
      },
    });
    if (openCodeShutdownStarted || generation !== openCodeInstanceGeneration) {
      // Never publish an instance after the instance map was drained. The
      // catch below closes the child; phase 2 also tracks its PID.
      throw createOpenCodeShuttingDownError();
    }
    const client = createOpencodeClient({
      baseUrl: server.url,
      directory: workspaceFolder,
    });
    if (mimoApiKey) {
      try {
        await client.config.update({
          query: { directory: workspaceFolder },
          body: serverConfig,
        });
      } catch (err) {
        console.warn('[opencode] MiMo provider config update failed:', err?.message || err);
      }
    }
    if (apiKey) {
      try {
        await applyOpenCodeProviderCredentials(client, workspaceFolder, OPENCODE_ZEN_PROVIDER_IDS, apiKey);
      } catch (err) {
        console.warn('[opencode] auth.set failed:', err?.message || err);
      }
    }
    if (zaiApiKey) {
      try {
        await applyOpenCodeProviderCredentials(client, workspaceFolder, [getOpenCodeZaiProvider()], zaiApiKey);
      } catch (err) {
        console.warn('[opencode] z.ai auth.set failed:', err?.message || err);
      }
    }
    writeOpenCodePortOwner(port, createOpenCodePortOwnerEntry({
      instanceKey,
      opencodePid: server.pid,
      opencodeStartedAt: server.startedAt,
    }));
    instances.set(instanceKey, {
      client,
      server,
      baseUrl: server.url,
      refCount: 0,
      port,
      opencodePid: server.pid,
      workspaceFolder,
      sessionKey: String(sessionKey || ''),
      _idleTimer: null,
      _lastUsedAt: Date.now(),
      idleShutdownMs: delegationIdleMs > 0 ? delegationIdleMs : 0,
    });
  } catch (err) {
    try {
      server?.close();
    } catch {
      // The child may never have started; nothing to stop.
    }
    reservedPorts.delete(port);
    throw err;
  } finally {
    startingPids.delete(instanceKey);
  }
}

/**
 * @returns {number}
 */
function resolvePortBase() {
  const settings = loadSettings();
  const fromEnv = Number.parseInt(String(process.env.OPENCODE_PORT_BASE ?? ''), 10);
  const fromSettings = Number.parseInt(String(settings.opencodePortBase ?? ''), 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  if (Number.isFinite(fromSettings) && fromSettings > 0) return fromSettings;
  return DEFAULT_PORT_BASE;
}

/**
 * Hard cap on simultaneously live OpenCode instances. Opt-in by design: a
 * missing, zero or non-positive value means no limit, so the pre-existing
 * unbounded behaviour is preserved until an operator asks for a cap.
 *
 * Precedence mirrors `resolvePortBase`: a valid positive env var wins, then the
 * saved `opencodeMaxInstances` setting.
 *
 * @returns {number} the cap, or 0 when unlimited
 */
export function resolveOpenCodeMaxInstances() {
  const fromEnv = Number.parseInt(String(process.env[OPENCODE_MAX_INSTANCES_ENV] ?? ''), 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  const settings = loadSettings();
  const fromSettings = Number.parseInt(String(settings.opencodeMaxInstances ?? ''), 10);
  if (Number.isFinite(fromSettings) && fromSettings > 0) return fromSettings;
  return 0;
}

/**
 * Idle-shutdown override for delegation-child instances. Opt-in: 0 keeps the
 * normal `IDLE_SHUTDOWN_MS` window, so only an explicit value shortens it.
 *
 * @returns {number} milliseconds, or 0 to use the default window
 */
export function resolveOpenCodeDelegationIdleMs() {
  const fromEnv = Number.parseInt(String(process.env[OPENCODE_DELEGATION_IDLE_MS_ENV] ?? ''), 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  const settings = loadSettings();
  const fromSettings = Number.parseInt(String(settings.opencodeDelegationIdleMs ?? ''), 10);
  if (Number.isFinite(fromSettings) && fromSettings > 0) return fromSettings;
  return 0;
}

/**
 * Readable refusal raised when the instance cap is reached and no idle instance
 * can be evicted. Callers surface `error.code` to the UI.
 *
 * @param {number} limit
 * @returns {Error & { code: string, limit: number }}
 */
function createOpenCodeInstanceLimitError(limit) {
  const error = /** @type {Error & { code: string, limit: number }} */ (new Error(
    `OpenCode instance limit reached (${limit}). Close an idle OpenCode chat or raise ${OPENCODE_MAX_INSTANCES_ENV} / the opencodeMaxInstances setting.`
  ));
  error.code = OPENCODE_INSTANCE_LIMIT_CODE;
  error.limit = limit;
  return error;
}

/**
 * Live plus in-flight OpenCode instances. A create that is still booting counts
 * against the cap because it already owns a process group and a port.
 *
 * @returns {number}
 */
function countOpenCodeInstances() {
  return instances.size + pendingCreates.size;
}

/**
 * Close the least-recently-used idle instance (refCount 0) and free its slot.
 * Active instances are never touched. Returns the evicted key, or '' when every
 * live instance is in use.
 *
 * @returns {string}
 */
function evictIdleOpenCodeInstance() {
  let victimKey = '';
  let victimUsedAt = Infinity;
  for (const [key, entry] of instances.entries()) {
    if (!entry || entry.refCount > 0) continue;
    const usedAt = Number.isFinite(entry._lastUsedAt) ? entry._lastUsedAt : 0;
    if (usedAt < victimUsedAt) {
      victimUsedAt = usedAt;
      victimKey = key;
    }
  }
  if (!victimKey) return '';
  const victim = instances.get(victimKey);
  if (victim?._idleTimer) {
    clearTimeout(victim._idleTimer);
    victim._idleTimer = null;
  }
  try {
    victim?.server?.close();
  } catch {
    // A close failure must not leave the slot occupied.
  }
  forgetOpenCodePort(victimKey, victim?.port);
  instances.delete(victimKey);
  return victimKey;
}

/**
 * Enforce the opt-in instance cap before a new instance is created. This is
 * called synchronously before the first `await`, so a single-threaded create
 * cannot interleave with another gate check.
 *
 * When the cap is already reached, evict idle instances (LRU first) until there
 * is room; if none is idle, refuse with `opencode_instance_limit` rather than
 * killing active work or hanging.
 *
 * @throws {Error & { code: string, limit: number }}
 */
function enforceOpenCodeInstanceLimit() {
  const limit = resolveOpenCodeMaxInstances();
  if (limit <= 0) return;
  // The current create is not yet in `pendingCreates`, so a count at the cap
  // already means that publishing one more instance would exceed it.
  while (countOpenCodeInstances() >= limit) {
    if (!evictIdleOpenCodeInstance()) throw createOpenCodeInstanceLimitError(limit);
  }
}

function forgetOpenCodePort(instanceKey, port) {
  if (reservedPorts.get(port) === instanceKey) reservedPorts.delete(port);
  removeOpenCodePortOwner(port, instanceKey);
}

/**
 * @param {unknown} result
 * @returns {Record<string, unknown> | null}
 */
function unwrapSdkData(result) {
  if (!result || typeof result !== 'object') return null;
  if ('data' in result && result.data && typeof result.data === 'object') {
    return /** @type {Record<string, unknown>} */ (result.data);
  }
  return /** @type {Record<string, unknown>} */ (result);
}

/**
 * @param {import('@opencode-ai/sdk').OpencodeClient} client
 * @param {string} workspaceFolder
 * @param {string[]} providerIds
 * @param {string} apiKey
 */
async function applyOpenCodeProviderCredentials(client, workspaceFolder, providerIds, apiKey) {
  const key = String(apiKey || '').trim();
  if (!key || !client?.auth?.set) return;
  for (const providerId of providerIds) {
    try {
      await client.auth.set({
        path: { id: providerId },
        query: { directory: workspaceFolder },
        body: { type: 'api', key },
      });
    } catch (err) {
      console.warn(`[opencode] auth.set failed for ${providerId}:`, err?.message || err);
    }
  }
}

/**
 * @param {{ workspaceFolder: string, sessionKey?: string, delegation?: boolean }} options
 * @returns {Promise<{
 *   client: import('@opencode-ai/sdk').OpencodeClient,
 *   baseUrl: string,
 *   workspaceFolder: string,
 *   sessionKey: string,
 *   release: () => void,
 * }>}
 */
export async function getOrCreateOpenCodeInstance(options) {
  const workspaceFolder = String(options?.workspaceFolder || '').trim();
  if (!workspaceFolder) {
    throw new Error('workspaceFolder is required');
  }
  if (openCodeShutdownStarted) throw createOpenCodeShuttingDownError();
  const sessionKey = String(options?.sessionKey || '').trim();
  const instanceKey = opencodeInstanceKey({ workspaceFolder, sessionKey });
  let entry = instances.get(instanceKey);
  if (entry?.client) {
    entry.refCount += 1;
    entry._lastUsedAt = Date.now();
    if (entry._idleTimer) {
      clearTimeout(entry._idleTimer);
      entry._idleTimer = null;
    }
    return {
      client: entry.client,
      baseUrl: entry.baseUrl,
      workspaceFolder,
      sessionKey,
      release: () => releaseOpenCodeInstance(instanceKey),
    };
  }
  const timeoutRaw = Number.parseInt(String(process.env.OPENCODE_START_TIMEOUT_MS ?? ''), 10);
  const timeout = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : DEFAULT_START_TIMEOUT_MS;
  let pending = pendingCreates.get(instanceKey);
  if (!pending) {
    pending = createOpenCodeInstanceEntry(instanceKey, workspaceFolder, timeout, sessionKey, {
      delegation: options?.delegation === true,
    }).finally(() => {
      pendingCreates.delete(instanceKey);
    });
    pendingCreates.set(instanceKey, pending);
  }
  try {
    await pending;
  } catch (err) {
    instances.delete(instanceKey);
    throw err;
  }
  entry = instances.get(instanceKey);
  if (!entry?.client) {
    throw new Error('OpenCode instance failed to initialize');
  }
  entry.refCount += 1;
  entry._lastUsedAt = Date.now();
  if (entry._idleTimer) {
    clearTimeout(entry._idleTimer);
    entry._idleTimer = null;
  }
  return {
    client: entry.client,
    baseUrl: entry.baseUrl,
    workspaceFolder,
    sessionKey,
    release: () => releaseOpenCodeInstance(instanceKey),
  };
}

/**
 * @param {string} workspaceFolder
 */
export function releaseOpenCodeInstance(workspaceFolderOrKey, sessionKey = '') {
  const asKey = String(workspaceFolderOrKey || '').trim();
  const key = asKey.startsWith('workspace:') || asKey.startsWith('session:')
    ? asKey
    : opencodeInstanceKey({ workspaceFolder: asKey, sessionKey });
  const entry = instances.get(key);
  if (!entry) return;
  entry.refCount = Math.max(0, (entry.refCount || 1) - 1);
  entry._lastUsedAt = Date.now();
  if (entry.refCount > 0) return;
  if (entry._idleTimer) clearTimeout(entry._idleTimer);
  const idleMs = Number.isFinite(entry.idleShutdownMs) && entry.idleShutdownMs > 0
    ? entry.idleShutdownMs
    : IDLE_SHUTDOWN_MS;
  entry._idleTimer = setTimeout(() => {
    const current = instances.get(key);
    if (!current || current.refCount > 0) return;
    try {
      current.server?.close();
    } catch {
      // ignore shutdown errors
    }
    forgetOpenCodePort(key, current.port);
    instances.delete(key);
  }, idleMs);
}

/**
 * @param {string} workspaceFolder
 * @returns {Promise<{
 *   ok: boolean,
 *   opencodeReady?: boolean,
 *   healthy?: boolean,
 *   version?: string,
 *   connectedProviders?: string[],
 *   error?: string,
 * }>}
 */
export async function getOpenCodeHealth(workspaceFolder) {
  const folder = String(workspaceFolder || '').trim();
  if (!folder) {
    return { ok: false, opencodeReady: false, error: 'Missing workspace folder' };
  }
  let instance = null;
  try {
    instance = await getOrCreateOpenCodeInstance({ workspaceFolder: folder });
    const healthUrl = `${instance.baseUrl.replace(/\/$/, '')}/global/health`;
    const healthResponse = await fetch(healthUrl);
    if (!healthResponse.ok) {
      throw new Error(`OpenCode health HTTP ${healthResponse.status}`);
    }
    const health = /** @type {{ healthy?: boolean, version?: string }} */ (await healthResponse.json());
    const healthy = health?.healthy === true;
    let connectedProviders = [];
    if (healthy) {
      try {
        const providersResult = await instance.client.config.providers({
          query: { directory: folder },
        });
        const providersPayload = unwrapSdkData(providersResult);
        const providers = Array.isArray(providersPayload?.providers) ? providersPayload.providers : [];
        connectedProviders = providers
          .map((row) => (row && typeof row.id === 'string' ? row.id : ''))
          .filter(Boolean);
      } catch {
        connectedProviders = [];
      }
    }
    return {
      ok: true,
      opencodeReady: healthy && hasOpenCodeCredentials(),
      healthy,
      version: typeof health?.version === 'string' ? health.version : undefined,
      connectedProviders,
    };
  } catch (err) {
    return {
      ok: false,
      opencodeReady: false,
      healthy: false,
      error: err?.message || String(err),
    };
  } finally {
    instance?.release();
  }
}

/**
 * @param {string} workspaceFolder
 * @returns {Promise<Array<{ id: string, name: string, providerId: string, modelId: string, contextWindowTokens: number | null }>>}
 */
export async function listOpenCodeModels(workspaceFolder) {
  const folder = String(workspaceFolder || '').trim();
  if (!folder) return [];
  const instance = await getOrCreateOpenCodeInstance({ workspaceFolder: folder });
  try {
    const providersResult = await instance.client.config.providers({
      query: { directory: folder },
    });
    const payload = unwrapSdkData(providersResult);
    const providers = Array.isArray(payload?.providers) ? payload.providers : [];
    /**
     * @param {unknown} modelInfo
     * @returns {number | null}
     */
    const resolveContextWindowTokens = (modelInfo) => {
      if (!modelInfo || typeof modelInfo !== 'object') return null;
      const limit =
        modelInfo.limit && typeof modelInfo.limit === 'object'
          ? modelInfo.limit
          : null;
      if (!limit) return null;
      const inputLimit = Number(limit.input);
      if (Number.isFinite(inputLimit) && inputLimit > 0) return Math.round(inputLimit);
      const contextLimit = Number(limit.context);
      if (Number.isFinite(contextLimit) && contextLimit > 0) return Math.round(contextLimit);
      return null;
    };
    /** @type {Array<{ id: string, name: string, providerId: string, modelId: string, contextWindowTokens: number | null }>} */
    const models = [];
    for (const provider of providers) {
      const providerId = typeof provider?.id === 'string' ? provider.id.trim() : '';
      if (!providerId) continue;
      const modelMap = provider?.models && typeof provider.models === 'object' ? provider.models : {};
      for (const [modelId, modelInfo] of Object.entries(modelMap)) {
        const trimmedModelId = String(modelId || '').trim();
        if (!trimmedModelId) continue;
        const name = typeof modelInfo?.name === 'string' ? modelInfo.name : trimmedModelId;
        models.push({
          id: `${providerId}/${trimmedModelId}`,
          name,
          providerId,
          modelId: trimmedModelId,
          contextWindowTokens: resolveContextWindowTokens(modelInfo),
        });
      }
    }
    models.sort((a, b) => a.name.localeCompare(b.name));
    return dedupeOpenCodeModelsForChat(models, {
      preferredZaiProvider: getOpenCodeZaiProvider(),
    });
  } finally {
    instance.release();
  }
}

/**
 * Pre-start OpenCode when any supported provider key is configured (first chat/model request is faster).
 * @param {string} [workspaceFolder]
 */
export async function warmUpOpenCodeFromSettings(workspaceFolder) {
  if (!hasOpenCodeCredentials()) return { ok: false, skipped: true };
  const settings = loadSettings();
  const folder = String(workspaceFolder || settings.workspaceFolder || process.cwd()).trim();
  if (!folder) return { ok: false, error: 'Missing workspace folder' };
  const health = await getOpenCodeHealth(folder);
  return { ok: health.opencodeReady === true, ...health };
}

/**
 * Force-close all OpenCode instances (e.g. after API key change).
 *
 * The generation bump invalidates an in-flight start: when its child comes up
 * it closes itself instead of publishing an instance after this drain.
 */
export function disposeAllOpenCodeInstances() {
  openCodeInstanceGeneration += 1;
  for (const [key, entry] of instances.entries()) {
    if (entry._idleTimer) clearTimeout(entry._idleTimer);
    try {
      entry.server?.close();
    } catch {
      // ignore shutdown errors
    }
    forgetOpenCodePort(key, entry.port);
    instances.delete(key);
  }
  for (const pid of startingPids.values()) {
    if (!Number.isInteger(pid) || pid <= 0) continue;
    killProcessTree(pid, 'SIGTERM');
  }
}

/**
 * First phase of process shutdown. Synchronous by design — the caller must not
 * `await` it. It sets the gate that refuses new instances, records every owned
 * PID (live instances plus children still booting) and SIGTERMs each process
 * group once, without waiting for exit.
 *
 * A deliberate cost, documented in `docs/TROUBLESHOOTING.md`: signalling
 * OpenCode first cuts in-flight chats and delegations. Under SIGTERM (earlyoom,
 * restart) those runs will not finish anyway, so freeing their memory and
 * marking them interrupted is more useful than a graceful drain.
 *
 * @param {{ kill?: (pid: number, signal: string) => boolean }} [options]
 * @returns {{ instances: number, pending: number, signaled: number }}
 */
export function beginOpenCodeShutdown(options = {}) {
  const kill = typeof options.kill === 'function' ? options.kill : killProcessTree;
  openCodeShutdownStarted = true;
  for (const [key, entry] of instances.entries()) {
    if (entry._idleTimer) {
      clearTimeout(entry._idleTimer);
      entry._idleTimer = null;
    }
    const pid = openCodePidOf(entry);
    if (pid > 0) shutdownPendingPids.set(pid, key);
  }
  for (const [key, pid] of startingPids.entries()) {
    if (Number.isInteger(pid) && pid > 0) shutdownPendingPids.set(pid, key);
  }
  let signaled = 0;
  for (const pid of shutdownPendingPids.keys()) {
    if (kill(pid, 'SIGTERM')) signaled += 1;
  }
  return { instances: instances.size, pending: pendingCreates.size, signaled };
}

/**
 * Every PID the shutdown must confirm dead: tracked shutdown targets, live
 * instances and children still booting.
 *
 * @returns {Set<number>}
 */
function collectShutdownPids() {
  const pids = new Set(shutdownPendingPids.keys());
  for (const entry of instances.values()) {
    const pid = openCodePidOf(entry);
    if (pid > 0) pids.add(pid);
  }
  for (const pid of startingPids.values()) {
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return pids;
}

/**
 * Poll until every PID is gone or the budget runs out. Never blocks the event
 * loop with a synchronous wait.
 *
 * @param {Set<number>} pids
 * @param {{ isProcessAlive: (pid: number) => boolean }} probes
 * @param {(ms: number) => Promise<void>} sleep
 * @param {number} waitMs
 * @returns {Promise<number[]>} PIDs still alive
 */
async function waitForOpenCodeExit(pids, probes, sleep, waitMs) {
  const deadline = Date.now() + Math.max(0, waitMs);
  for (;;) {
    const alive = [...pids].filter((pid) => probes.isProcessAlive(pid));
    if (alive.length === 0) return [];
    const remaining = deadline - Date.now();
    if (remaining <= 0) return alive;
    await sleep(Math.min(50, remaining));
  }
}

/**
 * Second phase of process shutdown: wait a bounded time for the phase-1
 * SIGTERMs, escalate the survivors to SIGKILL, confirm exit and persist the
 * result by dropping the registry entries of processes that are really gone.
 *
 * Safe to call without phase 1, but the intended order is
 * `beginOpenCodeShutdown()` then this.
 *
 * @param {{
 *   graceMs?: number,
 *   killWaitMs?: number,
 *   probes?: Partial<import('./opencode-port-registry.js').OpenCodeProcessProbes>,
 *   sleep?: (ms: number) => Promise<void>,
 * }} [options]
 * @returns {Promise<{
 *   ok: boolean,
 *   timedOut: boolean,
 *   total: number,
 *   escalated: number,
 *   remaining: number[],
 *   pendingCreates: number,
 * }>}
 */
export async function finishOpenCodeShutdown(options = {}) {
  const probes = createOpenCodeProcessProbes(options.probes || {});
  const graceMs = Number.isFinite(options.graceMs) && Number(options.graceMs) >= 0
    ? Number(options.graceMs)
    : SHUTDOWN_SIGTERM_GRACE_MS;
  const killWaitMs = Number.isFinite(options.killWaitMs) && Number(options.killWaitMs) >= 0
    ? Number(options.killWaitMs)
    : SHUTDOWN_SIGKILL_WAIT_MS;
  const sleep = typeof options.sleep === 'function' ? options.sleep : sleepMs;
  // In-flight creates were gated and close the child they spawned; let them
  // settle (bounded) before collecting the final PID set.
  const pendingCount = pendingCreates.size;
  if (pendingCount > 0) {
    await Promise.race([
      Promise.allSettled([...pendingCreates.values()]),
      sleep(graceMs),
    ]);
  }
  const targets = collectShutdownPids();
  for (const pid of targets) {
    if (probes.isProcessAlive(pid)) probes.killProcessTree(pid, 'SIGTERM');
  }
  await waitForOpenCodeExit(targets, probes, sleep, graceMs);
  /**
   * @returns {number}
   */
  const escalate = () => {
    let killed = 0;
    for (const pid of targets) {
      if (!probes.isProcessAlive(pid)) continue;
      probes.killProcessTree(pid, 'SIGKILL');
      killed += 1;
    }
    return killed;
  };
  let escalated = escalate();
  // Re-collect once: a create that passed the phase-1 gate can spawn while we
  // waited, and its `onSpawn` hook already SIGTERMed it.
  for (const pid of collectShutdownPids()) targets.add(pid);
  escalated += escalate();
  const remaining = await waitForOpenCodeExit(targets, probes, sleep, killWaitMs);
  for (const [key, entry] of [...instances.entries()]) {
    if (entry._idleTimer) clearTimeout(entry._idleTimer);
    // A process that survived SIGKILL keeps its registry entry, so the next
    // startup sweep retries it instead of leaking the port.
    if (!probes.isProcessAlive(openCodePidOf(entry))) forgetOpenCodePort(key, entry.port);
    instances.delete(key);
  }
  for (const pid of [...shutdownPendingPids.keys()]) {
    if (!probes.isProcessAlive(pid)) shutdownPendingPids.delete(pid);
  }
  return {
    ok: remaining.length === 0,
    timedOut: remaining.length > 0,
    total: targets.size,
    escalated,
    remaining,
    pendingCreates: pendingCount,
  };
}

/**
 * @param {string} workspaceFolder
 * @returns {{ running: boolean, refCount: number, port?: number, lastUsedAt?: number } | null}
 */
export function getOpenCodeInstanceDiag(workspaceFolder, sessionKey = '') {
  const entry = instances.get(opencodeInstanceKey({
    workspaceFolder: String(workspaceFolder || '').trim(),
    sessionKey,
  }));
  if (!entry) return null;
  return {
    running: true,
    refCount: entry.refCount,
    port: entry.port,
    lastUsedAt: Number.isFinite(entry._lastUsedAt) ? entry._lastUsedAt : undefined,
  };
}

/**
 * Live/pending instance counts plus the active opt-in cap, for the server
 * diagnostics endpoint. `limit` is 0 when no cap is configured.
 *
 * @returns {{ live: number, pending: number, limit: number }}
 */
export function getOpenCodeInstanceStats() {
  return {
    live: instances.size,
    pending: pendingCreates.size,
    limit: resolveOpenCodeMaxInstances(),
  };
}
