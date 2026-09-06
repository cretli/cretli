/**
 * HTTP catalog for harnesses and cached/fallback models (password clients).
 */

import { listHarnessCatalog, listHarnessModels } from '../harness-catalog.js';
import { msg } from '../messages.js';

/**
 * @param {import('express').Express} app
 */
export function registerHarnessCatalogRoutes(app) {
  app.get('/api/harness-catalog/harnesses', async (req, res) => {
    if (req.widgetAccess || req.mcpIntegration) {
      return res.status(403).json({ ok: false, error: msg(req, 'widget.endpointUnavailable') });
    }
    try {
      const items = await listHarnessCatalog();
      return res.json({ ok: true, items });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/harness-catalog/models', (req, res) => {
    if (req.widgetAccess || req.mcpIntegration) {
      return res.status(403).json({ ok: false, error: msg(req, 'widget.endpointUnavailable') });
    }
    try {
      const listed = listHarnessModels({
        harness: req.query.harness,
        query: req.query.query,
        enabledOnly: req.query.enabled_only === '1' || req.query.enabledOnly === '1',
      });
      return res.json({ ok: true, ...listed });
    } catch (err) {
      const status = err?.code === 'VALIDATION' ? 400 : 500;
      return res.status(status).json({ ok: false, error: err.message, code: err.code });
    }
  });
}
