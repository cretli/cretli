import * as api from '../../../core/api/index.js';
import { getChatsList, getTerminalStateMetaPublic } from '../../chat/index.js';
import { resolveTodoStatusIcon } from '../todoStatusIcon.js';
import { hasApprovedAncestorPlan } from '../state/todoStage.js';
import { t } from '../../../i18n/index.js';
import { preloadMarkdown } from '../../../lib/render-markdown.js';
import { sameAssignee } from '../services/todoIntegrationRules.js';
import { findTodoRecoveryState } from '../todoRecoveryView.js';
import { getWatcherView } from '../../watcher/watcherPanel.js';
import { bindCardHandlers } from '../services/todoCardActions.js';
import { applyEditorRelatedTodos, findItem, loadTodoDetail } from '../services/todoDetail.js';
import { setStatus } from '../services/todoPanelContext.js';
import { S } from '../state/todoPanelState.js';
import { renderList } from './todoListRender.js';

export function ensureEditor() {
  if (S.editorDialog) return;
  const dialog = document.createElement('cr-dialog');
  dialog.className = 'todo-editor-dialog';
  dialog.closable = true;
  dialog.closeLabel = t('todo.closeEditor');
  dialog.style.setProperty('--cr-dialog-max-width', '40rem');
  const wrap = document.createElement('div');
  wrap.className = 'todo-editor';
  const card = document.createElement('cr-todo-card');
  card.className = 'todo-card';
  bindCardHandlers(card);
  wrap.appendChild(card);
  dialog.appendChild(wrap);
  dialog.addEventListener('cr-dialog-close', () => {
    S.editorTodoId = '';
    S.editorTabTodoId = '';
  });
  document.body.appendChild(dialog);
  S.editorDialog = dialog;
  S.editorCard = card;
}

export function openEditor(id) {
  const item = findItem(id);
  if (!item) return;
  if (item.listSlim === true) {
    // Lean list row: the editor must never show (or save) a truncated body.
    void loadTodoDetail(id).then((ok) => {
      if (ok) openEditor(id);
      else setStatus(t('todo.loadError'), true);
    });
    return;
  }
  ensureEditor();
  if (!S.editorDialog || !S.editorCard) return;
  S.editorTodoId = id;
  S.editorDialog.heading = t('todo.editTask');
  S.editorCard.item = item;
  S.editorCard.statusIcon = resolveTodoStatusIcon(item, S.latestItems, getChatsList(), getTerminalStateMetaPublic);
  S.editorCard.planInherited = hasApprovedAncestorPlan(S.latestItems, item);
  S.editorCard.recoveryState = findTodoRecoveryState(getWatcherView(), id);
  S.editorCard.hasChildren = S.latestItems.some((row) => row.parentId === item.id);
  applyEditorRelatedTodos(item);
  S.editorCard.newChatHarness = '';
  S.editorCard.bodyPreview = false;
  // A different todo always starts on its plan (or notes when it has none);
  // re-renders of the same todo (renderList/syncEditorItem) keep the user's tab
  // and drafts.
  if (S.editorTabTodoId !== id) {
    S.editorTabTodoId = id;
    const hasPlan = typeof item.plan?.markdown === 'string' && item.plan.markdown.trim() !== '';
    S.editorCard.activeTab = hasPlan ? 'plan' : 'notes';
  }
  S.editorDialog.show();
  // The card rendered while the dialog was hidden, so auto-grow saw a
  // zero-height control; recompute once it has been laid out.
  requestAnimationFrame(() => {
    S.editorCard?.querySelectorAll('cr-bar-textarea').forEach((el) => {
      if (el instanceof HTMLElement && 'refreshAutoGrow' in el) el.refreshAutoGrow();
    });
  });
  // A preview rendered before markdown-it loads shows escaped text; re-render
  // the card once the shared renderer is ready.
  void preloadMarkdown().then(() => S.editorCard?.requestUpdate());
}

export function closeEditor() {
  S.editorTodoId = '';
  S.editorTabTodoId = '';
  S.editorDialog?.hide();
}

/** @param {() => Promise<void>} task */
export function queueEditorSave(task) {
  S.editorSaveQueue = S.editorSaveQueue.then(task, task);
  return S.editorSaveQueue;
}

/** @param {object | null} assignee */
export function saveEditorAssignee(assignee) {
  const todoId = S.editorTodoId;
  if (!todoId) return Promise.resolve();
  return queueEditorSave(() => patchEditorAssignee(todoId, assignee));
}

/**
 * @param {string} todoId
 * @param {object | null} assignee
 */
export async function patchEditorAssignee(todoId, assignee) {
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
export function onEditorAssigneeChange(e) {
  const assignee = e?.detail?.assignee && typeof e.detail.assignee === 'object' ? e.detail.assignee : null;
  void saveEditorAssignee(assignee);
}

/** @param {string} runMode */
export function saveEditorRunMode(runMode) {
  const todoId = S.editorTodoId;
  if (!todoId) return Promise.resolve();
  return queueEditorSave(() => patchEditorRunMode(todoId, runMode));
}

/**
 * @param {string} todoId
 * @param {string} runMode
 */
export async function patchEditorRunMode(todoId, runMode) {
  const next = runMode === 'sequential' ? 'sequential' : 'parallel';
  const current = findItem(todoId)?.runMode === 'parallel' ? 'parallel' : 'sequential';
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
export function onEditorRunModeChange(e) {
  void saveEditorRunMode(e?.detail?.runMode);
}

/** @param {string} executionMode */
export function saveEditorExecutionMode(executionMode) {
  const todoId = S.editorTodoId;
  if (!todoId) return Promise.resolve();
  return queueEditorSave(() => patchEditorExecutionMode(todoId, executionMode));
}

/**
 * @param {string} todoId
 * @param {string} executionMode
 */
export async function patchEditorExecutionMode(todoId, executionMode) {
  const allowed = ['inherit', 'worktree', 'project'];
  const next = allowed.includes(executionMode) ? executionMode : 'inherit';
  const current = ['worktree', 'project'].includes(findItem(todoId)?.executionMode)
    ? findItem(todoId).executionMode
    : 'inherit';
  if (current === next) return;
  try {
    const data = await api.patchTodo(todoId, { executionMode: next });
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
export function onEditorExecutionModeChange(e) {
  void saveEditorExecutionMode(e?.detail?.executionMode);
}
