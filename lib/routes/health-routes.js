import { monitorEventLoopDelay } from 'node:perf_hooks';
import { getServerInstanceId } from '../sdk/sdk-instance-id.js';
import { getSdkRoomBusMode } from '../sdk/sdk-room-bus.js';
import { getSdkRoomRegistryMode } from '../sdk/sdk-room-registry.js';

/**
 * @typedef {Object} HealthRoutesContext
 * @property {string} serverInstanceToken
 * @property {number} serverStartedAt
 * @property {() => string} [getFrontAssetVersion]
 * @property {{ snapshot: (event?: string, details?: Record<string, unknown>) => Record<string, unknown>, readRecent: (limit?: number) => Record<string, unknown>[] }} [serverDiagnostics]
 * @property {() => { live: number, pending: number, limit: number } | null} [getOpenCodeInstanceStats]
 * @property {(limit?: number) => Record<string, unknown>[]} [readMonitorAlerts]
 * @property {() => { name: string, bytes: number }[]} [listLargeDataFiles]
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
  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      serverInstanceToken: ctx.serverInstanceToken,
      serverInstanceId: getServerInstanceId(),
      startedAt: ctx.serverStartedAt,
      frontAssetVersion: readFrontAssetVersion(ctx),
      eventLoopLagMs: readEventLoopLag(),
      sdkRoomBus: getSdkRoomBusMode(),
      sdkRoomRegistry: getSdkRoomRegistryMode(),
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
        opencode: safeReadOpenCodeInstanceStats(ctx),
        largeDataFiles: safeListLargeDataFiles(ctx),
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
  if (typeof ctx.getOpenCodeInstanceStats !== 'function') return null;
  try {
    const stats = ctx.getOpenCodeInstanceStats();
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
