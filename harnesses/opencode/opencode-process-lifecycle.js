/**
 * OpenCode process lifecycle hook (`processLifecycle` on the provider
 * descriptor, typed in lib/agent-harness/harness-plugin-contract.ts).
 *
 * Owns everything core used to know about OpenCode processes by name: the boot
 * sweep, the two shutdown phases, instance counters, the ports Browser must not
 * reach, and the memory monitor's classification of `opencode serve` processes.
 *
 * Deliberately light: the server manager is imported lazily in `start()`, so the
 * memory monitor can load this module without pulling in the chat runtime.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  createOpenCodeProcessProbes,
  isRegistryOwnerAlive,
  normalizeOpenCodePortOwner,
  readOpenCodePortRegistryRaw,
} from './opencode-port-registry.js';

const DEFAULT_MAX_PROCESSES = 10;

/**
 * Preloaded in `start()` so phase 1 of shutdown can run synchronously. Null only
 * during early boot, when no instance can exist yet.
 *
 * @type {typeof import('./opencode-server-manager.js') | null}
 */
let managerModule = null;

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
 * Registry entries grouped by whether their owner server (PID + start time) is
 * alive. Orphans are entries whose owner is dead while the recorded OpenCode
 * process still runs. Parent PID is never the criterion: on WSL an orphan is
 * re-parented to Relay/init with an unrelated PID.
 *
 * @param {{
 *   registry: Record<string, unknown>,
 *   processes: Array<{ pid: number, ppid: number, rssBytes: number, args: string, startTime: string }>,
 *   probes: { isProcessAlive: (pid: number) => boolean, getProcessStartTime: (pid: number) => string, findListeningPid?: (port: number) => number },
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
    const ownerAlive = isRegistryOwnerAlive(entry, self, /** @type {any} */ (input.probes));
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
 * Managed OpenCode servers from the dedicated ownership registry, shaped like
 * executor rows. They are intentionally absent from `child-processes.json`, so
 * the monitor must read the OpenCode registry too. Keyed by pid by the caller,
 * so an entry present in both registries is counted once.
 *
 * @param {Record<string, unknown> | null | undefined} registry
 * @returns {object[]}
 */
export function openCodeExecutorsFromRegistry(registry) {
  const out = [];
  for (const rawOwner of Object.values(registry || {})) {
    const entry = normalizeOpenCodePortOwner(rawOwner);
    if (!entry || !(entry.opencodePid > 0)) continue;
    out.push({
      pid: entry.opencodePid,
      type: 'opencode-serve',
      label: `opencode serve :${/** @type {any} */ (entry).port || ''}`.trim(),
      startedAt: String(entry.opencodeStartedAt || ''),
    });
  }
  return out;
}

/**
 * Same numeric env override rule as the monitor: empty/invalid falls back.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {number}
 */
function readMaxProcesses(env) {
  const raw = env?.CRETLI_MEMORY_MONITOR_MAX_OPENCODE;
  if (raw == null || String(raw).trim() === '') return DEFAULT_MAX_PROCESSES;
  const parsed = Number(String(raw).trim());
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_MAX_PROCESSES;
}

/**
 * @param {{
 *   processes: Array<{ pid: number, ppid: number, args: string }>,
 *   registry?: Record<string, unknown>,
 *   probes: object,
 *   config: { maxOpenCodeProcesses: number },
 *   topProcesses: object[],
 * }} input
 * @returns {import('../../lib/agent-harness/harness-plugin-contract.ts').HarnessProcessMonitorEvaluation}
 */
function evaluateOpenCodeProcesses(input) {
  const { processes, config, topProcesses } = input;
  const { managedPids, orphaned, stale } = classifyManagedOpenCode({
    registry: input.registry || {},
    processes: /** @type {any} */ (processes),
    probes: /** @type {any} */ (input.probes),
  });
  const serveProcesses = processes.filter((row) => isOpenCodeServeProcess(row.args));
  const managedProcesses = serveProcesses.filter((row) => managedPids.has(row.pid));
  const foreignProcesses = serveProcesses.filter((row) => !managedPids.has(row.pid));
  const triggered = [];
  const episodeAlerts = [];
  if (orphaned.length > 0) {
    triggered.push('opencode-orphan');
    episodeAlerts.push({
      type: 'opencode-orphan',
      severity: 'warning',
      title: 'Orphaned OpenCode process',
      message: `${orphaned.length} OpenCode serve process(es) belong to a dead Cretli server (owner PID + start time no longer live).`,
      fingerprintBase: 'memory-monitor:opencode-orphan',
      details: {
        orphaned: orphaned.map((row) => ({
          port: row.port,
          pid: /** @type {any} */ (row.process).pid,
          ppid: row.ppid,
          serverPid: /** @type {any} */ (row.entry).serverPid,
          serverStartedAt: /** @type {any} */ (row.entry).serverStartedAt,
          port_owner: /** @type {any} */ (row.entry).instanceKey,
        })),
        stale,
        topProcesses,
      },
    });
  }
  if (serveProcesses.length > config.maxOpenCodeProcesses) {
    triggered.push('opencode-count-high');
    episodeAlerts.push({
      type: 'opencode-count-high',
      severity: 'warning',
      title: 'High OpenCode serve process count',
      message: `${serveProcesses.length} opencode serve processes are running (threshold > ${config.maxOpenCodeProcesses}); one instance per chat is normal.`,
      fingerprintBase: 'memory-monitor:opencode-count-high',
      details: { count: serveProcesses.length, threshold: config.maxOpenCodeProcesses, topProcesses },
    });
  }
  return {
    triggered,
    episodeAlerts,
    fields: {
      managed: {
        count: managedProcesses.length,
        processes: managedProcesses.map((row) => ({ pid: row.pid, ppid: row.ppid })),
        pids: [...managedPids],
      },
      orphaned: orphaned.map((row) => ({ port: row.port, pid: /** @type {any} */ (row.process).pid, ppid: row.ppid })),
      stale,
      foreign: foreignProcesses.map((row) => ({ pid: row.pid, ppid: row.ppid, port: readOpenCodeServePort(row.args) })),
      opencodeTotal: serveProcesses.length,
    },
  };
}

/**
 * @param {any} evaluation
 * @param {{ maxOpenCodeProcesses?: number }} config
 * @returns {string[]}
 */
function formatOpenCodeReport(evaluation, config) {
  return [
    `  managed opencode: ${evaluation.managed.count} live, ${evaluation.orphaned.length} orphaned,`
      + ` ${evaluation.stale.length} stale registry entr${evaluation.stale.length === 1 ? 'y' : 'ies'}`,
    `  foreign opencode: ${evaluation.foreign.length}`
      + (evaluation.foreign.length ? ` (pids ${evaluation.foreign.map((row) => row.pid).join(', ')})` : ''),
    `  opencode serve total: ${evaluation.opencodeTotal} (threshold > ${config.maxOpenCodeProcesses})`,
  ];
}

/** @type {import('../../lib/agent-harness/harness-plugin-contract.ts').HarnessProcessMonitor} */
const OPENCODE_PROCESS_MONITOR = Object.freeze({
  defaultConfig: Object.freeze({ maxOpenCodeProcesses: DEFAULT_MAX_PROCESSES }),
  resolveConfig: (env) => ({ maxOpenCodeProcesses: readMaxProcesses(env) }),
  readRegistry: (registryPath) => readOpenCodePortRegistryRaw(registryPath),
  createProbes: () => ({ findListeningPid: createOpenCodeProcessProbes().findListeningPid }),
  listExecutors: openCodeExecutorsFromRegistry,
  evaluate: evaluateOpenCodeProcesses,
  formatReport: formatOpenCodeReport,
});

/** @type {import('../../lib/agent-harness/harness-plugin-contract.ts').HarnessProcessLifecycle} */
export const OPENCODE_PROCESS_LIFECYCLE = Object.freeze({
  id: 'opencode',
  label: 'OpenCode',
  // A SIGKILL/earlyoom never reaches the shutdown handler, so any OpenCode
  // process owned by the previous server is an orphan: reclaim them from the
  // ownership registry before the first instance of this process exists.
  async start() {
    managerModule = await import('./opencode-server-manager.js');
    const sweep = await managerModule.reconcileOpenCodePortRegistry();
    const summary = [
      sweep.killed.length ? `stopped ${sweep.killed.length}` : '',
      sweep.removed.length ? `removed ${sweep.removed.length}` : '',
      sweep.kept.length ? `kept ${sweep.kept.length}` : '',
    ].filter(Boolean).join(', ');
    return { summary };
  },
  // Warm the first instance in the background when a credential is configured.
  async warmUp() {
    const { hasOpenCodeCredentials } = await import('./opencode-api-key.js');
    if (!hasOpenCodeCredentials()) return { skipped: true };
    const manager = await import('./opencode-server-manager.js');
    return manager.warmUpOpenCodeFromSettings();
  },
  beginStop: () => managerModule?.beginOpenCodeShutdown?.() || null,
  finishStop: async () => (managerModule?.finishOpenCodeShutdown
    ? await managerModule.finishOpenCodeShutdown()
    : null),
  getStats: () => managerModule?.getOpenCodeInstanceStats?.() || null,
  listInternalPorts(dataDir) {
    const ports = [];
    try {
      const raw = JSON.parse(readFileSync(path.join(dataDir, 'opencode-ports.json'), 'utf8'));
      for (const key of Object.keys(raw || {})) {
        const port = Number.parseInt(key, 10);
        if (Number.isInteger(port) && port > 0 && port <= 65535) ports.push(port);
      }
    } catch {
      // no ports file -> nothing to protect
    }
    return ports;
  },
  monitor: OPENCODE_PROCESS_MONITOR,
});
