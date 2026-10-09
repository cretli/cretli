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
 */

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
