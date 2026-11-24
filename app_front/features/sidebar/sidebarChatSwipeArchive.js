/**
 * Swipe a live sidebar chat row to the right to archive it (touch / pen only).
 * Once a rightward swipe is under way, dragging back past the start reveals a
 * delete action on the right; releasing there deletes (the delete flow confirms).
 * The row follows the finger, an archive icon is revealed behind it, a haptic
 * tick fires when the commit threshold is crossed, and releasing past it archives.
 */

import { haptic } from '../../lib/haptics.js';

const LOCK_PX = 10;
const COMMIT_PX = 84;
const FLICK_VELOCITY = 0.7; // px/ms
const FLICK_MIN_PX = 40;
const RESISTANCE = 0.35;
const SETTLE_MS = 160;

/**
 * @param {number} dx
 * @returns {number}
 */
export function resolveSwipeOffset(dx) {
  if (dx <= 0) return 0;
  return dx <= COMMIT_PX ? dx : COMMIT_PX + (dx - COMMIT_PX) * RESISTANCE;
}

/**
 * @param {{ dx: number, velocityX: number }} args
 * @returns {boolean}
 */
export function shouldCommitArchiveSwipe({ dx, velocityX }) {
  if (dx >= COMMIT_PX) return true;
  return dx >= FLICK_MIN_PX && velocityX >= FLICK_VELOCITY;
}

/**
 * @param {{
 *   body: HTMLElement,
 *   isEnabled?: () => boolean,
 *   isBlocked: (chatId: string) => boolean,
 *   onArchive: (chatId: string) => void,
 *   onDelete?: (chatId: string) => void,
 * }} options
 */
export function initSidebarChatSwipeArchive(options) {
  const { body, isEnabled = () => true, isBlocked, onArchive, onDelete } = options;
  /** @type {null | { li: HTMLElement, pointerId: number, startX: number, startY: number, lastX: number, lastT: number, velocityX: number, phase: 'pending' | 'tracking', armed: boolean, hint: HTMLElement | null, deleteHint: HTMLElement | null, side: 'archive' | 'delete' }} */
  let gesture = null;
  let suppressClick = false;

  function reset() {
    if (!gesture) return;
    const { li } = gesture;
    li.classList.remove('is-swiping-archive', 'is-swipe-armed', 'is-swipe-armed-delete');
    li.style.removeProperty('--sidebar-swipe-x');
    li.style.removeProperty('--sidebar-swipe-reveal');
    li.style.removeProperty('--sidebar-swipe-reveal-delete');
    gesture.hint?.remove();
    gesture.deleteHint?.remove();
    gesture = null;
  }

  function onPointerDown(ev) {
    if (gesture || !isEnabled()) return;
    if (ev.pointerType !== 'touch' && ev.pointerType !== 'pen') return;
    const raw = ev.target;
    const target = raw instanceof Element ? raw : null;
    if (!target || target.closest('.sidebar-chat-action')) return;
    const li = target.closest('.sidebar-chat-item');
    if (!(li instanceof HTMLElement) || !li.dataset.chatId) return;
    if (li.dataset.archived === '1' || li.classList.contains('is-archived')) return;
    if (li.hidden || li.classList.contains('is-subchat-hidden')) return;
    gesture = {
      li,
      pointerId: ev.pointerId,
      startX: ev.clientX,
      startY: ev.clientY,
      lastX: ev.clientX,
      lastT: ev.timeStamp || Date.now(),
      velocityX: 0,
      phase: 'pending',
      armed: false,
      hint: null,
      deleteHint: null,
      side: 'archive',
    };
  }

  function startTracking(g) {
    g.phase = 'tracking';
    const hint = document.createElement('span');
    hint.className = 'sidebar-chat-swipe-hint mdi mdi-archive-arrow-down-outline';
    hint.setAttribute('aria-hidden', 'true');
    g.li.appendChild(hint);
    g.hint = hint;
    const deleteHint = document.createElement('span');
    deleteHint.className = 'sidebar-chat-swipe-hint sidebar-chat-swipe-hint--delete mdi mdi-trash-can-outline';
    deleteHint.setAttribute('aria-hidden', 'true');
    g.li.appendChild(deleteHint);
    g.deleteHint = deleteHint;
    g.li.classList.add('is-swiping-archive');
    try { g.li.setPointerCapture(g.pointerId); } catch (_) { /* pointer already gone */ }
  }

  function onPointerMove(ev) {
    const g = gesture;
    if (!g || ev.pointerId !== g.pointerId) return;
    const dx = ev.clientX - g.startX;
    const dy = ev.clientY - g.startY;
    if (g.phase === 'pending') {
      if (Math.abs(dy) > LOCK_PX && Math.abs(dy) >= Math.abs(dx)) { reset(); return; }
      if (dx < -LOCK_PX) { reset(); return; }
      if (dx > LOCK_PX && dx > Math.abs(dy) * 1.5) startTracking(g);
      else return;
    }
    const now = ev.timeStamp || Date.now();
    const dt = Math.max(1, now - g.lastT);
    g.velocityX = (ev.clientX - g.lastX) / dt;
    g.lastX = ev.clientX;
    g.lastT = now;
    const side = dx >= 0 ? 'archive' : 'delete';
    const magnitude = Math.abs(dx);
    const offset = resolveSwipeOffset(magnitude) * (side === 'delete' ? -1 : 1);
    g.li.style.setProperty('--sidebar-swipe-x', offset.toFixed(1) + 'px');
    // The icon fades in only once enough of the row has moved, so it never peeks out at the screen edge.
    const reveal = Math.min(1, Math.max(0, (Math.abs(offset) - 28) / 40)).toFixed(2);
    g.li.style.setProperty('--sidebar-swipe-reveal', side === 'archive' ? reveal : '0');
    g.li.style.setProperty('--sidebar-swipe-reveal-delete', side === 'delete' ? reveal : '0');
    const armed = magnitude >= COMMIT_PX;
    if (armed !== g.armed || side !== g.side) {
      const wasArmed = g.armed && side === g.side;
      g.armed = armed;
      g.side = side;
      g.li.classList.toggle('is-swipe-armed', armed && side === 'archive');
      g.li.classList.toggle('is-swipe-armed-delete', armed && side === 'delete');
      if (armed !== wasArmed) haptic('tick');
    }
    ev.preventDefault();
  }

  function finish(ev, cancelled) {
    const g = gesture;
    if (!g || ev.pointerId !== g.pointerId) return;
    if (g.phase === 'pending') { reset(); return; }
    suppressClick = true;
    window.setTimeout(() => { suppressClick = false; }, 350);
    const dx = ev.clientX - g.startX;
    const chatId = g.li.dataset.chatId || '';
    const isDelete = dx < 0;
    const commit = !cancelled && shouldCommitArchiveSwipe(
      isDelete ? { dx: -dx, velocityX: -g.velocityX } : { dx, velocityX: g.velocityX },
    );
    const { li } = g;
    li.classList.add('is-swipe-settling');
    if (commit && chatId && !isDelete && isBlocked(chatId)) {
      haptic('warn');
    } else if (commit && chatId && isDelete) {
      // Delete always goes through the confirm modal, so the row snaps back
      // instead of leaving the list.
      haptic('warn');
      onDelete?.(chatId);
    } else if (commit && chatId) {
      li.style.setProperty('--sidebar-swipe-x', (isDelete ? -li.offsetWidth : li.offsetWidth) + 'px');
      haptic(isDelete ? 'warn' : 'select');
      window.setTimeout(() => (isDelete ? onDelete?.(chatId) : onArchive(chatId)), SETTLE_MS);
      window.setTimeout(() => li.classList.remove('is-swipe-settling'), SETTLE_MS + 40);
      // Keep the row displaced until the archive re-render replaces it; if the
      // archive is declined or fails, the row slides back.
      window.setTimeout(() => {
        if (!li.isConnected) return;
        li.classList.add('is-swipe-settling');
        li.style.setProperty('--sidebar-swipe-x', '0px');
        window.setTimeout(() => {
          li.classList.remove('is-swiping-archive', 'is-swipe-armed', 'is-swipe-armed-delete', 'is-swipe-settling');
          li.style.removeProperty('--sidebar-swipe-x');
    li.style.removeProperty('--sidebar-swipe-reveal');
    li.style.removeProperty('--sidebar-swipe-reveal-delete');
          g.hint?.remove();
          g.deleteHint?.remove();
        }, SETTLE_MS + 40);
      }, 1800);
      gesture = null;
      return;
    }
    li.style.setProperty('--sidebar-swipe-x', '0px');
    window.setTimeout(() => li.classList.remove('is-swipe-settling'), SETTLE_MS + 40);
    reset();
  }

  function onClickCapture(ev) {
    if (!suppressClick) return;
    suppressClick = false;
    ev.preventDefault();
    ev.stopPropagation();
  }

  body.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove, { passive: false });
  window.addEventListener('pointerup', (ev) => finish(ev, false));
  window.addEventListener('pointercancel', (ev) => finish(ev, true));
  body.addEventListener('click', onClickCapture, true);

  return { isSwiping: () => gesture?.phase === 'tracking' };
}
