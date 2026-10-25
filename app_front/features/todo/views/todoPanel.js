import * as api from '../../../core/api/index.js';
import { getChatsList, getTerminalStateMetaPublic } from '../../chat/index.js';
import '../../../components/ui/cr-todo-review-badge.js';
import '../../../components/todo/cr-todo-row.js';
import { installPerfProbe } from '../../../lib/perfProbe.js';
import { subscribeSidebarChatRowStatusPatch } from '../../sidebar/sidebarChatRowRefreshBus.js';
import { t } from '../../../i18n/index.js';
import { registerViewMemoryRestoreHandler } from '../../../app/appShell/viewMemoryBridge.js';
import { canAddTodoChild } from '../todoTreeView.js';
import { paintTodoStatusIcon } from './todoRowPaint.js';
import '../../../components/ui/cr-bar-select.js';
import '../../../components/ui/cr-bar-input.js';
import '../../../components/ui/cr-bar-textarea.js';
import '../../../components/ui/cr-bar-button.js';
import '../../../components/ui/cr-checkbox.js';
import '../../../components/ui/cr-dialog.js';
import '../../../components/ui/cr-tabs.js';
import '../../../components/ui/cr-todo-card.js';
import '../crTodoUsage.js';
import { initWatcherPanel } from '../../watcher/watcherPanel.js';
import {
  onBatchCheckboxChange,
  onBatchPanelVisibilityChange,
} from '../services/todoBatchFlow.js';
import { findItem, syncEditorItem } from '../services/todoDetail.js';
import { onTodoReviewChanged, onTodoWorkspaceChange } from '../services/todoFieldHandlers.js';
import { refreshTodoList, retryWhenOffline } from '../services/todoListRefresh.js';
import {
  scheduleTodoViewMemoryCapture,
  setStatus,
  todoScrollContainer,
  tryApplyPendingTodoViewMemory,
} from '../services/todoPanelContext.js';
import { S } from '../state/todoPanelState.js';
import {
  ensureBatchBanner,
  paintBatchActionBar,
  paintBatchBanner,
  syncBatchSelectTrigger,
} from './todoBatchView.js';
import { renderList } from './todoListRender.js';
import { getTodoWorkspaceFolder, getTodoWorkspaceFile } from '../todoWorkspaceScope.js';
import { onRowMenuTriggerKeydown, openWatcherChat } from './todoRowMenu.js';
import { repaintTodoRowBadges } from './todoRowRender.js';
import {
  ensureBatchSelectionUi,
  ensureStatusFilterUi,
  ensureUsageUi,
  renderStatusFilterMenuItems,
  renderTodoSortMenuItems,
  syncStatusFilterTriggerLabel,
  syncTodoSortTrigger,
} from './todoToolbar.js';

export { openTodo, continueTodo, loadTodoSummary } from '../services/todoDetail.js';
export { repaintTodoRowBadges, computeTodoRowSignature } from './todoRowRender.js';
export { startTodoAgentForVoice } from '../services/todoAgentStart.js';
export { refreshTodoList } from '../services/todoListRefresh.js';

/**
 * @param {{ showPanel?: (panelId: string) => void }} [options]
 */
export function initTodoPanel(options = {}) {
  installPerfProbe();
  if (typeof options.showPanel === 'function') {
    S.showPanelFn = options.showPanel;
  }
  S.listEl = document.getElementById('todo-list');
  const listRoot = S.listEl;
  const deferredRoot = document.getElementById('todo-deferred-list');
  const tabs = document.getElementById('todo-tabs');
  const tabPanels = [...document.querySelectorAll('#todo-panel [data-todo-tab-panel]')];
  // Filter, search and batch selection drive the todo tree, so the toolbar only
  // shows on the tabs that render it (List and Later).
  const toolbarEl = document.querySelector('#todo-panel .todo-toolbar');
  const applyTodoTab = (value) => {
    const active = value || 'list';
    S.todoTab = active;
    S.listEl = active === 'deferred' ? deferredRoot : listRoot;
    tabPanels.forEach((panel) => { panel.hidden = panel.dataset.todoTabPanel !== active; });
    if (toolbarEl) toolbarEl.hidden = active !== 'list' && active !== 'deferred';
    if (active === 'list' || active === 'deferred') renderList({ items: S.latestItems });
  };
  if (tabs) {
    // Listener first: the restore triggered by workspaceKey emits a change.
    tabs.addEventListener('cr-tabs-change', (event) => applyTodoTab(event.detail?.value));
    tabs.workspaceKey = getTodoWorkspaceFile() || getTodoWorkspaceFolder();
    applyTodoTab(tabs.querySelector('[aria-selected="true"]')?.dataset.tab || 'list');
  }
  const setTabCount = (value, count, label) => {
    if (!tabs?.setCount) return;
    tabs.setCount(value, count, label, true);
    if (!Number(count) && S.todoTab === value) {
      tabs.select(tabs.querySelector('[data-tab="list"]'));
      applyTodoTab('list');
    }
  };
  window.addEventListener('cretli:todo-blocked-count-changed', (event) => {
    setTabCount('blocked', event.detail?.count, t('todo.tabBlocked'));
  });
  window.addEventListener('cretli:todo-deferred-count-changed', (event) => {
    setTabCount('deferred', event.detail?.count, t('todo.tabDeferred'));
  });
  // One delegated handler for all rows: row menus are lazy, so this opens the
  // first ArrowDown before any per-row dropdown instance exists.
  S.listEl?.addEventListener('keydown', onRowMenuTriggerKeydown);
  // cr-checkbox emits cr-change; one delegated listener covers every row.
  S.listEl?.addEventListener('cr-change', onBatchCheckboxChange);
  deferredRoot?.addEventListener('keydown', onRowMenuTriggerKeydown);
  deferredRoot?.addEventListener('cr-change', onBatchCheckboxChange);
  S.statusEl = document.getElementById('todo-status');
  S.hintEl = document.getElementById('todo-cwd-hint');
  window.addEventListener('cretli-active-workspace-changed', (event) => {
    onTodoWorkspaceChange(event);
    if (tabs) {
      tabs.workspaceKey = event.detail?.workspaceFile || event.detail?.workspaceFolder || 'default';
      tabs.restore?.();
      // cr-tabs restores the selection without emitting a change event. Apply
      // the panel state explicitly so the tab and its content cannot diverge.
      applyTodoTab(tabs.querySelector('[aria-selected="true"]')?.dataset.tab || 'list');
    }
  });
  document.addEventListener('visibilitychange', onBatchPanelVisibilityChange);
  if (!S.offlineListenersBound) {
    S.offlineListenersBound = true;
    window.addEventListener('online', retryWhenOffline);
    document.addEventListener('visibilitychange', retryWhenOffline);
  }
  window.addEventListener('cretli:todo-changed', onTodoReviewChanged);
  let lastStatusPatchKey = '';
  subscribeSidebarChatRowStatusPatch(() => {
    // Selecting another chat fires this patch without changing any chat state:
    // repaint the icons only when the states behind them (or the rows) moved.
    const key = `${S.latestItems.length}|${getChatsList().map((chat) => `${chat.id}:${getTerminalStateMetaPublic(chat)?.tone || ''}`).join(',')}`;
    if (key === lastStatusPatchKey && S.listEl?.querySelector('.todo-row')) return;
    lastStatusPatchKey = key;
    S.listEl?.querySelectorAll('.todo-row').forEach((el) => {
      const item = findItem(el.dataset.id);
      if (item) paintTodoStatusIcon(el, item, S.latestItems);
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
    S.pendingParentId = '';
  };

  S.openNewTodoModal = () => {
    if (!modalEl) return;
    modalEl.hidden = false;
    newOpenBtn?.setAttribute('aria-expanded', 'true');
    if (titleInp && 'value' in titleInp) titleInp.value = '';
    if (bodyInp && 'value' in bodyInp) bodyInp.value = '';
    titleInp?.focus?.();
  };

  refreshBtn?.addEventListener('click', () => {
    // An explicit refresh must reach the server, never the short-lived list cache.
    api.invalidateTodoListCache();
    refreshTodoList();
  });
  newOpenBtn?.addEventListener('click', () => {
    S.pendingParentId = '';
    S.openNewTodoModal();
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
    const parentId = S.pendingParentId;
    if (parentId && !canAddTodoChild(S.latestItems, parentId)) {
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
    syncTodoSortTrigger();
    syncBatchSelectTrigger();
    if (S.statusFilterMenu?.api.isOpen()) renderStatusFilterMenuItems();
    if (S.sortMenu?.api.isOpen()) renderTodoSortMenuItems();
    if (S.latestItems.length || S.listEl?.querySelector('.todo-empty')) renderList({ items: S.latestItems });
    paintBatchBanner();
    paintBatchActionBar();
  });
  registerViewMemoryRestoreHandler('todo', (slice) => {
    S.pendingTodoViewMemory = slice;
    tryApplyPendingTodoViewMemory();
  });
  todoScrollContainer()?.addEventListener('scroll', () => scheduleTodoViewMemoryCapture(), { passive: true });
}
