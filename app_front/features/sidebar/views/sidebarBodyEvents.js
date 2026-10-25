/** Delegated click / pointer handlers for the static sidebar body. */

import { applyWorkspaceWatcherModeLocal, listWorkspaceWatcherPinnedChats } from '../workspaceAutopilotBadge.js';
import { setWorkspaceWatcherEnabled, setWorkspaceWatcherStartsEnabled } from '../workspaceWatcherToggle.js';
import { chatBelongsToWorkspaceGroup, listCloneFoldersForWorkspaceFile, resolveWorkspaceTargetForChat } from '../workspaceChatMatch.js';
import { readWatcherShowAllFlag, writeWatcherShowAllFlag, normalizePath } from '../state/sidebarPersistence.js';
import { wireArchiveVirtualFocusTracking } from '../sidebarArchiveSidebarFocus.js';
import { onSidebarBodyKeydown } from './sidebarBodyKeyboard.js';

/**
 * @param {Record<string, any>} ctx shared sidebar closure: deps, state and sibling modules
 */
export function createSidebarBodyEvents(ctx) {
  const { getWorkspaces, getChats, getActiveWorkspaceFile, getActiveWorkspaceFolder, selectChat, switchWorkspace, getPreferredWorkspaceFolder, chatFavorites, requestArchiveChat, requestRestoreChat, requestDeleteChat, requestNewChat, requestLoadArchivedChats, toggleChatUrlPinById, isMobileViewport, state, showAllChatsBySidebarKey, updateScheduler } = ctx;
  const getContainer = (...args) => ctx.getContainer(...args);
  const closeSidebar = (...args) => ctx.closeSidebar(...args);
  const setWorkspaceCollapsed = (...args) => ctx.setWorkspaceCollapsed(...args);
  const toggleWorkspaceCollapsed = (...args) => ctx.toggleWorkspaceCollapsed(...args);
  const isArchiveSectionOpen = (...args) => ctx.isArchiveSectionOpen(...args);
  const setArchiveSectionOpen = (...args) => ctx.setArchiveSectionOpen(...args);
  const isSubchatGroupExpanded = (...args) => ctx.isSubchatGroupExpanded(...args);
  const setSubchatGroupExpanded = (...args) => ctx.setSubchatGroupExpanded(...args);
  const isChatForkArchiveBlocked = (...args) => ctx.isChatForkArchiveBlocked(...args);
  const archiveSettledGroup = (...args) => ctx.archiveSettledGroup(...args);
  const render = (...args) => ctx.render(...args);
  const forceRerender = (...args) => ctx.forceRerender(...args);

  function activateChatPanelTab() {
    const chatTabButton = document.querySelector('.tab[data-panel="chat"]');
    if (!(chatTabButton instanceof HTMLButtonElement)) return;
    chatTabButton.click();
  }

  /**
   * Delegated `pointerdown` (capture) for the chat-row action buttons. The
   * capture phase runs before the drag layer's bubble listener on `.sidebar-body`,
   * so stopping propagation keeps a press on an action button from arming a drag
   * (the old code attached this per button).
   */
  function onSidebarBodyPointerDown(ev) {
    const target = ev.target instanceof Element ? ev.target : null;
    if (!target) return;
    if (target.closest('.sidebar-chat-action')) ev.stopPropagation();
  }

  function closeSidebarAfterMobileAction() {
    if (!state.pinned || isMobileViewport()) closeSidebar();
  }

  function openPinnedChatRow(el) {
    const chatId = el?.dataset?.pinnedChatId || '';
    if (!chatId) return;
    activateChatPanelTab();
    const chat = getChats().find((item) => item.id === chatId);
    const entry = listWorkspaceWatcherPinnedChats().find((row) => row.pinnedChatId === chatId);
    const folder = chat?.workspaceFolder || entry?.workspaceFolder || '';
    const target = resolveWorkspaceTargetForChat(
      { workspaceFile: chat?.workspaceFile || '', workspaceFolder: folder },
      { workspaceFile: getActiveWorkspaceFile(), workspaceFolder: getActiveWorkspaceFolder() },
      getWorkspaces(),
      getPreferredWorkspaceFolder,

    );
    const finish = () => {
      selectChat(chatId, { byUser: true });
      closeSidebarAfterMobileAction();
    };
    if (!target) {
      finish();
      return;
    }
    switchWorkspace(target.workspaceFile, target.workspaceFolder).then((ok) => {
      if (!ok) return;
      render();
      finish();
    });
  }

  function openNewChatForWorkspace(newBtn, ev) {
    ev.preventDefault();
    ev.stopPropagation();
    const workspaceFile = newBtn.getAttribute('data-workspace-file') || '';
    const sidebarKey = newBtn.getAttribute('data-sidebar-key') || workspaceFile;
    const preferredFolder = getPreferredWorkspaceFolder(sidebarKey);

    const openNewChat = () => {
      activateChatPanelTab();
      requestNewChat({ workspaceFile, workspaceFolder: preferredFolder });
      // A pinned sidebar is docked on desktop, so opening the new-chat modal must
      // not undo the user's layout choice. Mobile remains an overlay, therefore it
      // should still close behind the modal.
      closeSidebarAfterMobileAction();
    };
    const activeWorkspace = normalizePath(getActiveWorkspaceFile());
    const activeFolder = normalizePath(getActiveWorkspaceFolder());
    if (
      normalizePath(workspaceFile) === activeWorkspace &&
      normalizePath(preferredFolder) === activeFolder
    ) {
      openNewChat();
      return;
    }

    switchWorkspace(workspaceFile, preferredFolder).then((ok) => {
      if (!ok) return;
      setWorkspaceCollapsed(sidebarKey, false);
      render();
      openNewChat();
    });
  }

  function handleWorkspaceHeaderClick(header, ev) {
    ev.stopPropagation();
    const li = header.closest('.sidebar-workspace');
    const workspaceFile = li?.dataset.workspaceFile || '';
    const sidebarKey = li?.dataset.sidebarKey || workspaceFile;
    if (ev.target instanceof Element && ev.target.closest('.sidebar-workspace-chevron')) {
      toggleWorkspaceCollapsed(sidebarKey);
      return;
    }
    const preferredFolder = getPreferredWorkspaceFolder(sidebarKey);
    const isActive =
      normalizePath(workspaceFile) === normalizePath(getActiveWorkspaceFile()) &&
      normalizePath(preferredFolder) === normalizePath(getActiveWorkspaceFolder());
    if (isActive) {
      toggleWorkspaceCollapsed(sidebarKey);
      return;
    }
    switchWorkspace(workspaceFile, preferredFolder).then((ok) => {
      if (ok) {
        setWorkspaceCollapsed(sidebarKey, false);
        render();
      }
    });
  }

  function toggleArchiveSection(header, ev) {
    ev.preventDefault();
    ev.stopPropagation();
    const group = header.closest('.sidebar-archive-group');
    const key = group?.getAttribute('data-sidebar-key') || '';
    if (!key) return;
    setArchiveSectionOpen(key, !isArchiveSectionOpen(key));
    if (isArchiveSectionOpen(key)) {
      // Scope the archived load to this workspace's file only: expanding one
      // group must not pull every archived row in the index. Clone groups share
      // a workspaceFile, so resolve it from the sidebar key (the route windows by
      // chat.workspaceFile, which covers every folder/clone of that file).
      const scopeWorkspaceFile = getWorkspaces().find(
        (workspace) => (workspace.sidebarKey || workspace.workspaceFile || '') === key,
      )?.workspaceFile || key;
      Promise.resolve(requestLoadArchivedChats(scopeWorkspaceFile)).catch(() => {});
    }
    render();
  }

  function toggleSubchatGroup(toggle, ev) {
    ev.preventDefault();
    ev.stopPropagation();
    const parentId = toggle.getAttribute('data-parent-id') || '';
    if (!parentId) return;
    setSubchatGroupExpanded(parentId, !isSubchatGroupExpanded(parentId));
    render();
  }

  function archiveSubchatGroup(archiveBtn, ev) {
    ev.preventDefault();
    ev.stopPropagation();
    const parentId = archiveBtn.getAttribute('data-parent-id') || '';
    const group = state.settledGroupsByParent.get(parentId);
    if (!group) return;
    void archiveSettledGroup(parentId, group.allChildIds);
  }

  function expandAllChats(moreEl, ev) {
    ev.preventDefault();
    ev.stopPropagation();
    const key = moreEl.getAttribute('data-sidebar-key') || '';
    if (!key) return;
    showAllChatsBySidebarKey.add(key);
    render();
  }

  function handleChatRowAction(btn, ev) {
    ev.preventDefault();
    ev.stopPropagation();
    const row = btn.closest('.sidebar-chat-item');
    const chatId = row?.dataset?.chatId || '';
    if (!chatId) return;
    if (btn.classList.contains('sidebar-chat-pin-btn')) {
      void toggleChatUrlPinById(chatId);
      return;
    }
    if (btn.classList.contains('sidebar-chat-fav-btn')) {
      chatFavorites.toggleFavorite(chatId);
      render();
      return;
    }
    if (btn.classList.contains('sidebar-chat-restore-btn')) {
      if (typeof requestRestoreChat !== 'function') return;
      void requestRestoreChat(chatId);
      return;
    }
    if (btn.classList.contains('sidebar-chat-archive-btn')) {
      const chat = getChats().find((item) => item.id === chatId);
      const isArchived = row?.dataset?.archived === '1' || Boolean(chat?.archivedAt);
      if (isArchived) {
        if (typeof requestRestoreChat !== 'function') return;
        void requestRestoreChat(chatId);
        return;
      }
      if (isChatForkArchiveBlocked(chatId)) return;
      if (typeof requestArchiveChat !== 'function') return;
      void requestArchiveChat(chatId, { preserveListOpen: true });
      return;
    }
    if (btn.classList.contains('sidebar-chat-delete-btn')) {
      const chat = getChats().find((item) => item.id === chatId);
      const isArchived = row?.dataset?.archived === '1' || Boolean(chat?.archivedAt);
      if (!isArchived) return;
      if (typeof requestDeleteChat !== 'function') return;
      requestDeleteChat(chatId, { preserveListOpen: true });
    }
  }

  function selectChatRow(el) {
    const chatId = el?.dataset?.chatId || '';
    if (!chatId) return;
    const chat = getChats().find((item) => item.id === chatId);
    if (!chat) return;
    activateChatPanelTab();

    const finishSelect = () => {
      selectChat(chatId, { byUser: true });
      if (isMobileViewport()) closeSidebar();
    };

    const target = resolveWorkspaceTargetForChat(
      chat,
      { workspaceFile: getActiveWorkspaceFile(), workspaceFolder: getActiveWorkspaceFolder() },
      getWorkspaces(),
      getPreferredWorkspaceFolder,
    );
    if (!target) {
      finishSelect();
      return;
    }

    switchWorkspace(target.workspaceFile, target.workspaceFolder).then((ok) => {
      if (!ok) return;
      const cloneFolders = listCloneFoldersForWorkspaceFile(
        getWorkspaces(),
        target.workspaceFile,
        getPreferredWorkspaceFolder,
      );
      const chatSidebarKey = getWorkspaces().find((workspace) =>
        chatBelongsToWorkspaceGroup(chat, {
          workspaceFile: workspace.workspaceFile,
          groupFolder: getPreferredWorkspaceFolder(workspace.sidebarKey || workspace.workspaceFile),
          isClone: workspace.isClone === true,
          cloneFolders,
        }),
      )?.sidebarKey;
      setWorkspaceCollapsed(chatSidebarKey || chat.workspaceFile || '', false);
      render();
      finishSelect();
    });
  }

  /**
   * Flip the server-wide start gate or one workspace's watcher mode. The REST
   * write is authoritative; on success the local stores are updated so the
   * switch repaints before the next presence frame reconciles it.
   *
   * @param {HTMLButtonElement} btn
   * @returns {Promise<void>}
   */
  async function handleWatcherToggle(btn) {
    if (!btn || btn.disabled) return;
    const scope = btn.dataset?.watcherScope === 'all' ? 'all' : 'workspace';
    const folder = String(btn.dataset?.workspaceFolder || '');
    const next = btn.getAttribute('aria-checked') !== 'true';
    btn.disabled = true;
    const result = scope === 'all'
      ? await setWorkspaceWatcherStartsEnabled(next)
      : await setWorkspaceWatcherEnabled(folder, next);
    btn.disabled = false;
    if (!result.ok) return;
    if (scope === 'workspace') {
      applyWorkspaceWatcherModeLocal(folder, next ? 'autopilot' : 'off');
    }
    updateScheduler.schedule();
  }

  /**
   * One click listener on the static `.sidebar-body`: every row, header and
   * action button is dispatched through `closest()`. The body element itself is
   * never replaced, so the listener set survives every rebuild.
   */
  function onSidebarBodyClick(ev) {
    const target = ev.target instanceof Element ? ev.target : null;
    if (!target) return;

    const watcherShowAll = target.closest('.sidebar-watcher-show-all');
    if (watcherShowAll) {
      writeWatcherShowAllFlag(!readWatcherShowAllFlag());
      forceRerender();
      return;
    }
    const watcherToggle = target.closest('.sidebar-watcher-toggle');
    if (watcherToggle) {
      void handleWatcherToggle(watcherToggle);
      return;
    }
    const pinnedRow = target.closest('.sidebar-pinned-chat');
    if (pinnedRow) {
      openPinnedChatRow(pinnedRow);
      return;
    }
    const subchatArchive = target.closest('.sidebar-subchat-group-archive');
    if (subchatArchive) {
      archiveSubchatGroup(subchatArchive, ev);
      return;
    }
    const actionBtn = target.closest('.sidebar-chat-action');
    if (actionBtn) {
      handleChatRowAction(actionBtn, ev);
      return;
    }
    const newBtn = target.closest('.sidebar-workspace-new-btn');
    if (newBtn) {
      openNewChatForWorkspace(newBtn, ev);
      return;
    }
    const archiveHeader = target.closest('.sidebar-archive-header');
    if (archiveHeader) {
      toggleArchiveSection(archiveHeader, ev);
      return;
    }
    // The whole group row toggles, not just the button: the wide (grid) layout
    // reserves dead columns for the count/summary/actions, and clicking any of
    // them used to do nothing. The archive button is handled before this branch.
    const subchatHeader = target.closest('.sidebar-subchat-group-header');
    if (subchatHeader) {
      const subchatToggle = subchatHeader.querySelector('.sidebar-subchat-group-toggle');
      if (subchatToggle) toggleSubchatGroup(subchatToggle, ev);
      return;
    }
    const moreEl = target.closest('.sidebar-chat-more');
    if (moreEl) {
      expandAllChats(moreEl, ev);
      return;
    }
    const header = target.closest('.sidebar-workspace-header');
    if (header) {
      handleWorkspaceHeaderClick(header, ev);
      return;
    }
    const chatRow = target.closest('.sidebar-chat-item');
    if (chatRow) selectChatRow(chatRow);
  }

  // `.sidebar-body` is static, but guard against a shell re-render replacing it.
  const wiredBodyEvents = new WeakSet();

  function wireBodyEvents() {
    const body = getContainer()?.querySelector('.sidebar-body');
    if (!body || wiredBodyEvents.has(body)) return;
    wiredBodyEvents.add(body);
    body.addEventListener('click', onSidebarBodyClick);
    body.addEventListener('keydown', onSidebarBodyKeydown);
    body.addEventListener('pointerdown', onSidebarBodyPointerDown, true);
    wireArchiveVirtualFocusTracking(body);
  }

  return { activateChatPanelTab, onSidebarBodyPointerDown, closeSidebarAfterMobileAction, openPinnedChatRow, openNewChatForWorkspace, handleWorkspaceHeaderClick, toggleArchiveSection, toggleSubchatGroup, archiveSubchatGroup, expandAllChats, handleChatRowAction, selectChatRow, handleWatcherToggle, onSidebarBodyClick, wireBodyEvents, wiredBodyEvents };
}
