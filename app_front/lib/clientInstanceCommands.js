/**
 * Polls and executes cross-instance diagnostic commands for this client.
 */

import { getClientInstanceId } from './clientInstance.js';
import { requestClientDebugRemoteFlush, appLogger } from '../logger.js';
import { logUiBlockerSnapshot } from './pwaFreezeDiagnostics.js';
import { cretliApiFetch } from './cretliApiRequest.js';

const COMMAND_POLL_MS = 15000;

/** @type {ReturnType<typeof setInterval> | null} */
let pollTimerId = null;
let commandsInFlight = false;

/** @type {Array<Record<string, unknown>>} */
let pendingCommandResults = [];

/**
 * @returns {Array<Record<string, unknown>>}
 */
export function consumeClientInstanceCommandResults() {
  if (!pendingCommandResults.length) return [];
  const rows = pendingCommandResults.slice();
  pendingCommandResults = [];
  return rows;
}

/**
 * @param {Record<string, unknown>} command
 * @returns {Record<string, unknown>}
 */
function executeClientInstanceCommand(command) {
  const commandId = String(command.id || '');
  const type = String(command.type || '');
  const payload = command.payload && typeof command.payload === 'object' ? command.payload : null;
  const startedAt = Date.now();
  try {
    if (type === 'flushLogs' || type === 'consoleReport') {
      const modeFromPayload = typeof payload?.mode === 'string' ? payload.mode.trim() : '';
      const mode = type === 'consoleReport' ? 'console' : modeFromPayload;
      if (mode === 'console') {
        const consoleTags = new Set([
          'console-error',
          'console-warn',
          'window-error',
          'unhandled-rejection',
        ]);
        const relevant = appLogger
          .getEntries()
          .filter((entry) => consoleTags.has(String(entry?.tag || '')))
          .slice(-120);
        const lines = relevant.map((entry) => `${entry.timeStr} [${entry.tag}] ${entry.text}`);
        if (lines.length === 0) {
          lines.push(`${new Date().toISOString()} [console-report] no console errors or warnings captured`);
        }
        requestClientDebugRemoteFlush('remote-console-report', lines);
        return {
          commandId,
          type,
          ok: true,
          pong: false,
          elapsedMs: Date.now() - startedAt,
          consoleLines: relevant.length,
        };
      }
      requestClientDebugRemoteFlush('remote-command');
      return { commandId, type, ok: true, pong: false, elapsedMs: Date.now() - startedAt };
    }
    if (type === 'uiSnapshot') {
      logUiBlockerSnapshot('remote-request');
      requestClientDebugRemoteFlush('remote-ui-snapshot');
      return { commandId, type, ok: true, pong: false, elapsedMs: Date.now() - startedAt };
    }
    if (type === 'ping') {
      return { commandId, type, ok: true, pong: true, elapsedMs: Date.now() - startedAt };
    }
    return { commandId, type, ok: false, pong: false, elapsedMs: Date.now() - startedAt, error: 'Unknown command type' };
  } catch (err) {
    return {
      commandId,
      type,
      ok: false,
      pong: false,
      elapsedMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message.slice(0, 240) : 'Command failed',
    };
  }
}

/**
 * Sole command poll. Hidden tabs wait; heartbeat must not call this.
 *
 * @param {{ hidden?: boolean } | Document} [doc]
 * @returns {boolean}
 */
export function shouldPollClientInstanceCommands(doc = typeof document !== 'undefined' ? document : null) {
  if (!doc) return true;
  if (doc.hidden === true) return false;
  if (doc.visibilityState === 'hidden') return false;
  return true;
}

/**
 * Fetches pending commands and executes them locally.
 * @returns {Promise<number>}
 */
export async function pullAndExecuteClientInstanceCommands() {
  if (typeof fetch === 'undefined') return 0;
  if (!shouldPollClientInstanceCommands()) return 0;
  if (commandsInFlight) return 0;
  commandsInFlight = true;
  const clientInstanceId = getClientInstanceId();
  try {
    const url = `${window.location.origin || ''}/api/client-instances/commands?clientInstanceId=${encodeURIComponent(clientInstanceId)}`;
    const res = await cretliApiFetch(url);
    if (!res.ok) return 0;
    const data = await res.json();
    if (!data?.ok || !Array.isArray(data.commands) || data.commands.length === 0) return 0;
    let executed = 0;
    for (const command of data.commands) {
      if (!command || typeof command !== 'object') continue;
      pendingCommandResults.push(executeClientInstanceCommand(command));
      executed += 1;
    }
    return executed;
  } catch {
    return 0;
  } finally {
    commandsInFlight = false;
  }
}

/**
 * Starts polling for remote diagnostic commands.
 */
export function initClientInstanceCommands() {
  if (pollTimerId != null || typeof window === 'undefined') return;
  void pullAndExecuteClientInstanceCommands();
  pollTimerId = window.setInterval(() => {
    if (!shouldPollClientInstanceCommands()) return;
    void pullAndExecuteClientInstanceCommands();
  }, COMMAND_POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (shouldPollClientInstanceCommands()) void pullAndExecuteClientInstanceCommands();
  });
}

/**
 * Stops command polling (tests).
 */
export function stopClientInstanceCommandsForTests() {
  if (pollTimerId == null || typeof window === 'undefined') return;
  window.clearInterval(pollTimerId);
  pollTimerId = null;
  pendingCommandResults = [];
}
