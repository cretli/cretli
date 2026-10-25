/** Archive group and workspace group payload registration for a render pass. */

import { t } from '../../../i18n/index.js';
import { flattenChatsTree, isChatArchived } from '../../../../lib/chat-tree.js';
import { capSidebarVisibleTreeChats, SIDEBAR_VISIBLE_CHAT_LIMIT, shouldSerializeWorkspaceChatList } from '../sidebarVisibleChats.js';
import { formatSubchatParentBadge, getAncestorContinuationLevels } from '../sidebarSubchatGroups.js';
import { getWorkspaceAutopilotBadge } from '../workspaceAutopilotBadge.js';
import { normalizePath } from '../state/sidebarPersistence.js';
import { measureFreezeSpan } from '../../../lib/uiFreezeCounters.js';
import { registerSidebarArchiveGroup } from '../sidebarArchiveGroupPass.js';
import { registerArchiveChatRowSlice } from '../sidebarArchiveChatRows.js';
import { archiveWindowChatIds, computeSidebarArchiveMountedRowLimit, selectArchiveVisibleWindow, SIDEBAR_ARCHIVE_TEST_VIEWPORT_HEIGHT_PX } from '../sidebarArchiveVirtualizer.js';
import { getSidebarArchiveVirtualWindow } from '../sidebarArchiveVirtualState.js';
import { registerSidebarWorkspace } from '../sidebarWorkspacePass.js';
import { sidebarArchiveRepeatKey, sidebarChatRepeatKey, sidebarEmptyRepeatKey, sidebarShowMoreRepeatKey, sidebarSubchatGroupRepeatKey } from '../sidebarWorkspaceModel.js';

/**
 * @param {Record<string, any>} ctx shared sidebar closure: deps, state and sibling modules
 */
export function createSidebarWorkspaceGroups(ctx) {
  const { getPreferredWorkspaceFolder, escapeHtml, state, showAllChatsBySidebarKey } = ctx;
  const isWorkspaceCollapsed = (...args) => ctx.isWorkspaceCollapsed(...args);
  const isArchiveSectionOpen = (...args) => ctx.isArchiveSectionOpen(...args);
  const workspaceModel = (...args) => ctx.workspaceModel(...args);
  const sidebarChatRowDeps = (...args) => ctx.sidebarChatRowDeps(...args);
  const registerSubchatGroupEntry = (...args) => ctx.registerSubchatGroupEntry(...args);
  const registerChatRowEntry = (...args) => ctx.registerChatRowEntry(...args);
  const isSearchActive = (...args) => ctx.isSearchActive(...args);
  const archivedCountForWorkspace = (...args) => ctx.archivedCountForWorkspace(...args);

  function resolveArchiveVirtualWindowForPass(sidebarKey, archiveTree) {
    const total = archiveTree.length;
    if (!total) {
      return { startIndex: 0, endIndex: 0, topSpacerPx: 0, bottomSpacerPx: 0 };
    }
    const stored = getSidebarArchiveVirtualWindow(sidebarKey);
    if (stored && stored.endIndex > stored.startIndex && stored.endIndex <= total) {
      return stored;
    }
    const maxMounted = computeSidebarArchiveMountedRowLimit(SIDEBAR_ARCHIVE_TEST_VIEWPORT_HEIGHT_PX);
    return selectArchiveVisibleWindow(
      total,
      0,
      SIDEBAR_ARCHIVE_TEST_VIEWPORT_HEIGHT_PX,
      null,
      { maxMounted },
    );
  }

  function registerArchiveGroupEntry(sidebarKey, archivedChats, activeChatId, searching, hintCount = 0) {
    const count = archivedChats.length || Number(hintCount) || 0;
    if (!count) return false;
    const openSection = searching || isArchiveSectionOpen(sidebarKey)
      || archivedChats.some((chat) => chat.id === activeChatId);
    const archiveTree = flattenChatsTree(archivedChats);
    if (openSection) {
      const virtualWindow = resolveArchiveVirtualWindowForPass(sidebarKey, archiveTree);
      measureFreezeSpan(
        'sidebar.archive.render',
        { sidebarKey, rows: virtualWindow.endIndex - virtualWindow.startIndex },
        () => {
          registerArchiveChatRowSlice(
            archiveTree,
            virtualWindow.startIndex,
            virtualWindow.endIndex,
            activeChatId,
            sidebarChatRowDeps(),
          );
          return '';
        },
      );
    }
    registerSidebarArchiveGroup(sidebarKey, {
      sidebarKey,
      openSection,
      count,
      activeChatId,
      archiveTree: openSection ? /** @type {any[]} */ (archiveTree) : [],
      // The archive virtualiser re-registers its mounted slice with these deps
      // (`registerArchiveChatRowSliceDirect`), so they must be the full chat-row
      // deps — otherwise expanded archive rows lose their harness icon and actions.
      deps: sidebarChatRowDeps(),
    });
    return true;
  }

  function registerWorkspaceGroupEntry(workspace, activeWorkspaceFile, activeWorkspaceFolder, activeChatId, chats, renderedIds) {
    const sidebarKey = workspace.sidebarKey || workspace.workspaceFile || '';
    const preferredFolder = getPreferredWorkspaceFolder(sidebarKey);
    const isActive =
      normalizePath(workspace.workspaceFile) === normalizePath(activeWorkspaceFile) &&
      normalizePath(preferredFolder) === normalizePath(activeWorkspaceFolder);
    const isCollapsed = !isSearchActive() && isWorkspaceCollapsed(sidebarKey);
    const searching = isSearchActive();
    const { live, archived, grouped, tree } = workspaceModel(workspace);
    const count = live.length;
    const serializeList = shouldSerializeWorkspaceChatList(isCollapsed, searching);
    const capped = capSidebarVisibleTreeChats(grouped.items, {
      limit: SIDEBAR_VISIBLE_CHAT_LIMIT,
      activeChatId,
      showAll: searching || showAllChatsBySidebarKey.has(sidebarKey),
    });
    if (serializeList) {
      for (const group of grouped.groups) {
        state.settledGroupsByParent.set(group.parentId, group);
      }
      for (const item of capped.items) {
        if (item?.chat?.id) renderedIds.add(item.chat.id);
      }
      if (isArchiveSectionOpen(sidebarKey) || searching) {
        const archiveTree = flattenChatsTree(archived);
        const virtualWindow = resolveArchiveVirtualWindowForPass(sidebarKey, archiveTree);
        for (const id of archiveWindowChatIds(virtualWindow, archiveTree)) {
          renderedIds.add(id);
        }
      }
    }
    // Parent-row summary: only folded (collapsed) groups hide their children,
    // so only they need a badge telling the user where the subchats went.
    const collapsedSummariesByParent = new Map();
    for (const group of grouped.groups) {
      if (group.expanded === true) continue;
      collapsedSummariesByParent.set(
        group.parentId,
        formatSubchatParentBadge(group.summary, t),
      );
    }
    const parentTitleById = new Map(chats.map((chat) => [chat.id, chat.title]));
    const continuationLevelsFor = (item) => getAncestorContinuationLevels(item, tree);
    /** @type {import('../sidebarWorkspaceModel.js').SidebarListEntry[]} */
    const listEntries = [];
    if (serializeList && count) {
      for (const item of /** @type {any[]} */ (capped.items)) {
        if (item?.isGroup) {
          registerSubchatGroupEntry(
            item,
            sidebarKey,
            parentTitleById.get(item.parentId) || '',
            continuationLevelsFor(item),
          );
          listEntries.push({
            kind: 'subchat-group',
            key: sidebarSubchatGroupRepeatKey(item.parentId),
            parentId: item.parentId,
          });
          continue;
        }
        if (!item?.chat?.id) continue;
        registerChatRowEntry(item.chat, activeChatId, {
          level: item.level,
          isLastChild: item.isLastChild,
          parentId: item.parentId,
          archived: isChatArchived(item.chat),
          subchatSummary: collapsedSummariesByParent.get(item.chat.id) || null,
          continuationLevels: continuationLevelsFor(item),
        });
        listEntries.push({
          kind: 'chat',
          key: sidebarChatRepeatKey(item.chat.id),
          chatId: item.chat.id,
        });
      }
      if (capped.hidden > 0) {
        listEntries.push({
          kind: 'more',
          key: sidebarShowMoreRepeatKey(sidebarKey),
          sidebarKey,
          hiddenCount: capped.hidden,
        });
      }
    } else if (serializeList && !count && !(archived.length || archivedCountForWorkspace(workspace))) {
      listEntries.push({
        kind: 'empty',
        key: sidebarEmptyRepeatKey(sidebarKey),
      });
    }
    const keptArchivedInLive = live.filter((chat) => isChatArchived(chat)).length;
    const archiveHint = Math.max(0, archivedCountForWorkspace(workspace) - keptArchivedInLive);
    if (serializeList && registerArchiveGroupEntry(
      sidebarKey,
      archived,
      activeChatId,
      searching,
      archiveHint,
    )) {
      listEntries.push({
        kind: 'archive',
        key: sidebarArchiveRepeatKey(sidebarKey),
        sidebarKey,
      });
    }
    registerSidebarWorkspace(sidebarKey, {
      sidebarKey,
      workspace,
      isActive,
      isCollapsed,
      searching,
      serializeList,
      count,
      preferredFolder,
      autopilotBadge: getWorkspaceAutopilotBadge(workspace, preferredFolder),
      listEntries,
      deps: { t, escapeHtml },
    });
    return !!sidebarKey;
  }

  return { resolveArchiveVirtualWindowForPass, registerArchiveGroupEntry, registerWorkspaceGroupEntry };
}
