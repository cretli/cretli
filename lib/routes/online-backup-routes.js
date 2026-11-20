/**
 * HTTP API for online backups and the backup scheduler (B6).
 * Admin-equivalent only: widget and MCP-integration credentials are refused.
 * Docs: docs/backup/online-backups.md.
 */

import { getOnlineBackupService } from '../backup/online/online-service.js';
import { OfflineDataError } from '../backup/offline/offline-errors.js';
import { MaintenanceError } from '../storage/maintenance-coordinator.js';
import { msg } from '../messages.js';

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {boolean} true when the request was refused
 */
function rejectLimitedClients(req, res) {
  if (req.widgetAccess || req.mcpIntegration) {
    res.status(403).json({ ok: false, code: 'FORBIDDEN', error: msg(req, 'widget.endpointUnavailable') });
    return true;
  }
  return false;
}

/**
 * @param {import('express').Response} res
 * @param {unknown} err
 */
function sendError(res, err) {
  if (err instanceof MaintenanceError) {
    return res.status(err.deferred ? 409 : 503).json({ ok: false, code: err.code, deferred: err.deferred, error: err.message, details: err.details });
  }
  if (err instanceof OfflineDataError) {
    return res.status(400).json({ ok: false, code: err.code, error: err.message });
  }
  return res.status(500).json({ ok: false, code: 'INTERNAL', error: 'Request failed' });
}

/**
 * @param {import('express').Application} app
 * @param {{ getService?: typeof getOnlineBackupService }} [deps]
 */
export function registerOnlineBackupRoutes(app, deps = {}) {
  const service = () => (deps.getService || getOnlineBackupService)();
  const guard = (handler) => async (req, res) => {
    if (rejectLimitedClients(req, res)) return undefined;
    try {
      return await handler(req, res);
    } catch (err) {
      return sendError(res, err);
    }
  };

  app.get('/api/online-backup/status', guard((req, res) => res.json({ ok: true, ...service().scheduler.status(), budgets: service().coordinator.budgets })));

  app.put('/api/online-backup/policy', guard((req, res) => {
    const policy = service().scheduler.setPolicy(req.body || {});
    return res.json({ ok: true, policy });
  }));

  app.post('/api/online-backup/run', guard(async (req, res) => {
    const result = await service().scheduler.runNow();
    const ok = result.status === 'succeeded';
    return res.status(ok ? 200 : 409).json({ ok, ...result });
  }));
}
