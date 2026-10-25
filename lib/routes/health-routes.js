import { monitorEventLoopDelay } from 'node:perf_hooks';
import { createRouteTimings } from '../metrics/route-timings.js';
import { probeableLanHosts } from '../bind-host.js';
import { createLanReachability } from '../server-health/lan-reachability.js';
import { getPeriodicJobRunner } from '../delegation-runtime-boot.js';
import { createLoadSnapshotProvider } from '../server-health/load-snapshot.js';
import { getJobQueueMetricsSnapshot } from '../job-queue/metrics.js';
import { setWorkspaceWatcherStabilitySource } from '../workspace-watcher-scheduler.js';
import { getServerInstanceId } from '../sdk/sdk-instance-id.ts';
import { getSdkRoomBusMode } from '../sdk/sdk-room-bus.ts';
import { getSdkRoomRegistryMode } from '../sdk/sdk-room-registry.ts';

/**
 * @typedef {Object} HealthRoutesContext
 * @property {string} serverInstanceToken
 * @property {number} serverStartedAt
 * @property {() => string} [getFrontAssetVersion]
 * @property {{ snapshot: (event?: string, details?: Record<string, unknown>) => Record<string, unknown>, readRecent: (limit?: number) => Record<string, unknown>[] }} [serverDiagnostics]
 * @property {() => { live: number, pending: number, limit: number } | null} [getInstanceStats]
 * @property {(limit?: number) => Record<string, unknown>[]} [readMonitorAlerts]
 * @property {() => { name: string, bytes: number }[]} [listLargeDataFiles]
 * @property {(limit?: number) => Record<string, unknown>[]} [readOomMarkers]
 * @property {() => boolean} [isServerCodeStale]
 * @property {() => boolean} [hasMcpResourceAlarm]
 * @property {() => Record<string, unknown>} [readMcpResources]
 * @property {() => { state: string, changedCount: number | null, staleSinceAt: string | null }} [readServerCodeFreshness]
 */

const NS_PER_MS = 1e6;
export const EVENT_LOOP_LAG_WINDOW_MS = 10_000;
const eventLoopHistogram = monitorEventLoopDelay({ resolution: 20 });
eventLoopHistogram.enable();

/**
 * @param {import('node:perf_hooks').IntervalHistogram} histogram
 * @returns {{ p50: number, p99: number, max: number }}
 */
function summarizeEventLoopLag(histogram) {
  const round = (ns) => Math.round(ns / NS_PER_MS * 10) / 10;
  return {
    p50: round(histogram.percentile(50)),
    p99: round(histogram.percentile(99)),
    max: round(histogram.max),
  };
}

/** Last completed window; null until the first window closes. */
let lastEventLoopWindow = null;
// Windows rotate on a timer, not per request, so concurrent health pollers all
// see the same numbers instead of resetting each other's sample.
setInterval(() => {
  lastEventLoopWindow = { ...summarizeEventLoopLag(eventLoopHistogram), windowMs: EVENT_LOOP_LAG_WINDOW_MS };
  eventLoopHistogram.reset();
}, EVENT_LOOP_LAG_WINDOW_MS).unref();

/**
 * Event-loop delay in ms over the last completed window, or the current
 * partial window right after start.
 *
 * @returns {{ p50: number, p99: number, max: number, windowMs: number }}
 */
export function readEventLoopLag() {
  return lastEventLoopWindow || { ...summarizeEventLoopLag(eventLoopHistogram), windowMs: 0 };
}

const routeTimings = createRouteTimings();
const lanReachability = createLanReachability({
  hosts: probeableLanHosts(),
  port: parseInt(process.env.PORT || '3011', 10),
});
const loadSnapshotProvider = createLoadSnapshotProvider({
  getEventLoopLag: () => readEventLoopLag(),
  routeTimings,
  lanReachability,
  getPeriodicJobs: () => getPeriodicJobRunner()?.getJobsStatus() || [],
  getJobQueueMetrics: getJobQueueMetricsSnapshot,
});

/**
 * Load snapshot (event-loop lag, route p95, child processes, free disk, load
 * average, thresholds, breached alarms). Feeds the Watcher scheduler's safety
 * valve: `maxParallel` only postpones starts while these alarms are breached.
 */
export function getLoadSnapshot() {
  return loadSnapshotProvider.get();
}

setWorkspaceWatcherStabilitySource(getLoadSnapshot);

/**
 * Server-code freshness for the authorized diagnostics payload. The endpoint must
 * still answer when the detector is not wired or its getter throws, and an
 * unmeasured backend is reported as `unknown` — never as zero changed files.
 *
 * @param {HealthRoutesContext} ctx
 * @returns {Record<string, unknown>}
 */
function readServerCodeFreshness(ctx) {
  if (typeof ctx.readServerCodeFreshness !== 'function') {
    return { state: 'unknown', changedCount: null, staleSinceAt: null };
  }
  try {
    const detail = ctx.readServerCodeFreshness();
    if (!detail || typeof detail !== 'object') return { state: 'unknown', changedCount: null, staleSinceAt: null };
    const state = ['fresh', 'stale', 'unknown'].includes(String(detail.state))
      ? String(detail.state)
      : 'unknown';
    const changedCount = Number.isFinite(Number(detail.changedCount))
      ? Math.max(0, Math.floor(Number(detail.changedCount)))
      : null;
    return {
      state,
      changedCount: state === 'unknown' ? null : changedCount,
      staleSinceAt: typeof detail.staleSinceAt === 'string' ? detail.staleSinceAt : null,
    };
  } catch {
    return { state: 'unknown', changedCount: null, staleSinceAt: null };
  }
}

/**
 * Bare MCP resource flag for the pre-auth health payload; details stay in diagnostics.
 *
 * @param {HealthRoutesContext} ctx
 * @returns {boolean}
 */
function readMcpResourceAlarm(ctx) {
  try {
    return typeof ctx.hasMcpResourceAlarm === 'function' && ctx.hasMcpResourceAlarm() === true;
  } catch {
    return false;
  }
}

/**
 * @param {HealthRoutesContext} ctx
 * @returns {Record<string, unknown>}
 */
function readMcpResources(ctx) {
  try {
    const detail = typeof ctx.readMcpResources === 'function' ? ctx.readMcpResources() : null;
    return detail && typeof detail === 'object' ? detail : { state: 'unknown' };
  } catch {
    return { state: 'unknown' };
  }
}

/**
 * Bare flag for the pre-auth health payload. `unknown` must not read as an alarm,
 * so only a real `stale` measurement is true, and a throwing getter is false.
 *
 * @param {HealthRoutesContext} ctx
 * @returns {boolean}
 */
function readServerCodeStaleFlag(ctx) {
  if (typeof ctx.isServerCodeStale !== 'function') return false;
  try {
    return ctx.isServerCodeStale() === true;
  } catch {
    return false;
  }
}

/**
 * @param {HealthRoutesContext} ctx
 * @returns {string}
 */
function readFrontAssetVersion(ctx) {
  if (typeof ctx.getFrontAssetVersion !== 'function') return '';
  try {
    const version = ctx.getFrontAssetVersion();
    if (typeof version === 'string') return version.trim();
    if (version == null) return '';
    return String(version);
  } catch {
    return '';
  }
}

/**
 * @param {import('express').Express} app
 * @param {HealthRoutesContext} ctx
 */
export function registerHealthRoutes(app, ctx) {
  // Passive timing observer; it only listens for `finish` and always calls next().
  if (typeof app.use === 'function') app.use(routeTimings.middleware());
  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      serverInstanceToken: ctx.serverInstanceToken,
      serverInstanceId: getServerInstanceId(),
      startedAt: ctx.serverStartedAt,
      frontAssetVersion: readFrontAssetVersion(ctx),
      eventLoopLagMs: readEventLoopLag(),
      load: getLoadSnapshot(),
      sdkRoomBus: getSdkRoomBusMode(),
      sdkRoomRegistry: getSdkRoomRegistryMode(),
      restoreGeneration: /** @type {any} */ (ctx).restoreGate?.snapshot?.().restoreGeneration || null,
      restorePaused: /** @type {any} */ (ctx).restoreGate?.isRestorePaused?.() === true,
      // The bare flag only: which files changed and how many belong to the
      // authorized diagnostics endpoint. `/api/health` is pre-auth.
      backendCodeStale: readServerCodeStaleFlag(ctx),
      mcpResourceAlarm: readMcpResourceAlarm(ctx),
    });
  });
  app.get('/api/diagnostics/server', (req, res) => {
    if (req.widgetAccess || req.mcpIntegration) {
      return res.status(403).json({ ok: false, error: 'Server diagnostics require a Cretli login session.' });
    }
    if (!ctx.serverDiagnostics) return res.status(503).json({ ok: false, error: 'Server diagnostics are unavailable.' });
    const requestedLimit = Number.parseInt(String(req.query?.limit || ''), 10);
    const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(1000, requestedLimit)) : 200;
    try {
      res.json({
        ok: true,
        current: ctx.serverDiagnostics.snapshot('current'),
        recent: ctx.serverDiagnostics.readRecent(limit),
        monitorAlerts: safeReadMonitorAlerts(ctx, limit),
        oomMarkers: safeReadOomMarkers(ctx, limit),
        opencode: safeReadOpenCodeInstanceStats(ctx),
        largeDataFiles: safeListLargeDataFiles(ctx),
        codeFreshness: readServerCodeFreshness(ctx),
        mcpResources: readMcpResources(ctx),
      });
    } catch {
      res.status(503).json({ ok: false, error: 'Server diagnostics are temporarily unavailable.' });
    }
  });
}

/**
 * Live/pending OpenCode instance counts with the active opt-in cap. Never fail
 * the diagnostics endpoint because the manager is not loaded yet.
 *
 * @param {HealthRoutesContext} ctx
 * @returns {{ live: number, pending: number, limit: number } | null}
 */
function safeReadOpenCodeInstanceStats(ctx) {
  if (typeof ctx.getInstanceStats !== 'function') return null;
  try {
    const stats = ctx.getInstanceStats();
    return stats && typeof stats === 'object' ? stats : null;
  } catch {
    return null;
  }
}

/**
 * Oversized top-level files in the runtime data directory. Never fail the
 * diagnostics endpoint because the scan failed.
 *
 * @param {HealthRoutesContext} ctx
 * @returns {{ name: string, bytes: number }[]}
 */
function safeListLargeDataFiles(ctx) {
  if (typeof ctx.listLargeDataFiles !== 'function') return [];
  try {
    const rows = ctx.listLargeDataFiles();
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

/**
 * Memory/orphan alarms recorded by the machine-level monitor. Never fail the
 * diagnostics endpoint because the alert file is missing or malformed.
 *
 * @param {HealthRoutesContext} ctx
 * @param {number} limit
 * @returns {Record<string, unknown>[]}
 */
function safeReadMonitorAlerts(ctx, limit) {
  if (typeof ctx.readMonitorAlerts !== 'function') return [];
  try {
    const rows = ctx.readMonitorAlerts(limit);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

/**
 * OOM/termination markers written by the external monitor. A missing or corrupt
 * marker file is an empty list, never a failed diagnostics request.
 *
 * @param {HealthRoutesContext} ctx
 * @param {number} limit
 * @returns {Record<string, unknown>[]}
 */
function safeReadOomMarkers(ctx, limit) {
  if (typeof ctx.readOomMarkers !== 'function') return [];
  try {
    const rows = ctx.readOomMarkers(Math.min(limit, 100));
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}
