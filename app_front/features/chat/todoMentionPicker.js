/**
 * Modal list opened by `@todo` in the chat composer.
 */
import * as api from '../../core/api/index.js';
import { t } from '../../i18n/index.js';
import { escapeHtml } from './chatHtmlUtils.js';
import '../../components/ui/cr-dialog.js';
import '../../components/ui/cr-bar-input.js';
import '../../components/ui/cr-checkbox.js';
import {
  TODO_MENTION_OPEN_STATUSES,
  buildTodoMentionRows,
  todoStatusLabelKey,
} from './todoMention.js';

/**
 * @param {{
 *   onSelect: (item: object) => void,
 *   onContinue: (item: object) => void,
 *   onClose?: () => void,
 *   getContinueBlock?: (item: object) => { chatId: string, title: string } | null,
 * }} options
 */
export function createTodoMentionPicker(options) {
  const onSelect = options.onSelect;
  const onContinue = options.onContinue;
  const onClose = typeof options.onClose === 'function' ? options.onClose : () => {};
  const getContinueBlock = typeof options.getContinueBlock === 'function' ? options.getContinueBlock : () => null;

  /** @type {HTMLElement | null} */
  let dialog = null;
  /** @type {HTMLElement | null} */
  let searchInput = null;
  /** @type {HTMLElement | null} */
  let listEl = null;
  /** @type {HTMLElement | null} */
  let hideDone = null;
  /** @type {HTMLElement | null} */
  let messageEl = null;
  /** @type {object[]} */
  let items = [];
  /** @type {string} */
  let loadError = '';
  /** @type {boolean} */
  let loading = false;
  /** @type {string} */
  let query = '';
  /** @type {boolean} */
  let opened = false;
  /** @type {boolean} */
  let closingFromChoice = false;

  function ensureDialog() {
    if (dialog) return;
    const root = document.createElement('cr-dialog');
    root.className = 'todo-mention-dialog';
    root.heading = t('sendBar.todoPickerTitle');
    root.style.setProperty('--cr-dialog-max-width', '28rem');
    root.innerHTML = `
      <div class="todo-mention-picker">
        <cr-bar-input class="todo-mention-search" type="search" placeholder="${escapeHtml(t('sendBar.todoPickerSearch'))}" aria-label="${escapeHtml(t('sendBar.todoPickerSearch'))}"></cr-bar-input>
        <label class="todo-mention-active">
          <cr-checkbox class="todo-mention-hide-done"></cr-checkbox>
          <span>${escapeHtml(t('sendBar.todoPickerHideDone'))}</span>
        </label>
        <p class="todo-mention-message" hidden></p>
        <div class="todo-mention-list" role="list"></div>
      </div>
    `;
    root.addEventListener('cr-dialog-close', () => {
      opened = false;
      if (closingFromChoice) {
        closingFromChoice = false;
        return;
      }
      onClose();
    });
    document.body.appendChild(root);
    dialog = root;
    searchInput = root.querySelector('.todo-mention-search');
    listEl = root.querySelector('.todo-mention-list');
    hideDone = root.querySelector('.todo-mention-hide-done');
    messageEl = root.querySelector('.todo-mention-message');
    searchInput?.addEventListener('input', () => {
      query = String(searchInput?.value || '');
      renderRows();
    });
    hideDone?.addEventListener('cr-change', () => renderRows());
  }

  function statusLabel(status) {
    const key = todoStatusLabelKey(status);
    return key ? t(key) : '';
  }

  /**
   * @param {string} status
   * @returns {string}
   */
  function statusIcon(status) {
    if (status === 'done') return 'mdi-check-circle';
    if (status === 'doing') return 'mdi-progress-clock';
    if (status === 'ready') return 'mdi-circle-slice-8';
    return 'mdi-circle-outline';
  }

  function renderMessage(text) {
    if (!(messageEl instanceof HTMLElement)) return;
    messageEl.hidden = !text;
    messageEl.textContent = text;
  }

  function renderRows() {
    if (!(listEl instanceof HTMLElement)) return;
    if (loading) {
      listEl.textContent = '';
      renderMessage(t('sendBar.todoPickerLoading'));
      return;
    }
    if (loadError) {
      listEl.textContent = '';
      renderMessage(loadError);
      return;
    }
    const statuses = hideDone?.checked ? TODO_MENTION_OPEN_STATUSES : null;
    const rows = buildTodoMentionRows(items, { query, statuses });
    listEl.textContent = '';
    renderMessage(rows.length ? '' : t('sendBar.todoPickerEmpty'));
    rows.forEach((entry) => {
      const item = entry.item;
      const status = String(item.status || 'idea');
      const row = document.createElement('div');
      row.className = 'todo-mention-row';
      row.dataset.status = status;
      row.style.setProperty('--todo-mention-level', String(entry.level));
      row.setAttribute('role', 'listitem');
      const pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'todo-mention-pick';
      const mark = document.createElement('span');
      mark.className = `todo-mention-mark mdi ${statusIcon(status)}`;
      mark.title = statusLabel(status);
      mark.setAttribute('aria-hidden', 'true');
      const title = document.createElement('span');
      title.className = 'todo-mention-title';
      title.textContent = String(item.title || '');
      pick.append(mark, title);
      const block = getContinueBlock(item);
      const cont = document.createElement('button');
      cont.type = 'button';
      cont.className = 'todo-mention-continue';
      cont.innerHTML = '<span class="mdi mdi-play" aria-hidden="true"></span>';
      cont.setAttribute('aria-label', t('sendBar.todoContinue'));
      if (block) {
        const busy = t('sendBar.todoContinueBusy', { title: block.title });
        pick.disabled = true;
        pick.title = busy;
        cont.disabled = true;
        cont.title = busy;
        const lock = document.createElement('span');
        lock.className = 'todo-mention-lock mdi mdi-lock-outline';
        lock.title = busy;
        lock.setAttribute('aria-label', busy);
        pick.append(lock);
      } else {
        cont.title = t('sendBar.todoContinue');
        pick.addEventListener('click', () => choose(item, onSelect));
        cont.addEventListener('click', () => choose(item, onContinue));
      }
      row.append(pick, cont);
      listEl.appendChild(row);
    });
  }

  /**
   * @param {object} item
   * @param {(item: object) => void} handler
   */
  function choose(item, handler) {
    closingFromChoice = true;
    opened = false;
    dialog?.hide();
    handler(item);
  }

  async function loadItems() {
    loading = true;
    loadError = '';
    renderRows();
    try {
      const data = await api.getTodos();
      if (!data?.ok) {
        items = [];
        loadError = data?.error || t('sendBar.todoPickerLoadError');
      } else {
        items = Array.isArray(data.items) ? data.items : [];
      }
    } catch {
      items = [];
      loadError = t('sendBar.todoPickerLoadError');
    } finally {
      loading = false;
      if (opened) renderRows();
    }
  }

  return {
    isOpen() {
      return opened;
    },
    /**
     * @param {string} nextQuery
     */
    open(nextQuery) {
      ensureDialog();
      query = String(nextQuery || '');
      if (searchInput) searchInput.value = query;
      opened = true;
      dialog?.show();
      if (!items.length && !loading) void loadItems();
      else renderRows();
      searchInput?.focus();
    },
    /**
     * @param {string} nextQuery
     */
    setQuery(nextQuery) {
      if (!opened) return;
      query = String(nextQuery || '');
      if (searchInput && searchInput.value !== query) searchInput.value = query;
      renderRows();
    },
    close() {
      if (!opened) return;
      opened = false;
      dialog?.hide();
    },
  };
}
