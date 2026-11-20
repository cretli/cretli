import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { countChildProcesses } from './child-processes.js';
import { getExternalJobTimings } from '../periodic-job-runner.js';
import { evaluateLoadAlarms, resolveLoadThresholds } from './thresholds.js';
import { readServerMetrics } from './server-metrics.js';

const PS_CACHE_MS = 5000;
const EMPTY_CHILDREN = { claude: 0, opencode: 0, mcp: 0, tests: 0, other: 0, total: 0 };
const HOST_HISTORY_LIMIT = 12;
// Routes that wait by design (MCP bridge calls carry delegation_wait /
// operator_chat_wait long polls of up to minutes). They stay in `routes` but do
// not drive the interactive `routeP95Ms` alarm.
export const LONG_POLL_ROUTES = new Set(['POST /api/mcp/bridge/call', 'POST /mcp']);

/** @returns {Promise<string>} */
function readPs() {
  return new Promise((resolve) => {
    execFile('ps', ['-eo', 'pid=,ppid=,args='], { maxBuffer: 8 * 1024 * 1024, timeout: 3000 }, (err, stdout) => {
      resolve(err ? '' : String(stdout));
    });
  });
}

/**
 * Free space of the partition holding `dir` (walks up to the nearest existing
 * ancestor). `freeMb` is null when statfs is unavailable.
 *
 * @param {string} dir
 * @returns {Promise<{ path: string, freeMb: number | null }>}
 */
export async function readFreeDisk(dir) {
  let probe = path.resolve(dir);
  while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
  try {
    const st = await fs.promises.statfs(probe);
    return { path: probe, freeMb: Math.floor((Number(st.bavail) * Number(st.bsize)) / (1024 * 1024)) };
  } catch {
    return { path: probe, freeMb: null };
  }
}

/**
 * Cached load snapshot. `get()` is synchronous (last completed sample) and
 * kicks off a background refresh when stale, so /api/health never waits on `ps`.
 *
 * @param {{
 *   getEventLoopLag: () => { p50: number, p99: number, max: number, windowMs?: number },
 *   routeTimings?: ReturnType<typeof import('../metrics/route-timings.js').createRouteTimings>,
 *   worktreeDir?: string,
 *   thresholds?: Partial<typeof import('./thresholds.js').LOAD_THRESHOLD_DEFAULTS>,
 *   env?: Record<string, string|undefined>,
 *   readProcesses?: () => Promise<string>,
 *   readDisk?: (dir: string) => ReturnType<typeof readFreeDisk>,
 *   now?: () => number,
 *   getServerMetrics?: () => Record<string, any> | null,
 *   getPeriodicJobs?: () => Array<Record<string, any>>,
 *   getJobQueueMetrics?: () => Record<string, any>,
 *   lanReachability?: { get: () => { hosts: string[], unreachable: string[] } },
 * }} deps
 */
export function createLoadSnapshotProvider(deps) {
  const env = deps.env || process.env;
  const now = deps.now || Date.now;
  const worktreeDir = deps.worktreeDir || env.CRETLI_WORKTREES_DIR || path.resolve(process.cwd(), '..', '.cretli-worktrees');
  let children = EMPTY_CHILDREN;
  let dataDisk = { path: path.resolve(process.cwd(), 'data'), freeMb: /** @type {number|null} */ (null) };
  let swap = { totalBytes: null, freeBytes: null };
  const worktreeSamples = new Map();
  const refreshes = new Map();
  const worktreeHistories = new Map();

  function refresh(worktreeDirOverride) {
    const targetWorktreeDir = path.resolve(String(worktreeDirOverride || worktreeDir));
    if (refreshes.has(targetWorktreeDir)) return refreshes.get(targetWorktreeDir);
    const pending = (async () => {
      try {
        children = countChildProcesses(await (deps.readProcesses || readPs)(), process.pid);
        const [nextDisk, nextDataDisk] = await Promise.all([
          (deps.readDisk || readFreeDisk)(targetWorktreeDir),
          (deps.readDisk || readFreeDisk)(dataDisk.path),
        ]);
        dataDisk = nextDataDisk;
        let worktreeCount = null;
        try {
          worktreeCount = (await fs.promises.readdir(targetWorktreeDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).length;
        } catch {
          worktreeCount = null;
        }
        try {
          const memInfo = await fs.promises.readFile('/proc/meminfo', 'utf8');
          const total = /^SwapTotal:\s+(\d+)\s+kB/m.exec(memInfo);
          const free = /^SwapFree:\s+(\d+)\s+kB/m.exec(memInfo);
          if (total && free) swap = { totalBytes: Number(total[1]) * 1024, freeBytes: Number(free[1]) * 1024 };
        } catch {
          // Swap is unavailable on platforms without procfs.
        }
        const sample = { disk: nextDisk, worktreeCount, sampledAt: now() };
        worktreeSamples.set(targetWorktreeDir, sample);
        let history = worktreeHistories.get(targetWorktreeDir);
        if (!history) {
          history = [];
          worktreeHistories.set(targetWorktreeDir, history);
        }
        history.push(sample);
        if (history.length > HOST_HISTORY_LIMIT) history.shift();
      } catch {
        // Keep the previous sample; a failed probe must not break health.
      } finally {
        refreshes.delete(targetWorktreeDir);
      }
    })();
    refreshes.set(targetWorktreeDir, pending);
    return pending;
  }

  /** Current snapshot; thresholds are re-read each call so env changes apply on restart only. */
  function get(options = {}) {
    const requestedWorktreeDir = options.worktreeDir ? path.resolve(options.worktreeDir) : worktreeDir;
    const worktreeSample = worktreeSamples.get(requestedWorktreeDir);
    if (!worktreeSample || now() - worktreeSample.sampledAt > PS_CACHE_MS) void refresh(requestedWorktreeDir);
    const thresholds = resolveLoadThresholds(env, deps.thresholds);
    const lag = deps.getEventLoopLag();
    const allRoutes = deps.routeTimings ? deps.routeTimings.summarize({ top: 10 }) : [];
    const routes = allRoutes.slice(0, 5);
    const cpus = os.cpus().length || 1;
    const loadAvg = os.loadavg().map((v) => Math.round(v * 100) / 100);
    const totalMemoryBytes = os.totalmem();
    const freeMemoryBytes = os.freemem();
    const history = worktreeHistories.get(requestedWorktreeDir) || [];
    const hostResources = {
      loadAvg,
      loadPerCpu: loadAvg.map((value) => Math.round(value / cpus * 100) / 100),
      cpus,
      memory: { totalBytes: totalMemoryBytes, availableBytes: freeMemoryBytes },
      swap,
      worktreeDisk: { ...(worktreeSample?.disk || { path: requestedWorktreeDir, freeMb: null }), configuredPath: requestedWorktreeDir },
      dataDisk,
      worktreeCount: worktreeSample?.worktreeCount ?? null,
      sampledAt: worktreeSample?.sampledAt ?? 0,
      // Rolling 1/5/15 min loop delay, ELU, GC and heap figures (null when unavailable).
      serverMetrics: (deps.getServerMetrics || readServerMetrics)(),
    };
    hostResources.history = history.map((sample) => {
      const { history: _history, serverMetrics: _metrics, ...historyBase } = hostResources;
      return {
        ...historyBase,
        worktreeDisk: { ...sample.disk, configuredPath: requestedWorktreeDir },
        worktreeCount: sample.worktreeCount,
        sampledAt: sample.sampledAt,
      };
    });
    const interactive = allRoutes.find((row) => !LONG_POLL_ROUTES.has(row.route));
    const routeP95Ms = interactive ? interactive.p95 : 0;
    let runnerJobs = [];
    try {
      runnerJobs = deps.getPeriodicJobs ? deps.getPeriodicJobs() : [];
    } catch {
      // Job timings are diagnostic only; never break health.
    }
    // Last-run time per periodic task, to spot jobs that start in the same second.
    const periodicJobs = [
      ...runnerJobs.map((j) => ({
        id: j.id, source: 'runner', intervalMs: j.intervalMs, runs: j.runs, skipped: j.skipped,
        lastRunAt: j.lastRunAt, lastDurationMs: j.lastDurationMs, maxDurationMs: j.maxDurationMs,
      })),
      ...getExternalJobTimings().map((j) => ({ ...j, source: 'inline' })),
    ];
    /** @type {Record<string, any> | undefined} */
    let jobQueue;
    try {
      // Queue depth, running, wait per class and cache hit/miss (S4); diagnostic only.
      jobQueue = deps.getJobQueueMetrics ? deps.getJobQueueMetrics() : undefined;
    } catch {
      // Queue metrics must never break health.
    }
    const defaultWorktreeSample = worktreeSamples.get(worktreeDir);
    const snapshot = {
      eventLoopLagMs: lag,
      routeP95Ms,
      routes,
      children,
      disk: defaultWorktreeSample?.disk || { path: worktreeDir, freeMb: null },
      loadAvg,
      cpus,
      sampledAt: defaultWorktreeSample?.sampledAt ?? 0,
      hostResources,
      periodicJobs,
      ...(jobQueue ? { jobQueue } : {}),
    };
    const alarms = evaluateLoadAlarms(snapshot, thresholds);
    const lan = deps.lanReachability?.get();
    if (lan?.hosts.length) {
      // A configured LAN address that does not accept connections: the server
      // is up on localhost but phones and other devices cannot reach it.
      if (lan.unreachable.length) alarms.push('lanUnreachable');
      return { ...snapshot, thresholds, alarms, lan: { hosts: lan.hosts, unreachable: lan.unreachable } };
    }
    return { ...snapshot, thresholds, alarms };
  }

  return { get, refresh };
}
