import { existsSync, realpathSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import pty from 'node-pty';
import { loadTasks } from './tasks.js';

/** Task label from `.vscode/tasks.json` used for remote front build restart. */
export const BUILD_TASK_LABEL = 'Cretli: build front (watch)';

/**
 * @typedef {Object} DevBuildRunContext
 * @property {Map<string, object>} taskRuns
 * @property {string} devBuildRunId
 * @property {() => string} getCurrentCwd
 * @property {() => object|null} getCurrentWorkspace
 * @property {string} projectRoot
 * @property {(overrides?: object) => NodeJS.ProcessEnv} buildInteractivePtyEnv
 * @property {(clients: Set<object>, state: object, data: string) => void} queuePtyOutput
 * @property {(clients: Set<object>, state: object) => void} flushPtyOutput
 * @property {(clients: Set<object>, data: object) => void} broadcastToClients
 * @property {number} taskRunBufferMax
 */

/**
 * @param {Map<string, object>} taskRuns
 * @param {string} taskLabel
 */
export function killTaskRunsByLabel(taskRuns, taskLabel) {
  for (const [runId, run] of taskRuns.entries()) {
    if (run.taskLabel === taskLabel && run.pty) {
      try {
        run.pty.kill();
      } catch (_) {}
      taskRuns.delete(runId);
    }
  }
}

/** Best-effort kill of webpack dev processes started outside the server (Linux/macOS). */
export function killExternalBuildProcesses() {
  if (process.platform === 'win32') return;
  try {
    execSync('pkill -f "webpack.dev.js" 2>/dev/null || true', { stdio: 'ignore' });
  } catch (_) {}
}

/**
 * Start front build with output preview (runId = dev-build).
 * Tasks are loaded from server dir first, then selected cwd, then workspace dir.
 * @param {DevBuildRunContext} ctx
 * @returns {{ started: boolean, detail: string }}
 */
export function startDevBuildRun(ctx) {
  const selectedDir = ctx.getCurrentCwd();
  const workspace = ctx.getCurrentWorkspace();
  let serverDir;
  try {
    serverDir = realpathSync(ctx.projectRoot);
  } catch {
    serverDir = ctx.projectRoot;
  }
  const dirsToTry = [serverDir];
  if (selectedDir !== serverDir) dirsToTry.push(selectedDir);
  if (workspace && workspace.workspaceDir !== serverDir && workspace.workspaceDir !== selectedDir) {
    dirsToTry.push(workspace.workspaceDir);
  }
  let data = null;
  let tasksDir = null;
  for (const dir of dirsToTry) {
    data = loadTasks(dir);
    if (data) {
      tasksDir = dir;
      break;
    }
  }
  if (!data) {
    const serverTasksPath = path.join(serverDir, '.vscode', 'tasks.json');
    console.log(
      '[dev-actions] startDevBuildRun: no .vscode/tasks.json in',
      dirsToTry.join(', '),
      '| file exists in serverDir:',
      existsSync(serverTasksPath),
    );
    return { started: false, detail: 'No .vscode/tasks.json in the server, selected or workspace directory' };
  }
  const task = data.tasks.find((entry) => entry.label === BUILD_TASK_LABEL);
  if (!task) {
    console.log('[dev-actions] startDevBuildRun: no task', BUILD_TASK_LABEL, 'in', tasksDir);
    return { started: false, detail: `No "${BUILD_TASK_LABEL}" task in .vscode/tasks.json` };
  }
  let ptyProcess;
  try {
    const env = ctx.buildInteractivePtyEnv(task.env || {});
    env.CRETLI_FRONT_HMR = '0';
    env.CURSOR_REMOTE_FRONT_HMR = '0';
    const shell = process.env.SHELL || 'bash';
    ptyProcess = pty.spawn(shell, ['-c', task.command], {
      cwd: task.cwd,
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      env,
    });
  } catch (err) {
    console.log('[dev-actions] startDevBuildRun: spawn error', err.message);
    return { started: false, detail: 'Failed to start: ' + err.message };
  }
  const clients = new Set();
  const run = {
    pty: ptyProcess,
    clients,
    buffer: '',
    bufferMax: ctx.taskRunBufferMax,
    taskLabel: BUILD_TASK_LABEL,
  };
  ctx.taskRuns.set(ctx.devBuildRunId, run);
  ptyProcess.onData((chunk) => ctx.queuePtyOutput(clients, run, chunk));
  ptyProcess.onExit(() => {
    ctx.flushPtyOutput(clients, run);
    ctx.broadcastToClients(clients, { type: 'output', data: '\r\n\x1b[33m[Build finished.]\x1b[0m\r\n' });
    for (const client of clients) {
      if (client.readyState === 1) client.close();
    }
    ctx.taskRuns.delete(ctx.devBuildRunId);
  });
  console.log('[dev-actions] startDevBuildRun: started in selected context', tasksDir, '→', task.command, 'cwd=', task.cwd);
  return { started: true, detail: 'Started (directory: ' + tasksDir + ')' };
}
