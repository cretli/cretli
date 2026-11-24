/**
 * Filter menu of the sidebar search row: per-browser checkboxes that narrow the
 * chat list. The button stays neutral: sort and filters always have some state, so "active" says nothing.
 */

import { closeAllOpenDropdowns, initDropdown } from '../../lib/dropdown.js';
import { t } from '../../i18n/index.js';
import {
  readSidebarOnlyActiveWorkspaceFlag,
  readSidebarOnlyLiveChatsFlag,
  writeSidebarOnlyActiveWorkspaceFlag,
  writeSidebarOnlyLiveChatsFlag,
  SIDEBAR_ONLY_ACTIVE_WORKSPACE_KEY,
  SIDEBAR_ONLY_LIVE_CHATS_KEY,
} from './sidebarOnlyActiveFilter.js';
import {
  SIDEBAR_FAVORITES_FIRST_KEY,
  SIDEBAR_ONLY_FAVORITES_KEY,
  SIDEBAR_SORT_MODES,
  readSidebarFavoritesFirstFlag,
  readSidebarOnlyFavoritesFlag,
  readSidebarSortMode,
  writeSidebarFavoritesFirstFlag,
  writeSidebarOnlyFavoritesFlag,
  writeSidebarSortMode,
} from './sidebarListSort.js';

const FILTERS = [
  {
    id: 'workspace',
    storageKey: SIDEBAR_ONLY_ACTIVE_WORKSPACE_KEY,
    labelKey: 'sidebar.filterActiveWorkspace',
    read: readSidebarOnlyActiveWorkspaceFlag,
    write: writeSidebarOnlyActiveWorkspaceFlag,
  },
  {
    id: 'live',
    storageKey: SIDEBAR_ONLY_LIVE_CHATS_KEY,
    labelKey: 'sidebar.filterLiveChats',
    hintKey: 'sidebar.filterLiveChatsHint',
    read: readSidebarOnlyLiveChatsFlag,
    write: writeSidebarOnlyLiveChatsFlag,
  },
  {
    id: 'favorites',
    storageKey: SIDEBAR_ONLY_FAVORITES_KEY,
    labelKey: 'sidebar.filterFavorites',
    read: readSidebarOnlyFavoritesFlag,
    write: writeSidebarOnlyFavoritesFlag,
  },
];

const FAVORITES_FIRST = {
  id: 'favoritesFirst',
  storageKey: SIDEBAR_FAVORITES_FIRST_KEY,
  labelKey: 'sidebar.sortFavoritesFirst',
  read: readSidebarFavoritesFirstFlag,
  write: writeSidebarFavoritesFirstFlag,
};

const SORT_LABEL_KEYS = {
  created: 'sidebar.sortCreated',
  updated: 'sidebar.sortUpdated',
  title: 'sidebar.sortTitle',
};

/**
 * @param {{ onFilterChanged?: () => void }} [deps]
 * @returns {void}
 */
export function initSidebarFilterMenu(deps = {}) {
  const trigger = document.getElementById('sidebar-filter-btn');
  if (!trigger) return;

  const panel = document.createElement('div');
  panel.className = 'chat-list-modal todo-status-filter-panel sidebar-filter-panel';
  panel.hidden = true;
  const list = document.createElement('div');
  list.className = 'chat-list-panel todo-status-filter-list';
  list.setAttribute('role', 'menu');
  panel.appendChild(list);
  document.body.appendChild(panel);

  function appendCheckboxRow(filter) {
      const row = document.createElement('div');
      row.className = 'todo-status-filter-row';
      row.dataset.filterId = filter.id;
      if (filter.hintKey) row.title = t(filter.hintKey);
      const box = /** @type {any} */ (document.createElement('cr-checkbox'));
      box.checked = filter.read();
      box.setAttribute('aria-label', t(filter.labelKey));
      const text = document.createElement('span');
      text.textContent = t(filter.labelKey);
      box.appendChild(text);
      row.appendChild(box);
      list.appendChild(row);
  }

  function renderRows() {
    list.textContent = '';
    for (const filter of FILTERS) appendCheckboxRow(filter);
    const heading = document.createElement('div');
    heading.className = 'sidebar-filter-heading';
    heading.textContent = t('sidebar.sortHeading');
    list.appendChild(heading);
    const current = readSidebarSortMode();
    for (const mode of SIDEBAR_SORT_MODES) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'todo-status-filter-row sidebar-sort-row';
      item.dataset.sortMode = mode;
      item.setAttribute('role', 'menuitemradio');
      item.setAttribute('aria-checked', mode === current ? 'true' : 'false');
      const mark = document.createElement('span');
      mark.className = 'cr-radio-mark';
      mark.setAttribute('aria-hidden', 'true');
      const text = document.createElement('span');
      text.textContent = t(SORT_LABEL_KEYS[mode]);
      item.append(mark, text);
      list.appendChild(item);
    }
    appendCheckboxRow(FAVORITES_FIRST);
  }

  const dropdown = initDropdown({
    triggerEl: trigger,
    floatingEl: panel,
    compact: true,
    placement: 'bottom-end',
    minWidthPx: 220,
    maxHeightPx: 320,
    onOpen: renderRows,
    onClose: (reason) => {
      if (reason === 'escape') trigger.focus();
    },
  });

  // cr-checkbox toggles itself, clicks on the label text included.
  list.addEventListener('cr-change', (event) => {
    const row = /** @type {HTMLElement | null} */ (
      event.target instanceof Element ? event.target.closest('.todo-status-filter-row') : null
    );
    const filter = [...FILTERS, FAVORITES_FIRST].find((entry) => entry.id === row?.dataset.filterId);
    const box = /** @type {any} */ (row?.querySelector('cr-checkbox'));
    if (!filter || !box) return;
    filter.write(box.checked === true);
    deps.onFilterChanged?.();
  });

  list.addEventListener('click', (event) => {
    const item = /** @type {HTMLElement | null} */ (
      event.target instanceof Element ? event.target.closest('.sidebar-sort-row') : null
    );
    if (!item) return;
    writeSidebarSortMode(item.dataset.sortMode || '');
    renderRows();
    deps.onFilterChanged?.();
  });

  trigger.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!dropdown.isOpen()) closeAllOpenDropdowns();
    dropdown.toggle();
  });
}
