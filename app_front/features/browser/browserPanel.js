/**
 * Browser PWA panel — minimal front-end for the server-side Browser module.
 *
 * Deliberately separate from the Settings interface-browser tab: this panel
 * drives sessions through the first-party `/api/browser/*` REST API only (the
 * session cookie carries auth and the current workspace scope). Frames are
 * data URLs and API responses bypass the PWA service worker, so nothing is
 * cached offline.
 */

import { t } from '../../i18n/index.js';
import { escapeHtml } from '../chat/chatHtmlUtils.js';
import { cretliApiFetch } from '../../lib/cretliApiRequest.js';
import { normalizeSdkMode } from '../../../lib/sdk/sdk-mode.js';

const API_BASE = '/api/browser';
const PULL_LIMIT = 100;
/** Client-side cap for text typed into the page per request. */
const TYPE_TEXT_MAX = 1000;
/** Dynamic console/network entries kept in the DOM per channel. */
const PULL_RENDER_MAX = 200;

const state = {
  runtime: null,
  sessions: [],
  sessionId: '',
  tabs: [],
  tabId: '',
  consoleSince: 0,
  networkSince: 0,
  frame: null,
  busy: false,
  initDone: false,
  getActiveChatId: () => '',
  getChats: () => [],
};

/**
 * @returns {boolean}
 */
function isBrowserPanelActive() {
  const panel = document.getElementById('browser-panel');
  return panel?.classList.contains('active') === true;
}

/**
 * @param {string} path
 * @param {Record<string, unknown>} [init]
 * @returns {Promise<Record<string, any>>}
 */
async function api(path, init = {}) {
  const method = String(init.method || 'GET').toUpperCase();
  let requestPath = path;
  if (method !== 'GET' && method !== 'HEAD') {
    const activeChatId = String(state.getActiveChatId?.() || '').trim();
    const activeChat = state.getChats?.().find((chat) => chat?.id === activeChatId);
    const mode = normalizeSdkMode(activeChat?.sdkMode || '');
    const separator = requestPath.includes('?') ? '&' : '?';
    const context = new URLSearchParams();
    if (mode) context.set('mode', mode);
    if (activeChatId) context.set('chatId', activeChatId);
    if (context.toString()) requestPath += `${separator}${context.toString()}`;
  }
  const res = await cretliApiFetch(`${window.location.origin || ''}${API_BASE}${requestPath}`, init);
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok || !data?.ok) {
    const message = String(data?.error || `HTTP ${res.status}`);
    const err = new Error(message);
    err.code = String(data?.code || '');
    err.status = res.status;
    throw err;
  }
  return data;
}

/**
 * @param {string} message
 * @param {'' | 'ok' | 'error'} [tone]
 */
function setStatus(message, tone = '') {
  const el = document.getElementById('browser-status');
  if (!el) return;
  el.textContent = message || '';
  el.classList.remove('browser-status--ok', 'browser-status--error');
  if (tone === 'ok') el.classList.add('browser-status--ok');
  if (tone === 'error') el.classList.add('browser-status--error');
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function errorText(err) {
  const text = String(err?.message || err || 'error');
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/**
 * Renders the Chromium-unavailable banner. Returns true when the panel cannot
 * work at all (no runtime), so callers can skip session calls.
 * @returns {boolean}
 */
function renderAvailability() {
  const banner = document.getElementById('browser-unavailable');
  const body = document.getElementById('browser-body');
  const available = state.runtime?.available === true;
  if (!banner || !body) return !available;
  if (available) {
    banner.hidden = true;
    banner.textContent = '';
    body.hidden = false;
    return false;
  }
  const reason = String(state.runtime?.reason || state.runtime?.status || 'browser-unavailable');
  banner.hidden = false;
  banner.textContent = t('browser.unavailable', { reason });
  body.hidden = true;
  return true;
}

/**
 * @param {Array<Record<string, any>>} sessions
 */
function renderSessionList(sessions) {
  const listEl = document.getElementById('browser-sessions');
  if (!listEl) return;
  if (!sessions.length) {
    listEl.innerHTML = `<div class="browser-empty">${escapeHtml(t('browser.noSessions'))}</div>`;
    return;
  }
  listEl.innerHTML = sessions
    .map((session) => {
      const id = String(session.browserSessionId || '');
      const selected = id === state.sessionId;
      const tabCount = Array.isArray(session.tabs) ? session.tabs.length : 0;
      return (
        `<button type="button" class="browser-card${selected ? ' is-selected' : ''}" data-browser-session-id="${escapeHtml(id)}" role="option" aria-selected="${selected ? 'true' : 'false'}">`
        + `<span class="browser-card-icon mdi mdi-web" aria-hidden="true"></span>`
        + `<span class="browser-card-body">`
        + `<span class="browser-card-title">${escapeHtml(id.slice(0, 8))}</span>`
        + `<span class="browser-card-sub">${escapeHtml(t('browser.tabsCount', { count: String(tabCount) }))}</span>`
        + `</span>`
        + `</button>`
      );
    })
    .join('');
  listEl.querySelectorAll('[data-browser-session-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-browser-session-id');
      if (!id || id === state.sessionId) return;
      void selectSession(id);
    });
  });
}

/**
 * @param {Array<Record<string, any>>} tabs
 */
function renderTabList(tabs) {
  const listEl = document.getElementById('browser-tabs');
  if (!listEl) return;
  if (!tabs.length) {
    listEl.innerHTML = `<div class="browser-empty">${escapeHtml(t('browser.noTabs'))}</div>`;
    return;
  }
  listEl.innerHTML = tabs
    .map((tab) => {
      const id = String(tab.browserTabId || '');
      const selected = id === state.tabId;
      const title = String(tab.title || tab.url || id.slice(0, 8));
      return (
        `<span class="browser-tab-row${selected ? ' is-selected' : ''}">`
        + `<button type="button" class="browser-card browser-tab-card" data-browser-tab-id="${escapeHtml(id)}" role="option" aria-selected="${selected ? 'true' : 'false'}">`
        + `<span class="browser-card-icon mdi mdi-tab" aria-hidden="true"></span>`
        + `<span class="browser-card-body">`
        + `<span class="browser-card-title">${escapeHtml(title.slice(0, 60))}</span>`
        + `</span>`
        + `</button>`
        + `<cr-icon-button class="browser-tab-close" data-browser-tab-close="${escapeHtml(id)}" title="${escapeHtml(t('browser.tabCloseTitle'))}">`
        + `<span class="mdi mdi-close" aria-hidden="true"></span>`
        + `</cr-icon-button>`
        + `</span>`
      );
    })
    .join('');
  listEl.querySelectorAll('[data-browser-tab-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-browser-tab-id');
      if (!id || id === state.tabId) return;
      void selectTab(id);
    });
  });
  listEl.querySelectorAll('[data-browser-tab-close]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      const id = btn.getAttribute('data-browser-tab-close');
      if (!id) return;
      void closeTab(id);
    });
  });
}

/**
 * @param {Record<string, any>|null} frame
 */
function renderFrame(frame) {
  const img = document.getElementById('browser-frame');
  const empty = document.getElementById('browser-frame-empty');
  if (!img || !empty) return;
  if (!frame?.data) {
    img.removeAttribute('src');
    img.hidden = true;
    empty.hidden = false;
    return;
  }
  img.src = `data:${String(frame.mimeType || 'image/jpeg')};base64,${frame.data}`;
  img.hidden = false;
  empty.hidden = true;
}

/**
 * @param {'console' | 'network'} channel
 * @param {Array<Record<string, any>>} entries
 */
function renderPull(channel, entries) {
  const listId = channel === 'network' ? 'browser-network-list' : 'browser-console-list';
  const listEl = document.getElementById(listId);
  if (!listEl) return;
  const items = entries.slice(-PULL_RENDER_MAX);
  listEl.innerHTML = items
    .map((entry) => {
      const text = channel === 'network'
        ? `${String(entry.method || 'GET')} ${String(entry.status || '…')} ${String(entry.url || '')}`
        : `[${String(entry.level || 'log')}] ${String(entry.text || '')}`;
      const tone = channel === 'network'
        ? (entry.blocked ? ' browser-pull-line--blocked' : (entry.ok === false ? ' browser-pull-line--warn' : ''))
        : (entry.level === 'error' ? ' browser-pull-line--error' : '');
      return `<div class="browser-pull-line${tone}">${escapeHtml(text.slice(0, 500))}</div>`;
    })
    .join('');
}

/**
 * Updates the URL bar from the current tab state (no history spam).
 * @param {string} url
 */
function setUrlBar(url) {
  const input = document.getElementById('browser-url-input');
  if (input && document.activeElement !== input) input.value = url || '';
}

async function refreshFrame() {
  if (!state.sessionId || !state.tabId) return;
  try {
    // User-driven refresh only (the panel has no auto-poll loop). `force` is a
    // hint, not a bypass: the server still enforces the per-tab frame cap, so a
    // 429 is expected when refreshing too quickly and keeps the last frame.
    const data = await api(`/sessions/${encodeURIComponent(state.sessionId)}/tabs/${encodeURIComponent(state.tabId)}/screenshot?force=1`);
    state.frame = data.frame || null;
    renderFrame(state.frame);
  } catch (err) {
    if (err?.code === 'rate-limited') return; // keep the last frame on 429
    setStatus(errorText(err), 'error');
  }
}

/**
 * @param {'console' | 'network'} channel
 * @returns {HTMLDivElement|null}
 */
function pullListEl(channel) {
  return document.getElementById(channel === 'network' ? 'browser-network-list' : 'browser-console-list');
}

async function pullChannel(channel) {
  if (!state.sessionId || !state.tabId) return;
  const since = channel === 'network' ? state.networkSince : state.consoleSince;
  try {
    const data = await api(
      `/sessions/${encodeURIComponent(state.sessionId)}/tabs/${encodeURIComponent(state.tabId)}/${channel}?limit=${PULL_LIMIT}${since ? `&since=${since}` : ''}`,
    );
    // The REST route spreads the pull payload at the top level and the WS
    // channel nests it under `payload`; accept both.
    const payload = data?.payload || data || {};
    const entries = Array.isArray(payload.entries) ? payload.entries : [];
    const nextSince = Number(payload.nextSince);
    const cursor = Number.isFinite(nextSince) ? nextSince : since;
    if (channel === 'network') state.networkSince = cursor;
    else state.consoleSince = cursor;
    const listEl = pullListEl(channel);
    if (entries.length && listEl) {
      const merged = [...(listEl._crEntries || []), ...entries].slice(-PULL_RENDER_MAX);
      listEl._crEntries = merged;
      renderPull(channel, merged);
    }
  } catch (err) {
    setStatus(errorText(err), 'error');
  }
}

function pullBoth() {
  void pullChannel('console');
  void pullChannel('network');
}

/**
 * Reflects the server's real Chromium history state in the back/forward buttons.
 * @param {Record<string, any>|null|undefined} tabState
 */
function applyHistoryState(tabState) {
  const back = document.getElementById('browser-back-btn');
  const forward = document.getElementById('browser-forward-btn');
  if (back) back.disabled = tabState?.canGoBack !== true;
  if (forward) forward.disabled = tabState?.canGoForward !== true;
}

async function refreshTabState() {
  if (!state.sessionId || !state.tabId) return;
  try {
    const data = await api(`/sessions/${encodeURIComponent(state.sessionId)}/tabs/${encodeURIComponent(state.tabId)}/state`);
    const tabState = data?.state || null;
    setUrlBar(String(tabState?.url || ''));
    applyHistoryState(tabState);
  } catch {
    // state is best-effort; the tab list carries the URL too
  }
}

async function reloadTabs() {
  if (!state.sessionId) {
    state.tabs = [];
    state.tabId = '';
    renderTabList([]);
    renderFrame(null);
    return;
  }
  try {
    const data = await api(`/sessions/${encodeURIComponent(state.sessionId)}/tabs`);
    state.tabs = Array.isArray(data?.tabs) ? data.tabs : [];
    if (!state.tabs.some((tab) => tab.browserTabId === state.tabId)) {
      state.tabId = state.tabs[0]?.browserTabId || '';
    }
    renderTabList(state.tabs);
    state.consoleSince = 0;
    state.networkSince = 0;
    const consoleList = pullListEl('console');
    const networkList = pullListEl('network');
    if (consoleList) { consoleList.innerHTML = ''; consoleList._crEntries = []; }
    if (networkList) { networkList.innerHTML = ''; networkList._crEntries = []; }
    if (state.tabId) {
      await refreshTabState();
      await refreshFrame();
      pullBoth();
    } else {
      renderFrame(null);
      setUrlBar('');
    }
  } catch (err) {
    setStatus(errorText(err), 'error');
  }
}

async function reloadSessions() {
  try {
    const data = await api('/sessions');
    state.sessions = Array.isArray(data?.sessions) ? data.sessions : [];
    if (!state.sessions.some((session) => session.browserSessionId === state.sessionId)) {
      state.sessionId = state.sessions[0]?.browserSessionId || '';
      state.tabId = '';
    }
    renderSessionList(state.sessions);
    await reloadTabs();
  } catch (err) {
    setStatus(errorText(err), 'error');
  }
}

async function selectSession(sessionId) {
  state.sessionId = sessionId;
  state.tabId = '';
  renderSessionList(state.sessions);
  await reloadTabs();
}

async function selectTab(tabId) {
  if (!state.sessionId) return;
  try {
    await api(`/sessions/${encodeURIComponent(state.sessionId)}/tabs/${encodeURIComponent(tabId)}/select`, { method: 'POST' });
    state.tabId = tabId;
    renderTabList(state.tabs);
    state.consoleSince = 0;
    state.networkSince = 0;
    await refreshTabState();
    await refreshFrame();
    pullBoth();
  } catch (err) {
    setStatus(errorText(err), 'error');
  }
}

async function createSession() {
  if (state.busy) return;
  state.busy = true;
  setStatus(t('browser.creating'));
  try {
    const data = await api('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    state.sessionId = String(data?.session?.browserSessionId || '');
    state.tabId = '';
    setStatus('', '');
    await reloadSessions();
  } catch (err) {
    setStatus(errorText(err), 'error');
  } finally {
    state.busy = false;
  }
}

async function closeSession() {
  if (!state.sessionId || state.busy) return;
  state.busy = true;
  try {
    await api(`/sessions/${encodeURIComponent(state.sessionId)}`, { method: 'DELETE' });
    state.sessionId = '';
    state.tabId = '';
    setStatus('', '');
    await reloadSessions();
  } catch (err) {
    setStatus(errorText(err), 'error');
  } finally {
    state.busy = false;
  }
}

async function createTab() {
  if (!state.sessionId) return;
  try {
    const data = await api(`/sessions/${encodeURIComponent(state.sessionId)}/tabs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    state.tabId = String(data?.tab?.browserTabId || '');
    await reloadTabs();
  } catch (err) {
    setStatus(errorText(err), 'error');
  }
}

async function closeTab(tabId) {
  if (!state.sessionId || !tabId) return;
  try {
    await api(`/sessions/${encodeURIComponent(state.sessionId)}/tabs/${encodeURIComponent(tabId)}`, { method: 'DELETE' });
    if (state.tabId === tabId) state.tabId = '';
    await reloadTabs();
  } catch (err) {
    setStatus(errorText(err), 'error');
  }
}

async function navigate(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!state.sessionId || !state.tabId || !url) return;
  setStatus(t('browser.navigating'));
  try {
    await api(`/sessions/${encodeURIComponent(state.sessionId)}/tabs/${encodeURIComponent(state.tabId)}/navigate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    setStatus('', '');
    await refreshTabState();
    await refreshFrame();
    pullBoth();
  } catch (err) {
    setStatus(errorText(err), 'error');
  }
}

/**
 * @param {'back' | 'forward' | 'reload'} action
 */
async function historyAction(action) {
  if (!state.sessionId || !state.tabId) return;
  try {
    await api(`/sessions/${encodeURIComponent(state.sessionId)}/tabs/${encodeURIComponent(state.tabId)}/${action}`, { method: 'POST' });
    await refreshTabState();
    await refreshFrame();
    pullBoth();
  } catch (err) {
    setStatus(errorText(err), 'error');
  }
}

/**
 * Sends a pointer click mapped from preview (screenshot) space to the page
 * viewport — the server performs the same mapping for non-scaled payloads.
 * @param {MouseEvent} event
 */
async function sendPointerClick(event) {
  const img = document.getElementById('browser-frame');
  if (!img || img.hidden || !state.sessionId || !state.tabId) return;
  const rect = img.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
  const preview = { width: rect.width, height: rect.height };
  try {
    await api(`/sessions/${encodeURIComponent(state.sessionId)}/tabs/${encodeURIComponent(state.tabId)}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: { kind: 'pointer', action: 'click', point, preview } }),
    });
    await refreshFrame();
  } catch (err) {
    setStatus(errorText(err), 'error');
  }
}

/**
 * @param {{ kind: 'type' | 'enter', text?: string }} input
 */
async function sendKeyInput(input) {
  if (!state.sessionId || !state.tabId) return;
  const event = input.kind === 'type'
    ? { kind: 'key', action: 'type', text: String(input.text || '').slice(0, TYPE_TEXT_MAX) }
    : { kind: 'key', action: 'press', key: 'Enter' };
  if (event.kind === 'type' && !event.text) return;
  try {
    await api(`/sessions/${encodeURIComponent(state.sessionId)}/tabs/${encodeURIComponent(state.tabId)}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event }),
    });
    await refreshFrame();
  } catch (err) {
    setStatus(errorText(err), 'error');
  }
}

/**
 * Fetches runtime status, then sessions. Safe to call repeatedly.
 */
export async function refreshBrowserPanel() {
  if (!isBrowserPanelActive() && state.initDone) return;
  try {
    const data = await api('/status');
    state.runtime = data?.runtime || null;
  } catch (err) {
    state.runtime = { available: false, reason: errorText(err) };
  }
  if (renderAvailability()) return;
  await reloadSessions();
}

/**
 * Wires static listeners exactly once (panel module init).
 */
export function initBrowserPanel(deps = {}) {
  if (state.initDone) return;
  state.getActiveChatId = typeof deps.getActiveChatId === 'function' ? deps.getActiveChatId : state.getActiveChatId;
  state.getChats = typeof deps.getChats === 'function' ? deps.getChats : state.getChats;
  state.initDone = true;

  document.getElementById('browser-new-session-btn')?.addEventListener('click', () => void createSession());
  document.getElementById('browser-close-session-btn')?.addEventListener('click', () => void closeSession());
  document.getElementById('browser-new-tab-btn')?.addEventListener('click', () => void createTab());
  document.getElementById('browser-refresh-btn')?.addEventListener('click', () => {
    void refreshBrowserPanel();
  });

  const goBtn = document.getElementById('browser-go-btn');
  const urlInput = document.getElementById('browser-url-input');
  const submitUrl = () => void navigate(urlInput?.value || '');
  goBtn?.addEventListener('click', submitUrl);
  urlInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submitUrl();
  });

  document.getElementById('browser-back-btn')?.addEventListener('click', () => void historyAction('back'));
  document.getElementById('browser-forward-btn')?.addEventListener('click', () => void historyAction('forward'));
  document.getElementById('browser-reload-btn')?.addEventListener('click', () => void historyAction('reload'));

  document.getElementById('browser-frame')?.addEventListener('click', (event) => void sendPointerClick(event));

  const typeInput = document.getElementById('browser-key-input');
  document.getElementById('browser-type-btn')?.addEventListener('click', () => {
    void sendKeyInput({ kind: 'type', text: typeInput?.value || '' });
    if (typeInput) typeInput.value = '';
  });
  document.getElementById('browser-enter-btn')?.addEventListener('click', () => void sendKeyInput({ kind: 'enter' }));

  document.getElementById('browser-console-pull-btn')?.addEventListener('click', () => void pullChannel('console'));
  document.getElementById('browser-network-pull-btn')?.addEventListener('click', () => void pullChannel('network'));

  window.addEventListener('cr-lang-changed', () => {
    if (!isBrowserPanelActive()) return;
    renderAvailability();
    renderSessionList(state.sessions);
    renderTabList(state.tabs);
  });
}
