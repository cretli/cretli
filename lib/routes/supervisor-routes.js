import { createSupervisorControl } from '../autostart/supervisor-control.js';
import { beginUpdateOperation, endUpdateOperation } from '../update-gate.js';

export function registerSupervisorRoutes(app, { control = createSupervisorControl(),
  claim = beginUpdateOperation, release = endUpdateOperation, schedule = (fn) => setTimeout(fn, 700) } = {}) {
  let restarting = false;
  const guard = (req, res, next) => {
    if (req.widgetAccess || req.mcpIntegration) return res.status(403).json({ ok: false, code: 'session-required' });
    res.set('Cache-Control', 'no-store');
    next();
  };
  app.get('/api/settings/supervisor', guard, (_req, res) => {
    try { res.json({ ok: true, supervisor: control.status(), restarting }); }
    catch { res.status(503).json({ ok: false, code: 'unavailable' }); }
  });
  app.get('/api/settings/supervisor/logs', guard, (_req, res) => {
    try { res.json({ ok: true, ...control.logs() }); }
    catch { res.status(503).json({ ok: false, code: 'unavailable' }); }
  });
  app.post('/api/settings/supervisor', guard, async (req, res) => {
    const action = req.body?.action;
    if (!['enable', 'disable', 'restart'].includes(action) || req.body?.confirm !== true) {
      return res.status(400).json({ ok: false, code: 'invalid-action' });
    }
    if (restarting) return res.status(409).json({ ok: false, code: 'busy' });
    let operationId;
    try {
      if (action !== 'restart') {
        control.setEnabled(action === 'enable');
        return res.status(202).json({ ok: true, action });
      }
      // Share the updater's exclusion slot and its live-run check. Never stop an install.
      const gate = claim({ kind: 'supervisor-restart', reason: 'settings' });
      if (!gate.allowed) return res.status(gate.status).json({ ok: false, code: gate.errorKey });
      operationId = gate.operationId;
      restarting = true;
      const restart = await control.restart();
      res.status(202).json({ ok: true, action, reconnect: true });
      schedule(async () => {
        try { await restart(); }
        catch {
          restarting = false; release(operationId);
          console.error('[supervisor] Restart failed');
        }
      });
    } catch {
      restarting = false;
      if (operationId) release(operationId);
      res.status(503).json({ ok: false, code: 'unavailable' });
    }
  });
}
