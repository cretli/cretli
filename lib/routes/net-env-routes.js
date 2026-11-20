import { requireAuth } from '../auth.js';
import { getDefaultNetdClient } from '../port-exposure/netd-client.js';
import { getNetEnvReport } from '../port-exposure/runtime.js';
import { getDefaultHelperInstaller } from '../port-exposure/helper-installer.js';

/** @param {import('express').Request} req */
const isRestrictedCaller = (req) => Boolean(/** @type {any} */ (req).widgetAccess || /** @type {any} */ (req).mcpIntegration);

// The report is shared with the exposure runtime, so opening a screen never collects it twice.
export function registerNetEnvRoutes(app, { service = { getReport: getNetEnvReport }, installer = getDefaultHelperInstaller() } = {}) {
  app.get('/api/net-env', requireAuth, async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const refresh = req.query.refresh === '1';
    try {
      // An explicit refresh also re-reads the helper, whose status is cached longer than the report.
      if (refresh) await getDefaultNetdClient().status({ refresh: true });
      res.json(await service.getReport(refresh ? { refresh } : { stale: true }));
    } catch (error) { next(error); }
  });

  // Dialog data (command, installer hash). Takes no input.
  app.get('/api/net-env/netd/install-info', requireAuth, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (isRestrictedCaller(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
    return res.json({ ok: true, ...installer.describe() });
  });

  // The body is ignored on purpose: the action is fixed by the route, so a client cannot inject arguments.
  const registerAction = (route, action) => app.post(route, requireAuth, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (isRestrictedCaller(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
    try {
      const requested = action === 'install' && req.query.reinstall === '1' ? 'reinstall' : action;
      const { status, ...body } = await installer.execute(requested);
      if (body.ok) await getDefaultNetdClient().status({ refresh: true }).catch(() => {});
      return res.status(status).json(body);
    } catch (err) {
      return res.status(500).json({ ok: false, state: 'failed', error: 'internal-error', message: String(/** @type {any} */ (err)?.message || err) });
    }
  });
  registerAction('/api/net-env/netd/install', 'install');
  registerAction('/api/net-env/netd/uninstall', 'uninstall');
}
