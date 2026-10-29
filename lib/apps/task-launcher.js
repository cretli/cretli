/**
 * Starts an app as a regular task run: a PTY registered in the shared `taskRuns`
 * map, so it shows up in `/api/task-runs` and can be attached to over `/ws-task`.
 * Mirrors the PTY setup of lib/ws/task-ws-handler.ts without changing it.
 */

import pty from 'node-pty';
import { broadcastToClients, flushPtyOutput, queuePtyOutput, TASK_RUN_BUFFER_MAX } from '../pty-broadcast.js';
import { canAcceptNewRun } from '../update-gate.js';
import { trackChildProcess } from '../child-process-registry.js';
import { assertExecutorLaunchAllowed } from '../executor-launch-gate.js';

/**
 * @typedef {{
 *   label: string,
 *   type: 'shell'|'process',
 *   command: string,
 *   args?: string[],
 *   cwd: string,
 *   env?: Record<string, string>,
 *   workspaceDir: string,
 * }} LaunchSpec
 */

/**
 * @param {{
 *   taskRuns: Map<string, any>,
 *   buildInteractivePtyEnv: (overrides?: Record<string, string>) => NodeJS.ProcessEnv,
 *   randomSessionId: () => string,
 *   buildTaskRunScopeSnapshot?: () => { workspaceFile: string, cwd: string },
 *   spawnPty?: typeof pty.spawn,
 * }} deps
 * @returns {(spec: LaunchSpec, hooks?: { onExit?: (info: { runId: string }) => void }) => { runId: string, pid: number }}
 */
export function createTaskLauncher(deps) {
  const spawnPty = deps.spawnPty || pty.spawn;
  return function launchTask(spec, hooks = {}) {
    if (!canAcceptNewRun()) throw new Error('An update or install is in progress; new runs are not accepted.');
    assertExecutorLaunchAllowed({ type: 'task-run', label: spec.label });
    const env = deps.buildInteractivePtyEnv(spec.env || {});
    const ptyProcess = spec.type === 'shell'
      ? spawnPty(process.env.SHELL || 'bash', ['-c', spec.command], { cwd: spec.cwd, name: 'xterm-256color', cols: 80, rows: 24, env })
      : spawnPty(spec.command, spec.args || [], { cwd: spec.cwd, name: 'xterm-256color', cols: 80, rows: 24, env });
    const runId = deps.randomSessionId();
    const clients = new Set();
    const scope = deps.buildTaskRunScopeSnapshot ? deps.buildTaskRunScopeSnapshot() : { workspaceFile: '', cwd: spec.workspaceDir };
    /** @type {any} */
    const run = {
      pty: ptyProcess,
      clients,
      buffer: '',
      bufferMax: TASK_RUN_BUFFER_MAX,
      taskLabel: spec.label,
      workspaceFile: scope.workspaceFile,
      // Same visibility rule as /ws-task runs: the run is scoped to the selected workspace folder.
      cwd: scope.cwd || spec.workspaceDir,
    };
    deps.taskRuns.set(runId, run);
    trackChildProcess(ptyProcess, { type: 'task-run', label: spec.label });
    ptyProcess.onData((chunk) => queuePtyOutput(clients, run, chunk));
    ptyProcess.onExit(() => {
      flushPtyOutput(clients, run);
      broadcastToClients(clients, { type: 'output', data: '\r\n\x1b[33m[Task finished.]\x1b[0m\r\n' });
      for (const client of clients) {
        if (client.readyState === 1) client.close();
      }
      deps.taskRuns.delete(runId);
      try { hooks.onExit?.({ runId }); } catch { /* observers must not break cleanup */ }
    });
    return { runId, pid: ptyProcess.pid };
  };
}

/**
 * Stops one task run: kills its PTY, closes attached clients and removes it from the map.
 * Same effect as DELETE /api/task-runs/:runId, which is left unchanged.
 *
 * @param {Map<string, any>} taskRuns
 * @param {string} runId
 * @returns {boolean} false when the run does not exist
 */
export function killTaskRun(taskRuns, runId) {
  const run = taskRuns.get(runId);
  if (!run) return false;
  if (run.pty) {
    try { run.pty.kill(); } catch { /* already gone */ }
  }
  for (const client of run.clients || []) {
    if (client.readyState === 1) {
      try { client.close(1000, 'run stopped'); } catch { /* ignore */ }
    }
  }
  taskRuns.delete(runId);
  return true;
}
