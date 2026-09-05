/**
 * Press-and-hold drag & drop reordering for sidebar workspace groups.
 *
 * A single Pointer Events implementation shared by mouse and touch:
 *  - pointerdown on a workspace header starts a hold timer (~250 ms);
 *  - moving the pointer beyond a small threshold before the timer fires
 *    cancels the gesture (it was a scroll or a tap);
 *  - once the hold is confirmed the group follows the pointer, siblings make
 *    room live, and the list auto-scrolls near its edges;
 *  - on drop the new `sidebarKey` sequence is committed via `onOrderChange`
 *    and the synthetic click is suppressed so a drag never activates the
 *    workspace underneath.
 *
 * Listeners are delegated on the static `.sidebar-body` element once, so the
 * controller survives sidebar re-renders.
 */

import { collectWorkspaceKeysFromList, computeDropIndex } from './sidebarWorkspaceOrder.js';

const HOLD_MS = 250;
const MOVE_CANCEL_PX = 8;
const EDGE_SCROLL_PX = 48;
const EDGE_SCROLL_SPEED = 12;

/**
 * @param {{
 *   body: HTMLElement | null,
 *   isEnabled?: () => boolean,
 *   onOrderChange?: (keys: string[]) => void,
 * }} options
 * @returns {{ isDragging: () => boolean }}
 */
export function initSidebarWorkspaceDrag({ body, isEnabled = () => true, onOrderChange = () => {} }) {
  if (!body || typeof window === 'undefined' || typeof PointerEvent === 'undefined') {
    return { isDragging: () => false };
  }

  /** @type {{ li: HTMLElement, startX: number, startY: number, timer: number } | null} */
  let pending = null;
  /** @type {{ li: HTMLElement, list: HTMLElement, lastY: number, raf: number, originalKeys: string[], moved: boolean } | null} */
  let drag = null;
  let suppressClick = false;

  function cancelPending() {
    if (!pending) return;
    clearTimeout(pending.timer);
    pending = null;
  }

  function orderedWorkspaceItems(list) {
    return Array.from(list.querySelectorAll(':scope > .sidebar-workspace'));
  }

  function beginDrag(pending2) {
    const list = pending2.li.parentElement;
    if (!list) return;
    const originalKeys = collectWorkspaceKeysFromList(list);
    drag = {
      li: pending2.li,
      list,
      lastY: pending2.startY,
      raf: 0,
      originalKeys,
      moved: false,
    };
    pending2.li.classList.add('is-dragging');
    document.body?.classList.add('sidebar-workspace-drag-active');
    drag.raf = requestAnimationFrame(rafStep);
  }

  /**
   * Live-reorders the DOM so the dragged group sits at the insertion index
   * for the current pointer position (siblings slide around it).
   * @param {number} y
   */
  function moveDraggedItem(y) {
    if (!drag) return;
    const siblings = orderedWorkspaceItems(drag.list).filter((li) => li !== drag.li);
    const centers = siblings.map((li) => {
      const rect = li.getBoundingClientRect();
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
    const rect = body.getBoundingClientRect();
    if (drag.lastY < rect.top + EDGE_SCROLL_PX) {
      body.scrollTop -= EDGE_SCROLL_SPEED;
    } else if (drag.lastY > rect.bottom - EDGE_SCROLL_PX) {
      body.scrollTop += EDGE_SCROLL_SPEED;
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
    document.body?.classList.remove('sidebar-workspace-drag-active');
    if (!finished.moved) return;
    // A live reorder already happened: swallow the click that browsers fire
    // after pointerup so the drop does not toggle/activate the workspace.
    suppressClick = true;
    const keys = collectWorkspaceKeysFromList(finished.list);
    const changed =
      keys.length !== finished.originalKeys.length ||
      keys.some((key, i) => key !== finished.originalKeys[i]);
    if (!changed) return;
    onOrderChange(keys);
  }

  function onPointerDown(ev) {
    if (drag || pending) return;
    if (!isEnabled()) return;
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    const raw = ev.target;
    const target =
      raw instanceof Element ? raw : raw && raw.parentElement instanceof Element ? raw.parentElement : null;
    if (!target) return;
    if (target.closest('.sidebar-workspace-new-btn')) return;
    const header = target.closest('.sidebar-workspace-header');
    if (!header) return;
    const li = header.closest('.sidebar-workspace');
    if (!li || !(li instanceof HTMLElement)) return;
    const siblings = li.parentElement?.querySelectorAll(':scope > .sidebar-workspace');
    if (!siblings || siblings.length < 2) return;
    pending = {
      li,
      startX: ev.clientX,
      startY: ev.clientY,
      timer: window.setTimeout(() => {
        const started = pending;
        pending = null;
        if (started) beginDrag(started);
      }, HOLD_MS),
    };
  }

  function onPointerMove(ev) {
    if (drag) {
      ev.preventDefault();
      drag.lastY = ev.clientY;
      moveDraggedItem(ev.clientY);
      return;
    }
    if (!pending) return;
    const dx = ev.clientX - pending.startX;
    const dy = ev.clientY - pending.startY;
    if (dx * dx + dy * dy > MOVE_CANCEL_PX * MOVE_CANCEL_PX) cancelPending();
  }

  function onPointerEnd() {
    if (drag) endDrag();
    else cancelPending();
  }

  // iOS Safari: preventDefault on pointermove does not stop touch scrolling,
  // so block touchmove explicitly while a drag is active.
  function onTouchMove(ev) {
    if (drag) ev.preventDefault();
  }

  function onClickCapture(ev) {
    if (!suppressClick) return;
    suppressClick = false;
    ev.preventDefault();
    ev.stopPropagation();
  }

  body.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerEnd);
  window.addEventListener('pointercancel', onPointerEnd);
  body.addEventListener('touchmove', onTouchMove, { passive: false });
  body.addEventListener('click', onClickCapture, true);

  return {
    isDragging: () => drag !== null,
  };
}
