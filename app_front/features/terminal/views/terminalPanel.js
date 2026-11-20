/**
 * Terminal panel: multiple sessions (list, +, pane), xterm, the /ws WebSocket and
 * the shared send bar.
 */
import { getTerminalSession, getSettings } from '../../../core/api/index.js';
import { t } from '../../../i18n/index.js';
import { initDropdown } from '../../../lib/dropdown.js';
import { navigateSpa } from '../../../app/appShell/spaNavigationBridge.js';
import {
  terminals,
  findTerminal,
  terminalState,
  stopTerminalPoll,
} from '../state/terminalStore.js';
import {
  createTerminalPane,
  showTerminalMain,
  disposeAllTerminalPanes,
} from '../services/terminalPanes.js';
import { selectTerminal, updateTerminalSelect } from './terminalSelect.js';
import { initTerminalSendBar } from './terminalSendBar.js';

/**
 * Safe shell when a deep-linked session id is missing — no PTY spawn.
 */
export function clearTerminalSessionFromRoute() {
  disposeAllTerminalPanes();
  stopTerminalPoll();
  const banner = document.getElementById('terminal-join-banner');
  const main = document.getElementById('terminal-main');
  const joinText = document.getElementById('terminal-join-text');
  const joinBtn = document.getElementById('terminal-join-btn');
  const newBtn = document.getElementById('terminal-new-btn');
  if (main) main.style.display = 'none';
  if (banner) banner.style.display = 'flex';
  if (joinText) joinText.textContent = t('terminal.noSession');
  if (joinBtn) joinBtn.style.display = 'none';
  if (newBtn) {
    newBtn.style.display = '';
    newBtn.onclick = () => {
      showTerminalMain();
      createTerminalPane(null);
      initTerminalSendBar();
    };
  }
}

/**
 * Join a live shared terminal session from route restore (after server validation).
 *
 * @param {string} sessionId
 */
export function joinTerminalSessionFromRoute(sessionId) {
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!id) return;
  stopTerminalPoll();
  const existing = terminals.find((row) => row.sessionId === id);
  if (existing) {
    showTerminalMain();
    selectTerminal(existing.id);
    initTerminalSendBar();
    return;
  }
  showTerminalMain();
  createTerminalPane(id);
  initTerminalSendBar();
}

/**
 * Returns the active terminal, used by quick commands, special characters and fit.
 * @returns {{ term: import('@xterm/xterm').Terminal, ws: WebSocket | null, fitAddon: object, pane: HTMLElement } | null}
 */
export function getActiveTerminal() {
  const row = findTerminal(terminalState.activeId);
  if (!row) return null;
  return { term: row.term, ws: row.ws, fitAddon: row.fitAddon, pane: row.pane };
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
    terminalState.dropdownApi = initDropdown({
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
      if (terminalState.dropdownApi?.isOpen()) {
        terminalState.dropdownApi.close();
        return;
      }
      updateTerminalSelect();
      terminalState.dropdownApi?.open();
    });
    terminalBarTrigger.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      if (terminalState.dropdownApi?.isOpen()) {
        terminalState.dropdownApi.close();
        return;
      }
      updateTerminalSelect();
      terminalState.dropdownApi?.open();
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
          if (terminalState.pollInterval) {
            clearInterval(terminalState.pollInterval);
            terminalState.pollInterval = null;
          }
          if (joinBtn) {
            joinBtn.onclick = () => {
              showTerminalMain();
              createTerminalPane(data.sessionId);
              initTerminalSendBar();
              void navigateSpa(
                { panel: 'terminal', query: { session: data.sessionId } },
                { explicit: false, history: 'replace' },
              );
            };
          }
        } else {
          if (joinText) joinText.textContent = t('terminal.lookingForSession');
          if (joinBtn) joinBtn.style.display = 'none';
          if (newBtn) newBtn.style.display = '';
          banner.style.display = 'flex';
          if (newBtn) {
            newBtn.onclick = () => {
              if (terminalState.pollInterval) {
                clearInterval(terminalState.pollInterval);
                terminalState.pollInterval = null;
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
              if (terminalState.pollInterval) {
                clearInterval(terminalState.pollInterval);
                terminalState.pollInterval = null;
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
      terminalState.pollInterval = setInterval(poll, 2500);
    } else {
      // Session join runs only after route resource restore validates the id.
      showTerminalMain();
      initTerminalSendBar();
    }

    const tabTerminal = document.querySelector('.tab[data-panel="terminal"]');
    if (tabTerminal) {
      tabTerminal.addEventListener('click', () => {
        if (!sessionSyncEnabled) return;
        if (hasSessionInUrl() || terminalState.pollInterval) return;
        poll();
        terminalState.pollInterval = setInterval(poll, 2500);
      });
    }
  }).catch(() => {
    showTerminalMain();
    createTerminalPane(null);
    initTerminalSendBar();
  });

  return { getActiveTerminal };
}
