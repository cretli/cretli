/**
 * Connection status dialog opened from the header status dot.
 * Shows live WebSocket state, server reachability, and optional server logs.
 */

import * as api from './core/api/index.js';
import { restartServer } from './app/serverRestartCoordinator.js';
import { getConnectionSnapshot, setStatusIndicatorClickHandler } from './connectionStatus.js';
import { stripAnsi } from './features/chat/chatTitleParsing.js';
import { formatServerUptime } from './lib/format-server-uptime.js';
import { t } from './i18n/index.js';
import './components/ui/cr-bar-button.js';
import './components/ui/cr-dialog.js';

let dialogEl = null;
let serverLogWs = null;
let lastServerReachable = false;
let lastCanRestartServer = true;

function getServerLogWsUrl() {
  const protocol = typeof location !== 'undefined' && location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = typeof location !== 'undefined' ? location.host : '';
  return `${protocol}//${host}/ws-server-logs`;
}

function statusLabel(status) {
  const labels = {
    connected: t('connection.connected'),
    disconnected: t('connection.disconnected'),
    connecting: t('connection.connecting'),
    reconnecting: t('connection.reconnecting'),
  };
  return labels[status] || t('connectionStatus.unknown');
}

function statusTone(status) {
  if (status === 'connected') return 'ok';
  if (status === 'connecting' || status === 'reconnecting') return 'warn';
  return 'err';
}

function setRowValue(id, text, tone = '') {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text || t('connectionStatus.unknown');
  if (tone) el.setAttribute('data-tone', tone);
  else el.removeAttribute('data-tone');
}

function applyDialogCopy() {
  if (!dialogEl) return;
  dialogEl.heading = t('connectionStatus.title');
}

function renderConnectionRows() {
  const snapshot = getConnectionSnapshot();
  setRowValue('connection-status-terminal', statusLabel(snapshot.terminalStatus), statusTone(snapshot.terminalStatus));
  setRowValue('connection-status-chat', statusLabel(snapshot.chatStatus), statusTone(snapshot.chatStatus));
}

function renderOriginRow() {
  const origin = typeof location !== 'undefined' ? location.origin : '';
  setRowValue('connection-status-origin', origin);
}

function renderLanRow(lanUrl) {
  const row = document.getElementById('connection-status-lan-row');
  const hasLan = typeof lanUrl === 'string' && lanUrl.trim() !== '';
  if (row) row.hidden = !hasLan;
  if (!hasLan) return;
  setRowValue('connection-status-lan', lanUrl.trim());
}

function renderHealthRows(health) {
  if (!health || health.ok !== true) {
    setRowValue('connection-status-health', t('connectionStatus.serverDown'), 'err');
    setRowValue('connection-status-uptime', t('connectionStatus.unknown'));
    return false;
  }
  setRowValue('connection-status-health', t('connectionStatus.serverOk'), 'ok');
  const uptime = formatServerUptime(Number(health.startedAt));
  setRowValue('connection-status-uptime', uptime || t('connectionStatus.unknown'));
  return true;
}

function renderDisconnectHint(isServerReachable = lastServerReachable) {
  lastServerReachable = !!isServerReachable;
  const hintEl = document.getElementById('connection-status-hint');
  if (!hintEl) return;
  hintEl.hidden = lastServerReachable;
  hintEl.textContent = lastServerReachable ? '' : t('connectionStatus.disconnectedHint');
}

function renderRestartAvailability(canRestart = lastCanRestartServer) {
  lastCanRestartServer = canRestart !== false;
  const restartBtn = document.getElementById('connection-status-restart');
  if (restartBtn) restartBtn.hidden = !lastCanRestartServer;
  const hintEl = document.getElementById('connection-status-restart-hint');
  if (!hintEl) return;
  hintEl.hidden = lastCanRestartServer;
  hintEl.textContent = lastCanRestartServer ? '' : t('serverRestart.disabledHint');
}

function refreshLiveRows() {
  if (!dialogEl || !dialogEl.open) return;
  applyDialogCopy();
  renderConnectionRows();
}

function refreshPanelData() {
  applyDialogCopy();
  renderConnectionRows();
  renderOriginRow();
  setRowValue('connection-status-health', t('connectionStatus.checking'), 'warn');
  setRowValue('connection-status-uptime', t('connectionStatus.unknown'));
  Promise.allSettled([api.getServerHealth(), api.getSettings()]).then(([healthResult, settingsResult]) => {
    const health = healthResult.status === 'fulfilled' ? healthResult.value : null;
    const settings = settingsResult.status === 'fulfilled' ? settingsResult.value : null;
    const isReachable = renderHealthRows(health);
    renderLanRow(settings?.lanUrl);
    renderDisconnectHint(isReachable);
    renderRestartAvailability(settings?.canRestartServer !== false);
  });
}

function appendLogText(pre, text, replace) {
  const clean = stripAnsi(text);
  if (!clean) return;
  if (replace) pre.textContent = clean;
  else pre.textContent += clean;
  pre.scrollTop = pre.scrollHeight;
}

function connectServerLogWs() {
  if (serverLogWs && serverLogWs.readyState === WebSocket.OPEN) serverLogWs.close();
  serverLogWs = null;
  const pre = document.getElementById('connection-status-log-output');
  if (!pre) return;
  const ws = new WebSocket(getServerLogWsUrl());
  serverLogWs = ws;
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type !== 'output' || !msg.data) return;
      appendLogText(pre, msg.data, !!msg.catchUp);
    } catch (_) {}
  };
  ws.onclose = () => {
    if (serverLogWs === ws) serverLogWs = null;
  };
}

function disconnectServerLogWs() {
  if (!serverLogWs) return;
  serverLogWs.close();
  serverLogWs = null;
}

function onDialogClose() {
  disconnectServerLogWs();
}

function onRestartClick() {
  if (!lastCanRestartServer) return;
  if (dialogEl) dialogEl.hide();
  void restartServer({ source: 'connection-status' });
}

/**
 * Opens the connection status dialog and refreshes live data.
 */
export function openConnectionStatusDialog() {
  if (!dialogEl || typeof dialogEl.show !== 'function') return;
  dialogEl.show();
  refreshPanelData();
  connectServerLogWs();
}

/**
 * Wires the header status dot to the connection dialog.
 */
export function initConnectionStatusPanel() {
  dialogEl = document.getElementById('connection-status-dialog');
  if (!dialogEl) return;
  applyDialogCopy();
  setStatusIndicatorClickHandler(openConnectionStatusDialog);
  dialogEl.addEventListener('cr-dialog-close', onDialogClose);
  const closeBtn = document.getElementById('connection-status-close');
  if (closeBtn) closeBtn.addEventListener('click', () => dialogEl.hide());
  const restartBtn = document.getElementById('connection-status-restart');
  if (restartBtn) restartBtn.addEventListener('click', onRestartClick);
  if (typeof window === 'undefined') return;
  window.addEventListener('cretli-connection-status', refreshLiveRows);
  window.addEventListener('cr-lang-changed', () => {
    applyDialogCopy();
    if (dialogEl.open) refreshPanelData();
  });
}
