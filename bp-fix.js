/**
 * Browser PWA panel — front-end for the server-side Browser module.
 *
 * Deliberately separate from the Settings interface-browser tab: sessions are
 * driven through the first-party `/api/browser/*` REST API (the session cookie
 * carries auth and the current workspace scope), while the *live view* rides
 * the dedicated `/ws-browser` channel, which pushes frames, tab state and
 * console/network pages as they happen. Frames are data URLs and API responses
 * bypass the PWA service worker, so nothing is cached offline.
 */

import { t } from '../../i18n/index.js';
import { escapeHtml } from '../chat/chatHtmlUtils.js';
import { cretliApiFetch } from '../../lib/cretliApiRequest.js';
import { parseExplicitSdkMode } from '../../../lib/sdk/sdk-mode.js';
import { createBrowserWsClient } from './browserWsClient.js';

const API_BASE = '/api/browser';
const PULL_LIMIT = 100;
/** Client-side cap for text typed into the page per request. */
const TYPE_TEXT_MAX = 1000;
/** Dynamic console/network entries kept in the DOM per channel. */
const PULL_RENDER_MAX = 200;
/**
 * Live view frame cadence. The server caps a tab at 2 fps, so a 1 s interval
 * never trips `rate-limited` even when the user also hits Refresh.
 */
const LIVE_FRAME_INTERVAL_MS = 1000;
const LIVE_PULL_INTERVAL_MS = 2000;

/**
 * Phone and desktop viewports for the panel's mobile/desktop toggle. The
 * Browser session already defaults to a phone viewport, so the toggle lets the
 * user widen the page to a desktop layout and back. Sizes stay inside the
 * server's MIN/MAX_VIEWPORT bounds.
 */
const PHONE_VIEWPORT = Object.freeze({ width: 390, height: 844 });
const DESKTOP_VIEWPORT = Object.freeze({ width: 1280, height: 800 });
/** A drag past this many on-screen px is a scroll, below it a tap. */
const GESTURE_TAP_SLOP_PX = 10;
/** Throttle for the REST screenshot refresh after a scroll burst. */
const FRAME_REFRESH_THROTTLE_MS = 600;
/**
 * A 429 on the screenshot endpoint means the per-tab frame cap is still open,
 * not that the tab is broken. Wait out the cap and pull once more instead of
 * leaving the previous picture on screen with no explanation.
 */
const FRAME_RATE_LIMIT_RETRY_MS = 520;
/** Retry budget for one frame; a fresh frame or a new view resets it. */
const FRAME_RATE_LIMIT_RETRY_MAX = 2;
/** Matches server `INPUT_MIN_INTERVAL_MS` so scroll bursts stay under the tab input cap. */
const SCROLL_INPUT_MIN_INTERVAL_MS = 40;

const state = {
  runtime: null,
  limits: null,
  sessions: [],
  sessionId: '',
  tabs: [],
  tabId: '',
  consoleSince: 0,
  networkSince: 0,
  frame: null,
  /** Live tab viewport (size + hasTouch) captured from tab state. */
  viewport: null,
  /** Whether the panel currently shows the phone (mobile) viewport. */
  mobileViewport: true,
  busy: false,
  initDone: false,
  /** @type {{ id: number, dx: number, dy: number, raf: any } | null} */
  gesture: null,
  /** @type {any} */
  frameRefreshTimer: null,
  /** @type {any} */
  frameRetryTimer: null,
  frameRetryCount: 0,
  getActiveChatId: () => '',
  getChats: () => [],
};

/** @type {ReturnType<typeof createBrowserWsClient> | null} */
let liveView = null;

/** @type {((path: string, init: Record<string, unknown>) => Promise<Record<string, any>>) | null} */
let testApiImpl = null;

/** Client-side scroll coalescing so wheel + gesture paths respect the input rate cap. */
const scrollInputCoalesce = {
  deltaX: 0,
  deltaY: 0,
  /** @type {{ x: number, y: number } | null} */
  point: null,
  /** @type {ReturnType<typeof setTimeout> | null} */
  timer: null,
  /** `-1` means no scroll POST has been sent yet (distinct from timestamp 0). */
  lastSentAt: -1,
  sending: false,
};

/**
 * Frame interval derived from the limits the server advertises, so a workspace
 * that lowers the frame cap is not polled faster than it answers.
 * @returns {number}
 */
function liveFrameIntervalMs() {
  const minInterval = Number(state.limits?.SCREENSHOT_MIN_INTERVAL_MS);
  if (Number.isFinite(minInterval) && minInterval > 0) {
    return Math.max(LIVE_FRAME_INTERVAL_MS, minInterval * 2);
  }
  return LIVE_FRAME_INTERVAL_MS;
}

/**
 * @returns {boolean}
 */
function isBrowserPanelActive() {
  const panel = document.getElementById('browser-panel');
  return panel?.classList.contains('active') === true;
}

/**
 * Effective mode + chat id of the active chat. The server fails closed on a
 * Browser mutation without one (`mode-required`), so the REST query string and
 * the WebSocket message body are stamped from this single source.
 * @returns {{ mode: string, chatId: string }}
 */
function guardContext() {
  const chatId = String(state.getActiveChatId?.() || '').trim();
  const activeChat = state.getChats?.().find((chat) => chat?.id === chatId);
  const mode = parseExplicitSdkMode(activeChat?.sdkMode);
  return { mode, chatId };
}

/**
 * @param {string} path
 * @param {Record<string, unknown>} [init]
 * @returns {Promise<Record<string, any>>}
 */
async function api(path, init = {}) {
  if (testApiImpl) return testApiImpl(path, init);
  const method = String(init.method || 'GET').toUpperCase();
  let requestPath = path;
  if (method !== 'GET' && method !== 'HEAD') {
    const { mode, chatId } = guardContext();
    const separator = requestPath.includes('?') ? '&' : '?';
    const context = new URLSearchParams();
    if (mode) context.set('mode', mode);
    if (chatId) context.set('chatId', chatId);
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
 * Machine-readable codes the panel can receive from `/api/browser/*`: the
 * `BrowserError` set plus the route/guard rejections that are not errors of the
 * driver itself. Each one has a `browser.error.<code>` entry in both
 * dictionaries, because the raw Chromium/Playwright sentence is not something a
 * user can act on.
 */
const BROWSER_ERROR_CODES = Object.freeze(new Set([
  'auth-required',
  'browser-error',
  'browser-unavailable',
  'chat-bind-conflict',
  'confirmation-required',
  'dialog-action-invalid',
  'dialog-failed',
  'dialog-not-found',
  'dom-failed',
  'drag-target-required',
  'elements-failed',
  'elements-unavailable',
  'explicit-target-required',
  'forbidden-chat',
  'forbidden-owner',
  'forbidden-workspace',
  'input-rate-limited',
  'invalid-argument',
  'invalid-chat',
  'invalid-owner',
  'invalid-url',
  'invalid-wait-until',
  'locator-failed',
  'locator-index-invalid',
  'locator-required',
  'mode-required',
  'navigation-blocked',
  'navigation-failed',
  'no-workspace',
  'not-found',
  'page-closed',
  'plan-mode-readonly',
  'rate-limited',
  'review-mode-readonly',
  'screenshot-busy',
  'screenshot-failed',
  'screenshot-too-large',
  'select-option-invalid',
  'select-option-required',
  'session-limit',
  'tab-limit',
  'tab-not-found',
  'unknown-action',
  'unsupported-input',
  'upload-file-limit',
  'upload-files-required',
  'upload-path-forbidden',
  'upload-path-not-found',
  'wait-loadstate-invalid',
  'wait-state-invalid',
  'wait-target-required',
  'widget-auth-forbidden',
]));

/**
 * Turns an API failure into user-facing text. A known code becomes its
 * translation; anything else keeps the server message (already redacted
 * route-side), so an unmapped code never degrades into a bare code string.
 * @param {unknown} err
 * @returns {string}
 */
function errorText(err) {
  const message = String(/** @type {{ message?: unknown }} */ (err)?.message || err || 'error');
  const code = String(/** @type {{ code?: unknown }} */ (err)?.code || '');
  const text = BROWSER_ERROR_CODES.has(code) ? t(`browser.error.${code}`, { detail: message }) : message;
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
  const sessionId = state.sessionId;
  const tabId = state.tabId;
  try {
    // User-driven refresh only (the panel has no auto-poll loop). `force` is a
    // hint, not a bypass: the server still enforces the per-tab frame cap, so a
    // 429 is expected when refreshing too quickly and keeps the last frame.
    const data = await api(`/sessions/${encodeURIComponent(state.sessionId)}/tabs/${encodeURIComponent(state.tabId)}/screenshot?force=1`);
    state.frame = data.frame || null;
    renderFrame(state.frame);
    state.frameRetryCount = 0;
  } catch (err) {
    if (err?.code === 'rate-limited') {
      scheduleFrameRetry(sessionId, tabId);
      return; // keep the last frame while the retry is pending
    }
    setStatus(errorText(err), 'error');
  }
}

/**
 * Re-pulls the frame shortly after a 429 so a quick double-click on Refresh does
 * not leave the panel stuck on a stale picture. Bounded by `frameRetryCount` —
 * a tab that never becomes capturable must not turn into a polling loop — and
 * dropped when the view changes under us.
 * @param {string} sessionId
 * @param {string} tabId
 */
function scheduleFrameRetry(sessionId, tabId) {
  if (state.frameRetryTimer != null || state.frameRetryCount >= FRAME_RATE_LIMIT_RETRY_MAX) return;
  state.frameRetryCount += 1;
  state.frameRetryTimer = setTimeout(() => {
    state.frameRetryTimer = null;
    if (state.sessionId !== sessionId || state.tabId !== tabId) {
      state.frameRetryCount = 0;
      return;
    }
    void refreshFrame();
  }, FRAME_RATE_LIMIT_RETRY_MS);
}

/** Drops a pending 429 retry and its budget (a new view starts from scratch). */
function clearFrameRetry() {
  if (state.frameRetryTimer != null) {
    clearTimeout(state.frameRetryTimer);
    state.frameRetryTimer = null;
  }
  state.frameRetryCount = 0;
}

/**
 * @param {'console' | 'network'} channel
 * @returns {HTMLDivElement|null}
 */
function pullListEl(channel) {
  return document.getElementById(channel === 'network' ? 'browser-network-list' : 'browser-console-list');
}

/**
 * Key for the pull merge: a network row keeps one identity across its request
 * and response/failure revisions, while console rows are append-only.
 * @param {'console' | 'network'} channel
 * @param {Record<string, any>} entry
 * @returns {string}
 */
function pullEntryKey(channel, entry) {
  if (channel === 'network') return `r:${String(entry.requestId ?? entry.seq ?? '')}`;
  return `s:${String(entry.seq ?? '')}`;
}

/**
 * Merges a pulled page into the kept rows with a keyed upsert. The server
 * re-delivers an updated network entry under the same requestId with a higher
 * revision, so a blind append would leave a duplicate row stuck on "…"; the
 * upsert resolves the earlier pending row in place instead.
 * @param {'console' | 'network'} channel
 * @param {Array<Record<string, any>>} previous
 * @param {Array<Record<string, any>>} entries
 * @returns {Array<Record<string, any>>}
 */
function mergePullEntries(channel, previous, entries) {
  const byKey = new Map();
  for (const entry of previous) byKey.set(pullEntryKey(channel, entry), entry);
  for (const entry of entries) byKey.set(pullEntryKey(channel, entry), entry);
  return [...byKey.values()].slice(-PULL_RENDER_MAX);
}

/**
 * Advances the channel cursor and merges a pulled page into the kept rows.
 * Shared by the REST pull and the `/ws-browser` channel so both advance the
 * same `nextSince` cursor.
 * @param {'console' | 'network'} channel
 * @param {Record<string, any>} payload
 * @param {number} fallbackSince
 */
function applyPullPayload(channel, payload = {}, fallbackSince) {
  const entries = Array.isArray(payload.entries) ? payload.entries : [];
  // Both transports deliver the cursor: REST spreads it at the top level and
  // /ws-browser nests it under `payload`, so the caller normalizes that first
  // and this function always reads `nextSince` straight off the page object.
  const nextSince = Number(payload.nextSince);
  const cursor = Number.isFinite(nextSince) ? nextSince : fallbackSince;
  if (channel === 'network') state.networkSince = cursor;
  else state.consoleSince = cursor;
  const listEl = pullListEl(channel);
  if (entries.length && listEl) {
    const merged = mergePullEntries(channel, listEl._crEntries || [], entries);
    listEl._crEntries = merged;
    renderPull(channel, merged);
  }
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
    applyPullPayload(channel, data?.payload || data || {}, since);
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
    applyViewport(tabState);
  } catch {
    // state is best-effort; the tab list carries the URL too
  }
}

/**
 * Empties both dynamic lists and the cursors/merge keys that back them, so a
 * tab switch never renders the previous tab's rows.
 */
function clearPullLists() {
  state.consoleSince = 0;
  state.networkSince = 0;
  const consoleList = pullListEl('console');
  const networkList = pullListEl('network');
  if (consoleList) { consoleList.innerHTML = ''; consoleList._crEntries = []; }
  if (networkList) { networkList.innerHTML = ''; networkList._crEntries = []; }
}

async function reloadTabs() {
  if (!state.sessionId) {
    state.tabs = [];
    state.tabId = '';
    renderTabList([]);
    renderFrame(null);
    clearPullLists();
    syncLiveView();
    return;
  }
  try {
    const data = await api(`/sessions/${encodeURIComponent(state.sessionId)}/tabs`);
    state.tabs = Array.isArray(data?.tabs) ? data.tabs : [];
    if (!state.tabs.some((tab) => tab.browserTabId === state.tabId)) {
      // Follow the server's `active` marker: the array is in creation order, so
      // picking the first row could point the panel at a tab the session is not
      // showing. `tabs[0]` stays the fallback for a list with no active flag.
      const activeTab = state.tabs.find((tab) => tab.active === true);
      state.tabId = activeTab?.browserTabId || state.tabs[0]?.browserTabId || '';
    }
    renderTabList(state.tabs);
    clearPullLists();
    if (state.tabId) {
      clearFrame();
      await refreshTabState();
      await refreshFrame();
      pullBoth();
    } else {
      renderFrame(null);
      setUrlBar('');
    }
    syncLiveView();
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
    clearPullLists();
    // Same session, new tab: re-point the open channel with `subscribe` instead
    // of stacking a second socket onto the tab.
    syncLiveView();
    clearFrame();
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
  // Closing drops every tab and its console/network history server-side, and
  // there is no undo, so the button asks first. The id is quoted so a user with
  // several sessions can tell which one the panel is about to kill.
  const sessionId = state.sessionId;
  if (!window.confirm(t('browser.closeSessionConfirm', { id: sessionId.slice(0, 8) }))) return;
  state.busy = true;
  try {
    await api(`/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
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
    clearFrame();
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
    clearFrame();
    await refreshTabState();
    await refreshFrame();
    pullBoth();
  } catch (err) {
    setStatus(errorText(err), 'error');
  }
}

/**
 * @returns {{ width: number, height: number } | null}
 */
function currentPreview() {
  const img = document.getElementById('browser-frame');
  if (!img || img.hidden) return null;
  const rect = img.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  return { width: rect.width, height: rect.height };
}

/**
 * Ratio of page-viewport CSS px to on-screen preview px, so a finger drag
 * scrolls the page by the same visual distance the user dragged.
 * @returns {number}
 */
function previewToPageScale() {
  const vp = state.frame?.viewport || state.viewport || null;
  const preview = currentPreview();
  if (!vp?.height || !preview?.height) return 1;
  return vp.height / preview.height;
}

/**
 * Captures the live tab viewport (size + touch capability) so gesture handling
 * can decide between a touch tap and a mouse click.
 * @param {Record<string, any>|null|undefined} tabState
 */
function applyViewport(tabState) {
  if (tabState?.viewport) {
    state.viewport = tabState.viewport;
    // A narrow page means the phone viewport is active; keep the toggle label
    // honest even when the viewport was set elsewhere (e.g. at session start).
    state.mobileViewport = Number(tabState.viewport.width || 0) <= 600;
  }
}

/** Clears the displayed frame so a stale screenshot from the previous view does not linger while the next one loads. */
function clearFrame() {
  clearFrameRetry();
  renderFrame(null);
}

/** Throttled REST screenshot refresh used after a scroll burst (live view already repaints at 1 fps). */
function scheduleThrottledRefresh() {
  if (state.frameRefreshTimer != null) return;
  state.frameRefreshTimer = setTimeout(() => {
    state.frameRefreshTimer = null;
    void refreshFrame();
  }, FRAME_REFRESH_THROTTLE_MS);
}

function resetScrollInputCoalesce() {
  if (scrollInputCoalesce.timer != null) {
    clearTimeout(scrollInputCoalesce.timer);
    scrollInputCoalesce.timer = null;
  }
  scrollInputCoalesce.deltaX = 0;
  scrollInputCoalesce.deltaY = 0;
  scrollInputCoalesce.point = null;
  scrollInputCoalesce.lastSentAt = -1;
  scrollInputCoalesce.sending = false;
}

function scheduleScrollInputFlush() {
  if (scrollInputCoalesce.timer != null) return;
  if (scrollInputCoalesce.sending) return;
  const now = Date.now();
  const waitMs = scrollInputCoalesce.lastSentAt < 0
    ? 0
    : Math.max(0, SCROLL_INPUT_MIN_INTERVAL_MS - (now - scrollInputCoalesce.lastSentAt));
  scrollInputCoalesce.timer = setTimeout(() => {
    scrollInputCoalesce.timer = null;
    void flushCoalescedScrollInput();
  }, waitMs);
}

async function flushCoalescedScrollInput() {
  if (scrollInputCoalesce.sending) {
    scheduleScrollInputFlush();
    return;
  }
  const now = Date.now();
  if (scrollInputCoalesce.lastSentAt >= 0 && now - scrollInputCoalesce.lastSentAt < SCROLL_INPUT_MIN_INTERVAL_MS) {
    scheduleScrollInputFlush();
    return;
  }
  if (scrollInputCoalesce.deltaX === 0 && scrollInputCoalesce.deltaY === 0) return;
  if (!scrollInputCoalesce.point) return;
  const deltaX = scrollInputCoalesce.deltaX;
  const deltaY = scrollInputCoalesce.deltaY;
  const point = scrollInputCoalesce.point;
  scrollInputCoalesce.deltaX = 0;
  scrollInputCoalesce.deltaY = 0;
  scrollInputCoalesce.sending = true;
  scrollInputCoalesce.lastSentAt = Date.now();
  try {
    await sendScrollInput(deltaX, deltaY, point);
  } finally {
    scrollInputCoalesce.sending = false;
    if (scrollInputCoalesce.deltaX !== 0 || scrollInputCoalesce.deltaY !== 0) {
      scheduleScrollInputFlush();
    }
  }
}

/**
 * Queues scroll deltas for coalesced delivery (wheel + drag paths share this).
 * @param {number} deltaX
 * @param {number} deltaY
 * @param {{ x: number, y: number }} point
 */
function enqueueScrollInput(deltaX, deltaY, point) {
  scrollInputCoalesce.deltaX += deltaX;
  scrollInputCoalesce.deltaY += deltaY;
  scrollInputCoalesce.point = point;
  scheduleScrollInputFlush();
}

/**
 * Sends a scroll (wheel) input mapped from preview space. `deltaY > 0` scrolls
 * the page down, matching the server's `mouse.wheel` sign.
 * @param {number} deltaX
 * @param {number} deltaY
 * @param {{ x: number, y: number }} point
 */
async function sendScrollInput(deltaX, deltaY, point) {
  if (!state.sessionId || !state.tabId) return;
  const preview = currentPreview();
  try {
    await api(`/sessions/${encodeURIComponent(state.sessionId)}/tabs/${encodeURIComponent(state.tabId)}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: { kind: 'scroll', point, deltaX, deltaY, preview } }),
    });
    scheduleThrottledRefresh();
  } catch (err) {
    if (err?.code === 'rate-limited') return;
    setStatus(errorText(err), 'error');
  }
}

/**
 * Sends a tap/click at a preview-space point. A touch-capable session uses the
 * Playwright `touchscreen.tap` (real tap on the emulated phone); otherwise it
 * falls back to a mouse click.
 * @param {{ x: number, y: number }} point
 * @param {{ width: number, height: number } | null} preview
 */
async function sendTapOrClick(point, preview) {
  if (!state.sessionId || !state.tabId) return;
  const hasTouch = state.viewport?.hasTouch === true;
  const event = hasTouch
    ? { kind: 'pointer', action: 'tap', point, preview }
    : { kind: 'pointer', action: 'click', point, preview };
  clearFrame();
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
 * @param {PointerEvent} event
 * @returns {{ x: number, y: number } | null}
 */
function framePointFromEvent(event) {
  const img = document.getElementById('browser-frame');
  if (!img || img.hidden) return null;
  const rect = img.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

/**
 * Pointer gesture on the frame: a drag scrolls the page, a tap clicks it.
 * Pointer Events cover mouse, touch and pen with one path, so the old
 * `click`-only handler is replaced by this.
 * @param {PointerEvent} event
 */
function onFramePointerDown(event) {
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  const point = framePointFromEvent(event);
  if (!point) return;
  state.gesture = { id: event.pointerId, startX: point.x, startY: point.y, lastX: point.x, lastY: point.y, moved: false, dx: 0, dy: 0, raf: null };
  try { event.target.setPointerCapture(event.pointerId); } catch { /* capture is best-effort */ }
  event.preventDefault();
}

/**
 * @param {PointerEvent} event
 */
function onFramePointerMove(event) {
  const g = state.gesture;
  if (!g || event.pointerId !== g.id) return;
  const point = framePointFromEvent(event);
  if (!point) return;
  const dx = point.x - g.lastX;
  const dy = point.y - g.lastY;
  g.lastX = point.x;
  g.lastY = point.y;
  if (!g.moved && Math.hypot(point.x - g.startX, point.y - g.startY) > GESTURE_TAP_SLOP_PX) {
    g.moved = true;
  }
  if (g.moved) {
    g.dx += dx;
    g.dy += dy;
    if (g.raf == null) {
      g.raf = requestAnimationFrame(() => flushGestureScroll());
    }
    event.preventDefault();
  }
}

/** Flushes the accumulated drag delta as one scroll input (rAF-coalesced). */
function flushGestureScroll() {
  const g = state.gesture;
  if (!g) return;
  g.raf = null;
  if (g.dx === 0 && g.dy === 0) return;
  const dx = g.dx;
  const dy = g.dy;
  g.dx = 0;
  g.dy = 0;
  const scale = previewToPageScale();
  // Drag down (dy > 0) should scroll the page up, so negate the delta.
  void enqueueScrollInput(-dx * scale, -dy * scale, { x: g.lastX, y: g.lastY });
}

/**
 * @param {PointerEvent} event
 */
function onFramePointerUp(event) {
  const g = state.gesture;
  if (!g || event.pointerId !== g.id) return;
  state.gesture = null;
  try { event.target.releasePointerCapture?.(event.pointerId); } catch { /* best-effort */ }
  event.preventDefault();
  if (g.raf != null) {
    cancelAnimationFrame(g.raf);
    g.raf = null;
  }
  if (g.moved) {
    flushGestureScroll();
    return;
  }
  void sendTapOrClick({ x: g.startX, y: g.startY }, currentPreview());
}

/**
 * Desktop trackpad / wheel: forward the native delta as a scroll input.
 * @param {WheelEvent} event
 */
function onFrameWheel(event) {
  const point = framePointFromEvent(event);
  if (!point) return;
  event.preventDefault();
  const scale = previewToPageScale();
  void enqueueScrollInput(event.deltaX * scale, event.deltaY * scale, point);
}

/** Toggles the panel between the phone and desktop viewport via a `resize` input. */
async function toggleViewport() {
  if (!state.sessionId || !state.tabId || state.busy) return;
  const target = state.mobileViewport ? DESKTOP_VIEWPORT : PHONE_VIEWPORT;
  clearFrame();
  try {
    await api(`/sessions/${encodeURIComponent(state.sessionId)}/tabs/${encodeURIComponent(state.tabId)}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: { kind: 'resize', viewport: target } }),
    });
    state.mobileViewport = !state.mobileViewport;
    updateViewportButton();
    await refreshFrame();
  } catch (err) {
    setStatus(errorText(err), 'error');
  }
}

/** Reflects the current viewport mode on the toggle button label/icon. */
function updateViewportButton() {
  const btn = document.getElementById('browser-mobile-btn');
  if (!btn) return;
  const mobile = state.mobileViewport;
  btn.title = mobile ? t('browser.desktopTitle') : t('browser.mobileTitle');
  btn.setAttribute('aria-label', btn.title);
  btn.dataset.mode = mobile ? 'mobile' : 'desktop';
}

/**
 * Types text into the page or presses one of the panel's paging keys. The
 * server passes `key` straight to Playwright's `keyboard.press`, so a valid
 * Playwright key name needs no further allowlisting here.
 * @param {{ kind: 'type', text?: string } | { kind: 'press', key: string }} input
 */
async function sendKeyInput(input) {
  if (!state.sessionId || !state.tabId) return;
  let event = null;
  if (input.kind === 'type') {
    const text = String(input.text || '').slice(0, TYPE_TEXT_MAX);
    if (!text) return;
    event = { kind: 'key', action: 'type', text };
  } else {
    const key = String(input.key || '');
    if (!key) return;
    event = { kind: 'key', action: 'press', key };
  }
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
 * @returns {ReturnType<typeof createBrowserWsClient>}
 */
function getLiveView() {
  if (liveView) return liveView;
  liveView = createBrowserWsClient({
    isActive: isBrowserPanelActive,
    getGuardContext: guardContext,
    getPullCursors: () => ({ console: state.consoleSince, network: state.networkSince }),
    pullLimit: PULL_LIMIT,
    frameIntervalMs: liveFrameIntervalMs(),
    pullIntervalMs: LIVE_PULL_INTERVAL_MS,
    handlers: {
      // Sessions are in-memory, so a reconnect after a server restart cannot
      // trust the ids we hold: re-read the list instead of waiting for Refresh.
      onOpen: (reconnect) => {
        if (reconnect) void reloadSessions();
      },
      onReady: (route) => {
        if (route.limits) state.limits = route.limits;
        setStatus('', '');
      },
      onFrame: (frame) => {
        state.frame = frame || null;
        renderFrame(state.frame);
      },
      onState: (tabState) => {
        setUrlBar(String(tabState?.url || ''));
        applyHistoryState(tabState);
        applyViewport(tabState);
      },
      onPull: (channel, payload) => {
        const since = channel === 'network' ? state.networkSince : state.consoleSince;
        applyPullPayload(channel, payload || {}, since);
      },
      // Backpressure: nothing new was sent, so the picture on screen stays the
      // last good frame and the poll loop keeps running.
      onFrameSkipped: () => {},
      onError: (route) => {
        // Same rule as the REST refresh: a 429 keeps the last frame and the loop.
        if (route.code === 'rate-limited') return;
        setStatus(route.error || route.code || 'browser-error', 'error');
      },
      onAck: () => {},
      onReconnecting: (info) => {
        setStatus(t('browser.liveReconnecting', { seconds: String(Math.max(1, Math.round(info.delayMs / 1000))) }), '');
      },
      // 4401 / 4404: the session or the login is gone. Clear the selection and
      // reload the session list, which restarts the channel on a live session.
      onResync: () => {
        resetLiveViewSelection();
        void reloadSessions();
      },
      // 4400 / 4403: a policy reject. Stop here and show why — redialling the
      // same refusal would only spin.
      onStop: (info) => {
        setStatus(t('browser.liveStopped', { reason: info.reason || String(info.code) }), 'error');
      },
    },
  });
  return liveView;
}

/**
 * Drops everything bound to the current session/tab after the server closed the
 * channel on a session that no longer exists.
 */
function resetLiveViewSelection() {
  state.sessions = [];
  state.tabs = [];
  state.sessionId = '';
  state.tabId = '';
  state.frame = null;
  clearFrameRetry();
  renderSessionList([]);
  renderTabList([]);
  renderFrame(null);
  setUrlBar('');
  applyHistoryState(null);
  clearPullLists();
}

/**
 * Opens the channel for the selected session/tab, or closes it when there is
 * nothing to look at or the Browser panel is not the visible one.
 */
function syncLiveView() {
  if (!isBrowserPanelActive() || !state.sessionId || !state.tabId) {
    if (liveView) liveView.close();
    return;
  }
  getLiveView().open({ sessionId: state.sessionId, tabId: state.tabId });
}

/**
 * Fetches runtime status, then sessions. Safe to call repeatedly.
 */
export async function refreshBrowserPanel() {
  if (!isBrowserPanelActive() && state.initDone) return;
  try {
    const data = await api('/status');
    state.runtime = data?.runtime || null;
    state.limits = data?.limits || state.limits || null;
  } catch (err) {
    state.runtime = { available: false, reason: errorText(err) };
  }
  if (renderAvailability()) {
    if (liveView) liveView.close();
    return;
  }
  await reloadSessions();
}

/**
 * Wires static listeners exactly once (panel module init).
 */
/**
 * Injects active-chat lookups for guard stamping (tests and init).
 * @param {{ getActiveChatId?: () => string, getChats?: () => Array<{ id?: string, sdkMode?: string }> }} deps
 */
export function setBrowserPanelGuardDeps(deps = {}) {
  if (typeof deps.getActiveChatId === 'function') state.getActiveChatId = deps.getActiveChatId;
  if (typeof deps.getChats === 'function') state.getChats = deps.getChats;
}

// `errorText` and `guardContext` are exported for the panel tests only.
export { guardContext, errorText };

/** @internal Wiring tests: inject REST responses without a browser DOM. */
export function __testSetApiImpl(fn) {
  testApiImpl = typeof fn === 'function' ? fn : null;
}

/** @internal Wiring tests: reset scroll coalescing and optional tab binding. */
export function __testResetScrollInputState(sessionId = 'sess-test', tabId = 'tab-test') {
  resetScrollInputCoalesce();
  state.sessionId = sessionId;
  state.tabId = tabId;
  if (state.frameRefreshTimer != null) {
    clearTimeout(state.frameRefreshTimer);
    state.frameRefreshTimer = null;
  }
}

export { enqueueScrollInput as __testEnqueueScrollInput, SCROLL_INPUT_MIN_INTERVAL_MS };

/** @internal Wiring tests: tap/click path (must still surface input-rate-limited). */
export async function __testSendTapOrClick(point, preview) {
  return sendTapOrClick(point, preview);
}

/** @internal Wiring tests: key path (must still surface input-rate-limited). */
export async function __testSendKeyInput(input) {
  return sendKeyInput(input);
}

export function initBrowserPanel(deps = {}) {
  if (state.initDone) return;
  setBrowserPanelGuardDeps(deps);
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

  const frameEl = document.getElementById('browser-frame');
  frameEl?.addEventListener('pointerdown', (event) => onFramePointerDown(event));
  frameEl?.addEventListener('pointermove', (event) => onFramePointerMove(event));
  frameEl?.addEventListener('pointerup', (event) => onFramePointerUp(event));
  frameEl?.addEventListener('pointercancel', (event) => onFramePointerUp(event));
  frameEl?.addEventListener('wheel', (event) => onFrameWheel(event), { passive: false });
  frameEl?.addEventListener('contextmenu', (event) => {
    // A long-press on the preview would otherwise pop the browser context menu;
    // the panel sends its own gestures instead.
    event.preventDefault();
  });

  document.getElementById('browser-mobile-btn')?.addEventListener('click', () => void toggleViewport());
  updateViewportButton();

  const typeInput = document.getElementById('browser-key-input');
  document.getElementById('browser-type-btn')?.addEventListener('click', () => {
    void sendKeyInput({ kind: 'type', text: typeInput?.value || '' });
    if (typeInput) typeInput.value = '';
  });
  const pressKey = (key) => void sendKeyInput({ kind: 'press', key });
  document.getElementById('browser-enter-btn')?.addEventListener('click', () => pressKey('Enter'));
  // A touch device has no keyboard page keys, so paging lives on the bar.
  document.getElementById('browser-pageup-btn')?.addEventListener('click', () => pressKey('PageUp'));
  document.getElementById('browser-pagedown-btn')?.addEventListener('click', () => pressKey('PageDown'));

  document.getElementById('browser-console-pull-btn')?.addEventListener('click', () => void pullChannel('console'));
  document.getElementById('browser-network-pull-btn')?.addEventListener('click', () => void pullChannel('network'));

  // The server scopes the channel to the current workspace
  // (getCurrentWorkspaceFile/getCurrentCwd), so the socket is rebuilt rather
  // than re-used when the workspace changes. `refreshUiAfterWorkspaceChange`
  // follows with a panel refresh, which reopens it on the new session list.
  window.addEventListener('cretli-active-workspace-changed', () => {
    if (liveView) liveView.close();
  });

  window.addEventListener('pagehide', () => {
    if (liveView) liveView.close();
  });

  window.addEventListener('cr-lang-changed', () => {
    if (!isBrowserPanelActive()) return;
    renderAvailability();
    renderSessionList(state.sessions);
    renderTabList(state.tabs);
    updateViewportButton();
  });
}
