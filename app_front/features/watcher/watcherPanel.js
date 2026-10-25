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

import { blockedActionPatch, blockedActionRequest, renderTodoBlockedHtml } from '../todo/todoBlockedView.js';
import { patchTodo } from '../../core/api/index.js';
import { sharedState } from '../../state/index.js';
import { t, getCurrentLang } from '../../i18n/index.js';
import { cretliApiFetch } from '../../lib/cretliApiRequest.js';
import { probeSync } from '../../lib/perfProbe.js';
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
import { paintWatcherAutomation } from './watcherAutomationView.js';
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
let automationBusy = false;
let automationError = '';

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
  // Blocked todos have their own tab, so the log holds recovery and decisions only.
  why.innerHTML = `<section class="todo-watcher-why-block">${recoveryHtml}</section>`
    + `<section class="todo-watcher-why-block"><p class="todo-watcher-why-heading">${escapeWatcherHtml(t('todo.watcherDecisionKind'))}</p>${decisionsHtml}</section>`;
}

/** Paint the cached blocked groups into the main Todo panel section and the Why? slot. */
function paintBlocked() {
  const section = document.getElementById('todo-blocked-section');
  if (section) {
    const hasGroups = Array.isArray(currentBlocked?.groups) && currentBlocked.groups.length > 0;
    section.hidden = !hasGroups;
    section.innerHTML = hasGroups ? renderTodoBlockedHtml(currentBlocked) : '';
  }
  window.dispatchEvent(new CustomEvent('cretli:todo-blocked-count-changed', {
    detail: { count: Number(currentBlocked?.total || 0) },
  }));
}

/** @type {any} */
let currentBlocked = null;

/** Fetch the blocked groups and repaint only their slot (no flicker of the rest). */
async function loadBlockedView() {
  const folder = currentViewFolder;
  const res = await watcherApi('/api/workspace-watcher/blocked');
  const json = /** @type {any} */ (res.json);
  if (folder !== currentViewFolder || !json?.ok) return;
  currentBlocked = json;
  paintBlocked();
}

/**
 * One-click action from the blocked view.
 *
 * @param {string} id
 * @param {string} action
 */
async function runBlockedAction(id, action) {
  const request = blockedActionRequest(action, id);
  if (request) {
    const res = await watcherApi(request.path, request.options);
    const json = /** @type {any} */ (res.json);
    if (!json?.ok) {
      const reason = String(json?.reason || json?.error || res.status);
      window.alert(t('todo.blockedRefreshFailed', { reason }));
    }
    await refreshWatcherPanel();
    return;
  }
  const patch = blockedActionPatch(action);
  if (!patch) {
    document.dispatchEvent(new CustomEvent('cretli-open-todo', { detail: { todoId: id }, bubbles: true }));
    return;
  }
  // A status change also clears the watcher's `blockedReason` on the server.
  await patchTodo(id, patch);
  await refreshWatcherPanel();
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
  // The Watcher tab label carries the live cycle count, e.g. "Watcher (2)".
  const cycles = Array.isArray(view?.watcher?.activeCycles) ? view.watcher.activeCycles.length : 0;
  /** @type {any} */ (document.getElementById('todo-tabs'))?.setCount?.('watcher', cycles, t('todo.tabWatcher'), false);
  paintWatcherAutomation(document.getElementById('todo-watcher-automation'), view, { busy: automationBusy, error: automationError });
  paintWhy(view);
  paintBlocked();
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
    currentBlocked = null;
    currentViewFolder = folder;
    whyOpen = false;
    paintBlocked();
    bar.hidden = true;
    bar.innerHTML = '';
    paintWatcherAutomation(document.getElementById('todo-watcher-automation'), null);
    const why = document.getElementById('todo-watcher-why');
    if (why) {
      why.hidden = true;
      why.innerHTML = '';
    }
  }
  try {
    const res = await watcherApi('/api/workspace-watcher');
    if (!isCurrent()) return null;
    const watcherJson = /** @type {any} */ (res.json);
    if (watcherJson?.cwd && folder && normalizeWatcherWorkspaceFolder(watcherJson.requestedFolder || watcherJson.cwd) !== folder) return null;
    if (!res.json?.ok) {
      bar.hidden = false;
      bar.innerHTML = `<span class="todo-watcher-error">${escapeWatcherHtml(res.json?.error || t('todo.watcherLoadError'))}</span>`;
      return null;
    }
    currentView = res.json;
    probeSync('shell.watcherPanel.paint', () => paint(res.json));
    // Every watcher refresh (todo changes broadcast one) also refreshes the blocked groups.
    void loadBlockedView();
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
 * Switch both automation policies off (partial policy patch; the pause flag of
 * the watcher itself is untouched).
 */
async function pauseAutomation() {
  if (automationBusy) return;
  automationBusy = true;
  automationError = '';
  if (currentView) paint(currentView);
  try {
    const res = await watcherApi('/api/workspace-watcher', {
      method: 'PATCH',
      body: { policy: { autoIntegrate: false, autoRestart: false } },
    });
    if (!/** @type {any} */ (res.json)?.ok) automationError = t('todo.watcherAutomationPauseError');
  } catch {
    automationError = t('todo.watcherAutomationPauseError');
  }
  automationBusy = false;
  await refreshWatcherPanel();
  if (automationError && currentView) paint(currentView);
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
    const onBlockedClick = (event) => {
      const button = event.target instanceof Element ? event.target.closest('[data-blocked-action]') : null;
      if (!button) return;
      void runBlockedAction(
        String(button.getAttribute('data-blocked-id') || ''),
        String(button.getAttribute('data-blocked-action') || ''),
      );
    };
    document.getElementById('todo-watcher-why')?.addEventListener('click', onBlockedClick);
    document.getElementById('todo-blocked-section')?.addEventListener('click', onBlockedClick);
    document.getElementById('todo-watcher-automation')?.addEventListener('click', (event) => {
      if (event.target instanceof Element && event.target.closest('[data-watcher-automation-pause]')) void pauseAutomation();
    });
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
    sharedState.onWatcherChanged(() => {
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
  currentBlocked = null;
  currentViewFolder = '';
  refreshGeneration += 1;
  bound = false;
  whyOpen = false;
  automationBusy = false;
  automationError = '';
  getTodoTitleFn = () => '';
  openChatFn = () => {};
}
