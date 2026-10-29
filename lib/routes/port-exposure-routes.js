/**
 * Port exposure API. All routes sit behind requireAuth and act as the logged-in
 * operator; widget and MCP integration tokens are refused. Policy, hard blocks
 * and ownership checks are enforced by the service, not here.
 */

import { requireAuth } from '../auth.js';
import { getPortExposureService } from '../port-exposure/runtime.js';

/** @param {import('express').Request} req */
const isRestrictedCaller = (req) => Boolean(/** @type {any} */ (req).widgetAccess || /** @type {any} */ (req).mcpIntegration);

/**
 * @param {import('express').Express} app
 * @param {{ service?: ReturnType<typeof import('../port-exposure/service.js').createPortExposureService> }} [ctx]
 */
export function registerPortExposureRoutes(app, ctx = {}) {
  const svc = () => ctx.service || getPortExposureService();
  const operator = /** @type {{ kind: 'operator' }} */ ({ kind: 'operator' });

  const handle = (fn) => async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (isRestrictedCaller(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
    try {
      const result = await fn(req);
      if (result.ok) return res.json(result);
      const { status, ...body } = result;
      return res.status(status || 500).json(body);
    } catch (err) {
      return res.status(500).json({ ok: false, error: 'internal-error', message: String(err?.message || err) });
    }
  };

  app.get('/api/port-exposures', requireAuth, handle((req) => svc().list({ refresh: req.query.refresh === '1' })));
  app.post('/api/port-exposures', requireAuth, handle((req) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    return svc().expose({ port: b.port, reason: b.reason, ttlMs: b.ttlMs, owner: b.owner }, operator);
  }));
  app.delete('/api/port-exposures/:port', requireAuth, handle((req) => svc().close(Number(req.params.port), operator)));
}
