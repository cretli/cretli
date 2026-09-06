import pty from 'node-pty';
import { loadAgents } from '../agents.js';
import { broadcastToClients, flushPtyOutput, queuePtyOutput } from '../pty-broadcast.js';
import { readEnvAlias } from '../env-alias.js';

/**
 * @typedef {Object} AgentRunWsHandlerContext
 * @property {string} agentCmd
 * @property {string} agentModel
 * @property {() => string} getCurrentCwd
 * @property {Map<string, object>} agentRuns
 * @property {() => string} randomSessionId
 * @property {(overrides?: object) => NodeJS.ProcessEnv} buildInteractivePtyEnv
 * @property {() => { schedules: object[] }} loadAgentsSchedule
 */

/** @type {Map<string, number>} agentName -> last run timestamp */
const agentLastRunAt = new Map();
const DEFAULT_AGENT_COLS = 200;
const DEFAULT_AGENT_ROWS = 40;
const MAX_AGENT_COLS = 500;
const MAX_AGENT_ROWS = 200;

/**
 * @returns {{ cols: number, rows: number }}
 */
function resolveAgentPtySize() {
  const rawCols = readEnvAlias({
    current: 'CRETLI_AGENT_COLS',
    legacy: 'CURSOR_REMOTE_AGENT_COLS',
    defaultValue: String(DEFAULT_AGENT_COLS),
  });
  const rawRows = readEnvAlias({
    current: 'CRETLI_AGENT_ROWS',
    legacy: 'CURSOR_REMOTE_AGENT_ROWS',
    defaultValue: String(DEFAULT_AGENT_ROWS),
  });
  const parsedCols = Number.parseInt(rawCols, 10);
  const parsedRows = Number.parseInt(rawRows, 10);
  const cols = Math.min(parsedCols || DEFAULT_AGENT_COLS, MAX_AGENT_COLS);
  const rows = Math.min(parsedRows || DEFAULT_AGENT_ROWS, MAX_AGENT_ROWS);
  return { cols, rows };
}

export const AGENTS_SCHEDULER_INTERVAL_MS = 60 * 1000;

/**
 * @param {import('ws').WebSocket} ws
 * @param {string} agentName
 * @param {string|null} runIdParam
 * @param {AgentRunWsHandlerContext} ctx
 */
export function handleAgentRunConnection(ws, agentName, runIdParam, ctx) {
  if (runIdParam && ctx.agentRuns.has(runIdParam)) {
    const run = ctx.agentRuns.get(runIdParam);
    if (run.buffer && run.buffer.length > 0 && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'output', catchUp: true, data: run.buffer }));
    }
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'agentRunId', runId: runIdParam }));
    }
    run.clients.add(ws);
    ws.on('close', () => run.clients.delete(ws));
    return;
  }
  const data = loadAgents(ctx.getCurrentCwd());
  if (!data || !data.agents || data.agents.length === 0) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'output', data: '\r\n\x1b[31mNo agents in .cursor/agents\x1b[0m\r\n' }));
    }
    ws.close();
    return;
  }
  const agent = data.agents.find((entry) => entry.name === agentName);
  if (!agent) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'output', data: `\r\n\x1b[31mNie znaleziono agenta: ${agentName}\x1b[0m\r\n` }));
    }
    ws.close();
    return;
  }
  const agentDir = ctx.getCurrentCwd();
  const model = agent.model || ctx.agentModel;
  const effectiveModel = model === 'Auto' ? 'auto' : (model || 'auto');
  const args = ['--workspace', agentDir];
  if (effectiveModel) args.push('--model', effectiveModel);
  args.push('--agent', agentName);
  const ptySize = resolveAgentPtySize();
  const ptyCols = ptySize.cols;
  const ptyRows = ptySize.rows;
  const baseEnv = ctx.buildInteractivePtyEnv({ COLUMNS: String(ptyCols), ROWS: String(ptyRows) });
  const spawnEnv = {
    ...baseEnv,
    TERM_PROGRAM: 'cursor',
    TERM_PROGRAM_VERSION: process.env.TERM_PROGRAM_VERSION || '',
  };
  let ptyProcess;
  try {
    ptyProcess = pty.spawn(ctx.agentCmd, args, {
      cwd: agentDir,
      name: 'xterm-256color',
      cols: ptyCols,
      rows: ptyRows,
      env: spawnEnv,
    });
  } catch (err) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'output', data: `\r\n\x1b[31mError: ${err.message}\x1b[0m\r\n` }));
    }
    ws.close();
    return;
  }
  const runId = ctx.randomSessionId();
  const clients = new Set([ws]);
  const run = { pty: ptyProcess, clients, buffer: '', agentName, cwd: agentDir };
  ctx.agentRuns.set(runId, run);
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'agentRunId', runId }));
  }
  ptyProcess.onData((chunk) => queuePtyOutput(clients, run, chunk));
  setImmediate(() => {
    ptyProcess.write('Wykonaj swoje zadanie.\n');
  });
  ptyProcess.onExit(() => {
    flushPtyOutput(clients, run);
    broadcastToClients(clients, { type: 'output', data: '\r\n\x1b[33m[Agent finished.]\x1b[0m\r\n' });
    for (const client of clients) {
      if (client.readyState === 1) client.close();
    }
    ctx.agentRuns.delete(runId);
  });
  ws.on('close', () => {
    clients.delete(ws);
  });
}

/**
 * Runs an agent in the background (from scheduler) with no attached WS client.
 *
 * @param {string} agentName
 * @param {AgentRunWsHandlerContext} ctx
 */
export function runAgentInBackground(agentName, ctx) {
  const data = loadAgents(ctx.getCurrentCwd());
  if (!data?.agents?.length) return;
  const agent = data.agents.find((entry) => entry.name === agentName);
  if (!agent) return;
  const agentDir = ctx.getCurrentCwd();
  const model = agent.model || ctx.agentModel;
  const effectiveModel = model === 'Auto' ? 'auto' : (model || 'auto');
  const args = ['--workspace', agentDir];
  if (effectiveModel) args.push('--model', effectiveModel);
  args.push('--agent', agentName);
  try {
    const ptyProcess = pty.spawn(ctx.agentCmd, args, {
      cwd: agentDir,
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      env: ctx.buildInteractivePtyEnv(),
    });
    ptyProcess.onExit(() => {});
  } catch (err) {
    console.warn('[agents] runAgentInBackground', agentName, err.message);
  }
}

/**
 * @param {AgentRunWsHandlerContext} ctx
 */
export function runAgentsScheduler(ctx) {
  const data = ctx.loadAgentsSchedule();
  const schedules = data.schedules || [];
  const now = Date.now();
  for (const schedule of schedules) {
    if (!schedule.enabled || !schedule.agentName || !schedule.intervalMinutes || schedule.intervalMinutes < 1) continue;
    const last = agentLastRunAt.get(schedule.agentName) || 0;
    if (now - last >= schedule.intervalMinutes * 60 * 1000) {
      agentLastRunAt.set(schedule.agentName, now);
      runAgentInBackground(schedule.agentName, ctx);
    }
  }
}
