import * as api from '../../../core/api/index.js';
import { probeSync, probeStart, probeEnd } from '../../../lib/perfProbe.js';
import { offlineRetryDelay } from '../todoOfflineState.js';
import { t } from '../../../i18n/index.js';
import { getTodoWorkspaceFolder, todoWorkspaceMatches } from '../todoWorkspaceScope.js';
import {
  getViewContextState,
  isViewContextScopedAccessAllowed,
  reportViewContextResourceConflict,
} from '../../../app/appShell/viewContextBridge.js';
import { refreshWatcherPanel } from '../../watcher/watcherPanel.js';
import { syncTrackedBatch } from './todoBatchFlow.js';
import { resetTodoWorkspaceView } from './todoFieldHandlers.js';
import {
  loadCollapsed,
  loadIntegrationFilter,
  loadReviewFilter,
  loadStatusFilter,
  loadTodoSort,
  setStatus,
} from './todoPanelContext.js';
import { LIST_SKELETON_ROWS, S, batchListGate, listModel } from '../state/todoPanelState.js';
import { applyIntegrationLock } from '../views/todoBatchView.js';
import { renderList } from '../views/todoListRender.js';
import { syncStatusFilterTriggerLabel, syncTodoSortTrigger } from '../views/todoToolbar.js';
import { createListSkeleton } from '../views/todoDomBuild.js';

/**
 * Loading feedback for the task list: the refresh button spins on every fetch,
 * and a list with nothing to show yet gets placeholder rows instead of a blank
 * panel. `renderList` replaces the placeholders as soon as data arrives.
 *
 * @param {boolean} loading
 */
export function setListLoading(loading) {
  const refreshBtn = document.getElementById('todo-refresh-btn');
  refreshBtn?.classList.toggle('todo-refresh--loading', loading);
  refreshBtn?.setAttribute('aria-busy', loading ? 'true' : 'false');
  S.listEl?.setAttribute('aria-busy', loading ? 'true' : 'false');
  if (!loading || !S.listEl || S.listEl.querySelector('.todo-rows')) return;
  S.listEl.replaceChildren(createListSkeleton(LIST_SKELETON_ROWS, t('todo.loading')));
}

/**
 * True when `data` equals what is already painted: same items, a rendered row
 * tree in the DOM and no skeleton/empty placeholder replacing it.
 *
 * @param {{ items?: Array<object> } | null | undefined} data
 */
export function isUnchangedListPayload(data) {
  if (!S.listEl || !Array.isArray(data?.items) || !data.items.length) return false;
  if (!S.latestItems.length || !S.listEl.querySelector('.todo-rows')) return false;
  if (data.items.length !== S.latestItems.length) return false;
  // The server hashes the whole payload into `rev`; equal revisions mean equal rows.
  return typeof data.rev === 'string' && data.rev !== '' && data.rev === S.latestListRev;
}

export function refreshTodoList() {
  if (!isViewContextScopedAccessAllowed()) {
    return Promise.resolve();
  }
  const generation = ++S.refreshGeneration;
  const folder = getTodoWorkspaceFolder();
  resetTodoWorkspaceView();
  const isCurrent = () => generation === S.refreshGeneration && todoWorkspaceMatches(folder);
  loadCollapsed();
  loadStatusFilter();
  loadReviewFilter();
  loadIntegrationFilter();
  loadTodoSort();
  syncStatusFilterTriggerLabel();
  syncTodoSortTrigger();
  void refreshWatcherPanel();
  // Restore the banner and the poll loop after a reload or workspace switch.
  const batchListToken = batchListGate.next();
  void api.getIntegrateBatch(folder).then((data) => {
    if (!isCurrent() || !batchListGate.isLatest(batchListToken) || !data?.ok) return;
    syncTrackedBatch(data.batches);
    applyIntegrationLock(data.lock);
  }).catch(() => {});
  // Readiness only flips once per server start; re-ask only while it is not ready.
  if (!S.sdkReady) {
    void api.getAgentSdkStatus().then((data) => {
      S.sdkReady = !!data?.ready;
    }).catch(() => {});
  }
  setListLoading(true);
  const fetchSpan = probeStart('todo.fetch');
  return api
    .getTodos(folder, { slim: true })
    .finally(() => {
      probeEnd(fetchSpan);
      if (generation !== S.refreshGeneration) return;
      setListLoading(false);
      // A response that is discarded below must not leave placeholders behind.
      S.listEl?.querySelector('.todo-skeleton')?.remove();
    })
    .then((data) => {
      if (!isCurrent()) return;
      if (data?.cwd && folder && !todoWorkspaceMatches(data.requestedFolder || data.cwd, folder)) return;
      if (!data?.ok) {
        setStatus(data?.error || t('todo.loadFailed'), true);
        if (S.hintEl) S.hintEl.textContent = '';
        renderList({ items: [] });
        return;
      }
      if (S.hintEl) {
        if (data.cwd) {
          S.hintEl.textContent = data.cwd;
          S.hintEl.hidden = false;
        } else {
          S.hintEl.textContent = '';
          S.hintEl.hidden = true;
        }
      }
      probeSync('todo.applySuccess', () => listModel.applySuccess(data.items));
      clearOfflineState();
      setStatus('');
      // Re-showing the tab refetches; an identical payload must not rebuild
      // 200+ rows (the dominant long task on tab switch).
      if (!probeSync('todo.isUnchanged', () => isUnchangedListPayload(data))) renderList(data);
      probeSync('todo.notifyViewContextTodoScope', () => notifyViewContextTodoScope(data));
    })
    .catch((error) => {
      if (!isCurrent()) return;
      if (listModel.applyFailure(error) === 'offline') {
        // Keep the last rendered list; retry quietly.
        showOfflineState();
        return;
      }
      setStatus(t('todo.loadError'), true);
      renderList({ items: [] });
    });
}

export function clearOfflineState() {
  if (S.offlineRetryTimer) clearTimeout(S.offlineRetryTimer);
  S.offlineRetryTimer = 0;
  document.getElementById('todo-offline-note')?.remove();
}

export function showOfflineState() {
  if (!document.getElementById('todo-offline-note') && S.statusEl?.parentNode) {
    const note = document.createElement('div');
    note.id = 'todo-offline-note';
    note.className = 'todo-status todo-offline-note';
    note.setAttribute('role', 'status');
    note.textContent = t('todo.offline');
    S.statusEl.parentNode.insertBefore(note, S.statusEl.nextSibling);
  }
  if (S.offlineRetryTimer) clearTimeout(S.offlineRetryTimer);
  S.offlineRetryTimer = setTimeout(() => {
    S.offlineRetryTimer = 0;
    void refreshTodoList();
  }, offlineRetryDelay(listModel.attempt - 1));
}

export function retryWhenOffline() {
  if (!listModel.offline) return;
  if (document.visibilityState === 'hidden') return;
  if (S.offlineRetryTimer) clearTimeout(S.offlineRetryTimer);
  S.offlineRetryTimer = 0;
  void refreshTodoList();
}

/**
 * Stage 2 ownership check: when this tab's view context names a TODO (a
 * `/todo?todo=` or `/git?scope=todo&todo=` link) and the explicit `ws/folder`
 * list does not contain it, report the conflict instead of pretending the
 * scope resolved. No message without an explicit link target.
 *
 * @param {{ items?: Array<object> } | null | undefined} data
 */
export function notifyViewContextTodoScope(data) {
  const state = getViewContextState();
  if (!state?.target) return;
  const resource = state.route?.resource;
  const targetId = String(resource?.type === 'todo' ? resource.id : '').trim();
  if (!targetId) return;
  const items = Array.isArray(data?.items) ? data.items : [];
  const row = items.find((item) => item?.id === targetId) || null;
  reportViewContextResourceConflict('todo', row);
}
