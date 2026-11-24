/**
 * Workspace app registry API (`.cretli/apps.json`). All routes sit behind requireAuth.
 *
 * Orphans are read-only and carry at most a copyable `kill <pid>` hint. The only
 * route that signals a PID is `takeover`, for a confirmed user action on the app's
 * own port; `handle` refuses widget and MCP callers, and no MCP tool maps to it.
 */

import path from 'node:path';
import { requireAuth } from '../auth.js';
import { configureAppsRuntime } from '../apps/runtime.js';
import { getLanHost } from '../lan-host.js';
import { peekNetEnvReport } from '../port-exposure/runtime.js';
import { loadSettings } from '../persist/settings.js';
import { listRegisteredWorkspacesForFolder } from '../workspace-registry-service.js';
import { resolveTodoHomeFromSettings } from '../todo-home.js';
import { requireRequestScope, scopeFolderOf } from '../workspace-scope.js';

/**
 * @typedef {Object} AppsRoutesContext
 * @property {Map<string, any>} taskRuns
 * @property {() => string} getCurrentCwd
 * @property {() => Record<string, any>} [loadSettings] test override for workspace scope
 * @property {(input: any) => any} [loadTasksForWorkspace]
 * @property {(overrides?: Record<string, string>) => NodeJS.ProcessEnv} [buildInteractivePtyEnv]
 * @property {() => string} [randomSessionId]
 * @property {() => { workspaceFile: string, cwd: string }} [buildTaskRunScopeSnapshot]
 * @property {ReturnType<typeof import('../apps/service.js').createAppsService>} [service]  test override
 * @property {(folder: string) => boolean} [isKnownFolder]  test override
 * @property {() => any} [peekReport]  test override
 * @property {() => string | null} [getLanHost]  test override
 */

/** @param {import('express').Request} req */
const isRestrictedCaller = (req) => Boolean(/** @type {any} */ (req).widgetAccess || /** @type {any} */ (req).mcpIntegration);

/**
 * @param {import('express').Express} app
 * @param {AppsRoutesContext} ctx
 */
export function registerAppsRoutes(app, ctx) {
  const readSettings = typeof ctx.loadSettings === 'function' ? ctx.loadSettings : loadSettings;
  const service = ctx.service || configureAppsRuntime({
    taskRuns: ctx.taskRuns,
    // The background monitor uses this default; every HTTP handler supplies its resolved dir.
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

  const isKnownFolder = ctx.isKnownFolder || ((folder) => listRegisteredWorkspacesForFolder(readSettings(), folder).length > 0);
  const peekReport = ctx.peekReport || peekNetEnvReport;
  const lanHost = ctx.getLanHost || getLanHost;

  /**
   * The workspace of a request, named by the panel (or a chat / widget) and never by the shared
   * settings cwd. Only a registered folder is accepted: these routes write a definition and run
   * its command there.
   * @param {import('express').Request} req
   */
  const scopeOf = async (req) => {
    const settings = readSettings();
    const resolved = await requireRequestScope(req, settings);
    if (!resolved.ok) {
      throw Object.assign(new Error(resolved.error), { status: resolved.status, code: resolved.code });
    }
    const folder = scopeFolderOf(resolved.scope, (input) => resolveTodoHomeFromSettings(input, settings));
    if (!folder) {
      throw Object.assign(new Error('The workspace folder could not be determined.'), { status: 400, code: 'workspace-scope-required' });
    }
    const dir = path.resolve(folder);
    if (!isKnownFolder(dir)) {
      throw Object.assign(new Error('This folder is not a registered workspace.'), { status: 403, code: 'workspace-unknown' });
    }
    return { dir };
  };

  /** Wraps a handler so a thrown error becomes a JSON 500 instead of an unhandled rejection. */
  const handle = (fn) => async (req, res) => {
    if (isRestrictedCaller(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
    try {
      return send(res, await fn(req));
    } catch (err) {
      const e = /** @type {any} */ (err);
      return res.status(e?.status || 500).json({ ok: false, code: e?.code || 'internal-error', error: e?.code || 'internal-error', message: String(e?.message || err) });
    }
  };

  app.get('/api/apps', requireAuth, handle(async (req) => service.list(await scopeOf(req))));
  app.put('/api/apps', requireAuth, handle(async (req) => {
    const apps = req.body && typeof req.body === 'object' ? req.body.apps : undefined;
    return service.put(apps, await scopeOf(req));
  }));
  app.post('/api/apps', requireAuth, handle(async (req) => service.add(req.body && typeof req.body === 'object' ? req.body.app : undefined, await scopeOf(req))));
  app.get('/api/apps/status', requireAuth, handle(async (req) => {
    const status = await service.status({ refresh: req.query.refresh === '1', ...(await scopeOf(req)) });
    // Everything the panel needs from the network side, without waiting for a network report.
    const report = peekReport();
    return { ...status, lanHost: lanHost() || null, network: report ? { platform: report.platform, helper: report.helper?.state || null } : null };
  }));
  app.get('/api/apps/suggestions', requireAuth, handle(async (req) => service.suggestions(await scopeOf(req))));
  app.delete('/api/apps/:id', requireAuth, handle(async (req) => service.remove(String(req.params.id), await scopeOf(req))));
  app.post('/api/apps/:id/start', requireAuth, handle(async (req) => service.start(String(req.params.id), await scopeOf(req))));
  app.post('/api/apps/:id/stop', requireAuth, handle(async (req) => service.stop(String(req.params.id), await scopeOf(req))));
  app.post('/api/apps/:id/restart', requireAuth, handle(async (req) => service.restart(String(req.params.id), await scopeOf(req))));
  app.post('/api/apps/:id/takeover', requireAuth, handle(async (req) => {
    const pids = Array.isArray(req.body?.pids) ? req.body.pids.filter(Number.isInteger) : [];
    return service.takeover(String(req.params.id), { ...(await scopeOf(req)), pids });
  }));
}
