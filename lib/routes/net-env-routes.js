import { requireAuth, isLanExposed } from '../auth.js';
import { resolveBindHost } from '../bind-host.js';
import { getLanHost } from '../lan-host.js';
import { createNetEnvService } from '../net-env/index.js';

export function registerNetEnvRoutes(app, { service = createNetEnvService({ getHost: getLanHost, getBind: resolveBindHost, getLanExposed: isLanExposed }) } = {}) {
  app.get('/api/net-env', requireAuth, async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.json(await service.getReport({ refresh: req.query.refresh === '1' })); }
    catch (error) { next(error); }
  });
}
