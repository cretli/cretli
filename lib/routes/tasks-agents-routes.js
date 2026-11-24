import path from 'path';
import { loadAgents } from '../agents.js';
import { msg } from '../messages.js';
import { loadSettings } from '../persist/settings.js';
import { resolveTodoHomeFromSettings } from '../todo-home.js';
import { requestFolderOf, workspaceScopeMiddleware } from '../workspace-scope.js';

/**
 * @typedef {Object} TasksAgentsRoutesContext
 * @property {(workspaceFile?: string) => Record<string, any>|null} loadCurrentTasks
 * @property {Map<string, Record<string, any>>} taskRuns
 * @property {string} devBuildRunId
 * @property {() => { workspaceFile: string, cwd: string }} buildTaskRunScopeSnapshot
 * @property {(run: Record<string, any>, scope: Record<string, any>) => boolean} isTaskRunInScope
 * @property {() => string} randomSessionId
 * @property {any} [loadTasksForWorkspace]
 * @property {() => Record<string, any>} [loadSettings]
 */

/**
 * @param {import('express').Express} app
 * @param {TasksAgentsRoutesContext} ctx
 */
export function registerTasksAgentsRoutes(app, ctx) {
  const readSettings = typeof ctx.loadSettings === 'function' ? ctx.loadSettings : loadSettings;
  // Listing tasks, runs and agents is per workspace: no scope means 400, never the global selection.
  if (typeof app?.use === 'function') {
    app.use(['/api/tasks', '/api/task-runs', '/api/agents'], workspaceScopeMiddleware({
      loadSettings: readSettings,
    }));
  }
  const folderOf = (req) => requestFolderOf(req, (input) => resolveTodoHomeFromSettings(input, readSettings()));

  /**
   * File selector of a request. A folder-only request keeps filtering by its folder: the resolver may
   * infer a containing .code-workspace, but runs created from a folder store an empty workspaceFile.
   */
  const fileOf = (req) => {
    const explicit = String(req.query?.workspaceFile || req.body?.workspaceFile || '').trim();
    if (explicit) return explicit;
    const explicitFolder = String(req.query?.workspaceFolder || req.body?.workspaceFolder || '').trim();
    return explicitFolder ? '' : String(req.requestScope?.workspaceFile || '').trim();
  };

  app.get('/api/tasks', (req, res) => {
    try {
      const workspaceFile = fileOf(req);
      const workspaceFolder = folderOf(req);
      const data = typeof ctx.loadTasksForWorkspace === 'function' && (workspaceFolder || workspaceFile)
        ? ctx.loadTasksForWorkspace({ workspaceFile, workspaceFolder })
        : ctx.loadCurrentTasks(workspaceFile);
      if (!data) return res.json({ ok: true, tasks: [] });
      res.json({ ok: true, tasks: data.tasks });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /** Active task runs (rejoin after page refresh, like terminal/chat sessions). */
  app.get('/api/task-runs', (req, res) => {
    try {
      const folder = folderOf(req);
      const workspaceFile = fileOf(req);
      const scope = { workspaceFile: folder ? '' : workspaceFile, cwd: folder };
      const runs = [];
      for (const [runId, run] of ctx.taskRuns.entries()) {
        if (runId === ctx.devBuildRunId) continue;
        if (folder) {
          if (workspaceFile && run.workspaceFile !== workspaceFile) continue;
          const runCwd = String(run?.cwd || '').trim();
          if (!runCwd || path.resolve(runCwd) !== path.resolve(folder)) continue;
        } else if (!ctx.isTaskRunInScope(run, scope)) {
          continue;
        }
        if (run && run.taskLabel) runs.push({ runId, taskLabel: run.taskLabel, cwd: run.cwd || '' });
      }
      res.json({ ok: true, runs });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /** Stop an active task run (kill PTY + close clients). */
  app.delete('/api/task-runs/:runId', (req, res) => {
    try {
      const runId = req.params?.runId ? String(req.params.runId).trim() : '';
      if (!runId) {
        return res.status(400).json({ ok: false, error: msg(req, 'tasks.noRunId') });
      }
      const run = ctx.taskRuns.get(runId);
      if (!run) {
        return res.status(404).json({ ok: false, error: msg(req, 'tasks.runNotFound') });
      }
      const folder = folderOf(req);
      const workspaceFile = fileOf(req);
      const inScope = folder
        ? path.resolve(String(run.cwd || '')) === path.resolve(folder)
        : ctx.isTaskRunInScope(run, { workspaceFile, cwd: '' });
      if (!inScope) return res.status(404).json({ ok: false, error: msg(req, 'tasks.runNotFound') });
      if (run.pty) {
        try {
          run.pty.kill();
        } catch (_) {}
      }
      for (const client of run.clients || []) {
        if (client.readyState === 1) {
          try {
            client.close(1000, 'run stopped');
          } catch (_) {}
        }
      }
      ctx.taskRuns.delete(runId);
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/agents', (req, res) => {
    try {
      const folder = folderOf(req);
      if (!folder) return res.status(400).json({ ok: false, code: 'workspace-scope-required', error: 'workspace-scope-required' });
      const data = loadAgents(folder);
      res.json({ ok: true, agents: data.agents || [] });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

}
