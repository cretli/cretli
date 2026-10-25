import path from 'path';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { msg } from '../messages.js';
import { canRestartServer, resolveServerRestartGate } from '../server-restart-policy.js';
import { countActiveDelegationRuns } from '../delegation-service.js';

/**
 * @typedef {Object} DevActionsRoutesContext
 * @property {string} serverInstanceToken
 * @property {string} projectRoot
 * @property {() => boolean} getServerRestartScheduled
 * @property {(scheduled: boolean) => void} setServerRestartScheduled
 */

/**
 * @param {DevActionsRoutesContext} ctx
 * @param {string} restartRequestId
 */
export function scheduleServerRestart(ctx, restartRequestId) {
  const helperPath = path.join(ctx.projectRoot, 'scripts', 'restart-server-helper.js');
  const child = spawn(process.execPath, [helperPath], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      RESTART_PID: String(process.pid),
      RESTART_CWD: ctx.projectRoot,
      RESTART_REQUEST_ID: restartRequestId,
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
    let activeDelegations = 0;
    let activeDelegationsUnknown = false;
    try {
      activeDelegations = countActiveDelegationRuns();
    } catch {
      // A store read failure fails closed: the restart may not pass under
      // possibly-live delegations when the count is unknown.
      activeDelegationsUnknown = true;
    }
    const gate = resolveServerRestartGate({
      action: req.body && req.body.action,
      isRestartScheduled: ctx.getServerRestartScheduled(),
      activeDelegations,
      activeDelegationsUnknown,
      force: req.body && req.body.force === true,
    });
    if (!gate.allowed) {
      return res.status(gate.status).json({
        ok: false,
        error: msg(req, gate.errorKey),
        canRestartServer: canRestartServer(),
        activeDelegations: gate.activeDelegations,
        canForce: gate.canForce === true,
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
      activeDelegations: gate.activeDelegations,
    });
    setTimeout(() => scheduleServerRestart(ctx, restartRequestId), 300);
  });
}
