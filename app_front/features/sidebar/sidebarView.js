/**
 * Sidebar listing workspaces and chats. It replaces the chat switcher dropdown as
 * the primary UI, while the dropdown stays available as a fallback.
 * The drawer slides in from the left via the header menu icon.
 *
 * The closure is a thin composition root: state lives in `state/`, rendering,
 * patching, events and gestures live in `views/` as factories sharing one `ctx`.
 */

import { installPerfProbe } from '../../lib/perfProbe.js';
import { sharedState } from '../../state/index.js';
import { readSidebarOnlyWorktreeFlag, SIDEBAR_ONLY_ACTIVE_WORKSPACE_KEY } from './sidebarOnlyActiveFilter.js';
import {
  refreshWorkspaceWatcherRuntimeControl,
} from './workspaceWatcherToggle.js';
import { createRafDebouncer } from '../chat/chatListStateRefresh.js';
import { getUiFreezeCounters } from '../../lib/uiFreezeCounters.js';
import { createSidebarSearchService } from './services/sidebarSearchService.js';
import {
  readOpenFlag,
  readPinFlag,
  normalizePath,
} from './state/sidebarPersistence.js';
import { createSidebarLayoutState } from './state/sidebarLayoutState.js';
import { createSidebarRenderPass } from './state/sidebarRenderPass.js';
import { createSidebarChrome } from './views/sidebarChrome.js';
import { createSidebarChatRows } from './views/sidebarChatRows.js';
import { createSidebarWorkspaceGroups } from './views/sidebarWorkspaceGroups.js';
import { createSidebarPinnedSection } from './views/sidebarPinnedSection.js';
import { createSidebarSignature } from './views/sidebarSignature.js';
import { createSidebarPatch } from './views/sidebarPatch.js';
import { createSidebarRender } from './views/sidebarRender.js';
import { createSidebarBodyEvents } from './views/sidebarBodyEvents.js';
import { createSidebarGestures } from './views/sidebarGestures.js';
import './cr-sidebar-chat-row.js';
import './cr-sidebar-workspace.js';

export { resolveSidebarHarnessIcon } from './views/sidebarHarnessIcon.js';
export { planWorkspaceRebuild } from './views/sidebarRebuildPlan.js';

/** Chats expanded with the sidebar's show-more control. */
const showAllChatsBySidebarKey = new Set();

/**
 * Parse one trusted sidebar markup string (the pinned watcher section; every
 * dynamic value in it is escaped by the caller) into an element. This is the
 * only markup sink left in the sidebar and stays here, in a file whose
 * innerHTML baseline is tracked by the size ratchet.
 * @param {string} html
 * @returns {Element|null}
 */
function parseSidebarMarkup(html) {
  const template = document.createElement('template');
  template.innerHTML = String(html || '').trim();
  return template.content.firstElementChild;
}

export function createSidebarView(deps) {
  installPerfProbe();
  const {
    getWorkspaces,
    getChats,
    getArchivedCounts = () => ({}),
    getActiveWorkspaceFile,
    getActiveWorkspaceFolder = () => '',
    getActiveChatId,
    selectChat,
    switchWorkspace,
    getPreferredWorkspaceFolder = () => '',
    chatFavorites,
    resolveChatState,
    getTerminalStateMeta,
    requestArchiveChat,
    requestRestoreChat,
    requestDeleteChat = () => {},
    requestNewChat = () => {},
    requestLoadArchivedChats = () => {},
    expandWorkspaceChatsForSearch = null,
    notifySidebarSearchActive = null,
    canPinChatToUrl = () => false,
    toggleChatUrlPinById = async () => {},
    escapeHtml,
    openWorkspaceSettings = () => {},
    refreshStates = () => {},
    setChatForkParent = async () => {},
    onArchiveSettled = null,
    isMobileViewport = () =>
      typeof window !== 'undefined' && window.matchMedia
        ? window.matchMedia('(max-width: 768px)').matches
        : false,
  } = deps;

  /**
   * Mutable closure state shared by the view modules (they read and write it
   * through this object so a module never captures a stale copy).
   */
  const state = {
    open: readOpenFlag(),
    pinned: readPinFlag(),
    lastRenderSignature: '',
    /** Active chat id the mounted rows were last painted for; null until the first full pass. */
    lastPatchedActiveChatId: null,
    /** Workspaces whose chat list hit the visible-row cap in the last membership scan. */
    lastPassCappedWorkspaces: 0,
    /** Chats inside the first `limit` rows of every workspace (visible without active-chat protection). */
    lastNaturalVisibleIds: new Set(),
    /** Skeleton signature (row-only fields blanked) that produced lastRenderSignature. */
    lastSkeletonSignature: null,
    /** Previous NAMED signature segments, held only while the trace flag is on. */
    lastRenderSigParts: null,
    /**
     * Per-pass workspace-tree cache. A single render/update pass computes each
     * workspace's archive-split + flat tree + settled-subchat grouping EXACTLY once
     * and shares the result across the signature, the rendered-id set and the HTML
     * build. Reset at the start of every pass.
     * @type {{ activeChatId: string, searching: boolean, map: Map<string, object> } | null}
     */
    renderPass: null,
    /** HTML of the last pinned watcher section, so it is only reshuffled on change. */
    lastPinnedSectionHtml: '',
    searchQuery: '',
    workspaceDrag: { isDragging: () => false },
    chatDrag: { isDragging: () => false },
    swipe: { isSwiping: () => false, abort() {} },
    /** @type {Map<string, { allChildIds: string[] }>} */
    settledGroupsByParent: new Map(),
  };
  /**
   * Per-workspace `<li class="sidebar-workspace">` nodes kept across renders so a
   * structure change in one workspace only recreates that node. Keyed by
   * sidebar key, with the per-workspace structure signature that produced it.
   * Cleared by `forceRerender()` (language/order changes need fresh text).
   * @type {Map<string, { sig: string, node: Element }>}
   */
  const renderedWorkspaceNodes = new Map();
  /**
   * Coalesced sidebar update: many callers (`notifySidebar`) fire per frame
   * (presence / title / chatsChanged). One `render()` per animation frame bounds
   * the cost; `forceRerender()` stays synchronous for callers that need the DOM
   * immediately.
   */
  const updateScheduler = createRafDebouncer(() => {
    ctx.render();
  });
  /** @type {Set<string>} parent ids with an archive request in flight */
  const archivingGroupParents = new Set();

  /** @type {Record<string, any>} */
  const ctx = {
    getWorkspaces, getChats, getArchivedCounts, getActiveWorkspaceFile, getActiveWorkspaceFolder,
    getActiveChatId, selectChat, switchWorkspace, getPreferredWorkspaceFolder, chatFavorites,
    resolveChatState, getTerminalStateMeta, requestArchiveChat, requestRestoreChat, requestDeleteChat,
    requestNewChat, requestLoadArchivedChats, expandWorkspaceChatsForSearch, notifySidebarSearchActive,
    canPinChatToUrl, toggleChatUrlPinById, escapeHtml, openWorkspaceSettings, refreshStates,
    setChatForkParent, onArchiveSettled, isMobileViewport,
    parseSidebarMarkup, state, showAllChatsBySidebarKey, renderedWorkspaceNodes, archivingGroupParents, updateScheduler,
  };

  const searchService = createSidebarSearchService({
    getChats,
    getWorkspaces,
    getActiveChatId,
    getPreferredWorkspaceFolder,
    expandWorkspaceChatsForSearch,
    notifySidebarSearchActive,
    readSidebarOnlyWorktreeFlag,
    orderedChats: (list) => ctx.orderedChats(list),
    getArchivedCounts,
    normalizePath,
  });
  ctx.searchService = searchService;

  Object.assign(ctx, {
    getSearchInput: () => searchService.getInput(),
    isSearchActive: () => searchService.isActive(),
    isSearchFocused: () => searchService.isFocused(),
    activeWorktreeFilterId: () => searchService.activeWorktreeFilterId(),
    setSearchQuery: (value) => {
      searchService.setQuery(value);
      state.searchQuery = searchService.query;
    },
    visibleChatsForWorkspace: (workspace) => searchService.visibleChatsForWorkspace(workspace),
    archivedCountForWorkspace: (workspace) => searchService.archivedCountForWorkspace(workspace),
    chatsForWorkspace: (workspace) => searchService.chatsForWorkspace(workspace),
  });

  ctx.forceRerender = forceRerender;

  // Layout state first: it owns the persisted sets the other modules destructure.
  Object.assign(ctx, createSidebarLayoutState(ctx));
  Object.assign(ctx, createSidebarRenderPass(ctx));
  Object.assign(ctx, createSidebarChrome(ctx));
  Object.assign(ctx, createSidebarChatRows(ctx));
  Object.assign(ctx, createSidebarWorkspaceGroups(ctx));
  Object.assign(ctx, createSidebarPinnedSection(ctx));
  Object.assign(ctx, createSidebarSignature(ctx));
  Object.assign(ctx, createSidebarPatch(ctx));
  Object.assign(ctx, createSidebarRender(ctx));
  Object.assign(ctx, createSidebarBodyEvents(ctx));
  Object.assign(ctx, createSidebarGestures(ctx));

  const {
    render,
    patchTransientVisualStates,
    applyActiveChatOnly,
    readLayoutSnapshot,
    applyLayoutSnapshot,
    renderSignature,
    openSidebar,
    closeSidebar,
    toggleSidebar,
    applyPinButton,
    applyVisibility,
    applySidebarWidth,
    initMenuButton,
    initResizer,
    initSearchInput,
    initPinActiveWorkspaceSetting,
    initWorkspaceDrag,
    initChatDrag,
    initArchiveVirtualGestureGuard,
    initSwipe,
  } = ctx;

  function init() {
    initMenuButton();
    initSearchInput();
    initPinActiveWorkspaceSetting();
    initWorkspaceDrag();
    initChatDrag();
    initArchiveVirtualGestureGuard();
    applySidebarWidth();
    initResizer();
    initSwipe();
    applyVisibility();
    // The render signature tracks data, not language, so a language switch
    // needs an explicit rerender to pick up new labels.
    window.addEventListener('cr-lang-changed', () => {
      applyPinButton();
      forceRerender();
    });
    window.addEventListener('resize', () => {
      applySidebarWidth();
      if (state.swipe.isSwiping()) return;
      applyVisibility();
    });
    // The master switch reads a server-wide gate that the presence frame does not
    // carry: fetch it once, then refresh whenever the watcher reports a change.
    sharedState.onWatcherChanged(() => {
      void refreshWorkspaceWatcherRuntimeControl().then(() => updateScheduler.schedule());
    });
    // The only-active filter is per browser: another tab flipping it must
    // repaint here too (best-effort; fires only for cross-tab writes).
    window.addEventListener('storage', (event) => {
      if (event?.key !== SIDEBAR_ONLY_ACTIVE_WORKSPACE_KEY) return;
      forceRerender();
    });
    void refreshWorkspaceWatcherRuntimeControl().then((ok) => {
      if (ok) updateScheduler.schedule();
    });
    render();
  }

  function forceRerender() {
    getUiFreezeCounters()?.bump('sidebar.forceRenders');
    state.lastRenderSignature = '';
    state.lastPatchedActiveChatId = null;
    state.lastSkeletonSignature = null;
    // Language / explicit force: text must be regenerated, so drop the reuse map.
    renderedWorkspaceNodes.clear();
    state.lastPinnedSectionHtml = '';
    render();
  }

  return {
    init,
    open: openSidebar,
    close: closeSidebar,
    toggle: toggleSidebar,
    isOpen: () => state.open,
    isPinned: () => state.pinned,
    render,
    forceRerender,
    // Coalesced "something changed" entry point — at most one render per frame.
    scheduleUpdate: () => updateScheduler.schedule(),
    // In-place repaint of the visuals kept out of the structural signature
    // (active chat, group summaries, parent badges). Safe to call any time.
    patchTransientVisualStates,
    applyActiveChatOnly,
    readLayoutSnapshot,
    applyLayoutSnapshot,
    /** Test seam: mounted workspace `<li>` node for reuse checks (leaf 6.1). */
    getWorkspaceRenderNode: (sidebarKey) =>
      renderedWorkspaceNodes.get(String(sidebarKey || '').trim())?.node ?? null,
    // Test seams: the structural render signature is pure data → a string, so the
    // "status/active must not rebuild" contract is unit-checkable without a DOM.
    renderSignature,
  };
}