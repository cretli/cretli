import * as api from './core/api/index.js';
import { openTodoAgentChat } from './chat.js';
import { getCurrentLang, t } from './i18n/index.js';
import { formatTodoRef } from '../lib/todo-ref.js';
import { writeTextToClipboard } from './lib/clipboard.js';
import { initDropdown, closeAllOpenDropdowns } from './lib/dropdown.js';
import { preloadMarkdown } from './lib/render-markdown.js';
import {
  buildTodoMarkdown,
  canAddTodoChild,
  filterTodoItemsByRootStatus,
  flattenTodoTree,
  formatTodoAssigneeBadge,
  parseTodoRootStatusFilter,
  serializeTodoRootStatusFilter,
  TODO_ITEM_STATUSES,
  readTodoRowMark,
  readTodoRowMeta,
  resolveTodoChatCountKey,
  resolveTodoDrop,
  resolveTodoStartHarness as resolveTodoHarness,
  todoDropZoneFromRatio,
} from './features/todo/todoTreeView.js';
import './components/ui/cr-bar-select.js';
import './components/ui/cr-bar-input.js';
import './components/ui/cr-bar-textarea.js';
import './components/ui/cr-bar-button.js';
import './components/ui/cr-checkbox.js';
import './components/ui/cr-dialog.js';
import './components/ui/cr-todo-card.js';

/** @type {HTMLElement|null} */
let listEl = null;
/** @type {HTMLElement|null} */
let statusEl = null;
/** @type {HTMLElement|null} */
let hintEl = null;
/** @type {(panelId: string) => void} */
let showPanelFn = () => {};
/** @type {boolean} */
let sdkReady = false;
/** @type {object[]} */
let latestItems = [];
/** @type {Set<string>} */
let collapsedIds = new Set();
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

/** @type {Map<HTMLElement, { api: { destroy: () => void }, panel: HTMLElement }>} */
const rowMenus = new Map();

/** Todo ids with a start-agent request in flight (row menu and card share it). */
const startAgentInFlight = new Set();

const COLLAPSE_PREFIX = 'cretli-todo-collapsed:';
const STATUS_FILTER_PREFIX = 'cretli-todo-status-filter:';

/** @type {Set<string> | null} */
let rootStatusFilter = null;
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
 */
function setStatus(msg, isErr) {
  if (!statusEl) return;
  statusEl.textContent = msg || '';
  statusEl.classList.toggle('todo-status--error', !!isErr);
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
  try {
    const raw = localStorage.getItem(collapseStorageKey());
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
  if (!rootStatusFilter) return t('todo.filterStatusAll');
  const parts = TODO_ITEM_STATUSES.filter((status) => rootStatusFilter.has(status)).map((status) =>
    t(todoStatusLabelKey(status))
  );
  return parts.join(', ');
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
  const addRow = (id, label, checked) => {
    const row = document.createElement('div');
    row.className = 'todo-status-filter-row';
    row.dataset.filterId = id;
    const box = document.createElement('cr-checkbox');
    box.checked = checked;
    box.setAttribute('aria-label', label);
    const text = document.createElement('span');
    text.textContent = label;
    box.appendChild(text);
    row.appendChild(box);
    list.appendChild(row);
  };
  addRow('all', t('todo.filterStatusAll'), showAll);
  TODO_ITEM_STATUSES.forEach((status) => {
    addRow(status, t(todoStatusLabelKey(status)), !showAll && selected.has(status));
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
  list.addEventListener('change', (event) => {
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
  syncStatusFilterTriggerLabel();
  const refreshBtn = document.getElementById('todo-refresh-btn');
  if (refreshBtn?.parentNode) {
    refreshBtn.parentNode.insertBefore(trigger, refreshBtn.nextSibling);
  } else {
    toolbar.appendChild(trigger);
  }
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
  try {
    entry.api.destroy();
  } catch {
    // A detached dropdown must never break the next render.
  }
  entry.panel.remove();
  rowMenus.delete(row);
}

function disposeAllRowMenus() {
  for (const row of [...rowMenus.keys()]) disposeRowMenu(row);
}

function bindCardHandlers(card) {
  card.addEventListener('todo-status-change', onStatusChange);
  card.addEventListener('todo-title-save', onTitleBlur);
  card.addEventListener('todo-body-save', onBodyBlur);
  card.addEventListener('todo-delete', onDelete);
  card.addEventListener('todo-start-agent', onStartAgent);
  card.addEventListener('todo-open-chat', onOpenChat);
  card.addEventListener('todo-copy', onCardCopy);
  card.addEventListener('todo-assignee-change', onEditorAssigneeChange);
  card.addEventListener('todo-runmode-change', onEditorRunModeChange);
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

/**
 * @param {string} id
 * @returns {object | null}
 */
function findItem(id) {
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
  const data = await api.getTodos();
  if (!data?.ok || !Array.isArray(data.items)) return null;
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
}

function renderList(data) {
  if (!listEl) return;
  latestItems = Array.isArray(data?.items) ? data.items : [];
  const visibleItems = filterTodoItemsByRootStatus(latestItems, rootStatusFilter);
  if (!latestItems.length) {
    disposeAllRowMenus();
    listEl.innerHTML =
      '<div class="todo-empty-state">' +
      '<span class="todo-empty-icon mdi mdi-checkbox-marked-circle-outline" aria-hidden="true"></span>' +
      `<p class="todo-empty">${t('todo.none')}</p>` +
      '</div>';
    syncEditorItem();
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
    return;
  }
  const rows = flattenTodoTree(visibleItems, collapsedIds);
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
}

function createTodoRow() {
  const row = document.createElement('div');
  row.className = 'todo-row';
  row.setAttribute('role', 'treeitem');
  row.innerHTML =
    '<button type="button" class="todo-row-grip" draggable="false">' +
    '<span class="mdi mdi-drag-vertical" aria-hidden="true"></span></button>' +
    '<button type="button" class="todo-row-toggle" hidden></button>' +
    '<button type="button" class="todo-row-main">' +
    '<span class="todo-item-status-dot" aria-hidden="true"></span>' +
    '<span class="todo-row-text">' +
    '<span class="todo-row-title"></span>' +
    '<span class="todo-row-meta" hidden></span>' +
    '</span>' +
    '<span class="todo-row-badge" hidden></span>' +
    '<span class="todo-row-mark" hidden></span>' +
    '</button>' +
    '<button type="button" class="todo-row-add">' +
    '<span class="mdi mdi-plus" aria-hidden="true"></span></button>' +
    '<button type="button" class="todo-row-menu" aria-haspopup="menu">' +
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
  add?.addEventListener('click', onAddChildClick);
  menu?.addEventListener('click', onRowMenuClick);
  ensureRowMenu(row);
  return row;
}

/**
 * Lazily creates the row action menu (portal to <body>, like other Cretli
 * dropdowns) and wires the shared dropdown controller for keyboard support.
 *
 * @param {HTMLElement} row
 */
function ensureRowMenu(row) {
  if (rowMenus.has(row)) return;
  const trigger = row.querySelector('.todo-row-menu');
  if (!(trigger instanceof HTMLButtonElement)) return;
  const panel = document.createElement('div');
  panel.className = 'chat-list-modal todo-row-menu-panel';
  panel.hidden = true;
  const list = document.createElement('div');
  list.className = 'chat-list-panel todo-row-menu-list';
  list.setAttribute('role', 'menu');
  list.addEventListener('click', (event) => onRowMenuSelect(event, row));
  panel.appendChild(list);
  document.body.appendChild(panel);
  const api = initDropdown({
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
    },
  });
  rowMenus.set(row, { api, panel });
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
  const actions = [
    { id: 'addChild', icon: 'mdi-plus', label: t('todo.addChild'), disabled: !canAdd },
    { id: 'copyId', icon: 'mdi-identifier', label: t('todo.copyId') },
    { id: 'copyRef', icon: 'mdi-link-variant', label: t('todo.copyRef') },
    {
      id: 'openChat',
      icon: 'mdi-chat-outline',
      label: t('todo.openLastChat'),
      disabled: chats.length === 0 && !item.chatId && !item.sourceChat?.id,
    },
    { id: 'newChat', icon: 'mdi-robot-outline', label: t('todo.continueNewChat') },
    { id: 'delete', icon: 'mdi-delete-outline', label: t('todo.delete'), danger: true },
  ];
  list.textContent = '';
  actions.forEach((action) => {
    // Visual group boundary before the destructive action, without adding a
    // focusable item the dropdown keyboard walk would trip over.
    if (action.id === 'delete') {
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
    list.appendChild(button);
  });
}

/** @param {MouseEvent} event */
function onRowMenuClick(event) {
  const row = event.currentTarget instanceof Element ? event.currentTarget.closest('.todo-row') : null;
  const entry = row instanceof HTMLElement ? rowMenus.get(row) : null;
  if (!entry) return;
  event.preventDefault();
  event.stopPropagation();
  // Only one row menu at a time; toggle keeps the common open/close behavior.
  if (!entry.api.isOpen()) closeAllOpenDropdowns();
  entry.api.toggle();
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
    await startTodoAgent(id, { forceNew: true });
    return;
  }
  if (action === 'delete') {
    await deleteTodoWithConfirm(id);
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
function paintTodoRow(el, row) {
  const id = String(row.item.id || '');
  const status = String(row.item.status || 'idea');
  el.dataset.id = id;
  el.dataset.status = status;
  el.className = `todo-row todo-row--${status}`;
  el.style.setProperty('--todo-level', String(row.level));
  el.setAttribute('aria-level', String(row.level + 1));
  const toggle = el.querySelector('.todo-row-toggle');
  const title = el.querySelector('.todo-row-title');
  const meta = el.querySelector('.todo-row-meta');
  const badge = el.querySelector('.todo-row-badge');
  const mark = el.querySelector('.todo-row-mark');
  const grip = el.querySelector('.todo-row-grip');
  const add = el.querySelector('.todo-row-add');
  const menu = el.querySelector('.todo-row-menu');
  const main = el.querySelector('.todo-row-main');
  if (title) title.textContent = String(row.item.title || '');
  if (grip instanceof HTMLElement) grip.setAttribute('aria-label', t('todo.dragHandle'));
  if (main instanceof HTMLElement) main.setAttribute('aria-label', t('todo.editTask'));
  if (menu instanceof HTMLElement) {
    menu.setAttribute('aria-label', t('todo.rowMenu'));
    menu.title = t('todo.rowMenu');
  }
  const metaText = formatTodoMetaText(row.item);
  if (meta instanceof HTMLElement) {
    meta.hidden = !metaText;
    meta.textContent = metaText;
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
  const badgeFull = formatTodoAssigneeBadge(row.item);
  if (badge instanceof HTMLElement) {
    const narrow = typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(max-width: 640px)').matches;
    const badgeText = narrow ? String(row.item?.assignee?.harness || '').trim() : badgeFull;
    badge.hidden = !badgeText;
    badge.textContent = badgeText;
    if (badgeFull) badge.title = badgeFull;
    else badge.removeAttribute('title');
  }
  const markKind = readTodoRowMark(latestItems, row.item);
  if (mark instanceof HTMLElement) {
    mark.hidden = !markKind;
    mark.textContent = markKind === 'blocked' ? t('todo.blocked') : t('todo.ready');
    mark.dataset.mark = markKind;
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
    row.classList.remove('todo-row--dragging');
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
}

/** @param {MouseEvent} event */
function onRowOpen(event) {
  const row = event.currentTarget instanceof Element ? event.currentTarget.closest('.todo-row') : null;
  const id = String(row?.dataset.id || '');
  if (!id) return;
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
  editorCard.newChatHarness = '';
  editorCard.bodyPreview = false;
  // A different todo always starts on the description tab; re-renders of the
  // same todo (renderList/syncEditorItem) keep the user's tab and drafts.
  if (editorTabTodoId !== id) {
    editorTabTodoId = id;
    editorCard.activeTab = 'description';
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
  const current = findItem(todoId)?.runMode === 'sequential' ? 'sequential' : 'parallel';
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

/** @param {Event} e */
async function onStartAgent(e) {
  const id = e?.detail?.id;
  if (!id) return;
  const forceNew = e?.detail?.forceNew === true;
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

/**
 * Opens the linked chat or creates one. `forceNew` always creates a fresh chat
 * and keeps the previous one in the todo history.
 *
 * @param {string} id
 * @param {{ forceNew?: boolean, agentTransport?: string, item?: object | null }} [options]
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
 * @param {{ forceNew?: boolean, agentTransport?: string, item?: object | null }} [options]
 */
async function startTodoAgentOnce(todoId, options = {}) {
  const forceNew = options.forceNew === true;
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
  if (forceNew && String(item.status || '') === 'done' && !confirmAction(t('todo.confirmStartDone'))) {
    return;
  }
  setStatus(t('todo.creatingAgent'));
  const payload = {
    workspaceFile: ctx.workspaceFile,
    workspaceFolder: ctx.workspaceFolder,
    model: 'auto',
    agentTransport: harness,
  };
  if (forceNew) payload.forceNew = true;
  try {
    const data = await api.postTodoStartAgent(todoId, payload);
    if (!data?.ok || !data.chat) {
      setStatus(data?.error || t('todo.startAgentFailed'), true);
      return;
    }
    renderList(data);
    openTodoAgentChat(data.chat, {
      initialPrompt: data.initialPrompt,
      reused: !!data.reused,
    });
    showPanelFn('chat');
    setStatus(data.reused ? t('todo.openedLinkedChat') : t('todo.startedAgent'));
  } catch {
    setStatus(t('todo.networkError'), true);
  }
}

/** @param {Event} e */
async function onStatusChange(e) {
  const id = e?.detail?.id;
  if (!id) return;
  const status = e.detail?.status || e.detail?.value;
  if (!status) return;
  try {
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
async function onDelete(e) {
  const id = e?.detail?.id;
  if (!id) return;
  await deleteTodoWithConfirm(String(id));
}

export function refreshTodoList() {
  loadCollapsed();
  loadStatusFilter();
  void api.getAgentSdkStatus().then((data) => {
    sdkReady = !!data?.ready;
  }).catch(() => {});
  return api
    .getTodos()
    .then((data) => {
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
    })
    .catch(() => {
      setStatus(t('todo.loadError'), true);
      renderList({ items: [] });
    });
}

/**
 * @param {{ showPanel?: (panelId: string) => void }} [options]
 */
export function initTodoPanel(options = {}) {
  if (typeof options.showPanel === 'function') {
    showPanelFn = options.showPanel;
  }
  listEl = document.getElementById('todo-list');
  statusEl = document.getElementById('todo-status');
  hintEl = document.getElementById('todo-cwd-hint');
  ensureStatusFilterUi(document.querySelector('#todo-panel .todo-toolbar'));
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
    if (statusFilterMenu?.api.isOpen()) renderStatusFilterMenuItems();
    if (latestItems.length || listEl?.querySelector('.todo-empty')) renderList({ items: latestItems });
  });
}
