import pty from 'node-pty';
import { BUILD_TASK_LABEL } from '../dev-build.js';
import { broadcastToClients, flushPtyOutput, queuePtyOutput, TASK_RUN_BUFFER_MAX } from '../pty-broadcast.js';

/**
 * @typedef {Object} TaskWsHandlerContext
 * @property {Map<string, object>} taskRuns
 * @property {string} devBuildRunId
 * @property {() => object|null} loadCurrentTasks
 * @property {() => { workspaceFile: string, cwd: string }} buildTaskRunScopeSnapshot
 * @property {(run: object, scope: object) => boolean} isTaskRunInScope
 * @property {() => string} randomSessionId
 * @property {(overrides?: object) => NodeJS.ProcessEnv} buildInteractivePtyEnv
 */

/**
 * Runs a task from `.vscode/tasks.json` and streams output over WebSocket.
 * Session keeps running in the background after client disconnect.
 *
 * @param {import('ws').WebSocket} ws
 * @param {string} taskLabel
 * @param {string|null} runIdParam
 * @param {TaskWsHandlerContext} ctx
 */
export function handleTaskConnection(ws, taskLabel, runIdParam, ctx) {
  const scope = ctx.buildTaskRunScopeSnapshot();
  if (runIdParam && ctx.taskRuns.has(runIdParam)) {
    const run = ctx.taskRuns.get(runIdParam);
    if (!ctx.isTaskRunInScope(run, scope)) {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({
          type: 'output',
          data: '\r\n\x1b[31mThe task run belongs to a different workspace/folder.\x1b[0m\r\n',
        }));
      }
      ws.close();
      return;
    }
    if (run.buffer && run.buffer.length > 0 && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'output', catchUp: true, data: run.buffer }));
    }
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'taskRunId', runId: runIdParam }));
    }
    run.clients.add(ws);
    ws.on('close', () => {
      run.clients.delete(ws);
    });
    return;
  }
  if (runIdParam === ctx.devBuildRunId && taskLabel === BUILD_TASK_LABEL) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({
        type: 'output',
        data: '\r\n\x1b[33mBuild is not running. Click "Restart front build".\x1b[0m\r\n',
      }));
    }
    ws.close();
    return;
  }
  const data = ctx.loadCurrentTasks();
  if (!data) {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'output', data: '\r\n\x1b[31mMissing .vscode/tasks.json\x1b[0m\r\n' }));
    ws.close();
    return;
  }
  const task = data.tasks.find((entry) => entry.label === taskLabel);
  if (!task) {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'output', data: `\r\n\x1b[31mTask not found: ${taskLabel}\x1b[0m\r\n` }));
    ws.close();
    return;
  }
  let ptyProcess;
  try {
    const env = ctx.buildInteractivePtyEnv(task.env || {});
    // Task "build front (watch)" must always run as watch on disk — not inherit HMR=1 from server.
    if (taskLabel === BUILD_TASK_LABEL) {
      env.CRETLI_FRONT_HMR = '0';
      env.CRETLI_FRONT_HMR = '0';
      env.CURSOR_REMOTE_FRONT_HMR = '0';
    }
    if (task.type === 'shell') {
      const shell = process.env.SHELL || 'bash';
      ptyProcess = pty.spawn(shell, ['-c', task.command], {
        cwd: task.cwd,
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        env,
      });
    } else {
      ptyProcess = pty.spawn(task.command, task.args || [], {
        cwd: task.cwd,
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        env: ctx.buildInteractivePtyEnv(task.env || {}),
      });
    }
  } catch (err) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'output', data: `\r\n\x1b[31mError: ${err.message}\x1b[0m\r\n` }));
    }
    ws.close();
    return;
  }
  const runId = ctx.randomSessionId();
  const clients = new Set([ws]);
  const run = {
    pty: ptyProcess,
    clients,
    buffer: '',
    bufferMax: TASK_RUN_BUFFER_MAX,
    taskLabel,
    workspaceFile: scope.workspaceFile,
    cwd: scope.cwd,
  };
  ctx.taskRuns.set(runId, run);
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'taskRunId', runId }));
  }
  ptyProcess.onData((chunk) => queuePtyOutput(clients, run, chunk));
  ptyProcess.onExit(() => {
    flushPtyOutput(clients, run);
    broadcastToClients(clients, { type: 'output', data: '\r\n\x1b[33m[Task finished.]\x1b[0m\r\n' });
    for (const client of clients) {
      if (client.readyState === 1) client.close();
    }
    ctx.taskRuns.delete(runId);
  });
  ws.on('close', () => {
    clients.delete(ws);
    // Do not kill PTY — task keeps running in the background (like agent).
  });
}
