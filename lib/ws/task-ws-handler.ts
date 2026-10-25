import pty from 'node-pty';
import type { IPty } from 'node-pty';
import type { WebSocket } from 'ws';
import { BUILD_TASK_LABEL } from '../dev-build.js';
import { broadcastToClients, flushPtyOutput, queuePtyOutput, TASK_RUN_BUFFER_MAX } from '../pty-broadcast.js';
import { canAcceptNewRun } from '../update-gate.js';
import { trackChildProcess } from '../child-process-registry.js';
import { assertExecutorLaunchAllowed } from '../executor-launch-gate.js';

/** One running (or recently running) task PTY and its attached clients. */
export type TaskRun = {
  pty: IPty,
  clients: Set<WebSocket>,
  buffer: string,
  bufferMax: number,
  _flushScheduled?: boolean,
  taskLabel: string,
  workspaceFile: string,
  cwd: string,
};

/** One entry of `.vscode/tasks.json` as resolved by `loadCurrentTasks`. */
export type TaskDefinition = {
  label: string,
  type?: string,
  command: string,
  args?: string[],
  cwd?: string,
  env?: Record<string, string>,
};

export type TaskWsHandlerContext = {
  taskRuns: Map<string, TaskRun>,
  devBuildRunId: string,
  loadCurrentTasks: (workspaceFile?: string) => { tasks: TaskDefinition[] } | null,
  buildTaskRunScopeSnapshot: () => { workspaceFile: string, cwd: string },
  isTaskRunInScope: (run: TaskRun, scope: { workspaceFile: string, cwd: string }) => boolean,
  randomSessionId: () => string,
  buildInteractivePtyEnv: (overrides?: Record<string, string>) => NodeJS.ProcessEnv,
};

/**
 * Runs a task from `.vscode/tasks.json` and streams output over WebSocket.
 * Session keeps running in the background after client disconnect.
 */
export function handleTaskConnection(
  ws: WebSocket,
  taskLabel: string,
  runIdParam: string | null,
  workspaceFileParam: string | null | undefined,
  ctx: TaskWsHandlerContext,
): void {
  const scope = ctx.buildTaskRunScopeSnapshot();
  if (runIdParam && ctx.taskRuns.has(runIdParam)) {
    const run = ctx.taskRuns.get(runIdParam)!;
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
  const data = ctx.loadCurrentTasks(workspaceFileParam || undefined);
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
  if (!canAcceptNewRun()) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({
        type: 'output',
        data: '\r\n\x1b[31mAn update or install is in progress. New task runs are not accepted until it finishes.\x1b[0m\r\n',
      }));
    }
    ws.close();
    return;
  }
  let ptyProcess: IPty;
  try {
    assertExecutorLaunchAllowed({ type: 'task-run', label: taskLabel });
    const env = ctx.buildInteractivePtyEnv(task.env || {});
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
      ws.send(JSON.stringify({ type: 'output', data: `\r\n\x1b[31mError: ${(err as Error).message}\x1b[0m\r\n` }));
    }
    ws.close();
    return;
  }
  const runId = ctx.randomSessionId();
  const clients = new Set<WebSocket>([ws]);
  const run: TaskRun = {
    pty: ptyProcess,
    clients,
    buffer: '',
    bufferMax: TASK_RUN_BUFFER_MAX,
    taskLabel,
    workspaceFile: scope.workspaceFile,
    cwd: scope.cwd,
  };
  ctx.taskRuns.set(runId, run);
  // Own the PTY so a server SIGKILL cannot leave the task run behind; the
  // startup sweep reclaims it from the registry.
  trackChildProcess(ptyProcess, { type: 'task-run', label: taskLabel });
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'taskRunId', runId }));
  }
  ptyProcess.onData((chunk: string) => queuePtyOutput(clients, run, chunk));
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
