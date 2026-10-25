import * as api from '../../../core/api/index.js';
import { createTodoFieldSaver } from '../todoFieldSaver.js';
import { createTodoReviewRefresher } from '../todoReviewRefresh.js';
import { t } from '../../../i18n/index.js';
import { getTodoWorkspaceFolder, todoWorkspaceMatches } from '../todoWorkspaceScope.js';
import { deferTodoItem, restoreTodoItem } from './todoAgentStart.js';
import { resetBatchWorkspaceView } from './todoBatchFlow.js';
import { disposeAllRowMenus } from './todoCardActions.js';
import { findItem, syncEditorItem } from './todoDetail.js';
import { refreshTodoList } from './todoListRefresh.js';
import { setEditorSaveState, setStatus } from './todoPanelContext.js';
import { REVIEW_REFRESH_DEBOUNCE_MS, S, SAVE_SLOW_MS, detailCache } from '../state/todoPanelState.js';
import { closeEditor } from '../views/todoEditor.js';
import { renderList } from '../views/todoListRender.js';
import { deleteTodoWithConfirm, openWatcherChat } from '../views/todoRowMenu.js';

export function clearSaveSlowTimer() {
  if (S.saveSlowTimer) clearTimeout(S.saveSlowTimer);
  S.saveSlowTimer = 0;
}

/**
 * Optimistic single-field saves: the UI changes first, one PATCH follows, and a
 * failed request restores the previous value without reloading the tree.
 */
export const todoFieldSaver = createTodoFieldSaver({
  patch: (id, payload) => api.patchTodo(id, payload),
  read: (id, field) => findItem(id)?.[field],
  applyOptimistic: (id, field, value) => {
    S.latestItems = S.latestItems.map((row) => (String(/** @type {{ id?: string }} */ (row)?.id || '') === id ? { ...row, [field]: value } : row));
    renderList({ items: S.latestItems });
  },
  onSaving: () => {
    clearSaveSlowTimer();
    setEditorSaveState('saving', t('todo.saving'));
    S.saveSlowTimer = setTimeout(() => setEditorSaveState('saving', t('todo.savingSlow')), SAVE_SLOW_MS);
  },
  onSaved: (_id, _field, data) => {
    clearSaveSlowTimer();
    setStatus(t('todo.saved'), false);
    renderList(data);
  },
  rollback: (id, field, previous, error) => {
    clearSaveSlowTimer();
    S.latestItems = S.latestItems.map((row) => (String(/** @type {{ id?: string }} */ (row)?.id || '') === id ? { ...row, [field]: previous } : row));
    renderList({ items: S.latestItems });
    setStatus(error.kind === 'network' ? t('todo.networkError') : error.message || t('todo.saveError'), true);
  },
});

/** @param {Event} e */
export async function onStatusChange(e) {
  const id = e?.detail?.id;
  if (!id) return;
  const status = e.detail?.status || e.detail?.value;
  if (!status) return;
  if (status === 'deferred') {
    const item = findItem(id);
    if (item && item.status !== 'deferred') void deferTodoItem(item);
    return;
  }
  if (status === 'idea' && findItem(id)?.status === 'deferred') {
    void restoreTodoItem(findItem(id));
    return;
  }
  await todoFieldSaver.save(String(id), 'status', status);
}

/** @param {Event} e */
export async function onTitleBlur(e) {
  const id = e?.detail?.id;
  if (!id) return;
  const title = String(e?.detail?.title || '').trim();
  if (!title) {
    setStatus(t('todo.titleRequired'), true);
    syncEditorItem();
    S.editorCard?.requestUpdate();
    return;
  }
  await todoFieldSaver.save(String(id), 'title', title);
}

/** @param {Event} e */
export async function onBodyBlur(e) {
  const id = e?.detail?.id;
  if (!id) return;
  await todoFieldSaver.save(String(id), 'body', String(e?.detail?.body || ''));
}

/** @param {Event} e */
export async function onPlanApprove(e) {
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
export async function onDelete(e) {
  const id = e?.detail?.id;
  if (!id) return;
  await deleteTodoWithConfirm(String(id));
}

export function resetTodoWorkspaceView() {
  if (todoWorkspaceMatches(S.latestWorkspaceFolder)) return;
  closeEditor();
  S.pendingParentId = '';
  document.getElementById('todo-new-modal')?.setAttribute('hidden', '');
  disposeAllRowMenus();
  S.latestItems = [];
  detailCache.clear();
  S.latestWorkspaceFolder = getTodoWorkspaceFolder();
  if (S.listEl) S.listEl.textContent = '';
  if (S.hintEl) {
    S.hintEl.textContent = '';
    S.hintEl.hidden = true;
  }
  resetBatchWorkspaceView();
  setStatus('');
}

export function onTodoWorkspaceChange() {
  resetTodoWorkspaceView();
  if (document.getElementById('todo-panel')?.classList.contains('active')) {
    return refreshTodoList();
  }
}

export function getReviewRefresher() {
  if (S.reviewRefresher) return S.reviewRefresher;
  S.reviewRefresher = createTodoReviewRefresher({
    debounceMs: REVIEW_REFRESH_DEBOUNCE_MS,
    isActive: () => !!document.getElementById('todo-panel')?.classList.contains('active'),
    load: async () => {
      const folder = getTodoWorkspaceFolder();
      const generation = S.refreshGeneration;
      const data = await api.getTodos(folder, { slim: true });
      // A newer full refresh or a workspace switch owns the list now.
      if (generation !== S.refreshGeneration || !todoWorkspaceMatches(folder)) return null;
      if (!data?.ok || !Array.isArray(data.items)) return null;
      if (data.cwd && folder && !todoWorkspaceMatches(data.requestedFolder || data.cwd, folder)) return null;
      return data;
    },
    apply: (data) => renderList(data),
  });
  return S.reviewRefresher;
}

/**
 * Server pushed a `todo.review` refresh frame (or the socket reconnected, in
 * which case the frame has no todo id and may have been missed). A frame for
 * another selected workspace is ignored.
 *
 * @param {CustomEvent<{ workspaceFolder?: string, todoId?: string }>} [event]
 */
export function onTodoReviewChanged(event) {
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
export async function onReviewOpenReport(event) {
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
