import { matchesSidebarSearch } from '../sidebarSearch.js';
import { filterChatsByWorktree, chatWorktreeTodoId } from '../sidebarOnlyActiveFilter.js';
import { listCloneFoldersForWorkspaceFile, chatBelongsToWorkspaceGroup } from '../workspaceChatMatch.js';

/** Search and workspace scoping for the sidebar list. */
export function createSidebarSearchService({
  getChats,
  getWorkspaces,
  getActiveChatId,
  getPreferredWorkspaceFolder,
  expandWorkspaceChatsForSearch,
  notifySidebarSearchActive,
  readSidebarOnlyWorktreeFlag,
  orderedChats,
  getArchivedCounts,
  normalizePath,
}) {
  let query = '';

  const getInput = () => typeof document === 'undefined'
    ? null
    : /** @type {HTMLInputElement | null} */ (document.getElementById('sidebar-search'));
  const isActive = () => String(query || '').trim() !== '';
  const isFocused = () => {
    const input = getInput();
    return Boolean(input && typeof document !== 'undefined' &&
      (document.activeElement === input || input.contains(document.activeElement)));
  };

  function setQuery(value) {
    const wasActive = isActive();
    query = typeof value === 'string' ? value : '';
    const input = getInput();
    if (input && input.value !== query) input.value = query;
    if (!wasActive && isActive() && typeof notifySidebarSearchActive === 'function') {
      try { notifySidebarSearchActive(); } catch (_) {}
    }
  }

  function activeWorktreeFilterId() {
    if (!readSidebarOnlyWorktreeFlag() || isActive()) return '';
    const activeId = getActiveChatId();
    if (!activeId) return '';
    return chatWorktreeTodoId(getChats().find((chat) => chat?.id === activeId));
  }

  function chatsForWorkspace(workspace) {
    const workspaceFile = normalizePath(workspace.workspaceFile);
    if (!workspaceFile) return [];
    const cloneFolders = listCloneFoldersForWorkspaceFile(
      getWorkspaces(), workspaceFile, getPreferredWorkspaceFolder,
    );
    const groupFolder = normalizePath(
      getPreferredWorkspaceFolder(workspace.sidebarKey || workspace.workspaceFile),
    );
    return getChats().filter((chat) => chatBelongsToWorkspaceGroup(chat, {
      workspaceFile,
      groupFolder,
      isClone: workspace.isClone === true,
      cloneFolders,
    }));
  }

  function visibleChatsForWorkspace(workspace) {
    const workspaceName = workspace.name || workspace.workspaceFile || '';
    const scoped = filterChatsByWorktree(
      orderedChats(chatsForWorkspace(workspace)), activeWorktreeFilterId(),
    );
    const pool = typeof expandWorkspaceChatsForSearch === 'function'
      ? expandWorkspaceChatsForSearch(workspace, scoped)
      : scoped;
    return pool
      .filter((chat) => chat?.watcherPinned !== true)
      .filter((chat) => matchesSidebarSearch(query, { title: chat.title, workspaceName }));
  }

  function archivedCountForWorkspace(workspace) {
    const counts = getArchivedCounts() || {};
    const workspaceFile = normalizePath(workspace.workspaceFile);
    if (!workspaceFile) return 0;
    const cloneFolders = listCloneFoldersForWorkspaceFile(
      getWorkspaces(), workspaceFile, getPreferredWorkspaceFolder,
    );
    const groupFolder = normalizePath(
      getPreferredWorkspaceFolder(workspace.sidebarKey || workspace.workspaceFile),
    );
    return Object.entries(counts).reduce((total, [key, value]) => {
      const [file = '', folder = ''] = String(key).split('\n');
      const belongs = chatBelongsToWorkspaceGroup({ workspaceFile: file, workspaceFolder: folder }, {
        workspaceFile, groupFolder, isClone: workspace.isClone === true, cloneFolders,
      });
      return belongs ? total + (Number(value) || 0) : total;
    }, 0);
  }

  return {
    getInput,
    isActive,
    isFocused,
    setQuery,
    activeWorktreeFilterId,
    visibleChatsForWorkspace,
    archivedCountForWorkspace,
    chatsForWorkspace,
    get query() { return query; },
  };
}
