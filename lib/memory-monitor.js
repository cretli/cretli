/**
 * Read-only memory and orphan monitor library.
 *
 * This is a safety net, not the primary protection: it NEVER signals or kills a
 * process, and it never needs a live Cretli server. A machine-level timer
 * (systemd or cron) runs `scripts/memory-orphan-monitor.js` about once a minute.
 * The script appends alarms to a daily JSONL file under `data/` and keeps a
 * small state file so one alert per episode is written.
 *
 * The server reads the same JSONL at startup (`memory-monitor-producer.js`) and
 * publishes those alarms into the in-app notification centre, so an alarm
 * written while the server was dead is visible after the next start.
 *
 * Everything the real machine touches is injectable (`createMemoryMonitorProbes`),
 * so tests run entirely on `ps` / `/proc/meminfo` / journal fixtures.
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { writeJsonAtomic } from './persist/atomic-write.js';
import { getProcessStartTime, isProcessAlive } from './delegation-owner-lock.js';
import { createOpenCodeProcessProbes, isRegistryOwnerAlive, normalizeOpenCodePortOwner, readOpenCodePortRegistryRaw } from './opencode/opencode-port-registry.js';
import { resolveDataPath } from './runtime-paths.js';

export const MEMORY_MONITOR_SCHEMA_VERSION = 1;
export const MEMORY_MONITOR_ALERT_PREFIX = 'memory-monitor-alerts-';
export const MEMORY_MONITOR_STATE_FILE = 'memory-monitor-state.json';
const MEMORY_MONITOR_RETENTION_DAYS = 14;
const MAX_DAILY_ALERT_BYTES = 4 * 1024 * 1024;
const MAX_ARGS_LENGTH = 200;

/**
 * Defaults tuned for a 24 GiB RAM + 8 GiB swap host, NOT universal values.
 * earlyoom kills node around the 10% MemAvailable mark (~2.4 GiB here), so the
 * critical alarm must fire well before that, and the swap condition is "used
 * over half / grew fast" rather than "little swap free" (earlyoom's 90% swap
 * threshold is satisfied almost always on this machine).
 *
 * @typedef {{
 *   memoryCriticalBytes: number,
 *   memoryWarnBytes: number,
 *   swapUsedRatio: number,
 *   swapGrowthBytes: number,
 *   swapGrowthWindowMs: number,
 *   maxOpenCodeProcesses: number,
 *   alertRepeatMs: number,
 *   topProcessCount: number,
 *   journalUnit: string,
 * }} MemoryMonitorConfig
 */

/** @type {Readonly<MemoryMonitorConfig>} */
export const DEFAULT_MEMORY_MONITOR_CONFIG = Object.freeze({
  memoryCriticalBytes: 4 * 1024 ** 3,
  memoryWarnBytes: 6 * 1024 ** 3,
  swapUsedRatio: 0.5,
  swapGrowthBytes: 1024 ** 3,
  swapGrowthWindowMs: 10 * 60 * 1000,
  maxOpenCodeProcesses: 10,
  alertRepeatMs: 30 * 60 * 1000,
  topProcessCount: 10,
  journalUnit: 'earlyoom',
});

/**
 * Read a numeric env override with a unit scale. Empty/invalid values fall back
 * to the default so a typo never disables the alarm silently.
 *
 * @param {Record<string, string | undefined>} env
 * @param {string} key
 * @param {number} fallback
 * @param {{ min?: number, scale?: number }} [options]
 * @returns {number}
 */
function readNumberEnv(env, key, fallback, options = {}) {
  const raw = env?.[key];
  if (raw == null || String(raw).trim() === '') return fallback;
  const parsed = Number(String(raw).trim());
  const min = Number.isFinite(options.min) ? options.min : 0;
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return parsed * (options.scale ?? 1);
}

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {MemoryMonitorConfig}
 */
export function resolveMemoryMonitorConfig(env = process.env) {
  return {
    memoryCriticalBytes: readNumberEnv(env, 'CRETLI_MEMORY_MONITOR_MEM_CRITICAL_MB', DEFAULT_MEMORY_MONITOR_CONFIG.memoryCriticalBytes, { min: 1, scale: 1024 ** 2 }),
    memoryWarnBytes: readNumberEnv(env, 'CRETLI_MEMORY_MONITOR_MEM_WARN_MB', DEFAULT_MEMORY_MONITOR_CONFIG.memoryWarnBytes, { min: 1, scale: 1024 ** 2 }),
    swapUsedRatio: readNumberEnv(env, 'CRETLI_MEMORY_MONITOR_SWAP_USED_RATIO', DEFAULT_MEMORY_MONITOR_CONFIG.swapUsedRatio, { min: 0 }),
    swapGrowthBytes: readNumberEnv(env, 'CRETLI_MEMORY_MONITOR_SWAP_GROWTH_MB', DEFAULT_MEMORY_MONITOR_CONFIG.swapGrowthBytes, { min: 0, scale: 1024 ** 2 }),
    swapGrowthWindowMs: readNumberEnv(env, 'CRETLI_MEMORY_MONITOR_SWAP_GROWTH_WINDOW_MS', DEFAULT_MEMORY_MONITOR_CONFIG.swapGrowthWindowMs, { min: 0 }),
    maxOpenCodeProcesses: readNumberEnv(env, 'CRETLI_MEMORY_MONITOR_MAX_OPENCODE', DEFAULT_MEMORY_MONITOR_CONFIG.maxOpenCodeProcesses, { min: 1 }),
    alertRepeatMs: readNumberEnv(env, 'CRETLI_MEMORY_MONITOR_ALERT_REPEAT_MS', DEFAULT_MEMORY_MONITOR_CONFIG.alertRepeatMs, { min: 0 }),
    topProcessCount: readNumberEnv(env, 'CRETLI_MEMORY_MONITOR_TOP_PROCESSES', DEFAULT_MEMORY_MONITOR_CONFIG.topProcessCount, { min: 1 }),
    journalUnit: String(env?.CRETLI_MEMORY_MONITOR_JOURNAL_UNIT || DEFAULT_MEMORY_MONITOR_CONFIG.journalUnit).trim() || DEFAULT_MEMORY_MONITOR_CONFIG.journalUnit,
  };
}

/**
 * @param {string} text `/proc/meminfo` contents
 * @returns {{ totalBytes: number | null, availableBytes: number | null, swapTotalBytes: number | null, swapFreeBytes: number | null }}
 */
export function parseMeminfo(text) {
  const values = new Map();
  for (const match of String(text || '').matchAll(/^(MemTotal|MemAvailable|SwapTotal|SwapFree):\s+(\d+)\s+kB$/gm)) {
    values.set(match[1], Number(match[2]) * 1024);
  }
  return {
    totalBytes: values.has('MemTotal') ? values.get('MemTotal') : null,
    availableBytes: values.has('MemAvailable') ? values.get('MemAvailable') : null,
    swapTotalBytes: values.has('SwapTotal') ? values.get('SwapTotal') : null,
    swapFreeBytes: values.has('SwapFree') ? values.get('SwapFree') : null,
  };
}

const PS_LINE_PATTERN = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/;

/**
 * Parse `ps -eo pid=,ppid=,rss=,args=` output. `rss` is in KiB. Start times are
 * supplied separately (real probes read `/proc/<pid>`, tests inject them)
 * because `ps` cannot express the Linux starttime jiffies used by the ownership
 * registry.
 *
 * @param {string} text
 * @param {{ startTimes?: Record<number, string> }} [options]
 * @returns {Array<{ pid: number, ppid: number, rssBytes: number, args: string, startTime: string }>}
 */
export function parsePsOutput(text, options = {}) {
  const startTimes = options.startTimes || {};
  const processes = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    const match = PS_LINE_PATTERN.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    processes.push({
      pid,
      ppid: Number(match[2]) || 0,
      rssBytes: (Number(match[3]) || 0) * 1024,
      args: match[4].trim(),
      startTime: String(startTimes[pid] ?? ''),
    });
  }
  return processes;
}

/**
 * @param {string} args
 * @returns {boolean} true for an `opencode ... serve ...` cmdline
 */
export function isOpenCodeServeProcess(args) {
  const text = String(args || '');
  if (!text.includes('opencode')) return false;
  return /(^|\s)serve(\s|$)/.test(text);
}

/**
 * @param {string} args
 * @returns {number} the `--port=` value, or 0
 */
export function readOpenCodeServePort(args) {
  const match = /(^|\s)--port=(\d+)(\s|$)/.exec(String(args || ''));
  return match ? Number(match[2]) : 0;
}

/**
 * @param {string} args
 * @returns {string} the `--config` path of a `webpack-cli-watch.mjs` process
 */
export function readWebpackConfigPath(args) {
  const text = String(args || '');
  if (!text.includes('webpack-cli-watch.mjs')) return '';
  const equals = /--config=(\S+)/.exec(text);
  if (equals) return equals[1];
  const spaced = /--config\s+(\S+)/.exec(text);
  return spaced ? spaced[1] : '';
}

/**
 * @param {string} args
 * @returns {string} the `webpack-cli-watch.mjs` script path from argv, or ''
 */
export function readWebpackScriptPath(args) {
  const text = String(args || '');
  const match = /(?:^|\s)(\S*webpack-cli-watch\.mjs)(?=\s|$)/.exec(text);
  return match ? match[1] : '';
}

/**
 * Directory a relative `--config` is resolved against, derived from the watcher
 * script path in argv. `app_front/package.json` runs
 * `node scripts/webpack-cli-watch.mjs --config webpack.dev.js` from the
 * `<project>/app_front` package directory, so the script path
 * `<project>/app_front/scripts/webpack-cli-watch.mjs` yields
 * `<project>/app_front`. Returns '' when argv carries no usable directory, so
 * the caller can fall back to the process CWD.
 *
 * @param {string} args
 * @returns {string}
 */
export function resolveWebpackConfigBaseDir(args) {
  const scriptPath = readWebpackScriptPath(args);
  if (!scriptPath) return '';
  const scriptDir = path.dirname(scriptPath);
  if (!scriptDir || scriptDir === '.' || scriptDir === path.sep) return '';
  return path.dirname(scriptDir);
}

/**
 * Resolve a watcher's `--config` value to the path the process itself would
 * use. A bare `--config webpack.dev.js` is relative to the watcher process,
 * never to the monitor: first `/proc/<pid>/cwd`, then the script path in argv,
 * then the monitor CWD as a last resort. Resolving it against the monitor CWD
 * (the old behaviour) collapsed watchers from different checkouts into one
 * group and raised a false "Duplicate webpack watchers" alarm.
 *
 * @param {{ pid: number, args: string }} row
 * @param {{ readProcessCwd?: (pid: number) => string }} [options]
 * @returns {string}
 */
export function resolveWebpackConfigInput(row, options = {}) {
  const configPath = readWebpackConfigPath(row?.args);
  if (!configPath) return '';
  if (path.isAbsolute(configPath)) return configPath;
  const readCwd = typeof options.readProcessCwd === 'function' ? options.readProcessCwd : readProcessCwdFromProc;
  let cwd = '';
  try {
    cwd = String(readCwd(row?.pid) || '').trim();
  } catch {
    cwd = '';
  }
  if (cwd) return path.join(cwd, configPath);
  const scriptBase = resolveWebpackConfigBaseDir(row?.args);
  if (scriptBase) return path.join(scriptBase, configPath);
  return path.resolve(configPath);
}

/**
 * Project root used to group watchers by realpath. A config under
 * `<root>/app_front/…` groups on `<root>`; otherwise the config directory is
 * the group. Callers pass an already-resolved config path, so two different
 * checkouts never collapse into one group.
 *
 * @param {string} configPath
 * @returns {string}
 */
export function resolveProjectRootFromConfigPath(configPath) {
  const normalized = String(configPath || '');
  const marker = `${path.sep}app_front${path.sep}`;
  const index = normalized.lastIndexOf(marker);
  if (index > 0) return normalized.slice(0, index);
  return path.dirname(normalized);
}

/**
 * Resolve a process CWD through `/proc/<pid>/cwd`. Returns '' when the PID is
 * gone, foreign, or the platform has no `/proc`. Tests inject this probe.
 *
 * @param {number} pid
 * @returns {string}
 */
function readProcessCwdFromProc(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return '';
  try {
    return realpathSync(`/proc/${pid}/cwd`);
  } catch {
    return '';
  }
}

/**
 * @param {Array<{ pid: number, ppid: number, rssBytes: number, args: string, startTime: string }>} processes
 * @param {number} limit
 * @returns {Array<{ pid: number, ppid: number, rssBytes: number, startTime: string, args: string }>}
 */
export function buildTopProcesses(processes, limit) {
  return [...(Array.isArray(processes) ? processes : [])]
    .sort((left, right) => (right.rssBytes || 0) - (left.rssBytes || 0))
    .slice(0, Math.max(1, limit))
    .map((row) => ({
      pid: row.pid,
      ppid: row.ppid,
      rssBytes: row.rssBytes || 0,
      startTime: String(row.startTime || ''),
      args: String(row.args || '').slice(0, MAX_ARGS_LENGTH),
    }));
}

/**
 * Registry entries grouped by whether their owner server (PID + start time) is
 * alive. Orphans are entries whose owner is dead while the recorded OpenCode
 * process still runs. Parent PID is never the criterion: on WSL an orphan is
 * re-parented to Relay/init with an unrelated PID.
 *
 * @param {{
 *   registry: Record<string, unknown>,
 *   processes: Array<{ pid: number, ppid: number, rssBytes: number, args: string, startTime: string }>,
 *   probes: { isProcessAlive: (pid: number) => boolean, getProcessStartTime: (pid: number) => string },
 * }} input
 * @returns {{
 *   managedPids: Set<number>,
 *   orphaned: Array<{ port: number, entry: object, process: object, ppid: number }>,
 *   stale: Array<{ port: number, reason: string, pid: number }>,
 * }}
 */
export function classifyManagedOpenCode(input) {
  const byPid = new Map((Array.isArray(input.processes) ? input.processes : []).map((row) => [row.pid, row]));
  const managedPids = new Set();
  const orphaned = [];
  const stale = [];
  const self = { pid: 0, startedAt: '', instanceToken: '' };
  for (const [rawPort, rawOwner] of Object.entries(input.registry || {})) {
    const port = Number.parseInt(rawPort, 10);
    if (!Number.isInteger(port) || port <= 0) continue;
    const entry = normalizeOpenCodePortOwner(rawOwner);
    if (!entry) continue;
    const ownerAlive = isRegistryOwnerAlive(entry, self, input.probes);
    const live = entry.opencodePid > 0 ? byPid.get(entry.opencodePid) : null;
    const startMatches = Boolean(live) && (!entry.opencodeStartedAt || live.startTime === entry.opencodeStartedAt);
    if (ownerAlive) {
      if (live && startMatches) managedPids.add(entry.opencodePid);
      continue;
    }
    // Legacy entry (no owner PID): the old format records only the instance key,
    // so fall back to the process actually listening on that port. It is managed
    // but can never be called an orphan from owner identity.
    if (entry.opencodePid <= 0) {
      const listenerPid = readListeningPid(input.probes, port);
      const listener = byPid.get(listenerPid);
      if (listener && isOpenCodeServeProcess(listener.args)) {
        managedPids.add(listenerPid);
        continue;
      }
      stale.push({ port, pid: 0, reason: 'legacy-entry-without-live-listener' });
      continue;
    }
    if (live && startMatches && isOpenCodeServeProcess(live.args)) {
      managedPids.add(entry.opencodePid);
      orphaned.push({ port, entry, process: live, ppid: live.ppid });
      continue;
    }
    stale.push({
      port,
      pid: entry.opencodePid,
      reason: !live ? 'process-dead' : (startMatches ? 'cmdline-mismatch' : 'start-time-mismatch'),
    });
  }
  return { managedPids, orphaned, stale };
}

/**
 * @param {{ findListeningPid?: (port: number) => number }} probes
 * @param {number} port
 * @returns {number}
 */
function readListeningPid(probes, port) {
  if (typeof probes?.findListeningPid !== 'function') return 0;
  try {
    return Number(probes.findListeningPid(port)) || 0;
  } catch {
    return 0;
  }
}

/**
 * Groups live `webpack-cli-watch.mjs` processes by resolved project + config
 * realpath and returns every group with more than one watcher. A relative
 * `--config` is resolved against the owning process (`/proc/<pid>/cwd`, then the
 * watcher script path in argv), so two different checkouts never collapse into
 * one group while the same checkout + config still groups.
 *
 * @param {Array<{ pid: number, args: string, rssBytes: number, startTime: string }>} processes
 * @param {{ realpath?: (value: string) => string, readProcessCwd?: (pid: number) => string }} [options]
 * @returns {Array<{ projectRootRealpath: string, configRealpath: string, processes: object[] }>}
 */
export function findDuplicateWebpackWatchers(processes, options = {}) {
  const realpath = options.realpath || ((value) => {
    try {
      return realpathSync(value);
    } catch {
      return path.resolve(value);
    }
  });
  const groups = new Map();
  for (const row of Array.isArray(processes) ? processes : []) {
    const configPath = readWebpackConfigPath(row.args);
    if (!configPath) continue;
    const configRealpath = realpath(resolveWebpackConfigInput(row, options));
    const projectRootRealpath = resolveProjectRootFromConfigPath(configRealpath);
    const key = `${projectRootRealpath}\u0000${configRealpath}`;
    if (!groups.has(key)) {
      groups.set(key, { projectRootRealpath, configRealpath, processes: [] });
    }
    groups.get(key).processes.push(row);
  }
  return [...groups.values()].filter((group) => group.processes.length > 1);
}

const EARLYOOM_EVENT_PATTERN = /sending SIGTERM|sending SIGKILL|escalating to SIGKILL/i;
const JOURNAL_CURSOR_PATTERN = /^--\s*cursor:\s*(.+)$/;
const SHORT_ISO_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[+-]\d{2}:?\d{2}|Z)?)/;

/**
 * Bounded fingerprint base for one journal kill line. The raw message can be up
 * to 500 characters, and `notification-store` rejects any fingerprint longer
 * than 512, so the message is hashed instead of embedded; the full text stays in
 * `details`. Without this an earlyoom alarm silently never reached the store and
 * was retried every minute.
 *
 * @param {string} timestamp
 * @param {string} message
 * @returns {string}
 */
function buildEarlyoomFingerprintBase(timestamp, message) {
  const digest = createHash('sha256').update(String(message)).digest('hex');
  const stamp = String(timestamp || '').slice(0, 64);
  return `memory-monitor:earlyoom-kill:${stamp}:${digest}`;
}

/**
 * Parse `journalctl --show-cursor -o short-iso` output, keeping only earlyoom
 * kill events and the trailing journald cursor.
 *
 * @param {string} text
 * @returns {{ available: boolean, cursor: string, entries: Array<{ timestamp: string, message: string }>, warning: string }}
 */
export function parseEarlyoomJournal(text) {
  let cursor = '';
  const entries = [];
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const cursorMatch = JOURNAL_CURSOR_PATTERN.exec(line);
    if (cursorMatch) {
      cursor = cursorMatch[1].trim();
      continue;
    }
    if (!EARLYOOM_EVENT_PATTERN.test(line)) continue;
    const timestampMatch = SHORT_ISO_PATTERN.exec(line);
    entries.push({ timestamp: timestampMatch ? timestampMatch[1] : '', message: line });
  }
  return { available: true, cursor, entries, warning: '' };
}

/**
 * Whether a swap usage looks alarming: used above the ratio, or a fast rise
 * inside the growth window compared with the previous run.
 *
 * @param {{
 *   host: { swapTotalBytes: number | null, swapFreeBytes: number | null },
 *   previousState: { lastSwapUsedBytes?: unknown, lastSwapAt?: unknown },
 *   config: MemoryMonitorConfig,
 *   now: number,
 * }} input
 * @returns {{ usedBytes: number, totalBytes: number, ratio: number, grewFast: boolean, previousUsedBytes: number | null } | null}
 */
export function evaluateSwapPressure(input) {
  const total = input.host?.swapTotalBytes;
  if (!Number.isFinite(total) || total <= 0) return null;
  const free = Number.isFinite(input.host?.swapFreeBytes) ? input.host.swapFreeBytes : 0;
  const usedBytes = Math.max(0, total - free);
  const ratio = usedBytes / total;
  const previousUsedBytes = Number(input.previousState?.lastSwapUsedBytes);
  const previousAt = Date.parse(String(input.previousState?.lastSwapAt || ''));
  const elapsed = input.now - previousAt;
  const grewFast = Number.isFinite(previousUsedBytes) && Number.isFinite(previousAt)
    && elapsed >= 0 && elapsed <= input.config.swapGrowthWindowMs
    && usedBytes - previousUsedBytes >= input.config.swapGrowthBytes;
  if (ratio >= input.config.swapUsedRatio || grewFast) {
    return {
      usedBytes,
      totalBytes: total,
      ratio,
      grewFast,
      previousUsedBytes: Number.isFinite(previousUsedBytes) ? previousUsedBytes : null,
    };
  }
  return null;
}

/**
 * @param {number | null | undefined} bytes
 * @returns {string}
 */
function formatMiB(bytes) {
  if (!Number.isFinite(bytes)) return 'n/a';
  return `${Math.round(Number(bytes) / 1024 ** 2)} MiB`;
}

/**
 * Pure evaluation on an already-collected snapshot. Produces threshold alerts
 * (`episodeAlerts`, deduplicated by episode) and discrete journal alerts
 * (`eventAlerts`, one per new earlyoom event).
 *
 * @param {{
 *   now: number,
 *   config: MemoryMonitorConfig,
 *   host: { totalBytes?: number | null, availableBytes?: number | null, swapTotalBytes?: number | null, swapFreeBytes?: number | null },
 *   processes?: object[],
 *   registry?: Record<string, unknown>,
 *   previousState?: object,
 *   earlyoom?: { available?: boolean, warning?: string, cursor?: string, entries?: Array<{ timestamp: string, message: string }> },
 *   probes?: { isProcessAlive: (pid: number) => boolean, getProcessStartTime: (pid: number) => string },
 * }} input
 * @returns {object}
 */
export function evaluateMemoryMonitor(input) {
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const config = { ...DEFAULT_MEMORY_MONITOR_CONFIG, ...(input.config || {}) };
  const host = input.host || {};
  const processes = Array.isArray(input.processes) ? input.processes : [];
  const probes = input.probes || { isProcessAlive, getProcessStartTime };
  const previousState = input.previousState || {};
  const warnings = [];
  /** @type {Array<object>} */
  const episodeAlerts = [];
  /** @type {Array<object>} */
  const eventAlerts = [];
  const triggered = new Set();

  // --- Memory: one severity, never both warning and critical -----------------
  if (Number.isFinite(host.availableBytes)) {
    if (host.availableBytes < config.memoryCriticalBytes) triggered.add('memory-critical');
    else if (host.availableBytes < config.memoryWarnBytes) triggered.add('memory-warning');
  }

  // --- Swap ------------------------------------------------------------------
  const swap = evaluateSwapPressure({ host, previousState, config, now });
  if (swap) triggered.add('swap-pressure');

  // --- Managed / orphaned / foreign OpenCode ---------------------------------
  const { managedPids, orphaned, stale } = classifyManagedOpenCode({
    registry: input.registry || {},
    processes,
    probes,
  });
  const opencodeProcesses = processes.filter((row) => isOpenCodeServeProcess(row.args));
  const managedProcesses = opencodeProcesses.filter((row) => managedPids.has(row.pid));
  const foreignProcesses = opencodeProcesses.filter((row) => !managedPids.has(row.pid));
  if (orphaned.length > 0) triggered.add('opencode-orphan');
  if (opencodeProcesses.length > config.maxOpenCodeProcesses) triggered.add('opencode-count-high');

  // --- Duplicate webpack watchers (grouped by project + config realpath) ------
  const duplicateWatchers = findDuplicateWebpackWatchers(processes);
  if (duplicateWatchers.length > 0) triggered.add('webpack-watch-duplicate');

  // Computed once and shared by every alert, including discrete earlyoom events.
  const topProcesses = buildTopProcesses(processes, config.topProcessCount);

  // --- Earlyoom journal ------------------------------------------------------
  if (input.earlyoom && input.earlyoom.available === false) {
    warnings.push(String(input.earlyoom.warning || 'earlyoom journal is unavailable; that condition is skipped.'));
  } else if (input.earlyoom?.available) {
    if (input.earlyoom.warning) warnings.push(String(input.earlyoom.warning));
    const entries = Array.isArray(input.earlyoom.entries) ? input.earlyoom.entries : [];
    for (const entry of entries) {
      const message = String(entry?.message || '').slice(0, 500);
      if (!message) continue;
      const timestamp = String(entry?.timestamp || '');
      const fingerprintBase = buildEarlyoomFingerprintBase(timestamp, message);
      eventAlerts.push({
        type: 'earlyoom-kill',
        severity: 'error',
        title: 'earlyoom killed a process',
        message,
        fingerprintBase,
        fingerprint: fingerprintBase,
        details: { timestamp, source: 'journal', unit: config.journalUnit, topProcesses },
      });
    }
  }

  if (triggered.has('memory-critical')) {
    episodeAlerts.push({
      type: 'memory-critical',
      severity: 'error',
      title: 'Available memory below the critical threshold',
      message: `MemAvailable is ${formatMiB(host.availableBytes)}, below the critical threshold ${formatMiB(config.memoryCriticalBytes)}.`,
      fingerprintBase: 'memory-monitor:memory-critical',
      details: { availableBytes: host.availableBytes, thresholdBytes: config.memoryCriticalBytes, swap, topProcesses },
    });
  } else if (triggered.has('memory-warning')) {
    episodeAlerts.push({
      type: 'memory-warning',
      severity: 'warning',
      title: 'Available memory below the warning threshold',
      message: `MemAvailable is ${formatMiB(host.availableBytes)}, below the warning threshold ${formatMiB(config.memoryWarnBytes)}.`,
      fingerprintBase: 'memory-monitor:memory-warning',
      details: { availableBytes: host.availableBytes, thresholdBytes: config.memoryWarnBytes, swap, topProcesses },
    });
  }
  if (triggered.has('swap-pressure') && swap) {
    episodeAlerts.push({
      type: 'swap-pressure',
      severity: 'warning',
      title: 'Swap pressure',
      message: swap.grewFast
        ? `Swap usage rose to ${formatMiB(swap.usedBytes)} of ${formatMiB(swap.totalBytes)} (fast growth).`
        : `Swap usage is ${formatMiB(swap.usedBytes)} of ${formatMiB(swap.totalBytes)} (${Math.round(swap.ratio * 100)}%).`,
      fingerprintBase: 'memory-monitor:swap-pressure',
      details: { ...swap, topProcesses },
    });
  }
  if (orphaned.length > 0) {
    episodeAlerts.push({
      type: 'opencode-orphan',
      severity: 'warning',
      title: 'Orphaned OpenCode process',
      message: `${orphaned.length} OpenCode serve process(es) belong to a dead Cretli server (owner PID + start time no longer live).`,
      fingerprintBase: 'memory-monitor:opencode-orphan',
      details: {
        orphaned: orphaned.map((row) => ({
          port: row.port,
          pid: row.process.pid,
          ppid: row.ppid,
          serverPid: row.entry.serverPid,
          serverStartedAt: row.entry.serverStartedAt,
          port_owner: row.entry.instanceKey,
        })),
        stale,
        topProcesses,
      },
    });
  }
  if (triggered.has('opencode-count-high')) {
    episodeAlerts.push({
      type: 'opencode-count-high',
      severity: 'warning',
      title: 'High OpenCode serve process count',
      message: `${opencodeProcesses.length} opencode serve processes are running (threshold > ${config.maxOpenCodeProcesses}); one instance per chat is normal.`,
      fingerprintBase: 'memory-monitor:opencode-count-high',
      details: { count: opencodeProcesses.length, threshold: config.maxOpenCodeProcesses, topProcesses },
    });
  }
  if (duplicateWatchers.length > 0) {
    episodeAlerts.push({
      type: 'webpack-watch-duplicate',
      severity: 'warning',
      title: 'Duplicate webpack watchers for the same config',
      message: duplicateWatchers.map((group) => `${group.processes.length}x ${group.configRealpath}`).join('; '),
      fingerprintBase: 'memory-monitor:webpack-watch-duplicate',
      details: {
        groups: duplicateWatchers.map((group) => ({
          projectRootRealpath: group.projectRootRealpath,
          configRealpath: group.configRealpath,
          pids: group.processes.map((row) => row.pid),
        })),
        topProcesses,
      },
    });
  }

  return {
    at: new Date(now).toISOString(),
    host: {
      totalBytes: Number.isFinite(host.totalBytes) ? host.totalBytes : null,
      availableBytes: Number.isFinite(host.availableBytes) ? host.availableBytes : null,
      swapTotalBytes: Number.isFinite(host.swapTotalBytes) ? host.swapTotalBytes : null,
      swapFreeBytes: Number.isFinite(host.swapFreeBytes) ? host.swapFreeBytes : null,
    },
    swap,
    topProcesses,
    managed: {
      count: managedProcesses.length,
      processes: managedProcesses.map((row) => ({ pid: row.pid, ppid: row.ppid })),
      pids: [...managedPids],
    },
    orphaned: orphaned.map((row) => ({ port: row.port, pid: row.process.pid, ppid: row.ppid })),
    stale,
    foreign: foreignProcesses.map((row) => ({ pid: row.pid, ppid: row.ppid, port: readOpenCodeServePort(row.args) })),
    opencodeTotal: opencodeProcesses.length,
    duplicateWatchers,
    earlyoom: input.earlyoom
      ? { available: input.earlyoom.available !== false, cursor: String(input.earlyoom.cursor || ''), eventCount: eventAlerts.length }
      : { available: false, cursor: '', eventCount: 0 },
    warnings,
    triggered: [...triggered],
    thresholdExceeded: triggered.size > 0 || eventAlerts.length > 0,
    episodeAlerts,
    eventAlerts,
  };
}

/**
 * One alarm per episode: emit on the first breach, then only after the metric
 * recovered below the threshold or `repeatMs` passed. Recovery clears `active`
 * so the next breach starts a new episode (and a new fingerprint).
 *
 * @param {{
 *   alerts: Array<{ type: string, fingerprintBase?: string }>,
 *   previousEpisodes?: Record<string, { active?: boolean, episode?: number, firstSeenAt?: string, lastEmittedAt?: string }>,
 *   nowMs: number,
 *   repeatMs: number,
 * }} input
 * @returns {{ emitted: object[], episodes: Record<string, object>, recovered: object[] }}
 */
export function applyAlertEpisodes(input) {
  const episodes = { ...(input.previousEpisodes || {}) };
  const emitted = [];
  const recovered = [];
  const triggeredTypes = new Set();
  for (const alert of input.alerts || []) {
    triggeredTypes.add(alert.type);
    const previous = episodes[alert.type];
    const lastEmittedMs = previous ? Date.parse(String(previous.lastEmittedAt || '')) : NaN;
    const active = Boolean(previous?.active);
    const shouldEmit = !active || !Number.isFinite(lastEmittedMs) || input.nowMs - lastEmittedMs >= input.repeatMs;
    if (!shouldEmit) continue;
    const episode = (Number(previous?.episode) || 0) + 1;
    const base = String(alert.fingerprintBase || `memory-monitor:${alert.type}`);
    emitted.push({ ...alert, fingerprint: `${base}#episode:${episode}` });
    episodes[alert.type] = {
      active: true,
      episode,
      firstSeenAt: active && previous?.firstSeenAt ? String(previous.firstSeenAt) : new Date(input.nowMs).toISOString(),
      lastEmittedAt: new Date(input.nowMs).toISOString(),
    };
  }
  for (const [type, episode] of Object.entries(episodes)) {
    if (triggeredTypes.has(type) || !episode?.active) continue;
    recovered.push({ type, firstSeenAt: String(episode.firstSeenAt || ''), recoveredAt: new Date(input.nowMs).toISOString() });
    episodes[type] = { ...episode, active: false };
  }
  return { emitted, episodes, recovered };
}

/**
 * @param {number} at
 * @returns {string}
 */
export function getMemoryMonitorAlertPath(dataDir, at) {
  const date = new Date(at).toISOString().slice(0, 10);
  return path.join(dataDir, `${MEMORY_MONITOR_ALERT_PREFIX}${date}.jsonl`);
}

/**
 * @param {string} dataDir
 * @returns {string}
 */
export function getMemoryMonitorStatePath(dataDir) {
  return path.join(dataDir, MEMORY_MONITOR_STATE_FILE);
}

/**
 * @param {string} dataDir
 * @returns {object}
 */
export function readMemoryMonitorState(dataDir) {
  const filePath = getMemoryMonitorStatePath(dataDir);
  if (!existsSync(filePath)) return { version: MEMORY_MONITOR_SCHEMA_VERSION, episodes: {} };
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { version: MEMORY_MONITOR_SCHEMA_VERSION, episodes: {} };
    }
    return {
      ...parsed,
      version: MEMORY_MONITOR_SCHEMA_VERSION,
      episodes: parsed.episodes && typeof parsed.episodes === 'object' ? parsed.episodes : {},
    };
  } catch {
    return { version: MEMORY_MONITOR_SCHEMA_VERSION, episodes: {} };
  }
}

/**
 * @param {string} dataDir
 * @param {object} state
 * @returns {string}
 */
export function writeMemoryMonitorState(dataDir, state) {
  mkdirSync(dataDir, { recursive: true });
  const filePath = getMemoryMonitorStatePath(dataDir);
  writeJsonAtomic(filePath, state);
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // A permissions failure must not abort the monitor run.
  }
  return filePath;
}

/**
 * Append JSONL records to today's alert file. A full daily file is skipped
 * rather than unbounded; the monitor keeps running (state still advances).
 *
 * @param {string} dataDir
 * @param {object[]} records
 * @param {{ now?: number }} [options]
 * @returns {{ written: number, skipped: number, filePath: string }}
 */
export function appendMemoryMonitorRecords(dataDir, records, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const filePath = getMemoryMonitorAlertPath(dataDir, now);
  mkdirSync(dataDir, { recursive: true });
  let written = 0;
  let skipped = 0;
  for (const record of records) {
    const line = `${JSON.stringify(record)}\n`;
    const isNewFile = !existsSync(filePath);
    let currentSize = 0;
    try {
      currentSize = isNewFile ? 0 : statSync(filePath).size;
    } catch {
      currentSize = 0;
    }
    if (currentSize + Buffer.byteLength(line) > MAX_DAILY_ALERT_BYTES) {
      skipped += 1;
      continue;
    }
    appendFileSync(filePath, line, { encoding: 'utf8', mode: 0o600 });
    if (isNewFile) chmodSync(filePath, 0o600);
    written += 1;
  }
  return { written, skipped, filePath };
}

/**
 * Remove alert files older than the retention window.
 *
 * @param {string} dataDir
 * @param {number} now
 * @param {number} [retentionDays]
 * @returns {number} removed count
 */
export function pruneMemoryMonitorAlerts(dataDir, now, retentionDays = MEMORY_MONITOR_RETENTION_DAYS) {
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  let names = [];
  try {
    names = readdirSync(dataDir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith(MEMORY_MONITOR_ALERT_PREFIX) || !name.endsWith('.jsonl')) continue;
    const date = name.slice(MEMORY_MONITOR_ALERT_PREFIX.length, -'.jsonl'.length);
    const timestamp = Date.parse(`${date}T00:00:00.000Z`);
    if (!Number.isFinite(timestamp) || timestamp >= cutoff) continue;
    try {
      unlinkSync(path.join(dataDir, name));
      removed += 1;
    } catch {
      // Retention is best-effort and must not break the monitor run.
    }
  }
  return removed;
}

/**
 * Read alert records newest-first for the server/diagnostics view.
 *
 * @param {{ dataDir: string, limit?: number, days?: number, now?: number }} options
 * @returns {object[]}
 */
export function readMemoryMonitorAlerts(options) {
  const dataDir = options.dataDir;
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(2000, Math.floor(options.limit))) : 200;
  const days = Number.isFinite(options.days) ? Math.max(1, Math.min(60, Math.floor(options.days))) : 3;
  const entries = [];
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  for (let offset = 0; offset < days && entries.length < limit; offset += 1) {
    const filePath = getMemoryMonitorAlertPath(dataDir, now - offset * 24 * 60 * 60 * 1000);
    if (!existsSync(filePath)) continue;
    let lines = [];
    try {
      lines = readFileSync(filePath, 'utf8').split('\n');
    } catch {
      continue;
    }
    for (let index = lines.length - 1; index >= 0 && entries.length < limit; index -= 1) {
      if (!lines[index]) continue;
      try {
        entries.push(JSON.parse(lines[index]));
      } catch {
        // Ignore a partial final line and keep reading older records.
      }
    }
  }
  return entries;
}

/**
 * Real, Linux-oriented probes. `readHostMemory` reads `/proc/meminfo`,
 * `readProcessSnapshot` runs `ps` and reads `/proc/<pid>` for the start time
 * (jiffies) used by the ownership registry.
 *
 * @param {object} [overrides]
 * @returns {object}
 */
export function createMemoryMonitorProbes(overrides = {}) {
  const registryProbes = createOpenCodeProcessProbes();
  return {
    readHostMemory: () => {
      try {
        return parseMeminfo(readFileSync('/proc/meminfo', 'utf8'));
      } catch {
        return { totalBytes: os.totalmem(), availableBytes: os.freemem(), swapTotalBytes: null, swapFreeBytes: null };
      }
    },
    readProcessSnapshot: (options = {}) => readProcessSnapshot(options),
    isProcessAlive,
    getProcessStartTime,
    findListeningPid: registryProbes.findListeningPid,
    readEarlyoomJournal: (options = {}) => readEarlyoomJournal(options),
    ...overrides,
  };
}

/**
 * @param {{ execFile?: typeof execFileSync }} [options]
 * @returns {{ processes: object[], warning: string }}
 */
export function readProcessSnapshot(options = {}) {
  const exec = options.execFile || execFileSync;
  let text = '';
  try {
    text = exec('ps', ['-eo', 'pid=,ppid=,rss=,args='], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    return { processes: [], warning: `Could not list processes with ps: ${String(error?.message || error).slice(0, 200)}` };
  }
  const base = parsePsOutput(text);
  const startTimes = {};
  for (const row of base) {
    startTimes[row.pid] = getProcessStartTime(row.pid);
  }
  return { processes: parsePsOutput(text, { startTimes }), warning: '' };
}

/**
 * @param {string[]} args
 * @param {typeof execFileSync} [execFile]
 * @returns {{ ok: true, stdout: string } | { ok: false, error: string }}
 */
function runJournalctl(args, execFile = execFileSync) {
  try {
    return {
      ok: true,
      stdout: execFile('journalctl', args, {
        encoding: 'utf8',
        timeout: 8000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { ok: false, error: 'journalctl is not installed' };
    }
    const detail = String(error?.stderr || error?.message || error).trim().replace(/\s+/g, ' ').slice(0, 200);
    return { ok: false, error: detail || 'journalctl failed' };
  }
}

/**
 * Read new earlyoom kill events using a journald cursor so a rotation does not
 * duplicate or lose records. A missing `journalctl` / unreadable journal is a
 * warning, never an error: that single condition is then skipped.
 *
 * @param {{ unit?: string, afterCursor?: string, execFile?: typeof execFileSync }} [options]
 * @returns {{ available: boolean, cursor: string, entries: object[], warning: string }}
 */
export function readEarlyoomJournal(options = {}) {
  const execFile = options.execFile || execFileSync;
  const unit = String(options.unit || DEFAULT_MEMORY_MONITOR_CONFIG.journalUnit).trim() || 'earlyoom';
  const afterCursor = String(options.afterCursor || '').trim();
  const base = ['--no-pager', '--show-cursor', '-o', 'short-iso', '-u', unit];
  if (afterCursor) {
    const withCursor = runJournalctl([...base, `--after-cursor=${afterCursor}`], execFile);
    if (withCursor.ok) return parseEarlyoomJournal(withCursor.stdout);
    // A rotated cursor is not fatal: fall back to a bounded tail and say so.
    const tail = runJournalctl([...base, '-n', '20'], execFile);
    if (tail.ok) {
      const parsed = parseEarlyoomJournal(tail.stdout);
      parsed.warning = `earlyoom journal cursor was stale (${withCursor.error}); read the last 20 entries instead.`;
      return parsed;
    }
    return { available: false, cursor: '', entries: [], warning: `Could not read the ${unit} journal: ${tail.error}` };
  }
  const tail = runJournalctl([...base, '-n', '200'], execFile);
  if (tail.ok) {
    const parsed = parseEarlyoomJournal(tail.stdout);
    parsed.warning = '';
    return parsed;
  }
  return { available: false, cursor: '', entries: [], warning: `Could not read the ${unit} journal: ${tail.error}` };
}

/**
 * Human-readable one-run report for the CLI.
 *
 * @param {ReturnType<typeof runMemoryMonitorOnce>} result
 * @returns {string}
 */
export function formatMemoryMonitorReport(result) {
  const evaluation = result.evaluation;
  const host = evaluation.host;
  const lines = [];
  lines.push(`Cretli memory/orphan monitor ${result.at}`);
  lines.push(`  memory: total ${formatMiB(host.totalBytes)}, available ${formatMiB(host.availableBytes)}`
    + ` (critical < ${formatMiB(result.config.memoryCriticalBytes)}, warn < ${formatMiB(result.config.memoryWarnBytes)})`);
  lines.push(`  swap: ${evaluation.swap
    ? `${formatMiB(evaluation.swap.usedBytes)} / ${formatMiB(evaluation.swap.totalBytes)} (${Math.round(evaluation.swap.ratio * 100)}%${evaluation.swap.grewFast ? ', fast growth' : ''})`
    : (Number.isFinite(host.swapTotalBytes) && host.swapTotalBytes > 0 ? 'below threshold' : 'no swap')}`);
  lines.push(`  managed opencode: ${evaluation.managed.count} live, ${evaluation.orphaned.length} orphaned,`
    + ` ${evaluation.stale.length} stale registry entr${evaluation.stale.length === 1 ? 'y' : 'ies'}`);
  lines.push(`  foreign opencode: ${evaluation.foreign.length}`
    + (evaluation.foreign.length ? ` (pids ${evaluation.foreign.map((row) => row.pid).join(', ')})` : ''));
  lines.push(`  opencode serve total: ${evaluation.opencodeTotal} (threshold > ${result.config.maxOpenCodeProcesses})`);
  lines.push(`  duplicate webpack watchers: ${evaluation.duplicateWatchers.length}`);
  lines.push(`  earlyoom: ${evaluation.earlyoom.available ? `${evaluation.earlyoom.eventCount} new kill event(s), cursor ${evaluation.earlyoom.cursor || 'n/a'}` : 'journal unavailable (condition skipped)'}`);
  if (result.alerts.length > 0) {
    lines.push(`ALERTS (${result.alerts.length}):`);
    for (const alert of result.alerts) lines.push(`  - [${alert.severity}] ${alert.type}: ${alert.message}`);
  } else {
    lines.push('ALERTS: none');
  }
  if (evaluation.topProcesses.length > 0) {
    lines.push('Top processes by RSS:');
    for (const row of evaluation.topProcesses) {
      lines.push(`  pid ${row.pid} ppid ${row.ppid} rss ${formatMiB(row.rssBytes)} ${row.args.slice(0, 80)}`);
    }
  }
  if (result.warnings.length > 0) {
    lines.push('WARNINGS:');
    for (const warning of result.warnings) lines.push(`  - ${warning}`);
  }
  lines.push(`  wrote ${result.written} record(s)${result.skipped ? `, skipped ${result.skipped}` : ''}`
    + `${result.alertFilePath ? ` to ${result.alertFilePath}` : ' (dry run)'}; state ${result.statePath}`);
  return `${lines.join('\n')}\n`;
}

/**
 * One monitor run. Reads the previous state, evaluates the snapshot, writes the
 * new alarms and the next state, and returns a summary for the CLI.
 *
 * @param {{
 *   dataDir?: string,
 *   registryPath?: string,
 *   env?: Record<string, string | undefined>,
 *   config?: Partial<MemoryMonitorConfig>,
 *   now?: number | (() => number),
 *   probes?: object,
 *   registry?: Record<string, unknown>,
 *   processes?: object[],
 *   host?: object,
 *   earlyoom?: object,
 *   previousState?: object,
 *   write?: boolean,
 * }} [options]
 * @returns {object}
 */
export function runMemoryMonitorOnce(options = {}) {
  const dataDir = options.dataDir || resolveDataPath();
  const config = { ...resolveMemoryMonitorConfig(options.env || process.env), ...(options.config || {}) };
  const nowMs = typeof options.now === 'function' ? options.now() : (Number.isFinite(options.now) ? options.now : Date.now());
  const probes = options.probes || createMemoryMonitorProbes();
  const write = options.write !== false;
  const state = options.previousState || readMemoryMonitorState(dataDir);
  // A caller (CLI `--registry`) can point the monitor at a fixture instead of the
  // server's own `resolveDataPath()` registry, so the orphan classification is
  // reproducible from a test fixture.
  const registry = options.registry !== undefined
    ? options.registry
    : readOpenCodePortRegistryRaw(options.registryPath);
  const warnings = [];

  let processes = options.processes;
  if (processes === undefined) {
    const snapshot = typeof probes.readProcessSnapshot === 'function' ? probes.readProcessSnapshot() : { processes: [], warning: '' };
    processes = snapshot.processes || [];
    if (snapshot.warning) warnings.push(snapshot.warning);
  }
  const host = options.host !== undefined
    ? options.host
    : (typeof probes.readHostMemory === 'function' ? probes.readHostMemory() : {});
  let earlyoom = options.earlyoom;
  if (earlyoom === undefined) {
    earlyoom = typeof probes.readEarlyoomJournal === 'function'
      ? probes.readEarlyoomJournal({ unit: config.journalUnit, afterCursor: state.earlyoom?.cursor || '' })
      : { available: false, cursor: '', entries: [], warning: 'earlyoom journal probe is unavailable.' };
  }
  // First read has no cursor: without a baseline every historical kill in the
  // journal would alarm. Record the cursor and ignore the history instead.
  if (earlyoom?.available && !state.earlyoom?.cursor) {
    const entries = Array.isArray(earlyoom.entries) ? earlyoom.entries : [];
    const baselineMs = Date.parse(String(state.lastRunAt || state.earlyoom?.lastEventAt || ''));
    if (!Number.isFinite(baselineMs)) {
      if (entries.length > 0) warnings.push(`earlyoom baseline: ignored ${entries.length} historical journal event(s).`);
      earlyoom = { ...earlyoom, entries: [] };
    } else {
      earlyoom = {
        ...earlyoom,
        entries: entries.filter((entry) => {
          const timestamp = Date.parse(String(entry?.timestamp || ''));
          return !Number.isFinite(timestamp) || timestamp > baselineMs;
        }),
      };
    }
  }

  // Rotation safety beyond the journald cursor: remember the events already
  // reported so a stale-cursor fallback (or a state file that lost its cursor)
  // cannot re-alarm the same kill line.
  const seenEarlyoomFingerprints = Array.isArray(state.earlyoom?.seen) ? state.earlyoom.seen : [];
  const reportedEarlyoomFingerprints = [];
  if (earlyoom?.available && Array.isArray(earlyoom.entries) && earlyoom.entries.length > 0) {
    const freshEntries = [];
    for (const entry of earlyoom.entries) {
      const fingerprint = `${entry?.timestamp || ''}\u0000${entry?.message || ''}`;
      if (seenEarlyoomFingerprints.includes(fingerprint)) continue;
      freshEntries.push(entry);
      reportedEarlyoomFingerprints.push(fingerprint);
    }
    earlyoom = { ...earlyoom, entries: freshEntries };
  }

  const evaluation = evaluateMemoryMonitor({
    now: nowMs,
    config,
    host,
    processes,
    registry,
    previousState: state,
    earlyoom,
    probes,
  });
  warnings.push(...evaluation.warnings);

  const episodeResult = applyAlertEpisodes({
    alerts: evaluation.episodeAlerts,
    previousEpisodes: state.episodes,
    nowMs,
    repeatMs: config.alertRepeatMs,
  });
  const emitted = [...episodeResult.emitted, ...evaluation.eventAlerts];
  const records = [
    ...emitted.map((alert) => ({
      at: new Date(nowMs).toISOString(),
      event: 'memory-monitor-alert',
      alert: true,
      severity: alert.severity,
      type: alert.type,
      title: alert.title,
      message: alert.message,
      fingerprint: alert.fingerprint,
      details: alert.details,
      host: evaluation.host,
    })),
    ...episodeResult.recovered.map((recovery) => ({
      at: new Date(nowMs).toISOString(),
      event: 'memory-monitor-recovered',
      alert: false,
      severity: 'info',
      type: `${recovery.type}-recovered`,
      title: 'Memory monitor threshold recovered',
      message: `${recovery.type} is back below its threshold.`,
      fingerprint: `memory-monitor:${recovery.type}:recovered:${recovery.recoveredAt}`,
      details: recovery,
      host: evaluation.host,
    })),
  ];

  const swapUsedBytes = evaluation.swap
    ? evaluation.swap.usedBytes
    : (Number.isFinite(host.swapTotalBytes) && Number.isFinite(host.swapFreeBytes)
      ? Math.max(0, host.swapTotalBytes - host.swapFreeBytes)
      : null);

  const nextState = {
    version: MEMORY_MONITOR_SCHEMA_VERSION,
    updatedAt: new Date(nowMs).toISOString(),
    lastRunAt: new Date(nowMs).toISOString(),
    episodes: episodeResult.episodes,
    lastSwapUsedBytes: swapUsedBytes,
    lastSwapAt: new Date(nowMs).toISOString(),
    earlyoom: {
      cursor: String(earlyoom?.cursor || state.earlyoom?.cursor || ''),
      seen: [...new Set([...reportedEarlyoomFingerprints, ...seenEarlyoomFingerprints])].slice(0, 100),
    },
  };

  let written = 0;
  let skipped = 0;
  let alertFilePath = null;
  if (write) {
    try {
      mkdirSync(dataDir, { recursive: true });
      const result = appendMemoryMonitorRecords(dataDir, records, { now: nowMs });
      written = result.written;
      skipped = result.skipped;
      alertFilePath = result.filePath;
      writeMemoryMonitorState(dataDir, nextState);
      pruneMemoryMonitorAlerts(dataDir, nowMs);
    } catch (error) {
      warnings.push(`Could not persist monitor output: ${String(error?.message || error).slice(0, 200)}`);
    }
  }

  return {
    at: new Date(nowMs).toISOString(),
    dataDir,
    config,
    evaluation,
    records,
    alerts: records.filter((record) => record.alert === true),
    recovered: episodeResult.recovered,
    suppressedEpisodeAlerts: evaluation.episodeAlerts.length - episodeResult.emitted.length,
    warnings,
    written,
    skipped,
    alertFilePath,
    statePath: getMemoryMonitorStatePath(dataDir),
    state: nextState,
    exitCode: evaluation.thresholdExceeded ? 1 : 0,
  };
}
