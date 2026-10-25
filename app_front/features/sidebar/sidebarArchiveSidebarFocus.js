/**
 * Archive list focus capture, restore, and keyboard delegation (stage 7.3).
 * Shared by sidebarView and DOM harness tests — no duplicated logic in harness.
 */

import { getSidebarArchiveGroupRegistration } from './sidebarArchiveGroupPass.js';
import {
  findArchiveLogicalIndexByChatId,
  resolveArchiveStoredLogicalIndex,
  resolveNextArchiveLogicalIndex,
} from './sidebarArchiveVirtualNavigation.js';
import {
  clearSidebarArchiveVirtualFocus,
  getSidebarArchiveVirtualFocus,
  isSidebarArchiveGestureActive,
  setSidebarArchiveVirtualFocus,
} from './sidebarArchiveVirtualFocus.js';

/**
 * Selector-safe id escaping (CSS.escape when available, conservative fallback).
 *
 * @param {string} value
 * @returns {string}
 */
export function sidebarSelectorCssEscape(value) {
  const s = String(value ?? '');
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(s);
  return s.replace(/["\\]/g, '\\$&');
}

/**
 * @param {Element} body
 * @param {string} chatId
 * @returns {{ sidebarKey: string, logicalIndex: number } | null}
 */
export function findArchiveGroupForChatId(body, chatId) {
  const id = String(chatId || '').trim();
  if (!id) return null;
  const groups = body.querySelectorAll('.sidebar-archive-group[data-sidebar-key]');
  for (const groupEl of groups) {
    const sidebarKey = groupEl.getAttribute('data-sidebar-key') || '';
    const reg = sidebarKey ? getSidebarArchiveGroupRegistration(sidebarKey) : null;
    const tree = reg?.archiveTree;
    const logicalIndex = Array.isArray(tree) ? findArchiveLogicalIndexByChatId(tree, id) : -1;
    if (logicalIndex >= 0 && sidebarKey) {
      return { sidebarKey, logicalIndex };
    }
  }
  return null;
}

/**
 * @param {Element} body
 * @returns {{
 *   chatId: string,
 *   parentId: string,
 *   pinnedId: string,
 *   sidebarKey: string,
 *   actionKind: string,
 *   archiveListboxFocus: boolean,
 *   logicalIndex: number,
 * } | null}
 */
export function captureSidebarFocusInfo(body) {
  const active = document.activeElement;
  if (!active || typeof body.contains !== 'function' || !body.contains(active)) return null;
  const archiveListbox = active.closest?.('.sidebar-archive-list');
  if (
    archiveListbox instanceof HTMLElement
    && archiveListbox === active
    && archiveListbox.getAttribute('tabindex') === '0'
  ) {
    const groupEl = archiveListbox.closest('.sidebar-archive-group');
    const sidebarKey = groupEl?.getAttribute('data-sidebar-key') || '';
    const stored = sidebarKey ? getSidebarArchiveVirtualFocus(sidebarKey) : null;
    return {
      chatId: stored?.chatId || '',
      parentId: '',
      pinnedId: '',
      sidebarKey,
      actionKind: '',
      archiveListboxFocus: true,
      logicalIndex: stored?.logicalIndex ?? -1,
    };
  }
  const chatItem = active.closest?.('.sidebar-chat-item');
  const actionBtn = active.closest?.('.sidebar-chat-action');
  const moreEl = active.closest?.('.sidebar-chat-more');
  let actionKind = '';
  if (actionBtn instanceof HTMLElement) {
    if (actionBtn.classList.contains('sidebar-chat-fav-btn')) actionKind = 'fav';
    else if (actionBtn.classList.contains('sidebar-chat-pin-btn')) actionKind = 'pin';
  }
  const archiveList = chatItem?.closest?.('.sidebar-archive-list');
  const archiveGroupKey = archiveList
    ? chatItem?.closest('.sidebar-archive-group')?.getAttribute('data-sidebar-key') || ''
    : '';
  return {
    chatId: chatItem?.dataset?.chatId || '',
    parentId: active.closest?.('.sidebar-subchat-group')?.getAttribute('data-parent-id') || '',
    pinnedId: active.closest?.('.sidebar-pinned-chat')?.dataset?.pinnedChatId
      || active.dataset?.pinnedChatId
      || '',
    sidebarKey: archiveGroupKey || moreEl?.dataset?.sidebarKey || '',
    actionKind,
    archiveListboxFocus: false,
    logicalIndex: -1,
  };
}

/**
 * @param {Element} body
 * @param {string} sidebarKey
 * @param {number} logicalIndex
 * @param {boolean} [focus]
 * @returns {Promise<boolean>}
 */
export async function revealSidebarArchiveLogicalIndex(body, sidebarKey, logicalIndex, focus = true) {
  const host = body.querySelector(
    'cr-sidebar-archive-group[sidebar-key="' + sidebarSelectorCssEscape(sidebarKey) + '"]',
  );
  if (!host || typeof host.revealLogicalIndex !== 'function') return false;
  return host.revealLogicalIndex(logicalIndex, { focus });
}

/**
 * @param {Element} body
 * @param {string} chatId
 * @returns {Promise<HTMLElement | null>}
 */
export async function ensureArchivedChatRowMounted(body, chatId) {
  const id = String(chatId || '').trim();
  if (!id) return null;
  let row = body.querySelector('.sidebar-chat-item[data-chat-id="' + sidebarSelectorCssEscape(id) + '"]');
  if (row) return row instanceof HTMLElement ? row : null;
  const archiveRow = body.querySelector(
    '.sidebar-archive-list .sidebar-chat-item[data-chat-id="' + sidebarSelectorCssEscape(id) + '"]',
  );
  if (archiveRow) return archiveRow instanceof HTMLElement ? archiveRow : null;
  const located = findArchiveGroupForChatId(body, id);
  if (!located) return null;
  const { sidebarKey, logicalIndex } = located;
  await revealSidebarArchiveLogicalIndex(body, sidebarKey, logicalIndex, false);
  row = body.querySelector('.sidebar-chat-item[data-chat-id="' + sidebarSelectorCssEscape(id) + '"]');
  return row instanceof HTMLElement ? row : null;
}

/**
 * @param {Element} body
 * @param {ReturnType<typeof captureSidebarFocusInfo>} info
 */
export function restoreSidebarFocus(body, info) {
  if (!info) return;
  if (info.archiveListboxFocus && info.sidebarKey) {
    const list = body.querySelector(
      '.sidebar-archive-group[data-sidebar-key="' + sidebarSelectorCssEscape(info.sidebarKey) + '"] .sidebar-archive-list',
    );
    if (list instanceof HTMLElement) {
      if (info.chatId) {
        setSidebarArchiveVirtualFocus(info.sidebarKey, {
          chatId: info.chatId,
          logicalIndex: Number.isFinite(Number(info.logicalIndex)) ? Number(info.logicalIndex) : -1,
        });
      }
      list.setAttribute('tabindex', '0');
      list.querySelectorAll('.sidebar-chat-item').forEach((row) => row.setAttribute('tabindex', '-1'));
      try {
        list.focus({ preventScroll: true });
      } catch (_) {
        list.focus?.();
      }
      return;
    }
  }
  let el = null;
  if (info.chatId && info.actionKind) {
    const row = body.querySelector('.sidebar-chat-item[data-chat-id="' + sidebarSelectorCssEscape(info.chatId) + '"]');
    if (row) {
      const selector = info.actionKind === 'fav'
        ? '.sidebar-chat-fav-btn'
        : '.sidebar-chat-pin-btn';
      el = row.querySelector(selector);
    }
  }
  if (!el && info.chatId && !info.actionKind) {
    el = body.querySelector('.sidebar-chat-item[data-chat-id="' + sidebarSelectorCssEscape(info.chatId) + '"]');
    if (!el) {
      void ensureArchivedChatRowMounted(body, info.chatId).then((mounted) => {
        if (!mounted) return;
        try {
          mounted.focus({ preventScroll: true });
        } catch (_) {
          mounted.focus?.();
        }
      });
      return;
    }
  }
  if (!el && info.sidebarKey) {
    el = body.querySelector(
      '.sidebar-chat-more[data-sidebar-key="' + sidebarSelectorCssEscape(info.sidebarKey) + '"]',
    );
  }
  if (!el && info.parentId) {
    el = body.querySelector(
      '.sidebar-subchat-group[data-parent-id="' + sidebarSelectorCssEscape(info.parentId) + '"] .sidebar-subchat-group-toggle',
    );
  }
  if (!el && info.pinnedId) {
    el = body.querySelector('.sidebar-pinned-chat[data-pinned-chat-id="' + sidebarSelectorCssEscape(info.pinnedId) + '"]');
  }
  if (!el || el === document.activeElement) return;
  try {
    el.focus({ preventScroll: true });
  } catch (_) {
    el.focus?.();
  }
}

/** @type {WeakSet<Element>} */
const wiredArchiveFocusBodies = new WeakSet();

/**
 * @param {Element} body
 */
export function wireArchiveVirtualFocusTracking(body) {
  if (wiredArchiveFocusBodies.has(body)) return;
  wiredArchiveFocusBodies.add(body);
  body.addEventListener('focusin', (ev) => {
    const target = ev.target instanceof Element ? ev.target : null;
    if (!target) return;
    if (
      target.classList.contains('sidebar-archive-list')
      && target.getAttribute('tabindex') === '0'
    ) {
      const groupEl = target.closest('.sidebar-archive-group');
      const sidebarKey = groupEl?.getAttribute('data-sidebar-key') || '';
      const stored = sidebarKey ? getSidebarArchiveVirtualFocus(sidebarKey) : null;
      if (sidebarKey && stored?.chatId) {
        setSidebarArchiveVirtualFocus(sidebarKey, {
          chatId: stored.chatId,
          logicalIndex: resolveArchiveStoredLogicalIndex(
            stored,
            getSidebarArchiveGroupRegistration(sidebarKey)?.archiveTree,
          ),
        });
      }
      return;
    }
    const chatItem = target.closest('.sidebar-chat-item');
    const archiveList = chatItem?.closest('.sidebar-archive-list');
    if (!archiveList || !chatItem) return;
    const groupEl = chatItem.closest('.sidebar-archive-group');
    const sidebarKey = groupEl?.getAttribute('data-sidebar-key') || '';
    if (!sidebarKey) return;
    let logicalIndex = Number(chatItem.getAttribute('data-archive-logical-index'));
    if (!Number.isFinite(logicalIndex)) {
      const reg = getSidebarArchiveGroupRegistration(sidebarKey);
      logicalIndex = findArchiveLogicalIndexByChatId(
        reg?.archiveTree,
        chatItem.getAttribute('data-chat-id') || '',
      );
    }
    setSidebarArchiveVirtualFocus(sidebarKey, {
      chatId: chatItem.getAttribute('data-chat-id') || '',
      logicalIndex: Number.isFinite(logicalIndex) ? logicalIndex : -1,
    });
  });
  body.addEventListener('focusout', (ev) => {
    if (isSidebarArchiveGestureActive()) return;
    const target = ev.target instanceof Element ? ev.target : null;
    if (!target) return;
    const groupEl = target.closest('.sidebar-archive-group');
    if (!groupEl) return;
    const sidebarKey = groupEl.getAttribute('data-sidebar-key') || '';
    if (!sidebarKey) return;
    const related = ev.relatedTarget instanceof Element ? ev.relatedTarget : null;
    if (related && groupEl.contains(related)) return;
    clearSidebarArchiveVirtualFocus(sidebarKey);
  });
}

/**
 * Archive listbox keyboard navigation (arrows, Home, End). Returns true when handled.
 *
 * @param {KeyboardEvent} ev
 * @param {Element} body
 * @returns {boolean}
 */
export function handleSidebarArchiveKeydown(ev, body) {
  const target = ev.target instanceof Element ? ev.target : null;
  if (!target || !body) return false;
  const chatItem = target.closest('.sidebar-chat-item');
  if (chatItem) {
    const archiveList = chatItem.closest('.sidebar-archive-list');
    if (!archiveList) return false;
    const groupEl = chatItem.closest('.sidebar-archive-group');
    const sidebarKey = groupEl?.getAttribute('data-sidebar-key') || '';
    const reg = sidebarKey ? getSidebarArchiveGroupRegistration(sidebarKey) : null;
    const tree = reg?.archiveTree;
    const total = Array.isArray(tree) ? tree.length : 0;
    if (!sidebarKey || !total) return false;
    const logicalIndex = resolveArchiveStoredLogicalIndex(
      {
        chatId: chatItem.getAttribute('data-chat-id') || '',
        logicalIndex: Number(chatItem.getAttribute('data-archive-logical-index')),
      },
      tree,
    );
    if (logicalIndex < 0) return false;
    const nextLogical = resolveNextArchiveLogicalIndex(ev.key, logicalIndex, total);
    if (nextLogical === null) return false;
    ev.preventDefault();
    void revealSidebarArchiveLogicalIndex(body, sidebarKey, nextLogical, true);
    return true;
  }
  const archiveListbox = target.closest('.sidebar-archive-list');
  if (archiveListbox instanceof HTMLElement && archiveListbox.getAttribute('tabindex') === '0') {
    const groupEl = archiveListbox.closest('.sidebar-archive-group');
    const sidebarKey = groupEl?.getAttribute('data-sidebar-key') || '';
    const reg = sidebarKey ? getSidebarArchiveGroupRegistration(sidebarKey) : null;
    const tree = reg?.archiveTree;
    const total = Array.isArray(tree) ? tree.length : 0;
    const stored = sidebarKey ? getSidebarArchiveVirtualFocus(sidebarKey) : null;
    const logicalIndex = resolveArchiveStoredLogicalIndex(stored, tree);
    if (!sidebarKey || !total || logicalIndex < 0) return false;
    const nextLogical = resolveNextArchiveLogicalIndex(ev.key, logicalIndex, total);
    if (nextLogical === null) return false;
    ev.preventDefault();
    void revealSidebarArchiveLogicalIndex(body, sidebarKey, nextLogical, true);
    return true;
  }
  return false;
}

