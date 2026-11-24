/**
 * Devices registry API. All routes sit behind requireAuth; widget and MCP
 * integration callers are refused (agents use the consent-gated MCP tools).
 */

import { getDeviceRunsService } from '../devices/runs.js';
import { requireAuth } from '../auth.js';
import { getDevicesService } from '../devices/service.js';

/** @param {import('express').Request} req */
const isRestrictedCaller = (req) => Boolean(/** @type {any} */ (req).widgetAccess || /** @type {any} */ (req).mcpIntegration);

/**
 * @param {import('express').Express} app
 * @param {{ runs?: any, service?: ReturnType<typeof import('../devices/service.js').createDevicesService> }} [ctx]
 */
export function registerDevicesRoutes(app, ctx = {}) {
  const runs = () => ctx.runs || getDeviceRunsService();
  const service = () => ctx.service || getDevicesService();
  const handle = (fn) => async (req, res) => {
    if (isRestrictedCaller(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
    res.setHeader('Cache-Control', 'no-store');
    try {
      const result = await fn(req);
      if (result.ok) { const { httpStatus, ...body } = result; return res.status(httpStatus || 200).json(body); }
      const { status, ...body } = result;
      return res.status(status || 500).json(body);
    } catch (err) {
      return res.status(500).json({ ok: false, error: 'internal-error', message: String(/** @type {any} */ (err)?.message || err) });
    }
  };
  const workspace = (req) => String(req.query?.workspaceFolder || '').trim() || undefined;

  app.get('/api/devices/run-consents', requireAuth, handle(() => ({ ok: true, prompts: runs().consent.list('') })));
  app.post('/api/devices/run-consents/:consentId', requireAuth, handle((req) => runs().consent.resolve(req.params.consentId, req.body?.decision)));
  app.get('/api/devices/chat-run-consents', requireAuth, handle((req) => {
    const chatId = String(req.query.chatId || '');
    return chatId ? { ok: true, prompts: runs().consent.list(chatId) } : { ok: false, status: 400, error: 'chat-required' };
  }));
  app.post('/api/devices/chat-run-consents/:consentId', requireAuth, handle((req) => {
    const chatId = String(req.body?.chatId || '');
    if (!chatId) return { ok: false, status: 400, error: 'chat-required' };
    return runs().consent.resolve(req.params.consentId, req.body?.decision, { chatId });
  }));
  app.get('/api/devices/runs', requireAuth, handle((req) => ({ ok: true, runs: runs().history.list({ workspace: workspace(req), deviceId: req.query.deviceId }) })));
  app.get('/api/devices/runs/compare', requireAuth, handle((req) => runs().history.compare(req.query.before, req.query.after, workspace(req))));
  app.get('/api/devices/runs/:runId/screenshots/:name', requireAuth, (req, res) => {
    if (isRestrictedCaller(req)) return res.sendStatus(403);
    const file = runs().history.screenshot(req.params.runId, req.params.name, workspace(req));
    if (!file) return res.sendStatus(404);
    res.setHeader('Cache-Control', 'no-store'); res.type('png').sendFile(file);
  });
  app.post('/api/devices/:id/runs', requireAuth, handle(async (req) => {
    const result = await runs().start(req.params.id, req.body || {}, { workspace: workspace(req) });
    const { completion, ...body } = result;
    if (completion) void completion.catch(() => {});
    return { ...body, httpStatus: 202 };
  }));
  app.get('/api/devices', requireAuth, handle((req) => service().list({ workspace: workspace(req) })));
  app.post('/api/devices', requireAuth, handle((req) => service().create(req.body?.device ?? req.body)));
  app.put('/api/devices/:id', requireAuth, handle((req) => service().update(String(req.params.id), req.body?.device ?? req.body)));
  app.delete('/api/devices/:id', requireAuth, handle((req) => service().remove(String(req.params.id))));
  app.get('/api/devices/:id/status', requireAuth, handle((req) => service().status(String(req.params.id), { workspace: workspace(req) })));
  app.get('/api/devices/:id/connect-help', requireAuth, handle((req) => service().connectHelp(String(req.params.id))));
  app.post('/api/devices/connect-help', requireAuth, handle((req) => service().connectHelp(null, req.body || {})));
  app.post('/api/devices/:id/launch-chrome', requireAuth, handle((req) => service().launchChrome(String(req.params.id))));
}
