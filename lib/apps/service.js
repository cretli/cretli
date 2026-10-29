/**
 * App registry service: start/stop/restart through task runs, status, suggestions.
 *
 * Isolation rule: `stop` acts only on the run stored in this app's appId -> runId
 * mapping. A task run started any other way (for example by `/ws-task`) is never
 * touched, and there is no code path here that signals a foreign PID.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadAppsFile, saveAppsFile, validateApp } from './schema.js';
import { buildSuggestions } from './suggestions.js';
import { killTaskRun } from './task-launcher.js';
import {
  belongsToProcessTree, classifyAppPorts, detectPortConflicts, findOrphans, probeHealth, readParentPid,
} from './monitor.js';

/** @param {number} status @param {string} error @param {string} message @param {object} [extra] @returns {Record<string, any>} */
const fail = (status, error, message, extra = {}) => ({ ok: false, status, error, message, ...extra });

/**
 * Resolves a command-form cwd against the workspace and returns it only when the
 * real path (symlinks resolved) is an existing directory inside the workspace root.
 *
 * @param {string} workspaceDir
 * @param {string|undefined} cwd
 * @returns {string|null}
 */
export function resolveConfinedCwd(workspaceDir, cwd) {
  try {
    const root = fs.realpathSync(workspaceDir);
    const real = fs.realpathSync(path.resolve(workspaceDir, cwd || '.'));
    const rel = path.relative(root, real);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return fs.statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/**
 * @param {{
 *   getWorkspaceDir: () => string,
 *   taskRuns: Map<string, any>,
 *   launchTask: (spec: any, hooks?: any) => { runId: string, pid: number },
 *   loadTasksForWorkspace?: (input: { workspaceFolder?: string, workspaceFile?: string }) => { tasks: any[] } | null,
 *   snapshot: () => Promise<{ ok: boolean, listeners: any[], error?: string }>,
 *   state: ReturnType<typeof import('./state-store.js').createAppsStateStore>,
 *   broadcast?: (event: Record<string, any>) => void,
 *   notify?: (payload: Record<string, any>) => void | Promise<unknown>,
 *   probe?: typeof probeHealth,
 *   parentOf?: (pid: number) => number | null,
 *   isAlive?: (pid: number) => boolean,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 * }} deps
 */
export function createAppsService(deps) {
  const probe = deps.probe || probeHealth;
  const parentOf = deps.parentOf || readParentPid;
  const now = deps.now || Date.now;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const isAlive = deps.isAlive || ((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
  const broadcast = deps.broadcast || (() => {});
  /** @type {Map<string, { signature: string, report: any }>} */
  const lastReports = new Map();

  const dirKey = (dir) => path.resolve(dir);
  const runAlive = (runId) => Boolean(runId && deps.taskRuns.has(runId));

  /** Marks a mapped run as ended; idempotent per runId. Notifies when an autoStart app dies. */
  function handleRunEnded(workspaceDir, app, runId, reason) {
    const current = deps.state.get(workspaceDir, app.id);
    if (current.runId !== runId) return;
    deps.state.patch(workspaceDir, app.id, { runId: null, pid: null, status: 'exited', lastChangeAt: new Date(now()).toISOString() });
    deps.state.addError(workspaceDir, app.id, reason);
    broadcast({ type: 'appsChanged', reason: 'exited', appId: app.id });
    if (app.autoStart && deps.notify) {
      Promise.resolve(deps.notify({
        category: 'system', severity: 'error',
        title: `App "${app.name}" stopped unexpectedly`,
        body: reason,
        fingerprint: `apps:died:${dirKey(workspaceDir)}:${app.id}:${runId}`,
      })).catch(() => {});
    }
  }

  /** @param {string} workspaceDir */
  function loadApps(workspaceDir) {
    const loaded = /** @type {any} */ (loadAppsFile(workspaceDir));
    if (!loaded.ok) {
      return { error: fail(400, 'apps-file-invalid', 'The .cretli/apps.json file is invalid.', { errors: loaded.errors }) };
    }
    return { apps: /** @type {any[]} */ (loaded.apps) };
  }

  /** Reaps mapped runs that disappeared without a stop through this service. */
  function reapDeadRuns(workspaceDir, apps) {
    for (const app of apps) {
      const st = deps.state.get(workspaceDir, app.id);
      if (st.runId && !runAlive(st.runId)) handleRunEnded(workspaceDir, app, st.runId, 'The task run ended unexpectedly.');
    }
  }

  async function buildReport(workspaceDir, snapshot) {
    const loaded = /** @type {any} */ (loadAppsFile(workspaceDir));
    if (!loaded.ok) return { workspace: workspaceDir, valid: false, errors: loaded.errors, apps: [], orphans: [] };
    reapDeadRuns(workspaceDir, loaded.apps);
    const listeners = snapshot.listeners;
    const apps = [];
    for (const app of loaded.apps) {
      const st = deps.state.get(workspaceDir, app.id);
      const run = runAlive(st.runId) ? deps.taskRuns.get(st.runId) : null;
      const rootPid = run?.pty?.pid ?? null;
      const ports = /** @type {any[]} */ (classifyAppPorts(app, listeners, { rootPid, parentOf }));
      for (const p of ports) {
        const def = app.ports.find((x) => x.port === p.port);
        if (p.listening && def?.healthPath) {
          p.health = await probe({ bind: p.listener?.address, port: p.port, path: def.healthPath });
        }
      }
      apps.push({
        id: app.id, name: app.name, exposure: app.exposure, autoStart: Boolean(app.autoStart),
        status: run ? 'running' : (st.status === 'running' || st.status === 'starting' ? 'stopped' : st.status),
        runId: run ? st.runId : null, pid: rootPid,
        lastChangeAt: st.lastChangeAt, errors: st.errors, ports,
      });
    }
    return {
      workspace: workspaceDir, valid: true, errors: [], apps,
      orphans: snapshot.ok ? findOrphans(listeners, loaded.apps) : [],
    };
  }

  const stable = (report) => JSON.stringify(report, (k, v) => (k === 'latencyMs' ? undefined : v));

  /** Runs one listener snapshot (one `ss`) and refreshes every known workspace. */
  async function refresh() {
    const snapshot = await deps.snapshot();
    const dirs = new Set([dirKey(deps.getWorkspaceDir()), ...deps.state.workspaces()]);
    for (const dir of dirs) {
      let report;
      try { report = await buildReport(dir, snapshot); } catch (err) {
        report = { workspace: dir, valid: false, errors: [String(err?.message || err)], apps: [], orphans: [] };
      }
      report.listenersAvailable = snapshot.ok;
      if (!snapshot.ok) report.listenersError = snapshot.error;
      const signature = stable(report);
      if (lastReports.get(dir)?.signature !== signature) broadcast({ type: 'appsChanged', reason: 'status', workspace: dir });
      lastReports.set(dir, { signature, report });
    }
    return snapshot;
  }

  const service = {
    refresh,

    list() {
      const dir = deps.getWorkspaceDir();
      const loaded = /** @type {any} */ (loadAppsFile(dir));
      return loaded.ok
        ? { ok: true, exists: loaded.exists, apps: loaded.apps }
        : fail(400, 'apps-file-invalid', 'The .cretli/apps.json file is invalid.', { errors: loaded.errors });
    },

    put(apps) {
      const saved = /** @type {any} */ (saveAppsFile(deps.getWorkspaceDir(), apps));
      if (!saved.ok) return fail(400, 'invalid-apps', 'The app definitions are invalid.', { errors: saved.errors });
      broadcast({ type: 'appsChanged', reason: 'definitions' });
      return { ok: true, apps: saved.apps };
    },

    /** Appends one definition (suggestion or orphan acceptance). Writes the definition only. */
    add(rawApp) {
      const dir = deps.getWorkspaceDir();
      const errors = [];
      const app = validateApp(rawApp, 'app', errors);
      if (!app) return fail(400, 'invalid-apps', 'The app definition is invalid.', { errors });
      const loaded = /** @type {any} */ (loadAppsFile(dir));
      if (!loaded.ok) return fail(400, 'apps-file-invalid', 'Fix or replace the invalid .cretli/apps.json first.', { errors: loaded.errors });
      return service.put([...loaded.apps, app]);
    },

    /** @param {{ refresh?: boolean }} [opts] */
    async status(opts = {}) {
      const dir = dirKey(deps.getWorkspaceDir());
      if (opts.refresh || !lastReports.has(dir)) await refresh();
      return { ok: true, ...(lastReports.get(dir)?.report || { workspace: dir, valid: true, apps: [], orphans: [], errors: [] }) };
    },

    suggestions() {
      const dir = deps.getWorkspaceDir();
      const loaded = /** @type {any} */ (loadAppsFile(dir));
      return { ok: true, suggestions: buildSuggestions(dir, loaded.ok ? loaded.apps : []) };
    },

    /** @returns {Promise<Record<string, any>>} */
    async start(appId) {
      const dir = dirKey(deps.getWorkspaceDir());
      const { apps, error } = loadApps(dir);
      if (error) return error;
      const app = apps.find((a) => a.id === appId);
      if (!app) return fail(404, 'app-not-found', `No app "${appId}" in .cretli/apps.json.`);
      const st = deps.state.get(dir, app.id);
      if (runAlive(st.runId)) return fail(409, 'app-already-running', `App "${app.id}" is already running.`, { runId: st.runId });

      const snapshot = await deps.snapshot();
      const conflicts = snapshot.ok ? detectPortConflicts(app, snapshot.listeners) : [];
      if (conflicts.length) {
        return fail(409, 'port-in-use', 'A declared port is already used by another process.', { conflicts });
      }

      let spec;
      if ('taskLabel' in app.start) {
        const data = deps.loadTasksForWorkspace ? deps.loadTasksForWorkspace({ workspaceFolder: dir }) : null;
        const task = data?.tasks?.find((t) => t.label === app.start.taskLabel);
        if (!task) return fail(404, 'task-not-found', `Task "${app.start.taskLabel}" was not found in .vscode/tasks.json.`);
        spec = { label: task.label, type: task.type === 'process' ? 'process' : 'shell', command: task.command, args: task.args, cwd: task.cwd || dir, env: task.env, workspaceDir: dir };
      } else {
        const s = app.start;
        const cwd = resolveConfinedCwd(dir, s.cwd);
        if (!cwd) {
          return fail(400, 'invalid-cwd', `Working directory "${s.cwd || '.'}" does not exist or is outside the workspace.`);
        }
        spec = { label: app.name, type: s.args ? 'process' : 'shell', command: s.command, args: s.args, cwd, env: s.env, workspaceDir: dir };
      }

      try {
        const { runId, pid } = deps.launchTask(spec, {
          onExit: ({ runId: endedRunId }) => handleRunEnded(dir, app, endedRunId, 'The task run exited.'),
        });
        deps.state.patch(dir, app.id, { runId, pid, status: 'running', lastChangeAt: new Date(now()).toISOString() });
        broadcast({ type: 'appsChanged', reason: 'started', appId: app.id });
        return { ok: true, runId, pid, conflictCheck: snapshot.ok ? 'ok' : 'unavailable' };
      } catch (err) {
        deps.state.patch(dir, app.id, { runId: null, pid: null, status: 'failed', lastChangeAt: new Date(now()).toISOString() });
        deps.state.addError(dir, app.id, String(err?.message || err));
        broadcast({ type: 'appsChanged', reason: 'failed', appId: app.id });
        return fail(500, 'start-failed', String(err?.message || err));
      }
    },

    /** @returns {Promise<Record<string, any>>} */
    async stop(appId) {
      const dir = dirKey(deps.getWorkspaceDir());
      const { apps, error } = loadApps(dir);
      if (error) return error;
      const app = apps.find((a) => a.id === appId);
      if (!app) return fail(404, 'app-not-found', `No app "${appId}" in .cretli/apps.json.`);
      const st = deps.state.get(dir, app.id);
      // Only the run in this app's own mapping may be stopped; nothing else is looked up.
      if (!st.runId || !runAlive(st.runId)) {
        if (st.runId) deps.state.patch(dir, app.id, { runId: null, pid: null, status: 'stopped' });
        return fail(409, 'app-not-running', `App "${app.id}" has no active run started by Cretli.`);
      }
      const { runId, pid } = st;
      deps.state.patch(dir, app.id, { runId: null, pid: null, status: 'stopped', lastChangeAt: new Date(now()).toISOString() });
      killTaskRun(deps.taskRuns, runId);
      broadcast({ type: 'appsChanged', reason: 'stopped', appId: app.id });
      return { ok: true, runId, pid };
    },

    /** @returns {Promise<Record<string, any>>} */
    async restart(appId) {
      const stopped = await service.stop(appId);
      if (!stopped.ok && stopped.error !== 'app-not-running') return stopped;
      if (stopped.ok && stopped.pid) {
        for (let i = 0; i < 30 && isAlive(stopped.pid); i += 1) await sleep(100);
      }
      return service.start(appId);
    },
  };
  return service;
}

export { belongsToProcessTree };
