/**
 * Pure hit-testing for sidebar chat drag.
 * Reorder follows the pointer immediately. Nesting onto a hovered chat is
 * armed only after a dwell (`nestArmed`), so a short pass does not attach.
 */

export const CHAT_NEST_HOLD_MS = 500;

/**
 * @typedef {{ id: string, top: number, bottom: number, isChild: boolean }} ChatDropItem
 * @typedef {{ mode: 'nest' | 'insert', nestParentId: string, beforeId: string | null, parentChatId: string, hoveredId: string }} ChatDropResult
 */

/**
 * @param {ChatDropItem[]} items
 * @param {ChatDropItem} item
 * @returns {string}
 */
function folderRootId(items, item) {
  if (!item.isChild) return item.id;
  const index = items.findIndex((entry) => entry.id === item.id);
  for (let i = index - 1; i >= 0; i -= 1) {
    if (!items[i].isChild) return items[i].id;
  }
  return '';
}

/**
 * @param {ChatDropItem[]} items
 * @param {number} startIndex
 * @returns {string | null}
 */
function nextRootId(items, startIndex) {
  for (let i = startIndex; i < items.length; i += 1) {
    if (!items[i].isChild) return items[i].id;
  }
  return null;
}

/**
 * @param {ChatDropItem[]} others
 * @param {ChatDropItem} item
 * @param {string} hoveredId
 * @returns {ChatDropResult}
 */
function insertBeforeItem(others, item, hoveredId) {
  const parentChatId = item.isChild ? folderRootId(others, item) : '';
  return {
    mode: 'insert',
    nestParentId: '',
    beforeId: item.id,
    parentChatId,
    hoveredId,
  };
}

/**
 * @param {ChatDropItem[]} others
 * @param {ChatDropItem} item
 * @param {string} hoveredId
 * @returns {ChatDropResult}
 */
function insertAfterItem(others, item, hoveredId) {
  const index = others.findIndex((entry) => entry.id === item.id);
  if (item.isChild) {
    const next = others[index + 1];
    if (!next) {
      return {
        mode: 'insert',
        nestParentId: '',
        beforeId: null,
        parentChatId: folderRootId(others, item),
        hoveredId,
      };
    }
    if (next.isChild) {
      return {
        mode: 'insert',
        nestParentId: '',
        beforeId: next.id,
        parentChatId: folderRootId(others, item),
        hoveredId,
      };
    }
    return {
      mode: 'insert',
      nestParentId: '',
      beforeId: next.id,
      parentChatId: '',
      hoveredId,
    };
  }
  return {
    mode: 'insert',
    nestParentId: '',
    beforeId: nextRootId(others, index + 1),
    parentChatId: '',
    hoveredId,
  };
}

/**
 * @param {ChatDropItem[]} others
 * @param {ChatDropItem} hovered
 * @returns {ChatDropResult}
 */
function nestOntoItem(others, hovered) {
  const index = others.indexOf(hovered);
  const next = others[index + 1];
  return {
    mode: 'nest',
    nestParentId: hovered.id,
    beforeId: next ? next.id : null,
    parentChatId: hovered.id,
    hoveredId: hovered.id,
  };
}

/**
 * Tracks how long the pointer has stayed on the same hovered chat.
 *
 * @param {{ hoverId?: string, hoverSince?: number }} state
 * @param {string} hoveredId
 * @param {number} now
 * @param {number} [holdMs]
 * @returns {{ hoverId: string, hoverSince: number, nestArmed: boolean }}
 */
export function updateChatNestHold(state, hoveredId, now, holdMs = CHAT_NEST_HOLD_MS) {
  const id = String(hoveredId || '').trim();
  const clock = typeof now === 'number' && Number.isFinite(now) ? now : 0;
  const threshold = typeof holdMs === 'number' && holdMs > 0 ? holdMs : CHAT_NEST_HOLD_MS;
  if (!id) return { hoverId: '', hoverSince: 0, nestArmed: false };
  if (id !== String(state?.hoverId || '')) {
    return { hoverId: id, hoverSince: clock, nestArmed: false };
  }
  const started = typeof state?.hoverSince === 'number' ? state.hoverSince : clock;
  return {
    hoverId: id,
    hoverSince: started,
    nestArmed: clock - started >= threshold,
  };
}

/**
 * @param {{
 *   items: ChatDropItem[],
 *   y: number,
 *   draggedIds?: string[],
 *   nestArmed?: boolean,
 * }} input
 * @returns {ChatDropResult}
 */
export function resolveChatDrop(input) {
  const empty = { mode: 'insert', nestParentId: '', beforeId: null, parentChatId: '', hoveredId: '' };
  const all = Array.isArray(input?.items) ? input.items : [];
  const dragged = new Set((input?.draggedIds || []).map((id) => String(id || '')));
  const others = all.filter((item) => item?.id && !dragged.has(item.id));
  const y = typeof input?.y === 'number' && Number.isFinite(input.y) ? input.y : 0;
  if (!others.length) return empty;
  if (y < others[0].top) return insertBeforeItem(others, others[0], '');
  const last = others[others.length - 1];
  if (y > last.bottom) return insertAfterItem(others, last, '');

  let hovered = null;
  others.forEach((item) => {
    if (hovered) return;
    if (y >= item.top && y <= item.bottom) hovered = item;
  });
  if (!hovered) {
    const after = others.find((item) => y < item.top);
    if (after) return insertBeforeItem(others, after, '');
    return insertAfterItem(others, last, '');
  }
  if (input?.nestArmed === true) return nestOntoItem(others, hovered);
  const height = Math.max(hovered.bottom - hovered.top, 1);
  const ratio = (y - hovered.top) / height;
  if (ratio < 0.5) return insertBeforeItem(others, hovered, hovered.id);
  return insertAfterItem(others, hovered, hovered.id);
}
