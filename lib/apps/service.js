/**
 * App registry service: start/stop/restart through task runs, status, suggestions.
 *
 * Isolation rule: `stop` acts only on the run stored in this app's appId -> runId
 * mapping. A task run started any other way (for example by `/ws-task`) is never
 * touched. The one code path that signals a foreign PID is `takeover`: a confirmed
 * user action limited to the listener on the app's own port, running from inside
 * this workspace. It is deliberately not offered to agents.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadAppsFile, saveAppsFile, validateApp } from './schema.js';
import { buildSuggestions } from './suggestions.js';
import { killTaskRun } from './task-launcher.js';
import { listGitWorktrees } from '../worktree/git-worktree.ts';
import {
  belongsToProcessTree, classifyAppPorts, detectPortConflicts, findOrphans, probeHealth, readParentPid,
} from './monitor.js';

/** A status request answers from the monitor's last pass while it is at most this old. */
const STATUS_MAX_AGE_MS = 10_000;
/** How long a workspace stays monitored after its last status request. */
const VIEWER_TTL_MS = 30_000;
/** How long a takeover waits for the old process to release the port after SIGTERM. */
const TAKEOVER_WAIT_MS = 5_000;
const TAKEOVER_POLL_MS = 200;

/** @param {number} status @param {string} error @param {string} message @param {object} [extra] @returns {Record<string, any>} */
const fail = (status, error, message, extra = {}) => ({ ok: false, status, error, message, ...extra });

/**
 * Resolves a command-form cwd against the workspace and returns it only when the
 * real path (symlinks resolved) is an existing directory inside the workspace root
 * or inside one of `extraRoots` (linked Git worktrees of the same repository).
 *
 * @param {string} workspaceDir
 * @param {string|undefined} cwd
 * @param {string[]} [extraRoots]
 * @returns {string|null}
 */
export function resolveConfinedCwd(workspaceDir, cwd, extraRoots = []) {
  try {
    const real = fs.realpathSync(path.resolve(workspaceDir, cwd || '.'));
    const inside = (rootDir) => {
      try {
        const rel = path.relative(fs.realpathSync(rootDir), real);
        return !rel.startsWith('..') && !path.isAbsolute(rel);
      } catch {
        return false;
      }
    };
    if (![workspaceDir, ...extraRoots].some(inside)) return null;
    return fs.statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/** Git worktrees of the workspace's repository (the checkout itself included); empty outside a repo. */
function defaultWorktreeRoots(workspaceDir) {
  try {
    return listGitWorktrees(workspaceDir).filter((w) => !w.bare).map((w) => w.path);
  } catch {
    return [];
  }
}

/**
 * True when a process runs from inside the workspace. An unreadable cwd counts as outside.
 *
 * @param {string} workspaceDir
 * @param {number} pid
 * @returns {boolean}
 */
export function processRunsInWorkspace(workspaceDir, pid) {
  try {
    const root = fs.realpathSync(workspaceDir);
    const rel = path.relative(root, fs.realpathSync(`/proc/${pid}/cwd`));
    return !rel.startsWith('..') && !path.isAbsolute(rel);
  } catch {
    return false;
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
 *   listWorktreeRoots?: (workspaceDir: string) => string[],
 *   parentOf?: (pid: number) => number | null,
 *   isAlive?: (pid: number) => boolean,
 *   runsInWorkspace?: (workspaceDir: string, pid: number) => boolean,
 *   signal?: (pid: number, signal: NodeJS.Signals) => void,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 * }} deps
 */
export function createAppsService(deps) {
  const probe = deps.probe || probeHealth;
  const listWorktreeRoots = deps.listWorktreeRoots || defaultWorktreeRoots;
  const parentOf = deps.parentOf || readParentPid;
  const now = deps.now || Date.now;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const isAlive = deps.isAlive || ((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
  const broadcast = deps.broadcast || (() => {});
  const runsInWorkspace = deps.runsInWorkspace || processRunsInWorkspace;
  const signal = deps.signal || ((pid, sig) => { process.kill(pid, sig); });
  /** @type {Map<string, { signature: string, report: any, at: number }>} */
  const lastReports = new Map();
  /** Workspaces somebody looked at lately, so the monitor follows them without any stored state. */
  /** @type {Map<string, number>} */
  const viewers = new Map();
  /** @type {Promise<any> | null} */
  let refreshing = null;

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
      const external = Boolean(app.start.external);
      apps.push({
        id: app.id, name: app.name, exposure: app.exposure, autoStart: Boolean(app.autoStart), external,
        status: external
          ? (ports.some((p) => p.listening) ? 'running' : 'stopped')
          : (run ? 'running' : (st.status === 'running' || st.status === 'starting' ? 'stopped' : st.status)),
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

  /** @param {{ dir?: string }} [opts] */
  const resolveDir = (opts) => dirKey(opts?.dir || deps.getWorkspaceDir());

  /** Runs one listener snapshot (one `ss`) and refreshes every known workspace. Concurrent callers share it. */
  function refresh() {
    if (!refreshing) refreshing = refreshAll().finally(() => { refreshing = null; });
    return refreshing;
  }

  async function refreshAll() {
    const snapshot = await deps.snapshot();
    const cutoff = now() - VIEWER_TTL_MS;
    for (const [dir, at] of viewers) if (at < cutoff) viewers.delete(dir);
    const dirs = new Set([dirKey(deps.getWorkspaceDir()), ...deps.state.workspaces(), ...viewers.keys()]);
    for (const dir of dirs) {
      let report;
      try { report = await buildReport(dir, snapshot); } catch (err) {
        report = { workspace: dir, valid: false, errors: [String(err?.message || err)], apps: [], orphans: [] };
      }
      report.listenersAvailable = snapshot.ok;
      if (!snapshot.ok) report.listenersError = snapshot.error;
      const signature = stable(report);
      if (lastReports.get(dir)?.signature !== signature) broadcast({ type: 'appsChanged', reason: 'status', workspace: dir });
      lastReports.set(dir, { signature, report, at: now() });
    }
    return snapshot;
  }

  /** True while the monitor has something to watch: an open Apps panel or a run Cretli started. */
  function hasWatchers() {
    if (viewers.size && [...viewers.values()].some((at) => at >= now() - VIEWER_TTL_MS)) return true;
    return deps.state.workspaces().some((dir) => {
      const { apps } = loadApps(dir);
      return (apps || []).some((app) => deps.state.get(dir, app.id).runId);
    });
  }

  const service = {
    refresh,

    /** Periodic pass; idle servers skip the snapshot entirely. */
    monitorTick: async () => (hasWatchers() ? refresh() : null),

    /** @param {{ dir?: string }} [opts] */
    list(opts) {
      const dir = resolveDir(opts);
      const loaded = /** @type {any} */ (loadAppsFile(dir));
      return loaded.ok
        ? { ok: true, exists: loaded.exists, apps: loaded.apps }
        : fail(400, 'apps-file-invalid', 'The .cretli/apps.json file is invalid.', { errors: loaded.errors });
    },

    /** @param {any} apps @param {{ dir?: string }} [opts] */
    put(apps, opts) {
      const saved = /** @type {any} */ (saveAppsFile(resolveDir(opts), apps));
      if (!saved.ok) return fail(400, 'invalid-apps', 'The app definitions are invalid.', { errors: saved.errors });
      lastReports.delete(resolveDir(opts));
      broadcast({ type: 'appsChanged', reason: 'definitions' });
      return { ok: true, apps: saved.apps };
    },

    /** Appends one definition (suggestion or orphan acceptance). Writes the definition only. */
    add(rawApp, opts) {
      const dir = resolveDir(opts);
      const errors = [];
      const app = validateApp(rawApp, 'app', errors);
      if (!app) return fail(400, 'invalid-apps', 'The app definition is invalid.', { errors });
      const loaded = /** @type {any} */ (loadAppsFile(dir));
      if (!loaded.ok) return fail(400, 'apps-file-invalid', 'Fix or replace the invalid .cretli/apps.json first.', { errors: loaded.errors });
      return service.put([...loaded.apps, app], { dir });
    },

    /** Removes one definition; a running app has to be stopped first so no run loses its owner. */
    remove(appId, opts) {
      const dir = resolveDir(opts);
      const { apps, error } = loadApps(dir);
      if (error) return error;
      if (!apps.some((a) => a.id === appId)) return fail(404, 'app-not-found', `No app "${appId}" in .cretli/apps.json.`);
      if (runAlive(deps.state.get(dir, appId).runId)) return fail(409, 'app-running', `Stop app "${appId}" before removing it.`);
      const result = service.put(apps.filter((a) => a.id !== appId), { dir });
      if (result.ok) deps.state.remove(dir, appId);
      return result;
    },

    /** @param {{ refresh?: boolean, dir?: string }} [opts] */
    async status(opts = {}) {
      const dir = resolveDir(opts);
      viewers.set(dir, now());
      const last = lastReports.get(dir);
      if (opts.refresh || !last || now() - last.at > STATUS_MAX_AGE_MS) await refresh();
      return { ok: true, ...(lastReports.get(dir)?.report || { workspace: dir, valid: true, apps: [], orphans: [], errors: [] }) };
    },

    /** @param {{ dir?: string }} [opts] */
    suggestions(opts) {
      const dir = resolveDir(opts);
      const loaded = /** @type {any} */ (loadAppsFile(dir));
      return { ok: true, suggestions: buildSuggestions(dir, loaded.ok ? loaded.apps : []) };
    },

    /** @returns {Promise<Record<string, any>>} */
    async start(appId, opts) {
      const dir = resolveDir(opts);
      const { apps, error } = loadApps(dir);
      if (error) return error;
      const app = apps.find((a) => a.id === appId);
      if (!app) return fail(404, 'app-not-found', `No app "${appId}" in .cretli/apps.json.`);
      if (app.start.external) return fail(409, 'app-external', `App "${app.id}" runs outside Cretli, so Cretli cannot start it.`);
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
        // A relative cwd that stays inside the workspace needs no Git lookup.
        const cwd = resolveConfinedCwd(dir, s.cwd) || resolveConfinedCwd(dir, s.cwd, listWorktreeRoots(dir));
        if (!cwd) {
          return fail(400, 'invalid-cwd', `Working directory "${s.cwd || '.'}" does not exist or is outside the workspace and its Git worktrees.`);
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
    async stop(appId, opts) {
      const dir = resolveDir(opts);
      const { apps, error } = loadApps(dir);
      if (error) return error;
      const app = apps.find((a) => a.id === appId);
      if (!app) return fail(404, 'app-not-found', `No app "${appId}" in .cretli/apps.json.`);
      if (app.start.external) return fail(409, 'app-external', `App "${app.id}" runs outside Cretli, so Cretli cannot stop it.`);
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

    /**
     * Ends the process holding this app's ports, then starts the app. SIGTERM only: a process
     * that ignores it keeps the port and the takeover reports that instead of escalating.
     * `opts.pids` is what the user confirmed, so a port that changed hands is refused.
     *
     * @param {string} appId
     * @param {{ dir?: string, pids?: number[] }} [opts]
     * @returns {Promise<Record<string, any>>}
     */
    async takeover(appId, opts) {
      const dir = resolveDir(opts);
      const { apps, error } = loadApps(dir);
      if (error) return error;
      const app = apps.find((a) => a.id === appId);
      if (!app) return fail(404, 'app-not-found', `No app "${appId}" in .cretli/apps.json.`);
      if (app.start.external) return fail(409, 'app-external', `App "${app.id}" runs outside Cretli, so Cretli cannot start it.`);
      if (runAlive(deps.state.get(dir, app.id).runId)) return fail(409, 'app-already-running', `App "${app.id}" is already running.`);

      const snapshot = await deps.snapshot();
      if (!snapshot.ok) return fail(503, 'listeners-unavailable', 'Cretli cannot read the port owners right now.');
      const conflicts = detectPortConflicts(app, snapshot.listeners);
      if (!conflicts.length) return service.start(appId, opts);

      const pids = [...new Set(conflicts.map((c) => c.pid))];
      const confirmed = new Set(opts?.pids || []);
      if (pids.some((pid) => !pid || !confirmed.has(pid))) {
        return fail(409, 'takeover-stale', 'The port owner changed; review it and confirm again.', { conflicts });
      }
      const killHint = `kill ${pids.join(' ')}`;
      if (pids.includes(process.pid) || pids.some((pid) => !runsInWorkspace(dir, pid))) {
        return fail(403, 'takeover-outside-workspace', 'The process does not run from this workspace, so Cretli will not end it.', { conflicts, killHint });
      }

      try {
        for (const pid of pids) signal(pid, 'SIGTERM');
      } catch (err) {
        return fail(500, 'takeover-failed', String(err?.message || err), { killHint });
      }
      const ports = new Set(app.ports.map((p) => p.port));
      for (let waited = 0; waited < TAKEOVER_WAIT_MS; waited += TAKEOVER_POLL_MS) {
        await sleep(TAKEOVER_POLL_MS);
        const next = await deps.snapshot();
        if (next.ok && !next.listeners.some((l) => ports.has(l.port))) return service.start(appId, opts);
      }
      return fail(409, 'takeover-timeout', 'The process did not release the port in time.', { killHint });
    },

    /** @returns {Promise<Record<string, any>>} */
    async restart(appId, opts) {
      const stopped = await service.stop(appId, opts);
      if (!stopped.ok && stopped.error !== 'app-not-running') return stopped;
      if (stopped.ok && stopped.pid) {
        for (let i = 0; i < 30 && isAlive(stopped.pid); i += 1) await sleep(100);
      }
      return service.start(appId, opts);
    },
  };
  return service;
}

export { belongsToProcessTree };
