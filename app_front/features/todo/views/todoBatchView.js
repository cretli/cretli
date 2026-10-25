import { openTodoAgentChat } from '../../chat/index.js';
import { t } from '../../../i18n/index.js';
import { getTodoWorkspaceFolder, todoWorkspaceMatches } from '../todoWorkspaceScope.js';
import {
  buildBatchRequestIds,
  buildBatchSelection,
  captureBatchScope,
  describeBatchFailure,
  isBatchScopeCurrent,
  localizeBatchReason,
  canClearIntegrationLock,
  resolveBatchControls,
  summarizeBatchEntries,
} from '../todoBatchSelection.js';
import {
  batchActions,
  clearBatchSelection,
  dismissBatchBanner,
  exitBatchSelectionMode,
  openBatchIntegratePicker,
  runBatchResume,
  selectAllEligibleBatch,
} from '../services/todoBatchFlow.js';
import { effectiveCollapsedIds, getVisibleTodoItems } from '../services/todoPanelContext.js';
import { S, batchStartGuard, todoList } from '../state/todoPanelState.js';

// ---------------------------------------------------------------------------
// Bulk "integrate with agent": selection, action bar, progress banner, polling
// ---------------------------------------------------------------------------

/**
 * @param {unknown} reason
 * @param {'skip' | 'entry' | 'pause'} [scope]
 * @returns {string}
 */
export function batchReasonText(reason, scope = 'entry') {
  return localizeBatchReason(reason, t, scope);
}

/**
 * @param {{ error?: string, message?: string } | null | undefined} result
 * @param {string} [fallbackKey]
 * @returns {string}
 */
export function batchErrorMessage(result, fallbackKey = 'todo.batchFailed') {
  return describeBatchFailure(result, t, fallbackKey);
}

/** @returns {{ folder: string, generation: number }} */
export function captureCurrentBatchScope() {
  return captureBatchScope(getTodoWorkspaceFolder(), S.batchWorkspaceGeneration);
}

/**
 * @param {{ folder: string, generation: number }} scope
 * @returns {boolean}
 */
export function isCurrentBatchScope(scope) {
  return isBatchScopeCurrent(scope, S.batchWorkspaceGeneration, (folder) => todoWorkspaceMatches(folder));
}

/** @returns {{ eligibleIds: string[], eligibleSet: Set<string> }} */
export function currentBatchSelection() {
  return buildBatchSelection({
    items: getVisibleTodoItems(),
    collapsedIds: effectiveCollapsedIds(),
  });
}

/** Keep the toolbar toggle in sync with the current selection mode and language. */
export function syncBatchSelectTrigger() {
  const btn = document.getElementById('todo-batch-select-btn');
  if (!(btn instanceof HTMLElement)) return;
  const label = S.batchSelectionMode ? t('todo.batchSelectModeExit') : t('todo.batchSelectMode');
  btn.setAttribute('aria-label', label);
  btn.title = label;
  btn.setAttribute('aria-pressed', S.batchSelectionMode ? 'true' : 'false');
  btn.classList.toggle('todo-batch-select-trigger--active', S.batchSelectionMode);
}

/**
 * @param {string} id
 * @returns {HTMLElement | null}
 */
export function todoRowElForId(id) {
  if (!S.listEl || !id) return null;
  const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(id) : id;
  return S.listEl.querySelector(`.todo-row[data-id="${escaped}"]`);
}

/** @param {string} id */
export function repaintSingleRowSelection(id) {
  const row = todoRowElForId(id);
  const box = row?.querySelector('.todo-row-select');
  if (box && 'checked' in box) box.checked = todoList.batchSelected.get().has(id);
  if (row instanceof HTMLElement) {
    row.dataset.batchSelected = todoList.batchSelected.get().has(id) ? 'true' : 'false';
  }
}

export function ensureBatchActionBar() {
  if (S.batchActionBar) return S.batchActionBar;
  const layout = document.querySelector('#todo-panel .todo-layout');
  const toolbar = layout?.querySelector('.todo-toolbar');
  if (!layout || !(toolbar instanceof HTMLElement)) return null;
  const bar = document.createElement('div');
  bar.className = 'todo-batch-bar';
  bar.hidden = true;
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', t('todo.batchActionBarAria'));
  const count = document.createElement('span');
  count.className = 'todo-batch-bar-count';
  const selectAll = document.createElement('cr-bar-button');
  selectAll.className = 'todo-batch-bar-select-all';
  const clear = document.createElement('cr-bar-button');
  clear.className = 'todo-batch-bar-clear';
  const integrate = document.createElement('cr-bar-button');
  integrate.className = 'todo-batch-bar-integrate';
  integrate.setAttribute('variant', 'primary');
  const exit = document.createElement('cr-bar-button');
  exit.className = 'todo-batch-bar-exit';
  bar.append(selectAll, clear, count, integrate, exit);
  const anchor = S.batchBanner && S.batchBanner.isConnected ? S.batchBanner : toolbar;
  anchor.insertAdjacentElement('afterend', bar);
  S.batchActionBar = bar;
  S.batchActionBarRefs = { count, selectAll, clear, integrate, exit };
  selectAll.addEventListener('click', () => selectAllEligibleBatch());
  clear.addEventListener('click', () => clearBatchSelection());
  integrate.addEventListener('click', () => openBatchIntegratePicker());
  exit.addEventListener('click', () => exitBatchSelectionMode());
  return bar;
}

export function paintBatchActionBar() {
  const bar = ensureBatchActionBar();
  if (!bar || !S.batchActionBarRefs) return;
  bar.hidden = !S.batchSelectionMode;
  if (!S.batchSelectionMode) return;
  const { eligibleIds } = currentBatchSelection();
  const selected = buildBatchRequestIds(todoList.batchSelected.get(), eligibleIds);
  const refs = S.batchActionBarRefs;
  refs.selectAll.textContent = t('todo.batchSelectAll');
  refs.selectAll.disabled = eligibleIds.length === 0 || selected.length >= eligibleIds.length;
  refs.clear.textContent = t('todo.batchClearSelection');
  refs.clear.disabled = selected.length === 0;
  refs.exit.textContent = t('todo.batchExitSelection');
  refs.integrate.disabled = selected.length === 0 || batchStartGuard.isPending();
  refs.integrate.textContent = t('todo.batchIntegrateSelected', { count: String(selected.length) });
  refs.count.textContent = t('todo.batchSelectedCount', { count: String(selected.length) });
}

export function ensureBatchBanner() {
  if (S.batchBanner) return S.batchBanner;
  const layout = document.querySelector('#todo-panel .todo-layout');
  const toolbar = layout?.querySelector('.todo-toolbar');
  if (!layout || !(toolbar instanceof HTMLElement)) return null;
  const banner = document.createElement('div');
  banner.className = 'todo-batch-banner';
  banner.hidden = true;
  const head = document.createElement('div');
  head.className = 'todo-batch-banner-head';
  const title = document.createElement('span');
  title.className = 'todo-batch-banner-title';
  const status = document.createElement('span');
  status.className = 'todo-batch-banner-status';
  const counts = document.createElement('span');
  counts.className = 'todo-batch-banner-counts';
  head.append(title, status, counts);
  const progress = document.createElement('p');
  progress.className = 'todo-batch-banner-progress';
  const reason = document.createElement('p');
  reason.className = 'todo-batch-banner-reason';
  reason.hidden = true;
  const list = document.createElement('ul');
  list.className = 'todo-batch-banner-list';
  list.hidden = true;
  const actions = document.createElement('div');
  actions.className = 'todo-batch-banner-actions';
  const openChat = document.createElement('cr-bar-button');
  openChat.className = 'todo-batch-open-chat';
  const cancel = document.createElement('cr-bar-button');
  cancel.className = 'todo-batch-cancel';
  const resumeRetry = document.createElement('cr-bar-button');
  resumeRetry.className = 'todo-batch-resume-retry';
  resumeRetry.setAttribute('variant', 'primary');
  const resumeSkip = document.createElement('cr-bar-button');
  resumeSkip.className = 'todo-batch-resume-skip';
  const abandon = document.createElement('cr-bar-button');
  abandon.className = 'todo-batch-abandon';
  abandon.setAttribute('variant', 'danger');
  const dismiss = document.createElement('cr-bar-button');
  dismiss.className = 'todo-batch-dismiss';
  actions.append(openChat, cancel, resumeRetry, resumeSkip, abandon, dismiss);
  banner.append(head, progress, reason, list, actions);
  toolbar.insertAdjacentElement('afterend', banner);
  S.batchBanner = banner;
  S.batchBannerRefs = { title, status, counts, progress, reason, list, openChat, cancel, resumeRetry, resumeSkip, abandon, dismiss };
  openChat.addEventListener('click', () => {
    const chatId = String(S.activeBatch?.chatId || '').trim();
    if (!chatId) return;
    openTodoAgentChat({ id: chatId }, { reused: true });
    S.showPanelFn('chat');
  });
  cancel.addEventListener('click', () => void batchActions.cancel());
  resumeRetry.addEventListener('click', () => runBatchResume('retry'));
  resumeSkip.addEventListener('click', () => runBatchResume('skip'));
  abandon.addEventListener('click', () => void batchActions.abandon());
  dismiss.addEventListener('click', () => dismissBatchBanner());
  return banner;
}

/**
 * Toggle one batch action control. A `cr-bar-button` sets `:host { display:
 * inline-block }`, which outranks the UA `[hidden]` rule, so the inline display
 * is kept alongside `hidden` for assistive tech.
 *
 * @param {HTMLElement | null | undefined} el
 * @param {boolean} visible
 */
export function setBatchControlVisible(el, visible) {
  if (!el) return;
  el.hidden = !visible;
  el.style.display = visible ? '' : 'none';
}

export function paintBatchBanner() {
  const banner = ensureBatchBanner();
  if (!banner) return;
  if (!S.activeBatch || !S.batchBannerRefs) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  const batch = S.activeBatch;
  const refs = S.batchBannerRefs;
  const { total, counts } = summarizeBatchEntries(batch);
  const done = ['merged', 'verified', 'failed', 'skipped', 'cancelled']
    .reduce((sum, state) => sum + (counts[state] || 0), 0);
  const controls = resolveBatchControls(batch);
  refs.title.textContent = t('todo.batchBannerTitle');
  refs.status.textContent = t(`todo.batchStatus_${batch.status}`);
  refs.status.dataset.batchStatus = String(batch.status || '');
  refs.counts.textContent = t('todo.batchCounts', { done: String(done), total: String(total) });
  const progressParts = ['merged', 'verified', 'failed', 'skipped', 'cancelled']
    .filter((state) => counts[state])
    .map((state) => `${t(`todo.batchEntryState_${state}`)} ${counts[state]}`);
  refs.progress.textContent = progressParts.join(' · ');
  const pausedReason = String(batch.pausedReason || '').trim();
  let reasonText = '';
  if (pausedReason) {
    reasonText = t('todo.batchPausedHint', { reason: batchReasonText(pausedReason, 'pause') });
  } else if (controls.livenessUnknown) {
    reasonText = t('todo.batchLivenessUnknownHint');
  }
  refs.reason.hidden = !reasonText;
  refs.reason.textContent = reasonText;
  const listItems = [];
  for (const entry of Array.isArray(batch.entries) ? batch.entries : []) {
    if (entry.state !== 'failed' && !(entry.state === 'skipped' && entry.reason)) continue;
    listItems.push(`${entry.title || entry.todoId}: ${batchReasonText(entry.reason, 'entry')}`);
  }
  for (const skip of Array.isArray(batch.skipped) ? batch.skipped : []) {
    listItems.push(`${String(skip.todoId || '').slice(0, 8)}: ${batchReasonText(skip.reason, 'skip')}`);
  }
  refs.list.replaceChildren(...listItems.map((text) => {
    const li = document.createElement('li');
    li.textContent = text;
    return li;
  }));
  refs.list.hidden = !listItems.length;
  setBatchControlVisible(refs.openChat, !!String(batch.chatId || '').trim());
  refs.openChat.textContent = t('todo.batchOpenChat');
  setBatchControlVisible(refs.cancel, controls.canCancel);
  refs.cancel.disabled = controls.cancelDisabled;
  refs.cancel.textContent = t('todo.batchCancel');
  setBatchControlVisible(refs.resumeRetry, controls.canResume);
  refs.resumeRetry.textContent = t('todo.batchResumeRetry');
  setBatchControlVisible(refs.resumeSkip, controls.canResume);
  refs.resumeSkip.textContent = t('todo.batchResumeSkip');
  setBatchControlVisible(refs.abandon, controls.canAbandon);
  refs.abandon.textContent = t('todo.batchAbandon');
  setBatchControlVisible(refs.dismiss, controls.canDismiss);
  refs.dismiss.textContent = t('todo.batchDismiss');
}

export function ensureLockNotice() {
  if (S.lockNotice) return S.lockNotice;
  const toolbar = document.querySelector('#todo-panel .todo-layout .todo-toolbar');
  if (!(toolbar instanceof HTMLElement)) return null;
  const notice = document.createElement('div');
  notice.className = 'todo-lock-notice';
  notice.setAttribute('role', 'status');
  notice.hidden = true;
  const text = document.createElement('span');
  text.className = 'todo-lock-notice-text';
  const clear = document.createElement('cr-bar-button');
  clear.className = 'todo-lock-clear';
  clear.setAttribute('variant', 'danger');
  notice.append(text, clear);
  const anchor = S.batchBanner && S.batchBanner.isConnected ? S.batchBanner : toolbar;
  anchor.insertAdjacentElement('afterend', notice);
  S.lockNotice = notice;
  S.lockNoticeRefs = { text, clear };
  clear.addEventListener('click', () => void batchActions.clearLock());
  return notice;
}

export function paintLockNotice() {
  const visible = canClearIntegrationLock(S.integrationLock, S.activeBatch);
  if (!visible && !S.lockNotice) return;
  const notice = ensureLockNotice();
  if (!notice || !S.lockNoticeRefs) return;
  setBatchControlVisible(notice, visible);
  if (!visible) return;
  S.lockNoticeRefs.text.textContent = t('todo.lockNoticeText');
  S.lockNoticeRefs.clear.textContent = t('todo.lockClear');
}

/** @param {object | null} lock */
export function applyIntegrationLock(lock) {
  S.integrationLock = lock && typeof lock === 'object' ? lock : null;
  paintLockNotice();
}
