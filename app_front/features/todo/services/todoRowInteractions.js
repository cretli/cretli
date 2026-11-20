import * as api from '../../../core/api/index.js';
import { t } from '../../../i18n/index.js';
import { canAddTodoChild, resolveTodoDrop, todoDropZoneFromRatio } from '../todoTreeView.js';
import { toggleRowBatchSelection } from './todoBatchFlow.js';
import { onStatusChange } from './todoFieldHandlers.js';
import { refreshTodoList } from './todoListRefresh.js';
import { saveCollapsed, scheduleTodoViewMemoryCapture, setStatus } from './todoPanelContext.js';
import { S, todoList } from '../state/todoPanelState.js';
import { openEditor } from '../views/todoEditor.js';
import { renderList } from '../views/todoListRender.js';

export function clearDropMarks() {
  S.listEl?.querySelectorAll('.todo-row').forEach((row) => {
    row.classList.remove('todo-row--drop-before', 'todo-row--drop-after', 'todo-row--drop-nest');
  });
}

/** @param {PointerEvent} event */
export function onGripPointerDown(event) {
  if (event.button !== 0) return;
  const row = event.currentTarget instanceof Element ? event.currentTarget.closest('.todo-row') : null;
  const id = String(row?.dataset.id || '');
  if (!id || !(event.currentTarget instanceof HTMLElement)) return;
  event.preventDefault();
  event.currentTarget.setPointerCapture(event.pointerId);
  S.dragState = { id, pointerId: event.pointerId, targetId: '', zone: '' };
  row.classList.add('todo-row--dragging');
}

/** @param {string} id */
function isRootTodo(id) {
  const item = S.latestItems.find((row) => String(row.id) === id);
  const parentId = String(item?.parentId || '');
  return !parentId || !S.latestItems.some((row) => String(row.id) === parentId);
}

/** @param {PointerEvent} event */
export function onGripPointerMove(event) {
  if (!S.dragState || event.pointerId !== S.dragState.pointerId) return;
  const hit = document.elementFromPoint(event.clientX, event.clientY);
  const row = hit instanceof Element ? hit.closest('.todo-row') : null;
  clearDropMarks();
  S.dragState.targetId = '';
  S.dragState.zone = '';
  if (!(row instanceof HTMLElement) || row.dataset.id === S.dragState.id) return;
  const rect = row.getBoundingClientRect();
  const ratio = (event.clientY - rect.top) / Math.max(rect.height, 1);
  const zone = todoDropZoneFromRatio(ratio);
  // A sorted list shows roots out of their sibling order, so reordering between
  // roots would land somewhere else than it looks; nesting still works.
  if (zone !== 'nest' && S.todoSort !== 'manual' && isRootTodo(String(row.dataset.id || ''))) return;
  S.dragState.targetId = String(row.dataset.id || '');
  S.dragState.zone = zone;
  row.classList.add(`todo-row--drop-${zone}`);
}

/** @param {PointerEvent} event */
export function onGripPointerUp(event) {
  if (!S.dragState || event.pointerId !== S.dragState.pointerId) return;
  const move = S.dragState;
  S.dragState = null;
  clearDropMarks();
  S.listEl?.querySelectorAll('.todo-row--dragging').forEach((row) => {
    row.classList.remove('todo-row--dragging', 'todo-row--moving');
    row.querySelector('.todo-row-menu')?.focus();
  });
  if (!move.targetId || !move.zone) return;
  const decision = resolveTodoDrop({
    items: S.latestItems,
    draggedId: move.id,
    targetId: move.targetId,
    zone: move.zone,
  });
  if (!decision.ok) {
    if (decision.reason !== 'noop' && decision.reason !== 'self') {
      setStatus(t('todo.dropRejected'), true);
    }
    return;
  }
  void patchMove(move.id, decision.parentId, decision.siblingIndex);
}

/** @param {MouseEvent} event */
export function onToggleClick(event) {
  event.preventDefault();
  event.stopPropagation();
  const row = event.currentTarget instanceof Element ? event.currentTarget.closest('.todo-row') : null;
  const id = String(row?.dataset.id || '');
  if (!id) return;
  todoList.toggleCollapsed(id);
  saveCollapsed();
  renderList({ items: S.latestItems });
  scheduleTodoViewMemoryCapture();
}

/** @param {MouseEvent} event */
export function onRowOpen(event) {
  const row = event.currentTarget instanceof Element ? event.currentTarget.closest('.todo-row') : null;
  const id = String(row?.dataset.id || '');
  if (!id) return;
  if (S.suppressRowOpenAfterLongPress) {
    // The long-press already entered selection mode and selected this row.
    S.suppressRowOpenAfterLongPress = false;
    return;
  }
  if (S.batchSelectionMode) {
    toggleRowBatchSelection(id);
    return;
  }
  openEditor(id);
}

/** @param {MouseEvent} event */
export function onCloseReviewedClick(event) {
  event.preventDefault();
  event.stopPropagation();
  const row = event.currentTarget instanceof Element ? event.currentTarget.closest('.todo-row') : null;
  const id = String(row?.dataset.id || '');
  if (!id) return;
  void onStatusChange({ detail: { id, status: 'done' } });
}

/** @param {MouseEvent} event */
export function onAddChildClick(event) {
  event.preventDefault();
  event.stopPropagation();
  const row = event.currentTarget instanceof Element ? event.currentTarget.closest('.todo-row') : null;
  const id = String(row?.dataset.id || '');
  if (!id) return;
  if (!canAddTodoChild(S.latestItems, id)) {
    setStatus(t('todo.depthLimit'), true);
    return;
  }
  S.pendingParentId = id;
  S.openNewTodoModal();
}

/**
 * @param {string} id
 * @param {string | null} parentId
 * @param {number} siblingIndex
 */
export async function patchMove(id, parentId, siblingIndex) {
  try {
    const data = await api.patchTodo(id, { parentId, siblingIndex });
    if (!data?.ok) {
      setStatus(data?.error || t('todo.saveError'), true);
      refreshTodoList();
      return;
    }
    setStatus(t('todo.saved'));
    renderList(data);
  } catch {
    setStatus(t('todo.networkError'), true);
    refreshTodoList();
  }
}
