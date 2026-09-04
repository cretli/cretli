import { loadAgents } from '../agents.js';
import { msg } from '../messages.js';

/**
 * @typedef {Object} TasksAgentsRoutesContext
 * @property {() => object|null} loadCurrentTasks
 * @property {Map<string, object>} taskRuns
 * @property {Map<string, object>} agentRuns
 * @property {string} devBuildRunId
 * @property {() => { workspaceFile: string, cwd: string }} buildTaskRunScopeSnapshot
 * @property {(run: object, scope: object) => boolean} isTaskRunInScope
 * @property {() => string} randomSessionId
 * @property {() => { schedules: object[] }} loadAgentsSchedule
 * @property {(data: { schedules: object[] }) => void} saveAgentsSchedule
 * @property {() => string} getCurrentCwd
 */

/**
 * @param {import('express').Express} app
 * @param {TasksAgentsRoutesContext} ctx
 */
export function registerTasksAgentsRoutes(app, ctx) {
  app.get('/api/tasks', (_req, res) => {
    try {
      const data = ctx.loadCurrentTasks();
      if (!data) return res.json({ ok: true, tasks: [] });
      res.json({ ok: true, tasks: data.tasks });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /** Active task runs (rejoin after page refresh, like terminal/chat sessions). */
  app.get('/api/task-runs', (_req, res) => {
    try {
      const scope = ctx.buildTaskRunScopeSnapshot();
      const runs = [];
      for (const [runId, run] of ctx.taskRuns.entries()) {
        if (runId === ctx.devBuildRunId) continue;
        if (!ctx.isTaskRunInScope(run, scope)) continue;
        if (run && run.taskLabel) runs.push({ runId, taskLabel: run.taskLabel });
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

  app.get('/api/agents', (_req, res) => {
    try {
      const data = loadAgents(ctx.getCurrentCwd());
      res.json({ ok: true, agents: data.agents || [] });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /** Active agent runs (rejoin after refresh, like task-runs). */
  app.get('/api/agent-runs', (_req, res) => {
    try {
      const runs = [];
      for (const [runId, run] of ctx.agentRuns.entries()) {
        if (run && run.agentName) runs.push({ runId, agentName: run.agentName });
      }
      res.json({ ok: true, runs });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/agents/schedule', (_req, res) => {
    try {
      const data = ctx.loadAgentsSchedule();
      res.json({ ok: true, schedules: data.schedules || [] });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.patch('/api/agents/schedule', (req, res) => {
    const schedules = req.body && req.body.schedules;
    if (!Array.isArray(schedules)) {
      return res.status(400).json({ ok: false, error: 'schedules (array) wymagane' });
    }
    try {
      ctx.saveAgentsSchedule({ schedules });
      res.json({ ok: true, schedules });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
}
