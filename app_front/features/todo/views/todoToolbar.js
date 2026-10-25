import { countTodoItemsByReviewState, parseReviewListFilter } from '../todoReviewBadge.js';
import { t } from '../../../i18n/index.js';
import { initDropdown, closeAllOpenDropdowns } from '../../../lib/dropdown.js';
import {
  filterTodoItemsByRootStatus,
  serializeTodoRootStatusFilter,
  TODO_INTEGRATION_FILTERS,
  TODO_INTEGRATION_PENDING_FILTERS,
  TODO_ITEM_STATUSES,
  TODO_SORT_MODES,
  parseTodoSortMode,
} from '../todoTreeView.js';
import { countTodoItemsByIntegrationState } from '../services/todoIntegrationRules.js';
import { toggleBatchSelectionMode } from '../services/todoBatchFlow.js';
import {
  isIntegrationPendingSelection,
  loadIntegrationFilter,
  loadReviewFilter,
  loadStatusFilter,
  loadTodoSort,
  saveIntegrationFilter,
  saveReviewFilter,
  saveTodoSort,
  scheduleTodoViewMemoryCapture,
  statusFilterStorageKey,
} from '../services/todoPanelContext.js';
import { S, todoList } from '../state/todoPanelState.js';
import { syncBatchSelectTrigger } from './todoBatchView.js';
import { renderList } from './todoListRender.js';
import { createSpan } from './todoDomBuild.js';

export function createFilterCountEl(count) {
  const el = document.createElement('span');
  el.className = 'todo-filter-count';
  el.textContent = String(count);
  return el;
}

export function integrationFilterLabel(filter) {
  if (filter === 'no_code_changes') return t('todo.integrationNoCodeDetail');
  return t(`todo.integrationFilter${filter.charAt(0).toUpperCase()}${filter.slice(1)}`);
}

export function reviewFilterLabel(filter) {
  return t(filter === 'stale' ? 'todo.filterReviewStale' : 'todo.filterReviewNone');
}

export function saveStatusFilter() {
  try {
    localStorage.setItem(
      statusFilterStorageKey(),
      JSON.stringify(serializeTodoRootStatusFilter(todoList.rootStatus.get()))
    );
  } catch {
    // Private mode can reject storage; filtering still works for this view.
  }
}

/**
 * @param {'idea' | 'ready' | 'doing' | 'done' | 'deferred'} status
 * @returns {string}
 */
export function todoStatusLabelKey(status) {
  if (status === 'ready') return 'todo.statusReady';
  if (status === 'doing') return 'todo.statusDoing';
  if (status === 'done') return 'todo.statusDone';
  if (status === 'deferred') return 'todo.statusDeferred';
  return 'todo.statusIdea';
}

export function formatStatusFilterTriggerLabel() {
  const parts = todoList.rootStatus.get()
    ? TODO_ITEM_STATUSES.filter((status) => todoList.rootStatus.get().has(status)).map((status) =>
      t(todoStatusLabelKey(status))
    )
    : [];
  if (todoList.review.get()) parts.push(reviewFilterLabel(todoList.review.get()));
  if (isIntegrationPendingSelection(todoList.integration.get())) parts.push(integrationFilterLabel('pending'));
  else if (todoList.integration.get().size) parts.push([...todoList.integration.get()].map(integrationFilterLabel).join(', '));
  return parts.length ? parts.join(', ') : t('todo.filterStatusAll');
}

export function syncStatusFilterTriggerLabel() {
  if (!S.statusFilterTrigger) return;
  const labelEl = S.statusFilterTrigger.querySelector('.todo-status-filter-trigger-label');
  const text = formatStatusFilterTriggerLabel();
  if (labelEl) labelEl.textContent = text;
  else S.statusFilterTrigger.append(text);
  S.statusFilterTrigger.title = t('todo.filterStatusTitle');
  S.statusFilterTrigger.setAttribute('aria-label', t('todo.filterStatusAria'));
}

export function renderStatusFilterMenuItems() {
  const entry = S.statusFilterMenu;
  if (!entry) return;
  const list = entry.list;
  list.textContent = '';
  const showAll = !todoList.rootStatus.get();
  const selected = todoList.rootStatus.get() || new Set(TODO_ITEM_STATUSES);
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
  addRow('all', t('todo.filterStatusAll'), showAll, S.latestItems.length);
  TODO_ITEM_STATUSES.forEach((status) => {
    const count = filterTodoItemsByRootStatus(S.latestItems, new Set([status])).length;
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
    box.checked = todoList.review.get() === filter;
    box.setAttribute('aria-label', reviewFilterLabel(filter));
    const text = document.createElement('span');
    text.textContent = reviewFilterLabel(filter);
    box.appendChild(text);
    row.append(box, createFilterCountEl(countTodoItemsByReviewState(S.latestItems, filter)));
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
      ? todoList.integration.get().size === 0
      : filter === 'pending'
        ? isIntegrationPendingSelection(todoList.integration.get())
        : todoList.integration.get().has(filter);
    box.setAttribute('aria-label', integrationFilterLabel(filter));
    const label = document.createElement('span');
    label.textContent = integrationFilterLabel(filter);
    box.appendChild(label);
    const count = filter === 'pending'
      ? TODO_INTEGRATION_PENDING_FILTERS.reduce((sum, key) => sum + countTodoItemsByIntegrationState(S.latestItems, key), 0)
      : countTodoItemsByIntegrationState(S.latestItems, filter);
    row.append(box, createFilterCountEl(count));
    list.appendChild(row);
  });
}

export function applyStatusFilterFromUi() {
  const entry = S.statusFilterMenu;
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
    todoList.setRootStatus(null);
  } else {
    todoList.setRootStatus(picked);
  }
  saveStatusFilter();
  syncStatusFilterTriggerLabel();
  if (S.latestItems.length || S.listEl?.querySelector('.todo-empty')) {
    renderList({ items: S.latestItems });
  }
  scheduleTodoViewMemoryCapture();
}

export function openUsageDialog() {
  if (!S.usageDialog) {
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
    S.usageDialog = dialog;
    S.usageSection = section;
  }
  S.usageDialog.heading = t('todo.usageDialogHeading');
  S.usageSection.active = true;
  S.usageSection.refresh();
  S.usageDialog.show();
}

export function ensureUsageUi() {
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
    if (S.usageSection?.active) S.usageSection.refresh();
  });
  window.addEventListener('cr-lang-changed', () => {
    btn.setAttribute('title', t('todo.usageOpenTitle'));
    btn.setAttribute('aria-label', t('todo.usageOpenTitle'));
    if (S.usageDialog) S.usageDialog.heading = t('todo.usageDialogHeading');
  });
}

export function ensureStatusFilterUi(toolbar) {
  if (!(toolbar instanceof HTMLElement) || S.statusFilterMenu) return;
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
  S.statusFilterTrigger = trigger;
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
        if (reason === 'escape' && S.statusFilterTrigger) S.statusFilterTrigger.focus();
      },
    }),
    panel,
    list,
  };
  S.statusFilterMenu = entry;
  // cr-checkbox toggles itself (clicks on the label text included); only keep the
  // "All" row and the status rows mutually consistent here.
  list.addEventListener('cr-change', (event) => {
    const reviewRow = event.target instanceof Element ? event.target.closest('.todo-review-filter-row') : null;
    if (reviewRow instanceof HTMLElement) {
      event.stopPropagation();
      const filter = parseReviewListFilter(reviewRow.dataset.reviewFilter);
      const reviewBox = reviewRow.querySelector('cr-checkbox');
      // The two review filters are mutually exclusive; unchecking clears it.
      todoList.setReview(reviewBox && 'checked' in reviewBox && reviewBox.checked ? filter : '');
      entry.list.querySelectorAll('.todo-review-filter-row').forEach((other) => {
        const box = other.querySelector('cr-checkbox');
        if (box && other !== reviewRow) box.checked = false;
      });
      saveReviewFilter();
      syncStatusFilterTriggerLabel();
      if (S.latestItems.length || S.listEl?.querySelector('.todo-empty')) renderList({ items: S.latestItems });
      scheduleTodoViewMemoryCapture();
      return;
    }
    const integrationRow = event.target instanceof Element ? event.target.closest('.todo-integration-filter-row') : null;
    if (integrationRow instanceof HTMLElement) {
      event.stopPropagation();
      const box = integrationRow.querySelector('cr-checkbox');
      const filter = String(integrationRow.dataset.integrationFilter || '');
      if (filter === 'all') {
        todoList.setIntegration([]);
        entry.list.querySelectorAll('.todo-integration-filter-row').forEach((other) => {
          if (other.dataset.integrationFilter !== 'all') other.querySelector('cr-checkbox').checked = false;
        });
      } else if (filter === 'pending' && box && 'checked' in box) {
        todoList.setIntegration(box.checked ? TODO_INTEGRATION_PENDING_FILTERS : []);
        entry.list.querySelectorAll('.todo-integration-filter-row').forEach((other) => {
          const key = String(other.dataset.integrationFilter || '');
          const otherBox = other.querySelector('cr-checkbox');
          if (!otherBox || key === 'pending') return;
          otherBox.checked = key === 'all' ? todoList.integration.get().size === 0 : todoList.integration.get().has(key);
        });
      } else if (box && 'checked' in box) {
        todoList.setIntegrationChecked(filter, box.checked);
        const allBox = entry.list.querySelector('[data-integration-filter="all"] cr-checkbox');
        if (allBox) allBox.checked = todoList.integration.get().size === 0;
        const pendingBox = entry.list.querySelector('[data-integration-filter="pending"] cr-checkbox');
        if (pendingBox) pendingBox.checked = isIntegrationPendingSelection(todoList.integration.get());
      }
      saveIntegrationFilter();
      syncStatusFilterTriggerLabel();
      if (S.latestItems.length || S.listEl?.querySelector('.todo-empty')) renderList({ items: S.latestItems });
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
  ensureTodoSortUi(trigger);
  ensureTodoSearchUi(toolbar, trigger);
}

/** @param {string} mode */
function todoSortLabel(mode) {
  return t(`todo.sort${mode.charAt(0).toUpperCase()}${mode.slice(1)}`);
}

export function syncTodoSortTrigger() {
  const trigger = S.sortTrigger;
  if (!trigger) return;
  const labelEl = trigger.querySelector('.todo-status-filter-trigger-label');
  if (labelEl) labelEl.textContent = todoSortLabel(S.todoSort);
  trigger.title = t('todo.sortTitle');
  trigger.setAttribute('aria-label', `${t('todo.sortTitle')}: ${todoSortLabel(S.todoSort)}`);
  trigger.classList.toggle('todo-sort-trigger--active', S.todoSort !== 'manual');
}

export function renderTodoSortMenuItems() {
  const entry = S.sortMenu;
  if (!entry) return;
  entry.list.textContent = '';
  TODO_SORT_MODES.forEach((mode) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'todo-sort-row';
    row.dataset.sortMode = mode;
    row.setAttribute('role', 'menuitemradio');
    const checked = S.todoSort === mode;
    row.setAttribute('aria-checked', String(checked));
    const icon = createSpan(`todo-sort-row-check mdi ${checked ? 'mdi-check' : ''}`, true);
    const label = document.createElement('span');
    label.textContent = todoSortLabel(mode);
    row.append(icon, label);
    entry.list.appendChild(row);
  });
}

/**
 * Sort dropdown next to the filter trigger. Sorting reorders root trees only;
 * children keep their sequential execution order.
 *
 * @param {HTMLElement} anchor
 */
export function ensureTodoSortUi(anchor) {
  if (S.sortMenu) return;
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'todo-status-filter-trigger todo-sort-trigger';
  trigger.setAttribute('aria-haspopup', 'menu');
  const label = document.createElement('span');
  label.className = 'todo-status-filter-trigger-label';
  trigger.append(createSpan('mdi mdi-sort', true), label);
  S.sortTrigger = trigger;
  const panel = document.createElement('div');
  panel.className = 'chat-list-modal todo-status-filter-panel';
  panel.hidden = true;
  const list = document.createElement('div');
  list.className = 'chat-list-panel todo-status-filter-list';
  list.setAttribute('role', 'menu');
  panel.appendChild(list);
  document.body.appendChild(panel);
  const entry = {
    api: initDropdown({
      triggerEl: trigger,
      floatingEl: panel,
      compact: true,
      placement: 'bottom-start',
      minWidthPx: 200,
      maxHeightPx: 320,
      onOpen: () => renderTodoSortMenuItems(),
      onClose: (reason) => {
        if (reason === 'escape' && S.sortTrigger) S.sortTrigger.focus();
      },
    }),
    panel,
    list,
  };
  S.sortMenu = entry;
  list.addEventListener('click', (event) => {
    const row = event.target instanceof Element ? event.target.closest('.todo-sort-row') : null;
    if (!(row instanceof HTMLElement)) return;
    S.todoSort = parseTodoSortMode(row.dataset.sortMode);
    saveTodoSort();
    syncTodoSortTrigger();
    entry.api.close?.();
    if (S.latestItems.length || S.listEl?.querySelector('.todo-empty')) renderList({ items: S.latestItems });
    scheduleTodoViewMemoryCapture();
  });
  trigger.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!entry.api.isOpen()) closeAllOpenDropdowns();
    entry.api.toggle();
  });
  loadTodoSort();
  syncTodoSortTrigger();
  anchor.parentNode?.insertBefore(trigger, anchor.nextSibling);
}

/**
 * Toolbar toggle for the bulk "integrate with agent" selection mode. On touch it
 * is also reachable by long-pressing an eligible row.
 *
 * @param {HTMLElement} toolbar
 */
export function ensureBatchSelectionUi(toolbar) {
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
export function ensureTodoSearchUi(toolbar, anchor) {
  if (toolbar.querySelector('.todo-search-btn')) return;
  const button = document.createElement('cr-icon-button');
  button.className = 'todo-search-btn';
  button.setAttribute('aria-label', t('todo.search'));
  button.title = t('todo.search');
  button.appendChild(createSpan('mdi mdi-magnify', true));
  const wrap = document.createElement('div');
  wrap.className = 'todo-search panel-toolbar';
  wrap.hidden = true;
  const field = document.createElement('div');
  field.className = 'todo-search-field';
  const input = document.createElement('cr-bar-input');
  input.setAttribute('type', 'text');
  input.setAttribute('placeholder', t('todo.searchPlaceholder'));
  input.setAttribute('aria-label', t('todo.search'));
  const clear = document.createElement('cr-icon-button');
  clear.className = 'todo-search-clear';
  clear.setAttribute('aria-label', t('todo.searchClear'));
  clear.title = t('todo.searchClear');
  clear.appendChild(createSpan('mdi mdi-close', true));
  clear.hidden = true;
  field.append(input, clear);
  const useFilters = document.createElement('cr-checkbox');
  useFilters.className = 'todo-search-use-filters';
  useFilters.checked = S.todoSearchUseFilters;
  useFilters.setAttribute('aria-label', t('todo.searchUseFilters'));
  useFilters.textContent = t('todo.searchUseFilters');
  wrap.append(field, useFilters);
  const apply = () => {
    S.todoSearchQuery = String(input.value || '');
    clear.hidden = !S.todoSearchQuery;
    button.classList.toggle('todo-search-btn--active', !!S.todoSearchQuery.trim());
    if (S.latestItems.length || S.listEl?.querySelector('.todo-empty')) renderList({ items: S.latestItems });
    scheduleTodoViewMemoryCapture();
  };
  input.addEventListener('input', apply);
  clear.addEventListener('click', () => {
    input.value = '';
    apply();
    input.focus?.();
  });
  useFilters.addEventListener('cr-change', () => {
    S.todoSearchUseFilters = useFilters.checked;
    apply();
  });
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
export function confirmAction(message) {
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') return true;
  return window.confirm(message);
}
