import { FleetRegistryError } from '../fleet/registry.js';

/** Must be registered after requireAuth (which also enforces mutation CSRF). */
export function registerFleetRoutes(app, { registry, poller }) {
  app.use('/api/fleet', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.widgetAccess || req.mcpIntegration) return res.status(403).json({ ok: false, error: 'sessionRequired' });
    next();
  });
  function handle(action) {
    return (req, res) => {
      try { action(req, res); } catch (err) {
        const known = err instanceof FleetRegistryError;
        const code = known ? err.code : 'fleetStorageUnavailable';
        res.status(code === 'fleetInstanceNotFound' ? 404 : code === 'fleetInvalidInstance' ? 400 : 503).json({ ok: false, error: code });
      }
    };
  }
  app.get('/api/fleet/instances', handle((_req, res) => res.json({ instances: registry.list() })));
  app.get('/api/fleet/status', handle((_req, res) => res.json({ instances: poller.list() })));
  app.get('/api/fleet/instances/:id/status', handle((req, res) => {
    if (!registry.get(req.params.id)) throw new FleetRegistryError('fleetInstanceNotFound');
    res.json(poller.status(req.params.id));
  }));
  app.post('/api/fleet/instances', handle((req, res) => res.status(201).json({ instance: registry.create(req.body) })));
  app.patch('/api/fleet/instances/:id', handle((req, res) => res.json({ instance: registry.update(req.params.id, req.body) })));
  app.delete('/api/fleet/instances/:id', handle((req, res) => { registry.remove(req.params.id); res.json({ ok: true }); }));
}
