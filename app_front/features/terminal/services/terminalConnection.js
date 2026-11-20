/**
 * Terminal WebSocket lifecycle: connect with the view-context scope and reconnect with backoff.
 */
import { TERMINAL_RECONNECT_MAX, TERMINAL_RECONNECT_DELAYS } from '../../../config.js';
import { setTerminalStatus } from '../../connection/connectionStatus.js';
import { t } from '../../../i18n/index.js';
import {
  getViewContextRuntimeScope,
  hasExplicitViewContextWorkspace,
  isViewContextScopedAccessAllowed,
} from '../../../app/appShell/viewContextBridge.js';
import { terminalState } from '../state/terminalStore.js';

/**
 * @param {any} terminal
 * @param {(terminal: any) => void} [onSessionId]
 */
function scheduleReconnect(terminal, onSessionId) {
  if (!terminal.pane || !terminal.term) return;
  if (terminal._reconnectTimer != null) return;
  terminal._reconnectAttempts = (terminal._reconnectAttempts || 0) + 1;
  terminal._connectionStatus =
    terminal._reconnectAttempts > TERMINAL_RECONNECT_MAX ? 'disconnected' : 'reconnecting';
  if (terminal.id === terminalState.activeId) setTerminalStatus(terminal._connectionStatus);
  if (terminal._reconnectAttempts > TERMINAL_RECONNECT_MAX) {
    terminal.term.writeln('\r\n\x1b[33m' + t('terminal.closed') + '\x1b[0m');
    return;
  }
  const delay = TERMINAL_RECONNECT_DELAYS[terminal._reconnectAttempts - 1] ?? 8000;
  terminal.term.writeln('\r\n\x1b[33m' + t('terminal.reconnecting', { sec: delay / 1000 }) + '\x1b[0m');
  terminal._reconnectTimer = setTimeout(() => {
    terminal._reconnectTimer = null;
    connectTerminal(terminal, onSessionId);
  }, delay);
}

/**
 * @param {any} terminal
 * @param {(terminal: any) => void} [onSessionId] - called when the server assigns a session id
 */
export function connectTerminal(terminal, onSessionId) {
  if (
    terminal.ws &&
    (terminal.ws.readyState === WebSocket.OPEN || terminal.ws.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }
  if (!isViewContextScopedAccessAllowed()) {
    terminal._connectionStatus = 'disconnected';
    if (terminal.id === terminalState.activeId) setTerminalStatus('disconnected');
    terminal.term.writeln('\r\n\x1b[33m' + t('workspace.contextPending') + '\x1b[0m');
    return;
  }
  const protocol = typeof location !== 'undefined' && location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = typeof location !== 'undefined' ? location.host : '';
  const scope = getViewContextRuntimeScope();
  const params = new URLSearchParams();
  if (terminal.sessionId) params.set('session', terminal.sessionId);
  if (scope.workspaceFolder) params.set('workspaceFolder', scope.workspaceFolder);
  if (scope.workspaceFile) params.set('workspace', scope.workspaceFile);
  if (hasExplicitViewContextWorkspace()) params.set('scoped', '1');
  const query = params.toString();
  const wsPath = query ? `/ws?${query}` : '/ws';
  const ws = new WebSocket(protocol + '//' + host + wsPath);
  terminal.ws = ws;
  terminal._connectionStatus = 'connecting';
  if (terminal.id === terminalState.activeId) setTerminalStatus('connecting');

  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'output') {
        if (msg.catchUp) terminal.term.reset();
        terminal.term.write(msg.data);
      }
      if (msg.type === 'ptySize' && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
        if (typeof window !== 'undefined' && window.innerWidth >= 768) terminal.term.resize(msg.cols, msg.rows);
      }
      if (msg.type === 'sessionId') {
        terminal.sessionId = msg.sessionId;
        onSessionId?.(terminal);
      }
    } catch (_) {}
  };

  ws.onclose = (event) => {
    if (terminal.ws !== ws) return;
    terminal.ws = null;
    if (event?.code === 4401 && typeof window !== 'undefined' && window.location.pathname !== '/login') {
      const next = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.replace(`/login?next=${next}`);
      return;
    }
    scheduleReconnect(terminal, onSessionId);
  };

  ws.onopen = () => {
    if (terminal._reconnectTimer != null) {
      clearTimeout(terminal._reconnectTimer);
      terminal._reconnectTimer = null;
    }
    terminal._reconnectAttempts = 0;
    terminal._connectionStatus = 'connected';
    if (terminal.id === terminalState.activeId) setTerminalStatus('connected');
    terminal.term.writeln('\x1b[32m' + t('terminal.connectedCwd') + '\x1b[0m\r\n');
    const { cols, rows } = terminal.term;
    ws.send(JSON.stringify({ type: 'resize', cols, rows }));
  };
}
