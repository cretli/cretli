/**
 * Terminal panes: creating an xterm instance per session and disposing it.
 */
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { CanvasAddon } from '@xterm/addon-canvas';
// @ts-ignore -- CSS side-effect import has no type declarations
import '@xterm/xterm/css/xterm.css';
import { TERMINAL_FONT_FAMILY } from '../../../config.js';
import { safeFit, isMobile } from './terminalViewport.js';
import { getTerminalReadOnly } from './terminalSettings.js';
import { getTerminalTheme, listenForTerminalThemeChanges } from './terminalTheme.js';
import { connectTerminal } from './terminalConnection.js';
import { terminals, terminalState } from '../state/terminalStore.js';
import { selectTerminal, updateSyncBox, updateTerminalSelect } from '../views/terminalSelect.js';

// Re-theme every open xterm on dark/light/system changes.
listenForTerminalThemeChanges(() => terminals.map((terminal) => terminal.term));

function onSessionId(terminal) {
  updateTerminalSelect();
  updateSyncBox(terminal.sessionId);
}

export function createTerminalPane(joinSessionId) {
  const id = joinSessionId || 't-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const title = joinSessionId ? 'Terminal ' + (terminals.length + 1) : 'Terminal ' + (terminals.length + 1);
  const pane = document.createElement('div');
  pane.className = 'terminal-tab-pane';
  pane.dataset.terminalId = id;

  const viewportWrap = document.createElement('div');
  viewportWrap.className = 'terminal-viewport-wrap';
  const container = document.createElement('div');
  viewportWrap.appendChild(container);
  pane.appendChild(viewportWrap);

  const term = new Terminal({
    cursorBlink: true,
    theme: getTerminalTheme(),
    fontFamily: TERMINAL_FONT_FAMILY,
    lineHeight: 1,
    letterSpacing: 0,
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(container);
  term.loadAddon(new CanvasAddon());
  safeFit(term, fitAddon, container);

  const t = {
    id,
    title,
    sessionId: joinSessionId || null,
    term,
    fitAddon,
    pane,
    ws: null,
  };
  terminals.push(t);

  const tabsEl = document.getElementById('terminal-tabs');
  if (tabsEl) tabsEl.appendChild(pane);

  connectTerminal(t, onSessionId);

  term.onData((data) => {
    if (getTerminalReadOnly()) return;
    if (t.ws && t.ws.readyState === WebSocket.OPEN) {
      t.ws.send(JSON.stringify({ type: 'input', data }));
    }
  });
  term.onResize(({ cols, rows }) => {
    if (t.ws && t.ws.readyState === WebSocket.OPEN) {
      t.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  });

  if (typeof window !== 'undefined') {
    window.addEventListener('resize', () => safeFit(term, fitAddon, container));
    if (isMobile()) {
      // No ResizeObserver on mobile: it causes flicker. Fit only on open and on
      // window resize (e.g. device rotation).
    }
  }

  updateTerminalSelect();
  selectTerminal(id);
  return t;
}

export function showTerminalMain() {
  const banner = document.getElementById('terminal-join-banner');
  const main = document.getElementById('terminal-main');
  if (banner) banner.style.display = 'none';
  if (main) main.style.display = 'flex';
}

function disposeTerminalPane(terminal) {
  if (!terminal) return;
  if (terminal._reconnectTimer != null) {
    clearTimeout(terminal._reconnectTimer);
    terminal._reconnectTimer = null;
  }
  if (terminal.ws) {
    try {
      terminal.ws.close();
    } catch (_) {}
    terminal.ws = null;
  }
  try {
    terminal.term?.dispose?.();
  } catch (_) {}
  terminal.pane?.remove?.();
}

export function disposeAllTerminalPanes() {
  for (const terminal of [...terminals]) {
    disposeTerminalPane(terminal);
  }
  terminals.length = 0;
  terminalState.activeId = null;
  updateTerminalSelect();
}
