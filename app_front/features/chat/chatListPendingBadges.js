/**
 * Task 1.2 — patch the pending-history badge inside the already-rendered rows of
 * the open chat-list modal, without rebuilding the list.
 *
 * The pending badge (`chat-list-item-sync-badge`) is rendered only by the modal
 * markup in `chatView.openChatListModal`; the sidebar never shows it. Before
 * this module every flip ran the full `renderChatList` (cache build/write,
 * model-label refresh, list rebuild). Here the publisher's net change set
 * (task 1.1 `addedIds` / `removedIds`) is applied to the existing nodes:
 *
 * - one `querySelectorAll` pass over the rendered rows, then only the changed
 *   rows are touched — never a `querySelector` per id across the whole list,
 * - the badge node alone is appended/removed, so every untouched row keeps its
 *   DOM identity,
 * - callers must check that the modal is open before calling; a closed modal
 *   gets zero pending DOM work and learns the state when it re-renders on open.
 *
 * Archived rows never carry the badge (the renderer does not emit it for them),
 * so an added id that resolves to an archived row is ignored.
 *
 * The module is DOM-free (it only consumes element-like objects) so it
 * unit-tests under `node`.
 */

import { getUiFreezeCounters } from '../../lib/uiFreezeCounters.js';

/** Class the modal renderer uses for the pending marker. */
export const CHAT_LIST_PENDING_BADGE_CLASS = 'chat-list-item-sync-badge';

const ROW_SELECTOR = '.chat-list-item[data-chat-id]';
const TITLE_SELECTOR = '.chat-list-item-title';
const BADGE_SELECTOR = `.${CHAT_LIST_PENDING_BADGE_CLASS}`;

/**
 * @typedef {object} PendingBadgePatchResult
 * @property {number} scanned rendered rows visited in the single pass
 * @property {number} added badges appended
 * @property {number} removed badges detached
 */

/**
 * @param {object} row element-like modal row
 * @returns {boolean} true when a badge was detached
 */
function removePendingBadge(row) {
  const badge = row.querySelector(BADGE_SELECTOR);
  if (!badge) return false;
  if (badge.parentNode && typeof badge.parentNode.removeChild === 'function') {
    badge.parentNode.removeChild(badge);
  } else if (typeof badge.remove === 'function') {
    badge.remove();
  }
  return true;
}

/**
 * Applies the net pending change set to the rows already inside `listEl`.
 *
 * @param {object | null | undefined} listEl the modal `#chat-list-items` element
 * @param {{ addedIds?: string[], removedIds?: string[] } | null | undefined} meta
 * @param {{ label?: string | (() => string), badgeText?: string, documentRef?: object }} [options]
 * @returns {PendingBadgePatchResult}
 */
export function applyChatListPendingBadgePatch(listEl, meta, options = {}) {
  /** @type {PendingBadgePatchResult} */
  const result = { scanned: 0, added: 0, removed: 0 };
  if (!listEl || typeof listEl.querySelectorAll !== 'function') return result;
  const addedIds = Array.isArray(meta?.addedIds) ? meta.addedIds.filter(Boolean) : [];
  const removedIds = Array.isArray(meta?.removedIds) ? meta.removedIds.filter(Boolean) : [];
  if (addedIds.length === 0 && removedIds.length === 0) return result;

  const addedSet = new Set(addedIds);
  const removedSet = new Set(removedIds);
  const documentRef = options.documentRef
    || (typeof document !== 'undefined' ? document : null);
  const label = typeof options.label === 'function' ? options.label() : String(options.label ?? '');
  const badgeText = typeof options.badgeText === 'string' ? options.badgeText : '●';

  // Single pass over the rendered rows: no per-id lookup over the list subtree.
  for (const row of listEl.querySelectorAll(ROW_SELECTOR)) {
    const id = row?.dataset?.chatId || '';
    if (!id) continue;
    result.scanned += 1;
    if (removedSet.has(id) && removePendingBadge(row)) result.removed += 1;
    if (!addedSet.has(id)) continue;
    // Archived rows are rendered without a pending marker; keep them that way.
    if (row.dataset?.archived === '1') continue;
    if (row.querySelector(BADGE_SELECTOR)) continue;
    const title = row.querySelector(TITLE_SELECTOR);
    if (!title || !documentRef || typeof documentRef.createElement !== 'function') continue;
    const badge = documentRef.createElement('span');
    badge.className = CHAT_LIST_PENDING_BADGE_CLASS;
    badge.title = label;
    badge.textContent = badgeText;
    title.appendChild(badge);
    result.added += 1;
  }

  const counters = getUiFreezeCounters();
  if (counters) {
    counters.bump('ui.pendingBadgePatch');
    counters.bump('ui.pendingBadgeRows', result.scanned);
    counters.bump('ui.pendingBadgeMarkers', result.added + result.removed);
  }
  return result;
}

/**
 * Fallback for a publisher that did not attach `addedIds`/`removedIds`: derives
 * the change set from the changed chat objects' current flag. The task 1.1
 * publisher always sends the meta, so this is only a safety net.
 *
 * @param {object[] | null | undefined} changedChats
 * @returns {{ addedIds: string[], removedIds: string[] }}
 */
export function derivePendingBadgeMeta(changedChats) {
  /** @type {string[]} */
  const addedIds = [];
  /** @type {string[]} */
  const removedIds = [];
  for (const chat of Array.isArray(changedChats) ? changedChats : []) {
    const id = String(chat?.id || '').trim();
    if (!id) continue;
    if (chat?._pendingRemoteHistory === true) addedIds.push(id);
    else removedIds.push(id);
  }
  return { addedIds, removedIds };
}
