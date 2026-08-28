/**
 * Client instances panel — list connected SPA/PWA clients and tail their debug logs.
 */

import { t } from '../../i18n/index.js';
import { escapeHtml } from '../../features/chat/chatHtmlUtils.js';
import { getClientInstanceId } from '../../lib/clientInstance.js';

const POLL_MS = 5000;
const LOG_LIMIT = 200;

/** @type {ReturnType<typeof setInterval> | null} */
let pollTimer = null;
/** @type {string | null} */
let selectedInstanceId = null;
/** @type {Array<Record<string, unknown>>} */
let instancesCache = [];
/** @type {string[]} */
let currentLogLines = [];
/** @type {number} */
let currentLogTotalBytes = 0;
/** @type {ReturnType<typeof setTimeout> | null} */
let commandPollTimer = null;

const COMMAND_TYPES = ['ping', 'flushLogs', 'consoleReport', 'uiSnapshot'];
const COMMAND_POLL_MS = 1500;
const COMMAND_TIMEOUT_MS = 65000;

/**
 * @returns {boolean}
 */
function isInstancesPanelActive() {
  const panel = document.getElementById('instances-panel');
  return panel?.classList.contains('active') === true;
}

/**
 * @param {number} timestamp
 * @returns {string}
 */
function formatRelativeAge(timestamp) {
  const ageMs = Math.max(0, Date.now() - Number(timestamp || 0));
  if (ageMs < 5000) return t('instances.justNow');
  const sec = Math.floor(ageMs / 1000);
  if (sec < 60) return t('instances.secondsAgo', { count: String(sec) });
  const min = Math.floor(sec / 60);
  if (min < 60) return t('instances.minutesAgo', { count: String(min) });
  const hours = Math.floor(min / 60);
  return t('instances.hoursAgo', { count: String(hours) });
}

/**
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * @param {'online' | 'stale' | 'offline' | string} status
 * @returns {string}
 */
function statusLabel(status) {
  if (status === 'online') return t('instances.statusOnline');
  if (status === 'stale') return t('instances.statusStale');
  return t('instances.statusOffline');
}

/**
 * @param {'pwa' | 'browser' | 'embed' | 'unknown' | string} kind
 * @returns {string}
 */
function kindIconClass(kind) {
  if (kind === 'pwa') return 'mdi-cellphone-link';
  if (kind === 'embed') return 'mdi-application-outline';
  return 'mdi-web';
}

/**
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
async function fetchInstances() {
  const res = await fetch(`${window.location.origin || ''}/api/client-instances`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data?.ok || !Array.isArray(data.instances)) throw new Error('Invalid response');
  return data.instances;
}

/**
 * @param {string} id
 * @returns {Promise<{ lines: string[], totalBytes: number }>}
 */
async function fetchInstanceLogs(id) {
  const url = `${window.location.origin || ''}/api/client-instances/${encodeURIComponent(id)}/logs?limit=${LOG_LIMIT}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data?.ok || !Array.isArray(data.lines)) throw new Error('Invalid response');
  return { lines: data.lines, totalBytes: Number(data.totalBytes) || 0 };
}

/**
 * @param {Record<string, unknown>} instance
 * @returns {string}
 */
function buildMetaHtml(instance) {
  const parts = [];
  parts.push(`<span>${escapeHtml(t('instances.lastSeen'))}: ${escapeHtml(formatRelativeAge(Number(instance.lastSeenAt)))}</span>`);
  if (Number.isFinite(Number(instance.wsCount))) {
    parts.push(`<span>${escapeHtml(t('instances.wsCount'))}: ${escapeHtml(String(instance.wsCount))}</span>`);
  }
  if (instance.activePanel) {
    parts.push(`<span>${escapeHtml(t('instances.activePanel'))}: ${escapeHtml(String(instance.activePanel))}</span>`);
  }
  if (instance.activeChatId) {
    parts.push(`<span>${escapeHtml(t('instances.activeChat'))}: ${escapeHtml(String(instance.activeChatId).slice(0, 12))}</span>`);
  }
  if (Number.isFinite(Number(instance.heapMiB))) {
    parts.push(`<span>${escapeHtml(t('instances.heap'))}: ${escapeHtml(String(instance.heapMiB))} MiB</span>`);
  }
  const flags = [];
  if (instance.debugRemote === true) flags.push('remote');
  if (instance.debugUiFreeze === true) flags.push('ui-freeze');
  if (flags.length) {
    parts.push(`<span>${escapeHtml(t('instances.debugFlags'))}: ${escapeHtml(flags.join(', '))}</span>`);
  }
  return parts.join('');
}

/**
 * @param {Array<Record<string, unknown>>} instances
 */
function renderInstanceList(instances) {
  const listEl = document.getElementById('instances-list');
  if (!listEl) return;
  const currentId = getClientInstanceId();
  if (!instances.length) {
    listEl.innerHTML = `<div class="instances-empty">${escapeHtml(t('instances.noInstances'))}</div>`;
    return;
  }
  listEl.innerHTML = instances
    .map((instance) => {
      const id = String(instance.id || '');
      const isCurrent = id === currentId;
      const isSelected = id === selectedInstanceId;
      const status = String(instance.status || 'offline');
      const kind = String(instance.kind || 'unknown');
      const label = String(instance.label || id.slice(0, 8));
      return (
        `<button type="button" class="instances-card${isSelected ? ' is-selected' : ''}${isCurrent ? ' is-current' : ''}" data-instance-id="${escapeHtml(id)}" role="option" aria-selected="${isSelected ? 'true' : 'false'}">` +
        `<span class="instances-card-icon mdi ${kindIconClass(kind)}" aria-hidden="true"></span>` +
        `<span class="instances-card-body">` +
        `<span class="instances-card-title">${escapeHtml(label)}${isCurrent ? ` <span class="instances-this-device">${escapeHtml(t('instances.thisDevice'))}</span>` : ''}</span>` +
        `<span class="instances-card-sub">${escapeHtml(id.slice(0, 8))} · ${escapeHtml(formatRelativeAge(Number(instance.lastSeenAt)))}</span>` +
        `</span>` +
        `<span class="instances-status instances-status--${escapeHtml(status)}">${escapeHtml(statusLabel(status))}</span>` +
        `</button>`
      );
    })
    .join('');
  listEl.querySelectorAll('[data-instance-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-instance-id');
      if (!id) return;
      selectInstance(id);
    });
  });
}

/**
 * @param {string} message
 * @param {'ok' | 'error' | ''} [tone]
 */
function setCommandStatus(message, tone = '') {
  const el = document.getElementById('instances-command-status');
  if (!el) return;
  if (!message) {
    el.hidden = true;
    el.textContent = '';
    el.classList.remove('instances-command-status--ok', 'instances-command-status--error');
    return;
  }
  el.hidden = false;
  el.textContent = message;
  el.classList.remove('instances-command-status--ok', 'instances-command-status--error');
  if (tone === 'ok') el.classList.add('instances-command-status--ok');
  if (tone === 'error') el.classList.add('instances-command-status--error');
}

/**
 * @param {string} message
 * @returns {string}
 */
function normalizeCommandErrorMessage(message) {
  const text = String(message || '').trim();
  if (!text) return '';
  return text.length > 180 ? `${text.slice(0, 180)}…` : text;
}

function stopCommandPoll() {
  if (!commandPollTimer) return;
  clearTimeout(commandPollTimer);
  commandPollTimer = null;
}

/**
 * @param {string} commandId
 */
function pollCommandResult(commandId) {
  stopCommandPoll();
  const startedAt = Date.now();
  const poll = async () => {
    if (Date.now() - startedAt > COMMAND_TIMEOUT_MS) {
      setCommandStatus(t('instances.cmdTimeout'), 'error');
      return;
    }
    try {
      const res = await fetch(
        `${window.location.origin || ''}/api/client-instances/commands/${encodeURIComponent(commandId)}`,
        { credentials: 'include' }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const command = data?.command;
      if (command?.status === 'completed') {
        const elapsedMs = command.result?.elapsedMs;
        if (command.result?.ok === false) {
          const detail = normalizeCommandErrorMessage(command.result?.error);
          setCommandStatus(
            detail ? `${t('instances.cmdFailed')}: ${detail}` : t('instances.cmdFailed'),
            'error'
          );
          return;
        }
        setCommandStatus(
          t('instances.cmdCompleted', { elapsedMs: String(Number.isFinite(Number(elapsedMs)) ? elapsedMs : '—') }),
          'ok'
        );
        if (selectedInstanceId) void selectInstance(selectedInstanceId);
        return;
      }
    } catch {
      // keep polling
    }
    commandPollTimer = setTimeout(() => {
      void poll();
    }, COMMAND_POLL_MS);
  };
  void poll();
}

/**
 * @param {string} type
 */
async function sendInstanceCommand(type) {
  if (!selectedInstanceId) return;
  const currentId = getClientInstanceId();
  if (selectedInstanceId === currentId) {
    setCommandStatus(t('instances.cmdOnlyRemote'), 'error');
    return;
  }
  if (!COMMAND_TYPES.includes(type)) return;
  const commandType = type === 'consoleReport' ? 'flushLogs' : type;
  const payload = type === 'consoleReport' ? { mode: 'console' } : null;
  setCommandStatus(t('instances.cmdQueued'));
  try {
    const res = await fetch(
      `${window.location.origin || ''}/api/client-instances/${encodeURIComponent(selectedInstanceId)}/commands`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ type: commandType, payload, fromInstanceId: currentId }),
      }
    );
    const data = await res.json();
    if (!res.ok || !data?.ok || !data?.command?.id) {
      const detail = normalizeCommandErrorMessage(data?.error);
      setCommandStatus(
        detail ? `${t('instances.cmdFailed')}: ${detail}` : t('instances.cmdFailed'),
        'error'
      );
      return;
    }
    pollCommandResult(String(data.command.id));
  } catch {
    setCommandStatus(t('instances.cmdFailed'), 'error');
  }
}

/**
 * @param {Record<string, unknown> | null} instance
 */
function updateCommandActions(instance) {
  const actions = document.getElementById('instances-command-actions');
  if (!actions) return;
  const currentId = getClientInstanceId();
  const canSend =
    instance &&
    String(instance.id) !== currentId &&
    (instance.status === 'online' || instance.status === 'stale');
  actions.hidden = !canSend;
}

/**
 * @param {string} message
 */
function renderLogsPlaceholder(message) {
  const content = document.getElementById('instances-logs-content');
  if (!content) return;
  content.innerHTML = `<div class="instances-logs-empty">${escapeHtml(message)}</div>`;
}

/**
 * @param {Record<string, unknown> | null} instance
 * @param {string[]} lines
 * @param {number} totalBytes
 */
function renderInstanceDetail(instance, lines, totalBytes) {
  const titleEl = document.getElementById('instances-detail-title');
  const metaEl = document.getElementById('instances-detail-meta');
  const content = document.getElementById('instances-logs-content');
  const copyBtn = document.getElementById('instances-copy-logs-btn');
  const clearBtn = document.getElementById('instances-clear-logs-btn');
  if (!titleEl || !metaEl || !content) return;
  if (!instance) {
    titleEl.textContent = '—';
    metaEl.innerHTML = '';
    updateCommandActions(null);
    setCommandStatus('');
    renderLogsPlaceholder(t('instances.selectInstance'));
    if (copyBtn) copyBtn.disabled = true;
    if (clearBtn) clearBtn.disabled = true;
    currentLogLines = [];
    currentLogTotalBytes = 0;
    return;
  }
  const label = String(instance.label || instance.id || '—');
  titleEl.textContent = label;
  metaEl.innerHTML = buildMetaHtml(instance);
  updateCommandActions(instance);
  if (copyBtn) copyBtn.disabled = lines.length === 0;
  if (clearBtn) clearBtn.disabled = !selectedInstanceId;
  currentLogLines = lines.slice();
  currentLogTotalBytes = totalBytes;
  if (!lines.length) {
    renderLogsPlaceholder(t('instances.noLogs'));
    return;
  }
  const footer = `<div class="instances-logs-footer">${escapeHtml(t('instances.logSummary', { lines: String(lines.length), bytes: formatBytes(totalBytes) }))}</div>`;
  content.innerHTML =
    lines
      .map((line) => {
        const isFreeze = /ui-freeze|freeze/i.test(line);
        return `<div class="log-line${isFreeze ? ' log-line--freeze' : ''}">${escapeHtml(line)}</div>`;
      })
      .join('') + footer;
  content.scrollTop = content.scrollHeight;
}

/**
 * @param {string} id
 */
async function selectInstance(id) {
  selectedInstanceId = id;
  setCommandStatus('');
  renderInstanceList(instancesCache);
  const instance = instancesCache.find((row) => String(row.id) === id) || null;
  renderInstanceDetail(instance, [], 0);
  try {
    const tail = await fetchInstanceLogs(id);
    renderInstanceDetail(instance, tail.lines, tail.totalBytes);
  } catch {
    renderLogsPlaceholder(t('instances.loadLogsFailed'));
  }
}

/**
 * @param {string} [errorMessage]
 */
async function reloadInstances(errorMessage = '') {
  const listEl = document.getElementById('instances-list');
  if (listEl && !instancesCache.length) {
    listEl.innerHTML = `<div class="instances-empty">${escapeHtml(t('instances.loading'))}</div>`;
  }
  try {
    instancesCache = await fetchInstances();
    renderInstanceList(instancesCache);
    if (selectedInstanceId && instancesCache.some((row) => String(row.id) === selectedInstanceId)) {
      const instance = instancesCache.find((row) => String(row.id) === selectedInstanceId) || null;
      try {
        const tail = await fetchInstanceLogs(selectedInstanceId);
        renderInstanceDetail(instance, tail.lines, tail.totalBytes);
      } catch {
        renderInstanceDetail(instance, [], 0);
      }
      return;
    }
    const currentId = getClientInstanceId();
    if (instancesCache.some((row) => String(row.id) === currentId)) {
      await selectInstance(currentId);
      return;
    }
    if (instancesCache.length) {
      await selectInstance(String(instancesCache[0].id));
      return;
    }
    selectedInstanceId = null;
    renderInstanceDetail(null, [], 0);
  } catch {
    if (listEl) {
      listEl.innerHTML = `<div class="instances-empty instances-empty--error">${escapeHtml(errorMessage || t('instances.loadFailed'))}</div>`;
    }
    renderInstanceDetail(null, [], 0);
  }
}

function stopInstancesPanelPoll() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

function startInstancesPanelPoll() {
  stopInstancesPanelPoll();
  pollTimer = setInterval(() => {
    if (!isInstancesPanelActive()) {
      stopInstancesPanelPoll();
      return;
    }
    void reloadInstances();
  }, POLL_MS);
}

/**
 * Refreshes list + selected logs; starts polling while the panel is active.
 */
export function refreshInstancesPanel() {
  if (!isInstancesPanelActive()) return;
  void reloadInstances();
  startInstancesPanelPoll();
}

/**
 * Wires toolbar actions and language change re-render.
 */
export function initInstancesPanel() {
  const refreshBtn = document.getElementById('instances-refresh-btn');
  const copyBtn = document.getElementById('instances-copy-logs-btn');
  const clearBtn = document.getElementById('instances-clear-logs-btn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      void reloadInstances();
    });
  }
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      const text = currentLogLines.join('\n');
      if (!text || typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return;
      navigator.clipboard.writeText(text).then(() => {
        const label = copyBtn.textContent;
        copyBtn.textContent = t('instances.copyLogsCopied');
        copyBtn.disabled = true;
        setTimeout(() => {
          copyBtn.textContent = label;
          copyBtn.disabled = currentLogLines.length === 0;
        }, 2000);
      }).catch(() => {});
    });
  }
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      if (!selectedInstanceId) return;
      if (!window.confirm(t('instances.clearLogsConfirm'))) return;
      fetch(`${window.location.origin || ''}/api/client-instances/${encodeURIComponent(selectedInstanceId)}/logs`, {
        method: 'DELETE',
      })
        .then((res) => res.json())
        .then(() => selectInstance(selectedInstanceId))
        .catch(() => {});
    });
  }
  document.querySelectorAll('.instances-command-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const type = btn.getAttribute('data-command');
      if (!type) return;
      void sendInstanceCommand(type);
    });
  });
  window.addEventListener('cr-lang-changed', () => {
    if (!isInstancesPanelActive()) return;
    renderInstanceList(instancesCache);
    const instance = instancesCache.find((row) => String(row.id) === selectedInstanceId) || null;
    if (instance && currentLogLines.length) {
      renderInstanceDetail(instance, currentLogLines, currentLogTotalBytes);
    }
  });
}
