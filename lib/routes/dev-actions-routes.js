import path from 'path';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { loadSettings } from '../persist/settings.js';
import { msg } from '../messages.js';
import { canRestartServer, resolveServerRestartGate } from '../server-restart-policy.js';

/**
 * @typedef {Object} DevActionsRoutesContext
 * @property {string} serverInstanceToken
 * @property {string} projectRoot
 * @property {boolean} frontHmrForcedByEnv
 * @property {boolean} frontHmrEnabled
 * @property {(settings?: object|null) => boolean} resolveFrontHmrEnabledFromSettings
 * @property {() => boolean} getServerRestartScheduled
 * @property {(scheduled: boolean) => void} setServerRestartScheduled
 */

/**
 * @param {DevActionsRoutesContext} ctx
 * @param {string} restartRequestId
 */
function scheduleServerRestart(ctx, restartRequestId) {
  const restartSettings = loadSettings();
  const restartFrontHmr = ctx.frontHmrForcedByEnv
    ? ctx.frontHmrEnabled
    : ctx.resolveFrontHmrEnabledFromSettings(restartSettings);
  const helperPath = path.join(ctx.projectRoot, 'scripts', 'restart-server-helper.js');
  const child = spawn(process.execPath, [helperPath], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      RESTART_PID: String(process.pid),
      RESTART_CWD: ctx.projectRoot,
      RESTART_REQUEST_ID: restartRequestId,
      CRETLI_FRONT_HMR: restartFrontHmr ? '1' : '0',
      CURSOR_REMOTE_FRONT_HMR: restartFrontHmr ? '1' : '0',
    },
    cwd: ctx.projectRoot,
  });
  child.once('error', (err) => {
    ctx.setServerRestartScheduled(false);
    console.error('[dev-actions] Failed to start restart helper:', err);
  });
  child.unref();
}

/**
 * @param {import('express').Express} app
 * @param {DevActionsRoutesContext} ctx
 */
export function registerDevActionsRoutes(app, ctx) {
  app.post('/api/dev-actions', (req, res) => {
    const gate = resolveServerRestartGate({
      action: req.body && req.body.action,
      isRestartScheduled: ctx.getServerRestartScheduled(),
    });
    if (!gate.allowed) {
      return res.status(gate.status).json({
        ok: false,
        error: msg(req, gate.errorKey),
        canRestartServer: canRestartServer(),
      });
    }
    const restartRequestId = randomUUID();
    ctx.setServerRestartScheduled(true);
    res.status(202).json({
      ok: true,
      action: 'restart-server',
      restartRequestId,
      previousServerInstanceToken: ctx.serverInstanceToken,
      canRestartServer: true,
    });
    setTimeout(() => scheduleServerRestart(ctx, restartRequestId), 300);
  });
}
