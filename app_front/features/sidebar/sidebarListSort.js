/**
 * Per-browser sort mode and "favorites only" filter of the sidebar chat list.
 *
 * Sorting is a pure function so the render pass and the unit tests share it.
 * Favorites lead unless the user turned that off; the mode orders the rest. The default `created` mode
 * keeps the historical behaviour (newest first, stable, honours the manual
 * drag order); other modes ignore the manual order because it would fight them.
 */

import { readStorageValueWithAlias, writeStorageValueWithAlias } from '../../lib/storageKeyAlias.js';
import { filterChatsToLive } from './sidebarOnlyActiveFilter.js';

export const SIDEBAR_SORT_MODE_KEY = 'cretli-sidebar-sort-mode';
export const SIDEBAR_FAVORITES_FIRST_KEY = 'cretli-sidebar-favorites-first';
export const SIDEBAR_ONLY_FAVORITES_KEY = 'cretli-sidebar-only-favorites';

/** @typedef {'created' | 'updated' | 'title'} SidebarSortMode */
export const SIDEBAR_SORT_MODES = /** @type {const} */ (['created', 'updated', 'title']);
export const DEFAULT_SIDEBAR_SORT_MODE = 'created';

/**
 * @param {unknown} value
 * @returns {SidebarSortMode}
 */
export function normalizeSidebarSortMode(value) {
  return SIDEBAR_SORT_MODES.includes(/** @type {any} */ (value))
    ? /** @type {SidebarSortMode} */ (value)
    : DEFAULT_SIDEBAR_SORT_MODE;
}

/** @returns {SidebarSortMode} */
export function readSidebarSortMode() {
  if (typeof localStorage === 'undefined') return DEFAULT_SIDEBAR_SORT_MODE;
  try {
    return normalizeSidebarSortMode(readStorageValueWithAlias(localStorage, SIDEBAR_SORT_MODE_KEY, ''));
  } catch (_) {
    return DEFAULT_SIDEBAR_SORT_MODE;
  }
}

/** @param {string} mode */
export function writeSidebarSortMode(mode) {
  if (typeof localStorage === 'undefined') return;
  try {
    writeStorageValueWithAlias(localStorage, SIDEBAR_SORT_MODE_KEY, normalizeSidebarSortMode(mode));
  } catch (_) {}
}

/** @returns {boolean} on unless the user switched it off */
export function readSidebarFavoritesFirstFlag() {
  if (typeof localStorage === 'undefined') return true;
  try {
    return readStorageValueWithAlias(localStorage, SIDEBAR_FAVORITES_FIRST_KEY, '') !== '0';
  } catch (_) {
    return true;
  }
}

/** @param {boolean} value */
export function writeSidebarFavoritesFirstFlag(value) {
  if (typeof localStorage === 'undefined') return;
  try {
    writeStorageValueWithAlias(localStorage, SIDEBAR_FAVORITES_FIRST_KEY, value ? '1' : '0');
  } catch (_) {}
}

/** @returns {boolean} */
export function readSidebarOnlyFavoritesFlag() {
  if (typeof localStorage === 'undefined') return false;
  try {
    return readStorageValueWithAlias(localStorage, SIDEBAR_ONLY_FAVORITES_KEY, '') === '1';
  } catch (_) {
    return false;
  }
}

/** @param {boolean} value */
export function writeSidebarOnlyFavoritesFlag(value) {
  if (typeof localStorage === 'undefined') return;
  try {
    writeStorageValueWithAlias(localStorage, SIDEBAR_ONLY_FAVORITES_KEY, value ? '1' : '0');
  } catch (_) {}
}

function parseMs(value) {
  const ms = typeof value === 'string' && value ? new Date(value).getTime() : 0;
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Server-side change time (not local clicks), so opening a chat never moves it.
 * @param {any} chat
 * @returns {number}
 */
function chatChangedMs(chat) {
  return Math.max(parseMs(chat?.updatedAt), parseMs(chat?.createdAt));
}

/**
 * Favorites first, then the chosen mode; ties keep the input order.
 *
 * @param {any[]} chats
 * @param {SidebarSortMode} mode
 * @param {(chat: any) => boolean} [isFavorite]
 * @returns {any[]}
 */
export function sortChatsForSidebar(chats, mode, isFavorite = () => false) {
  if (!Array.isArray(chats) || !chats.length) return [];
  /** @type {(chat: any) => any} */
  const key = (chat) => {
    if (mode === 'updated') return chatChangedMs(chat);
    if (mode === 'title') return String(chat?.title || '');
    return parseMs(chat?.createdAt);
  };
  return chats
    .map((chat, idx) => ({ chat, idx, fav: isFavorite(chat) ? 1 : 0, k: key(chat) }))
    .sort((a, b) => {
      if (a.fav !== b.fav) return b.fav - a.fav;
      if (mode === 'title') {
        const byTitle = a.k.localeCompare(b.k, undefined, { numeric: true, sensitivity: 'base' });
        if (byTitle !== 0) return byTitle;
      } else if (a.k !== b.k) {
        return b.k - a.k;
      }
      return a.idx - b.idx;
    })
    .map((entry) => entry.chat);
}

/**
 * Keep favorite chats, the open chat and their fork ancestors (same rule as the
 * live-chats filter, so nested subchats stay attached).
 *
 * @param {any[]} chats
 * @param {{ isFavorite: (chat: any) => boolean, activeChatId?: string, keepIds?: Set<string> }} params
 * @returns {any[]}
 */
export function filterChatsToFavorites(chats, params) {
  return filterChatsToLive(chats, { isLive: params.isFavorite, activeChatId: params.activeChatId, keepIds: params.keepIds });
}
