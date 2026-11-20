/**
 * Composer chip for the todo attached to the next message, or the todo already
 * linked to this chat. Click opens the todo. Only the draft chip can be cleared.
 */
import { t } from '../../i18n/index.js';
import { todoStatusLabelKey } from '../chat/todoMention.js';

/**
 * @param {{
 *   host: HTMLElement,
 *   onOpen: (todoId: string) => void,
 *   onLayoutChange?: () => void,
 * }} options
 */
export function createSendBarTodoChip(options) {
  const host = options.host;
  const onOpen = options.onOpen;
  const onLayoutChange = typeof options.onLayoutChange === 'function' ? options.onLayoutChange : () => {};

  /** @type {{ id: string, title: string, status: string } | null} */
  let draft = null;
  /** @type {{ id: string, title: string, status: string } | null} */
  let linked = null;

  function statusLabel(status) {
    const key = todoStatusLabelKey(status);
    return key ? t(key) : '';
  }

  function render() {
    const item = draft || linked;
    host.textContent = '';
    if (!item?.id) {
      host.hidden = true;
      onLayoutChange();
      return;
    }
    host.hidden = false;
    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'send-keys-todo-chip-open';
    openBtn.title = t('sendBar.todoChipOpen');
    const title = document.createElement('span');
    title.className = 'send-keys-todo-chip-title';
    title.textContent = item.title || item.id;
    openBtn.appendChild(title);
    const status = statusLabel(item.status);
    if (status) {
      const badge = document.createElement('span');
      badge.className = 'send-keys-todo-chip-status';
      badge.textContent = status;
      openBtn.appendChild(badge);
    }
    openBtn.addEventListener('click', () => onOpen(item.id));
    host.appendChild(openBtn);
    if (draft) {
      const clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.className = 'send-keys-todo-chip-clear';
      clearBtn.title = t('sendBar.todoChipClear');
      clearBtn.setAttribute('aria-label', t('sendBar.todoChipClear'));
      clearBtn.innerHTML = '<span class="mdi mdi-close" aria-hidden="true"></span>';
      clearBtn.addEventListener('click', () => {
        draft = null;
        render();
      });
      host.appendChild(clearBtn);
    }
    onLayoutChange();
  }

  return {
    /**
     * @param {{ id: string, title?: string, status?: string } | null} item
     */
    setDraft(item) {
      if (!item?.id) {
        draft = null;
      } else {
        draft = {
          id: String(item.id),
          title: String(item.title || ''),
          status: String(item.status || ''),
        };
      }
      render();
    },
    /**
     * @param {{ id: string, title?: string, status?: string } | null} item
     */
    setLinked(item) {
      if (!item?.id) {
        linked = null;
      } else {
        linked = {
          id: String(item.id),
          title: String(item.title || ''),
          status: String(item.status || ''),
        };
      }
      render();
    },
    getDraft() {
      return draft;
    },
    clearDraft() {
      if (!draft) return;
      draft = null;
      render();
    },
  };
}
