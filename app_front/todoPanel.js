import * as api from './core/api/index.js';
import { openTodoAgentChat, openTodoAgentStartModal, getChatsList, getTerminalStateMetaPublic } from './chat.js';
import { resolveTodoStatusIcon } from './features/todo/todoStatusIcon.js';
import './components/ui/cr-todo-review-badge.js';
import { startTodoForVoice } from './features/todo/todoVoiceStart.js';
import { createTodoReviewRefresher } from './features/todo/todoReviewRefresh.js';
import {
  filterTodoItemsByReviewState,
  countTodoItemsByReviewState,
  parseReviewListFilter,
  resolveAggregateReviewBadge,
  shouldShowLeafReviewBadge,
} from './features/todo/todoReviewBadge.js';
import { isTodoAwaitingIntegration } from '../lib/todo-integration-state.js';
import { subscribeSidebarChatRowStatusPatch } from './features/sidebar/sidebarChatRowRefreshBus.js';
import { getCurrentLang, t } from './i18n/index.js';
import { formatTodoRef } from '../lib/todo-ref.js';
import { writeTextToClipboard } from './lib/clipboard.js';
import { initDropdown, closeAllOpenDropdowns } from './lib/dropdown.js';
import { preloadMarkdown } from './lib/render-markdown.js';
import { getTodoWorkspaceFolder, todoWorkspaceMatches } from './features/todo/todoWorkspaceScope.js';
import {
  getViewContextState,
  isViewContextScopedAccessAllowed,
  reportViewContextResourceConflict,
} from './app/appShell/viewContextBridge.js';
import { navigateSpa } from './app/appShell/spaNavigationBridge.js';
import {
  registerViewMemoryRestoreHandler,
  schedulePanelViewMemoryCapture,
} from './app/appShell/viewMemoryBridge.js';
import {
  buildTodoMarkdown,
  canAddTodoChild,
  filterTodoItemsByRootStatus,
  filterTodoItemsBySearch,
  flattenTodoTree,
  formatTodoAssigneeBadge,
  isBatchSelectableItem,
  parseTodoIntegrationFilter,
  parseTodoRootStatusFilter,
  serializeTodoRootStatusFilter,
  TODO_INTEGRATION_FILTERS,
  TODO_INTEGRATION_PENDING_FILTERS,
  TODO_ITEM_STATUSES,
  normalizeTodoItemStatus,
  readTodoRowMark,
  readTodoRowBlockKind,
  readTodoRowMeta,
  resolveTodoChatCountKey,
  resolveTodoDrop,
  resolveTodoStartHarness as resolveTodoHarness,
  todoDropZoneFromRatio,
} from './features/todo/todoTreeView.js';
import {
  buildBatchRequestIds,
  buildBatchSelection,
  findBatchEntryForTodo,
  isActiveBatchStatus,
  isTerminalBatchStatus,
  captureBatchScope,
  createLatestRequestGate,
  createOwnedPendingGuard,
  resolveResumeAgentNeed,
  describeBatchFailure,
  isBatchScopeCurrent,
  localizeBatchReason,
  pruneBatchSelection,
  resolveBatchControls,
  resolveBatchToTrack,
  summarizeBatchEntries,
} from './features/todo/todoBatchSelection.js';
import './components/ui/cr-bar-select.js';
import './components/ui/cr-bar-input.js';
import './components/ui/cr-bar-textarea.js';
import './components/ui/cr-bar-button.js';
import './components/ui/cr-checkbox.js';
import './components/ui/cr-dialog.js';
import './components/ui/cr-todo-card.js';
import { createTodoStageStepperEl, buildTodoStageView } from './features/todo/todoStageView.js';
import './features/todo/crTodoUsage.js';
import { findTodoRecoveryState } from './features/todo/todoRecoveryView.js';
import { buildTodoReviewTaskText, resolveTodoReviewParentChatId } from './features/todo/todoReviewStart.js';
import {
  initWatcherPanel,
  refreshWatcherPanel,
  getWatcherView,
  isWatcherAutopilot,
} from './features/watcher/watcherPanel.js';

/** @type {HTMLElement|null} */
let listEl = null;
/** @type {HTMLElement|null} */
let statusEl = null;
/** @type {import('./components/ui/cr-dialog.js').CrDialog | null} */
let errorDialog = null;
/** @type {HTMLElement|null} */
let hintEl = null;
/** @type {(panelId: string) => void} */
let showPanelFn = () => {};
/** @type {boolean} */
let sdkReady = false;
/** @type {object[]} */
let latestItems = [];
let latestWorkspaceFolder = '';
let refreshGeneration = 0;
/** @type {Set<string>} */
let collapsedIds = new Set();
/** True until a workspace without a stored collapse preference got its defaults. */
let collapseDefaultsPending = false;
/** @type {string} */
let pendingParentId = '';
/** @type {HTMLElement | null} */
let editorDialog = null;
/** @type {HTMLElement | null} */
let editorCard = null;
/** @type {string} */
let editorTodoId = '';
/** Todo id whose tab selection the open dialog is remembering. */
let editorTabTodoId = '';
/** @type {{ id: string, pointerId: number, targetId: string, zone: string } | null} */
let dragState = null;
/** @type {() => void} */
let openNewTodoModal = () => {};

/** @type {Map<HTMLElement, { api: ReturnType<typeof initDropdown>, panel: HTMLElement, destroying: boolean }>} */
const rowMenus = new Map();

/** Todo ids with a start-agent request in flight (row menu and card share it). */
const startAgentInFlight = new Set();

/** Selection mode for the bulk "integrate with agent" flow. */
let batchSelectionMode = false;
/** @type {Set<string>} */
let batchSelectedIds = new Set();
/** @type {object | null} Batch view the panel currently tracks (active or just finished). */
let activeBatch = null;
/** Batch id whose final notification was already shown. */
let lastNotifiedBatchId = '';
/** Entry-state fingerprint; a poll only repaints rows when it changes. */
let batchBadgeSignature = '';
/** setTimeout chain id for the active-batch poll. */
let batchPollTimer = 0;
/** Guards a stale in-flight poll after stop/restart/workspace switch. */
let batchPollGeneration = 0;
const BATCH_POLL_MS = 4000;
/** Bumped on every workspace switch; in-flight batch responses compare against it. */
let batchWorkspaceGeneration = 0;
/** True while a start request is in flight (double-click guard). */
const batchStartGuard = createOwnedPendingGuard();
/** Only the newest list request may update the tracked batch. */
const batchListGate = createLatestRequestGate();
/** Harness / model used to start a batch, kept so a resume can reuse them. */
const batchAgentById = new Map();
/** Long-press (touch) delay before selection mode starts on a row. */
const BATCH_LONG_PRESS_MS = 500;
const BATCH_LONG_PRESS_MOVE_PX = 12;
let batchLongPressTimer = 0;
let batchLongPressPointerId = -1;
let batchLongPressStart = { x: 0, y: 0 };
/** Set when a touch long-press already toggled selection, to swallow the click. */
let suppressRowOpenAfterLongPress = false;
/** @type {HTMLElement | null} */
let batchActionBar = null;
/** @type {Record<string, HTMLElement> | null} */
let batchActionBarRefs = null;
/** @type {HTMLElement | null} */
let batchBanner = null;
/** @type {Record<string, HTMLElement> | null} */
let batchBannerRefs = null;

const COLLAPSE_PREFIX = 'cretli-todo-collapsed:';
const STATUS_FILTER_PREFIX = 'cretli-todo-status-filter:';
const REVIEW_FILTER_PREFIX = 'cretli-todo-review-filter:';
const INTEGRATION_FILTER_PREFIX = 'cretli-todo-integration-filter:';
/** Burst of `todosChanged` frames (several open chat sockets) becomes one fetch. */
const REVIEW_REFRESH_DEBOUNCE_MS = 400;

/** @type {Set<string> | null} */
let rootStatusFilter = null;
/** @type {'' | 'none' | 'stale'} */
let reviewListFilter = '';
/** @type {Set<string>} */
let integrationListFilter = new Set(TODO_INTEGRATION_PENDING_FILTERS);

/**
 * @param {Set<string>} selected
 * @returns {boolean}
 */
function isIntegrationPendingSelection(selected) {
  return selected.size === TODO_INTEGRATION_PENDING_FILTERS.length
    && TODO_INTEGRATION_PENDING_FILTERS.every((filter) => selected.has(filter));
}
/** Free-text list search (title or id); not persisted. */
let todoSearchQuery = '';
/** @type {object | null} View memory slice waiting for list data. */
let pendingTodoViewMemory = null;
/** @type {HTMLButtonElement | null} */
let statusFilterTrigger = null;
/** @type {{ api: ReturnType<typeof initDropdown>, panel: HTMLElement, list: HTMLElement } | null} */
let statusFilterMenu = null;

/**
 * Harness for starting this todo's agent. Shared precedence (assignee →
 * sourceHarness → sourceChat) lives in `resolveTodoStartHarness`; the chat
 * panel's new-harness select is only the last-resort fallback.
 *
 * @param {object | null | undefined} item
 * @returns {string}
 */
function resolveTodoStartHarness(item) {
  const sel = document.getElementById('chat-new-harness-select');
  const fallback = String(sel?.value || 'sdk').trim() || 'sdk';
  return resolveTodoHarness(item, fallback);
}

/**
 * @param {string} msg
 * @param {boolean} isErr
 * @param {object | null} [prepareDetails]
 */
function setStatus(msg, isErr, prepareDetails = null) {
  if (msg && isErr) showTodoError(msg, prepareDetails);
  // The page-level status line sits behind the editor modal, so mirror messages
  // into the modal while it is open.
  if (msg && editorTodoId) setEditorSaveState(isErr ? 'error' : 'saved', isErr ? t('todo.error') : msg);
  if (!statusEl) return;
  statusEl.textContent = msg && isErr ? t('todo.error') : msg || '';
  statusEl.classList.toggle('todo-status--error', !!isErr);
}

const EDITOR_SAVED_VISIBLE_MS = 2500;
/** @type {ReturnType<typeof setTimeout> | 0} */
let editorSaveStateTimer = 0;

/**
 * Save feedback inside the editor modal: "Saving…" while a patch is in flight,
 * then "Saved" (fades after a moment) or the error text.
 *
 * @param {'saving' | 'saved' | 'error'} kind
 * @param {string} text
 */
function setEditorSaveState(kind, text) {
  const el = editorCard?.querySelector?.('.todo-save-state');
  if (!(el instanceof HTMLElement)) return;
  if (editorSaveStateTimer) clearTimeout(editorSaveStateTimer);
  editorSaveStateTimer = 0;
  el.hidden = !text;
  el.textContent = text || '';
  el.dataset.state = kind;
  if (kind === 'saved') {
    editorSaveStateTimer = setTimeout(() => {
      el.hidden = true;
    }, EDITOR_SAVED_VISIBLE_MS);
  }
}

function getWorkspaceContext() {
  const trigger = document.getElementById('header-workspace-trigger');
  return {
    workspaceFile: trigger?.dataset?.workspaceFile || '',
    workspaceFolder: trigger?.dataset?.workspaceFolder || '',
  };
}

function collapseStorageKey() {
  const folder = getWorkspaceContext().workspaceFolder || 'default';
  return `${COLLAPSE_PREFIX}${folder}`;
}

function loadCollapsed() {
  collapsedIds = new Set();
  collapseDefaultsPending = false;
  try {
    const raw = localStorage.getItem(collapseStorageKey());
    collapseDefaultsPending = raw === null;
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return;
    parsed.forEach((id) => {
      const key = String(id || '').trim();
      if (key) collapsedIds.add(key);
    });
  } catch {
    collapsedIds = new Set();
  }
}

/**
 * First visit to a workspace: collapse finished trees so a long history does not
 * render (and scroll past) hundreds of closed rows. Explicit expand/collapse
 * choices are persisted afterwards and are never overridden.
 */
function applyCollapseDefaults(items) {
  if (!collapseDefaultsPending || !items.length) return;
  collapseDefaultsPending = false;
  const parentIds = new Set(items.map((item) => String(item.parentId || '')).filter(Boolean));
  items.forEach((item) => {
    if (item.status === 'done' && parentIds.has(String(item.id))) collapsedIds.add(String(item.id));
  });
  saveCollapsed();
}

/** A search must reach rows inside collapsed branches. */
function effectiveCollapsedIds() {
  return todoSearchQuery.trim() ? new Set() : collapsedIds;
}

function saveCollapsed() {
  try {
    localStorage.setItem(collapseStorageKey(), JSON.stringify([...collapsedIds]));
  } catch {
    // Private mode can reject storage; the tree still works for this view.
  }
}

function statusFilterStorageKey() {
  const folder = getWorkspaceContext().workspaceFolder || 'default';
  return `${STATUS_FILTER_PREFIX}${folder}`;
}

function loadStatusFilter() {
  try {
    const raw = localStorage.getItem(statusFilterStorageKey());
    const parsed = raw ? JSON.parse(raw) : [];
    rootStatusFilter = parseTodoRootStatusFilter(Array.isArray(parsed) ? parsed : []);
  } catch {
    rootStatusFilter = null;
  }
}

function reviewFilterStorageKey() {
  const folder = getWorkspaceContext().workspaceFolder || 'default';
  return `${REVIEW_FILTER_PREFIX}${folder}`;
}

function loadReviewFilter() {
  try {
    reviewListFilter = parseReviewListFilter(localStorage.getItem(reviewFilterStorageKey()));
  } catch {
    reviewListFilter = '';
  }
}

function saveReviewFilter() {
  try {
    if (reviewListFilter) localStorage.setItem(reviewFilterStorageKey(), reviewListFilter);
    else localStorage.removeItem(reviewFilterStorageKey());
  } catch {
    // Private mode can reject storage; filtering still works for this view.
  }
}

function integrationFilterStorageKey() {
  const folder = getWorkspaceContext().workspaceFolder || 'default';
  return `${INTEGRATION_FILTER_PREFIX}${folder}`;
}

function loadIntegrationFilter() {
  let stored = null;
  try {
    stored = localStorage.getItem(integrationFilterStorageKey());
  } catch {
    // Storage blocked; the pending preset still applies for this view.
  }
  integrationListFilter = parseTodoIntegrationFilter(stored);
}

function saveIntegrationFilter() {
  try {
    // "All" is saved as an empty list: removing the key would bring back the pending default.
    localStorage.setItem(integrationFilterStorageKey(), JSON.stringify([...integrationListFilter]));
  } catch {
    // Private mode can reject storage; filtering still works for this view.
  }
}

/**
 * Items shown in the list: the root status filter first, then the review filter
 * (leaves matching the review state plus their ancestors).
 *
 * @returns {object[]}
 */
function getVisibleTodoItems() {
  const byReview = filterTodoItemsByReviewState(
    filterTodoItemsByRootStatus(latestItems, rootStatusFilter),
    reviewListFilter
  );
  return filterTodoItemsBySearch(filterTodoItemsByIntegrationState(byReview, integrationListFilter), todoSearchQuery);
}

function todoScrollContainer() {
  return document.querySelector('#todo-panel .todo-scroll');
}

function buildTodoViewMemorySlice() {
  const searchWrap = document.querySelector('#todo-panel .todo-search');
  const searchInput = searchWrap?.querySelector('cr-bar-input');
  return {
    search: todoSearchQuery,
    searchOpen: searchWrap ? searchWrap.hidden === false : false,
    rootStatus: rootStatusFilter ? [...rootStatusFilter] : null,
    review: reviewListFilter || '',
    // Integration filter stays out of the per-tab slice: a snapshot would override the saved filter.
    collapsed: [...collapsedIds],
    scrollTop: todoScrollContainer()?.scrollTop || 0,
    focusId: document.activeElement?.closest?.('.todo-row')?.dataset?.id || '',
    searchInputValue: searchInput && 'value' in searchInput ? String(searchInput.value || '') : todoSearchQuery,
  };
}

function scheduleTodoViewMemoryCapture() {
  schedulePanelViewMemoryCapture('todo', buildTodoViewMemorySlice);
}

/**
 * @param {object | null | undefined} slice
 */
function applyTodoViewMemorySlice(slice) {
  if (!slice || typeof slice !== 'object') return;
  const searchText = typeof slice.searchInputValue === 'string' ? slice.searchInputValue : slice.search;
  if (typeof searchText === 'string') todoSearchQuery = searchText;
  if (slice.review === 'none' || slice.review === 'stale' || slice.review === '') {
    reviewListFilter = slice.review;
  }
  if (slice.rootStatus === null) rootStatusFilter = null;
  else if (Array.isArray(slice.rootStatus)) rootStatusFilter = new Set(slice.rootStatus.map(String));
  if (Array.isArray(slice.collapsed)) {
    collapsedIds = new Set(slice.collapsed.map(String));
    collapseDefaultsPending = false;
  }
  const searchWrap = document.querySelector('#todo-panel .todo-search');
  const searchBtn = document.querySelector('#todo-panel .todo-search-btn');
  const searchInput = searchWrap?.querySelector('cr-bar-input');
  if (searchWrap && typeof slice.searchOpen === 'boolean') searchWrap.hidden = !slice.searchOpen;
  if (searchInput && 'value' in searchInput) searchInput.value = todoSearchQuery;
  searchBtn?.classList.toggle('todo-search-btn--active', !!todoSearchQuery.trim());
  syncStatusFilterTriggerLabel();
  if (statusFilterMenu?.api.isOpen()) renderStatusFilterMenuItems();
  if (!latestItems.length) return;
  // Consumed before the repaint: renderList ends by retrying the pending
  // slice, so leaving it set here would re-enter this function.
  pendingTodoViewMemory = null;
  if (latestItems.length || listEl?.querySelector('.todo-empty')) renderList({ items: latestItems });
  const scrollEl = todoScrollContainer();
  if (scrollEl && Number.isFinite(Number(slice.scrollTop))) scrollEl.scrollTop = Number(slice.scrollTop);
  const focusId = String(slice.focusId || '').trim();
  if (focusId && listEl) {
    const row = listEl.querySelector(`.todo-row[data-id="${CSS.escape(focusId)}"]`);
    row?.querySelector('.todo-row-open')?.focus?.();
  }
}

function tryApplyPendingTodoViewMemory() {
  if (!pendingTodoViewMemory || !latestItems.length) return;
  applyTodoViewMemorySlice(pendingTodoViewMemory);
}

function filterTodoItemsByIntegrationState(items, filter) {
  if (!filter.size) return items;
  const byId = new Map(items.map((item) => [String(item.id), item]));
  const included = new Set();
  for (const item of items) {
    const summary = item.integrationSummary || {};
    if (!filter.has(summary.state) && !filter.has(summary.detail)) continue;
    let current = item;
    const seen = new Set();
    while (current && !seen.has(String(current.id))) {
      const id = String(current.id);
      included.add(id);
      seen.add(id);
      current = byId.get(String(current.parentId || ''));
    }
  }
  return items.filter((item) => included.has(String(item.id)));
}

function countTodoItemsByIntegrationState(items, filter) {
  if (filter === 'all') return items.length;
  if (filter instanceof Set) {
    return items.filter((item) => {
      const summary = item.integrationSummary || {};
      return filter.has(summary.state) || filter.has(summary.detail);
    }).length;
  }
  return items.filter((item) => {
    const summary = item.integrationSummary || {};
    return summary.state === filter || summary.detail === filter;
  }).length;
}

function createFilterCountEl(count) {
  const el = document.createElement('span');
  el.className = 'todo-filter-count';
  el.textContent = String(count);
  return el;
}

// ---------------------------------------------------------------------------
// Bulk "integrate with agent": selection, action bar, progress banner, polling
// ---------------------------------------------------------------------------

/**
 * @param {unknown} reason
 * @param {'skip' | 'entry' | 'pause'} [scope]
 * @returns {string}
 */
function batchReasonText(reason, scope = 'entry') {
  return localizeBatchReason(reason, t, scope);
}

/**
 * @param {{ error?: string, message?: string } | null | undefined} result
 * @param {string} [fallbackKey]
 * @returns {string}
 */
function batchErrorMessage(result, fallbackKey = 'todo.batchFailed') {
  return describeBatchFailure(result, t, fallbackKey);
}

/** @returns {{ folder: string, generation: number }} */
function captureCurrentBatchScope() {
  return captureBatchScope(getTodoWorkspaceFolder(), batchWorkspaceGeneration);
}

/**
 * @param {{ folder: string, generation: number }} scope
 * @returns {boolean}
 */
function isCurrentBatchScope(scope) {
  return isBatchScopeCurrent(scope, batchWorkspaceGeneration, (folder) => todoWorkspaceMatches(folder));
}

/** @returns {{ eligibleIds: string[], eligibleSet: Set<string> }} */
function currentBatchSelection() {
  return buildBatchSelection({
    items: getVisibleTodoItems(),
    collapsedIds: effectiveCollapsedIds(),
  });
}

/** Keep the toolbar toggle in sync with the current selection mode and language. */
function syncBatchSelectTrigger() {
  const btn = document.getElementById('todo-batch-select-btn');
  if (!(btn instanceof HTMLElement)) return;
  const label = batchSelectionMode ? t('todo.batchSelectModeExit') : t('todo.batchSelectMode');
  btn.setAttribute('aria-label', label);
  btn.title = label;
  btn.setAttribute('aria-pressed', batchSelectionMode ? 'true' : 'false');
  btn.classList.toggle('todo-batch-select-trigger--active', batchSelectionMode);
}

/**
 * @param {string} id
 * @returns {HTMLElement | null}
 */
function todoRowElForId(id) {
  if (!listEl || !id) return null;
  const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(id) : id;
  return listEl.querySelector(`.todo-row[data-id="${escaped}"]`);
}

/** @param {string} id */
function repaintSingleRowSelection(id) {
  const row = todoRowElForId(id);
  const box = row?.querySelector('.todo-row-select');
  if (box && 'checked' in box) box.checked = batchSelectedIds.has(id);
  if (row instanceof HTMLElement) {
    row.dataset.batchSelected = batchSelectedIds.has(id) ? 'true' : 'false';
  }
}

function ensureBatchActionBar() {
  if (batchActionBar) return batchActionBar;
  const layout = document.querySelector('#todo-panel .todo-layout');
  const toolbar = layout?.querySelector('.todo-toolbar');
  if (!layout || !(toolbar instanceof HTMLElement)) return null;
  const bar = document.createElement('div');
  bar.className = 'todo-batch-bar';
  bar.hidden = true;
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', t('todo.batchActionBarAria'));
  const count = document.createElement('span');
  count.className = 'todo-batch-bar-count';
  const selectAll = document.createElement('cr-bar-button');
  selectAll.className = 'todo-batch-bar-select-all';
  const clear = document.createElement('cr-bar-button');
  clear.className = 'todo-batch-bar-clear';
  const integrate = document.createElement('cr-bar-button');
  integrate.className = 'todo-batch-bar-integrate';
  integrate.setAttribute('variant', 'primary');
  const exit = document.createElement('cr-bar-button');
  exit.className = 'todo-batch-bar-exit';
  bar.append(selectAll, clear, count, integrate, exit);
  const anchor = batchBanner && batchBanner.isConnected ? batchBanner : toolbar;
  anchor.insertAdjacentElement('afterend', bar);
  batchActionBar = bar;
  batchActionBarRefs = { count, selectAll, clear, integrate, exit };
  selectAll.addEventListener('click', () => selectAllEligibleBatch());
  clear.addEventListener('click', () => clearBatchSelection());
  integrate.addEventListener('click', () => openBatchIntegratePicker());
  exit.addEventListener('click', () => exitBatchSelectionMode());
  return bar;
}

function paintBatchActionBar() {
  const bar = ensureBatchActionBar();
  if (!bar || !batchActionBarRefs) return;
  bar.hidden = !batchSelectionMode;
  if (!batchSelectionMode) return;
  const { eligibleIds } = currentBatchSelection();
  const selected = buildBatchRequestIds(batchSelectedIds, eligibleIds);
  const refs = batchActionBarRefs;
  refs.selectAll.textContent = t('todo.batchSelectAll');
  refs.selectAll.disabled = eligibleIds.length === 0 || selected.length >= eligibleIds.length;
  refs.clear.textContent = t('todo.batchClearSelection');
  refs.clear.disabled = selected.length === 0;
  refs.exit.textContent = t('todo.batchExitSelection');
  refs.integrate.disabled = selected.length === 0 || batchStartGuard.isPending();
  refs.integrate.textContent = t('todo.batchIntegrateSelected', { count: String(selected.length) });
  refs.count.textContent = t('todo.batchSelectedCount', { count: String(selected.length) });
}

function ensureBatchBanner() {
  if (batchBanner) return batchBanner;
  const layout = document.querySelector('#todo-panel .todo-layout');
  const toolbar = layout?.querySelector('.todo-toolbar');
  if (!layout || !(toolbar instanceof HTMLElement)) return null;
  const banner = document.createElement('div');
  banner.className = 'todo-batch-banner';
  banner.hidden = true;
  const head = document.createElement('div');
  head.className = 'todo-batch-banner-head';
  const title = document.createElement('span');
  title.className = 'todo-batch-banner-title';
  const status = document.createElement('span');
  status.className = 'todo-batch-banner-status';
  const counts = document.createElement('span');
  counts.className = 'todo-batch-banner-counts';
  head.append(title, status, counts);
  const progress = document.createElement('p');
  progress.className = 'todo-batch-banner-progress';
  const reason = document.createElement('p');
  reason.className = 'todo-batch-banner-reason';
  reason.hidden = true;
  const list = document.createElement('ul');
  list.className = 'todo-batch-banner-list';
  list.hidden = true;
  const actions = document.createElement('div');
  actions.className = 'todo-batch-banner-actions';
  const openChat = document.createElement('cr-bar-button');
  openChat.className = 'todo-batch-open-chat';
  const cancel = document.createElement('cr-bar-button');
  cancel.className = 'todo-batch-cancel';
  const resumeRetry = document.createElement('cr-bar-button');
  resumeRetry.className = 'todo-batch-resume-retry';
  resumeRetry.setAttribute('variant', 'primary');
  const resumeSkip = document.createElement('cr-bar-button');
  resumeSkip.className = 'todo-batch-resume-skip';
  const abandon = document.createElement('cr-bar-button');
  abandon.className = 'todo-batch-abandon';
  abandon.setAttribute('variant', 'danger');
  const dismiss = document.createElement('cr-bar-button');
  dismiss.className = 'todo-batch-dismiss';
  actions.append(openChat, cancel, resumeRetry, resumeSkip, abandon, dismiss);
  banner.append(head, progress, reason, list, actions);
  toolbar.insertAdjacentElement('afterend', banner);
  batchBanner = banner;
  batchBannerRefs = { title, status, counts, progress, reason, list, openChat, cancel, resumeRetry, resumeSkip, abandon, dismiss };
  openChat.addEventListener('click', () => {
    const chatId = String(activeBatch?.chatId || '').trim();
    if (!chatId) return;
    openTodoAgentChat({ id: chatId }, { reused: true });
    showPanelFn('chat');
  });
  cancel.addEventListener('click', () => void runBatchCancel());
  resumeRetry.addEventListener('click', () => runBatchResume('retry'));
  resumeSkip.addEventListener('click', () => runBatchResume('skip'));
  abandon.addEventListener('click', () => void runBatchAbandon());
  dismiss.addEventListener('click', () => dismissBatchBanner());
  return banner;
}

/**
 * Toggle one batch action control. A `cr-bar-button` sets `:host { display:
 * inline-block }`, which outranks the UA `[hidden]` rule, so the inline display
 * is kept alongside `hidden` for assistive tech.
 *
 * @param {HTMLElement | null | undefined} el
 * @param {boolean} visible
 */
function setBatchControlVisible(el, visible) {
  if (!el) return;
  el.hidden = !visible;
  el.style.display = visible ? '' : 'none';
}

function paintBatchBanner() {
  const banner = ensureBatchBanner();
  if (!banner) return;
  if (!activeBatch || !batchBannerRefs) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  const batch = activeBatch;
  const refs = batchBannerRefs;
  const { total, counts } = summarizeBatchEntries(batch);
  const done = ['merged', 'verified', 'failed', 'skipped', 'cancelled']
    .reduce((sum, state) => sum + (counts[state] || 0), 0);
  const controls = resolveBatchControls(batch);
  refs.title.textContent = t('todo.batchBannerTitle');
  refs.status.textContent = t(`todo.batchStatus_${batch.status}`);
  refs.status.dataset.batchStatus = String(batch.status || '');
  refs.counts.textContent = t('todo.batchCounts', { done: String(done), total: String(total) });
  const progressParts = ['merged', 'verified', 'failed', 'skipped', 'cancelled']
    .filter((state) => counts[state])
    .map((state) => `${t(`todo.batchEntryState_${state}`)} ${counts[state]}`);
  refs.progress.textContent = progressParts.join(' · ');
  const pausedReason = String(batch.pausedReason || '').trim();
  let reasonText = '';
  if (pausedReason) {
    reasonText = t('todo.batchPausedHint', { reason: batchReasonText(pausedReason, 'pause') });
  } else if (controls.livenessUnknown) {
    reasonText = t('todo.batchLivenessUnknownHint');
  }
  refs.reason.hidden = !reasonText;
  refs.reason.textContent = reasonText;
  const listItems = [];
  for (const entry of Array.isArray(batch.entries) ? batch.entries : []) {
    if (entry.state !== 'failed' && !(entry.state === 'skipped' && entry.reason)) continue;
    listItems.push(`${entry.title || entry.todoId}: ${batchReasonText(entry.reason, 'entry')}`);
  }
  for (const skip of Array.isArray(batch.skipped) ? batch.skipped : []) {
    listItems.push(`${String(skip.todoId || '').slice(0, 8)}: ${batchReasonText(skip.reason, 'skip')}`);
  }
  refs.list.replaceChildren(...listItems.map((text) => {
    const li = document.createElement('li');
    li.textContent = text;
    return li;
  }));
  refs.list.hidden = !listItems.length;
  setBatchControlVisible(refs.openChat, !!String(batch.chatId || '').trim());
  refs.openChat.textContent = t('todo.batchOpenChat');
  setBatchControlVisible(refs.cancel, controls.canCancel);
  refs.cancel.disabled = controls.cancelDisabled;
  refs.cancel.textContent = t('todo.batchCancel');
  setBatchControlVisible(refs.resumeRetry, controls.canResume);
  refs.resumeRetry.textContent = t('todo.batchResumeRetry');
  setBatchControlVisible(refs.resumeSkip, controls.canResume);
  refs.resumeSkip.textContent = t('todo.batchResumeSkip');
  setBatchControlVisible(refs.abandon, controls.canAbandon);
  refs.abandon.textContent = t('todo.batchAbandon');
  setBatchControlVisible(refs.dismiss, controls.canDismiss);
  refs.dismiss.textContent = t('todo.batchDismiss');
}

function dismissBatchBanner() {
  if (activeBatch?.id) lastNotifiedBatchId = activeBatch.id;
  stopBatchPoll();
  activeBatch = null;
  batchBadgeSignature = '';
  paintBatchBanner();
  repaintTodoRowBadges();
}

function enterBatchSelectionMode() {
  if (batchSelectionMode) return;
  batchSelectionMode = true;
  batchSelectedIds = new Set();
  listEl?.classList.add('todo-list--batch-mode');
  syncBatchSelectTrigger();
  paintBatchActionBar();
  repaintTodoRowBadges();
}

function exitBatchSelectionMode() {
  if (!batchSelectionMode) return;
  batchSelectionMode = false;
  batchSelectedIds = new Set();
  suppressRowOpenAfterLongPress = false;
  listEl?.classList.remove('todo-list--batch-mode');
  syncBatchSelectTrigger();
  paintBatchActionBar();
  repaintTodoRowBadges();
}

function toggleBatchSelectionMode() {
  if (batchSelectionMode) exitBatchSelectionMode();
  else enterBatchSelectionMode();
}

function selectAllEligibleBatch() {
  const { eligibleIds } = currentBatchSelection();
  batchSelectedIds = new Set(eligibleIds);
  paintBatchActionBar();
  repaintTodoRowBadges();
}

function clearBatchSelection() {
  batchSelectedIds = new Set();
  paintBatchActionBar();
  repaintTodoRowBadges();
}

/** @param {string} id */
function toggleRowBatchSelection(id) {
  const item = findItem(id);
  if (!item) return;
  if (!isBatchSelectableItem(item)) {
    setStatus(batchReasonText(item?.batchEligibility?.reason || 'not_eligible', 'skip'), true);
    return;
  }
  if (batchSelectedIds.has(id)) batchSelectedIds.delete(id);
  else batchSelectedIds.add(id);
  repaintSingleRowSelection(id);
  paintBatchActionBar();
  scheduleTodoViewMemoryCapture();
}

/** @param {Event} event */
function onBatchCheckboxChange(event) {
  const box = event.target instanceof Element ? event.target.closest('.todo-row-select') : null;
  const row = box?.closest('.todo-row');
  const id = String(row?.dataset.id || '');
  if (!id) return;
  const checked = event?.detail?.checked === true;
  if (checked) batchSelectedIds.add(id);
  else batchSelectedIds.delete(id);
  paintBatchActionBar();
  scheduleTodoViewMemoryCapture();
}

/** @param {PointerEvent} event */
function onRowMainPointerDown(event) {
  if (batchSelectionMode) return;
  if (String(event.pointerType || '') !== 'touch') return;
  // A new gesture never belongs to a previous long-press click.
  suppressRowOpenAfterLongPress = false;
  const row = event.currentTarget instanceof Element ? event.currentTarget.closest('.todo-row') : null;
  const id = String(row?.dataset.id || '');
  const item = findItem(id);
  if (!id || !item || !isBatchSelectableItem(item)) return;
  cancelBatchLongPress();
  batchLongPressPointerId = event.pointerId;
  batchLongPressStart = { x: event.clientX, y: event.clientY };
  batchLongPressTimer = setTimeout(() => {
    batchLongPressTimer = 0;
    const still = findItem(id);
    if (!still || !isBatchSelectableItem(still)) return;
    enterBatchSelectionMode();
    if (!batchSelectedIds.has(id)) {
      batchSelectedIds.add(id);
      repaintSingleRowSelection(id);
      paintBatchActionBar();
    }
    suppressRowOpenAfterLongPress = true;
    try {
      navigator?.vibrate?.(10);
    } catch {
      // Vibration is best-effort feedback; unsupported engines may throw.
    }
  }, BATCH_LONG_PRESS_MS);
}

function cancelBatchLongPress() {
  if (batchLongPressTimer) clearTimeout(batchLongPressTimer);
  batchLongPressTimer = 0;
  batchLongPressPointerId = -1;
}

/** @param {PointerEvent} event */
function onRowMainPointerMove(event) {
  if (!batchLongPressTimer || event.pointerId !== batchLongPressPointerId) return;
  if (Math.abs(event.clientX - batchLongPressStart.x) > BATCH_LONG_PRESS_MOVE_PX
    || Math.abs(event.clientY - batchLongPressStart.y) > BATCH_LONG_PRESS_MOVE_PX) {
    cancelBatchLongPress();
  }
}

/** @param {PointerEvent} event */
function onRowMainPointerUp(event) {
  if (batchLongPressPointerId !== -1 && event.pointerId !== batchLongPressPointerId) return;
  cancelBatchLongPress();
}

/**
 * Open the agent picker for the current selection, then start the batch. One
 * chat integrates every selected todo; skipped / aliased rows are reported in
 * the banner and in the status line.
 */
function openBatchIntegratePicker() {
  if (batchStartGuard.isPending()) return;
  const { eligibleIds } = currentBatchSelection();
  const ids = buildBatchRequestIds(batchSelectedIds, eligibleIds);
  if (!ids.length) {
    setStatus(t('todo.batchNothingSelected'), true);
    return;
  }
  // The scope is captured before the picker opens: it may sit open across a switch.
  const scope = captureCurrentBatchScope();
  const first = findItem(ids[0]);
  openTodoAgentStartModal({
    harness: resolveTodoStartHarness(first),
    onStart: ({ harness, model }) => startTodoBatch(ids, { harness, model }, scope),
  });
}

/**
 * @param {string[]} todoIds
 * @param {{ harness: string, model: string }} options
 * @param {{ folder: string, generation: number }} scope
 */
async function startTodoBatch(todoIds, options, scope) {
  if (batchStartGuard.isPending()) return;
  if (!scope.folder) {
    setStatus(t('todo.selectWorkspace'), true);
    return;
  }
  if (!isCurrentBatchScope(scope)) return;
  const ctx = getWorkspaceContext();
  const model = String(options.model || 'auto');
  const startToken = batchStartGuard.begin();
  paintBatchActionBar();
  setStatus(t('todo.batchStarting'));
  try {
    const data = await api.integrateTodosBatch(todoIds, scope.folder, {
      workspaceFile: ctx.workspaceFile,
      agentTransport: options.harness,
      model,
    });
    if (!isCurrentBatchScope(scope)) return;
    if (!data?.ok) {
      setStatus(batchErrorMessage(data, 'todo.batchStartFailed'), true);
      if (data?.batch) applyActiveBatch(data.batch);
      return;
    }
    if (data.batch?.id) batchAgentById.set(String(data.batch.id), { harness: options.harness, model });
    exitBatchSelectionMode();
    applyActiveBatch(data.batch);
    const skipped = Array.isArray(data.skipped) ? data.skipped.length : 0;
    if (data.chat) {
      openTodoAgentChat(data.chat, { initialPrompt: data.initialPrompt });
      showPanelFn('chat');
    }
    await refreshTodoList();
    if (!isCurrentBatchScope(scope)) return;
    setStatus(skipped
      ? t('todo.batchStartedWithSkipped', { count: String(skipped) })
      : t('todo.batchStarted'));
  } catch {
    if (isCurrentBatchScope(scope)) setStatus(t('todo.networkError'), true);
  } finally {
    if (batchStartGuard.release(startToken)) paintBatchActionBar();
  }
}

/**
 * Resume needs the harness / model, because the server opens a new chat for it.
 * Reuse what the batch was started with; when unknown (reload, another device)
 * ask through the same agent picker.
 *
 * @param {'retry' | 'skip'} entryAction
 */
function runBatchResume(entryAction) {
  const batch = activeBatch;
  if (!batch) return;
  const scope = captureCurrentBatchScope();
  const known = batchAgentById.get(String(batch.id));
  const need = resolveResumeAgentNeed(batch, known);
  if (!need.needsPicker) {
    void executeBatchResume(batch, entryAction, need.agent, scope);
    return;
  }
  const firstEntry = (Array.isArray(batch.entries) ? batch.entries : [])[0];
  openTodoAgentStartModal({
    harness: resolveTodoStartHarness(findItem(String(firstEntry?.todoId || ''))),
    onStart: ({ harness, model }) => {
      if (!isCurrentBatchScope(scope)) return;
      const agent = { harness, model: String(model || 'auto') };
      batchAgentById.set(String(batch.id), agent);
      void executeBatchResume(batch, entryAction, agent, scope);
    },
  });
}

/**
 * @param {object} batch
 * @param {'retry' | 'skip'} entryAction
 * @param {{ harness: string, model: string }} agent
 * @param {{ folder: string, generation: number }} scope
 */
async function executeBatchResume(batch, entryAction, agent, scope) {
  if (!isCurrentBatchScope(scope)) return;
  const folder = scope.folder;
  const needsForce = resolveBatchControls(batch).needsForce;
  if (needsForce && !confirmAction(t('todo.batchForceLivenessConfirm'))) return;
  const send = (forceLiveness) => api.resumeIntegrateBatch(batch.id, folder, {
    entryAction,
    forceLiveness,
    workspaceFile: getWorkspaceContext().workspaceFile,
    ...(agent ? { agentTransport: agent.harness, model: agent.model } : {}),
  });
  setStatus(t('todo.batchResuming'));
  try {
    let result = await send(needsForce);
    if (!isCurrentBatchScope(scope)) return;
    if (!result?.ok && ['liveness_unknown', 'agent_busy'].includes(String(result?.error || ''))) {
      if (!confirmAction(t('todo.batchForceLivenessConfirm'))) return;
      result = await send(true);
      if (!isCurrentBatchScope(scope)) return;
    }
    if (!result?.ok) {
      setStatus(batchErrorMessage(result, 'todo.batchResumeFailed'), true);
      if (result?.batch) applyActiveBatch(result.batch);
      return;
    }
    applyActiveBatch(result.batch);
    if (result.chat) {
      openTodoAgentChat(result.chat, { initialPrompt: result.initialPrompt });
      showPanelFn('chat');
    }
    await refreshTodoList();
    if (!isCurrentBatchScope(scope)) return;
    setStatus(t('todo.batchResumed'));
  } catch {
    if (isCurrentBatchScope(scope)) setStatus(t('todo.networkError'), true);
  }
}

async function runBatchAbandon() {
  const batch = activeBatch;
  if (!batch) return;
  if (!confirmAction(t('todo.batchAbandonConfirm'))) return;
  const scope = captureCurrentBatchScope();
  const needsForce = resolveBatchControls(batch).needsForce;
  if (needsForce && !confirmAction(t('todo.batchForceLivenessConfirm'))) return;
  setStatus(t('todo.batchAbandoning'));
  try {
    let result = await api.abandonIntegrateBatch(batch.id, scope.folder, { forceLiveness: needsForce });
    if (!isCurrentBatchScope(scope)) return;
    if (!result?.ok && ['liveness_unknown', 'agent_busy'].includes(String(result?.error || ''))) {
      if (!confirmAction(t('todo.batchForceLivenessConfirm'))) return;
      result = await api.abandonIntegrateBatch(batch.id, scope.folder, { forceLiveness: true });
      if (!isCurrentBatchScope(scope)) return;
    }
    if (!result?.ok) {
      setStatus(batchErrorMessage(result, 'todo.batchAbandonFailed'), true);
      if (result?.batch) applyActiveBatch(result.batch);
      return;
    }
    applyActiveBatch(result.batch);
    await refreshTodoList();
    if (!isCurrentBatchScope(scope)) return;
    setStatus(t('todo.batchAbandoned'));
  } catch {
    if (isCurrentBatchScope(scope)) setStatus(t('todo.networkError'), true);
  }
}

async function runBatchCancel() {
  const batch = activeBatch;
  if (!batch) return;
  if (!confirmAction(t('todo.batchCancelConfirm'))) return;
  const scope = captureCurrentBatchScope();
  setStatus(t('todo.batchCancelling'));
  try {
    const result = await api.cancelIntegrateBatch(batch.id, scope.folder);
    if (!isCurrentBatchScope(scope)) return;
    if (!result?.ok) {
      setStatus(batchErrorMessage(result, 'todo.batchCancelFailed'), true);
      return;
    }
    if (result.batch) applyActiveBatch(result.batch);
    setStatus(t('todo.batchCancelRequested'));
  } catch {
    if (isCurrentBatchScope(scope)) setStatus(t('todo.networkError'), true);
  }
}

/** One toast per terminal batch; the banner stays until dismissed. */
function notifyBatchFinished(batch) {
  if (typeof window === 'undefined') return;
  const { total, counts } = summarizeBatchEntries(batch);
  const done = (counts.merged || 0) + (counts.verified || 0);
  const message = t('todo.batchFinalSummary', {
    status: t(`todo.batchStatus_${batch.status}`),
    done: String(done),
    total: String(total),
    failed: String(counts.failed || 0),
    skipped: String(counts.skipped || 0),
  });
  window.dispatchEvent(new CustomEvent('cretli:toast', { detail: { message } }));
  setStatus(message);
}

/**
 * Track one batch view, repaint the banner / badges and keep polling while the
 * queue is still active. Called from create, resume, cancel, abandon, the list
 * sync and every poll answer.
 *
 * @param {object | null} batch
 */
function applyActiveBatch(batch) {
  activeBatch = batch || null;
  const signature = activeBatch
    ? (Array.isArray(activeBatch.entries) ? activeBatch.entries : [])
      .map((entry) => `${entry.todoId}:${entry.state}:${entry.reason}`)
      .join('|')
    : '';
  const badgesChanged = signature !== batchBadgeSignature;
  batchBadgeSignature = signature;
  if (activeBatch && isTerminalBatchStatus(activeBatch.status) && activeBatch.id !== lastNotifiedBatchId) {
    lastNotifiedBatchId = activeBatch.id;
    notifyBatchFinished(activeBatch);
  }
  paintBatchBanner();
  paintBatchActionBar();
  // Polling must not restyle every row when no entry changed.
  if (badgesChanged) repaintTodoRowBadges();
  scheduleBatchPoll();
}

/** @param {object[] | null | undefined} batches */
function syncTrackedBatch(batches) {
  const chosen = resolveBatchToTrack(batches, activeBatch);
  if (chosen) applyActiveBatch(chosen);
  else if (activeBatch && !isTerminalBatchStatus(activeBatch.status)) applyActiveBatch(null);
}

function stopBatchPoll() {
  batchPollGeneration += 1;
  if (batchPollTimer) clearTimeout(batchPollTimer);
  batchPollTimer = 0;
}

function scheduleBatchPoll() {
  stopBatchPoll();
  if (!activeBatch || !isActiveBatchStatus(activeBatch.status)) return;
  const generation = batchPollGeneration;
  batchPollTimer = setTimeout(() => {
    batchPollTimer = 0;
    void pollActiveBatch(generation);
  }, BATCH_POLL_MS);
}

/** @param {number} generation */
async function pollActiveBatch(generation) {
  if (generation !== batchPollGeneration) return;
  const batchId = String(activeBatch?.id || '');
  const folder = getTodoWorkspaceFolder();
  if (!batchId || !todoWorkspaceMatches(folder)) return;
  try {
    const data = await api.getIntegrateBatch(folder, batchId);
    if (generation !== batchPollGeneration) return;
    if (data?.ok && data.batch) applyActiveBatch(data.batch);
    else scheduleBatchPoll();
  } catch {
    if (generation === batchPollGeneration) scheduleBatchPoll();
  }
}

/**
 * Background tabs throttle timers, so a batch may have finished while hidden:
 * poll once on return so the final notification still fires.
 */
function onBatchPanelVisibilityChange() {
  if (document.visibilityState !== 'visible') return;
  if (!activeBatch || !isActiveBatchStatus(activeBatch.status)) return;
  void pollActiveBatch(batchPollGeneration);
}

/** Workspace switch: a batch belongs to exactly one workspace. */
function resetBatchWorkspaceView() {
  batchWorkspaceGeneration += 1;
  batchStartGuard.reset();
  batchListGate.next();
  stopBatchPoll();
  activeBatch = null;
  lastNotifiedBatchId = '';
  batchBadgeSignature = '';
  batchSelectedIds = new Set();
  if (batchSelectionMode) exitBatchSelectionMode();
  paintBatchBanner();
}

function integrationFilterLabel(filter) {
  if (filter === 'no_code_changes') return t('todo.integrationNoCodeDetail');
  return t(`todo.integrationFilter${filter.charAt(0).toUpperCase()}${filter.slice(1)}`);
}

function reviewFilterLabel(filter) {
  return t(filter === 'stale' ? 'todo.filterReviewStale' : 'todo.filterReviewNone');
}

function saveStatusFilter() {
  try {
    localStorage.setItem(
      statusFilterStorageKey(),
      JSON.stringify(serializeTodoRootStatusFilter(rootStatusFilter))
    );
  } catch {
    // Private mode can reject storage; filtering still works for this view.
  }
}

/**
 * @param {'idea' | 'ready' | 'doing' | 'done'} status
 * @returns {string}
 */
function todoStatusLabelKey(status) {
  if (status === 'ready') return 'todo.statusReady';
  if (status === 'doing') return 'todo.statusDoing';
  if (status === 'done') return 'todo.statusDone';
  return 'todo.statusIdea';
}

function formatStatusFilterTriggerLabel() {
  const parts = rootStatusFilter
    ? TODO_ITEM_STATUSES.filter((status) => rootStatusFilter.has(status)).map((status) =>
      t(todoStatusLabelKey(status))
    )
    : [];
  if (reviewListFilter) parts.push(reviewFilterLabel(reviewListFilter));
  if (isIntegrationPendingSelection(integrationListFilter)) parts.push(integrationFilterLabel('pending'));
  else if (integrationListFilter.size) parts.push([...integrationListFilter].map(integrationFilterLabel).join(', '));
  return parts.length ? parts.join(', ') : t('todo.filterStatusAll');
}

function syncStatusFilterTriggerLabel() {
  if (!statusFilterTrigger) return;
  const labelEl = statusFilterTrigger.querySelector('.todo-status-filter-trigger-label');
  const text = formatStatusFilterTriggerLabel();
  if (labelEl) labelEl.textContent = text;
  else statusFilterTrigger.append(text);
  statusFilterTrigger.title = t('todo.filterStatusTitle');
  statusFilterTrigger.setAttribute('aria-label', t('todo.filterStatusAria'));
}

function renderStatusFilterMenuItems() {
  const entry = statusFilterMenu;
  if (!entry) return;
  const list = entry.list;
  list.textContent = '';
  const showAll = !rootStatusFilter;
  const selected = rootStatusFilter || new Set(TODO_ITEM_STATUSES);
  const addRow = (id, label, checked, count) => {
    const row = document.createElement('div');
    row.className = 'todo-status-filter-row';
    row.dataset.filterId = id;
    const box = document.createElement('cr-checkbox');
    box.checked = checked;
    box.setAttribute('aria-label', label);
    const text = document.createElement('span');
    text.textContent = label;
    box.appendChild(text);
    row.append(box, createFilterCountEl(count));
    list.appendChild(row);
  };
  addRow('all', t('todo.filterStatusAll'), showAll, latestItems.length);
  TODO_ITEM_STATUSES.forEach((status) => {
    const count = filterTodoItemsByRootStatus(latestItems, new Set([status])).length;
    addRow(status, t(todoStatusLabelKey(status)), !showAll && selected.has(status), count);
  });
  const heading = document.createElement('div');
  heading.className = 'todo-review-filter-heading';
  heading.textContent = t('todo.filterReviewHeading');
  list.appendChild(heading);
  ['none', 'stale'].forEach((filter) => {
    const row = document.createElement('div');
    row.className = 'todo-review-filter-row';
    row.dataset.reviewFilter = filter;
    const box = document.createElement('cr-checkbox');
    box.checked = reviewListFilter === filter;
    box.setAttribute('aria-label', reviewFilterLabel(filter));
    const text = document.createElement('span');
    text.textContent = reviewFilterLabel(filter);
    box.appendChild(text);
    row.append(box, createFilterCountEl(countTodoItemsByReviewState(latestItems, filter)));
    list.appendChild(row);
  });
  const integrationHeading = document.createElement('div');
  integrationHeading.className = 'todo-review-filter-heading';
  integrationHeading.textContent = t('todo.integrationFilterHeading');
  list.appendChild(integrationHeading);
  ['all', 'pending', ...TODO_INTEGRATION_FILTERS].forEach((filter) => {
    const row = document.createElement('div');
    row.className = 'todo-integration-filter-row';
    row.dataset.integrationFilter = filter;
    const box = document.createElement('cr-checkbox');
    box.checked = filter === 'all'
      ? integrationListFilter.size === 0
      : filter === 'pending'
        ? isIntegrationPendingSelection(integrationListFilter)
        : integrationListFilter.has(filter);
    box.setAttribute('aria-label', integrationFilterLabel(filter));
    const label = document.createElement('span');
    label.textContent = integrationFilterLabel(filter);
    box.appendChild(label);
    const count = filter === 'pending'
      ? TODO_INTEGRATION_PENDING_FILTERS.reduce((sum, key) => sum + countTodoItemsByIntegrationState(latestItems, key), 0)
      : countTodoItemsByIntegrationState(latestItems, filter);
    row.append(box, createFilterCountEl(count));
    list.appendChild(row);
  });
}

function applyStatusFilterFromUi() {
  const entry = statusFilterMenu;
  if (!entry) return;
  /** @type {Set<string>} */
  const picked = new Set();
  let allChecked = false;
  entry.list.querySelectorAll('.todo-status-filter-row').forEach((row) => {
    if (!(row instanceof HTMLElement)) return;
    const id = String(row.dataset.filterId || '');
    const box = row.querySelector('cr-checkbox');
    const checked = box && 'checked' in box ? !!box.checked : false;
    if (id === 'all') {
      allChecked = checked;
      return;
    }
    if (checked) picked.add(id);
  });
  if (allChecked || picked.size === 0 || picked.size >= TODO_ITEM_STATUSES.length) {
    rootStatusFilter = null;
  } else {
    rootStatusFilter = picked;
  }
  saveStatusFilter();
  syncStatusFilterTriggerLabel();
  if (latestItems.length || listEl?.querySelector('.todo-empty')) {
    renderList({ items: latestItems });
  }
  scheduleTodoViewMemoryCapture();
}

/** Workspace-wide usage statistics dialog (aggregate view of the TODO panel). */
let usageDialog = null;
let usageSection = null;

function openUsageDialog() {
  if (!usageDialog) {
    const dialog = document.createElement('cr-dialog');
    dialog.className = 'todo-usage-dialog';
    dialog.closable = true;
    dialog.closeLabel = t('todo.closeEditor');
    dialog.style.setProperty('--cr-dialog-max-width', '60rem');
    const section = document.createElement('cr-todo-usage');
    section.todoId = '';
    dialog.appendChild(section);
    // Closing stops fetching and aborts any request still in flight.
    dialog.addEventListener('cr-dialog-close', () => {
      section.active = false;
    });
    document.body.appendChild(dialog);
    usageDialog = dialog;
    usageSection = section;
  }
  usageDialog.heading = t('todo.usageDialogHeading');
  usageSection.active = true;
  usageSection.refresh();
  usageDialog.show();
}

function ensureUsageUi() {
  const anchor = document.getElementById('todo-new-open-btn');
  if (!anchor || document.getElementById('todo-usage-open-btn')) return;
  const btn = document.createElement('cr-icon-button');
  btn.id = 'todo-usage-open-btn';
  btn.setAttribute('title', t('todo.usageOpenTitle'));
  btn.setAttribute('aria-label', t('todo.usageOpenTitle'));
  const icon = document.createElement('span');
  icon.className = 'mdi mdi-chart-box-outline';
  icon.setAttribute('aria-hidden', 'true');
  btn.appendChild(icon);
  btn.addEventListener('click', openUsageDialog);
  anchor.after(btn);
  window.addEventListener('cretli-active-workspace-changed', () => {
    if (usageSection?.active) usageSection.refresh();
  });
  window.addEventListener('cr-lang-changed', () => {
    btn.setAttribute('title', t('todo.usageOpenTitle'));
    btn.setAttribute('aria-label', t('todo.usageOpenTitle'));
    if (usageDialog) usageDialog.heading = t('todo.usageDialogHeading');
  });
}

function ensureStatusFilterUi(toolbar) {
  if (!(toolbar instanceof HTMLElement) || statusFilterMenu) return;
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'todo-status-filter-trigger';
  trigger.setAttribute('aria-haspopup', 'menu');
  const triggerIcon = document.createElement('span');
  triggerIcon.className = 'mdi mdi-filter-variant';
  triggerIcon.setAttribute('aria-hidden', 'true');
  const triggerLabel = document.createElement('span');
  triggerLabel.className = 'todo-status-filter-trigger-label';
  trigger.append(triggerIcon, triggerLabel);
  statusFilterTrigger = trigger;
  const panel = document.createElement('div');
  panel.className = 'chat-list-modal todo-status-filter-panel';
  panel.hidden = true;
  const list = document.createElement('div');
  list.className = 'chat-list-panel todo-status-filter-list';
  list.setAttribute('role', 'menu');
  panel.appendChild(list);
  document.body.appendChild(panel);
  /** @type {{ api: ReturnType<typeof initDropdown>, panel: HTMLElement, list: HTMLElement }} */
  const entry = {
    api: initDropdown({
      triggerEl: trigger,
      floatingEl: panel,
      compact: true,
      placement: 'bottom-start',
      minWidthPx: 220,
      maxHeightPx: 320,
      onOpen: () => renderStatusFilterMenuItems(),
      onClose: (reason) => {
        if (reason === 'escape' && statusFilterTrigger) statusFilterTrigger.focus();
      },
    }),
    panel,
    list,
  };
  statusFilterMenu = entry;
  // cr-checkbox toggles itself (clicks on the label text included); only keep the
  // "All" row and the status rows mutually consistent here.
  list.addEventListener('cr-change', (event) => {
    const reviewRow = event.target instanceof Element ? event.target.closest('.todo-review-filter-row') : null;
    if (reviewRow instanceof HTMLElement) {
      event.stopPropagation();
      const filter = parseReviewListFilter(reviewRow.dataset.reviewFilter);
      const reviewBox = reviewRow.querySelector('cr-checkbox');
      // The two review filters are mutually exclusive; unchecking clears it.
      reviewListFilter = reviewBox && 'checked' in reviewBox && reviewBox.checked ? filter : '';
      entry.list.querySelectorAll('.todo-review-filter-row').forEach((other) => {
        const box = other.querySelector('cr-checkbox');
        if (box && other !== reviewRow) box.checked = false;
      });
      saveReviewFilter();
      syncStatusFilterTriggerLabel();
      if (latestItems.length || listEl?.querySelector('.todo-empty')) renderList({ items: latestItems });
      scheduleTodoViewMemoryCapture();
      return;
    }
    const integrationRow = event.target instanceof Element ? event.target.closest('.todo-integration-filter-row') : null;
    if (integrationRow instanceof HTMLElement) {
      event.stopPropagation();
      const box = integrationRow.querySelector('cr-checkbox');
      const filter = String(integrationRow.dataset.integrationFilter || '');
      if (filter === 'all') {
        integrationListFilter = new Set();
        entry.list.querySelectorAll('.todo-integration-filter-row').forEach((other) => {
          if (other.dataset.integrationFilter !== 'all') other.querySelector('cr-checkbox').checked = false;
        });
      } else if (filter === 'pending' && box && 'checked' in box) {
        integrationListFilter = new Set(box.checked ? TODO_INTEGRATION_PENDING_FILTERS : []);
        entry.list.querySelectorAll('.todo-integration-filter-row').forEach((other) => {
          const key = String(other.dataset.integrationFilter || '');
          const otherBox = other.querySelector('cr-checkbox');
          if (!otherBox || key === 'pending') return;
          otherBox.checked = key === 'all' ? integrationListFilter.size === 0 : integrationListFilter.has(key);
        });
      } else if (box && 'checked' in box) {
        if (box.checked) integrationListFilter.add(filter);
        else integrationListFilter.delete(filter);
        const allBox = entry.list.querySelector('[data-integration-filter="all"] cr-checkbox');
        if (allBox) allBox.checked = integrationListFilter.size === 0;
        const pendingBox = entry.list.querySelector('[data-integration-filter="pending"] cr-checkbox');
        if (pendingBox) pendingBox.checked = isIntegrationPendingSelection(integrationListFilter);
      }
      saveIntegrationFilter();
      syncStatusFilterTriggerLabel();
      if (latestItems.length || listEl?.querySelector('.todo-empty')) renderList({ items: latestItems });
      scheduleTodoViewMemoryCapture();
      return;
    }
    const row = event.target instanceof Element ? event.target.closest('.todo-status-filter-row') : null;
    if (!(row instanceof HTMLElement)) return;
    event.stopPropagation();
    const id = String(row.dataset.filterId || '');
    const box = row.querySelector('cr-checkbox');
    if (!(box && 'checked' in box)) return;
    const allBox = entry.list.querySelector('[data-filter-id="all"] cr-checkbox');
    const statusBoxes = [...entry.list.querySelectorAll('.todo-status-filter-row:not([data-filter-id="all"]) cr-checkbox')];
    if (id === 'all') {
      box.checked = true;
      statusBoxes.forEach((statusBox) => {
        statusBox.checked = false;
      });
    } else {
      if (allBox) allBox.checked = false;
      if (!statusBoxes.some((statusBox) => statusBox.checked) && allBox) allBox.checked = true;
    }
    applyStatusFilterFromUi();
  });
  trigger.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!entry.api.isOpen()) closeAllOpenDropdowns();
    entry.api.toggle();
  });
  loadStatusFilter();
  loadReviewFilter();
  loadIntegrationFilter();
  syncStatusFilterTriggerLabel();
  const refreshBtn = document.getElementById('todo-refresh-btn');
  if (refreshBtn?.parentNode) {
    refreshBtn.parentNode.insertBefore(trigger, refreshBtn.nextSibling);
  } else {
    toolbar.appendChild(trigger);
  }
  ensureTodoSearchUi(toolbar, trigger);
}

/**
 * Toolbar toggle for the bulk "integrate with agent" selection mode. On touch it
 * is also reachable by long-pressing an eligible row.
 *
 * @param {HTMLElement} toolbar
 */
function ensureBatchSelectionUi(toolbar) {
  if (!(toolbar instanceof HTMLElement) || document.getElementById('todo-batch-select-btn')) return;
  const btn = document.createElement('cr-icon-button');
  btn.id = 'todo-batch-select-btn';
  btn.className = 'todo-batch-select-trigger';
  btn.setAttribute('aria-pressed', 'false');
  const icon = document.createElement('span');
  icon.className = 'mdi mdi-checkbox-multiple-marked-outline';
  icon.setAttribute('aria-hidden', 'true');
  btn.appendChild(icon);
  btn.addEventListener('click', () => toggleBatchSelectionMode());
  const refreshBtn = document.getElementById('todo-refresh-btn');
  if (refreshBtn?.parentNode) {
    refreshBtn.parentNode.insertBefore(btn, refreshBtn.nextSibling);
  } else {
    toolbar.appendChild(btn);
  }
  syncBatchSelectTrigger();
}

/**
 * Search button next to the filter trigger; the input row opens below the toolbar.
 *
 * @param {HTMLElement} toolbar
 * @param {HTMLElement} anchor
 */
function ensureTodoSearchUi(toolbar, anchor) {
  if (toolbar.querySelector('.todo-search-btn')) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'todo-search-btn';
  button.setAttribute('aria-label', t('todo.search'));
  button.title = t('todo.search');
  button.innerHTML = '<span class="mdi mdi-magnify" aria-hidden="true"></span>';
  const wrap = document.createElement('div');
  wrap.className = 'todo-search';
  wrap.hidden = true;
  const input = document.createElement('cr-bar-input');
  input.setAttribute('type', 'search');
  input.setAttribute('placeholder', t('todo.searchPlaceholder'));
  input.setAttribute('aria-label', t('todo.search'));
  wrap.appendChild(input);
  const apply = () => {
    todoSearchQuery = String(input.value || '');
    button.classList.toggle('todo-search-btn--active', !!todoSearchQuery.trim());
    if (latestItems.length || listEl?.querySelector('.todo-empty')) renderList({ items: latestItems });
    scheduleTodoViewMemoryCapture();
  };
  input.addEventListener('input', apply);
  button.addEventListener('click', () => {
    wrap.hidden = !wrap.hidden;
    if (wrap.hidden) {
      input.value = '';
      apply();
    } else {
      input.focus?.();
    }
  });
  anchor.parentNode?.insertBefore(button, anchor.nextSibling);
  toolbar.insertAdjacentElement('afterend', wrap);
}

/**
 * @param {string} message
 * @returns {boolean}
 */
function confirmAction(message) {
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') return true;
  return window.confirm(message);
}

/**
 * Second meta line for a row: `#e7212fc3 · 2 chaty · 2d temu`.
 *
 * @param {object} item
 * @returns {string}
 */
function formatTodoMetaText(item) {
  const meta = readTodoRowMeta(item);
  const parts = [];
  if (meta.shortId) parts.push(`#${meta.shortId}`);
  if (meta.chats > 0) {
    parts.push(t(resolveTodoChatCountKey(meta.chats, getCurrentLang()), { count: String(meta.chats) }));
  }
  if (meta.age) {
    const key =
      meta.age.unit === 'now'
        ? 'todo.timeNow'
        : meta.age.unit === 'minutes'
          ? 'todo.timeMinutes'
          : meta.age.unit === 'hours'
            ? 'todo.timeHours'
            : 'todo.timeDays';
    parts.push(t(key, { count: String(meta.age.count) }));
  }
  const integrationState = String(item?.integrationSummary?.state || 'unconfirmed');
  const integrationDetail = String(item?.integrationSummary?.detail || '');
  const integrationLabel = ['no_code_changes', 'rejected', 'conflict'].includes(integrationDetail)
    ? integrationFilterLabel(integrationDetail)
    : integrationFilterLabel(integrationState);
  // An unconfirmed state is the default for every open task, so it only adds
  // noise on a narrow row; show integration for done work and non-default states.
  // The healthy state (integrated, no caveat) is left out so rows stay one line.
  const isHealthy = integrationState === 'integrated' && !integrationDetail;
  const showIntegration = !isHealthy && (integrationState !== 'unconfirmed' || !!integrationDetail
    || normalizeTodoItemStatus(item?.status) === 'done');
  if (showIntegration) parts.push(integrationLabel);
  return parts.join(' · ');
}

/**
 * @param {string} text
 * @param {string} okMessage
 */
async function copyTodoText(text, okMessage) {
  const value = String(text || '');
  if (!value) {
    setStatus(t('todo.copyFailed'), true);
    return;
  }
  const ok = await writeTextToClipboard(value);
  setStatus(ok ? okMessage : t('todo.copyFailed'), !ok);
}

/** @param {HTMLElement} row */
function disposeRowMenu(row) {
  const entry = rowMenus.get(row);
  if (!entry) return;
  // Mark before destroy(): destroy() may emit onClose, which must not re-enter.
  entry.destroying = true;
  rowMenus.delete(row);
  try {
    entry.api.destroy();
  } catch {
    // A detached dropdown must never break the next render.
  }
  entry.panel.remove();
}

function disposeAllRowMenus() {
  for (const row of [...rowMenus.keys()]) disposeRowMenu(row);
}

function bindCardHandlers(card) {
  card.addEventListener('todo-status-change', onStatusChange);
  card.addEventListener('todo-retry-blocked', onRetryBlockedTodo);
  card.addEventListener('todo-recover', onRecoverTodo);
  card.addEventListener('todo-release-unknown', onReleaseUnknownTodo);
  card.addEventListener('todo-integration', onIntegrationDecision);
  card.addEventListener('todo-title-save', onTitleBlur);
  card.addEventListener('todo-body-save', onBodyBlur);
  card.addEventListener('todo-delete', onDelete);
  card.addEventListener('todo-start-agent', onStartAgent);
  card.addEventListener('todo-open-chat', onOpenChat);
  card.addEventListener('todo-open-git', onOpenGit);
  card.addEventListener('todo-copy', onCardCopy);
  card.addEventListener('todo-assignee-change', onEditorAssigneeChange);
  card.addEventListener('todo-runmode-change', onEditorRunModeChange);
  card.addEventListener('todo-executionmode-change', onEditorExecutionModeChange);
  card.addEventListener('todo-plan-approve', onPlanApprove);
  card.addEventListener('todo-review-open-report', onReviewOpenReport);
  card.addEventListener('todo-review-start', onReviewStart);
  card.addEventListener('todo-refine-start', (e) => openTodoRefinePicker(findItem(String(e?.detail?.id || ''))));
}

/** @param {Event} e */
async function onCardCopy(e) {
  const detail = /** @type {any} */ (e)?.detail || {};
  const id = String(detail.id || '').trim();
  const kind = String(detail.kind || '').trim();
  const cardEl = e.target instanceof Element ? e.target.closest('cr-todo-card') : null;
  const item = (cardEl && 'item' in cardEl ? cardEl.item : null) || findItem(id);
  if (!item) return;
  if (kind === 'id') {
    await copyTodoText(String(item.id || ''), t('todo.copiedId'));
    return;
  }
  if (kind === 'ref') {
    await copyTodoText(formatTodoRef(item.id), t('todo.copiedRef'));
    return;
  }
  if (kind === 'markdown') {
    await copyTodoText(buildTodoMarkdown(item), t('todo.copiedMarkdown'));
  }
}

async function onRecoverTodo(e) {
  const detail = /** @type {any} */ (e)?.detail || {};
  const id = String(detail.id || '').trim();
  const revision = String(detail.revision || '').trim();
  const ctx = getWorkspaceContext();
  if (!id || !revision || !ctx.workspaceFolder) return;
  const card = e.currentTarget instanceof HTMLElement ? e.currentTarget : null;
  const feedback = card?.querySelector('.todo-action-feedback');
  const showFeedback = (message, isError = false) => {
    if (!(feedback instanceof HTMLElement)) return;
    feedback.hidden = !message;
    feedback.textContent = message;
    feedback.dataset.tone = isError ? 'error' : 'status';
  };
  showFeedback(t('todo.recoveryResume'));
  setStatus(t('todo.recoveryResume'));
  try {
    const result = await api.recoverWorkspaceWatcherTodo(id, ctx.workspaceFolder, revision);
    if (!result?.ok) {
      const outcome = String(result?.outcome || '');
      const message = outcome === 'conflict'
        ? t('todo.recoveryResumeConflict')
        : t('todo.recoveryResumeFailed', { outcome: outcome || result?.error || 'error' });
      showFeedback(message, true);
      setStatus(message, true);
      return;
    }
    await refreshTodoList();
    await refreshWatcherPanel();
    openEditor(id);
    showFeedback(t('todo.recoveryResumeSuccess'));
    setStatus(t('todo.recoveryResumeSuccess'));
  } catch {
    showFeedback(t('todo.recoveryResumeFailed', { outcome: 'network' }), true);
    setStatus(t('todo.networkError'), true);
  }
}

/** @param {Event} e */
async function onReleaseUnknownTodo(e) {
  const detail = /** @type {any} */ (e)?.detail || {};
  const id = String(detail.id || '').trim();
  const revision = String(detail.revision || '').trim();
  const title = String(detail.title || id).trim();
  const ctx = getWorkspaceContext();
  if (!id || !revision || !ctx.workspaceFolder) return;
  if (!confirmAction(t('todo.recoveryReleaseUnknownConfirm', { title }))) return;
  const card = e.currentTarget instanceof HTMLElement ? e.currentTarget : null;
  const feedback = card?.querySelector('.todo-action-feedback');
  const showFeedback = (message, isError = false) => {
    if (!(feedback instanceof HTMLElement)) return;
    feedback.hidden = !message;
    feedback.textContent = message;
    feedback.dataset.tone = isError ? 'error' : 'status';
  };
  showFeedback(t('todo.recoveryReleaseUnknown'));
  setStatus(t('todo.recoveryReleaseUnknown'));
  try {
    const result = await api.releaseDoingWorkspaceWatcherTodo(id, ctx.workspaceFolder, revision);
    if (!result?.ok) {
      const outcome = String(result?.outcome || '');
      const message = outcome === 'conflict'
        ? t('todo.recoveryResumeConflict')
        : t('todo.recoveryReleaseUnknownFailed', { outcome: outcome || result?.error || 'error' });
      showFeedback(message, true);
      setStatus(message, true);
      return;
    }
    await refreshTodoList();
    await refreshWatcherPanel();
    openEditor(id);
    showFeedback(t('todo.recoveryReleaseUnknownSuccess'));
    setStatus(t('todo.recoveryReleaseUnknownSuccess'));
  } catch {
    showFeedback(t('todo.recoveryReleaseUnknownFailed', { outcome: 'network' }), true);
    setStatus(t('todo.networkError'), true);
  }
}

/**
 * Human integration decision from the editor card: confirm marks the todo done
 * (unblocking siblings), reject returns it to the pool with the worktree kept.
 *
 * @param {Event} e
 */
async function onIntegrationDecision(e) {
  const detail = /** @type {any} */ (e)?.detail || {};
  const id = String(detail.id || '').trim();
  const revision = String(detail.revision || '').trim();
  const requested = String(detail.action || '').trim();
  const action = ['prepare', 'apply', 'reject', 'confirm', 'invalidate', 'no-code'].includes(requested) ? requested : 'confirm';
  const ctx = getWorkspaceContext();
  if (!id || !revision || !ctx.workspaceFolder) return;
  const card = e.currentTarget instanceof HTMLElement ? e.currentTarget : null;
  const feedback = card?.querySelector('.todo-action-feedback');
  let proof = {};
  let reason = '';
  if (action === 'invalidate' || action === 'no-code') {
    const promptKey = action === 'no-code' ? 'todo.integrationAskNoCodeReason' : 'todo.integrationAskInvalidationReason';
    const suppliedReason = typeof window.prompt === 'function' ? window.prompt(t(promptKey)) : null;
    if (suppliedReason == null || !suppliedReason.trim()) return;
    reason = suppliedReason.trim();
  }
  if (action === 'confirm') {
    const item = findItem(id);
    if (!item || typeof window.prompt !== 'function') return;
    // One click: the server records the current workspace branch and HEAD commit.
    if (!confirmAction(t('todo.integrationSimpleConfirm', { title: item.title || id }))) return;
    proof = { simple: true };
  }
  const showFeedback = (message, isError = false) => {
    if (!(feedback instanceof HTMLElement)) return;
    feedback.hidden = !message;
    feedback.textContent = message;
    feedback.dataset.tone = isError ? 'error' : 'status';
  };
  const busyMessage = action === 'prepare' ? t('todo.integrationPreparing') : action === 'apply' ? t('todo.integrationApplying') : t('todo.integrationSaving');
  showFeedback(busyMessage);
  setStatus(busyMessage);
  try {
    const result = await api.integrateTodo(id, ctx.workspaceFolder, action, revision, reason, proof);
    if (!result?.ok) {
      const message = integrationFailureMessage(action, result);
      showFeedback(message, true);
      setStatus(message, true);
      return;
    }
    await refreshTodoList();
    await refreshWatcherPanel();
    openEditor(id);
    const success = action === 'prepare'
      ? t('todo.integrationPrepared')
      : action === 'apply'
        ? t('todo.integrationApplied')
      : action === 'reject'
        ? t('todo.integrationRejected')
        : action === 'invalidate'
          ? t('todo.integrationProofInvalidated')
          : action === 'no-code'
            ? t('todo.integrationNoCodeSaved')
        : t('todo.integrationConfirmed');
    showFeedback(success);
    setStatus(success);
  } catch {
    showFeedback(t('todo.integrationFailed'), true);
    setStatus(t('todo.networkError'), true);
  }
}

async function onRetryBlockedTodo(e) {
  const detail = /** @type {any} */ (e)?.detail || {};
  const id = String(detail.id || '').trim();
  const ctx = getWorkspaceContext();
  if (!id || !ctx.workspaceFolder) return;
  const card = e.currentTarget instanceof HTMLElement ? e.currentTarget : null;
  const feedback = card?.querySelector('.todo-action-feedback');
  const showFeedback = (message, isError = false) => {
    if (!(feedback instanceof HTMLElement)) return;
    feedback.hidden = !message;
    feedback.textContent = message;
    feedback.dataset.tone = isError ? 'error' : 'status';
  };
  showFeedback(t('todo.retryingBlocked'));
  setStatus(t('todo.retryingBlocked'));
  try {
    const result = await api.retryWorkspaceWatcherTodo(id, ctx.workspaceFolder);
    if (!result?.ok) {
      showFeedback(result?.error || t('todo.retryBlockedFailed'), true);
      setStatus(result?.error || t('todo.retryBlockedFailed'), true);
      return;
    }
    await refreshTodoList();
    openEditor(id);
    showFeedback(t('todo.retryBlockedSuccess'));
    setStatus(t('todo.retryBlockedSuccess'));
  } catch {
    showFeedback(t('todo.retryBlockedFailed'), true);
    setStatus(t('todo.networkError'), true);
  }
}

/**
 * @param {string} id
 * @returns {object | null}
 */
function findItem(id) {
  if (!todoWorkspaceMatches(latestWorkspaceFolder)) return null;
  return latestItems.find((item) => String(item?.id || '') === id) || null;
}

/**
 * @param {object | null} item
 * @returns {{ id: string, title: string, status: string } | null}
 */
function summarizeTodo(item) {
  if (!item?.id) return null;
  return {
    id: String(item.id),
    title: String(item.title || ''),
    status: String(item.status || ''),
  };
}

/**
 * Load one todo into the in-memory list when the panel has not fetched it yet.
 *
 * @param {string} id
 * @returns {Promise<object | null>}
 */
async function ensureTodoLoaded(id) {
  const todoId = String(id || '').trim();
  if (!todoId) return null;
  const cached = findItem(todoId);
  if (cached) return cached;
  const folder = getTodoWorkspaceFolder();
  const data = await api.getTodos(folder);
  if (!todoWorkspaceMatches(folder) || !data?.ok || !Array.isArray(data.items)) return null;
  if (data.cwd && folder && !todoWorkspaceMatches(data.cwd, folder)) return null;
  latestWorkspaceFolder = folder;
  latestItems = data.items;
  if (listEl) renderList(data);
  return findItem(todoId);
}

/**
 * Open the Todo panel on one task.
 *
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export async function openTodo(id) {
  const item = await ensureTodoLoaded(id);
  if (!item) return false;
  showPanelFn('todo');
  openEditor(String(item.id));
  return true;
}

/**
 * Open the newest chat for a todo, or start an agent when none exists.
 *
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export async function continueTodo(id) {
  const item = await ensureTodoLoaded(id);
  if (!item) return false;
  openLatestTodoChat(item);
  return true;
}

/**
 * @param {string} id
 * @returns {Promise<{ id: string, title: string, status: string } | null>}
 */
export async function loadTodoSummary(id) {
  const item = await ensureTodoLoaded(id);
  return summarizeTodo(item);
}

function syncEditorItem() {
  if (!editorCard || !editorTodoId) return;
  const item = findItem(editorTodoId);
  if (!item) {
    closeEditor();
    return;
  }
  editorCard.item = item;
  editorCard.statusIcon = resolveTodoStatusIcon(item, latestItems, getChatsList(), getTerminalStateMetaPublic);
  editorCard.hasChildren = latestItems.some((row) => row.parentId === item.id);
}

function renderList(data) {
  const folder = getTodoWorkspaceFolder();
  if (data?.cwd && folder && !todoWorkspaceMatches(data.cwd, folder)) return;
  latestWorkspaceFolder = folder;
  if (!listEl) return;
  latestItems = Array.isArray(data?.items) ? data.items : [];
  const visibleItems = getVisibleTodoItems();
  if (!latestItems.length) {
    disposeAllRowMenus();
    listEl.innerHTML =
      '<div class="todo-empty-state">' +
      '<span class="todo-empty-icon mdi mdi-checkbox-marked-circle-outline" aria-hidden="true"></span>' +
      `<p class="todo-empty">${t('todo.none')}</p>` +
      '</div>';
    syncEditorItem();
    afterTodoRowsPainted();
    return;
  }
  if (!visibleItems.length) {
    disposeAllRowMenus();
    listEl.innerHTML =
      '<div class="todo-empty-state">' +
      '<span class="todo-empty-icon mdi mdi-filter-outline" aria-hidden="true"></span>' +
      `<p class="todo-empty">${t('todo.noneFiltered')}</p>` +
      '</div>';
    syncEditorItem();
    afterTodoRowsPainted();
    return;
  }
  applyCollapseDefaults(latestItems);
  const rows = flattenTodoTree(visibleItems, effectiveCollapsedIds());
  let wrapEl = listEl.querySelector('.todo-rows');
  if (!wrapEl) {
    listEl.innerHTML = '';
    wrapEl = document.createElement('div');
    wrapEl.className = 'todo-rows';
    wrapEl.setAttribute('role', 'tree');
    wrapEl.setAttribute('aria-label', t('todo.treeAria'));
    listEl.appendChild(wrapEl);
  }
  wrapEl.setAttribute('aria-label', t('todo.treeAria'));
  const existing = new Map(
    [...wrapEl.querySelectorAll('.todo-row')].map((row) => [String(row.dataset.id || ''), row])
  );
  const nextIds = new Set(rows.map((row) => String(row.item.id)));
  for (const [id, row] of existing) {
    if (nextIds.has(id)) continue;
    disposeRowMenu(row);
    row.remove();
    existing.delete(id);
  }
  rows.forEach((row, index) => {
    const id = String(row.item.id);
    let el = existing.get(id);
    if (!el) {
      el = createTodoRow();
      const before = wrapEl.children[index] || null;
      wrapEl.insertBefore(el, before);
    } else if (wrapEl.children[index] !== el) {
      wrapEl.insertBefore(el, wrapEl.children[index] || null);
    }
    paintTodoRow(el, row);
  });
  syncEditorItem();
  tryApplyPendingTodoViewMemory();
  scheduleTodoViewMemoryCapture();
  afterTodoRowsPainted();
}

/**
 * A list render may remove or filter out selected rows; drop them before the
 * bar computes its count so the request can never include a hidden id.
 */
function afterTodoRowsPainted() {
  if (batchSelectionMode) {
    const { eligibleIds } = currentBatchSelection();
    batchSelectedIds = pruneBatchSelection(batchSelectedIds, eligibleIds);
  }
  paintBatchActionBar();
}

function createTodoRow() {
  const row = document.createElement('div');
  row.className = 'todo-row';
  row.setAttribute('role', 'treeitem');
  row.innerHTML =
    '<cr-checkbox class="todo-row-select" hidden></cr-checkbox>' +
    '<button type="button" class="todo-row-grip" draggable="false">' +
    '<span class="mdi mdi-drag-vertical" aria-hidden="true"></span></button>' +
    '<button type="button" class="todo-row-toggle" hidden></button>' +
    '<button type="button" class="todo-row-main">' +
    '<span class="todo-item-status-icon" aria-hidden="true"></span>' +
    '<span class="todo-row-worktree-badge" role="img" hidden><span class="mdi mdi-source-branch" aria-hidden="true"></span></span>' +
    '<span class="todo-row-text">' +
    '<span class="todo-row-title"></span>' +
    '<span class="todo-row-meta" hidden></span>' +
    '<span class="todo-row-stage-host"></span>' +
    '</span>' +
    '<cr-todo-review-badge class="todo-row-review" hidden></cr-todo-review-badge>' +
    '<span class="todo-row-batch-badge" hidden></span>' +
    '<span class="todo-row-badge" hidden></span>' +
    '<span class="todo-row-mark" hidden></span>' +
    '</button>' +
    '<button type="button" class="todo-row-add">' +
    '<span class="mdi mdi-plus" aria-hidden="true"></span></button>' +
    '<button type="button" class="todo-row-menu" aria-haspopup="menu" aria-expanded="false">' +
    '<span class="mdi mdi-dots-vertical" aria-hidden="true"></span></button>';
  const grip = row.querySelector('.todo-row-grip');
  const toggle = row.querySelector('.todo-row-toggle');
  const main = row.querySelector('.todo-row-main');
  const add = row.querySelector('.todo-row-add');
  const menu = row.querySelector('.todo-row-menu');
  grip?.addEventListener('pointerdown', onGripPointerDown);
  grip?.addEventListener('pointermove', onGripPointerMove);
  grip?.addEventListener('pointerup', onGripPointerUp);
  grip?.addEventListener('pointercancel', onGripPointerUp);
  toggle?.addEventListener('click', onToggleClick);
  main?.addEventListener('click', onRowOpen);
  // Touch long-press enters bulk selection on an eligible row; a short tap still
  // opens the editor. Pointer events also cover the underlying mouse click.
  main?.addEventListener('pointerdown', onRowMainPointerDown);
  main?.addEventListener('pointermove', onRowMainPointerMove);
  main?.addEventListener('pointerup', onRowMainPointerUp);
  main?.addEventListener('pointercancel', onRowMainPointerUp);
  add?.addEventListener('click', onAddChildClick);
  menu?.addEventListener('click', onRowMenuClick);
  return row;
}

/**
 * Creates the row action menu on first open (portal to <body>, like other
 * Cretli dropdowns) and wires the shared dropdown controller for keyboard
 * support. The instance is destroyed again when it closes, so rows never
 * accumulate document-level listeners while idle.
 *
 * @param {HTMLElement} row
 * @returns {{ api: ReturnType<typeof initDropdown>, panel: HTMLElement, destroying: boolean } | null}
 */
function ensureRowMenu(row) {
  const existing = rowMenus.get(row);
  if (existing) return existing;
  const trigger = row.querySelector('.todo-row-menu');
  if (!(trigger instanceof HTMLButtonElement)) return null;
  const panel = document.createElement('div');
  panel.className = 'chat-list-modal todo-row-menu-panel';
  panel.hidden = true;
  const list = document.createElement('div');
  list.className = 'chat-list-panel todo-row-menu-list';
  list.setAttribute('role', 'menu');
  list.addEventListener('click', (event) => onRowMenuSelect(event, row));
  panel.appendChild(list);
  document.body.appendChild(panel);
  /** @type {{ api: ReturnType<typeof initDropdown>, panel: HTMLElement, destroying: boolean }} */
  const entry = {
    api: initDropdown({
      triggerEl: trigger,
      floatingEl: panel,
      compact: true,
      placement: 'bottom-end',
      minWidthPx: 210,
      maxHeightPx: 280,
      onOpen: () => renderRowMenuItems(row, list),
      // Escape must not strand focus inside the now-hidden panel.
      onClose: (reason) => {
        if (reason === 'escape') trigger.focus();
        // Lazy instance: drop it (and its document listeners) once closed.
        if (!entry.destroying) disposeRowMenu(row);
      },
    }),
    panel,
    destroying: false,
  };
  rowMenus.set(row, entry);
  return entry;
}

/**
 * Rebuilds the menu for the row's current item each time it opens, so labels
 * and disabled state follow the latest data and language.
 *
 * @param {HTMLElement} row
 * @param {HTMLElement} list
 */
function renderRowMenuItems(row, list) {
  const id = String(row.dataset.id || '');
  const item = findItem(id);
  if (!item) return;
  const chats = Array.isArray(item.chats) ? item.chats.filter((chat) => !chat.deleted) : [];
  const canAdd = canAddTodoChild(latestItems, id);
  // Ordered by lifecycle: plan -> execute -> integrate -> utilities -> delete.
  // `groupStart` draws a visual separator before the item.
  const actions = [
    // Per-todo orchestrator loop: refine -> approval gate -> implement -> integrate.
    {
      id: 'orchestratorFull',
      icon: 'mdi-robot-happy-outline',
      label: t('todo.orchestratorFull'),
      title: t('todo.orchestratorFullHint'),
      disabled: String(item.status || '') === 'done',
    },
    {
      id: 'refinePlan',
      icon: 'mdi-file-document-edit-outline',
      label: t('todo.refinePlan'),
      disabled: String(item.status || '') === 'done',
    },
    // Plan-review delegation (review_subject=plan), same path as the card's plan review button.
    { id: 'reviewPlanAgent', icon: 'mdi-robot-outline', label: t('todo.reviewPlanAgent') },
    { id: 'newChat', icon: 'mdi-robot-outline', label: t('todo.continueNewChat'), groupStart: true },
    // Code-review delegation (review_subject=code), same path as the card's code review button.
    { id: 'reviewCodeAgent', icon: 'mdi-robot-outline', label: t('todo.reviewCodeAgent') },
    // Only offered when the item's tree really owns an un-integrated worktree;
    // a permanently disabled row on every other task would be noise.
    ...(canIntegrateWorktree(item)
      ? [
        { id: 'integrate', icon: 'mdi-source-merge', label: t('todo.integrationMerge'), groupStart: true },
        { id: 'smartMerge', icon: 'mdi-robot-outline', label: t('todo.smartMerge') },
      ]
      : []),
    ...(canConfirmIntegrationFromMenu(item)
      ? [
        { id: 'verifyIntegration', icon: 'mdi-robot-outline', label: t('todo.verifyIntegration') },
        { id: 'confirmIntegration', icon: 'mdi-check-decagram-outline', label: t('todo.integrationConfirmMenu') },
      ]
      : []),
    {
      id: 'openChat',
      icon: 'mdi-chat-outline',
      label: t('todo.openLastChat'),
      disabled: chats.length === 0 && !item.chatId && !item.sourceChat?.id,
      groupStart: true,
    },
    { id: 'addChild', icon: 'mdi-plus', label: t('todo.addChild'), disabled: !canAdd },
    { id: 'move', icon: 'mdi-drag-vertical', label: t('todo.moveTask') },
    { id: 'copyId', icon: 'mdi-identifier', label: t('todo.copyId') },
    { id: 'copyRef', icon: 'mdi-link-variant', label: t('todo.copyRef') },
    { id: 'delete', icon: 'mdi-delete-outline', label: t('todo.delete'), danger: true, groupStart: true },
  ];
  list.textContent = '';
  actions.forEach((action) => {
    // Visual group boundary without adding a focusable item the dropdown
    // keyboard walk would trip over.
    if (action.groupStart) {
      const separator = document.createElement('div');
      separator.className = 'todo-row-menu-separator';
      separator.setAttribute('role', 'separator');
      list.appendChild(separator);
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className =
      'chat-list-item todo-row-menu-item' + (action.danger ? ' todo-row-menu-item--danger' : '');
    button.setAttribute('role', 'menuitem');
    button.dataset.action = action.id;
    button.disabled = action.disabled === true;
    const icon = document.createElement('span');
    icon.className = `mdi ${action.icon}`;
    icon.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'chat-list-item-title';
    label.textContent = action.label;
    button.append(icon, label);
    if (action.id === 'copyId') button.title = String(item.id || '');
    if (action.title) button.title = action.title;
    list.appendChild(button);
  });
}

/** @param {MouseEvent} event */
function onRowMenuClick(event) {
  const row = event.currentTarget instanceof Element ? event.currentTarget.closest('.todo-row') : null;
  if (!(row instanceof HTMLElement)) return;
  event.preventDefault();
  event.stopPropagation();
  const entry = ensureRowMenu(row);
  if (!entry) return;
  // Only one row menu at a time; toggle keeps the common open/close behavior.
  if (!entry.api.isOpen()) closeAllOpenDropdowns();
  entry.api.toggle();
}

/**
 * Opens the row action menu with ArrowDown. The dropdown instance is created
 * lazily on first open, so this single delegated listener on the list covers
 * the very first key press before any per-row controller exists. Once the
 * panel is open, navigation runs through the dropdown's own keydown handling.
 *
 * @param {KeyboardEvent} event
 */
function onRowMenuTriggerKeydown(event) {
  if (event.key !== 'ArrowDown') return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  const trigger = target.closest('.todo-row-menu');
  if (!(trigger instanceof HTMLButtonElement)) return;
  const row = trigger.closest('.todo-row');
  if (!(row instanceof HTMLElement)) return;
  // The live instance handles its own trigger once it exists.
  if (rowMenus.get(row)?.api.isOpen()) return;
  event.preventDefault();
  const entry = ensureRowMenu(row);
  if (!entry) return;
  entry.api.open();
  // Mirror the dropdown's ArrowDown-on-trigger behavior: enter at the top.
  requestAnimationFrame(() => {
    const first = entry.panel.querySelector('[role="menuitem"]:not([disabled])');
    if (first instanceof HTMLElement) first.focus();
  });
}

/**
 * @param {MouseEvent} event
 * @param {HTMLElement} row
 */
async function onRowMenuSelect(event, row) {
  const button = event.target instanceof Element ? event.target.closest('[data-action]') : null;
  if (!(button instanceof HTMLElement)) return;
  const action = String(button.dataset.action || '');
  rowMenus.get(row)?.api.close();
  // Selecting an item hides the panel; move focus back to the row trigger
  // instead of leaving it on a hidden menuitem.
  const trigger = row.querySelector('.todo-row-menu');
  if (trigger instanceof HTMLElement) trigger.focus();
  const id = String(row.dataset.id || '');
  const item = findItem(id);
  if (!item) return;
  if (action === 'move') {
    const wasMoving = row.classList.contains('todo-row--moving');
    listEl?.querySelectorAll('.todo-row--moving').forEach((entry) => entry.classList.remove('todo-row--moving'));
    if (!wasMoving) {
      row.classList.add('todo-row--moving');
      row.querySelector('.todo-row-grip')?.focus();
    }
    return;
  }
  await runRowMenuAction(action, item);
}

/**
 * @param {string} action
 * @param {object} item
 */
async function runRowMenuAction(action, item) {
  const id = String(item.id || '');
  if (!id) return;
  if (action === 'addChild') {
    if (!canAddTodoChild(latestItems, id)) {
      setStatus(t('todo.depthLimit'), true);
      return;
    }
    pendingParentId = id;
    openNewTodoModal();
    return;
  }
  if (action === 'copyId') {
    await copyTodoText(id, t('todo.copiedId'));
    return;
  }
  if (action === 'copyRef') {
    await copyTodoText(formatTodoRef(id), t('todo.copiedRef'));
    return;
  }
  if (action === 'openChat') {
    openLatestTodoChat(item);
    return;
  }
  if (action === 'newChat') {
    openTodoStartPicker(item);
    return;
  }
  if (action === 'orchestratorFull') {
    openTodoFullPicker(item);
    return;
  }
  if (action === 'refinePlan') {
    openTodoRefinePicker(item);
    return;
  }
  if (action === 'reviewPlanAgent') {
    onReviewStart({ detail: { id, subject: 'plan' } });
    return;
  }
  if (action === 'reviewCodeAgent') {
    onReviewStart({ detail: { id, subject: 'code' } });
    return;
  }
  if (action === 'integrate') {
    await mergeTodoWithWorkspace(item);
    return;
  }
  if (action === 'smartMerge') {
    openSmartMergePicker(item, []);
    return;
  }
  if (action === 'confirmIntegration') {
    await confirmTodoIntegrationFromMenu(item);
    return;
  }
  if (action === 'verifyIntegration') {
    openVerifyIntegrationPicker(item);
    return;
  }
  if (action === 'delete') {
    await deleteTodoWithConfirm(id);
  }
}

/**
 * The tree owns a live worktree (the server summary is keyed by the tree ROOT,
 * so every node of the tree reports it) and its result is not integrated yet.
 *
 * @param {object} item
 * @returns {boolean}
 */
function canIntegrateWorktree(item) {
  const summary = item?.worktree;
  if (summary?.live !== true) return false;
  return String(summary.integrationState || '') !== 'integrated';
}

/**
 * A finished todo with no live worktree has nothing to merge; the remaining
 * integration step is recording proof against the workspace branch.
 *
 * @param {object} item
 * @returns {boolean}
 */
function canConfirmIntegrationFromMenu(item) {
  if (String(item?.status || '') !== 'done') return false;
  if (canIntegrateWorktree(item) || isTodoAwaitingIntegration(item)) return false;
  return String(item?.integrationSummary?.state || 'unconfirmed') !== 'integrated';
}

/**
 * One-click confirmation: the server records the current workspace branch and
 * HEAD as proof, so the operator never types a commit SHA.
 *
 * @param {object} item
 */
async function confirmTodoIntegrationFromMenu(item) {
  const id = String(item?.id || '').trim();
  const revision = String(item?.updatedAt || '').trim();
  const ctx = getWorkspaceContext();
  if (!id || !revision || !ctx.workspaceFolder) return;
  if (!confirmAction(t('todo.integrationSimpleConfirm', { title: item.title || id }))) return;
  setStatus(t('todo.integrationSaving'));
  try {
    const result = await api.integrateTodo(id, ctx.workspaceFolder, 'confirm', revision, '', { simple: true });
    if (!result?.ok) {
      const message = integrationFailureMessage('confirm', result);
      setStatus(message, true);
      return;
    }
    await refreshTodoList();
    await refreshWatcherPanel();
    setStatus(t('todo.integrationConfirmed'));
  } catch {
    setStatus(t('todo.networkError'), true);
  }
}

/**
 * Agent variant of the confirmation: the agent verifies the task change is in the
 * workspace branch and records the integration proof itself.
 *
 * @param {object} item
 */
function openVerifyIntegrationPicker(item) {
  const id = String(item?.id || '').trim();
  if (!id) return;
  openTodoAgentStartModal({
    harness: resolveTodoStartHarness(item),
    onStart: ({ harness, model }) => runVerifyIntegration(id, { harness, model }),
  });
}

/**
 * @param {string} todoId
 * @param {{ harness: string, model: string }} options
 */
async function runVerifyIntegration(todoId, options) {
  const ctx = getWorkspaceContext();
  if (!ctx.workspaceFile || !ctx.workspaceFolder) {
    setStatus(t('todo.selectWorkspace'), true);
    return;
  }
  setStatus(t('todo.verifyIntegrationStarting'));
  try {
    const data = await api.verifyIntegrationTodo(todoId, ctx.workspaceFolder, {
      workspaceFile: ctx.workspaceFile,
      agentTransport: options.harness,
      model: String(options.model || 'auto'),
    });
    if (!data?.ok || !data.chat) {
      setStatus(t('todo.verifyIntegrationFailed'), true);
      return;
    }
    await refreshTodoList();
    openTodoAgentChat(data.chat, { initialPrompt: data.initialPrompt });
    showPanelFn('chat');
    setStatus(t('todo.verifyIntegrationStarted'));
  } catch {
    setStatus(t('todo.networkError'), true);
  }
}

/**
 * @param {string} action
 * @param {{ error?: string } | null | undefined} result
 * @returns {string}
 */
function integrationFailureMessage(action, result) {
  const error = String(result?.error || '');
  if (action === 'prepare') return t('todo.integrationPrepareFailed');
  if (error.startsWith('target_') || error === 'task_change_link_required' || error === 'full_commit_required') {
    return t('todo.integrationProofInvalid');
  }
  if (error === 'conflict' || error === 'integration_conflict') return t('todo.integrationConflict');
  return t('todo.integrationFailed');
}

/**
 * Explicit human integration from the row menu: apply the worktree result to the
 * logical workspace through the server's guarded three-way merge. The task stays
 * `doing` with `integration.state = ready`, so the card still offers
 * confirm/reject.
 *
 * @param {object} item
 */
async function mergeTodoWithWorkspace(item) {
  const id = String(item?.id || '').trim();
  const ctx = getWorkspaceContext();
  if (!id || !ctx.workspaceFolder) return;
  const ownerTodoId = String(item?.worktree?.ownerTodoId || id).trim();
  const branch = String(item?.worktree?.branch || '').trim() || t('todo.gitBadgeGeneric');
  if (!confirmAction(t('todo.integrationMergeConfirm', { branch }))) return;
  setStatus(t('todo.integrationMerging'));
  try {
    const result = await api.integrateTodo(id, ctx.workspaceFolder, 'merge', '');
    if (!result?.ok) {
      const conflicts = Array.isArray(result?.conflicts) ? result.conflicts.filter(Boolean) : [];
      const error = String(result?.error || '');
      const message = error === 'no_worktree'
        ? t('todo.integrationNoWorktree')
        : error === 'integration_conflict'
          ? t('todo.integrationMergeConflict', { paths: conflicts.join(', ') || '—' })
          : t('todo.integrationMergeFailed');
      setStatus(message, true);
      // A conflicting worktree is handed to an agent instead of dead-ending.
      if (error === 'integration_conflict' && confirmAction(t('todo.smartMergeOffer', { paths: conflicts.join(', ') || '—' }))) {
        openSmartMergePicker(item, conflicts);
      }
      return;
    }
    await refreshTodoList();
    await refreshWatcherPanel();
    openEditor(ownerTodoId);
    setStatus(result.alreadyApplied ? t('todo.integrationMergedAlready') : t('todo.integrationMerged'));
  } catch {
    setStatus(t('todo.networkError'), true);
  }
}

/**
 * Smart merge: pick an agent (harness + model) that merges the worktree result
 * into the workspace, commits only those task files, and records the integration
 * proof. The chat runs in the logical workspace, not in the worktree. It does
 * not push.
 *
 * @param {object} item
 * @param {string[]} conflicts
 */
function openSmartMergePicker(item, conflicts) {
  const id = String(item?.id || '').trim();
  if (!id) return;
  openTodoAgentStartModal({
    harness: resolveTodoStartHarness(item),
    onStart: ({ harness, model }) => runSmartMerge(id, { harness, model, conflicts }),
  });
}

/**
 * @param {string} todoId
 * @param {{ harness: string, model: string, conflicts: string[] }} options
 */
async function runSmartMerge(todoId, options) {
  const ctx = getWorkspaceContext();
  if (!ctx.workspaceFile || !ctx.workspaceFolder) {
    setStatus(t('todo.selectWorkspace'), true);
    return;
  }
  setStatus(t('todo.smartMergeStarting'));
  try {
    const data = await api.smartMergeTodo(todoId, ctx.workspaceFolder, {
      workspaceFile: ctx.workspaceFile,
      agentTransport: options.harness,
      model: String(options.model || 'auto'),
      conflicts: options.conflicts,
    });
    if (!data?.ok || !data.chat) {
      setStatus(data?.error === 'no_worktree' ? t('todo.integrationNoWorktree') : t('todo.smartMergeFailed'), true);
      return;
    }
    await refreshTodoList();
    openTodoAgentChat(data.chat, { initialPrompt: data.initialPrompt });
    showPanelFn('chat');
    setStatus(t('todo.smartMergeStarted'));
  } catch {
    setStatus(t('todo.networkError'), true);
  }
}

/**
 * Opens the newest non-deleted chat of a todo, falling back to chatId/sourceChat.
 *
 * @param {object} item
 */
function openLatestTodoChat(item) {
  const chats = Array.isArray(item?.chats) ? item.chats.filter((chat) => !chat.deleted) : [];
  const latest = chats[0] || null;
  const chatId = String(latest?.id || item?.chatId || item?.sourceChat?.id || '').trim();
  if (!chatId) {
    void startTodoAgent(String(item?.id || ''), {});
    return;
  }
  const agentTransport = String(latest?.harness || resolveTodoStartHarness(item)).trim();
  openTodoAgentChat(
    agentTransport ? { id: chatId, agentTransport } : { id: chatId },
    { reused: true }
  );
  showPanelFn('chat');
  setStatus(t('todo.openedLinkedChat'));
}

/**
 * Open the watcher's orchestrator chat from the top bar.
 *
 * @param {string} chatId
 */
function openWatcherChat(chatId) {
  const id = String(chatId || '').trim();
  if (!id) return;
  openTodoAgentChat({ id }, { reused: true });
  showPanelFn('chat');
}

/** @param {string} id */
async function deleteTodoWithConfirm(id) {
  if (!confirmAction(t('todo.confirmDelete'))) return;
  try {
    const data = await api.deleteTodo(id);
    if (!data?.ok) {
      setStatus(data?.error || t('todo.deleteError'), true);
      refreshTodoList();
      return;
    }
    if (editorTodoId === String(id)) closeEditor();
    setStatus(t('todo.deleted'));
    renderList(data);
  } catch {
    setStatus(t('todo.networkError'), true);
    refreshTodoList();
  }
}

/**
 * @param {HTMLElement} el
 * @param {{ item: object, level: number, hasChildren: boolean, collapsed: boolean }} row
 */
/** Re-paint queued/claimed badges after the watcher view changes without a full list fetch. */
export function repaintTodoRowBadges() {
  if (!listEl || !latestItems.length) return;
  const visibleItems = getVisibleTodoItems();
  if (!visibleItems.length) return;
  const rows = flattenTodoTree(visibleItems, effectiveCollapsedIds());
  const wrapEl = listEl.querySelector('.todo-rows');
  if (!wrapEl) return;
  const byId = new Map(rows.map((row) => [String(row.item.id), row]));
  wrapEl.querySelectorAll('.todo-row').forEach((el) => {
    const row = byId.get(String(el.dataset.id || ''));
    if (row) paintTodoRow(el, row);
  });
}

/** Update only the icon so live events preserve row controls and animation. */
function paintTodoStatusIcon(el, item) {
  const statusIcon = resolveTodoStatusIcon(item, latestItems, getChatsList(), getTerminalStateMetaPublic);
  const iconEl = el.querySelector('.todo-item-status-icon');
  if (iconEl) {
    const iconClass = `todo-item-status-icon mdi ${statusIcon.icon}${statusIcon.spinning ? ' mdi-spin' : ''}`;
    if (iconEl.className !== iconClass) iconEl.className = iconClass;
    iconEl.title = t(statusIcon.labelKey, { title: statusIcon.title });
  }
}

/**
 * Paint the review badge of one row. The element never changes the row height:
 * it is a single nowrap flex item with an ellipsis cap, and below 640px the
 * component collapses to the icon in CSS (the label stays in `title` /
 * `aria-label`).
 */
function paintTodoReviewBadge(el, row) {
  const badge = el.querySelector('.todo-row-review');
  if (!(badge instanceof HTMLElement)) return;
  const show = row.hasChildren
    ? !!resolveAggregateReviewBadge(row.item?.review)
    : shouldShowLeafReviewBadge(row.item);
  badge.hidden = !show;
  if (!show) return;
  // Property assignment only: Lit diffs the object, so an identical snapshot
  // re-renders nothing and a live refresh does not flicker rows.
  if (badge.item !== row.item) badge.item = row.item;
  if (badge.hasChildren !== !!row.hasChildren) badge.hasChildren = !!row.hasChildren;
}

/**
 * Repaints the stage stepper only when its derived view changed, so a live
 * refresh of hundreds of rows does not rebuild identical DOM.
 * @param {HTMLElement} el
 * @param {object} item
 */
function paintTodoStageStepper(el, item) {
  const host = el.querySelector('.todo-row-stage-host');
  if (!(host instanceof HTMLElement)) return;
  const view = buildTodoStageView(item);
  const key = view.steps.map((step) => `${step.id}:${step.state}:${step.hint}`).join('|') + `|${view.current}`;
  if (host.dataset.stageKey === key) return;
  host.dataset.stageKey = key;
  host.replaceChildren(createTodoStageStepperEl(item));
}

/** @param {HTMLElement} el @param {string} text */
function setTextIfChanged(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

/** @param {HTMLElement} el @param {string} key @param {string} value */
function setIfChanged(el, key, value) {
  if (el.dataset[key] !== value) el.dataset[key] = value;
}

/**
 * Row checkbox: visible only in selection mode and only on eligible rows. The
 * server's `batchEligibility.mode` decides eligibility, never the client.
 *
 * @param {HTMLElement} el
 * @param {object} item
 */
function paintTodoRowSelection(el, item) {
  const box = el.querySelector('.todo-row-select');
  if (!(box instanceof HTMLElement)) return;
  const selectable = isBatchSelectableItem(item);
  const visible = batchSelectionMode && selectable;
  // cr-checkbox `:host { display: inline-flex }` beats the UA `[hidden]` rule.
  setBatchControlVisible(box, visible);
  el.dataset.batchSelectable = selectable ? 'true' : 'false';
  const selected = visible && batchSelectedIds.has(String(item.id || ''));
  el.dataset.batchSelected = selected ? 'true' : 'false';
  if ('checked' in box && box.checked !== selected) box.checked = selected;
  if (visible) {
    const label = t('todo.batchSelectRow', { title: String(item.title || '') });
    box.setAttribute('aria-label', label);
    box.title = label;
  }
}

/**
 * Per-row badge mirroring the batch entry state (`queued`, `running`,
 * `awaiting_confirmation`, `merged`, `verified`, `failed`, `skipped`, `cancelled`).
 * The banner stays the place for reasons and actions.
 *
 * @param {HTMLElement} el
 * @param {object} item
 */
function paintTodoRowBatchBadge(el, item) {
  const badge = el.querySelector('.todo-row-batch-badge');
  if (!(badge instanceof HTMLElement)) return;
  const entry = activeBatch ? findBatchEntryForTodo(activeBatch, item?.id) : null;
  if (!entry) {
    badge.hidden = true;
    badge.textContent = '';
    badge.removeAttribute('data-batch-state');
    badge.removeAttribute('title');
    return;
  }
  const label = t(`todo.batchEntryState_${entry.state}`);
  badge.hidden = false;
  badge.textContent = label;
  badge.dataset.batchState = String(entry.state || '');
  const reason = entry.reason ? batchReasonText(entry.reason, 'entry') : '';
  const detail = reason ? `${label} · ${reason}` : label;
  badge.title = detail;
  badge.setAttribute('aria-label', detail);
}

function paintTodoRow(el, row) {
  const id = String(row.item.id || '');
  const status = String(row.item.status || 'idea');
  // Every write below is skipped when the value is unchanged: a full-list repaint
  // otherwise restyles and re-lays-out hundreds of rows for no visible change.
  setIfChanged(el, 'id', id);
  setIfChanged(el, 'status', status);
  const className = `todo-row todo-row--${status}`;
  if (el.className !== className) el.className = className;
  const levelText = String(row.level);
  if (el.style.getPropertyValue('--todo-level') !== levelText) el.style.setProperty('--todo-level', levelText);
  setIfChanged(el, 'level', levelText);
  if (el.getAttribute('aria-level') !== String(row.level + 1)) el.setAttribute('aria-level', String(row.level + 1));
  const toggle = el.querySelector('.todo-row-toggle');
  const title = el.querySelector('.todo-row-title');
  const worktreeBadge = el.querySelector('.todo-row-worktree-badge');
  const meta = el.querySelector('.todo-row-meta');
  const badge = el.querySelector('.todo-row-badge');
  const mark = el.querySelector('.todo-row-mark');
  const grip = el.querySelector('.todo-row-grip');
  const add = el.querySelector('.todo-row-add');
  const menu = el.querySelector('.todo-row-menu');
  const main = el.querySelector('.todo-row-main');
  paintTodoStatusIcon(el, row.item);
  paintTodoReviewBadge(el, row);
  paintTodoRowSelection(el, row.item);
  paintTodoRowBatchBadge(el, row.item);
  if (worktreeBadge instanceof HTMLElement) {
    const usesWorktree = row.item?.executionMode === 'worktree' || row.item?.worktree?.live === true;
    worktreeBadge.hidden = !usesWorktree;
    worktreeBadge.title = t('sidebar.worktreeTitle');
    worktreeBadge.setAttribute('aria-label', t('sidebar.worktreeTitle'));
  }
  if (title) setTextIfChanged(title, String(row.item.title || ''));
  if (grip instanceof HTMLElement) grip.setAttribute('aria-label', t('todo.dragHandle'));
  if (main instanceof HTMLElement) main.setAttribute('aria-label', t('todo.editTask'));
  if (menu instanceof HTMLElement) {
    menu.setAttribute('aria-label', t('todo.rowMenu'));
    menu.title = t('todo.rowMenu');
  }
  paintTodoStageStepper(el, row.item);
  const metaText = formatTodoMetaText(row.item);
  if (meta instanceof HTMLElement) {
    meta.hidden = !metaText;
    setTextIfChanged(meta, metaText);
  }
  if (toggle instanceof HTMLButtonElement) {
    toggle.hidden = !row.hasChildren;
    toggle.textContent = '';
    const icon = document.createElement('span');
    icon.className = `mdi ${row.collapsed ? 'mdi-chevron-right' : 'mdi-chevron-down'}`;
    icon.setAttribute('aria-hidden', 'true');
    toggle.appendChild(icon);
    toggle.setAttribute('aria-label', row.collapsed ? t('todo.expand') : t('todo.collapse'));
    if (row.hasChildren) el.setAttribute('aria-expanded', row.collapsed ? 'false' : 'true');
    else el.removeAttribute('aria-expanded');
  }
  const claimedBy = String(row.item?.claimedByChatId || '').trim();
  const isClaimed = !!claimedBy;
  const isQueued = !isClaimed && status === 'ready' && isWatcherAutopilot();
  const isIntegrationReady = isTodoAwaitingIntegration(row.item);
  // Applied to the working directory; target-branch proof is still required.
  const isIntegrationApplied = isIntegrationReady && !!String(row.item?.integration?.appliedAt || '').trim();
  const isSmartMerging = isIntegrationReady && String(row.item?.integration?.reason || '') === 'smart_merge_running';
  const integrationLabel = isSmartMerging
    ? t('todo.smartMergeRunningBadge')
    : isIntegrationApplied ? t('todo.integrationAppliedBadge') : t('todo.integrationReady');
  const assigneeBadge = formatTodoAssigneeBadge(row.item);
  let badgeFull = '';
  let badgeKind = '';
  if (isIntegrationReady) {
    badgeFull = integrationLabel;
    badgeKind = 'integration';
  } else if (isClaimed) {
    badgeFull = t('todo.claimedBy', { chat: claimedBy.slice(0, 8) });
    badgeKind = 'claimed';
  } else if (isQueued) {
    badgeFull = t('todo.queued');
    badgeKind = 'queued';
  } else {
    badgeFull = assigneeBadge;
  }
  if (badge instanceof HTMLElement) {
    const narrow = typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(max-width: 640px)').matches;
    const badgeText = narrow && !isClaimed && !isQueued && !isIntegrationReady
      ? String(row.item?.assignee?.harness || '').trim()
      : badgeFull;
    // The integration label is already shown by the row mark; do not repeat it.
    badge.hidden = !badgeText || isIntegrationReady;
    badge.textContent = badgeText;
    badge.dataset.kind = badgeKind;
    if (isClaimed) badge.title = t('todo.claimedBy', { chat: claimedBy });
    else if (badgeFull) badge.title = badgeFull;
    else badge.removeAttribute('title');
  }
  let markKind = readTodoRowMark(latestItems, row.item);
  if (isIntegrationReady) markKind = 'integration';
  if (mark instanceof HTMLElement) {
    mark.hidden = !markKind;
    const blockKind = markKind === 'blocked' ? readTodoRowBlockKind(latestItems, row.item) : '';
    mark.textContent = markKind === 'integration'
      ? integrationLabel
      : blockKind === 'action'
        ? t('todo.blockedAction')
        : blockKind === 'dependency'
          ? t('todo.blockedDependency')
          : markKind === 'blocked' ? t('todo.blocked') : t('todo.ready');
    mark.dataset.mark = markKind === 'integration' ? 'integration' : (blockKind ? `blocked-${blockKind}` : markKind);
    // Narrow rows show blocked marks as an icon; the text stays in aria-label/title.
    const iconOnly = (markKind === 'blocked' || markKind === 'integration') && typeof window !== 'undefined'
      && typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 640px)').matches;
    mark.dataset.label = mark.textContent;
    if (iconOnly) {
      mark.setAttribute('data-icon-only', '');
      mark.textContent = '';
      const markIcon = document.createElement('span');
      markIcon.className = `mdi ${markKind === 'integration' ? 'mdi-source-merge' : blockKind === 'dependency' ? 'mdi-timer-sand' : 'mdi-alert-circle-outline'}`;
      markIcon.setAttribute('aria-hidden', 'true');
      mark.appendChild(markIcon);
    } else {
      mark.removeAttribute('data-icon-only');
    }
    const blockedReason = String(row.item?.blockedReason || '').trim();
    const blockDetail = markKind === 'integration'
      ? (isSmartMerging ? t('todo.smartMergeRunningHint') : isIntegrationApplied ? t('todo.integrationWorkingDirectoryHint') : t('todo.integrationReadyHint'))
      : blockKind === 'action'
        ? blockedReason
        : blockKind === 'dependency' ? t('todo.blockedDependencyHint') : '';
    if (blockDetail) {
      mark.title = blockDetail;
      mark.setAttribute('aria-label', `${mark.dataset.label}: ${blockDetail}`);
    } else if (iconOnly) {
      mark.title = String(mark.dataset.label || '');
      mark.setAttribute('aria-label', String(mark.dataset.label || ''));
    } else {
      mark.removeAttribute('title');
      mark.removeAttribute('aria-label');
    }
  }
  if (add instanceof HTMLButtonElement) {
    const allowed = canAddTodoChild(latestItems, id);
    add.disabled = !allowed;
    add.setAttribute('aria-label', t('todo.addChild'));
    add.title = allowed ? t('todo.addChild') : t('todo.depthLimit');
  }
}

function clearDropMarks() {
  listEl?.querySelectorAll('.todo-row').forEach((row) => {
    row.classList.remove('todo-row--drop-before', 'todo-row--drop-after', 'todo-row--drop-nest');
  });
}

/** @param {PointerEvent} event */
function onGripPointerDown(event) {
  if (event.button !== 0) return;
  const row = event.currentTarget instanceof Element ? event.currentTarget.closest('.todo-row') : null;
  const id = String(row?.dataset.id || '');
  if (!id || !(event.currentTarget instanceof HTMLElement)) return;
  event.preventDefault();
  event.currentTarget.setPointerCapture(event.pointerId);
  dragState = { id, pointerId: event.pointerId, targetId: '', zone: '' };
  row.classList.add('todo-row--dragging');
}

/** @param {PointerEvent} event */
function onGripPointerMove(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) return;
  const hit = document.elementFromPoint(event.clientX, event.clientY);
  const row = hit instanceof Element ? hit.closest('.todo-row') : null;
  clearDropMarks();
  dragState.targetId = '';
  dragState.zone = '';
  if (!(row instanceof HTMLElement) || row.dataset.id === dragState.id) return;
  const rect = row.getBoundingClientRect();
  const ratio = (event.clientY - rect.top) / Math.max(rect.height, 1);
  const zone = todoDropZoneFromRatio(ratio);
  dragState.targetId = String(row.dataset.id || '');
  dragState.zone = zone;
  row.classList.add(`todo-row--drop-${zone}`);
}

/** @param {PointerEvent} event */
function onGripPointerUp(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) return;
  const move = dragState;
  dragState = null;
  clearDropMarks();
  listEl?.querySelectorAll('.todo-row--dragging').forEach((row) => {
    row.classList.remove('todo-row--dragging', 'todo-row--moving');
    row.querySelector('.todo-row-menu')?.focus();
  });
  if (!move.targetId || !move.zone) return;
  const decision = resolveTodoDrop({
    items: latestItems,
    draggedId: move.id,
    targetId: move.targetId,
    zone: move.zone,
  });
  if (!decision.ok) {
    if (decision.reason !== 'noop' && decision.reason !== 'self') {
      setStatus(t('todo.dropRejected'), true);
    }
    return;
  }
  void patchMove(move.id, decision.parentId, decision.siblingIndex);
}

/** @param {MouseEvent} event */
function onToggleClick(event) {
  event.preventDefault();
  event.stopPropagation();
  const row = event.currentTarget instanceof Element ? event.currentTarget.closest('.todo-row') : null;
  const id = String(row?.dataset.id || '');
  if (!id) return;
  if (collapsedIds.has(id)) collapsedIds.delete(id);
  else collapsedIds.add(id);
  saveCollapsed();
  renderList({ items: latestItems });
  scheduleTodoViewMemoryCapture();
}

/** @param {MouseEvent} event */
function onRowOpen(event) {
  const row = event.currentTarget instanceof Element ? event.currentTarget.closest('.todo-row') : null;
  const id = String(row?.dataset.id || '');
  if (!id) return;
  if (suppressRowOpenAfterLongPress) {
    // The long-press already entered selection mode and selected this row.
    suppressRowOpenAfterLongPress = false;
    return;
  }
  if (batchSelectionMode) {
    toggleRowBatchSelection(id);
    return;
  }
  openEditor(id);
}

/** @param {MouseEvent} event */
function onAddChildClick(event) {
  event.preventDefault();
  event.stopPropagation();
  const row = event.currentTarget instanceof Element ? event.currentTarget.closest('.todo-row') : null;
  const id = String(row?.dataset.id || '');
  if (!id) return;
  if (!canAddTodoChild(latestItems, id)) {
    setStatus(t('todo.depthLimit'), true);
    return;
  }
  pendingParentId = id;
  openNewTodoModal();
}

/**
 * @param {string} id
 * @param {string | null} parentId
 * @param {number} siblingIndex
 */
async function patchMove(id, parentId, siblingIndex) {
  try {
    const data = await api.patchTodo(id, { parentId, siblingIndex });
    if (!data?.ok) {
      setStatus(data?.error || t('todo.saveError'), true);
      refreshTodoList();
      return;
    }
    setStatus(t('todo.saved'));
    renderList(data);
  } catch {
    setStatus(t('todo.networkError'), true);
    refreshTodoList();
  }
}

function ensureEditor() {
  if (editorDialog) return;
  const dialog = document.createElement('cr-dialog');
  dialog.className = 'todo-editor-dialog';
  dialog.closable = true;
  dialog.closeLabel = t('todo.closeEditor');
  dialog.style.setProperty('--cr-dialog-max-width', '40rem');
  const wrap = document.createElement('div');
  wrap.className = 'todo-editor';
  const card = document.createElement('cr-todo-card');
  card.className = 'todo-card';
  bindCardHandlers(card);
  wrap.appendChild(card);
  dialog.appendChild(wrap);
  dialog.addEventListener('cr-dialog-close', () => {
    editorTodoId = '';
    editorTabTodoId = '';
  });
  document.body.appendChild(dialog);
  editorDialog = dialog;
  editorCard = card;
}

function openEditor(id) {
  const item = findItem(id);
  if (!item) return;
  ensureEditor();
  if (!editorDialog || !editorCard) return;
  editorTodoId = id;
  editorDialog.heading = t('todo.editTask');
  editorCard.item = item;
  editorCard.statusIcon = resolveTodoStatusIcon(item, latestItems, getChatsList(), getTerminalStateMetaPublic);
  editorCard.recoveryState = findTodoRecoveryState(getWatcherView(), id);
  editorCard.hasChildren = latestItems.some((row) => row.parentId === item.id);
  editorCard.newChatHarness = '';
  editorCard.bodyPreview = false;
  // A different todo always starts on its plan (or notes when it has none);
  // re-renders of the same todo (renderList/syncEditorItem) keep the user's tab
  // and drafts.
  if (editorTabTodoId !== id) {
    editorTabTodoId = id;
    const hasPlan = typeof item.plan?.markdown === 'string' && item.plan.markdown.trim() !== '';
    editorCard.activeTab = hasPlan ? 'plan' : 'notes';
  }
  editorDialog.show();
  // The card rendered while the dialog was hidden, so auto-grow saw a
  // zero-height control; recompute once it has been laid out.
  requestAnimationFrame(() => {
    editorCard?.querySelectorAll('cr-bar-textarea').forEach((el) => {
      if (el instanceof HTMLElement && 'refreshAutoGrow' in el) el.refreshAutoGrow();
    });
  });
  // A preview rendered before markdown-it loads shows escaped text; re-render
  // the card once the shared renderer is ready.
  void preloadMarkdown().then(() => editorCard?.requestUpdate());
}

function closeEditor() {
  editorTodoId = '';
  editorTabTodoId = '';
  editorDialog?.hide();
}

function sameAssignee(item, assignee) {
  const current = item?.assignee && typeof item.assignee === 'object' ? item.assignee : null;
  if (!assignee && !current?.harness) return true;
  if (!assignee || !current) return false;
  return current.harness === assignee.harness
    && current.role === assignee.role
    && String(current.model || '') === String(assignee.model || '');
}

/**
 * Settings PATCHes run one at a time, so a later response can never roll the
 * form back to an older assignee (model blur followed by a harness change).
 *
 * @type {Promise<void>}
 */
let editorSaveQueue = Promise.resolve();

/** @param {() => Promise<void>} task */
function queueEditorSave(task) {
  editorSaveQueue = editorSaveQueue.then(task, task);
  return editorSaveQueue;
}

/** @param {object | null} assignee */
function saveEditorAssignee(assignee) {
  const todoId = editorTodoId;
  if (!todoId) return Promise.resolve();
  return queueEditorSave(() => patchEditorAssignee(todoId, assignee));
}

/**
 * @param {string} todoId
 * @param {object | null} assignee
 */
async function patchEditorAssignee(todoId, assignee) {
  if (sameAssignee(findItem(todoId), assignee)) return;
  try {
    const data = await api.patchTodo(todoId, { assignee });
    if (!data?.ok) {
      setStatus(data?.error || t('todo.saveError'), true);
      return;
    }
    setStatus(t('todo.saved'));
    renderList(data);
  } catch {
    setStatus(t('todo.networkError'), true);
  }
}

/** @param {Event} e */
function onEditorAssigneeChange(e) {
  const assignee = e?.detail?.assignee && typeof e.detail.assignee === 'object' ? e.detail.assignee : null;
  void saveEditorAssignee(assignee);
}

/** @param {string} runMode */
function saveEditorRunMode(runMode) {
  const todoId = editorTodoId;
  if (!todoId) return Promise.resolve();
  return queueEditorSave(() => patchEditorRunMode(todoId, runMode));
}

/**
 * @param {string} todoId
 * @param {string} runMode
 */
async function patchEditorRunMode(todoId, runMode) {
  const next = runMode === 'sequential' ? 'sequential' : 'parallel';
  const current = findItem(todoId)?.runMode === 'parallel' ? 'parallel' : 'sequential';
  if (current === next) return;
  try {
    const data = await api.patchTodo(todoId, { runMode: next });
    if (!data?.ok) {
      setStatus(data?.error || t('todo.saveError'), true);
      return;
    }
    setStatus(t('todo.saved'));
    renderList(data);
  } catch {
    setStatus(t('todo.networkError'), true);
  }
}

/** @param {Event} e */
function onEditorRunModeChange(e) {
  void saveEditorRunMode(e?.detail?.runMode);
}

/** @param {string} executionMode */
function saveEditorExecutionMode(executionMode) {
  const todoId = editorTodoId;
  if (!todoId) return Promise.resolve();
  return queueEditorSave(() => patchEditorExecutionMode(todoId, executionMode));
}

/**
 * @param {string} todoId
 * @param {string} executionMode
 */
async function patchEditorExecutionMode(todoId, executionMode) {
  const allowed = ['inherit', 'worktree', 'project'];
  const next = allowed.includes(executionMode) ? executionMode : 'inherit';
  const current = ['worktree', 'project'].includes(findItem(todoId)?.executionMode)
    ? findItem(todoId).executionMode
    : 'inherit';
  if (current === next) return;
  try {
    const data = await api.patchTodo(todoId, { executionMode: next });
    if (!data?.ok) {
      setStatus(data?.error || t('todo.saveError'), true);
      return;
    }
    setStatus(t('todo.saved'));
    renderList(data);
  } catch {
    setStatus(t('todo.networkError'), true);
  }
}

/** @param {Event} e */
function onEditorExecutionModeChange(e) {
  void saveEditorExecutionMode(e?.detail?.executionMode);
}

/** @param {Event} e */
function onOpenChat(e) {
  const chatId = String(e?.detail?.chatId || '').trim();
  if (!chatId) {
    void onStartAgent(e);
    return;
  }
  const agentTransport = String(e?.detail?.agentTransport || '').trim();
  openTodoAgentChat(
    agentTransport ? { id: chatId, agentTransport } : { id: chatId },
    { reused: true }
  );
  showPanelFn('chat');
  setStatus(t('todo.openedLinkedChat'));
}

/** Opens the worktree list scoped to one task via the Git route. */
function onOpenGit(e) {
  const id = String(e?.detail?.id || '').trim();
  if (!id) return;
  void navigateSpa({
    panel: 'git',
    subview: 'worktrees',
    scope: 'todo',
    resource: { type: 'todo', id },
    query: { todo: id },
  }, { explicit: true });
}

/** @param {Event} e */
async function onStartAgent(e) {
  const id = e?.detail?.id;
  if (!id) return;
  const forceNew = e?.detail?.forceNew === true;
  if (forceNew) {
    openTodoStartPicker(e.target instanceof Element ? e.target.closest('cr-todo-card')?.item || findItem(String(id)) : findItem(String(id)));
    return;
  }
  const agentTransport = String(e?.detail?.agentTransport || '').trim();
  const cardEl = e.target instanceof Element ? e.target.closest('cr-todo-card') : null;
  const btnEl = cardEl?.querySelector(forceNew ? '.todo-item-newchat' : '.todo-item-agent');
  const setBtnDisabled = (disabled) => {
    if (btnEl instanceof HTMLElement && 'disabled' in btnEl) btnEl.disabled = disabled;
  };
  setBtnDisabled(true);
  try {
    await startTodoAgent(String(id), {
      forceNew,
      agentTransport,
      item: cardEl?.item || null,
    });
  } finally {
    setBtnDisabled(false);
  }
}

/** Open the shared harness and model picker before creating a fresh TODO chat. */
function openTodoStartPicker(item) {
  if (!item?.id) return;
  const harness = resolveTodoStartHarness(item);
  openTodoAgentStartModal({
    harness,
    onStart: ({ harness: selectedHarness, model }) => startTodoAgent(String(item.id), {
      forceNew: true,
      agentTransport: selectedHarness,
      model,
      item,
    }),
  });
}

/**
 * Pick harness and model for the "do everything" orchestrator chat. The server
 * records it as the root's orchestrator chat; a human still approves the plan.
 * Stop it by cancelling that chat's run (chat WebSocket `{ type: 'cancel' }`,
 * the same path as the chat stop button) and its children through
 * `POST /api/delegations/:id/cancel` with `tree: true`.
 */
function openTodoFullPicker(item) {
  if (!item?.id || String(item.status || '') === 'done') return;
  openTodoAgentStartModal({
    harness: resolveTodoStartHarness(item),
    onStart: ({ harness, model }) => startTodoAgent(String(item.id), {
      mode: 'full',
      forceNew: true,
      agentTransport: harness,
      model,
      item,
    }),
  });
}

/**
 * Pick harness and model for a chat that runs the plan review-and-refine loop
 * (`cretli-todo-refine-loop` skill). The chat is linked to the todo but does not
 * become its executor chat and does not change its status.
 */
function openTodoRefinePicker(item) {
  if (!item?.id || String(item.status || '') === 'done') return;
  openTodoAgentStartModal({
    harness: resolveTodoStartHarness(item),
    planReviewerCooperationMode: true,
    onStart: ({ harness, model, planReviewerCooperationMode }) => startTodoAgent(String(item.id), {
      mode: 'refine',
      forceNew: true,
      agentTransport: harness,
      model,
      item,
      planReviewerCooperationMode,
    }),
  });
}

/** Review button on the card: the shared picker chooses harness and model of the reviewer chat. */
function onReviewStart(e) {
  const id = String(e?.detail?.id || '').trim();
  const subject = e?.detail?.subject === 'plan' ? 'plan' : 'code';
  const item = findItem(id);
  if (!item?.id) return;
  if (!resolveTodoReviewParentChatId(item)) {
    setStatus(t('todo.reviewStartNoChat'), true);
    return;
  }
  openTodoAgentStartModal({
    harness: resolveTodoStartHarness(item),
    onStart: ({ harness, model }) => startTodoReview(item, subject, harness, model),
  });
}

/**
 * Starts a review delegation of one subject for the todo. The reviewer runs in its
 * own new chat; the server attaches its verdict to the todo's review block.
 *
 * @param {object} item
 * @param {'code'|'plan'} subject
 * @param {string} harness
 * @param {string} model
 */
async function startTodoReview(item, subject, harness, model) {
  const todoId = String(item.id);
  setStatus(t('todo.reviewStarting'));
  try {
    const data = await api.postManualChatDelegation(resolveTodoReviewParentChatId(item), {
      executor: { transport: harness, model },
      idempotencyKey: `todo-review:${todoId}:${subject}:${Date.now()}:${Math.random().toString(16).slice(2)}`,
      sourceKind: 'text',
      taskText: buildTodoReviewTaskText(item, subject),
      title: `${String(item.title || '').trim()} (review ${subject})`,
      assignment: 'review',
      reviewSubject: subject,
      leafId: todoId,
    });
    if (!data?.ok) {
      setStatus(data?.error || t('todo.reviewStartFailed'), true);
      return;
    }
    setStatus(t('todo.reviewStarted'));
  } catch {
    setStatus(t('todo.networkError'), true);
  }
}

/**
 * Opens the linked chat or creates one. `forceNew` always creates a fresh chat
 * and keeps the previous one in the todo history.
 *
 * @param {string} id
 * @param {{ forceNew?: boolean, agentTransport?: string, model?: string, item?: object | null }} [options]
 */
async function startTodoAgent(id, options = {}) {
  const todoId = String(id || '').trim();
  if (!todoId) return;
  // The row menu and the card button can both fire; never create two chats for
  // the same todo while the first request is in flight.
  if (startAgentInFlight.has(todoId)) return;
  startAgentInFlight.add(todoId);
  try {
    await startTodoAgentOnce(todoId, options);
  } finally {
    startAgentInFlight.delete(todoId);
  }
}

/**
 * @param {string} todoId
 * @param {{
 *   forceNew?: boolean,
 *   mode?: 'refine' | 'full',
 *   agentTransport?: string,
 *   model?: string,
 *   item?: object | null,
 *   planReviewerCooperationMode?: string,
 * }} [options]
 */
async function startTodoAgentOnce(todoId, options = {}) {
  const forceNew = options.forceNew === true;
  const refine = options.mode === 'refine';
  const item = options.item || findItem(todoId) || {};
  const ctx = getWorkspaceContext();
  if (!ctx.workspaceFile || !ctx.workspaceFolder) {
    setStatus(t('todo.selectWorkspace'), true);
    return;
  }
  const harness = String(options.agentTransport || resolveTodoStartHarness(item)).trim();
  // The server only reuses `todo.chatId`; sourceChat/plan links do not count.
  const willCreate = forceNew || !item.chatId;
  if (willCreate && harness === 'sdk' && !sdkReady) {
    setStatus(t('todo.sdkRequiresApiKey'), true);
    return;
  }
  if (forceNew && !refine && String(item.status || '') === 'done' && !confirmAction(t('todo.confirmStartDone'))) {
    return;
  }
  setStatus(t('todo.creatingAgent'));
  const payload = {
    workspaceFile: ctx.workspaceFile,
    workspaceFolder: ctx.workspaceFolder,
    model: String(options.model || 'auto'),
    agentTransport: harness,
    ...(options.dirtyPolicy ? { dirtyPolicy: options.dirtyPolicy } : {}),
  };
  if (forceNew) payload.forceNew = true;
  // Continuing in a fresh chat runs the executor, never a plan-mode draft.
  if (forceNew && !refine) payload.sdkMode = 'agent';
  if (refine) payload.mode = 'refine';
  if (options.mode === 'full') payload.mode = 'full';
  if (refine && options.planReviewerCooperationMode) {
    payload.cooperationMode = options.planReviewerCooperationMode;
  }
  try {
    let data = await api.postTodoStartAgent(todoId, payload);
    if (data?.ok && data.state === 'preparing') {
      // Worktree prepare can take minutes; the server answered 202 and the UI
      // polls until the chat exists (D4).
      setStatus(t('todo.worktreePreparing'));
      data = await pollTodoStartAgentStatus(todoId, ctx.workspaceFolder, forceNew);
    }
    if (!data?.ok || !data.chat) {
      if (data?.code === 'WORKTREE_DIRTY' && Array.isArray(data.details?.dirtyPaths)) {
        const choice = await chooseDirtyWorktreePolicy(data.details.dirtyPaths);
        if (choice) return startTodoAgentOnce(todoId, { ...options, dirtyPolicy: choice });
      }
      setStatus(data?.error || t('todo.startAgentFailed'), true,
        data?.code === 'WORKTREE_PREPARE_FAILED' ? data.details || {} : null);
      return;
    }
    renderList(data);
    openTodoAgentChat(data.chat, {
      initialPrompt: data.initialPrompt,
      reused: !!data.reused,
    });
    showPanelFn('chat');
    setStatus(refine ? t('todo.refinePlanStarted') : data.reused ? t('todo.openedLinkedChat') : t('todo.startedAgent'));
  } catch {
    setStatus(t('todo.networkError'), true);
  }
}

/**
 * Voice entry point for starting a todo agent. Uses the same API call, prepare
 * polling and chat opening as `startTodoAgentOnce`, but never opens a dialog:
 * a dirty worktree or a missing SDK key is reported back as a short error.
 * `ok: true` means the chat was opened and its initial prompt was handed over.
 *
 * @param {string} todoId
 * @param {{ agentTransport?: string, workspaceFile: string, workspaceFolder: string }} options
 * @returns {Promise<{ ok: boolean, error?: string, code?: string }>}
 */
export async function startTodoAgentForVoice(todoId, options) {
  return startTodoForVoice(todoId, options, {
    findItem,
    resolveHarness: (item) => resolveTodoStartHarness(item),
    isSdkReady: () => sdkReady,
    startAgent: (id, body) => api.postTodoStartAgent(id, body),
    pollStatus: (id, workspaceFolder) => pollTodoStartAgentStatus(id, workspaceFolder, false),
    renderList,
    openChat: openTodoAgentChat,
    showChatPanel: () => showPanelFn('chat'),
    messages: {
      sdkRequiresApiKey: t('todo.sdkRequiresApiKey'),
      startFailed: t('todo.startAgentFailed'),
      networkError: t('todo.networkError'),
    },
  });
}

/** Show full TODO errors and optional prepare output as text in one scrollable dialog. */
function showTodoError(message, prepareDetails = null) {
  const dialog = errorDialog || document.createElement('cr-dialog');
  dialog.heading = t(prepareDetails ? 'todo.worktreePrepareErrorTitle' : 'todo.error');
  dialog.variant = 'error';
  dialog.closable = true;
  dialog.closeLabel = t('settings.close');
  dialog.style.setProperty('--cr-dialog-max-width', '48rem');
  const content = document.createElement('div');
  content.style.cssText = 'max-height: 60dvh; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere;';
  const messageBlock = document.createElement('p');
  messageBlock.textContent = message;
  messageBlock.style.color = 'var(--cr-error)';
  messageBlock.setAttribute('role', 'alert');
  content.appendChild(messageBlock);
  if (prepareDetails) {
    const details = prepareDetails;
    const addRow = (label, value) => {
      if (!value) return;
      const row = document.createElement('p');
      const heading = document.createElement('strong');
      heading.textContent = `${label}: `;
      const text = document.createElement('code');
      text.textContent = value;
      text.style.overflowWrap = 'anywhere';
      row.append(heading, text);
      content.appendChild(row);
    };
    const command = Array.isArray(details.command) ? details.command.map(String) : [];
    if (details.stage === 'preflight') addRow(t('todo.worktreePrepareStage'), t('todo.worktreePreparePreflight'));
    addRow(t('todo.worktreePrepareCommand'), command.length ? JSON.stringify(command) : '—');
    addRow(t('todo.worktreePrepareDirectory'), String(details.cwd || ''));
    addRow(t('todo.worktreePrepareExit'), [details.exitCode, details.signal].filter(Boolean).join(' / '));
    const output = [
      details.stderr ? `stderr:\n${details.stderr}` : '',
      details.stdout ? `stdout:\n${details.stdout}` : '',
    ].filter(Boolean).join('\n\n') || t('todo.worktreePrepareNoOutput');
    const outputLabel = document.createElement('strong');
    outputLabel.textContent = t('todo.worktreePrepareOutput');
    const outputBlock = document.createElement('pre');
    outputBlock.textContent = output;
    outputBlock.style.cssText = 'max-height: 18rem; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere;';
    content.append(outputLabel, outputBlock);
  }
  dialog.replaceChildren(content);
  const actions = document.createElement('div');
  actions.setAttribute('slot', 'actions');
  const close = document.createElement('cr-bar-button');
  close.textContent = t('settings.close');
  close.addEventListener('click', () => dialog.hide(), { once: true });
  actions.appendChild(close);
  dialog.appendChild(actions);
  if (!errorDialog) {
    document.body.appendChild(dialog);
    errorDialog = dialog;
    dialog.addEventListener('cr-dialog-close', () => {
      dialog.remove();
      errorDialog = null;
    }, { once: true });
  }
  if (!dialog.open) dialog.show();
}

/** Ask the operator how to handle a dirty logical worktree before retrying. */
function chooseDirtyWorktreePolicy(paths) {
  return new Promise((resolve) => {
    const dialog = document.createElement('cr-dialog');
    dialog.heading = t('todo.worktreeDirtyChoiceTitle');
    dialog.style.setProperty('--cr-dialog-max-width', '42rem');
    const content = document.createElement('div');
    const description = document.createElement('p');
    description.textContent = t('todo.worktreeDirtyChoiceHint');
    const list = document.createElement('pre');
    list.textContent = paths.map((file) => String(file)).join('\n');
    list.style.cssText = 'max-height: 12rem; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere;';
    content.append(description, list);
    dialog.appendChild(content);
    const actions = document.createElement('div');
    actions.setAttribute('slot', 'actions');
    const addAction = (label, value) => {
      const button = document.createElement('cr-bar-button');
      button.textContent = label;
      button.addEventListener('click', () => { dialog.remove(); resolve(value); }, { once: true });
      actions.appendChild(button);
    };
    addAction(t('todo.worktreeDirtyCommit'), null);
    addAction(t('todo.worktreeDirtyHead'), 'head');
    addAction(t('todo.worktreeDirtySnapshot'), 'snapshot');
    dialog.appendChild(actions);
    dialog.addEventListener('cr-dialog-close', () => { dialog.remove(); resolve(null); }, { once: true });
    document.body.appendChild(dialog);
    dialog.show();
  });
}

/** How long the UI waits for a 202 worktree prepare before giving up. */
const TODO_START_POLL_TIMEOUT_MS = 11 * 60 * 1000;
const TODO_START_POLL_INTERVAL_MS = 2000;

/**
 * @param {string} todoId
 * @param {string} workspaceFolder
 * @param {boolean} forceNew
 * @returns {Promise<object>}
 */
async function pollTodoStartAgentStatus(todoId, workspaceFolder, forceNew) {
  const deadline = Date.now() + TODO_START_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, TODO_START_POLL_INTERVAL_MS));
    let status;
    try {
      status = await api.getTodoStartAgentStatus(todoId, workspaceFolder, forceNew);
    } catch {
      continue;
    }
    if (!status || status.state === 'preparing') continue;
    if (status.state === 'idle') return { ok: false, error: t('todo.startAgentFailed') };
    return status;
  }
  return { ok: false, error: t('todo.startAgentFailed') };
}

/** @param {Event} e */
async function onStatusChange(e) {
  const id = e?.detail?.id;
  if (!id) return;
  const status = e.detail?.status || e.detail?.value;
  if (!status) return;
  try {
    setEditorSaveState('saving', t('todo.saving'));
    const data = await api.patchTodo(id, { status });
    if (!data?.ok) {
      setStatus(data?.error || t('todo.saveError'), true);
      refreshTodoList();
      return;
    }
    setStatus(t('todo.saved'));
    renderList(data);
  } catch {
    setStatus(t('todo.networkError'), true);
    refreshTodoList();
  }
}

/** @param {Event} e */
async function onTitleBlur(e) {
  const id = e?.detail?.id;
  if (!id) return;
  const title = String(e?.detail?.title || '').trim();
  if (!title) {
    setStatus(t('todo.titleRequired'), true);
    refreshTodoList();
    return;
  }
  try {
    setEditorSaveState('saving', t('todo.saving'));
    const data = await api.patchTodo(id, { title });
    if (!data?.ok) {
      setStatus(data?.error || t('todo.saveError'), true);
      refreshTodoList();
      return;
    }
    setStatus(t('todo.saved'));
    renderList(data);
  } catch {
    setStatus(t('todo.networkError'), true);
    refreshTodoList();
  }
}

/** @param {Event} e */
async function onBodyBlur(e) {
  const id = e?.detail?.id;
  if (!id) return;
  const body = String(e?.detail?.body || '');
  try {
    setEditorSaveState('saving', t('todo.saving'));
    const data = await api.patchTodo(id, { body });
    if (!data?.ok) {
      setStatus(data?.error || t('todo.saveError'), true);
      refreshTodoList();
      return;
    }
    setStatus(t('todo.saved'));
    renderList(data);
  } catch {
    setStatus(t('todo.networkError'), true);
    refreshTodoList();
  }
}

/** @param {Event} e */
async function onPlanApprove(e) {
  const id = String(e?.detail?.id || '').trim();
  const updatedAt = String(e?.detail?.updatedAt || '').trim();
  if (!id) return;
  try {
    const data = await api.patchTodo(id, {
      plan: { approvedAt: new Date().toISOString() },
      expectedUpdatedAt: updatedAt || undefined,
    });
    if (!data?.ok) {
      setStatus(data?.error || t('todo.planApproveError'), true);
      refreshTodoList();
      return;
    }
    setStatus(t('todo.planApproved'));
    renderList(data);
  } catch {
    setStatus(t('todo.planApproveError'), true);
    refreshTodoList();
  }
}

/** @param {Event} e */
async function onDelete(e) {
  const id = e?.detail?.id;
  if (!id) return;
  await deleteTodoWithConfirm(String(id));
}

function resetTodoWorkspaceView() {
  if (todoWorkspaceMatches(latestWorkspaceFolder)) return;
  closeEditor();
  pendingParentId = '';
  document.getElementById('todo-new-modal')?.setAttribute('hidden', '');
  disposeAllRowMenus();
  latestItems = [];
  latestWorkspaceFolder = getTodoWorkspaceFolder();
  if (listEl) listEl.textContent = '';
  if (hintEl) {
    hintEl.textContent = '';
    hintEl.hidden = true;
  }
  resetBatchWorkspaceView();
  setStatus('');
}

function onTodoWorkspaceChange() {
  resetTodoWorkspaceView();
  if (document.getElementById('todo-panel')?.classList.contains('active')) {
    return refreshTodoList();
  }
}

/**
 * One refresher per panel: server `todo.review` frames and reconnects collapse
 * into a single debounced list fetch. It renders through `renderList`, which
 * diffs rows in place, so an unchanged snapshot repaints nothing.
 */
/** @type {ReturnType<typeof createTodoReviewRefresher> | null} */
let reviewRefresher = null;

function getReviewRefresher() {
  if (reviewRefresher) return reviewRefresher;
  reviewRefresher = createTodoReviewRefresher({
    debounceMs: REVIEW_REFRESH_DEBOUNCE_MS,
    isActive: () => !!document.getElementById('todo-panel')?.classList.contains('active'),
    load: async () => {
      const folder = getTodoWorkspaceFolder();
      const generation = refreshGeneration;
      const data = await api.getTodos(folder);
      // A newer full refresh or a workspace switch owns the list now.
      if (generation !== refreshGeneration || !todoWorkspaceMatches(folder)) return null;
      if (!data?.ok || !Array.isArray(data.items)) return null;
      if (data.cwd && folder && !todoWorkspaceMatches(data.cwd, folder)) return null;
      return data;
    },
    apply: (data) => renderList(data),
  });
  return reviewRefresher;
}

/**
 * Server pushed a `todo.review` refresh frame (or the socket reconnected, in
 * which case the frame has no todo id and may have been missed). A frame for
 * another selected workspace is ignored.
 *
 * @param {CustomEvent<{ workspaceFolder?: string, todoId?: string }>} [event]
 */
function onTodoReviewChanged(event) {
  const folder = String(event?.detail?.workspaceFolder || '').trim();
  if (folder && !todoWorkspaceMatches(folder)) return;
  getReviewRefresher().schedule();
}

/**
 * Open a reviewer's delegation report from the details panel. The persisted
 * snapshot carries no chat id and the list read never computes the link state,
 * so it is resolved lazily here (one cheap request per click, §11.3). The
 * resolved state is handed back to the badge so the row shows `trimmed`,
 * `chat deleted`, etc., and the outcome is also reported in the panel status.
 *
 * @param {CustomEvent<{ delegationId?: string, setLinkState?: (state: string) => void }>} event
 */
async function onReviewOpenReport(event) {
  const delegationId = String(event?.detail?.delegationId || '').trim();
  if (!delegationId) return;
  const setLinkState = typeof event?.detail?.setLinkState === 'function' ? event.detail.setLinkState : null;
  try {
    const link = await api.getDelegationReportLink(delegationId);
    if (!link?.ok) {
      // 404 means the record is gone (or not visible in this workspace).
      const gone = link?.status === 404 || /not found/i.test(String(link?.error || ''));
      if (gone) {
        setLinkState?.('delegation_missing');
        setStatus(t('todo.reviewReport.delegation_missing'), true);
        return;
      }
      setStatus(t('todo.reviewOpenFailed'), true);
      return;
    }
    const state = String(link.reportLinkState || '').trim();
    if (state) setLinkState?.(state);
    if (state === 'report_missing' || state === 'chat_deleted' || state === 'delegation_missing') {
      setStatus(t(`todo.reviewReport.${state}`), true);
      return;
    }
    const chatId = String(link.chatId || '').trim();
    if (!chatId) {
      setStatus(t('todo.reviewReport.chat_deleted'), true);
      return;
    }
    if (state === 'report_trimmed') setStatus(t('todo.reviewReport.trimmedNotice'), false);
    openWatcherChat(chatId);
  } catch {
    setStatus(t('todo.reviewOpenFailed'), true);
  }
}

const LIST_SKELETON_ROWS = 7;

/**
 * Loading feedback for the task list: the refresh button spins on every fetch,
 * and a list with nothing to show yet gets placeholder rows instead of a blank
 * panel. `renderList` replaces the placeholders as soon as data arrives.
 *
 * @param {boolean} loading
 */
function setListLoading(loading) {
  const refreshBtn = document.getElementById('todo-refresh-btn');
  refreshBtn?.classList.toggle('todo-refresh--loading', loading);
  refreshBtn?.setAttribute('aria-busy', loading ? 'true' : 'false');
  listEl?.setAttribute('aria-busy', loading ? 'true' : 'false');
  if (!loading || !listEl || listEl.querySelector('.todo-rows')) return;
  const rows = Array.from({ length: LIST_SKELETON_ROWS }, (_, index) =>
    `<div class="todo-skeleton-row" style="--todo-skeleton-width:${96 - ((index * 13) % 38)}%"><span></span></div>`
  ).join('');
  listEl.innerHTML =
    `<div class="todo-skeleton" role="status" aria-label="${t('todo.loading')}">${rows}</div>`;
}

export function refreshTodoList() {
  if (!isViewContextScopedAccessAllowed()) {
    return Promise.resolve();
  }
  const generation = ++refreshGeneration;
  const folder = getTodoWorkspaceFolder();
  resetTodoWorkspaceView();
  const isCurrent = () => generation === refreshGeneration && todoWorkspaceMatches(folder);
  loadCollapsed();
  loadStatusFilter();
  loadReviewFilter();
  loadIntegrationFilter();
  syncStatusFilterTriggerLabel();
  void refreshWatcherPanel();
  // Restore the banner and the poll loop after a reload or workspace switch.
  const batchListToken = batchListGate.next();
  void api.getIntegrateBatch(folder).then((data) => {
    if (!isCurrent() || !batchListGate.isLatest(batchListToken) || !data?.ok) return;
    syncTrackedBatch(data.batches);
  }).catch(() => {});
  void api.getAgentSdkStatus().then((data) => {
    sdkReady = !!data?.ready;
  }).catch(() => {});
  setListLoading(true);
  return api
    .getTodos(folder)
    .finally(() => {
      if (generation !== refreshGeneration) return;
      setListLoading(false);
      // A response that is discarded below must not leave placeholders behind.
      listEl?.querySelector('.todo-skeleton')?.remove();
    })
    .then((data) => {
      if (!isCurrent()) return;
      if (data?.cwd && folder && !todoWorkspaceMatches(data.cwd, folder)) return;
      if (!data?.ok) {
        setStatus(data?.error || t('todo.loadFailed'), true);
        if (hintEl) hintEl.textContent = '';
        renderList({ items: [] });
        return;
      }
      if (hintEl) {
        if (data.cwd) {
          hintEl.textContent = data.cwd;
          hintEl.hidden = false;
        } else {
          hintEl.textContent = '';
          hintEl.hidden = true;
        }
      }
      setStatus('');
      renderList(data);
      notifyViewContextTodoScope(data);
    })
    .catch(() => {
      if (!isCurrent()) return;
      setStatus(t('todo.loadError'), true);
      renderList({ items: [] });
    });
}

/**
 * Stage 2 ownership check: when this tab's view context names a TODO (a
 * `/todo?todo=` or `/git?scope=todo&todo=` link) and the explicit `ws/folder`
 * list does not contain it, report the conflict instead of pretending the
 * scope resolved. No message without an explicit link target.
 *
 * @param {{ items?: Array<object> } | null | undefined} data
 */
function notifyViewContextTodoScope(data) {
  const state = getViewContextState();
  if (!state?.target) return;
  const resource = state.route?.resource;
  const targetId = String(resource?.type === 'todo' ? resource.id : '').trim();
  if (!targetId) return;
  const items = Array.isArray(data?.items) ? data.items : [];
  const row = items.find((item) => item?.id === targetId) || null;
  reportViewContextResourceConflict('todo', row);
}

/**
 * @param {{ showPanel?: (panelId: string) => void }} [options]
 */
export function initTodoPanel(options = {}) {
  if (typeof options.showPanel === 'function') {
    showPanelFn = options.showPanel;
  }
  listEl = document.getElementById('todo-list');
  // One delegated handler for all rows: row menus are lazy, so this opens the
  // first ArrowDown before any per-row dropdown instance exists.
  listEl?.addEventListener('keydown', onRowMenuTriggerKeydown);
  // cr-checkbox emits cr-change; one delegated listener covers every row.
  listEl?.addEventListener('cr-change', onBatchCheckboxChange);
  statusEl = document.getElementById('todo-status');
  hintEl = document.getElementById('todo-cwd-hint');
  window.addEventListener('cretli-active-workspace-changed', onTodoWorkspaceChange);
  document.addEventListener('visibilitychange', onBatchPanelVisibilityChange);
  window.addEventListener('cretli:todo-changed', onTodoReviewChanged);
  subscribeSidebarChatRowStatusPatch(() => {
    listEl?.querySelectorAll('.todo-row').forEach((el) => {
      const item = findItem(el.dataset.id);
      if (item) paintTodoStatusIcon(el, item);
    });
    syncEditorItem();
  });
  const todoToolbar = document.querySelector('#todo-panel .todo-toolbar');
  ensureStatusFilterUi(todoToolbar);
  ensureBatchSelectionUi(todoToolbar);
  ensureBatchBanner();
  ensureUsageUi();
  initWatcherPanel({
    getTodoTitle: (id) => String(findItem(id)?.title || ''),
    openChat: openWatcherChat,
  });
  window.addEventListener('cretli:workspace-watcher-view-updated', () => {
    repaintTodoRowBadges();
  });
  const newOpenBtn = document.getElementById('todo-new-open-btn');
  const modalEl = document.getElementById('todo-new-modal');
  const modalBackdropEl = modalEl?.querySelector('.chat-settings-backdrop') || null;
  const cancelBtn = document.getElementById('todo-new-cancel-btn');
  const addBtn = document.getElementById('todo-add-btn');
  const titleInp = document.getElementById('todo-new-title');
  const bodyInp = document.getElementById('todo-new-body');
  const refreshBtn = document.getElementById('todo-refresh-btn');

  const closeNewTodoModal = () => {
    if (!modalEl) return;
    modalEl.hidden = true;
    newOpenBtn?.setAttribute('aria-expanded', 'false');
    pendingParentId = '';
  };

  openNewTodoModal = () => {
    if (!modalEl) return;
    modalEl.hidden = false;
    newOpenBtn?.setAttribute('aria-expanded', 'true');
    if (titleInp && 'value' in titleInp) titleInp.value = '';
    if (bodyInp && 'value' in bodyInp) bodyInp.value = '';
    titleInp?.focus?.();
  };

  refreshBtn?.addEventListener('click', () => {
    refreshTodoList();
  });
  newOpenBtn?.addEventListener('click', () => {
    pendingParentId = '';
    openNewTodoModal();
  });
  modalBackdropEl?.addEventListener('click', closeNewTodoModal);
  cancelBtn?.addEventListener('click', closeNewTodoModal);
  modalEl?.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    closeNewTodoModal();
  });
  titleInp?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    addBtn?.click();
  });
  addBtn?.addEventListener('click', async () => {
    const titleRaw = titleInp && 'value' in titleInp ? titleInp.value : '';
    const title = String(titleRaw || '').trim();
    if (!title) {
      setStatus(t('todo.provideTitle'), true);
      return;
    }
    const bodyRaw = bodyInp && 'value' in bodyInp ? bodyInp.value : '';
    const body = String(bodyRaw || '').trim();
    const parentId = pendingParentId;
    if (parentId && !canAddTodoChild(latestItems, parentId)) {
      setStatus(t('todo.depthLimit'), true);
      return;
    }
    try {
      const data = await api.postTodo(parentId ? { title, body, parentId } : { title, body });
      if (!data?.ok) {
        setStatus(data?.error || t('todo.error'), true);
        return;
      }
      if (titleInp && 'value' in titleInp) titleInp.value = '';
      if (bodyInp && 'value' in bodyInp) bodyInp.value = '';
      setStatus(t('todo.added'));
      renderList(data);
      closeNewTodoModal();
    } catch {
      setStatus(t('todo.networkError'), true);
    }
  });
  window.addEventListener('cr-lang-changed', () => {
    syncStatusFilterTriggerLabel();
    syncBatchSelectTrigger();
    if (statusFilterMenu?.api.isOpen()) renderStatusFilterMenuItems();
    if (latestItems.length || listEl?.querySelector('.todo-empty')) renderList({ items: latestItems });
    paintBatchBanner();
    paintBatchActionBar();
  });
  registerViewMemoryRestoreHandler('todo', (slice) => {
    pendingTodoViewMemory = slice;
    tryApplyPendingTodoViewMemory();
  });
  todoScrollContainer()?.addEventListener('scroll', () => scheduleTodoViewMemoryCapture(), { passive: true });
}
