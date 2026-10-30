import * as api from '../../../core/api/index.js';
import { openTodoAgentChat, openTodoAgentStartModal } from '../../chat/index.js';
import { t } from '../../../i18n/index.js';
import { getTodoWorkspaceFolder, todoWorkspaceMatches } from '../todoWorkspaceScope.js';
import { isBatchSelectableItem } from '../todoTreeView.js';
import {
  buildBatchRequestIds,
  isActiveBatchStatus,
  isTerminalBatchStatus,
  resolveBatchToTrack,
  summarizeBatchEntries,
} from '../todoBatchSelection.js';
import { createBatchActions } from '../todoBatchActions.js';
import { listSubtreeIntegrateIds } from './todoIntegrationRules.js';
import { findItem } from './todoDetail.js';
import { refreshTodoList } from './todoListRefresh.js';
import {
  getWorkspaceContext,
  resolveTodoStartHarness,
  scheduleTodoViewMemoryCapture,
  setStatus,
} from './todoPanelContext.js';
import {
  BATCH_LONG_PRESS_MOVE_PX,
  BATCH_LONG_PRESS_MS,
  BATCH_POLL_MS,
  S,
  batchAgentById,
  batchListGate,
  batchStartGuard,
  todoList,
} from '../state/todoPanelState.js';
import {
  applyIntegrationLock,
  batchErrorMessage,
  batchReasonText,
  captureCurrentBatchScope,
  currentBatchSelection,
  isCurrentBatchScope,
  paintBatchActionBar,
  paintBatchBanner,
  paintLockNotice,
  repaintSingleRowSelection,
  syncBatchSelectTrigger,
} from '../views/todoBatchView.js';
import { repaintTodoRowBadges } from '../views/todoRowRender.js';
import { confirmAction } from '../views/todoToolbar.js';

export function dismissBatchBanner() {
  if (S.activeBatch?.id) S.lastNotifiedBatchId = S.activeBatch.id;
  stopBatchPoll();
  S.activeBatch = null;
  S.batchBadgeSignature = '';
  paintBatchBanner();
  repaintTodoRowBadges();
}

export function enterBatchSelectionMode() {
  if (S.batchSelectionMode) return;
  S.batchSelectionMode = true;
  todoList.clearBatchSelected();
  S.listEl?.classList.add('todo-list--batch-mode');
  syncBatchSelectTrigger();
  paintBatchActionBar();
  repaintTodoRowBadges();
}

export function exitBatchSelectionMode() {
  if (!S.batchSelectionMode) return;
  S.batchSelectionMode = false;
  todoList.clearBatchSelected();
  S.suppressRowOpenAfterLongPress = false;
  S.listEl?.classList.remove('todo-list--batch-mode');
  syncBatchSelectTrigger();
  paintBatchActionBar();
  repaintTodoRowBadges();
}

export function toggleBatchSelectionMode() {
  if (S.batchSelectionMode) exitBatchSelectionMode();
  else enterBatchSelectionMode();
}

export function selectAllEligibleBatch() {
  const { eligibleIds } = currentBatchSelection();
  todoList.setBatchSelected(eligibleIds);
  paintBatchActionBar();
  repaintTodoRowBadges();
}

export function clearBatchSelection() {
  todoList.clearBatchSelected();
  paintBatchActionBar();
  repaintTodoRowBadges();
}

/** @param {string} id */
export function toggleRowBatchSelection(id) {
  const item = findItem(id);
  if (!item) return;
  if (!isBatchSelectableItem(item)) {
    setStatus(batchReasonText(item?.batchEligibility?.reason || 'not_eligible', 'skip'), true);
    return;
  }
  todoList.toggleBatchSelected(id);
  repaintSingleRowSelection(id);
  paintBatchActionBar();
  scheduleTodoViewMemoryCapture();
}

/** @param {Event} event */
export function onBatchCheckboxChange(event) {
  const box = event.target instanceof Element ? event.target.closest('.todo-row-select') : null;
  const row = box?.closest('.todo-row');
  const id = String(row?.dataset.id || '');
  if (!id) return;
  const checked = event?.detail?.checked === true;
  todoList.setBatchChecked(id, checked);
  paintBatchActionBar();
  scheduleTodoViewMemoryCapture();
}

/** @param {PointerEvent} event */
export function onRowMainPointerDown(event) {
  if (S.batchSelectionMode) return;
  if (String(event.pointerType || '') !== 'touch') return;
  // A new gesture never belongs to a previous long-press click.
  S.suppressRowOpenAfterLongPress = false;
  const row = event.currentTarget instanceof Element ? event.currentTarget.closest('.todo-row') : null;
  const id = String(row?.dataset.id || '');
  const item = findItem(id);
  if (!id || !item || !isBatchSelectableItem(item)) return;
  cancelBatchLongPress();
  S.batchLongPressPointerId = event.pointerId;
  S.batchLongPressStart = { x: event.clientX, y: event.clientY };
  S.batchLongPressTimer = setTimeout(() => {
    S.batchLongPressTimer = 0;
    const still = findItem(id);
    if (!still || !isBatchSelectableItem(still)) return;
    enterBatchSelectionMode();
    if (!todoList.batchSelected.get().has(id)) {
      todoList.setBatchChecked(id, true);
      repaintSingleRowSelection(id);
      paintBatchActionBar();
    }
    S.suppressRowOpenAfterLongPress = true;
    try {
      navigator?.vibrate?.(10);
    } catch {
      // Vibration is best-effort feedback; unsupported engines may throw.
    }
  }, BATCH_LONG_PRESS_MS);
}

export function cancelBatchLongPress() {
  if (S.batchLongPressTimer) clearTimeout(S.batchLongPressTimer);
  S.batchLongPressTimer = 0;
  S.batchLongPressPointerId = -1;
}

/** @param {PointerEvent} event */
export function onRowMainPointerMove(event) {
  if (!S.batchLongPressTimer || event.pointerId !== S.batchLongPressPointerId) return;
  if (Math.abs(event.clientX - S.batchLongPressStart.x) > BATCH_LONG_PRESS_MOVE_PX
    || Math.abs(event.clientY - S.batchLongPressStart.y) > BATCH_LONG_PRESS_MOVE_PX) {
    cancelBatchLongPress();
  }
}

/** @param {PointerEvent} event */
export function onRowMainPointerUp(event) {
  if (S.batchLongPressPointerId !== -1 && event.pointerId !== S.batchLongPressPointerId) return;
  cancelBatchLongPress();
}

/**
 * Open the agent picker for the current selection, then start the batch. One
 * chat integrates every selected todo; skipped / aliased rows are reported in
 * the banner and in the status line.
 */
export function openBatchIntegratePicker() {
  if (batchStartGuard.isPending()) return;
  const { eligibleIds } = currentBatchSelection();
  const ids = buildBatchRequestIds(todoList.batchSelected.get(), eligibleIds);
  if (!ids.length) {
    setStatus(t('todo.batchNothingSelected'), true);
    return;
  }
  batchActions.openStartPicker(ids);
}

/**
 * Row-menu entry on a parent: start one batch over the eligible leaves of its
 * subtree, in tree order, without entering selection mode.
 *
 * @param {object} item
 */
export function openSubtreeIntegratePicker(item) {
  if (batchStartGuard.isPending()) return;
  const ids = listSubtreeIntegrateIds(S.latestItems, item);
  if (!ids.length) {
    setStatus(t('todo.batchNothingSelected'), true);
    return;
  }
  batchActions.openStartPicker(ids);
}

/** Async start / resume / cancel / abandon / clear-lock handlers (see todoBatchActions.js). */
export const batchActions = createBatchActions({
  api,
  t,
  setStatus,
  confirmAction: (message) => confirmAction(message),
  captureScope: captureCurrentBatchScope,
  isCurrentScope: isCurrentBatchScope,
  getActiveBatch: () => S.activeBatch,
  applyActiveBatch: (batch) => applyActiveBatch(batch),
  applyLock: (lock) => applyIntegrationLock(lock),
  refreshList: () => refreshTodoList(),
  openChat: (chat, options) => openTodoAgentChat(chat, options),
  showChatPanel: () => S.showPanelFn('chat'),
  exitSelection: () => exitBatchSelectionMode(),
  repaintActionBar: () => paintBatchActionBar(),
  startGuard: batchStartGuard,
  agentById: batchAgentById,
  getWorkspaceContext: () => getWorkspaceContext(),
  openAgentPicker: (options) => openTodoAgentStartModal(options),
  resolveHarness: (todoId) => resolveTodoStartHarness(findItem(String(todoId || ''))),
  describeFailure: batchErrorMessage,
});

export function runBatchResume(entryAction) {
  batchActions.resume(entryAction);
}

/** One toast per terminal batch; the banner stays until dismissed. */
export function notifyBatchFinished(batch) {
  if (typeof window === 'undefined') return;
  const { total, counts } = summarizeBatchEntries(batch);
  const done = (counts.merged || 0) + (counts.verified || 0);
  const message = t('todo.batchFinalSummary', {
    status: t(`todo.batchStatus_${batch.status}`),
    done: String(done),
    total: String(total),
    failed: String(counts.failed || 0),
    skipped: String(counts.skipped || 0),
  });
  window.dispatchEvent(new CustomEvent('cretli:toast', { detail: { message } }));
  setStatus(message);
}

/**
 * Track one batch view, repaint the banner / badges and keep polling while the
 * queue is still active. Called from create, resume, cancel, abandon, the list
 * sync and every poll answer.
 *
 * @param {object | null} batch
 */
export function applyActiveBatch(batch) {
  S.activeBatch = batch || null;
  const signature = S.activeBatch
    ? (Array.isArray(S.activeBatch.entries) ? S.activeBatch.entries : [])
      .map((entry) => `${entry.todoId}:${entry.state}:${entry.reason}`)
      .join('|')
    : '';
  const badgesChanged = signature !== S.batchBadgeSignature;
  S.batchBadgeSignature = signature;
  if (S.activeBatch && isTerminalBatchStatus(S.activeBatch.status) && S.activeBatch.id !== S.lastNotifiedBatchId) {
    S.lastNotifiedBatchId = S.activeBatch.id;
    notifyBatchFinished(S.activeBatch);
  }
  paintBatchBanner();
  paintLockNotice();
  paintBatchActionBar();
  // Polling must not restyle every row when no entry changed.
  if (badgesChanged) repaintTodoRowBadges();
  scheduleBatchPoll();
}

/** @param {object[] | null | undefined} batches */
export function syncTrackedBatch(batches) {
  const chosen = resolveBatchToTrack(batches, S.activeBatch);
  if (chosen) applyActiveBatch(chosen);
  else if (S.activeBatch && !isTerminalBatchStatus(S.activeBatch.status)) applyActiveBatch(null);
}

export function stopBatchPoll() {
  S.batchPollGeneration += 1;
  if (S.batchPollTimer) clearTimeout(S.batchPollTimer);
  S.batchPollTimer = 0;
}

export function scheduleBatchPoll() {
  stopBatchPoll();
  if (!S.activeBatch || !isActiveBatchStatus(S.activeBatch.status)) return;
  const generation = S.batchPollGeneration;
  S.batchPollTimer = setTimeout(() => {
    S.batchPollTimer = 0;
    void pollActiveBatch(generation);
  }, BATCH_POLL_MS);
}

/** @param {number} generation */
export async function pollActiveBatch(generation) {
  if (generation !== S.batchPollGeneration) return;
  const batchId = String(S.activeBatch?.id || '');
  const folder = getTodoWorkspaceFolder();
  if (!batchId || !todoWorkspaceMatches(folder)) return;
  try {
    const data = await api.getIntegrateBatch(folder, batchId);
    if (generation !== S.batchPollGeneration) return;
    if (data?.ok && data.batch) applyActiveBatch(data.batch);
    else scheduleBatchPoll();
  } catch {
    if (generation === S.batchPollGeneration) scheduleBatchPoll();
  }
}

/**
 * Background tabs throttle timers, so a batch may have finished while hidden:
 * poll once on return so the final notification still fires.
 */
export function onBatchPanelVisibilityChange() {
  if (document.visibilityState !== 'visible') return;
  if (!S.activeBatch || !isActiveBatchStatus(S.activeBatch.status)) return;
  void pollActiveBatch(S.batchPollGeneration);
}

/** Workspace switch: a batch belongs to exactly one workspace. */
export function resetBatchWorkspaceView() {
  S.batchWorkspaceGeneration += 1;
  batchStartGuard.reset();
  batchListGate.next();
  stopBatchPoll();
  S.activeBatch = null;
  S.lastNotifiedBatchId = '';
  S.batchBadgeSignature = '';
  todoList.clearBatchSelected();
  S.integrationLock = null;
  if (S.batchSelectionMode) exitBatchSelectionMode();
  paintBatchBanner();
  paintLockNotice();
}
