import { randomUUID } from 'node:crypto';
import { msg } from '../messages.js';
import { canRestartServer } from '../server-restart-policy.js';
import { getUpdateStatus, startUpdateApply } from '../self-update.js';

/**
 * @typedef {Object} UpdateRoutesContext
 * @property {string} projectRoot
 * @property {(restartRequestId: string) => void} [scheduleServerRestart]
 * @property {() => boolean} [getServerRestartScheduled]
 * @property {(scheduled: boolean) => void} [setServerRestartScheduled]
 */

/**
 * @param {UpdateRoutesContext} ctx
 */
function scheduleRestartAfterUpdate(ctx) {
  if (!canRestartServer()) return;
  if (typeof ctx.getServerRestartScheduled === 'function' && ctx.getServerRestartScheduled()) {
    return;
  }
  if (typeof ctx.scheduleServerRestart !== 'function') return;
  if (typeof ctx.setServerRestartScheduled === 'function') {
    ctx.setServerRestartScheduled(true);
  }
  ctx.scheduleServerRestart(randomUUID());
}

/**
 * @param {import('express').Express} app
 * @param {UpdateRoutesContext} ctx
 */
export function registerUpdateRoutes(app, ctx) {
  app.get('/api/update/status', (req, res) => {
    const check = req.query?.check === '1' || req.query?.check === 'true';
    res.json(getUpdateStatus({
      projectRoot: ctx.projectRoot,
      check,
    }));
  });
  app.post('/api/update/apply', (req, res) => {
    const result = startUpdateApply({
      projectRoot: ctx.projectRoot,
      onSuccess: () => scheduleRestartAfterUpdate(ctx),
    });
    if (!result.allowed) {
      return res.status(result.status).json({
        ok: false,
        error: msg(req, result.errorKey),
        canRestartServer: canRestartServer(),
      });
    }
    res.status(202).json({
      ok: true,
      ...(result.statusPayload || {}),
    });
  });
}
