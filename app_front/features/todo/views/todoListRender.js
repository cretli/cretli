import { getChatsList, getTerminalStateMetaPublic } from '../../chat/index.js';
import { probeSync } from '../../../lib/perfProbe.js';
import { getCurrentLang, t } from '../../../i18n/index.js';
import { getTodoWorkspaceFolder, todoWorkspaceMatches } from '../todoWorkspaceScope.js';
import { splitDeferredTodoRows } from '../todoTreeView.js';
import { countDeferredRoots } from '../todoTabCounts.js';
import { pruneBatchSelection } from '../todoBatchSelection.js';
import { isWatcherAutopilot } from '../../watcher/watcherPanel.js';
import { onRowMainPointerDown, onRowMainPointerMove, onRowMainPointerUp } from '../services/todoBatchFlow.js';
import { disposeAllRowMenus, disposeRowMenu } from '../services/todoCardActions.js';
import { applyCachedDetail, rememberDetail, syncEditorItem } from '../services/todoDetail.js';
import {
  applyCollapseDefaults,
  buildTodoTreeRows,
  getVisibleTodoItems,
  scheduleTodoViewMemoryCapture,
  tryApplyPendingTodoViewMemory,
} from '../services/todoPanelContext.js';
import {
  onAddChildClick,
  onCloseReviewedClick,
  onGripPointerDown,
  onGripPointerMove,
  onGripPointerUp,
  onRowOpen,
  onToggleClick,
} from '../services/todoRowInteractions.js';
import { S, TODO_PAINT_CHUNK, todoList } from '../state/todoPanelState.js';
import { currentBatchSelection, paintBatchActionBar } from './todoBatchView.js';
import { onRowMenuClick } from './todoRowMenu.js';
import { paintTodoRowIfChanged } from './todoRowRender.js';
import { createEmptyState, createSpan } from './todoDomBuild.js';

export function renderList(data) {
  return probeSync('todo.renderList', () => renderListImpl(data));
}

/**
 * Key of everything a no-op repaint would read besides the row signatures: the
 * server list revision, the visible row structure, the merged-detail rows and the
 * chat states behind the status icons. Empty when the payload carries no
 * revision, which always means "paint".
 *
 * @param {string} rev
 * @param {Array<{ item: any, level: number, hasChildren?: boolean, collapsed?: boolean }>} rows
 * @returns {string}
 */
export function computePaintSkipKey(rev, rows) {
  if (!rev) return '';
  const chatStates = getChatsList()
    .map((chat) => `${chat.id}:${getTerminalStateMetaPublic(chat)?.tone || ''}`)
    .join(',');
  return JSON.stringify([
    rev,
    rows.map((row) => `${row.item.id}:${row.level}:${row.hasChildren ? 1 : 0}:${row.collapsed ? 1 : 0}`).join(','),
    // Rows merged from the detail cache lose `listSlim`; their content is not covered by `rev`.
    S.latestItems.filter((item) => item.listSlim !== true).map((item) => `${item.id}@${item.updatedAt || ''}`).join(','),
    chatStates,
    getCurrentLang(),
    typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 640px)').matches,
    S.batchSelectionMode,
    S.batchSelectionMode ? [...todoList.batchSelected.get()].join(',') : '',
    S.activeBatch ? JSON.stringify(S.activeBatch) : '',
    isWatcherAutopilot(),
    S.deferredSectionOpen,
    S.todoSort,
    // formatTodoMetaText embeds relative times.
    Math.floor(Date.now() / 60000),
  ]);
}

export function renderListImpl(data) {
  const folder = getTodoWorkspaceFolder();
  if (data?.cwd && folder && !todoWorkspaceMatches(data.requestedFolder || data.cwd, folder)) return;
  S.latestWorkspaceFolder = folder;
  if (!S.listEl) return;
  S.latestListRev = typeof data?.rev === 'string' ? data.rev : '';
  const incoming = Array.isArray(data?.items) ? data.items : [];
  incoming.forEach(rememberDetail);
  S.latestItems = incoming.map(applyCachedDetail);
  window.dispatchEvent(new CustomEvent('cretli:todo-deferred-count-changed', {
    detail: { count: countDeferredRoots(S.latestItems) },
  }));
  const visibleItems = getVisibleTodoItems();
  if (!S.latestItems.length || !visibleItems.length) S.lastPaintSkipKey = '';
  if (!S.latestItems.length) {
    disposeAllRowMenus();
    S.listEl.replaceChildren(createEmptyState('mdi-checkbox-marked-circle-outline', t('todo.none')));
    syncEditorItem();
    afterTodoRowsPainted();
    return;
  }
  if (!visibleItems.length) {
    disposeAllRowMenus();
    S.listEl.replaceChildren(createEmptyState('mdi-filter-outline', t('todo.noneFiltered')));
    syncEditorItem();
    afterTodoRowsPainted();
    return;
  }
  applyCollapseDefaults(S.latestItems);
  const allRows = buildTodoTreeRows(visibleItems);
  // Deferred roots live in their own collapsible section after the main tree.
  const split = splitDeferredTodoRows(allRows);
  const sectionOpen = S.deferredSectionOpen || !!S.todoSearchQuery.trim();
  const rows = S.todoTab === 'deferred'
    ? split.deferred
    : (sectionOpen ? [...split.main, ...split.deferred] : split.main);
  let wrapEl = S.listEl.querySelector('.todo-rows');
  if (!wrapEl) {
    S.listEl.replaceChildren();
    wrapEl = document.createElement('div');
    wrapEl.className = 'todo-rows';
    wrapEl.setAttribute('role', 'tree');
    wrapEl.setAttribute('aria-label', t('todo.treeAria'));
    S.listEl.appendChild(wrapEl);
  }
  wrapEl.setAttribute('aria-label', t('todo.treeAria'));
  // Same revision, structure and chat states as the last complete paint (e.g. a
  // chat switch re-resolving the list): nothing on screen can differ.
  const paintKey = computePaintSkipKey(S.latestListRev, rows);
  if (paintKey && paintKey === S.lastPaintSkipKey && !S.todoPaintContinuation && !S.todoPaintResumeFrom
    && wrapEl.querySelectorAll('.todo-row').length === rows.length) {
    probeSync('todo.renderList.skipped', () => {});
    syncEditorItem();
    afterTodoRowsPainted();
    return;
  }
  S.lastPaintSkipKey = '';
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
  // The section header sits between the main rows and the deferred rows, so it
  // takes a slot in the child order.
  const headIndex = split.deferredRoots > 0 ? split.main.length : -1;
  const head = paintDeferredSectionHead(wrapEl, split.deferredRoots, sectionOpen);
  if (headIndex >= 0 && wrapEl.children[headIndex] !== head) wrapEl.insertBefore(head, wrapEl.children[headIndex] || null);
  // A large cold paint (hundreds of new rows) is split into frame-sized chunks so
  // the first open does not block the main thread in one long task.
  const missingRows = rows.length - existing.size;
  const paintCap = missingRows > TODO_PAINT_CHUNK * 3 ? existing.size + TODO_PAINT_CHUNK : rows.length;
  if (S.todoPaintContinuation) {
    cancelAnimationFrame(S.todoPaintContinuation);
    S.todoPaintContinuation = 0;
  }
  // A continuation frame only paints the next slice; earlier rows are already in place.
  const resumeFrom = S.todoPaintResumeFrom;
  S.todoPaintResumeFrom = 0;
  rows.forEach((row, rowIndex) => {
    if (rowIndex >= paintCap || rowIndex < resumeFrom) return;
    const index = headIndex >= 0 && rowIndex >= headIndex ? rowIndex + 1 : rowIndex;
    const id = String(row.item.id);
    let el = existing.get(id);
    if (!el) {
      el = createTodoRow();
      const before = wrapEl.children[index] || null;
      wrapEl.insertBefore(el, before);
    } else if (wrapEl.children[index] !== el) {
      wrapEl.insertBefore(el, wrapEl.children[index] || null);
    }
    probeSync('todo.paintRow', () => paintTodoRowIfChanged(el, row));
  });
  if (headIndex < 0) wrapEl.querySelector('.todo-deferred-head')?.remove();
  const paintPending = paintCap < rows.length;
  if (!paintPending) S.lastPaintSkipKey = paintKey;
  if (paintPending) {
    S.todoPaintContinuation = requestAnimationFrame(() => {
      S.todoPaintContinuation = 0;
      S.todoPaintResumeFrom = paintCap;
      renderList({ items: S.latestItems, cwd: S.latestWorkspaceFolder, requestedFolder: S.latestWorkspaceFolder });
    });
  }
  syncEditorItem();
  // Scroll/focus memory is restored and captured only once the final chunk is in,
  // otherwise a clamped scrollTop would be applied, consumed and saved back.
  if (!paintPending) {
    tryApplyPendingTodoViewMemory();
    scheduleTodoViewMemoryCapture();
  }
  afterTodoRowsPainted();
}

/**
 * A list render may remove or filter out selected rows; drop them before the
 * bar computes its count so the request can never include a hidden id.
 */
export function afterTodoRowsPainted() {
  if (S.batchSelectionMode) {
    const { eligibleIds } = currentBatchSelection();
    todoList.setBatchSelected(pruneBatchSelection(todoList.batchSelected.get(), eligibleIds));
  }
  paintBatchActionBar();
}

/**
 * Creates or updates the "Later" section header. The caller positions it.
 *
 * @param {Element} wrapEl
 * @param {number} count Deferred root todos.
 * @param {boolean} open
 * @returns {HTMLElement}
 */
export function paintDeferredSectionHead(wrapEl, count, open) {
  let head = /** @type {HTMLElement | null} */ (wrapEl.querySelector('.todo-deferred-head'));
  if (!(head instanceof HTMLElement)) {
    const button = document.createElement('button');
    button.type = 'button';
    head = button;
    head.className = 'todo-deferred-head';
    head.append(
      createSpan('todo-deferred-head-chevron mdi', true),
      createSpan('todo-deferred-head-label'),
      createSpan('todo-deferred-head-count'),
    );
    head.addEventListener('click', () => {
      S.deferredSectionOpen = !S.deferredSectionOpen;
      renderList({ items: S.latestItems, cwd: S.latestWorkspaceFolder, requestedFolder: S.latestWorkspaceFolder });
    });
  }
  head.setAttribute('aria-expanded', String(open));
  head.setAttribute('aria-label', `${t('todo.deferredSectionAria')} (${count})`);
  const chevron = head.querySelector('.todo-deferred-head-chevron');
  if (chevron) chevron.className = `todo-deferred-head-chevron mdi ${open ? 'mdi-chevron-down' : 'mdi-chevron-right'}`;
  const label = head.querySelector('.todo-deferred-head-label');
  if (label) label.textContent = t('todo.deferredSection');
  const countEl = head.querySelector('.todo-deferred-head-count');
  if (countEl) countEl.textContent = String(count);
  return head;
}

export function createTodoRow() {
  const row = document.createElement('cr-todo-row');
  row.ensureSkeleton();
  const grip = row.querySelector('.todo-row-grip');
  const toggle = row.querySelector('.todo-row-toggle');
  const main = row.querySelector('.todo-row-main');
  const add = row.querySelector('.todo-row-add');
  const menu = row.querySelector('.todo-row-menu');
  const close = row.querySelector('.todo-row-close');
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
  close?.addEventListener('click', onCloseReviewedClick);
  menu?.addEventListener('click', onRowMenuClick);
  return row;
}
