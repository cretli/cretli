/**
 * Terminal panel: multiple sessions (list, +, pane), xterm, the /ws WebSocket and
 * the shared send bar.
 */
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { CanvasAddon } from '@xterm/addon-canvas';
import '@xterm/xterm/css/xterm.css';
import { getLanUrl, getTerminalSession, getSettings } from './core/api/index.js';
import {
  TERMINAL_RECONNECT_MAX,
  TERMINAL_RECONNECT_DELAYS,
  TERMINAL_FONT_FAMILY,
} from './config.js';
import { safeFit, isMobile } from './terminalViewport.js';
import { setTerminalStatus } from './connectionStatus.js';
import { getTerminalReadOnly } from './terminalSettings.js';
import { createSendBar } from './sendBar.js';
import { setSpecialCharsBarVisibility } from './specialChars.js';
import { t } from './i18n/index.js';
import { initDropdown } from './lib/dropdown.js';
import { createFavoritesStore } from './lib/favorites.js';
import { sendSequenceToTerminalState } from './inputDispatch.js';
import { getTerminalTheme, listenForTerminalThemeChanges } from './terminalTheme.js';
import { escapeHtml } from './features/chat/chatHtmlUtils.js';

const terminals = [];
listenForTerminalThemeChanges(() => terminals.map((terminal) => terminal.term));
let activeTerminalId = null;
let pollInterval = null;
let terminalSendBar = null;
let terminalDropdownApi = null;
const terminalFavorites = createFavoritesStore('cretli-favorites-terminals');

function updateSyncBox(sessionId) {
  if (!sessionId) return;
  getLanUrl()
    .then((data) => {
      const base = data.ok && data.url ? data.url : (typeof location !== 'undefined' ? location.origin : '');
      const pathname = typeof location !== 'undefined' ? location.pathname : '/';
      const syncUrl = base + pathname + '?session=' + sessionId;
      const box = document.getElementById('terminal-sync-box');
      const link = document.getElementById('terminal-sync-link');
      const qr = document.getElementById('terminal-sync-qr');
      if (link) {
        link.href = syncUrl;
        link.textContent = syncUrl;
      }
      if (qr) qr.src = 'https://api.qrserver.com/v1/create-qr-code/?size=80x80&data=' + encodeURIComponent(syncUrl);
      if (box) box.style.display = 'flex';
    })
    .catch(() => {
      const origin = typeof location !== 'undefined' ? location.origin : '';
      const pathname = typeof location !== 'undefined' ? location.pathname : '/';
      const syncUrl = origin + pathname + '?session=' + sessionId;
      const box = document.getElementById('terminal-sync-box');
      const link = document.getElementById('terminal-sync-link');
      const qr = document.getElementById('terminal-sync-qr');
      if (link) {
        link.href = syncUrl;
        link.textContent = syncUrl;
      }
      if (qr) qr.src = 'https://api.qrserver.com/v1/create-qr-code/?size=80x80&data=' + encodeURIComponent(syncUrl);
      if (box) box.style.display = 'flex';
    });
}

function getTerminalFavoriteKey(terminal) {
  if (!terminal) return '';
  if (terminal.sessionId) return `session:${terminal.sessionId}`;
  return `title:${terminal.title || terminal.id || ''}`;
}

function updateTerminalSelect() {
  const triggerLabel = document.getElementById('terminal-bar-trigger-label');
  const listEl = document.getElementById('terminal-list-items');

  if (!activeTerminalId || !terminals.some((t) => t.id === activeTerminalId)) {
    const firstId = terminals[0]?.id || null;
    if (firstId && firstId !== activeTerminalId) {
      selectTerminal(firstId);
      return;
    }
  }

  const current = activeTerminalId ? terminals.find((t) => t.id === activeTerminalId) : null;
  if (triggerLabel) {
    triggerLabel.textContent = current ? current.title : '—';
  }
  if (!listEl) return;

  const orderedTerminals = terminals
    .map((terminal, idx) => ({ terminal, idx }))
    .sort((a, b) => {
      const af = terminalFavorites.isFavorite(getTerminalFavoriteKey(a.terminal)) ? 1 : 0;
      const bf = terminalFavorites.isFavorite(getTerminalFavoriteKey(b.terminal)) ? 1 : 0;
      if (af !== bf) return bf - af;
      return a.idx - b.idx;
    })
    .map((x) => x.terminal);

  listEl.innerHTML = orderedTerminals
    .map(
      (t) =>
        '<li class="chat-list-item' +
        (t.id === activeTerminalId ? ' is-active' : '') +
        '" role="option" data-terminal-id="' +
        escapeHtml(t.id) +
        '" tabindex="-1">' +
        '<span class="chat-list-item-title">' +
        escapeHtml(t.title) +
        '</span>' +
        '</li>'
    )
    .join('');

  listEl.querySelectorAll('.chat-list-item').forEach((el) => {
    const id = el.dataset.terminalId;
    const terminal = id ? terminals.find((item) => item.id === id) : null;
    const favKey = getTerminalFavoriteKey(terminal);
    if (favKey) {
      const active = terminalFavorites.isFavorite(favKey);
      const favBtn = document.createElement('button');
      favBtn.type = 'button';
      favBtn.className = 'dropdown-fav-btn';
      favBtn.title = active ? t('terminal.favoriteRemove') : t('terminal.favoriteAdd');
      favBtn.setAttribute('aria-label', favBtn.title);
      favBtn.innerHTML =
        '<span class="mdi ' +
        (active ? 'mdi-star dropdown-fav-btn--active' : 'mdi-star-outline') +
        '" aria-hidden="true"></span>';
      favBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const next = terminalFavorites.toggleFavorite(favKey);
        favBtn.title = next ? t('terminal.favoriteRemove') : t('terminal.favoriteAdd');
        favBtn.setAttribute('aria-label', favBtn.title);
        favBtn.innerHTML =
          '<span class="mdi ' +
          (next ? 'mdi-star dropdown-fav-btn--active' : 'mdi-star-outline') +
          '" aria-hidden="true"></span>';
      });
      el.appendChild(favBtn);
    }
    el.addEventListener('click', () => {
      if (!id) return;
      selectTerminal(id);
      terminalDropdownApi?.close();
    });
  });
}

function selectTerminal(id) {
  activeTerminalId = id;
  const t = terminals.find((x) => x.id === id);
  document.querySelectorAll('.terminal-tab-pane').forEach((p) => {
    p.classList.toggle('active', p.dataset.terminalId === id);
  });
  updateTerminalSelect();
  setTerminalStatus(t ? (t._connectionStatus || 'disconnected') : 'disconnected');
  if (t && t.fitAddon && t.pane) {
    const wrap = t.pane.querySelector('.terminal-viewport-wrap');
    setTimeout(() => safeFit(t.term, t.fitAddon, wrap), 50);
  }
  if (t && t.sessionId) updateSyncBox(t.sessionId);
}

function scheduleReconnect(terminal) {
  if (!terminal.pane || !terminal.term) return;
  if (terminal._reconnectTimer != null) return;
  terminal._reconnectAttempts = (terminal._reconnectAttempts || 0) + 1;
  terminal._connectionStatus =
    terminal._reconnectAttempts > TERMINAL_RECONNECT_MAX ? 'disconnected' : 'reconnecting';
  if (terminal.id === activeTerminalId) setTerminalStatus(terminal._connectionStatus);
  if (terminal._reconnectAttempts > TERMINAL_RECONNECT_MAX) {
    terminal.term.writeln('\r\n\x1b[33m' + t('terminal.closed') + '\x1b[0m');
    return;
  }
  const delay = TERMINAL_RECONNECT_DELAYS[terminal._reconnectAttempts - 1] ?? 8000;
  terminal.term.writeln('\r\n\x1b[33m' + t('terminal.reconnecting', { sec: delay / 1000 }) + '\x1b[0m');
  terminal._reconnectTimer = setTimeout(() => {
    terminal._reconnectTimer = null;
    connectTerminal(terminal);
  }, delay);
}

function connectTerminal(terminal) {
  if (
    terminal.ws &&
    (terminal.ws.readyState === WebSocket.OPEN || terminal.ws.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }
  const protocol = typeof location !== 'undefined' && location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = typeof location !== 'undefined' ? location.host : '';
  const wsPath = terminal.sessionId ? '/ws?session=' + encodeURIComponent(terminal.sessionId) : '/ws';
  const ws = new WebSocket(protocol + '//' + host + wsPath);
  terminal.ws = ws;
  terminal._connectionStatus = 'connecting';
  if (terminal.id === activeTerminalId) setTerminalStatus('connecting');

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
        updateTerminalSelect();
        updateSyncBox(terminal.sessionId);
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
    scheduleReconnect(terminal);
  };

  ws.onopen = () => {
    if (terminal._reconnectTimer != null) {
      clearTimeout(terminal._reconnectTimer);
      terminal._reconnectTimer = null;
    }
    terminal._reconnectAttempts = 0;
    terminal._connectionStatus = 'connected';
    if (terminal.id === activeTerminalId) setTerminalStatus('connected');
    terminal.term.writeln('\x1b[32m' + t('terminal.connectedCwd') + '\x1b[0m\r\n');
    const { cols, rows } = terminal.term;
    ws.send(JSON.stringify({ type: 'resize', cols, rows }));
  };
}

function createTerminalPane(joinSessionId) {
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

  connectTerminal(t);

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

function showTerminalMain() {
  const banner = document.getElementById('terminal-join-banner');
  const main = document.getElementById('terminal-main');
  if (banner) banner.style.display = 'none';
  if (main) main.style.display = 'flex';
}

function initTerminalSendBar() {
  const wrap = document.getElementById('terminal-send-bar-wrap');
  if (!wrap || wrap.children.length > 0) return;

  function sendToActive(text) {
    const t = activeTerminalId ? terminals.find((x) => x.id === activeTerminalId) : null;
    const toSend = text ? text + '\r' : '\r';
    sendSequenceToTerminalState(t, toSend);
  }

  const sendBar = createSendBar({
    placeholder: t('terminal.commandPlaceholder'),
    showToggleExtra: true,
    getExtraBarWrap: () => document.getElementById('chat-extra-bar-wrap'),
    showArrows: true,
    showStop: true,
    onSend: sendToActive,
    onArrowUp: () => sendToActive('\x1b[A'),
    onArrowDown: () => sendToActive('\x1b[B'),
    onStop: () => sendToActive('\x03'),
    setSpecialCharsBarVisibility,
  });
  terminalSendBar = sendBar;
  wrap.appendChild(sendBar.root);
}

/**
 * Returns the terminal panel send bar, used to toggle multiline mode.
 * @returns {{ setMultiline: (b: boolean) => void, isMultiline: () => boolean } | null}
 */
export function getTerminalSendBar() {
  return terminalSendBar;
}

/**
 * Returns the active terminal, used by quick commands, special characters and fit.
 * @returns {{ term: import('@xterm/xterm').Terminal, ws: WebSocket | null, fitAddon: object, pane: HTMLElement } | null}
 */
export function getActiveTerminal() {
  const t = activeTerminalId ? terminals.find((x) => x.id === activeTerminalId) : null;
  if (!t) return null;
  return { term: t.term, ws: t.ws, fitAddon: t.fitAddon, pane: t.pane };
}

/**
 * Initializes the terminal panel: sessions, the session picker bar and the shared send bar.
 * @param {string} _containerId - unused, kept for API compatibility
 * @returns {{ getActiveTerminal: () => { term: import('@xterm/xterm').Terminal, ws: WebSocket | null } | null }}
 */
export function initTerminalPanel(_containerId) {
  const banner = document.getElementById('terminal-join-banner');
  const joinText = document.getElementById('terminal-join-text');
  const joinBtn = document.getElementById('terminal-join-btn');
  const newBtn = document.getElementById('terminal-new-btn');
  const syncBox = document.getElementById('terminal-sync-box');
  const terminalBarTrigger = document.getElementById('terminal-bar-trigger');
  const terminalListModal = document.getElementById('terminal-list-modal');
  const terminalNewTabBtn = document.getElementById('terminal-new-tab-btn');

  if (terminalBarTrigger && terminalListModal) {
    terminalDropdownApi = initDropdown({
      triggerEl: terminalBarTrigger,
      floatingEl: terminalListModal,
      placement: 'bottom-start',
      matchTriggerWidth: true,
      offsetPx: 6,
      viewportPadding: 8,
      minWidthPx: 220,
      maxHeightPx: 360,
    });
    terminalBarTrigger.addEventListener('click', () => {
      if (terminalDropdownApi?.isOpen()) {
        terminalDropdownApi.close();
        return;
      }
      updateTerminalSelect();
      terminalDropdownApi?.open();
    });
    terminalBarTrigger.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      if (terminalDropdownApi?.isOpen()) {
        terminalDropdownApi.close();
        return;
      }
      updateTerminalSelect();
      terminalDropdownApi?.open();
    });
  }
  if (terminalNewTabBtn) {
    terminalNewTabBtn.addEventListener('click', () => {
      showTerminalMain();
      createTerminalPane(null);
    });
  }

  getSettings().then((data) => {
    const sessionSyncEnabled = data.sessionSyncEnabled === true;

    if (!sessionSyncEnabled) {
      if (banner) banner.style.display = 'none';
      if (syncBox) syncBox.style.display = 'none';
      showTerminalMain();
      createTerminalPane(null);
      initTerminalSendBar();
      return;
    }

    function hasSessionInUrl() {
      if (typeof location === 'undefined') return false;
      return !!new URLSearchParams(location.search).get('session');
    }

    function poll() {
      if (hasSessionInUrl()) return;
      getTerminalSession().then((data) => {
        if (!banner) return;
        if (data.ok && data.sessionId) {
          if (joinText) joinText.textContent = t('terminal.sessionAvailable');
          if (joinBtn) joinBtn.style.display = '';
          if (newBtn) newBtn.style.display = '';
          banner.style.display = 'flex';
          if (pollInterval) {
            clearInterval(pollInterval);
            pollInterval = null;
          }
          if (joinBtn) {
            joinBtn.onclick = () => {
              showTerminalMain();
              createTerminalPane(data.sessionId);
              initTerminalSendBar();
              if (typeof history !== 'undefined' && history.replaceState) {
                const pathname = typeof location !== 'undefined' ? location.pathname : '/';
                history.replaceState(null, '', pathname + '?session=' + encodeURIComponent(data.sessionId));
              }
            };
          }
        } else {
          if (joinText) joinText.textContent = t('terminal.lookingForSession');
          if (joinBtn) joinBtn.style.display = 'none';
          if (newBtn) newBtn.style.display = '';
          banner.style.display = 'flex';
          if (newBtn) {
            newBtn.onclick = () => {
              if (pollInterval) {
                clearInterval(pollInterval);
                pollInterval = null;
              }
              showTerminalMain();
              createTerminalPane(null);
              initTerminalSendBar();
            };
          }
        }
      }).catch(() => {
        if (banner && !hasSessionInUrl()) {
          if (joinText) joinText.textContent = t('terminal.noSession');
          if (joinBtn) joinBtn.style.display = 'none';
          if (newBtn) newBtn.style.display = '';
          banner.style.display = 'flex';
          if (newBtn) {
            newBtn.onclick = () => {
              if (pollInterval) {
                clearInterval(pollInterval);
                pollInterval = null;
              }
              showTerminalMain();
              createTerminalPane(null);
              initTerminalSendBar();
            };
          }
        }
      });
    }

    if (!hasSessionInUrl()) {
      if (joinText) joinText.textContent = t('terminal.lookingForSession');
      if (joinBtn) joinBtn.style.display = 'none';
      if (newBtn) newBtn.style.display = '';
      if (banner) banner.style.display = 'flex';
      poll();
      pollInterval = setInterval(poll, 2500);
    } else {
      const sessionId = new URLSearchParams(location.search).get('session');
      showTerminalMain();
      createTerminalPane(sessionId);
      initTerminalSendBar();
    }

    const tabTerminal = document.querySelector('.tab[data-panel="terminal"]');
    if (tabTerminal) {
      tabTerminal.addEventListener('click', () => {
        if (!sessionSyncEnabled) return;
        if (hasSessionInUrl() || pollInterval) return;
        poll();
        pollInterval = setInterval(poll, 2500);
      });
    }
  }).catch(() => {
    showTerminalMain();
    createTerminalPane(null);
    initTerminalSendBar();
  });

  return { getActiveTerminal };
}
