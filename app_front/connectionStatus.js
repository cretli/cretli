/**
 * Connection status indicator in the header: connected / disconnected / reconnecting.
 * Terminal and chat report states; the active panel (Terminal / Chat) is shown.
 * Click opens the connection status dialog.
 */

import { t } from './i18n/index.js';

const STATUS = {
  disconnected: 'disconnected',
  connecting: 'connecting',
  reconnecting: 'reconnecting',
  connected: 'connected',
};

let terminalStatus = STATUS.disconnected;
let chatStatus = STATUS.disconnected;
let activePanel = 'terminal';
/** @type {(() => void) | null} */
let statusIndicatorClickHandler = null;

const el = () => document.getElementById('connection-status-indicator');

function getDisplayStatus() {
  if (activePanel === 'chat') return chatStatus;
  return terminalStatus;
}

/**
 * Snapshot of header connection state for the status dialog.
 * @returns {{ terminalStatus: string, chatStatus: string, activePanel: string, displayStatus: string }}
 */
export function getConnectionSnapshot() {
  return {
    terminalStatus,
    chatStatus,
    activePanel,
    displayStatus: getDisplayStatus(),
  };
}

/**
 * Registers the click handler for the header status indicator.
 * @param {() => void} handler
 */
export function setStatusIndicatorClickHandler(handler) {
  statusIndicatorClickHandler = typeof handler === 'function' ? handler : null;
}

function emitConnectionStatusChanged() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('cretli-connection-status', {
    detail: getConnectionSnapshot(),
  }));
}

function render() {
  const indicator = el();
  if (!indicator) return;
  const status = getDisplayStatus();
  indicator.className = 'connection-status connection-status-' + status;
  const titles = {
    connected: t('connection.connected'),
    disconnected: t('connection.disconnected'),
    connecting: t('connection.connecting'),
    reconnecting: t('connection.reconnecting'),
  };
  const title = titles[status] || t('connection.label');
  indicator.title = title;
  indicator.setAttribute('aria-label', title || t('connection.label'));
  emitConnectionStatusChanged();
}

/**
 * Sets the terminal connection status.
 * @param {'disconnected'|'connecting'|'reconnecting'|'connected'} status
 */
export function setTerminalStatus(status) {
  terminalStatus = status;
  if (activePanel === 'terminal' || activePanel === 'settings') render();
}

/**
 * Sets the chat connection status (active chat).
 * @param {'disconnected'|'connecting'|'reconnecting'|'connected'} status
 */
export function setChatStatus(status) {
  chatStatus = status;
  if (activePanel === 'chat') render();
}

/**
 * Sets the active panel (terminal / chat / settings). Refreshes the indicator.
 * @param {string} panelId - 'terminal' | 'chat' | 'settings'
 */
export function setActivePanel(panelId) {
  activePanel = panelId;
  render();
}

/**
 * Initializes the indicator (once after DOM is ready).
 * Click opens the connection status dialog.
 */
export function initConnectionStatus() {
  render();
  const indicator = el();
  if (indicator) {
    indicator.style.cursor = 'pointer';
    indicator.addEventListener('click', () => {
      if (statusIndicatorClickHandler) statusIndicatorClickHandler();
    });
    indicator.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      if (statusIndicatorClickHandler) statusIndicatorClickHandler();
    });
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('cr-lang-changed', () => render());
  }
}
