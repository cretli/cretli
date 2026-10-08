/**
 * Workspace Watcher — Todo tab top bar + "Why?" decision log.
 *
 * The watcher is the cheap deterministic guard that decides whether a workspace
 * is idle with work. The operator needs three things at a glance without
 * leaving the todo list: the current mode, what the guard is doing right now
 * (waiting / working on a todo / idle / blocked), and the one-click pause.
 * The "Why?" log turns the autopilot from a black box into an audit trail.
 *
 * The panel is a single fetch of `GET /api/workspace-watcher`; live changes
 * arrive through the existing chat-list updates channel, so no extra socket.
 * Pure rendering lives in `watcherStatus.js`.
 */

import { t, getCurrentLang } from '../../i18n/index.js';
import { cretliApiFetch } from '../../lib/cretliApiRequest.js';
import { getWorkspaceWatcherView, isWorkspaceWatcherRead } from './watcherGetCoalesce.js';
import {
  getWatcherWorkspaceFolder,
  normalizeWatcherWorkspaceFolder,
  scopeWatcherRequestToWorkspace,
} from './watcherWorkspaceScope.js';
import {
  WATCHER_MODES,
  renderWatcherBarHtml,
  renderWatcherDecisionsHtml,
  renderWatcherDoingRecoveryHtml,
  escapeWatcherHtml,
} from './watcherStatus.js';
import './watcher-panel.scss';

/** @type {object | null} */
let currentView = null;
let currentViewFolder = '';
let refreshGeneration = 0;
let bound = false;
/** @type {() => string} */
let getTodoTitleFn = () => '';
/** @type {(chatId: string) => void} */
let openChatFn = () => {};
let whyOpen = false;

/**
 * @param {string} path
 * @param {{ method?: string, body?: unknown }} [options]
 * @returns {Promise<{ status: number, json: object | null }>}
 */
async function watcherApi(path, options = {}) {
  // The bar belongs to one workspace. Scope every call like the settings panel
  // so it neither reads nor writes another workspace's watcher row.
  const scoped = scopeWatcherRequestToWorkspace(path, options, getWatcherWorkspaceFolder());
  if (isWorkspaceWatcherRead(scoped.path, scoped.options)) return getWorkspaceWatcherView(scoped.path);
  const headers = { Accept: 'application/json', 'Accept-Language': getCurrentLang() };
  if (scoped.options.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await cretliApiFetch(scoped.path, {
    method: scoped.options.method || 'GET',
    headers,
    credentials: 'include',
    body: scoped.options.body !== undefined ? JSON.stringify(scoped.options.body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

/**
 * The last view fetched. Used by the todo list to decide whether a ready row is
 * "queued" for the watcher and by tests.
 *
 * @returns {object | null}
 */
export function getWatcherView() {
  return currentViewFolder === normalizeWatcherWorkspaceFolder(getWatcherWorkspaceFolder()) ? currentView : null;
}

/**
 * True only when the watcher will actually claim ready work. Used by the todo
 * list to show a "queued" badge; `observe` never starts anything.
 *
 * @returns {boolean}
 */
export function isWatcherAutopilot() {
  return String(getWatcherView()?.watcher?.mode || 'off') === 'autopilot';
}

/**
 * @param {object} view
 */
function paintWhy(view) {
  const why = document.getElementById('todo-watcher-why');
  if (!why) return;
  why.hidden = !whyOpen;
  if (!whyOpen) return;
  const decisions = Array.isArray(view?.watcher?.decisions)
    ? view.watcher.decisions.slice(-40).reverse()
    : [];
  const recoveryHtml = renderWatcherDoingRecoveryHtml(view, { getTodoTitle: getTodoTitleFn });
  const decisionsHtml = renderWatcherDecisionsHtml(decisions);
  why.innerHTML = `${recoveryHtml}${decisionsHtml}`;
}

/**
 * @param {object} view
 */
function paint(view) {
  const bar = document.getElementById('todo-watcher-bar');
  if (bar) {
    bar.hidden = false;
    bar.innerHTML = renderWatcherBarHtml(view, { getTodoTitle: getTodoTitleFn, whyOpen });
  }
  paintWhy(view);
}

/**
 * @returns {Promise<object | null>}
 */
export async function refreshWatcherPanel() {
  const bar = document.getElementById('todo-watcher-bar');
  if (!bar) return null;
  const generation = ++refreshGeneration;
  const folder = normalizeWatcherWorkspaceFolder(getWatcherWorkspaceFolder());
  const isCurrent = () => generation === refreshGeneration
    && folder === normalizeWatcherWorkspaceFolder(getWatcherWorkspaceFolder());
  if (currentViewFolder !== folder) {
    currentView = null;
    currentViewFolder = folder;
    whyOpen = false;
    bar.hidden = true;
    bar.innerHTML = '';
    const why = document.getElementById('todo-watcher-why');
    if (why) {
      why.hidden = true;
      why.innerHTML = '';
    }
  }
  try {
    const res = await watcherApi('/api/workspace-watcher');
    if (!isCurrent()) return null;
    if (res.json?.cwd && folder && normalizeWatcherWorkspaceFolder(res.json.cwd) !== folder) return null;
    if (!res.json?.ok) {
      bar.hidden = false;
      bar.innerHTML = `<span class="todo-watcher-error">${escapeWatcherHtml(res.json?.error || t('todo.watcherLoadError'))}</span>`;
      return null;
    }
    currentView = res.json;
    paint(res.json);
    window.dispatchEvent(new CustomEvent('cretli:workspace-watcher-view-updated'));
    return res.json;
  } catch {
    if (!isCurrent()) return null;
    bar.hidden = false;
    bar.innerHTML = `<span class="todo-watcher-error">${escapeWatcherHtml(t('todo.watcherLoadError'))}</span>`;
    return null;
  }
}

/**
 * @param {'pause'|'resume'} action
 */
async function setPaused(action) {
  await watcherApi(`/api/workspace-watcher/${action === 'resume' ? 'resume' : 'pause'}`, { method: 'POST' });
  await refreshWatcherPanel();
}

/**
 * @param {string} mode
 */
async function setMode(mode) {
  const next = WATCHER_MODES.includes(mode) ? mode : 'off';
  await watcherApi('/api/workspace-watcher', { method: 'PATCH', body: { mode: next } });
  await refreshWatcherPanel();
}

/**
 * Bind the bar once. Delegation keeps the handlers valid across the
 * innerHTML re-renders the refresh performs.
 *
 * @param {{ getTodoTitle?: (id: string) => string, openChat?: (chatId: string) => void }} [options]
 */
export function initWatcherPanel(options = {}) {
  if (typeof options.getTodoTitle === 'function') getTodoTitleFn = options.getTodoTitle;
  if (typeof options.openChat === 'function') openChatFn = options.openChat;
  const bar = document.getElementById('todo-watcher-bar');
  if (!bar) return;
  if (!bound) {
    bound = true;
    bar.addEventListener('change', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLSelectElement) || !target.matches('[data-watcher-mode]')) return;
      void setMode(target.value);
    });
    bar.addEventListener('click', (event) => {
      const target = event.target instanceof Element
        ? event.target.closest('[data-watcher-action],[data-watcher-why],[data-watcher-open-chat]')
        : null;
      if (!target) return;
      const action = target.getAttribute('data-watcher-action');
      if (action === 'pause' || action === 'resume') {
        void setPaused(action);
        return;
      }
      if (target.hasAttribute('data-watcher-why')) {
        whyOpen = !whyOpen;
        if (currentView) paint(currentView);
        return;
      }
      const chatId = String(target.getAttribute('data-watcher-open-chat') || '').trim();
      if (chatId) openChatFn(chatId);
    });
    window.addEventListener('cr-lang-changed', () => {
      if (currentView) paint(currentView);
    });
    window.addEventListener('cretli:workspace-watcher-changed', () => {
      void refreshWatcherPanel();
    });
    // The bar is workspace-scoped, so a workspace switch must drop the previous
    // workspace's mode/status instead of leaving a stale (and write-dangerous)
    // bar above the new workspace's todos.
    window.addEventListener('cretli-active-workspace-changed', () => {
      void refreshWatcherPanel();
    });
  }
  void refreshWatcherPanel();
}

/**
 * Tests only.
 * @returns {void}
 */
export function __resetWatcherPanelForTest() {
  currentView = null;
  currentViewFolder = '';
  refreshGeneration += 1;
  bound = false;
  whyOpen = false;
  getTodoTitleFn = () => '';
  openChatFn = () => {};
}
