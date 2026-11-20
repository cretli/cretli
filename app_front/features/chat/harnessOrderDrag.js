/**
 * Pointer drag for sortable Settings lists (Harness overview, model roles).
 * Drag starts on the handle so checkboxes and status buttons stay tappable.
 * The defaults match the Harness overview list; other lists pass their own
 * row / handle / container selectors.
 */

import { computeDropIndex } from '../sidebar/sidebarWorkspaceOrder.js';

const MOVE_START_PX = 4;
const EDGE_SCROLL_PX = 48;
const EDGE_SCROLL_SPEED = 12;

/**
 * @param {{
 *   listEl: HTMLElement | null,
 *   onOrderChange?: (ids: string[], list: HTMLElement) => void,
 *   rowSelector?: string,
 *   handleSelector?: string,
 *   containerSelector?: string | null,
 *   rowId?: (row: HTMLElement) => string,
 * }} options `containerSelector` lets one host own several sortable lists:
 * rows only reorder inside their own container.
 * @returns {{ isDragging: () => boolean }}
 */
export function initHarnessOrderDrag({
  listEl,
  onOrderChange = () => {},
  rowSelector = '.harness-setup-status-row',
  handleSelector = '.harness-setup-drag',
  containerSelector = null,
  rowId = (row) => String(row.dataset.harnessId || ''),
}) {
  if (!listEl || typeof window === 'undefined' || typeof PointerEvent === 'undefined') {
    return { isDragging: () => false };
  }
  /** @type {{ li: HTMLElement, list: HTMLElement, lastY: number, raf: number, originalIds: string[], moved: boolean } | null} */
  let drag = null;
  let suppressClick = false;

  function readRowIds(list) {
    return [...list.querySelectorAll(`:scope > ${rowSelector}`)]
      .map((row) => rowId(row))
      .filter(Boolean);
  }

  function orderedRows(list) {
    return Array.from(list.querySelectorAll(`:scope > ${rowSelector}`));
  }

  function beginDrag(li, y) {
    const list = li.parentElement;
    if (!list) return;
    drag = {
      li,
      list,
      lastY: y,
      raf: 0,
      originalIds: readRowIds(list),
      moved: false,
    };
    li.classList.add('is-dragging');
    document.body?.classList.add('harness-setup-drag-active');
    drag.raf = requestAnimationFrame(rafStep);
  }

  /**
   * @param {number} y
   */
  function moveDraggedItem(y) {
    if (!drag) return;
    const siblings = orderedRows(drag.list).filter((row) => row !== drag.li);
    const centers = siblings.map((row) => {
      const rect = row.getBoundingClientRect();
      return rect.top + rect.height / 2;
    });
    const index = computeDropIndex(centers, y);
    const target = index < siblings.length ? siblings[index] : null;
    const isAtTarget = target
      ? drag.li.nextElementSibling === target
      : drag.list.lastElementChild === drag.li;
    if (isAtTarget) return;
    drag.moved = true;
    drag.list.insertBefore(drag.li, target);
  }

  function rafStep() {
    if (!drag) return;
    const scroller = listEl.closest('.settings-sections') || listEl.parentElement;
    if (scroller instanceof HTMLElement) {
      const rect = scroller.getBoundingClientRect();
      if (drag.lastY < rect.top + EDGE_SCROLL_PX) scroller.scrollTop -= EDGE_SCROLL_SPEED;
      else if (drag.lastY > rect.bottom - EDGE_SCROLL_PX) scroller.scrollTop += EDGE_SCROLL_SPEED;
    }
    moveDraggedItem(drag.lastY);
    drag.raf = requestAnimationFrame(rafStep);
  }

  function endDrag() {
    const finished = drag;
    drag = null;
    if (!finished) return;
    cancelAnimationFrame(finished.raf);
    finished.li.classList.remove('is-dragging');
    document.body?.classList.remove('harness-setup-drag-active');
    if (!finished.moved) return;
    suppressClick = true;
    const ids = readRowIds(finished.list);
    const changed =
      ids.length !== finished.originalIds.length
      || ids.some((id, i) => id !== finished.originalIds[i]);
    if (!changed) return;
    onOrderChange(ids, finished.list);
  }

  function onPointerDown(ev) {
    if (drag) return;
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    const raw = ev.target;
    const target = raw instanceof Element ? raw : null;
    if (!target) return;
    const handle = target.closest(handleSelector);
    if (!handle) return;
    const li = handle.closest(rowSelector);
    const container = li?.parentElement;
    if (!(li instanceof HTMLElement) || !container) return;
    if (containerSelector ? !container.matches(containerSelector) : container !== listEl) return;
    if (orderedRows(container).length < 2) return;
    ev.preventDefault();
    handle.setPointerCapture?.(ev.pointerId);
    beginDrag(li, ev.clientY);
  }

  function onPointerMove(ev) {
    if (!drag) return;
    ev.preventDefault();
    if (Math.abs(ev.clientY - drag.lastY) >= MOVE_START_PX) drag.moved = true;
    drag.lastY = ev.clientY;
    moveDraggedItem(ev.clientY);
  }

  function onPointerEnd() {
    if (drag) endDrag();
  }

  function onTouchMove(ev) {
    if (drag) ev.preventDefault();
  }

  function onClickCapture(ev) {
    if (!suppressClick) return;
    suppressClick = false;
    ev.preventDefault();
    ev.stopPropagation();
  }

  listEl.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerEnd);
  window.addEventListener('pointercancel', onPointerEnd);
  listEl.addEventListener('touchmove', onTouchMove, { passive: false });
  listEl.addEventListener('click', onClickCapture, true);
  return { isDragging: () => drag !== null };
}
