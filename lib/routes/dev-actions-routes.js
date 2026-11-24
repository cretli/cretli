import path from 'path';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { msg } from '../messages.js';
import { canRestartServer, isSupervised, resolveServerRestartGate } from '../server-restart-policy.js';
import { countActiveDelegationRuns } from '../delegation-service.js';
import { normalizeRestartMode } from '../restart-fast.js';

/**
 * @typedef {Object} DevActionsRoutesContext
 * @property {string} serverInstanceToken
 * @property {string} projectRoot
 * @property {() => boolean} getServerRestartScheduled
 * @property {(scheduled: boolean) => void} setServerRestartScheduled
 * @property {(input: { trigger: () => void }) => Promise<unknown>} [runFastRestart] fast-mode orchestrator (optional)
 */

/**
 * @param {DevActionsRoutesContext} ctx
 * @param {string} restartRequestId
 * @param {{ env?: NodeJS.ProcessEnv, ppid?: number, kill?: typeof process.kill, spawn?: typeof spawn }} [deps]
 */
export function scheduleServerRestart(ctx, restartRequestId, deps = {}) {
  const env = deps.env || process.env;
  const ppid = deps.ppid ?? process.ppid;
  if (isSupervised(env, ppid)) {
    try {
      (deps.kill || process.kill)(ppid, 'SIGUSR2');
    } catch (err) {
      ctx.setServerRestartScheduled(false);
      console.error('[dev-actions] Failed to signal restart supervisor:', err);
    }
    return;
  }
  const helperPath = path.join(ctx.projectRoot, 'scripts', 'restart-server-helper.js');
  const child = (deps.spawn || spawn)(process.execPath, [helperPath], {
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

/** Context of the registered routes, shared with the operator restart tool. */
let registeredCtx = null;

/**
 * Gate and start a restart for one request. Shared by the HTTP route and the
 * operator MCP tool. Fast mode implies `force`: its whole purpose is restarting
 * under running work, after the grace window.
 *
 * @param {DevActionsRoutesContext} ctx
 * @param {{ action?: unknown, mode?: unknown, force?: unknown }} body
 * @returns {{ ok: false, status: number, gate?: Record<string, any>, error?: string }
 *   | { ok: true, restartRequestId: string, mode: string, gate: Record<string, any>, begin: () => void }}
 */
export function requestServerRestart(ctx, body = {}) {
  let restartMode = 'drain';
  try {
    restartMode = normalizeRestartMode(body.mode);
  } catch (err) {
    return { ok: false, status: 400, error: err.message };
  }
  if (restartMode === 'fast' && typeof ctx.runFastRestart !== 'function') {
    return { ok: false, status: 501, error: 'fast restart is not available on this server' };
  }
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
    action: body.action,
    isRestartScheduled: ctx.getServerRestartScheduled(),
    activeDelegations,
    activeDelegationsUnknown,
    force: body.force === true || restartMode === 'fast',
  });
  if (!gate.allowed) return { ok: false, status: gate.status, gate };
  const restartRequestId = randomUUID();
  ctx.setServerRestartScheduled(true);
  return {
    ok: true,
    restartRequestId,
    mode: restartMode,
    gate,
    begin: () => {
      if (restartMode === 'fast') {
        // Fast mode: the orchestrator triggers the supervised restart itself after the grace window.
        Promise.resolve(ctx.runFastRestart({ trigger: () => scheduleServerRestart(ctx, restartRequestId) }))
          .catch((err) => {
            ctx.setServerRestartScheduled(false);
            console.error('[dev-actions] Fast restart failed:', err);
          });
        return;
      }
      setTimeout(() => scheduleServerRestart(ctx, restartRequestId), 300);
    },
  };
}

/**
 * Operator entry point (MCP `operator_restart`); uses the routes' own context.
 * @param {{ mode?: unknown }} input
 */
export function requestOperatorServerRestart(input = {}) {
  if (!registeredCtx) return { ok: false, status: 503, error: 'restart is not available yet' };
  const result = /** @type {any} */ (requestServerRestart(registeredCtx, { action: 'restart-server', mode: input.mode }));
  if (result.ok) result.begin();
  return result.ok
    ? { ok: true, restartRequestId: result.restartRequestId, mode: result.mode, previousServerInstanceToken: registeredCtx.serverInstanceToken, activeDelegations: result.gate.activeDelegations }
    : { ok: false, status: result.status, error: result.error || (result.gate && result.gate.errorKey) || 'restart_refused', activeDelegations: result.gate ? result.gate.activeDelegations : undefined };
}

/**
 * @param {import('express').Express} app
 * @param {DevActionsRoutesContext} ctx
 */
export function registerDevActionsRoutes(app, ctx) {
  registeredCtx = ctx;
  app.post('/api/dev-actions', (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const result = /** @type {any} */ (requestServerRestart(ctx, body));
    if (!result.ok && !result.gate) return res.status(result.status).json({ ok: false, error: result.error });
    if (!result.ok) {
      const gate = result.gate;
      return res.status(result.status).json({
        ok: false,
        error: msg(req, gate.errorKey),
        canRestartServer: canRestartServer(),
        activeDelegations: gate.activeDelegations,
        canForce: gate.canForce === true,
      });
    }
    res.status(202).json({
      ok: true,
      action: 'restart-server',
      restartRequestId: result.restartRequestId,
      previousServerInstanceToken: ctx.serverInstanceToken,
      canRestartServer: true,
      activeDelegations: result.gate.activeDelegations,
    });
    result.begin();
  });
}
