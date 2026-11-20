import { createAutostart } from '../autostart/index.js';
import { readSupervisorStatus } from '../autostart/supervisor-status.js';
import { resolveProjectPath } from '../runtime-paths.js';
import { readSystemAutostart } from '../autostart/system-autostart-status.js';

export function registerAutostartRoutes(app, { adapter = createAutostart({ root: resolveProjectPath() }), supervisor = readSupervisorStatus,
  systemAutostart = readSystemAutostart } = {}) {
  let operationActive = false;
  const guard = (req, res, next) => {
    // requireAuth runs before these routes, as for /api/diagnostics/server.
    if (req.widgetAccess || req.mcpIntegration) return res.status(403).json({ ok: false, error: 'Autostart requires a Cretli login session.' });
    res.set('Cache-Control', 'no-store');
    next();
  };
  const state = async () => {
    const currentSupervisor = supervisor();
    const system = currentSupervisor.active && !currentSupervisor.stale ? await systemAutostart({ pid: currentSupervisor.pid }) : null;
    if (system) return { supported: false, installed: system.enabled === true, foreign: false,
      platform: 'systemd', managedExternally: true, externalEnabled: system.enabled, supervisor: currentSupervisor };
    const value = await adapter.status();
    return { supported: value.supported === true, installed: value.installed === true, foreign: value.foreign === true,
      managedExternally: false, externalEnabled: null,
      platform: ['systemd', 'launchd', 'wsl', 'termux'].includes(value.platform) ? value.platform : 'unsupported', supervisor: currentSupervisor };
  };
  app.get('/api/settings/autostart', guard, async (_req, res) => {
    try { res.json({ ok: true, ...await state() }); }
    catch { res.status(503).json({ ok: false, error: 'Autostart status unavailable.' }); }
  });
  app.post('/api/settings/autostart', guard, async (req, res) => {
    if (req.body?.confirm !== true || typeof req.body?.enabled !== 'boolean') return res.status(400).json({ ok: false, error: 'Explicit confirmation and enabled boolean required.' });
    if (operationActive) return res.status(409).json({ ok: false, error: 'An autostart change is already in progress.' });
    operationActive = true;
    try {
      if ((await state()).managedExternally) return res.status(409).json({ ok: false, code: 'system-managed', error: 'Autostart is managed by the system service.' });
      const result = await adapter[req.body.enabled ? 'install' : 'uninstall']({ apply: true, start: false, linger: false });
      const current = await state();
      const activationCode = !current.supported ? 'unsupported' : req.body.enabled ? 'next_boot' : `removed_${current.platform}`;
      // Only the literal stop command is displayed alongside translated UI text.
      const stopCommand = !req.body.enabled && current.platform === 'systemd' ? 'systemctl --user stop cretli.service'
        : !req.body.enabled && current.platform === 'launchd'
          ? String(result.activation || '').match(/launchctl bootout gui\/[0-9]+\/com\.cretli\.supervisor$/)?.[0] || null : null;
      res.json({ ok: true, ...current, activation: result.activation, activationCode, stopCommand, warnings: result.warnings, serverKeepsRunning: true });
    } catch { res.status(503).json({ ok: false, error: 'Autostart change failed. Command output suppressed.' }); }
    finally { operationActive = false; }
  });
}
