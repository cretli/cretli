/**
 * Logical focus for the virtualized archive list (stage 7.3).
 */

import { resolveArchiveStoredLogicalIndex } from './sidebarArchiveVirtualNavigation.js';

/** @typedef {{ chatId: string, logicalIndex: number }} SidebarArchiveVirtualFocus */

/** @type {Map<string, SidebarArchiveVirtualFocus>} */
const focusBySidebarKey = new Map();

/** @type {Map<string, true>} */
const focusInsideArchiveAtGestureStart = new Map();

let gestureWasActive = false;

/** @type {() => boolean} */
let gestureGuard = () => false;

/** @type {(() => void) | null} */
let gestureEndFlush = null;

/**
 * Sidebar drag/swipe defer full rebuild; archive focus transfers defer too.
 *
 * @param {() => boolean} fn
 */
export function registerSidebarArchiveGestureGuard(fn) {
  gestureGuard = typeof fn === 'function' ? fn : () => false;
}

/**
 * Runs after sidebar drag / workspace drag / swipe release to resync archive windows.
 *
 * @param {(() => void) | null} fn
 */
export function registerSidebarArchiveGestureEndFlush(fn) {
  gestureEndFlush = typeof fn === 'function' ? fn : null;
}

export function runSidebarArchiveGestureEndFlush() {
  gestureEndFlush?.();
}

/** @returns {boolean} */
export function isSidebarArchiveGestureActive() {
  return gestureGuard();
}

/**
 * Snapshot which archive groups contained focus when a sidebar gesture begins.
 *
 * @param {boolean} isGestureActive
 */
export function tickSidebarArchiveGestureFocusSnapshot(isGestureActive) {
  if (isGestureActive && !gestureWasActive) {
    focusInsideArchiveAtGestureStart.clear();
    if (typeof document !== 'undefined') {
      const active = document.activeElement;
      if (active instanceof Element) {
        for (const groupEl of document.querySelectorAll('.sidebar-archive-group[data-sidebar-key]')) {
          const sidebarKey = groupEl.getAttribute('data-sidebar-key') || '';
          if (sidebarKey && groupEl.contains(active)) {
            focusInsideArchiveAtGestureStart.set(sidebarKey, true);
          }
        }
      }
    }
  }
  gestureWasActive = isGestureActive;
}

/**
 * @param {string} sidebarKey
 * @returns {boolean}
 */
export function shouldRestoreArchiveFocusAfterGesture(sidebarKey) {
  const key = String(sidebarKey || '').trim();
  return focusInsideArchiveAtGestureStart.get(key) === true;
}

export function clearArchiveGestureFocusSnapshot() {
  focusInsideArchiveAtGestureStart.clear();
  gestureWasActive = false;
}

/**
 * @param {string} sidebarKey
 */
export function clearSidebarArchiveVirtualFocus(sidebarKey) {
  const key = String(sidebarKey || '').trim();
  if (!key) return;
  focusBySidebarKey.delete(key);
}

/**
 * @param {string} sidebarKey
 * @param {{ chatId?: string, logicalIndex?: number }} focus
 */
export function setSidebarArchiveVirtualFocus(sidebarKey, focus) {
  const key = String(sidebarKey || '').trim();
  if (!key || !focus) return;
  const chatId = String(focus.chatId || '').trim();
  const logicalIndex = Number.isFinite(Number(focus.logicalIndex))
    ? Math.max(0, Math.round(Number(focus.logicalIndex)))
    : -1;
  if (!chatId && logicalIndex < 0) {
    focusBySidebarKey.delete(key);
    return;
  }
  focusBySidebarKey.set(key, { chatId, logicalIndex });
}

/**
 * @param {string} sidebarKey
 * @returns {SidebarArchiveVirtualFocus | null}
 */
export function getSidebarArchiveVirtualFocus(sidebarKey) {
  const key = String(sidebarKey || '').trim();
  if (!key) return null;
  return focusBySidebarKey.get(key) || null;
}

/**
 * When a focused row leaves the mounted window during user scroll, keep the logical
 * index but move DOM focus to the listbox (roving tabindex on options resumes on
 * the next arrow key via reveal). Skipped mid sidebar drag/swipe.
 *
 * @param {object} input
 * @param {string} input.sidebarKey
 * @param {Array<{ chat?: { id?: string } }>} input.archiveTree
 * @param {number} input.startIndex
 * @param {number} input.endIndex
 * @param {boolean} input.fromUserScroll
 * @param {Element | null} input.listEl `.sidebar-archive-list`
 * @returns {boolean} true when focus was transferred to the listbox
 */
export function reconcileArchiveFocusAfterWindowChange(input) {
  if (gestureGuard()) return false;
  if (!input.fromUserScroll) return false;
  const sidebarKey = String(input.sidebarKey || '').trim();
  const listEl = input.listEl;
  if (!sidebarKey || !listEl || typeof listEl.setAttribute !== 'function') return false;
  const stored = getSidebarArchiveVirtualFocus(sidebarKey);
  if (!stored?.chatId) return false;
  const rows = Array.isArray(input.archiveTree) ? input.archiveTree : [];
  const logicalIndex = resolveArchiveStoredLogicalIndex(stored, rows);
  if (logicalIndex < 0) return false;
  const start = Math.max(0, Math.round(input.startIndex));
  const end = Math.max(start, Math.round(input.endIndex));
  if (logicalIndex >= start && logicalIndex < end) return false;
  const active = typeof document !== 'undefined' ? document.activeElement : null;
  const activeChatId = active && typeof active.closest === 'function'
    ? active.closest('.sidebar-chat-item')?.getAttribute?.('data-chat-id') || ''
    : '';
  if (activeChatId !== stored.chatId) return false;
  listEl.setAttribute('tabindex', '0');
  listEl.querySelectorAll('.sidebar-chat-item').forEach((el) => el.setAttribute('tabindex', '-1'));
  try {
    listEl.focus({ preventScroll: true });
  } catch (_) {
    listEl.focus?.();
  }
  setSidebarArchiveVirtualFocus(sidebarKey, { chatId: stored.chatId, logicalIndex });
  return true;
}

/** Test-only reset. */
export function __resetSidebarArchiveVirtualFocusForTest() {
  focusBySidebarKey.clear();
  gestureGuard = () => false;
  gestureEndFlush = null;
  clearArchiveGestureFocusSnapshot();
}
