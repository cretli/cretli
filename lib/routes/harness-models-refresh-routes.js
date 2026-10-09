/**
 * POST /api/harness/models/refresh — explicit model catalog refresh per harness.
 */

import { refreshHarnessModelsCatalog } from '../harness-models-refresh.js';
import { msg } from '../messages.js';

/**
 * Widget and MCP bearer tokens clear `requireAuth` before the CSRF gate, so a
 * session-only route has to reject them itself (same guard as catalog routes).
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function isRestrictedCaller(req) {
  return Boolean(req?.widgetAccess || req?.mcpIntegration);
}

/**
 * @param {import('express').Express} app
 * @param {{ refresh?: typeof refreshHarnessModelsCatalog }} [ctx]
 */
export function registerHarnessModelsRefreshRoutes(app, ctx = {}) {
  const refresh = ctx.refresh || refreshHarnessModelsCatalog;

  app.post('/api/harness/models/refresh', async (req, res) => {
    if (isRestrictedCaller(req)) {
      return res.status(403).json({ ok: false, error: msg(req, 'widget.endpointUnavailable') });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const harness = body.harness;
    try {
      const result = await refresh(harness);
      return res.json(result);
    } catch (err) {
      if (err?.code === 'VALIDATION') {
        return res.status(400).json({ ok: false, error: err.message, code: err.code });
      }
      if (err?.code === 'NOT_REFRESHABLE') {
        return res.status(422).json({ ok: false, error: err.message, code: err.code });
      }
      return res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  });
}
