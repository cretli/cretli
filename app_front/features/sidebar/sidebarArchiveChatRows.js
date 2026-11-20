/**
 * Register `<cr-sidebar-chat-row>` payloads for a virtual archive slice.
 */

import { registerSidebarChatRow, registerSidebarChatRowDirect } from './sidebarChatRowPass.js';
import { getAncestorContinuationLevels } from './sidebarSubchatGroups.js';
import { computeArchiveOptionAria } from './sidebarArchiveVirtualNavigation.js';

/**
 * @param {Array<{ chat: object, level?: number, isLastChild?: boolean, parentId?: string }>} archiveTree
 * @param {number} startIndex inclusive
 * @param {number} endIndex exclusive
 * @param {string} activeChatId
 * @param {object} deps
 */
export function registerArchiveChatRowSlice(
  archiveTree,
  startIndex,
  endIndex,
  activeChatId,
  deps,
) {
  const list = Array.isArray(archiveTree) ? archiveTree : [];
  const start = Math.max(0, Math.round(startIndex));
  const end = Math.min(list.length, Math.round(endIndex));
  const totalOptions = list.length;
  for (let i = start; i < end; i += 1) {
    const item = list[i];
    const chat = item?.chat;
    if (!chat?.id) continue;
    const aria = computeArchiveOptionAria(i, totalOptions);
    registerSidebarChatRow(chat.id, {
      chat,
      activeChatId,
      opts: {
        archived: true,
        inArchiveList: true,
        level: item.level,
        isLastChild: item.isLastChild,
        parentId: item.parentId,
        continuationLevels: getAncestorContinuationLevels(item, list),
        archiveLogicalIndex: i,
        ariaSetSize: aria?.ariaSetSize,
        ariaPosInSet: aria?.ariaPosInSet,
      },
      deps,
    });
  }
}

/**
 * @param {Array<{ chat: object, level?: number, isLastChild?: boolean, parentId?: string }>} archiveTree
 * @param {number} startIndex inclusive
 * @param {number} endIndex exclusive
 * @param {string} activeChatId
 * @param {object} deps
 */
export function registerArchiveChatRowSliceDirect(
  archiveTree,
  startIndex,
  endIndex,
  activeChatId,
  deps,
) {
  const list = Array.isArray(archiveTree) ? archiveTree : [];
  const start = Math.max(0, Math.round(startIndex));
  const end = Math.min(list.length, Math.round(endIndex));
  const totalOptions = list.length;
  for (let i = start; i < end; i += 1) {
    const item = list[i];
    const chat = item?.chat;
    if (!chat?.id) continue;
    const aria = computeArchiveOptionAria(i, totalOptions);
    registerSidebarChatRowDirect(chat.id, {
      chat,
      activeChatId,
      opts: {
        archived: true,
        inArchiveList: true,
        level: item.level,
        isLastChild: item.isLastChild,
        parentId: item.parentId,
        continuationLevels: getAncestorContinuationLevels(item, list),
        archiveLogicalIndex: i,
        ariaSetSize: aria?.ariaSetSize,
        ariaPosInSet: aria?.ariaPosInSet,
      },
      deps,
    });
  }
}
