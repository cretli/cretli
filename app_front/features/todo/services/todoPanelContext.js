import { filterTodoItemsByReviewState, parseReviewListFilter } from '../todoReviewBadge.js';
import { getChatsList, getTerminalStateMetaPublic } from '../../chat/index.js';
import { resolveTodoStatusIcon } from '../todoStatusIcon.js';
import { t } from '../../../i18n/index.js';
import { getTodoWorkspaceFolder } from '../todoWorkspaceScope.js';
import { getViewContextRuntimeScope } from '../../../app/appShell/viewContextBridge.js';
import { schedulePanelViewMemoryCapture } from '../../../app/appShell/viewMemoryBridge.js';
import {
  filterTodoItemsByRootStatus,
  filterTodoItemsBySearch,
  flattenTodoTree,
  parseTodoIntegrationFilter,
  parseTodoSortMode,
  parseTodoRootStatusFilter,
  TODO_INTEGRATION_PENDING_FILTERS,
  resolveTodoStartHarness as resolveTodoHarness,
} from '../todoTreeView.js';
import { showTodoError } from '../views/todoDialogs.js';
import { filterTodoItemsByIntegrationState } from './todoIntegrationRules.js';
import {
  COLLAPSE_PREFIX,
  EDITOR_SAVED_VISIBLE_MS,
  INTEGRATION_FILTER_PREFIX,
  REVIEW_FILTER_PREFIX,
  S,
  SORT_PREFIX,
  STATUS_FILTER_PREFIX,
  todoList,
} from '../state/todoPanelState.js';
import { renderList } from '../views/todoListRender.js';
import { renderStatusFilterMenuItems, syncStatusFilterTriggerLabel } from '../views/todoToolbar.js';

/**
 * @param {Set<string>} selected
 * @returns {boolean}
 */
export function isIntegrationPendingSelection(selected) {
  return selected.size === TODO_INTEGRATION_PENDING_FILTERS.length
    && TODO_INTEGRATION_PENDING_FILTERS.every((filter) => selected.has(filter));
}

/**
 * Harness for starting this todo's agent. Shared precedence (assignee →
 * sourceHarness → sourceChat) lives in `resolveTodoStartHarness`; the chat
 * panel's new-harness select is only the last-resort fallback.
 *
 * @param {object | null | undefined} item
 * @returns {string}
 */
export function resolveTodoStartHarness(item) {
  const sel = document.getElementById('chat-new-harness-select');
  const fallback = String(sel?.value || 'sdk').trim() || 'sdk';
  return resolveTodoHarness(item, fallback);
}

/**
 * @param {string} msg
 * @param {boolean} isErr
 * @param {object | null} [prepareDetails]
 */
export function setStatus(msg, isErr, prepareDetails = null) {
  if (msg && isErr) showTodoError(msg, prepareDetails);
  // The page-level status line sits behind the editor modal, so mirror messages
  // into the modal while it is open.
  if (msg && S.editorTodoId) setEditorSaveState(isErr ? 'error' : 'saved', isErr ? t('todo.error') : msg);
  if (!S.statusEl) return;
  S.statusEl.textContent = msg && isErr ? t('todo.error') : msg || '';
  S.statusEl.classList.toggle('todo-status--error', !!isErr);
}

/**
 * Save feedback inside the editor modal: "Saving…" while a patch is in flight,
 * then "Saved" (fades after a moment) or the error text.
 *
 * @param {'saving' | 'saved' | 'error'} kind
 * @param {string} text
 */
export function setEditorSaveState(kind, text) {
  const el = S.editorCard?.querySelector?.('.todo-save-state');
  if (!(el instanceof HTMLElement)) return;
  if (S.editorSaveStateTimer) clearTimeout(S.editorSaveStateTimer);
  S.editorSaveStateTimer = 0;
  el.hidden = !text;
  el.textContent = text || '';
  el.dataset.state = kind;
  if (kind === 'saved') {
    S.editorSaveStateTimer = setTimeout(() => {
      el.hidden = true;
    }, EDITOR_SAVED_VISIBLE_MS);
  }
}

/**
 * Same scope the list is fetched with (view-context runtime first, header trigger
 * as fallback). The trigger alone is cleared while a link reports a conflict,
 * which used to drop filters/collapse state to the shared `default` key and show
 * a differently filtered list for the very same todo store.
 */
export function getWorkspaceContext() {
  const scope = getViewContextRuntimeScope();
  const trigger = document.getElementById('header-workspace-trigger');
  return {
    workspaceFile: scope.workspaceFile || trigger?.dataset?.workspaceFile || '',
    workspaceFolder: getTodoWorkspaceFolder() || trigger?.dataset?.workspaceFolder || '',
  };
}

/** Per-list UI state follows the workspace; a bare folder is the fallback scope. */
export function todoListScopeKey() {
  const ctx = getWorkspaceContext();
  return ctx.workspaceFile || ctx.workspaceFolder || 'default';
}

/**
 * Reads a per-list UI value; when the workspace-keyed entry is absent, falls
 * back once to the legacy folder-keyed entry.
 */
export function readScopedStorage(key, prefix) {
  const value = localStorage.getItem(key);
  if (value !== null) return value;
  const folder = getWorkspaceContext().workspaceFolder;
  const legacyKey = folder ? `${prefix}${folder}` : '';
  if (!legacyKey || legacyKey === key) return null;
  const legacy = localStorage.getItem(legacyKey);
  // Migrate once: later reads (and other workspaces sharing the folder) use the new key.
  if (legacy !== null) {
    try {
      localStorage.setItem(key, legacy);
    } catch {
      // Storage full or blocked: the value still applies for this view.
    }
  }
  return legacy;
}

export function collapseStorageKey() {
  return `${COLLAPSE_PREFIX}${todoListScopeKey()}`;
}

export function loadCollapsed() {
  todoList.setCollapsed([]);
  S.collapseDefaultsPending = false;
  try {
    const raw = readScopedStorage(collapseStorageKey(), COLLAPSE_PREFIX);
    S.collapseDefaultsPending = raw === null;
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return;
    parsed.forEach((id) => {
      const key = String(id || '').trim();
      if (key) todoList.addCollapsed(key);
    });
  } catch {
    todoList.setCollapsed([]);
  }
}

/**
 * First visit to a workspace: collapse finished trees so a long history does not
 * render (and scroll past) hundreds of closed rows. Explicit expand/collapse
 * choices are persisted afterwards and are never overridden.
 */
export function applyCollapseDefaults(items) {
  if (!S.collapseDefaultsPending || !items.length) return;
  S.collapseDefaultsPending = false;
  const parentIds = new Set(items.map((item) => String(item.parentId || '')).filter(Boolean));
  items.forEach((item) => {
    if (item.status === 'done' && parentIds.has(String(item.id))) todoList.addCollapsed(item.id);
  });
  saveCollapsed();
}

/** A search must reach rows inside collapsed branches. */
export function effectiveCollapsedIds() {
  return S.todoSearchQuery.trim() ? new Set() : todoList.collapsed.get();
}

export function saveCollapsed() {
  try {
    localStorage.setItem(collapseStorageKey(), JSON.stringify([...todoList.collapsed.get()]));
  } catch {
    // Private mode can reject storage; the tree still works for this view.
  }
}

export function statusFilterStorageKey() {
  return `${STATUS_FILTER_PREFIX}${todoListScopeKey()}`;
}

export function loadStatusFilter() {
  try {
    const raw = readScopedStorage(statusFilterStorageKey(), STATUS_FILTER_PREFIX);
    const parsed = raw ? JSON.parse(raw) : [];
    todoList.setRootStatus(parseTodoRootStatusFilter(Array.isArray(parsed) ? parsed : []));
  } catch {
    todoList.setRootStatus(null);
  }
}

export function reviewFilterStorageKey() {
  return `${REVIEW_FILTER_PREFIX}${todoListScopeKey()}`;
}

export function loadReviewFilter() {
  try {
    todoList.setReview(parseReviewListFilter(readScopedStorage(reviewFilterStorageKey(), REVIEW_FILTER_PREFIX)));
  } catch {
    todoList.setReview('');
  }
}

export function saveReviewFilter() {
  try {
    if (todoList.review.get()) localStorage.setItem(reviewFilterStorageKey(), todoList.review.get());
    else localStorage.removeItem(reviewFilterStorageKey());
  } catch {
    // Private mode can reject storage; filtering still works for this view.
  }
}

export function integrationFilterStorageKey() {
  return `${INTEGRATION_FILTER_PREFIX}${todoListScopeKey()}`;
}

export function loadIntegrationFilter() {
  let stored = null;
  try {
    stored = readScopedStorage(integrationFilterStorageKey(), INTEGRATION_FILTER_PREFIX);
  } catch {
    // Storage blocked; the pending preset still applies for this view.
  }
  todoList.setIntegration(parseTodoIntegrationFilter(stored));
}

export function saveIntegrationFilter() {
  try {
    // "All" is saved as an empty list: removing the key would bring back the pending default.
    localStorage.setItem(integrationFilterStorageKey(), JSON.stringify([...todoList.integration.get()]));
  } catch {
    // Private mode can reject storage; filtering still works for this view.
  }
}

/**
 * Search the full workspace list; otherwise apply the saved status, review and
 * integration filters. Searching never changes those saved selections.
 *
 * @returns {object[]}
 */
export function getVisibleTodoItems() {
  if (S.todoSearchQuery.trim() && !S.todoSearchUseFilters) return filterTodoItemsBySearch(S.latestItems, S.todoSearchQuery);
  const byReview = filterTodoItemsByReviewState(
    filterTodoItemsByRootStatus(S.latestItems, todoList.rootStatus.get()),
    todoList.review.get()
  );
  return filterTodoItemsBySearch(filterTodoItemsByIntegrationState(byReview, todoList.integration.get()), S.todoSearchQuery);
}

export function sortStorageKey() {
  return `${SORT_PREFIX}${todoListScopeKey()}`;
}

export function loadTodoSort() {
  try {
    S.todoSort = parseTodoSortMode(readScopedStorage(sortStorageKey(), SORT_PREFIX));
  } catch {
    S.todoSort = 'manual';
  }
}

export function saveTodoSort() {
  try {
    if (S.todoSort === 'manual') localStorage.removeItem(sortStorageKey());
    else localStorage.setItem(sortStorageKey(), S.todoSort);
  } catch {
    // Private mode can reject storage; sorting still works for this view.
  }
}

/**
 * Depth-first rows in the panel's current sort. The `active` sort ranks a root
 * tree by the same live agent state its status icon shows.
 *
 * @param {object[]} visibleItems
 */
export function buildTodoTreeRows(visibleItems) {
  const sort = parseTodoSortMode(S.todoSort);
  if (sort !== 'active') return flattenTodoTree(visibleItems, effectiveCollapsedIds(), { sort });
  const chats = getChatsList();
  const liveRank = (root) => {
    const icon = resolveTodoStatusIcon(root, S.latestItems, chats, getTerminalStateMetaPublic);
    if (icon.labelKey === 'todo.agentWorking') return 0;
    if (icon.labelKey === 'todo.agentWaiting') return 1;
    return -1;
  };
  return flattenTodoTree(visibleItems, effectiveCollapsedIds(), { sort, liveRank });
}

export function todoScrollContainer() {
  return document.querySelector('#todo-panel .todo-scroll');
}

export function buildTodoViewMemorySlice() {
  const searchWrap = document.querySelector('#todo-panel .todo-search');
  const searchInput = searchWrap?.querySelector('cr-bar-input');
  return {
    search: S.todoSearchQuery,
    searchUseFilters: S.todoSearchUseFilters,
    searchOpen: searchWrap ? searchWrap.hidden === false : false,
    rootStatus: todoList.rootStatus.get() ? [...todoList.rootStatus.get()] : null,
    review: todoList.review.get() || '',
    // Integration filter stays out of the per-tab slice: a snapshot would override the saved filter.
    collapsed: [...todoList.collapsed.get()],
    scrollTop: todoScrollContainer()?.scrollTop || 0,
    focusId: document.activeElement?.closest?.('.todo-row')?.dataset?.id || '',
    searchInputValue: searchInput && 'value' in searchInput ? String(searchInput.value || '') : S.todoSearchQuery,
  };
}

export function scheduleTodoViewMemoryCapture() {
  schedulePanelViewMemoryCapture('todo', buildTodoViewMemorySlice);
}

/**
 * @param {object | null | undefined} slice
 */
export function applyTodoViewMemorySlice(slice) {
  if (!slice || typeof slice !== 'object') return;
  const searchText = typeof slice.searchInputValue === 'string' ? slice.searchInputValue : slice.search;
  if (typeof searchText === 'string') S.todoSearchQuery = searchText;
  if (typeof slice.searchUseFilters === 'boolean') S.todoSearchUseFilters = slice.searchUseFilters;
  if (slice.review === 'none' || slice.review === 'stale' || slice.review === '') {
    todoList.setReview(slice.review);
  }
  if (slice.rootStatus === null) todoList.setRootStatus(null);
  else if (Array.isArray(slice.rootStatus)) todoList.setRootStatus(slice.rootStatus.map(String));
  if (Array.isArray(slice.collapsed)) {
    todoList.setCollapsed(slice.collapsed.map(String));
    S.collapseDefaultsPending = false;
  }
  const searchWrap = document.querySelector('#todo-panel .todo-search');
  const searchBtn = document.querySelector('#todo-panel .todo-search-btn');
  const searchInput = searchWrap?.querySelector('cr-bar-input');
  if (searchWrap && typeof slice.searchOpen === 'boolean') searchWrap.hidden = !slice.searchOpen;
  if (searchInput && 'value' in searchInput) searchInput.value = S.todoSearchQuery;
  const searchToggle = searchWrap?.querySelector('cr-checkbox');
  if (searchToggle) searchToggle.checked = S.todoSearchUseFilters;
  const clearSearch = searchWrap?.querySelector('.todo-search-clear');
  if (clearSearch) clearSearch.hidden = !S.todoSearchQuery;
  searchBtn?.classList.toggle('todo-search-btn--active', !!S.todoSearchQuery.trim());
  syncStatusFilterTriggerLabel();
  if (S.statusFilterMenu?.api.isOpen()) renderStatusFilterMenuItems();
  if (!S.latestItems.length) return;
  // Consumed before the repaint: renderList ends by retrying the pending
  // slice, so leaving it set here would re-enter this function.
  S.pendingTodoViewMemory = null;
  if (S.latestItems.length || S.listEl?.querySelector('.todo-empty')) renderList({ items: S.latestItems });
  const scrollEl = todoScrollContainer();
  if (scrollEl && Number.isFinite(Number(slice.scrollTop))) scrollEl.scrollTop = Number(slice.scrollTop);
  const focusId = String(slice.focusId || '').trim();
  if (focusId && S.listEl) {
    const row = S.listEl.querySelector(`.todo-row[data-id="${CSS.escape(focusId)}"]`);
    row?.querySelector('.todo-row-open')?.focus?.();
  }
}

export function tryApplyPendingTodoViewMemory() {
  if (!S.pendingTodoViewMemory || !S.latestItems.length) return;
  applyTodoViewMemorySlice(S.pendingTodoViewMemory);
}
