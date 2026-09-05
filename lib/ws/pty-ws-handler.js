import { readFileSync } from 'fs';
import path from 'path';
import pty from 'node-pty';
import { loadAgents } from '../agents.js';
import { broadcastToClients, flushPtyOutput, queuePtyOutput } from '../pty-broadcast.js';
import { readEnvAlias } from '../env-alias.js';

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

/**
 * @typedef {Object} PtyWsHandlerContext
 * @property {string} agentCmd
 * @property {string} agentModel
 * @property {() => string} getCurrentCwd
 * @property {(workspacePath: string|null|undefined) => string} workspaceDirForAgent
 * @property {Map<string, object>} terminalSessions
 * @property {Map<string, object>} agentSessions
 * @property {() => string|null} getCurrentAgentRunResumeId
 * @property {(id: string|null) => void} setCurrentAgentRunResumeId
 * @property {() => string|null} getLastTerminalSessionId
 * @property {(sessionId: string|null) => void} setLastTerminalSessionId
 * @property {() => string} randomSessionId
 * @property {(overrides?: object) => NodeJS.ProcessEnv} buildInteractivePtyEnv
 */

/** @param {string} cmd @param {string[]} args */
function buildAgentLaunchCommandLine(cmd, args) {
  const parts = [cmd, ...args];
  return parts.map((part) => (String(part).includes(' ') ? `"${part}"` : part)).join(' ');
}

/**
 * @param {import('ws').WebSocket} ws
 * @param {boolean} isAgent
 * @param {string|null} resumeId
 * @param {string|null} workspacePath
 * @param {string|null} workspaceFolder
 * @param {string|null} model
 * @param {string|null} terminalSessionId
 * @param {boolean} sessionSyncEnabled
 * @param {string|null} agentRunName
 * @param {PtyWsHandlerContext} ctx
 */
export function handlePtyConnection(
  ws,
  isAgent,
  resumeId,
  workspacePath,
  workspaceFolder,
  model,
  terminalSessionId,
  sessionSyncEnabled,
  agentRunName,
  ctx,
) {
  const command = isAgent ? ctx.agentCmd : (process.env.SHELL || 'bash');
  const agentDir = workspaceFolder || ctx.workspaceDirForAgent(workspacePath);
  const agentCwd = agentDir;
  let effectiveModel = model || ctx.agentModel;
  if (effectiveModel === 'Auto') effectiveModel = 'auto';
  const cwdNow = ctx.getCurrentCwd();
  let args = isAgent && (workspacePath || cwdNow) ? ['--workspace', agentDir] : isAgent ? [] : [];
  if (isAgent && effectiveModel) args = [...args, '--model', effectiveModel];
  if (isAgent && resumeId) {
    args = [...args, '--resume', resumeId];
  }
  const agentLaunchCommandLine = isAgent ? buildAgentLaunchCommandLine(command, args) : null;
  let sessionKey;
  let clients;
  let ptyProcess;
  if (isAgent && resumeId && ctx.agentSessions.has(resumeId)) {
    const session = ctx.agentSessions.get(resumeId);
    ptyProcess = session.pty;
    clients = session.clients;
    sessionKey = resumeId;
    // Catch-up before adding to clients — otherwise the client gets the same data
    // in catch-up and in broadcast → duplication in xterm.
    if (session.launchInfo && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'agentLaunch', commandLine: session.launchInfo.commandLine, cwd: session.launchInfo.cwd }));
    }
    if (session.buffer && session.buffer.length > 0 && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'output', catchUp: true, data: session.buffer }));
      if (session.ptyCols && session.ptyRows && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'ptySize', cols: session.ptyCols, rows: session.ptyRows }));
      }
    }
    clients.add(ws);
  } else if (!isAgent && sessionSyncEnabled && terminalSessionId && ctx.terminalSessions.has(terminalSessionId)) {
    const session = ctx.terminalSessions.get(terminalSessionId);
    ptyProcess = session.pty;
    clients = session.clients;
    sessionKey = terminalSessionId;
    if (session.buffer && session.buffer.length > 0 && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'output', catchUp: true, data: session.buffer }));
      if (session.ptyCols && session.ptyRows && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'ptySize', cols: session.ptyCols, rows: session.ptyRows }));
      }
    }
    clients.add(ws);
  } else {
    const ptySize = isAgent ? resolveAgentPtySize() : { cols: 80, rows: 24 };
    const ptyCols = ptySize.cols;
    const ptyRows = ptySize.rows;
    const baseEnv = ctx.buildInteractivePtyEnv({ COLUMNS: String(ptyCols), ROWS: String(ptyRows) });
    const spawnEnv = { ...baseEnv, TERM_PROGRAM: 'cursor', TERM_PROGRAM_VERSION: process.env.TERM_PROGRAM_VERSION || '' };
    try {
      ptyProcess = pty.spawn(command, args, {
        cwd: isAgent ? agentCwd : cwdNow,
        name: 'xterm-256color',
        cols: ptyCols,
        rows: ptyRows,
        env: spawnEnv,
      });
    } catch (err) {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'output', data: `\r\n\x1b[31mError: ${err.message}\x1b[0m\r\n` }));
      }
      ws.close();
      return;
    }
    clients = new Set([ws]);
    const sessionData = {
      pty: ptyProcess,
      clients,
      buffer: '',
      clientSizes: new Map(),
      ptyCols,
      ptyRows,
      ...(isAgent && agentLaunchCommandLine !== null && { launchInfo: { commandLine: agentLaunchCommandLine, cwd: agentCwd } }),
    };
    if (isAgent && resumeId) {
      sessionKey = resumeId;
      ctx.agentSessions.set(resumeId, sessionData);
    } else {
      sessionKey = ctx.randomSessionId();
      if (sessionSyncEnabled) ctx.setLastTerminalSessionId(sessionKey);
      ctx.terminalSessions.set(sessionKey, sessionData);
      if (sessionSyncEnabled && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'sessionId', sessionId: sessionKey }));
      }
    }
    if (isAgent && sessionData.launchInfo && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'agentLaunch', commandLine: sessionData.launchInfo.commandLine, cwd: sessionData.launchInfo.cwd }));
    }
    ptyProcess.onData((data) => {
      const session = isAgent ? ctx.agentSessions.get(sessionKey) : ctx.terminalSessions.get(sessionKey);
      if (session) queuePtyOutput(clients, session, data);
    });
    ptyProcess.onExit(() => {
      if (sessionKey === ctx.getCurrentAgentRunResumeId()) ctx.setCurrentAgentRunResumeId(null);
      const session = isAgent ? ctx.agentSessions.get(sessionKey) : ctx.terminalSessions.get(sessionKey);
      if (session) flushPtyOutput(clients, session);
      broadcastToClients(clients, { type: 'output', data: '\r\n\x1b[33m[Session ended.]\x1b[0m\r\n' });
      for (const client of clients) {
        if (client.readyState === 1) client.close();
      }
      if (isAgent && sessionKey) ctx.agentSessions.delete(sessionKey);
      else if (sessionKey) ctx.terminalSessions.delete(sessionKey);
    });
    if (isAgent && agentRunName) {
      const workspaceDir = workspacePath ? path.dirname(workspacePath) : ctx.getCurrentCwd();
      try {
        const data = loadAgents(workspaceDir);
        const agent = data.agents && data.agents.find((entry) => entry.name === agentRunName);
        if (agent && agent.path) {
          const fullPath = path.isAbsolute(agent.path)
            ? agent.path
            : path.join(workspaceDir, agent.path);
          const content = readFileSync(fullPath, 'utf8');
          setImmediate(() => ptyProcess.write(content + '\n'));
        }
      } catch (err) {
        console.warn('[pty] agent prompt inject failed:', err?.message || err);
      }
    }
  }
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'ping') {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }
      if (msg.type === 'input') {
        try {
          ptyProcess.write(msg.data);
        } catch (err) {
          console.warn('[pty] write failed:', err?.message || err);
        }
      }
      if (msg.type === 'resize' && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
        const session = isAgent ? ctx.agentSessions.get(sessionKey) : ctx.terminalSessions.get(sessionKey);
        if (session) {
          if (!session.clientSizes) session.clientSizes = new Map();
          session.clientSizes.set(ws, { cols: msg.cols, rows: msg.rows });
          const sizes = Array.from(session.clientSizes.values());
          const cols = sizes.length
            ? Math.max(2, ...sizes.map((size) => size.cols))
            : Math.max(2, msg.cols);
          const rows = sizes.length
            ? Math.max(2, ...sizes.map((size) => size.rows))
            : Math.max(2, msg.rows);
          const sizeChanged = session.ptyCols !== cols || session.ptyRows !== rows;
          if (!sizeChanged) return;
          session.ptyCols = cols;
          session.ptyRows = rows;
          /** Debounce agent PTY resize: fewer full TUI redraws in xterm. */
          const debounceMs = isAgent ? 120 : 0;
          const applyResize = () => {
            session._resizeDebounceTimer = null;
            try {
              ptyProcess.resize(session.ptyCols, session.ptyRows);
            } catch (err) {
              console.warn('[pty] resize failed:', err?.message || err);
            }
            broadcastToClients(clients, { type: 'ptySize', cols: session.ptyCols, rows: session.ptyRows });
          };
          if (debounceMs <= 0) {
            applyResize();
          } else {
            if (session._resizeDebounceTimer) clearTimeout(session._resizeDebounceTimer);
            session._resizeDebounceTimer = setTimeout(applyResize, debounceMs);
          }
        } else {
          ptyProcess.resize(msg.cols, msg.rows);
        }
      }
    } catch (err) {
      console.warn('[pty] invalid ws message:', err?.message || err);
    }
  });
  ws.on('close', () => {
    const session = isAgent ? ctx.agentSessions.get(sessionKey) : ctx.terminalSessions.get(sessionKey);
    if (session?._resizeDebounceTimer) {
      clearTimeout(session._resizeDebounceTimer);
      session._resizeDebounceTimer = null;
    }
    if (session && session.clientSizes) {
      session.clientSizes.delete(ws);
      if (session.clientSizes.size > 0) {
        const sizes = Array.from(session.clientSizes.values());
        const cols = Math.max(2, ...sizes.map((size) => size.cols));
        const rows = Math.max(2, ...sizes.map((size) => size.rows));
        const sizeChanged = session.ptyCols !== cols || session.ptyRows !== rows;
        session.ptyCols = cols;
        session.ptyRows = rows;
        if (sizeChanged) ptyProcess.resize(cols, rows);
      }
    }
    clients.delete(ws);
    const noClientsLeft = clients.size === 0;
    if (noClientsLeft && !isAgent) {
      ptyProcess.kill();
      if (sessionKey) {
        ctx.terminalSessions.delete(sessionKey);
        if (ctx.getLastTerminalSessionId() === sessionKey) ctx.setLastTerminalSessionId(null);
      }
    }
    // Agent session survives browser close — PTY keeps running; user can rejoin via resume + catch-up.
    if (noClientsLeft && isAgent && sessionKey) {
      console.log(`[agent] Last client disconnected, session ${sessionKey} still running in background`);
    }
  });
}
