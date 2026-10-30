import { requireAuth, isLanExposed } from '../auth.js';
import { resolveBindHost } from '../bind-host.js';
import { getLanHost } from '../lan-host.js';
import { createNetEnvService } from '../net-env/index.js';
import { getDefaultNetdClient } from '../port-exposure/netd-client.js';
import { getDefaultHelperInstaller } from '../port-exposure/helper-installer.js';

/** @param {import('express').Request} req */
const isRestrictedCaller = (req) => Boolean(/** @type {any} */ (req).widgetAccess || /** @type {any} */ (req).mcpIntegration);

export function registerNetEnvRoutes(app, { service = createNetEnvService({ getHost: getLanHost, getBind: resolveBindHost, getLanExposed: isLanExposed,
  getHelper: () => getDefaultNetdClient().status() }), installer = getDefaultHelperInstaller() } = {}) {
  app.get('/api/net-env', requireAuth, async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.json(await service.getReport({ refresh: req.query.refresh === '1' })); }
    catch (error) { next(error); }
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
      if (body.ok) getDefaultNetdClient().status({ refresh: true }).catch(() => {});
      return res.status(status).json(body);
    } catch (err) {
      return res.status(500).json({ ok: false, state: 'failed', error: 'internal-error', message: String(/** @type {any} */ (err)?.message || err) });
    }
  });
  registerAction('/api/net-env/netd/install', 'install');
  registerAction('/api/net-env/netd/uninstall', 'uninstall');
}
