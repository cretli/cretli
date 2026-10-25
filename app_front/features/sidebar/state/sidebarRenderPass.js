/** Per-pass workspace-tree cache plus chat ordering shared by signature and render. */

import { applyChatOrder, buildForkArchiveBlockedIds, isForkArchiveBlocked } from '../../../../lib/chat-tree.js';
import { hasLiveHarnessWork } from '../../chat/chatStatusMeta.js';
import { sortChatsByFavoriteThenDate } from '../../chat/chatListSort.js';
import { readChatOrder } from '../sidebarChatOrder.js';
import { buildSidebarWorkspaceGroups } from '../services/sidebarWorkspaceGroups.js';
import { beginSidebarChatRowPass, endSidebarChatRowPass } from '../sidebarChatRowPass.js';
import { beginSidebarSubchatGroupPass, endSidebarSubchatGroupPass } from '../sidebarSubchatGroupPass.js';
import { beginSidebarArchiveGroupPass, endSidebarArchiveGroupPass } from '../sidebarArchiveGroupPass.js';
import { beginSidebarWorkspacePass, endSidebarWorkspacePass } from '../sidebarWorkspacePass.js';

/**
 * @param {Record<string, any>} ctx shared sidebar closure: deps, state and sibling modules
 */
export function createSidebarRenderPass(ctx) {
  const { getChats, getActiveChatId, chatFavorites, state } = ctx;
  const isSubchatGroupExpanded = (...args) => ctx.isSubchatGroupExpanded(...args);
  const isSearchActive = (...args) => ctx.isSearchActive(...args);
  const visibleChatsForWorkspace = (...args) => ctx.visibleChatsForWorkspace(...args);

  function orderedChats(list) {
    const ranked = sortChatsByFavoriteThenDate(list, (/** @type {any} */ chat) => chatFavorites.isFavorite(chat.id));
    return applyChatOrder(ranked, readChatOrder());
  }

  /**
   * Shared grouping pipeline for a workspace: archive split, tree flatten and
   * settled-subchat folding. `registerWorkspaceGroupEntry` and
   * `collectRenderableChatIds` must agree on the visible rows, so both call this.
   *
   * @param {any[]} chats already search-filtered workspace chats
   * @param {string} activeChatId
   * @param {boolean} searching
   */
  function buildWorkspaceChatTree(chats, activeChatId, searching) {
    return buildSidebarWorkspaceGroups(chats, {
      isFavorite: (id) => chatFavorites.isFavorite(id),
      activeChatId,
      searching,
      isExpanded: (parentId) => isSubchatGroupExpanded(parentId),
    });
  }

  function beginRenderPass() {
    const { blocked } = buildForkArchiveBlockedIds(getChats(), hasLiveHarnessWork);
    beginSidebarChatRowPass();
    beginSidebarSubchatGroupPass();
    beginSidebarArchiveGroupPass();
    beginSidebarWorkspacePass();
    state.renderPass = {
      activeChatId: getActiveChatId() || '',
      searching: isSearchActive(),
      map: new Map(),
      forkArchiveBlocked: blocked,
    };
    return state.renderPass;
  }

  /**
   * @param {string} chatId
   * @returns {boolean}
   */
  function isChatForkArchiveBlocked(chatId) {
    if (state.renderPass?.forkArchiveBlocked) {
      return isForkArchiveBlocked(state.renderPass.forkArchiveBlocked, chatId);
    }
    const { blocked } = buildForkArchiveBlockedIds(getChats(), hasLiveHarnessWork);
    return isForkArchiveBlocked(blocked, chatId);
  }

  function endRenderPass() {
    state.renderPass = null;
    endSidebarChatRowPass();
    endSidebarSubchatGroupPass();
    endSidebarArchiveGroupPass();
    endSidebarWorkspacePass();
  }

  /**
   * Archive-split + tree + settled-grouping for a workspace, memoised for the
   * duration of one render/update pass. Outside a pass (e.g. a standalone
   * `renderSignature()` call from tests) it falls back to an uncached compute.
   *
   * @param {any} workspace
   * @returns {{ live: any[], archived: any[], grouped: any, tree: any[] }}
   */
  function workspaceModel(workspace) {
    const key = workspace.sidebarKey || workspace.workspaceFile || '';
    if (state.renderPass && state.renderPass.map.has(key)) return state.renderPass.map.get(key);
    const activeChatId = state.renderPass ? state.renderPass.activeChatId : (getActiveChatId() || '');
    const searching = state.renderPass ? state.renderPass.searching : isSearchActive();
    const model = buildWorkspaceChatTree(visibleChatsForWorkspace(workspace), activeChatId, searching);
    if (state.renderPass) state.renderPass.map.set(key, model);
    return model;
  }

  /**
   * Selector-safe id escaping (CSS.escape when available, conservative fallback).
   * @param {string} value
   * @returns {string}
   */
  function cssEscape(value) {
    const s = String(value ?? '');
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(s);
    return s.replace(/["\\]/g, '\\$&');
  }

  return { orderedChats, buildWorkspaceChatTree, beginRenderPass, isChatForkArchiveBlocked, endRenderPass, workspaceModel, cssEscape };
}
