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
  isFavorite = (/** @type {string} */ _id) => false,
  readChatOrder = () => /** @type {string[]} */ ([]),
}) {
  let query = '';
  /** Filter/sort runs, exposed for memo tests. */
  const stats = { chatsForWorkspace: 0, visibleChatsForWorkspace: 0, archivedParse: 0 };
  /** @type {Map<string, { key: string, value: any[] }>} */
  const chatsMemo = new Map();
  /** @type {Map<string, { key: string, value: any[] }>} */
  const visibleMemo = new Map();
  /** @type {{ counts: any, entries: any[] } | null} */
  let archivedParsed = null;

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

  const wsKey = (workspace) => workspace.sidebarKey || workspace.workspaceFile || '';

  /**
   * Fingerprint of every chat field the scoping, filter and sort read. Status is
   * deliberately absent. Recomputed on every call (a cheap O(n) string build, no
   * sort/filter) so an in-place mutation is never missed, even within one pass.
   */
  function chatsFingerprint() {
    const chats = getChats();
    const parts = new Array(chats.length);
    for (let i = 0; i < chats.length; i += 1) {
      const c = chats[i] || {};
      parts[i] = [
        c.id, c.workspaceFile, c.workspaceFolder, c.forkParentChatId, c.archived ? 1 : 0,
        isFavorite(c.id) ? 1 : 0, c.createdAt, c.title, c.watcherPinned === true ? 1 : 0,
        // Read by activeWorktreeFilterId / filterChatsByWorktree.
        c.todoId, c.onWorktree === true ? 1 : 0,
      ].join('\u0001');
    }
    return parts.join('\u0002') + '\u0003' + readChatOrder().join(',');
  }

  function workspacesFingerprint(workspace) {
    const rows = getWorkspaces() || [];
    const key = wsKey(workspace);
    const parts = rows.map((w) => [
      w.sidebarKey, w.workspaceFile, w.isClone ? 1 : 0, w.name,
      getPreferredWorkspaceFolder(w.sidebarKey || w.workspaceFile || ''),
    ].join('\u0001'));
    return key + '\u0003' + getPreferredWorkspaceFolder(key) + '\u0003' + parts.join('\u0002');
  }

  function cloneFoldersFor(workspaceFile) {
    return listCloneFoldersForWorkspaceFile(
      getWorkspaces(), workspaceFile, getPreferredWorkspaceFolder,
    );
  }

  function chatsForWorkspace(workspace) {
    const workspaceFile = normalizePath(workspace.workspaceFile);
    if (!workspaceFile) return [];
    const memoKey = chatsFingerprint() + '\u0004' + workspacesFingerprint(workspace);
    const hit = chatsMemo.get(wsKey(workspace));
    if (hit && hit.key === memoKey) return hit.value;
    stats.chatsForWorkspace += 1;
    const cloneFolders = cloneFoldersFor(workspaceFile);
    const groupFolder = normalizePath(
      getPreferredWorkspaceFolder(workspace.sidebarKey || workspace.workspaceFile),
    );
    const value = getChats().filter((chat) => chatBelongsToWorkspaceGroup(chat, {
      workspaceFile,
      groupFolder,
      isClone: workspace.isClone === true,
      cloneFolders,
    }));
    chatsMemo.set(wsKey(workspace), { key: memoKey, value });
    return value;
  }

  function visibleChatsForWorkspace(workspace) {
    // The search pool expansion depends on external hydration state: no memo while searching.
    const memoable = typeof expandWorkspaceChatsForSearch !== 'function' || !isActive();
    const worktreeId = activeWorktreeFilterId();
    const memoKey = memoable
      ? [chatsFingerprint(), workspacesFingerprint(workspace), query, worktreeId, workspace.name || ''].join('\u0004')
      : '';
    if (memoable) {
      const hit = visibleMemo.get(wsKey(workspace));
      if (hit && hit.key === memoKey) return hit.value;
    }
    stats.visibleChatsForWorkspace += 1;
    const workspaceName = workspace.name || workspace.workspaceFile || '';
    const scoped = filterChatsByWorktree(
      orderedChats(chatsForWorkspace(workspace)), worktreeId,
    );
    const pool = typeof expandWorkspaceChatsForSearch === 'function'
      ? expandWorkspaceChatsForSearch(workspace, scoped)
      : scoped;
    const value = pool
      .filter((chat) => chat?.watcherPinned !== true)
      .filter((chat) => matchesSidebarSearch(query, { title: chat.title, workspaceName }));
    if (memoable) visibleMemo.set(wsKey(workspace), { key: memoKey, value });
    return value;
  }

  function archivedCountForWorkspace(workspace) {
    const counts = getArchivedCounts() || {};
    const workspaceFile = normalizePath(workspace.workspaceFile);
    if (!workspaceFile) return 0;
    // Parse the key strings once per counts object (a new object means new counts).
    if (!archivedParsed || archivedParsed.counts !== counts) {
      stats.archivedParse += 1;
      const entries = Object.entries(counts).map(([key, value]) => {
        const [file = '', folder = ''] = String(key).split('\n');
        return { file, folder, n: Number(value) || 0 };
      });
      archivedParsed = { counts, entries };
    }
    const cloneFolders = cloneFoldersFor(workspaceFile);
    const groupFolder = normalizePath(
      getPreferredWorkspaceFolder(workspace.sidebarKey || workspace.workspaceFile || ''),
    );
    return archivedParsed.entries.reduce((total, { file, folder, n }) => {
      const belongs = chatBelongsToWorkspaceGroup({ workspaceFile: file, workspaceFolder: folder }, {
        workspaceFile, groupFolder, isClone: workspace.isClone === true, cloneFolders,
      });
      return belongs ? total + n : total;
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
    stats,
    get query() { return query; },
  };
}
