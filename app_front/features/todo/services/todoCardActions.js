import * as api from '../../../core/api/index.js';
import { getCurrentLang, t } from '../../../i18n/index.js';
import { formatTodoRef } from '../../../../lib/todo-ref.js';
import { writeTextToClipboard } from '../../../lib/clipboard.js';
import {
  buildTodoMarkdown,
  normalizeTodoItemStatus,
  readTodoRowMeta,
  resolveTodoChatCountKey,
} from '../todoTreeView.js';
import { integrationFailureMessage } from './todoIntegrationRules.js';
import { refreshWatcherPanel } from '../../watcher/watcherPanel.js';
import {
  onOpenChat,
  onOpenGit,
  onReviewStart,
  onStartAgent,
  openTodoRefinePicker,
} from './todoAgentStart.js';
import { findItem, findItemWithDetail } from './todoDetail.js';
import {
  onBodyBlur,
  onDelete,
  onPlanApprove,
  onReviewOpenReport,
  onStatusChange,
  onTitleBlur,
} from './todoFieldHandlers.js';
import { refreshTodoList } from './todoListRefresh.js';
import { getWorkspaceContext, setStatus } from './todoPanelContext.js';
import { rowMenus } from '../state/todoPanelState.js';
import {
  onEditorAssigneeChange,
  onEditorExecutionModeChange,
  onEditorRunModeChange,
  openEditor,
} from '../views/todoEditor.js';
import { confirmAction, integrationFilterLabel } from '../views/todoToolbar.js';

/**
 * Second meta line for a row: `#e7212fc3 · 2 chaty · 2d temu`.
 *
 * @param {object} item
 * @returns {string}
 */
export function formatTodoMetaText(item) {
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
  const integrationState = String(item?.integrationSummary?.state || 'unconfirmed');
  const integrationDetail = String(item?.integrationSummary?.detail || '');
  const integrationLabel = ['no_code_changes', 'rejected', 'conflict'].includes(integrationDetail)
    ? integrationFilterLabel(integrationDetail)
    : integrationFilterLabel(integrationState);
  // An unconfirmed state is the default for every open task, so it only adds
  // noise on a narrow row; show integration for done work and non-default states.
  // The healthy state (integrated, no caveat) is left out so rows stay one line.
  const isHealthy = integrationState === 'integrated' && !integrationDetail;
  const showIntegration = !isHealthy && (integrationState !== 'unconfirmed' || !!integrationDetail
    || normalizeTodoItemStatus(item?.status) === 'done');
  if (showIntegration) parts.push(integrationLabel);
  return parts.join(' · ');
}

/**
 * @param {string} text
 * @param {string} okMessage
 */
export async function copyTodoText(text, okMessage) {
  const value = String(text || '');
  if (!value) {
    setStatus(t('todo.copyFailed'), true);
    return;
  }
  const ok = await writeTextToClipboard(value);
  setStatus(ok ? okMessage : t('todo.copyFailed'), !ok);
}

/** @param {HTMLElement} row */
export function disposeRowMenu(row) {
  const entry = rowMenus.get(row);
  if (!entry) return;
  // Mark before destroy(): destroy() may emit onClose, which must not re-enter.
  entry.destroying = true;
  rowMenus.delete(row);
  try {
    entry.api.destroy();
  } catch {
    // A detached dropdown must never break the next render.
  }
  entry.panel.remove();
}

export function disposeAllRowMenus() {
  for (const row of [...rowMenus.keys()]) disposeRowMenu(row);
}

export function bindCardHandlers(card) {
  card.addEventListener('todo-status-change', onStatusChange);
  card.addEventListener('todo-retry-blocked', onRetryBlockedTodo);
  card.addEventListener('todo-recover', onRecoverTodo);
  card.addEventListener('todo-release-unknown', onReleaseUnknownTodo);
  card.addEventListener('todo-integration', onIntegrationDecision);
  card.addEventListener('todo-title-save', onTitleBlur);
  card.addEventListener('todo-body-save', onBodyBlur);
  card.addEventListener('todo-delete', onDelete);
  card.addEventListener('todo-start-agent', onStartAgent);
  card.addEventListener('todo-open-chat', onOpenChat);
  card.addEventListener('todo-open-git', onOpenGit);
  card.addEventListener('todo-copy', onCardCopy);
  card.addEventListener('todo-assignee-change', onEditorAssigneeChange);
  card.addEventListener('todo-runmode-change', onEditorRunModeChange);
  card.addEventListener('todo-executionmode-change', onEditorExecutionModeChange);
  card.addEventListener('todo-plan-approve', onPlanApprove);
  card.addEventListener('todo-review-open-report', onReviewOpenReport);
  card.addEventListener('todo-review-start', onReviewStart);
  // A manual acceptance changed the server-written review snapshot: reload.
  card.addEventListener('todo-review-accepted', () => { void refreshTodoList(); });
  card.addEventListener('todo-refine-start', (e) => openTodoRefinePicker(findItem(String(e?.detail?.id || ''))));
}

/** @param {Event} e */
export async function onCardCopy(e) {
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
    const full = await findItemWithDetail(String(item.id)) || item;
    await copyTodoText(buildTodoMarkdown(full), t('todo.copiedMarkdown'));
  }
}

export async function onRecoverTodo(e) {
  const detail = /** @type {any} */ (e)?.detail || {};
  const id = String(detail.id || '').trim();
  const revision = String(detail.revision || '').trim();
  const ctx = getWorkspaceContext();
  if (!id || !revision || !ctx.workspaceFolder) return;
  const card = e.currentTarget instanceof HTMLElement ? e.currentTarget : null;
  const feedback = card?.querySelector('.todo-action-feedback');
  const showFeedback = (message, isError = false) => {
    if (!(feedback instanceof HTMLElement)) return;
    feedback.hidden = !message;
    feedback.textContent = message;
    feedback.dataset.tone = isError ? 'error' : 'status';
  };
  showFeedback(t('todo.recoveryResume'));
  setStatus(t('todo.recoveryResume'));
  try {
    const result = await api.recoverWorkspaceWatcherTodo(id, ctx.workspaceFolder, revision);
    if (!result?.ok) {
      const outcome = String(result?.outcome || '');
      const message = outcome === 'conflict'
        ? t('todo.recoveryResumeConflict')
        : t('todo.recoveryResumeFailed', { outcome: outcome || result?.error || 'error' });
      showFeedback(message, true);
      setStatus(message, true);
      return;
    }
    await refreshTodoList();
    await refreshWatcherPanel();
    openEditor(id);
    showFeedback(t('todo.recoveryResumeSuccess'));
    setStatus(t('todo.recoveryResumeSuccess'));
  } catch {
    showFeedback(t('todo.recoveryResumeFailed', { outcome: 'network' }), true);
    setStatus(t('todo.networkError'), true);
  }
}

/** @param {Event} e */
export async function onReleaseUnknownTodo(e) {
  const detail = /** @type {any} */ (e)?.detail || {};
  const id = String(detail.id || '').trim();
  const revision = String(detail.revision || '').trim();
  const title = String(detail.title || id).trim();
  const ctx = getWorkspaceContext();
  if (!id || !revision || !ctx.workspaceFolder) return;
  if (!confirmAction(t('todo.recoveryReleaseUnknownConfirm', { title }))) return;
  const card = e.currentTarget instanceof HTMLElement ? e.currentTarget : null;
  const feedback = card?.querySelector('.todo-action-feedback');
  const showFeedback = (message, isError = false) => {
    if (!(feedback instanceof HTMLElement)) return;
    feedback.hidden = !message;
    feedback.textContent = message;
    feedback.dataset.tone = isError ? 'error' : 'status';
  };
  showFeedback(t('todo.recoveryReleaseUnknown'));
  setStatus(t('todo.recoveryReleaseUnknown'));
  try {
    const result = await api.releaseDoingWorkspaceWatcherTodo(id, ctx.workspaceFolder, revision);
    if (!result?.ok) {
      const outcome = String(result?.outcome || '');
      const message = outcome === 'conflict'
        ? t('todo.recoveryResumeConflict')
        : t('todo.recoveryReleaseUnknownFailed', { outcome: outcome || result?.error || 'error' });
      showFeedback(message, true);
      setStatus(message, true);
      return;
    }
    await refreshTodoList();
    await refreshWatcherPanel();
    openEditor(id);
    showFeedback(t('todo.recoveryReleaseUnknownSuccess'));
    setStatus(t('todo.recoveryReleaseUnknownSuccess'));
  } catch {
    showFeedback(t('todo.recoveryReleaseUnknownFailed', { outcome: 'network' }), true);
    setStatus(t('todo.networkError'), true);
  }
}

/**
 * Human integration decision from the editor card: confirm marks the todo done
 * (unblocking siblings), reject returns it to the pool with the worktree kept.
 *
 * @param {Event} e
 */
export async function onIntegrationDecision(e) {
  const detail = /** @type {any} */ (e)?.detail || {};
  const id = String(detail.id || '').trim();
  const revision = String(detail.revision || '').trim();
  const requested = String(detail.action || '').trim();
  const action = ['prepare', 'apply', 'reject', 'confirm', 'invalidate', 'no-code'].includes(requested) ? requested : 'confirm';
  const ctx = getWorkspaceContext();
  if (!id || !revision || !ctx.workspaceFolder) return;
  const card = e.currentTarget instanceof HTMLElement ? e.currentTarget : null;
  const feedback = card?.querySelector('.todo-action-feedback');
  let proof = {};
  let reason = '';
  if (action === 'invalidate' || action === 'no-code') {
    const promptKey = action === 'no-code' ? 'todo.integrationAskNoCodeReason' : 'todo.integrationAskInvalidationReason';
    const suppliedReason = typeof window.prompt === 'function' ? window.prompt(t(promptKey)) : null;
    if (suppliedReason == null || !suppliedReason.trim()) return;
    reason = suppliedReason.trim();
  }
  if (action === 'confirm') {
    const item = findItem(id);
    if (!item || typeof window.prompt !== 'function') return;
    // One click: the server records the current workspace branch and HEAD commit.
    if (!confirmAction(t('todo.integrationSimpleConfirm', { title: item.title || id }))) return;
    proof = { simple: true };
  }
  const showFeedback = (message, isError = false) => {
    if (!(feedback instanceof HTMLElement)) return;
    feedback.hidden = !message;
    feedback.textContent = message;
    feedback.dataset.tone = isError ? 'error' : 'status';
  };
  const busyMessage = action === 'prepare' ? t('todo.integrationPreparing') : action === 'apply' ? t('todo.integrationApplying') : t('todo.integrationSaving');
  showFeedback(busyMessage);
  setStatus(busyMessage);
  try {
    const result = await api.integrateTodo(id, ctx.workspaceFolder, action, revision, reason, proof);
    if (!result?.ok) {
      const message = integrationFailureMessage(action, result);
      showFeedback(message, true);
      setStatus(message, true);
      return;
    }
    await refreshTodoList();
    await refreshWatcherPanel();
    openEditor(id);
    const success = action === 'prepare'
      ? t('todo.integrationPrepared')
      : action === 'apply'
        ? t('todo.integrationApplied')
      : action === 'reject'
        ? t('todo.integrationRejected')
        : action === 'invalidate'
          ? t('todo.integrationProofInvalidated')
          : action === 'no-code'
            ? t('todo.integrationNoCodeSaved')
        : t('todo.integrationConfirmed');
    showFeedback(success);
    setStatus(success);
  } catch {
    showFeedback(t('todo.integrationFailed'), true);
    setStatus(t('todo.networkError'), true);
  }
}

export async function onRetryBlockedTodo(e) {
  const detail = /** @type {any} */ (e)?.detail || {};
  const id = String(detail.id || '').trim();
  const ctx = getWorkspaceContext();
  if (!id || !ctx.workspaceFolder) return;
  const card = e.currentTarget instanceof HTMLElement ? e.currentTarget : null;
  const feedback = card?.querySelector('.todo-action-feedback');
  const showFeedback = (message, isError = false) => {
    if (!(feedback instanceof HTMLElement)) return;
    feedback.hidden = !message;
    feedback.textContent = message;
    feedback.dataset.tone = isError ? 'error' : 'status';
  };
  showFeedback(t('todo.retryingBlocked'));
  setStatus(t('todo.retryingBlocked'));
  try {
    const result = await api.retryWorkspaceWatcherTodo(id, ctx.workspaceFolder);
    if (!result?.ok) {
      showFeedback(result?.error || t('todo.retryBlockedFailed'), true);
      setStatus(result?.error || t('todo.retryBlockedFailed'), true);
      return;
    }
    await refreshTodoList();
    openEditor(id);
    showFeedback(t('todo.retryBlockedSuccess'));
    setStatus(t('todo.retryBlockedSuccess'));
  } catch {
    showFeedback(t('todo.retryBlockedFailed'), true);
    setStatus(t('todo.networkError'), true);
  }
}
