/** Sidebar view construction: chat list actions, fork-parent edits and layout sync. */
import * as api from '../../core/api/index.js';
import {
  canPinChatToUrl,
  escapeHtml,
  expandSidebarWorkspaceSearchPool,
  getArchivedCounts,
  getActiveChatIdValue,
  getChatFavoritesStore,
  getChatListAgentStatePublic,
  getChatsList,
  getTerminalStateMetaPublic,
  loadChatsFromServer,
  notifySidebarSearchHydration,
  openNewChatModal,
  refreshRelatedChatHistoryLinks,
  refreshSidebarChatStates,
  requestArchiveChatConfirmed,
  requestArchiveSettledChats,
  requestDeleteChat,
  requestRestoreChat,
  selectChat,
  toggleChatUrlPinById,
} from '../../features/chat/index.js';
import { deriveWorkspaceKey } from '../../features/chat/chatMetadataIdbSchema.js';
import { createSidebarView } from '../../features/sidebar/sidebarView.js';
import {
  configureSidebarLayoutSync,
  publishSidebarLayout,
} from '../../features/sidebar/sidebarLayoutSync.js';
import { t } from '../../i18n/index.js';
import { wouldCreateChatParentCycle } from '../../../lib/chat-tree.js';
import { getActiveWorkspaceFileFromHeader, getActiveWorkspaceFolderFromHeader } from './headerLookups.js';
import { getSharedSpaNavigation } from './spaNavigationBridge.js';

/**
 * @param {{
 *   getWorkspacesList: any,
 *   switchWorkspace: (workspaceFile: string, folder?: string) => unknown,
 *   getSidebarWorkspaceFolder: (sidebarKey: string) => string,
 * }} deps
 */
export function createSidebarWiring({ getWorkspacesList, switchWorkspace, getSidebarWorkspaceFolder }) {
  async function setChatForkParent(chatId, parentChatId) {
    const id = String(chatId || '').trim();
    if (!id) return;
    const chats = getChatsList();
    const chat = chats.find((entry) => entry.id === id);
    if (!chat) return;
    const nextParent = String(parentChatId || '').trim();
    if (nextParent && wouldCreateChatParentCycle(chats, id, nextParent)) return;
    const previousParent = typeof chat.forkParentChatId === 'string' ? chat.forkParentChatId.trim() : '';
    if (nextParent) chat.forkParentChatId = nextParent;
    else delete chat.forkParentChatId;
    sidebarView.forceRerender();
    try {
      const data = await api.patchChat(id, { forkParentChatId: nextParent || null });
      if (!data?.ok || !data.chat) {
        if (previousParent) chat.forkParentChatId = previousParent;
        else delete chat.forkParentChatId;
        sidebarView.forceRerender();
        return;
      }
      if (typeof data.chat.forkParentChatId === 'string' && data.chat.forkParentChatId.trim()) {
        chat.forkParentChatId = data.chat.forkParentChatId.trim();
      } else {
        delete chat.forkParentChatId;
      }
      sidebarView.forceRerender();
      refreshRelatedChatHistoryLinks(chat);
      if (chat.forkParentChatId) {
        refreshRelatedChatHistoryLinks(chats.find((entry) => entry.id === chat.forkParentChatId));
      }
    } catch (_) {
      if (previousParent) chat.forkParentChatId = previousParent;
      else delete chat.forkParentChatId;
      sidebarView.forceRerender();
    }
  }

  const sidebarView = createSidebarView({
    getWorkspaces: getWorkspacesList,
    getChats: getChatsList,
    getArchivedCounts,
    getActiveWorkspaceFile: getActiveWorkspaceFileFromHeader,
    getActiveWorkspaceFolder: getActiveWorkspaceFolderFromHeader,
    getActiveChatId: getActiveChatIdValue,
    selectChat,
    switchWorkspace: (workspaceFile, folder) => switchWorkspace(workspaceFile, folder),
    getPreferredWorkspaceFolder: (sidebarKey) => getSidebarWorkspaceFolder(sidebarKey),
    chatFavorites: getChatFavoritesStore(),
    resolveChatState: getChatListAgentStatePublic,
    getTerminalStateMeta: getTerminalStateMetaPublic,
    requestArchiveChat: requestArchiveChatConfirmed,
    requestRestoreChat,
    requestDeleteChat,
    onArchiveSettled: async (chatIds, { parentId } = {}) => {
      const count = Array.isArray(chatIds) ? chatIds.length : 0;
      if (!count) return false;
      if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
        const message = t('sidebar.archiveSettledConfirm', { count: String(count) });
        if (!window.confirm(message)) return false;
      }
      let result = null;
      try {
        result = await requestArchiveSettledChats(chatIds);
      } catch (_) {
        result = null;
      }
      if (!result?.ok) {
        if (typeof window !== 'undefined' && typeof window.alert === 'function') {
          window.alert(t('sidebar.archiveSettledFailed'));
        }
        // Returning false keeps the group expanded so the user can retry instead of
        // the sidebar pretending the archive succeeded.
        return false;
      }
      // The sidebar clears its per-parent expansion after a confirmed archive.
      void parentId;
      return true;
    },
    requestNewChat: (workspaceContext) => openNewChatModal(workspaceContext),
    requestLoadArchivedChats: (workspaceFile) => loadChatsFromServer({
      includeArchived: true,
      skipAutoSelect: true,
      archiveWorkspace: typeof workspaceFile === 'string' ? workspaceFile : '',
    }),
    expandWorkspaceChatsForSearch: (workspace, list) => {
      const sidebarKey = workspace.sidebarKey || workspace.workspaceFile || '';
      const groupFolder = getSidebarWorkspaceFolder(sidebarKey);
      const workspaceKey = deriveWorkspaceKey({
        workspaceFile: workspace.workspaceFile || '',
        workspaceFolder: groupFolder || '',
      });
      return expandSidebarWorkspaceSearchPool(list, workspaceKey);
    },
    notifySidebarSearchActive: () => notifySidebarSearchHydration(),
    canPinChatToUrl,
    toggleChatUrlPinById,
    escapeHtml,
    openWorkspaceSettings: () => {
      sidebarView.close();
      void getSharedSpaNavigation()?.navigate(
        { panel: 'settings', settingsTab: 'workspace' },
        { explicit: true },
      );
    },
    refreshStates: refreshSidebarChatStates,
    setChatForkParent,
  });

  configureSidebarLayoutSync({
    readLocal: () => ({
      ...sidebarView.readLayoutSnapshot(),
      favoriteChatIds: getChatFavoritesStore().listFavorites(),
    }),
    apply: (layout) => {
      let needsRender = sidebarView.applyLayoutSnapshot(layout);
      if (Array.isArray(layout.favoriteChatIds)) {
        const before = getChatFavoritesStore().listFavorites().join('\0');
        getChatFavoritesStore().replaceFavorites(layout.favoriteChatIds);
        const after = getChatFavoritesStore().listFavorites().join('\0');
        if (before !== after) needsRender = true;
      }
      if (needsRender) sidebarView.scheduleUpdate();
    },
  });
  getChatFavoritesStore().setChangeListener((ids) => {
    publishSidebarLayout({ favoriteChatIds: ids });
  });

  return sidebarView;
}
