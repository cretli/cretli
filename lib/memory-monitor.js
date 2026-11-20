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
import { normalizeChildProcessEntry } from './child-process-registry.js';
import {
  appendMemoryLedger,
  createOomMarkerRecord,
  detectUnexpectedTerminations,
  isCoveredByCleanShutdown,
  readChildExitEvents,
  measureMemory,
  MAX_EXIT_EVENTS,
  MAX_IDENTITY_HISTORY,
  MAX_MARKER_TARGETS,
  MEMORY_LEDGER_FILE,
  parseTerminationEvidence,
  parseJournalLineTimestamp,
  readCleanShutdownMarker,
  readCgroupMemory,
  readProcessCgroup,
  readProcessRssBytes,
  readServerRuntimeMarker,
  terminationTargetKey,
  TERMINATION_JOURNAL_LOOKBACK_MS,
  writeOomMarker,
} from './oom-diagnostics.js';
import { listBuiltinProcessLifecycles } from './agent-harness/builtin-process-lifecycles.ts';
import { resolveDataPath } from './runtime-paths.js';
import { createMcpResourceObserver } from './self-check/mcp-process-invariants.js';

/** @typedef {{ pid: number, ppid: number, rssBytes: number, args: string, startTime: string }} ProcessRow */
/** @typedef {Record<string, any>} Dict Loosely shaped JSON-like record from probes, state files and journals. */

/**
 * Shared MCP resource observer (child processes per program, RSS, ownerless pool
 * entries). Started by the server next to the memory monitor timer.
 */
export const mcpResourceObserver = createMcpResourceObserver({
  onAlarm: (alarm) => console.warn(`[mcp-resources] ${alarm.kind}: ${alarm.message}`),
});

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
 *   alertRepeatMs: number,
 *   topProcessCount: number,
 *   journalUnit: string,
 *   serverUnit: string,
 *   oomdUnit: string,
 * } & Record<string, number | string>} MemoryMonitorConfig
 */

/**
 * Process monitors of every provider that exposes a `processLifecycle` hook.
 *
 * @returns {import('./agent-harness/harness-plugin-contract.ts').HarnessProcessMonitor[]}
 */
function listProcessMonitors() {
  return listBuiltinProcessLifecycles()
    .map((lifecycle) => lifecycle.monitor)
    .filter((monitor) => Boolean(monitor));
}

/** @type {Readonly<MemoryMonitorConfig>} */
export const DEFAULT_MEMORY_MONITOR_CONFIG = Object.freeze({
  memoryCriticalBytes: 4 * 1024 ** 3,
  memoryWarnBytes: 6 * 1024 ** 3,
  swapUsedRatio: 0.5,
  swapGrowthBytes: 1024 ** 3,
  swapGrowthWindowMs: 10 * 60 * 1000,
  alertRepeatMs: 30 * 60 * 1000,
  topProcessCount: 10,
  journalUnit: 'earlyoom',
  // External evidence for an unexpected server/executor termination.
  serverUnit: 'cretli.service',
  oomdUnit: 'systemd-oomd',
});

/**
 * The defaults above plus the provider-owned thresholds
 * (processLifecycle.monitor.defaultConfig). Read at call time: a plugin's hook
 * is registered after this module is imported.
 *
 * @returns {MemoryMonitorConfig}
 */
export function getDefaultMemoryMonitorConfig() {
  return /** @type {MemoryMonitorConfig} */ ({
    ...DEFAULT_MEMORY_MONITOR_CONFIG,
    ...Object.assign({}, ...listProcessMonitors().map((monitor) => monitor.defaultConfig)),
  });
}

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
    alertRepeatMs: readNumberEnv(env, 'CRETLI_MEMORY_MONITOR_ALERT_REPEAT_MS', DEFAULT_MEMORY_MONITOR_CONFIG.alertRepeatMs, { min: 0 }),
    topProcessCount: readNumberEnv(env, 'CRETLI_MEMORY_MONITOR_TOP_PROCESSES', DEFAULT_MEMORY_MONITOR_CONFIG.topProcessCount, { min: 1 }),
    journalUnit: String(env?.CRETLI_MEMORY_MONITOR_JOURNAL_UNIT || DEFAULT_MEMORY_MONITOR_CONFIG.journalUnit).trim() || DEFAULT_MEMORY_MONITOR_CONFIG.journalUnit,
    serverUnit: String(env?.CRETLI_MEMORY_MONITOR_SERVER_UNIT || DEFAULT_MEMORY_MONITOR_CONFIG.serverUnit).trim() || DEFAULT_MEMORY_MONITOR_CONFIG.serverUnit,
    oomdUnit: String(env?.CRETLI_MEMORY_MONITOR_OOMD_UNIT || DEFAULT_MEMORY_MONITOR_CONFIG.oomdUnit).trim() || DEFAULT_MEMORY_MONITOR_CONFIG.oomdUnit,
    ...Object.assign({}, ...listProcessMonitors().map((monitor) => monitor.resolveConfig(env))),
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
 * Groups live `webpack-cli-watch.mjs` processes by resolved project + config
 * realpath and returns every group with more than one watcher. A relative
 * `--config` is resolved against the owning process (`/proc/<pid>/cwd`, then the
 * watcher script path in argv), so two different checkouts never collapse into
 * one group while the same checkout + config still groups.
 *
 * @param {Array<{ pid: number, args: string, rssBytes: number, startTime: string }>} processes
 * @param {{ realpath?: (value: string) => string, readProcessCwd?: (pid: number) => string }} [options]
 * @returns {Array<{ projectRootRealpath: string, configRealpath: string, processes: Dict[] }>}
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
 *   host: { swapTotalBytes?: number | null, swapFreeBytes?: number | null },
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
 *   processes?: ProcessRow[],
 *   registry?: Record<string, unknown>,
 *   previousState?: Dict,
 *   earlyoom?: { available?: boolean, warning?: string, cursor?: string, entries?: Array<{ timestamp: string, message: string }> },
 *   probes?: { isProcessAlive: (pid: number) => boolean, getProcessStartTime: (pid: number) => string },
 * }} input
 * @returns {Dict}
 */
export function evaluateMemoryMonitor(input) {
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const config = { ...getDefaultMemoryMonitorConfig(), ...(input.config || {}) };
  const host = input.host || {};
  const processes = Array.isArray(input.processes) ? input.processes : [];
  const probes = input.probes || { isProcessAlive, getProcessStartTime };
  const previousState = input.previousState || {};
  const warnings = [];
  /** @type {Array<Dict>} */
  const episodeAlerts = [];
  /** @type {Array<Dict>} */
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

  // --- Provider-owned processes (processLifecycle.monitor) -------------------
  // Computed before the duplicate-watcher scan: the top-process list is pure and
  // the provider alerts sit between swap and webpack in the episode order.
  const topProcesses = buildTopProcesses(processes, config.topProcessCount);
  const providerEvaluations = listProcessMonitors().map((monitor) => monitor.evaluate({
    registry: input.registry || {},
    processes,
    probes,
    config,
    topProcesses,
  }));
  for (const evaluation of providerEvaluations) {
    for (const id of evaluation.triggered) triggered.add(id);
  }

  // --- Duplicate webpack watchers (grouped by project + config realpath) ------
  const duplicateWatchers = findDuplicateWebpackWatchers(processes);
  if (duplicateWatchers.length > 0) triggered.add('webpack-watch-duplicate');

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
  for (const evaluation of providerEvaluations) episodeAlerts.push(...evaluation.episodeAlerts);
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
    ...Object.assign({}, ...providerEvaluations.map((evaluation) => evaluation.fields)),
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
 * @returns {{ emitted: Dict[], episodes: Record<string, Dict>, recovered: Dict[] }}
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
 * @returns {Dict}
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
 * @param {Dict} state
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
 * @param {Dict[]} records
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
 * @returns {Dict[]}
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
 * @param {Dict} [overrides]
 * @returns {Dict}
 */
export function createMemoryMonitorProbes(overrides = {}) {
  const providerProbes = Object.assign({}, ...listProcessMonitors().map((monitor) => monitor.createProbes()));
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
    ...providerProbes,
    readEarlyoomJournal: (options = {}) => readEarlyoomJournal(options),
    readTerminationJournal: (options = {}) => readTerminationJournal(options),
    readProcessCgroup: (pid) => readProcessCgroup(pid),
    readCgroupMemory: (cgroupDir) => readCgroupMemory(cgroupDir),
    readProcessRss: (pid) => readProcessRssBytes(pid),
    ...overrides,
  };
}

/**
 * @param {{ execFile?: typeof execFileSync }} [options]
 * @returns {{ processes: Dict[], warning: string }}
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
 * @returns {{ ok: true, stdout: string, error?: undefined } | { ok: false, error: string }}
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
 * @returns {{ available: boolean, cursor: string, entries: Dict[], warning: string }}
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

const TERMINATION_JOURNAL_TAIL = 300;
const EXIT_EVENT_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const UNKNOWN_MARKER_ENRICH_WINDOW_MS = 60 * 60 * 1000;
// This durable outbox fits a complete exit-event window, every bounded server
// identity candidate (history + current/state), and one evidence-free batch.
// If producers exceed the invariant, the journal cursor is retained below.
const MAX_SERVER_TERMINATION_CANDIDATES = MAX_IDENTITY_HISTORY + 2;
const MAX_PENDING_MARKERS = MAX_EXIT_EVENTS + MAX_SERVER_TERMINATION_CANDIDATES + MAX_MARKER_TARGETS;
// Classified records are retained separately from the retry outbox so a full
// marker-write batch never forces already-read journal evidence to be reread.
const MAX_CLASSIFIED_OVERFLOW = MAX_PENDING_MARKERS * 2;
// Every SIGKILL/unknown marker written by one run must stay re-examinable on
// the next run. A run can persist at most MAX_PENDING_MARKERS markers (the write
// budget), so sizing the window to one complete batch means the oldest rows can
// only be evicted by a *later* batch, never by the tail of their own. The
// durable state stays bounded (previous window + one batch), unlike an unbounded
// history. 20 was too small: one 25-event SIGKILL batch already lost its first
// five candidates before the OOM journal evidence arrived (R5-F1 residual).
const MAX_UNKNOWN_MARKERS = MAX_PENDING_MARKERS;

/** Remembered earlyoom fingerprints; the replay cap applies while a termination overflow pins the cursor. */
const MAX_EARLYOOM_SEEN = 100;
const MAX_EARLYOOM_SEEN_REPLAY = 1000;

/**
 * Parse `journalctl --show-cursor -o short-iso` output into termination
 * evidence plus the trailing journald cursor.
 *
 * @param {string} text
 * @param {{ sources?: string[], requireTimestamp?: boolean }} [options] evidence filter, see `parseTerminationEvidence`
 * @returns {{ available: boolean, cursor: string, entries: Dict[], warning: string }}
 */
export function parseTerminationJournal(text, options = {}) {
  let cursor = '';
  for (const rawLine of String(text || '').split('\n')) {
    const match = JOURNAL_CURSOR_PATTERN.exec(rawLine.trim());
    if (match) cursor = match[1].trim();
  }
  return { available: true, cursor, entries: parseTerminationEvidence(text, options), warning: '' };
}

/**
 * Pick the newest cursor among several queries by its realtime `t=` field.
 * Only safe when every query was read at the same moment; the termination
 * reader no longer uses it (it keeps one cursor per source, see
 * `splitTerminationCursor`) but it stays exported for callers that do.
 *
 * @param {string[]} cursors
 * @returns {string}
 */
export function newestJournalCursor(cursors) {
  let best = '';
  let bestTime = -1;
  for (const cursor of cursors) {
    const match = /(?:^|;)t=([0-9a-f]+)/i.exec(cursor);
    const time = match ? parseInt(match[1], 16) : -1;
    if (time >= bestTime) {
      best = cursor;
      bestTime = time;
    }
  }
  return best;
}

const MULTI_CURSOR_PREFIX = 'multi:';

/**
 * Split a stored termination cursor into one cursor per journal source.
 * A composite value (`multi:k=<cursor>|u=<cursor>|U=<cursor>`) carries one
 * cursor per source; any other non-empty value is a legacy single cursor that
 * applies to every source. Journald cursors never contain `|`.
 *
 * @param {string} stored
 * @param {string[]} sourceIds
 * @returns {Record<string, string>}
 */
export function splitTerminationCursor(stored, sourceIds) {
  const text = String(stored || '').trim();
  const result = {};
  if (!text) return result;
  if (!text.startsWith(MULTI_CURSOR_PREFIX)) {
    for (const id of sourceIds) result[id] = text;
    return result;
  }
  for (const part of text.slice(MULTI_CURSOR_PREFIX.length).split('|')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const id = part.slice(0, eq);
    const value = part.slice(eq + 1).trim();
    if (value && sourceIds.includes(id)) result[id] = value;
  }
  return result;
}

/**
 * Join per-source cursors into one stored value. Identical cursors for every
 * source collapse to the plain legacy form; otherwise each source keeps its
 * own position so a lagging source is never advanced to another's watermark.
 *
 * @param {Record<string, string>} cursors
 * @param {string[]} sourceIds
 * @returns {string}
 */
export function joinTerminationCursor(cursors, sourceIds) {
  const present = sourceIds.filter((id) => cursors[id]);
  if (present.length === 0) return '';
  const first = cursors[present[0]];
  if (present.length === sourceIds.length && present.every((id) => cursors[id] === first)) return first;
  return `${MULTI_CURSOR_PREFIX}${present.map((id) => `${id}=${cursors[id]}`).join('|')}`;
}

/**
 * Read external termination evidence: kernel OOM lines plus the Cretli /
 * systemd-oomd unit messages. A missing `journalctl`, an unreadable journal or
 * a rotated cursor is a warning, never an error: absence of evidence leaves the
 * cause `unknown` instead of inventing one.
 *
 * @param {{
 *   unit?: string,
 *   serverUnit?: string,
 *   oomdUnit?: string,
 *   afterCursor?: string,
 *   since?: string,
 *   execFile?: typeof execFileSync,
 * }} [options]
 * @returns {{ available: boolean, cursor: string, entries: Dict[], warning: string }}
 */
export function readTerminationJournal(options = {}) {
  const execFile = options.execFile || execFileSync;
  const serverUnit = String(options.unit || options.serverUnit || DEFAULT_MEMORY_MONITOR_CONFIG.serverUnit).trim()
    || DEFAULT_MEMORY_MONITOR_CONFIG.serverUnit;
  const oomdUnit = String(options.oomdUnit || DEFAULT_MEMORY_MONITOR_CONFIG.oomdUnit).trim()
    || DEFAULT_MEMORY_MONITOR_CONFIG.oomdUnit;
  const since = String(options.since || '').trim();
  const sourceIds = ['k', 'u', 'U'];
  // Each source (-k, -u, --user-unit) resumes from its own cursor. A single
  // shared "newest" cursor could skip an event that landed in a lagging source
  // between two sequential reads (read k at T1, event in u at T2, read u at T3:
  // the newest cursor T3 would hide the T2 event on the next run).
  const sourceCursors = splitTerminationCursor(options.afterCursor, sourceIds);
  const tail = String(TERMINATION_JOURNAL_TAIL);
  const calls = [
    // Each stream may only produce the sources it can legitimately carry: the
    // unit streams hold application output, so message text quoting kernel or
    // earlyoom phrases never becomes `confirmed` evidence for those sources (F6).
    { id: 'k', args: ['-k', '-n', tail], parse: { sources: ['kernel'] } },
    { id: 'u', args: ['-u', serverUnit, '-u', oomdUnit, '-n', tail], parse: { sources: ['systemd', 'systemd-oomd'], requireTimestamp: true } },
    // A user-scope install (`systemctl --user`) logs under the user journal;
    // `-u` never matches it. Optional: hosts without a user journal just fail.
    { id: 'U', args: ['--user-unit', serverUnit, '-n', tail], optional: true, parse: { sources: ['systemd', 'systemd-oomd'], requireTimestamp: true } },
  ];
  const seenLines = new Set();
  const entries = [];
  const warnings = [];
  let available = false;
  // Per-source resume position; a source that returned no cursor (no new
  // entries, optional journal missing) keeps its previous one.
  const nextCursors = { ...sourceCursors };
  for (const { id, args, optional, parse } of calls) {
    const afterCursor = sourceCursors[id] || '';
    const base = ['--no-pager', '--show-cursor', '-o', 'short-iso'];
    if (afterCursor) base.push(`--after-cursor=${afterCursor}`);
    else if (since) base.push('--since', since);
    let result = runJournalctl([...base, ...args], execFile);
    if (!result.ok && afterCursor) {
      // A rotated cursor is not fatal: retry with the bounded time window.
      const cursorError = result.error || 'unknown error';
      const fallback = ['--no-pager', '--show-cursor', '-o', 'short-iso'];
      if (since) fallback.push('--since', since);
      result = runJournalctl([...fallback, ...args], execFile);
      if (result.ok) {
        warnings.push(`termination journal cursor was stale (${cursorError}); used a bounded time window instead.`);
      }
    }
    if (!result.ok) {
      if (!optional) warnings.push(`Could not read termination evidence: ${result.error}`);
      continue;
    }
    if (!optional) available = true;
    const parsed = parseTerminationJournal(result.stdout, parse);
    if (parsed.cursor) nextCursors[id] = parsed.cursor;
    const rawLines = String(result.stdout || '').split('\n').filter((line) => line.trim() && !JOURNAL_CURSOR_PATTERN.test(line.trim())).length;
    if (rawLines >= TERMINATION_JOURNAL_TAIL) {
      warnings.push(`termination journal read hit the ${TERMINATION_JOURNAL_TAIL}-line tail limit; older lines in the window may be missing.`);
    }
    for (const entry of parsed.entries) {
      if (seenLines.has(entry.line)) continue;
      seenLines.add(entry.line);
      entries.push(entry);
    }
  }
  const cursor = joinTerminationCursor(nextCursors, sourceIds);
  const warning = [...new Set(warnings)].join(' ');
  if (!available) {
    return {
      available: false,
      cursor: '',
      entries: [],
      warning: warning || 'termination journal is unavailable.',
    };
  }
  return { available: true, cursor, entries, warning };
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
  for (const monitor of listProcessMonitors()) lines.push(...monitor.formatReport(evaluation, result.config));
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
  if (result.memory) {
    lines.push(`  memory ledger: server ${formatMiB(result.memory.serverRssBytes)},`
      + ` executors ${formatMiB(result.memory.executorsRssBytes)} in ${result.memory.executorCount || 0} process(es)`
      + `${result.memory.unreadable ? `, ${result.memory.unreadable} unreadable` : ''}`);
  }
  if (result.termination) {
    const evidence = result.termination.evidenceRead === false
      ? 'not needed (no unexpected termination)'
      : (result.termination.evidenceAvailable ? 'available' : 'unavailable');
    lines.push(`  termination evidence: ${evidence}`
      + `; ${result.termination.detected || 0} new marker(s),`
      + ` server ${result.termination.serverAlive ? 'alive' : 'not observed'},`
      + ` executors ${result.termination.executorCount || 0} live / ${result.termination.staleExecutorCount || 0} stale`);
  }
  for (const marker of result.terminationMarkers || []) {
    lines.push(`  OOM marker: ${marker.target} pid ${marker.pid ?? 'n/a'} ${marker.cause}/${marker.confidence}`
      + ` from ${marker.source} (${marker.basis})`);
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
 * Read the server-owned child registry from the monitor's data directory. The
 * monitor must never use its own `resolveDataPath()` here: it may run with
 * `--data-dir` against another installation's state.
 *
 * @param {string} dataDir
 * @param {(filePath: string) => string} [readFile]
 * @returns {Record<string, Dict>}
 */
export function readExecutorRegistry(dataDir, readFile = (filePath) => readFileSync(filePath, 'utf8')) {
  const filePath = path.join(dataDir, 'child-processes.json');
  let raw;
  try {
    raw = JSON.parse(readFile(filePath));
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const value of Object.values(raw)) {
    const entry = normalizeChildProcessEntry(value);
    if (!entry) continue;
    out[String(entry.pid)] = entry;
  }
  return out;
}

/**
 * Observe the server identity marker. `/proc` start time guards against PID
 * reuse: a new unrelated process at the same PID is not the recorded server.
 *
 * @param {{ pid?: number, startedAt?: string, instanceToken?: string } | null} runtime
 * @param {Dict} probes
 */
function observeServerRuntime(runtime, probes) {
  if (!Number(runtime?.pid)) return null;
  const alive = typeof probes.isProcessAlive === 'function' ? probes.isProcessAlive(runtime.pid) : false;
  const liveStart = alive && typeof probes.getProcessStartTime === 'function'
    ? String(probes.getProcessStartTime(runtime.pid) || '')
    : '';
  const identityMatches = !runtime.startedAt || !liveStart || runtime.startedAt === liveStart;
  const startedAt = String(runtime.startedAt || liveStart || '');
  return {
    pid: Number(runtime.pid),
    startedAt,
    instanceToken: String(runtime.instanceToken || ''),
    alive: Boolean(alive && identityMatches),
  };
}

/**
 * Whether a recorded identity is the live server observed right now. PID reuse
 * is ruled out by the `/proc` start time.
 *
 * @param {{ pid?: number, startedAt?: string } | null} candidate
 * @param {{ pid?: number, startedAt?: string, alive?: boolean } | null} observed
 * @returns {boolean}
 */
function isSameLiveServer(candidate, observed) {
  if (!Number(candidate?.pid) || !Number(observed?.pid) || Number(candidate.pid) !== Number(observed.pid)) return false;
  if (!observed.alive) return false;
  if (candidate.startedAt && observed.startedAt && candidate.startedAt !== observed.startedAt) return false;
  return true;
}

/**
 * Split the persisted child registry into live executors and entries whose
 * process is gone (or whose PID was recycled). A stale entry is unusual: a
 * graceful child exit removes it, so it survives a SIGKILL/crash.
 *
 * @param {Record<string, Dict>} registry
 * @param {Dict} probes
 */
function observeExecutors(registry, probes) {
  const live = [];
  const stale = [];
  for (const entry of Object.values(registry || {})) {
    const alive = typeof probes.isProcessAlive === 'function' ? probes.isProcessAlive(entry.pid) : false;
    const liveStart = alive && typeof probes.getProcessStartTime === 'function'
      ? String(probes.getProcessStartTime(entry.pid) || '')
      : '';
    const identityMatches = alive && (!entry.startedAt || !liveStart || entry.startedAt === liveStart);
    if (identityMatches) {
      live.push({ ...entry, startedAt: String(entry.startedAt || liveStart || '') });
    } else {
      stale.push(entry);
    }
  }
  return { live, stale };
}

/**
 * Whether a journal read is worth doing: a previously seen server/executor is
 * gone, or the registry left a dead entry behind.
 */
function countPotentialTerminations(input) {
  let count = 0;
  const reported = input.reportedKeys || new Set();
  for (const previousServer of input.previousServers || []) {
    if (!Number(previousServer?.pid)) continue;
    const observed = input.observedServer;
    const sameAlive = observed?.alive
      && observed.pid === previousServer.pid
      && (!previousServer.startedAt || !observed.startedAt || previousServer.startedAt === observed.startedAt);
    const alreadyReported = reported.has(terminationTargetKey({
      target: 'server',
      pid: previousServer.pid,
      startedAt: previousServer.startedAt,
    }));
    if (!sameAlive && !alreadyReported) count += 1;
  }
  for (const event of input.exitEvents || []) {
    if (event?.signal !== 'SIGKILL') continue;
    const key = terminationTargetKey({ target: 'executor', pid: event.pid, startedAt: event.startedAt });
    if (!reported.has(key)) count += 1;
  }
  count += (input.unknownKeys || []).length;
  for (const stale of input.staleExecutors) {
    const alreadyReported = reported.has(terminationTargetKey({
      target: 'executor',
      pid: stale.pid,
      startedAt: stale.startedAt,
    }));
    if (!alreadyReported) count += 1;
  }
  const liveKeys = new Set(input.liveExecutors.map((entry) => `${entry.pid}:${entry.startedAt || ''}`));
  for (const row of Object.values(input.previousState?.executors || {})) {
    if (!Number(row?.pid)) continue;
    if (liveKeys.has(`${row.pid}:${row.startedAt || ''}`)) continue;
    const alreadyReported = reported.has(terminationTargetKey({
      target: 'executor',
      pid: row.pid,
      startedAt: row.startedAt,
    }));
    if (!alreadyReported) count += 1;
  }
  return count;
}

/**
 * @param {number} pid
 * @param {Dict} probes
 * @returns {string}
 */
function readServerCgroupPath(pid, probes) {
  const reader = typeof probes.readProcessCgroup === 'function' ? probes.readProcessCgroup : readProcessCgroup;
  try {
    const entry = reader(pid);
    return String(entry?.memoryDir || '');
  } catch {
    return '';
  }
}

/**
 * @param {string} cgroupDir
 * @param {Dict} probes
 * @returns {Dict | null}
 */
function readCgroupSnapshot(cgroupDir, probes) {
  if (!cgroupDir) return null;
  const reader = typeof probes.readCgroupMemory === 'function' ? probes.readCgroupMemory : readCgroupMemory;
  try {
    return reader(cgroupDir);
  } catch {
    return null;
  }
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
 *   probes?: Dict,
 *   registry?: Record<string, unknown>,
 *   processes?: ProcessRow[],
 *   exitEvents?: Dict[],
 *   host?: Dict,
 *   earlyoom?: Dict,
 *   previousState?: Dict,
 *   serverRuntime?: Dict | null,
 *   cleanShutdown?: Dict | null,
 *   executorRegistry?: Record<string, Dict> | null,
 *   terminationJournal?: Dict,
 *   cgroupBefore?: Dict | null,
 *   cgroupAfter?: Dict | null,
 *   write?: boolean,
 * }} [options]
 * @returns {Dict}
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
    : Object.assign({}, ...listProcessMonitors().map((monitor) => monitor.readRegistry(options.registryPath)));
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
  // Raw kill lines (before baseline / dedupe trimming) double as termination
  // evidence: earlyoom names the pid it signalled. The journal line carries the
  // event time; when a producer kept it only in `timestamp`, prepend it so the
  // PID match can be correlated with the target's lifetime (R17-F3).
  const earlyoomEvidence = earlyoom?.available && Array.isArray(earlyoom.entries)
    ? parseTerminationEvidence(earlyoom.entries.map((entry) => {
        const message = String(entry?.message || '');
        const timestamp = String(entry?.timestamp || '').trim();
        return timestamp && parseJournalLineTimestamp(message) === null ? `${timestamp} ${message}` : message;
      }).join('\n'), { sources: ['earlyoom'], requireTimestamp: true })
    : [];
  // First read has no cursor: without a baseline every historical kill in the
  // journal would alarm. Record the cursor and ignore the history instead.
  if (earlyoom?.available && !state.earlyoom?.cursor) {
    const entries = Array.isArray(earlyoom.entries) ? earlyoom.entries : [];
    // `baselineAt` pins the first-run baseline while a termination overflow
    // keeps the cursor and `lastRunAt` back; without it the next tick would
    // treat the historical kills of the lookback window as fresh (F-6).
    const baselineMs = Date.parse(String(state.earlyoom?.baselineAt || state.lastRunAt || state.earlyoom?.lastEventAt || ''));
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

  // --- External termination evidence and the durable memory ledger ----------
  // A SIGKILLed server/executor cannot write its own marker. This monitor is the
  // later external observer: it compares the durable server/executor identity
  // with live `/proc` state, so a marker is only written for a process that is
  // gone, and its cause comes from journal/cgroup evidence, never from a
  // self-report.
  const serverRuntime = options.serverRuntime !== undefined ? options.serverRuntime : readServerRuntimeMarker(dataDir);
  const cleanShutdown = options.cleanShutdown !== undefined ? options.cleanShutdown : readCleanShutdownMarker(dataDir);
  const executorRegistry = { ...(options.executorRegistry !== undefined
    ? (options.executorRegistry || {})
    : readExecutorRegistry(dataDir)) };
  // Provider-owned servers live only in their own ownership registry; merge by
  // pid so an entry present in both registries is measured once.
  for (const monitor of listProcessMonitors()) {
    for (const executor of monitor.listExecutors(registry)) {
      if (!executorRegistry[String(/** @type {Dict} */ (executor).pid)]) executorRegistry[String(/** @type {Dict} */ (executor).pid)] = executor;
    }
  }
  const exitEvents = (options.exitEvents !== undefined ? options.exitEvents : readChildExitEvents(dataDir))
    .filter((event) => {
      const at = Date.parse(String(event?.exitedAt || ''));
      return !Number.isFinite(at) || nowMs - at <= EXIT_EVENT_MAX_AGE_MS;
    });
  const observedServer = observeServerRuntime(serverRuntime, probes);
  const { live: liveExecutors, stale: staleExecutors } = observeExecutors(executorRegistry, probes);
  const previousExecutors = Object.values(state.executors || {}).filter((row) => Number(row?.pid) > 0);
  const reportedKeys = new Set(Array.isArray(state.termination?.reported) ? state.termination.reported : []);
  // Durable runtime identity is usable even when monitor state was lost: the
  // current marker (if it is not the live process any more) and the identity the
  // last boot superseded. A matching clean-shutdown marker means that identity
  // was retired normally, so it must not trigger a journal read on every run.
  const runtimeCandidates = [
    ...(serverRuntime?.history || []),
    serverRuntime?.previous,
    serverRuntime,
  ].filter(Boolean);
  const previousServers = [];
  const previousServerKeys = new Set();
  for (const candidate of [state.server, ...runtimeCandidates]) {
    if (!Number(candidate?.pid)) continue;
    if (isCoveredByCleanShutdown(cleanShutdown, candidate) || isSameLiveServer(candidate, observedServer)) continue;
    const key = `${candidate.pid}:${candidate.startedAt || ''}`;
    if (previousServerKeys.has(key)) continue;
    previousServerKeys.add(key);
    previousServers.push(candidate);
  }
  const unknownKeys = (Array.isArray(state.termination?.unknown) ? state.termination.unknown : [])
    .filter((row) => row?.key && nowMs - Date.parse(String(row.at || '')) <= UNKNOWN_MARKER_ENRICH_WINDOW_MS)
    .map((row) => row.key);
  const unknownKeySet = new Set(unknownKeys);
  // Cause each weakly-classified key was last reported with (legacy rows: unknown).
  const weakCauseRank = (cause) => (cause === 'oom-kill' ? 2 : cause === 'sigkill' ? 1 : 0);
  const unknownCauseByKey = new Map((Array.isArray(state.termination?.unknown) ? state.termination.unknown : [])
    .filter((row) => row?.key)
    .map((row) => [row.key, row.cause === 'sigkill' ? 'sigkill' : 'unknown']));
  const potentialTerminations = countPotentialTerminations({
    previousServers,
    exitEvents,
    unknownKeys,
    observedServer,
    liveExecutors,
    staleExecutors,
    previousState: state,
    reportedKeys,
  });
  const terminationSince = state.lastRunAt || new Date(nowMs - TERMINATION_JOURNAL_LOOKBACK_MS).toISOString();
  let terminationJournal = options.terminationJournal;
  if (terminationJournal === undefined && potentialTerminations > 0) {
    terminationJournal = typeof probes.readTerminationJournal === 'function'
      ? probes.readTerminationJournal({
          afterCursor: state.termination?.cursor || '',
          since: terminationSince,
          unit: config.serverUnit,
          oomdUnit: config.oomdUnit,
        })
      : { available: false, cursor: '', entries: [], warning: 'termination journal probe is unavailable.' };
  }
  if (terminationJournal?.available === false) {
    warnings.push(String(terminationJournal.warning || 'termination journal is unavailable; cause stays unknown.'));
  } else if (terminationJournal?.warning) {
    warnings.push(String(terminationJournal.warning));
  }

  const journalEvidence = terminationJournal?.entries || [];
  const evidenceLines = new Set(journalEvidence.map((entry) => entry.line));
  const evidence = [...journalEvidence, ...earlyoomEvidence.filter((entry) => !evidenceLines.has(entry.line))];

  const cgroupPath = (observedServer?.alive && observedServer.pid
    ? readServerCgroupPath(observedServer.pid, probes)
    : '') || String(state.cgroup?.path || '');
  const cgroupSnapshot = readCgroupSnapshot(cgroupPath, probes);
  const cgroupBefore = options.cgroupBefore !== undefined ? options.cgroupBefore : (state.cgroup || null);
  const cgroupAfter = options.cgroupAfter !== undefined ? options.cgroupAfter : (cgroupSnapshot || null);

  // Logical cgroup path ("/system.slice/cretli.service") of the server; executors
  // inherit it, so pidless oomd / unit evidence is correlated against it.
  const targetCgroups = cgroupPath ? [cgroupPath.replace(/^\/sys\/fs\/cgroup/, '') || '/'] : [];
  // Keys the caller has already fully handled must not be re-detected, and must
  // not consume the per-run batch cap inside `detectUnexpectedTerminations`: a
  // long acknowledged backlog would otherwise be re-selected every tick and
  // starve genuinely new terminations (R1A1-F2). The unknown re-examination
  // window is excluded from the skip set so those targets keep getting re-emitted
  // for late enrichment.
  let pendingFromState = (Array.isArray(state.termination?.pending) ? state.termination.pending : [])
    .slice(0, MAX_PENDING_MARKERS);
  let overflowFromState = (Array.isArray(state.termination?.overflow) ? state.termination.overflow : [])
    .slice(0, MAX_CLASSIFIED_OVERFLOW);
  const pendingKeysFromState = new Set(pendingFromState.map((marker) => terminationTargetKey(marker)));
  const skipKeys = new Set([
    ...[...reportedKeys].filter((key) => !unknownKeySet.has(key)),
    ...pendingKeysFromState,
    ...overflowFromState.map((marker) => terminationTargetKey(marker)),
  ]);
  const targetUnits = [config.serverUnit, targetCgroups[0] ? path.posix.basename(targetCgroups[0]) : ''].filter(Boolean);
  const terminationDetection = detectUnexpectedTerminations({
    previousServers,
    exitEvents,
    targetUnits,
    targetCgroups,
    observedServer,
    cleanShutdown,
    previousExecutors,
    liveExecutors,
    staleExecutors,
    evidence,
    evidenceAvailable: terminationJournal ? terminationJournal.available !== false : true,
    cgroupBefore,
    cgroupAfter,
    // F2/F4: acknowledged/pending targets are skipped (and exempt from the cap);
    // unknown-window targets are re-emitted but also exempt from the cap.
    reportedKeys: [...skipKeys],
    unknownKeys: [...unknownKeySet],
    maxTotalTargets: Math.max(0, MAX_CLASSIFIED_OVERFLOW - overflowFromState.length),
  });
  // R17-AUD-F2: retrying a weak or staged marker must not hide stronger
  // evidence consumed in the same run. The main detection skips those keys to
  // protect the batch cap, so re-classify only them here; the cursor below may
  // advance past this evidence and a later source read will not return it.
  const markerStrength = (marker) => weakCauseRank(marker?.cause) * 10
    + (marker?.confidence === 'confirmed' ? 2 : marker?.confidence === 'probable' ? 1 : 0);
  const retryPriorByKey = new Map();
  for (const marker of [...pendingFromState, ...overflowFromState]) {
    const key = terminationTargetKey(marker);
    const current = retryPriorByKey.get(key);
    if (!current || markerStrength(marker) > markerStrength(current)) retryPriorByKey.set(key, marker);
  }
  const retryTargets = [...retryPriorByKey.values()];
  const retryDetection = retryTargets.length > 0
    ? detectUnexpectedTerminations({
      previousServers: retryTargets.filter((marker) => marker.target === 'server' && Number(marker.pid) > 0),
      previousExecutors: retryTargets.filter((marker) => marker.target !== 'server' && Number(marker.pid) > 0),
      exitEvents: exitEvents.filter((event) => retryPriorByKey.has(
        terminationTargetKey({ target: 'executor', pid: event.pid, startedAt: event.startedAt }),
      )),
      liveExecutors,
      targetUnits,
      targetCgroups,
      observedServer,
      cleanShutdown,
      evidence,
      evidenceAvailable: terminationJournal ? terminationJournal.available !== false : true,
      cgroupBefore,
      cgroupAfter,
    })
    : { targets: [] };
  // R8C1-R17R2REG1: an end of life learned during the retry must be kept even
  // when it does not raise the classification strength. A legacy
  // sigkill/probable pending marker carries no boundary; the retry's exit event
  // knows `exitedAt`. Dropping that metadata left the stored marker
  // boundary-less, so a later OOM line for a recycled pid could be attributed to
  // the dead instance as `confirmed`. Merge the boundary only (never the
  // cause/confidence) below.
  const retryLifecycleByKey = new Map();
  for (const target of retryDetection.targets) {
    const key = terminationTargetKey(target);
    const prior = retryPriorByKey.get(key);
    if (!prior || !Number.isFinite(target.endMs)) continue;
    const priorHasBoundary = (Number.isFinite(Number(prior.endMs)) && Number(prior.endMs) > 0)
      || Boolean(prior.exitedAt) || Boolean(prior.endedAt);
    if (!priorHasBoundary) retryLifecycleByKey.set(key, target.endMs);
  }
  const withRetryLifecycle = (marker) => {
    const endMs = retryLifecycleByKey.get(terminationTargetKey(marker));
    return endMs === undefined ? marker : { ...marker, endMs };
  };
  if (retryLifecycleByKey.size > 0) {
    pendingFromState = pendingFromState.map(withRetryLifecycle);
    overflowFromState = overflowFromState.map(withRetryLifecycle);
  }
  const retryEnrichments = retryDetection.targets.filter((target) => {
    const prior = retryPriorByKey.get(terminationTargetKey(target));
    return Boolean(prior) && markerStrength(target) > markerStrength(prior);
  });
  const supersededRetryKeys = new Set(retryEnrichments.map((target) => terminationTargetKey(target)));
  // Markers that failed to persist earlier are retried first; they stay pending
  // (and unacknowledged) until a write really succeeds.
  const persistedKeys = [];
  const pendingMarkers = [];
  const unknownRows = unknownKeys.map((key) => (state.termination.unknown || []).find((row) => row.key === key));
  const markerKey = (marker) => terminationTargetKey(marker);
  const tryPersist = (marker) => {
    if (!write) return false;
    try {
      writeOomMarker(dataDir, marker, nowMs);
      return true;
    } catch (error) {
      warnings.push(`Could not persist an OOM marker (kept for retry): ${String(error?.message || error).slice(0, 200)}`);
      return false;
    }
  };
  const persistedUnknownKeys = [];
  for (const marker of pendingFromState) {
    if (tryPersist(marker)) {
      persistedKeys.push(markerKey(marker));
      // A pending unknown marker that finally persists must stay in the unknown
      // re-examination window, or its later enrichment would be lost (R1A2-F4).
      if (marker.cause === 'unknown' || marker.cause === 'sigkill') persistedUnknownKeys.push({ key: markerKey(marker), cause: marker.cause });
    } else {
      pendingMarkers.push(marker);
    }
  }
  // A target reported earlier with an `unknown` cause is re-examined: late
  // evidence upgrades it with an enriching marker instead of being ignored.
  // Stronger evidence found while a weak marker was pending/staged joins the
  // same batch, so the new read is persisted before the cursor advances.
  const freshTerminations = [
    ...terminationDetection.targets.filter((target) => {
      const key = terminationTargetKey(target);
      if (unknownKeySet.has(key)) return weakCauseRank(target.cause) > weakCauseRank(unknownCauseByKey.get(key));
      return !reportedKeys.has(key);
    }),
    ...retryEnrichments,
  ];
  // A stronger re-read replaces the weak retry for the same target; keeping the
  // stale marker would waste a retry slot and could land before the stronger one.
  // Dropping the superseded marker also frees its outbox slot, so the stronger
  // replacement can be written in this run even when the queue is full.
  // R8A1-R17AUDF2: a pending marker whose write finally succeeded frees its
  // outbox slot too (`pendingFromState.length - pendingMarkers.length`). Counting
  // only failed-write removals left the write budget at 0 after a successful
  // drain, so this run's enrichment plus the whole staged backlog exceeded the
  // classified bound and `slice(0, MAX_...)` dropped an earlier staged record —
  // possibly the only kernel/confirmed proof already read before an accepted
  // cursor.
  let freedPendingSlots = pendingFromState.length - pendingMarkers.length;
  for (let i = pendingMarkers.length - 1; i >= 0; i -= 1) {
    if (supersededRetryKeys.has(terminationTargetKey(pendingMarkers[i]))) {
      pendingMarkers.splice(i, 1);
      freedPendingSlots += 1;
    }
  }
  const freshMarkers = freshTerminations.map((target) => createOomMarkerRecord({
    target: target.target,
    pid: target.pid,
    startedAt: target.startedAt,
    type: target.type,
    label: target.label,
    cause: target.cause,
    source: target.source,
    confidence: target.confidence,
    basis: target.basis,
    reason: target.reason,
    evidence: target.evidence,
    // The end of the instance's life travels with the marker: a later retry
    // passes the marker back as `previousExecutor`, and without the boundary it
    // could attribute a kill of a *reused* pid to the dead instance
    // (R17-R2-REG1).
    ...(target.endMs !== undefined && target.endMs !== null ? { endMs: target.endMs } : {}),
    ...(target.exitedAt !== undefined ? { exitedAt: target.exitedAt } : {}),
    ...(target.endedAt !== undefined ? { endedAt: target.endedAt } : {}),
    detectedAt: new Date(nowMs).toISOString(),
    serverPid: observedServer?.alive ? observedServer.pid : null,
    ...(unknownKeySet.has(terminationTargetKey(target)) ? { enrichesEarlierUnknown: true } : {}),
  }, nowMs));
  const stagedMarkers = overflowFromState.filter((marker) => !supersededRetryKeys.has(terminationTargetKey(marker)));
  // R8A1-R17AUDF2: a retry enrichment is the only proof for a weak marker that
  // was re-read in this run, and the source may never return it again. Keeping it
  // behind the whole staged backlog let `nextOverflow.slice(0, MAX_...)` delete
  // exactly that stronger record while the cursor advanced past its evidence, so
  // retries are written (and staged) first.
  const freshRetryMarkers = [];
  const freshNewMarkers = [];
  for (const marker of freshMarkers) {
    (supersededRetryKeys.has(markerKey(marker)) ? freshRetryMarkers : freshNewMarkers).push(marker);
  }
  const terminationMarkers = [...freshRetryMarkers, ...stagedMarkers, ...freshNewMarkers];
  const acknowledged = [];
  const pendingRetryMarkers = [];
  let writeBudget = Math.max(0, MAX_PENDING_MARKERS - pendingFromState.length + freedPendingSlots);
  // An enrichment that lands in the deferred backlog was not persisted, so its
  // journal evidence would be lost if the cursor moved on: pin the checkpoints
  // for this run (same semantics as `hasTerminationOverflow`).
  let hasUnwrittenRetryEnrichment = false;
  // Deferred records are bucketed so the bound can never evict an earlier staged
  // record (R8A1-R17AUDF2). A staged record is proof already read before its
  // cursor was accepted; an enrichment this run is re-read next run because the
  // cursor stays pinned when it is dropped.
  const stagedMarkerSet = new Set(stagedMarkers);
  const deferredRetry = [];
  const deferredStaged = [];
  const deferredFresh = [];
  const defer = (marker, isRetryEnrichment) => {
    if (isRetryEnrichment) {
      hasUnwrittenRetryEnrichment = true;
      deferredRetry.push(marker);
    } else if (stagedMarkerSet.has(marker)) {
      deferredStaged.push(marker);
    } else {
      deferredFresh.push(marker);
    }
  };
  for (const marker of terminationMarkers) {
    const isRetryEnrichment = supersededRetryKeys.has(markerKey(marker));
    if (writeBudget <= 0) {
      defer(marker, isRetryEnrichment);
      continue;
    }
    writeBudget -= 1;
    if (tryPersist(marker)) {
      acknowledged.push(markerKey(marker));
    }
    // Retried enrichments are appended last so the bounded outbox tail (`slice`)
    // can never drop the strongest proof in favour of an older staged record.
    else if (write) (isRetryEnrichment ? pendingRetryMarkers : pendingMarkers).push(marker);
    else defer(marker, isRetryEnrichment);
  }
  let nextOverflow = [...deferredRetry, ...deferredStaged, ...deferredFresh];
  let deferredOverflowCount = 0;
  if (nextOverflow.length > MAX_CLASSIFIED_OVERFLOW) {
    // The retry accounting above keeps this branch theoretical; it is a hard
    // guard, not a drop policy. New evidence is evicted before a stronger retry
    // and an earlier staged record is never evicted at all: dropping one would
    // silently lose proof whose cursor already moved.
    const excess = nextOverflow.length - MAX_CLASSIFIED_OVERFLOW;
    const droppedFresh = Math.min(excess, deferredFresh.length);
    const droppedRetry = Math.min(excess - droppedFresh, deferredRetry.length);
    deferredOverflowCount = droppedFresh + droppedRetry;
    if (deferredOverflowCount > 0) hasUnwrittenRetryEnrichment = true;
    nextOverflow = [
      ...deferredRetry.slice(0, deferredRetry.length - droppedRetry),
      ...deferredStaged,
      ...deferredFresh.slice(0, deferredFresh.length - droppedFresh),
    ];
  }
  pendingMarkers.push(...pendingRetryMarkers);
  const acknowledgedKeys = new Set([...persistedKeys, ...acknowledged]);
  // Targets first reported (this run) as unknown stay re-examinable for a while.
  const nextUnknown = [
    ...unknownRows.filter((row) => row && !acknowledgedKeys.has(row.key) && !supersededRetryKeys.has(row.key)),
    ...persistedUnknownKeys
      .filter(({ key }) => !supersededRetryKeys.has(key))
      .map(({ key, cause }) => ({ key, cause, at: new Date(nowMs).toISOString() })),
    ...terminationMarkers
      .filter((marker) => (marker.cause === 'unknown' || marker.cause === 'sigkill')
        && acknowledgedKeys.has(markerKey(marker))
        && !supersededRetryKeys.has(markerKey(marker)))
      .map((marker) => ({ key: markerKey(marker), cause: marker.cause, at: new Date(nowMs).toISOString() })),
  ].slice(-MAX_UNKNOWN_MARKERS);
  const newlyReportedKeys = write ? [...acknowledgedKeys] : [];
  const hasTerminationOverflow = terminationDetection.overflowCount > 0
    || hasUnwrittenRetryEnrichment
    || deferredOverflowCount > 0;
  if (terminationDetection.overflowCount > 0) {
    warnings.push(
      `OOM classified-record staging reached its ${MAX_CLASSIFIED_OVERFLOW}-record bound; source checkpoints remain pinned with ${terminationDetection.overflowCount} unclassified target(s).`,
    );
  }
  if (hasUnwrittenRetryEnrichment) {
    warnings.push('An OOM retry enrichment could not be persisted in this batch; source checkpoints remain pinned so the stronger evidence is not lost.');
  }
  if (deferredOverflowCount > 0) {
    // Never claim the overflow is durably staged when this-run evidence was
    // dropped instead of evicting earlier staged proof: say what waits and how
    // much was written (R8A1-R17AUDF2).
    warnings.push(
      `OOM classified backlog is full at ${MAX_CLASSIFIED_OVERFLOW} durable record(s); ${deferredOverflowCount} this-run classification(s) stay deferred and source checkpoints remain pinned instead of evicting earlier staged proof.`,
    );
  }
  if (nextOverflow.length > 0) {
    warnings.push(`OOM classified backlog contains ${nextOverflow.length}/${MAX_CLASSIFIED_OVERFLOW} durable record(s) after writing ${persistedKeys.length + acknowledged.length} this run; marker writes will drain it in bounded batches.`);
  }
  const nextTerminationCursor = hasTerminationOverflow
    ? String(state.termination?.cursor || '')
    : String(terminationJournal?.cursor || state.termination?.cursor || '');

  // One sample per run, including an unreadable/gone server or executor as an
  // explicit `null`, so a missing process is never accounted as zero.
  const memory = measureMemory({
    serverPid: observedServer?.alive ? observedServer.pid : null,
    executors: liveExecutors.map((entry) => ({ pid: entry.pid, type: entry.type, label: entry.label })),
    readRss: typeof probes.readProcessRss === 'function' ? probes.readProcessRss : readProcessRssBytes,
  });
  if (write) {
    try {
      appendMemoryLedger(dataDir, {
        hostTotalBytes: Number.isFinite(host?.totalBytes) ? host.totalBytes : null,
        hostAvailableBytes: Number.isFinite(host?.availableBytes) ? host.availableBytes : null,
        ...memory,
      }, nowMs);
    } catch (error) {
      warnings.push(`Could not persist the memory ledger: ${String(error?.message || error).slice(0, 200)}`);
    }
  }

  const evaluation = evaluateMemoryMonitor({
    now: nowMs,
    config,
    host,
    processes,
    registry,
    previousState: state,
    earlyoom,
    probes: /** @type {{ isProcessAlive: (pid: number) => boolean, getProcessStartTime: (pid: number) => string }} */ (probes),
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

  // Keep (or start) the first-run earlyoom baseline only while the journal
  // cursor cannot advance; once it is stored the cursor replaces the baseline.
  const pinnedEarlyoomBaselineAt = hasTerminationOverflow && earlyoom?.available && !state.earlyoom?.cursor
    ? (state.earlyoom?.baselineAt || (state.lastRunAt ? '' : new Date(nowMs).toISOString()))
    : '';

  const nextState = {
    version: MEMORY_MONITOR_SCHEMA_VERSION,
    updatedAt: new Date(nowMs).toISOString(),
    lastRunAt: hasTerminationOverflow ? terminationSince : new Date(nowMs).toISOString(),
    episodes: episodeResult.episodes,
    lastSwapUsedBytes: swapUsedBytes,
    lastSwapAt: new Date(nowMs).toISOString(),
    earlyoom: {
      cursor: hasTerminationOverflow ? String(state.earlyoom?.cursor || '') : String(earlyoom?.cursor || state.earlyoom?.cursor || ''),
      // While the cursor is pinned the same journal batch is replayed, so every
      // fingerprint of that batch must survive; the normal cap would let the
      // overflow beyond 100 entries alert again on each tick (F-5).
      seen: [...new Set([...reportedEarlyoomFingerprints, ...seenEarlyoomFingerprints])]
        .slice(0, hasTerminationOverflow ? MAX_EARLYOOM_SEEN_REPLAY : MAX_EARLYOOM_SEEN),
      ...(pinnedEarlyoomBaselineAt ? { baselineAt: pinnedEarlyoomBaselineAt } : {}),
    },
    // Durable liveness observations used by the next run to spot a process that
    // disappeared between two monitor runs.
    server: hasTerminationOverflow ? (state.server || null) : observedServer?.alive
      ? {
          pid: observedServer.pid,
          startedAt: observedServer.startedAt,
          instanceToken: observedServer.instanceToken,
          lastSeenAt: new Date(nowMs).toISOString(),
        }
      : null,
    executors: hasTerminationOverflow ? (state.executors || {}) : Object.fromEntries(liveExecutors.map((entry) => [
      `${entry.pid}:${entry.startedAt || ''}`,
      {
        pid: entry.pid,
        startedAt: entry.startedAt || '',
        type: entry.type || 'child',
        label: entry.label || '',
        lastSeenAt: new Date(nowMs).toISOString(),
      },
    ])),
    cgroup: hasTerminationOverflow ? (state.cgroup || null) : cgroupSnapshot?.available && cgroupPath
      ? { path: cgroupPath, events: cgroupSnapshot.events || null }
      : null,
    termination: {
      cursor: nextTerminationCursor,
      evidenceAvailable: terminationJournal
        ? terminationDetection.evidenceAvailable
        : Boolean(state.termination?.evidenceAvailable),
      reported: [...reportedKeys, ...newlyReportedKeys].slice(-200),
      pending: pendingMarkers.slice(-MAX_PENDING_MARKERS),
      overflow: nextOverflow.slice(0, MAX_CLASSIFIED_OVERFLOW),
      unknown: nextUnknown,
      lastDetectedAt: freshTerminations.length > 0
        ? new Date(nowMs).toISOString()
        : String(state.termination?.lastDetectedAt || ''),
    },
    memory: {
      serverRssBytes: memory.serverRssBytes,
      executorsRssBytes: memory.executorsRssBytes,
      executorCount: memory.executorCount,
      unreadable: memory.unreadable,
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
    terminationMarkers,
    termination: {
      potential: potentialTerminations,
      detected: freshTerminations.length,
      evidenceRead: terminationJournal !== undefined,
      evidenceAvailable: terminationDetection.evidenceAvailable,
      evidenceCount: terminationDetection.evidenceCount,
      cgroupDelta: terminationDetection.cgroupDelta,
      journalCursor: nextTerminationCursor,
      overflowCount: terminationDetection.overflowCount + nextOverflow.length,
      serverAlive: Boolean(observedServer?.alive),
      executorCount: liveExecutors.length,
      staleExecutorCount: staleExecutors.length,
    },
    memory: {
      serverRssBytes: memory.serverRssBytes,
      executorsRssBytes: memory.executorsRssBytes,
      executorCount: memory.executorCount,
      unreadable: memory.unreadable,
    },
    ledgerPath: path.join(dataDir, MEMORY_LEDGER_FILE),
    written,
    skipped,
    alertFilePath,
    statePath: getMemoryMonitorStatePath(dataDir),
    state: nextState,
    exitCode: evaluation.thresholdExceeded ? 1 : 0,
  };
}
