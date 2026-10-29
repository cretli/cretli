/**
 * Workspace app registry API (`.cretli/apps.json`). All routes sit behind requireAuth.
 *
 * There is deliberately no route that signals or kills a PID: orphans are
 * read-only and carry at most a copyable `kill <pid>` hint.
 */

import { requireAuth } from '../auth.js';
import { configureAppsRuntime } from '../apps/runtime.js';

/**
 * @typedef {Object} AppsRoutesContext
 * @property {Map<string, any>} taskRuns
 * @property {() => string} getCurrentCwd
 * @property {(input: any) => any} [loadTasksForWorkspace]
 * @property {(overrides?: Record<string, string>) => NodeJS.ProcessEnv} [buildInteractivePtyEnv]
 * @property {() => string} [randomSessionId]
 * @property {() => { workspaceFile: string, cwd: string }} [buildTaskRunScopeSnapshot]
 * @property {ReturnType<typeof import('../apps/service.js').createAppsService>} [service]  test override
 */

/** @param {import('express').Request} req */
const isRestrictedCaller = (req) => Boolean(/** @type {any} */ (req).widgetAccess || /** @type {any} */ (req).mcpIntegration);

/**
 * @param {import('express').Express} app
 * @param {AppsRoutesContext} ctx
 */
export function registerAppsRoutes(app, ctx) {
  const service = ctx.service || configureAppsRuntime({
    taskRuns: ctx.taskRuns,
    getWorkspaceDir: ctx.getCurrentCwd,
    loadTasksForWorkspace: ctx.loadTasksForWorkspace,
    buildInteractivePtyEnv: ctx.buildInteractivePtyEnv || ((o = {}) => ({ ...process.env, ...o })),
    randomSessionId: ctx.randomSessionId || (() => Math.random().toString(36).slice(2)),
    buildTaskRunScopeSnapshot: ctx.buildTaskRunScopeSnapshot,
  });

  /** Sends a service result; errors keep the `{ ok:false, error, message, errors? }` shape. */
  const send = (res, result) => {
    res.setHeader('Cache-Control', 'no-store');
    if (result.ok) return res.json(result);
    const { status, ...body } = result;
    return res.status(status || 500).json(body);
  };

  /** Wraps a handler so a thrown error becomes a JSON 500 instead of an unhandled rejection. */
  const handle = (fn) => async (req, res) => {
    if (isRestrictedCaller(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
    try {
      return send(res, await fn(req));
    } catch (err) {
      return res.status(500).json({ ok: false, error: 'internal-error', message: String(err?.message || err) });
    }
  };

  app.get('/api/apps', requireAuth, handle(() => service.list()));
  app.put('/api/apps', requireAuth, handle((req) => {
    const apps = req.body && typeof req.body === 'object' ? req.body.apps : undefined;
    return service.put(apps);
  }));
  app.post('/api/apps', requireAuth, handle((req) => service.add(req.body && typeof req.body === 'object' ? req.body.app : undefined)));
  app.get('/api/apps/status', requireAuth, handle((req) => service.status({ refresh: req.query.refresh === '1' })));
  app.get('/api/apps/suggestions', requireAuth, handle(() => service.suggestions()));
  app.post('/api/apps/:id/start', requireAuth, handle((req) => service.start(String(req.params.id))));
  app.post('/api/apps/:id/stop', requireAuth, handle((req) => service.stop(String(req.params.id))));
  app.post('/api/apps/:id/restart', requireAuth, handle((req) => service.restart(String(req.params.id))));
}
