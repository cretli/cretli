import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { countChildProcesses } from './child-processes.js';
import { getExternalJobTimings } from '../periodic-job-runner.js';
import { evaluateLoadAlarms, resolveLoadThresholds } from './thresholds.js';

const PS_CACHE_MS = 5000;
const EMPTY_CHILDREN = { claude: 0, opencode: 0, mcp: 0, tests: 0, other: 0, total: 0 };
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
  let disk = { path: worktreeDir, freeMb: /** @type {number|null} */ (null) };
  let sampledAt = 0;
  let inflight = null;

  function refresh() {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        children = countChildProcesses(await (deps.readProcesses || readPs)(), process.pid);
        disk = await (deps.readDisk || readFreeDisk)(worktreeDir);
        sampledAt = now();
      } catch {
        // Keep the previous sample; a failed probe must not break health.
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  /** Current snapshot; thresholds are re-read each call so env changes apply on restart only. */
  function get() {
    if (now() - sampledAt > PS_CACHE_MS) void refresh();
    const thresholds = resolveLoadThresholds(env, deps.thresholds);
    const lag = deps.getEventLoopLag();
    const allRoutes = deps.routeTimings ? deps.routeTimings.summarize({ top: 10 }) : [];
    const routes = allRoutes.slice(0, 5);
    const cpus = os.cpus().length || 1;
    const loadAvg = os.loadavg().map((v) => Math.round(v * 100) / 100);
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
    const snapshot = { eventLoopLagMs: lag, routeP95Ms, routes, children, disk, loadAvg, cpus, sampledAt, periodicJobs, ...(jobQueue ? { jobQueue } : {}) };
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
