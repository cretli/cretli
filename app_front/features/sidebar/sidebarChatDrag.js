/**
 * Press-and-hold drag & drop for sidebar chats: reorder, nest under a root,
 * or lift a child back to the root list.
 */

import { resolveChatDrop, updateChatNestHold } from './sidebarChatDrop.js';
import { collectChatIdsFromList } from './sidebarChatOrder.js';

const HOLD_MS = 250;
const MOVE_CANCEL_PX = 8;
const EDGE_SCROLL_PX = 48;
const EDGE_SCROLL_SPEED = 12;

/**
 * @param {HTMLElement} li
 * @returns {HTMLElement[]}
 */
function collectChatBlock(li) {
  const nodes = [li];
  if (li.classList.contains('is-child')) return nodes;
  let next = li.nextElementSibling;
  while (next instanceof HTMLElement && next.classList.contains('sidebar-chat-item') && next.classList.contains('is-child')) {
    nodes.push(next);
    next = next.nextElementSibling;
  }
  return nodes;
}

/**
 * @param {HTMLElement} list
 * @returns {{ id: string, top: number, bottom: number, isChild: boolean }[]}
 */
function measureChatItems(list) {
  return Array.from(list.querySelectorAll('.sidebar-chat-item')).map((li) => {
    const rect = li.getBoundingClientRect();
    return {
      id: li.dataset.chatId || '',
      top: rect.top,
      bottom: rect.bottom,
      isChild: li.classList.contains('is-child'),
    };
  });
}

/**
 * @param {{
 *   body: HTMLElement | null,
 *   isEnabled?: () => boolean,
 *   onDrop?: (result: { orderedIds: string[], draggedId: string, parentChatId: string }) => void,
 * }} options
 * @returns {{ isDragging: () => boolean }}
 */
export function initSidebarChatDrag({ body, isEnabled = () => true, onDrop = () => {} }) {
  if (!body || typeof window === 'undefined' || typeof PointerEvent === 'undefined') {
    return { isDragging: () => false };
  }

  /** @type {{ li: HTMLElement, startX: number, startY: number, timer: number } | null} */
  let pending = null;
  /** @type {{
   *   li: HTMLElement,
   *   list: HTMLElement,
   *   lastY: number,
   *   raf: number,
   *   originalIds: string[],
   *   originalParent: string,
   *   moved: boolean,
   *   nestParentId: string,
   *   hoverId: string,
   *   hoverSince: number,
   *   nestArmed: boolean,
   * } | null} */
  let drag = null;
  let suppressClick = false;

  function cancelPending() {
    if (!pending) return;
    clearTimeout(pending.timer);
    pending = null;
  }

  function clearNestHighlight(list) {
    list.querySelectorAll('.sidebar-chat-item.is-drop-nest, .sidebar-chat-item.is-drop-nest-pending').forEach((el) => {
      el.classList.remove('is-drop-nest', 'is-drop-nest-pending');
    });
  }

  function paintNestHighlight(list, hoveredId, nestArmed) {
    clearNestHighlight(list);
    if (!hoveredId) return;
    const nestEl = list.querySelector(`.sidebar-chat-item[data-chat-id="${CSS.escape(hoveredId)}"]`);
    if (!nestEl) return;
    nestEl.classList.add(nestArmed ? 'is-drop-nest' : 'is-drop-nest-pending');
  }

  function beginDrag(pending2) {
    const list = pending2.li.closest('.sidebar-chat-list');
    if (!(list instanceof HTMLElement)) return;
    const originalParent = pending2.li.classList.contains('is-child')
      ? (() => {
          let prev = pending2.li.previousElementSibling;
          while (prev instanceof HTMLElement && prev.classList.contains('is-child')) {
            prev = prev.previousElementSibling;
          }
          return prev instanceof HTMLElement ? prev.dataset.chatId || '' : '';
        })()
      : '';
    drag = {
      li: pending2.li,
      list,
      lastY: pending2.startY,
      raf: 0,
      originalIds: collectChatIdsFromList(list),
      originalParent,
      moved: false,
      nestParentId: '',
      hoverId: '',
      hoverSince: 0,
      nestArmed: false,
    };
    pending2.li.classList.add('is-dragging');
    document.body?.classList.add('sidebar-chat-drag-active');
    drag.raf = requestAnimationFrame(rafStep);
  }

  /**
   * @param {number} y
   */
  function moveDraggedItem(y) {
    if (!drag) return;
    const block = collectChatBlock(drag.li);
    const draggedIds = block.map((node) => node.dataset.chatId || '').filter(Boolean);
    const hoverGuess = resolveChatDrop({
      items: measureChatItems(drag.list),
      y,
      draggedIds,
      nestArmed: false,
    });
    const hold = updateChatNestHold(drag, hoverGuess.hoveredId, Date.now());
    drag.hoverId = hold.hoverId;
    drag.hoverSince = hold.hoverSince;
    drag.nestArmed = hold.nestArmed;
    const drop = hold.nestArmed
      ? resolveChatDrop({
          items: measureChatItems(drag.list),
          y,
          draggedIds,
          nestArmed: true,
        })
      : hoverGuess;
    paintNestHighlight(drag.list, drop.hoveredId, drop.mode === 'nest');
    drag.nestParentId = drop.nestParentId;
    const beforeEl = drop.beforeId
      ? drag.list.querySelector(`.sidebar-chat-item[data-chat-id="${CSS.escape(drop.beforeId)}"]`)
      : null;
    const beforeNode = beforeEl instanceof HTMLElement ? beforeEl : null;
    const alreadyPlaced = beforeNode
      ? block[block.length - 1].nextElementSibling === beforeNode
      : drag.list.lastElementChild === block[block.length - 1];
    const parentChatId = drop.parentChatId;
    if (parentChatId) drag.li.classList.add('is-child');
    else drag.li.classList.remove('is-child');
    if (alreadyPlaced) return;
    drag.moved = true;
    const frag = document.createDocumentFragment();
    block.forEach((node) => frag.appendChild(node));
    drag.list.insertBefore(frag, beforeNode);
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

  function parentAfterDrop(finished) {
    if (finished.nestParentId) return finished.nestParentId;
    if (!finished.li.classList.contains('is-child')) return '';
    let prev = finished.li.previousElementSibling;
    while (prev instanceof HTMLElement && prev.classList.contains('is-child')) {
      prev = prev.previousElementSibling;
    }
    return prev instanceof HTMLElement ? prev.dataset.chatId || '' : '';
  }

  function endDrag() {
    const finished = drag;
    drag = null;
    if (!finished) return;
    cancelAnimationFrame(finished.raf);
    finished.li.classList.remove('is-dragging');
    clearNestHighlight(finished.list);
    document.body?.classList.remove('sidebar-chat-drag-active');
    if (!finished.moved && !finished.nestParentId) return;
    suppressClick = true;
    const orderedIds = collectChatIdsFromList(finished.list);
    const parentChatId = parentAfterDrop(finished);
    const orderChanged =
      orderedIds.length !== finished.originalIds.length ||
      orderedIds.some((id, i) => id !== finished.originalIds[i]);
    const parentChanged = parentChatId !== finished.originalParent;
    if (!orderChanged && !parentChanged) return;
    onDrop({
      orderedIds,
      draggedId: finished.li.dataset.chatId || '',
      parentChatId,
    });
  }

  function onPointerDown(ev) {
    if (drag || pending) return;
    if (!isEnabled()) return;
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    const raw = ev.target;
    const target =
      raw instanceof Element ? raw : raw && raw.parentElement instanceof Element ? raw.parentElement : null;
    if (!target) return;
    if (target.closest('.sidebar-chat-action')) return;
    const li = target.closest('.sidebar-chat-item');
    if (!li || !(li instanceof HTMLElement) || !li.dataset.chatId) return;
    const list = li.closest('.sidebar-chat-list');
    const items = list?.querySelectorAll('.sidebar-chat-item');
    if (!items || items.length < 2) return;
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
