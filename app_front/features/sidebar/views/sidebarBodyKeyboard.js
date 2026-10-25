/** Keyboard navigation for the sidebar body (pure, no closure state). */

import { handleSidebarArchiveKeydown } from '../sidebarArchiveSidebarFocus.js';

/**
 * One keydown listener on `.sidebar-body`: roving focus for the chat lists and
 * Enter/Space activation for the non-button rows. Real `<button>` elements are
 * left to the browser's native activation so a keypress never fires twice.
 */
export function onSidebarBodyKeydown(ev) {
  const target = ev.target instanceof Element ? ev.target : null;
  if (!target) return;
  if (target.closest('button, .sidebar-chat-action')) return;

  const body = target.closest('.sidebar-body');
  if (body && handleSidebarArchiveKeydown(ev, body)) return;

  const chatItem = target.closest('.sidebar-chat-item');
  if (chatItem) {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      chatItem.click();
      return;
    }
    const list = chatItem.closest('.sidebar-chat-list');
    if (!list) return;
    const items = Array.from(list.querySelectorAll('.sidebar-chat-item:not(.is-subchat-hidden)'))
      .filter((el) => !el.closest('[hidden]') && el.hidden !== true);
    const index = items.indexOf(chatItem);
    if (index < 0) return;
    const nextIndex = resolveNextItemIndex(ev.key, index, items.length);
    if (nextIndex === null) return;
    ev.preventDefault();
    items.forEach((el) => el.setAttribute('tabindex', '-1'));
    items[nextIndex].setAttribute('tabindex', '0');
    items[nextIndex].focus();
    return;
  }

  if (ev.key !== 'Enter' && ev.key !== ' ') return;
  const row = target.closest(
    '.sidebar-pinned-chat, .sidebar-workspace-header, .sidebar-archive-header, .sidebar-chat-more',
  );
  if (!row) return;
  ev.preventDefault();
  row.click();
}

/**
 * Roving-tabindex fallback: with no active chat nothing in a list would be
 * reachable with Tab. Runs after a rebuild, so it only walks the fresh rows.
 * @param {Element} body
 */
export function ensureChatListRovingTabindex(body) {
  body.querySelectorAll('.sidebar-chat-list').forEach((list) => {
    const readItems = () =>
      /** @type {HTMLElement[]} */ (Array.from(list.querySelectorAll('.sidebar-chat-item:not(.is-subchat-hidden)')))
        .filter((el) => !el.closest('[hidden]') && el.hidden !== true);
    const initial = readItems();
    if (initial.length && !initial.some((el) => el.getAttribute('tabindex') === '0')) {
      initial[0].setAttribute('tabindex', '0');
    }
  });
  body.querySelectorAll('.sidebar-archive-list').forEach((list) => {
    const items = /** @type {HTMLElement[]} */ (Array.from(list.querySelectorAll('.sidebar-chat-item')))
      .filter((el) => !el.closest('[hidden]') && el.hidden !== true);
    if (!items.length) return;
    if (!items.some((el) => el.getAttribute('tabindex') === '0')) {
      items[0].setAttribute('tabindex', '0');
    }
  });
}

/**
 * Index to move the roving focus to, or null when the key is not a
 * navigation key.
 * @param {string} key
 * @param {number} index
 * @param {number} count
 * @returns {number|null}
 */
export function resolveNextItemIndex(key, index, count) {
  if (key === 'ArrowDown') return (index + 1) % count;
  if (key === 'ArrowUp') return (index - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

/**
 * Keyboard support for the chat listboxes (arrows, Home/End, Enter/Space) now
 * lives in the delegated `onSidebarBodyKeydown`; only the pure index helper is
 * kept here (it is pinned by tests/sidebar-keyboard-nav.test.js).
 */
