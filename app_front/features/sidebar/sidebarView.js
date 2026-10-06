/**
 * Sidebar listing workspaces and chats. It replaces the chat switcher dropdown as
 * the primary UI, while the dropdown stays available as a fallback.
 * The drawer slides in from the left via the header menu icon.
 */

import {
  applyChatOrder,
  buildForkArchiveBlockedIds,
  flattenChatsTree,
  isChatArchived,
  isForkArchiveBlocked,
  partitionChatsByArchive,
} from '../../../lib/chat-tree.js';
import { hasLiveHarnessWork } from '../chat/chatStatusMeta.js';
import { MAX_SIDEBAR_NEST_INDENT } from './sidebarChatDragBlock.js';
import { sortChatsByFavoriteThenDate } from '../chat/chatListSort.js';
import { readStorageValueWithAlias, writeStorageValueWithAlias } from '../../lib/storageKeyAlias.js';
import { getCurrentLang, t } from '../../i18n/index.js';
import { isSidebarDocked } from './sidebarDock.js';
import { matchesSidebarSearch } from './sidebarSearch.js';
import {
  capSidebarVisibleTreeChats,
  SIDEBAR_VISIBLE_CHAT_LIMIT,
  shouldSerializeWorkspaceChatList,
  setRenderedSidebarChatIds,
  getRenderedSidebarChatIds,
  setSidebarArchiveSectionOpen,
} from './sidebarVisibleChats.js';
import {
  formatSubchatParentBadge,
  formatSubchatSummary,
  getAncestorContinuationLevels,
  groupSettledChildren,
  renderTreeContinuationHtml,
} from './sidebarSubchatGroups.js';
import { initSidebarChatDrag } from './sidebarChatDrag.js';
import {
  applyWorkspaceWatcherModeLocal,
  listEnabledWorkspaceWatcherPinnedChats,
  listWorkspaceWatcherPinnedChats,
  renderWorkspaceAutopilotBadgeHtml,
  resolveWorkspaceWatcherBadge,
  workspaceWatcherPresenceRevision,
} from './workspaceAutopilotBadge.js';
import {
  getWorkspaceWatcherRuntimeControl,
  isWorkspaceWatcherStartsEnabled,
  refreshWorkspaceWatcherRuntimeControl,
  setWorkspaceWatcherEnabled,
  setWorkspaceWatcherStartsEnabled,
  workspaceWatcherRuntimeRevision,
} from './workspaceWatcherToggle.js';
import { readChatOrder, writeChatOrder, writeChatOrderForList } from './sidebarChatOrder.js';
import {
  publishSidebarLayout,
  sidebarLayoutListsEqual,
} from './sidebarLayoutSync.js';
import { initSidebarWorkspaceDrag } from './sidebarWorkspaceDrag.js';
import {
  readWorkspaceOrder,
  writeWorkspaceOrder,
} from './sidebarWorkspaceOrder.js';
import { sortSidebarWorkspaces } from './sidebarWorkspaceSort.js';
import { resolvePersistedLocalChatHarnessDisplay } from '../chat/persistedLocalChatState.js';
import {
  chatBelongsToWorkspaceGroup,
  listCloneFoldersForWorkspaceFile,
  resolveWorkspaceTargetForChat,
} from './workspaceChatMatch.js';
import {
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_RESIZE_STEP,
  clampSidebarWidth,
} from './sidebarWidth.js';
import { initSidebarSwipe } from './sidebarSwipe.js';
import { isUiFreezeTraceActive } from '../../lib/uiFreezeTrace.js';
import { getUiFreezeCounters, measureFreezeSpan } from '../../lib/uiFreezeCounters.js';
import {
  diffSignatureSegments,
  getUiFreezeMetrics,
  monoNow,
} from './sidebarRenderMetrics.js';
import { createRafDebouncer } from '../chat/chatListStateRefresh.js';
import './cr-sidebar-chat-row.js';
import './cr-sidebar-workspace.js';
import {
  beginSidebarChatRowPass,
  endSidebarChatRowPass,
  registerSidebarChatRow,
} from './sidebarChatRowPass.js';
import {
  beginSidebarSubchatGroupPass,
  endSidebarSubchatGroupPass,
  registerSidebarSubchatGroup,
} from './sidebarSubchatGroupPass.js';
import {
  beginSidebarArchiveGroupPass,
  endSidebarArchiveGroupPass,
  registerSidebarArchiveGroup,
} from './sidebarArchiveGroupPass.js';
import { registerArchiveChatRowSlice } from './sidebarArchiveChatRows.js';
import {
  archiveWindowChatIds,
  computeSidebarArchiveMountedRowLimit,
  selectArchiveVisibleWindow,
  SIDEBAR_ARCHIVE_TEST_VIEWPORT_HEIGHT_PX,
} from './sidebarArchiveVirtualizer.js';
import { getSidebarArchiveVirtualWindow } from './sidebarArchiveVirtualState.js';
import { getSidebarArchiveGroupRegistration } from './sidebarArchiveGroupPass.js';
import {
  clearArchiveGestureFocusSnapshot,
  registerSidebarArchiveGestureEndFlush,
  registerSidebarArchiveGestureGuard,
  runSidebarArchiveGestureEndFlush,
  tickSidebarArchiveGestureFocusSnapshot,
} from './sidebarArchiveVirtualFocus.js';
import {
  captureSidebarFocusInfo,
  handleSidebarArchiveKeydown,
  restoreSidebarFocus,
  wireArchiveVirtualFocusTracking,
} from './sidebarArchiveSidebarFocus.js';
import {
  beginSidebarWorkspacePass,
  endSidebarWorkspacePass,
  registerSidebarWorkspace,
} from './sidebarWorkspacePass.js';
import {
  sidebarArchiveRepeatKey,
  sidebarChatRepeatKey,
  sidebarEmptyRepeatKey,
  sidebarShowMoreRepeatKey,
  sidebarSubchatGroupRepeatKey,
} from './sidebarWorkspaceModel.js';
import {
  createSidebarWorkspaceHostElement,
  hydrateSidebarWorkspaceHosts,
  requestSidebarWorkspaceUpdate,
  waitForSidebarLitHostsCommit,
} from './sidebarWorkspaceMount.js';

const SIDEBAR_OPEN_KEY = 'cretli-sidebar-open';
const SIDEBAR_COLLAPSE_KEY = 'cretli-sidebar-collapsed';
const SIDEBAR_ARCHIVE_OPEN_KEY = 'cretli-sidebar-archive-open';
const SIDEBAR_SUBCHAT_EXPANDED_KEY = 'cretli-sidebar-subchat-expanded';
const SIDEBAR_PIN_KEY = 'cretli-sidebar-pinned';
const SIDEBAR_WIDTH_KEY = 'cretli-sidebar-width';
const SIDEBAR_PIN_ACTIVE_WORKSPACE_KEY = 'cretli-sidebar-pin-active-workspace';
const SIDEBAR_WATCHER_SHOW_ALL_KEY = 'cretli-sidebar-watcher-show-all';

/** @type {Set<string>} */
const showAllChatsBySidebarKey = new Set();

function readOpenFlag() {
  if (typeof localStorage === 'undefined') return false;
  try {
    return readStorageValueWithAlias(localStorage, SIDEBAR_OPEN_KEY, '') === '1';
  } catch (_) {
    return false;
  }
}

function writeOpenFlag(value) {
  if (typeof localStorage === 'undefined') return;
  try {
    writeStorageValueWithAlias(localStorage, SIDEBAR_OPEN_KEY, value ? '1' : '0');
  } catch (_) {}
}

function readPinFlag() {
  if (typeof localStorage === 'undefined') return false;
  try {
    return readStorageValueWithAlias(localStorage, SIDEBAR_PIN_KEY, '') === '1';
  } catch (_) {
    return false;
  }
}

function writePinFlag(value) {
  if (typeof localStorage === 'undefined') return;
  try {
    writeStorageValueWithAlias(localStorage, SIDEBAR_PIN_KEY, value ? '1' : '0');
  } catch (_) {}
}

function readPinActiveWorkspaceFlag() {
  if (typeof localStorage === 'undefined') return false;
  try {
    return readStorageValueWithAlias(localStorage, SIDEBAR_PIN_ACTIVE_WORKSPACE_KEY, '') === '1';
  } catch (_) {
    return false;
  }
}

function writePinActiveWorkspaceFlag(value) {
  if (typeof localStorage === 'undefined') return;
  try {
    writeStorageValueWithAlias(localStorage, SIDEBAR_PIN_ACTIVE_WORKSPACE_KEY, value ? '1' : '0');
  } catch (_) {}
}

/** `Show all workspaces` in the Workspace section header (persisted per device). */
function readWatcherShowAllFlag() {
  if (typeof localStorage === 'undefined') return false;
  try {
    return readStorageValueWithAlias(localStorage, SIDEBAR_WATCHER_SHOW_ALL_KEY, '') === '1';
  } catch (_) {
    return false;
  }
}

function writeWatcherShowAllFlag(value) {
  if (typeof localStorage === 'undefined') return;
  try {
    writeStorageValueWithAlias(localStorage, SIDEBAR_WATCHER_SHOW_ALL_KEY, value ? '1' : '0');
  } catch (_) {}
}

function readCollapsedSet() {
  if (typeof localStorage === 'undefined') return new Set();
  try {
    const raw = readStorageValueWithAlias(localStorage, SIDEBAR_COLLAPSE_KEY, '');
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed
        .map((item) => normalizePath(item))
        .filter((item) => item)
    );
  } catch (_) {
    return new Set();
  }
}

function writeCollapsedSet(set) {
  if (typeof localStorage === 'undefined') return;
  try {
    const normalized = [...set]
      .map((item) => normalizePath(item))
      .filter((item) => item);
    writeStorageValueWithAlias(localStorage, SIDEBAR_COLLAPSE_KEY, JSON.stringify(normalized));
  } catch (_) {}
}

function readArchiveOpenSet() {
  if (typeof localStorage === 'undefined') return new Set();
  try {
    const raw = readStorageValueWithAlias(localStorage, SIDEBAR_ARCHIVE_OPEN_KEY, '');
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.map((item) => String(item || '').trim()).filter(Boolean));
  } catch (_) {
    return new Set();
  }
}

function writeArchiveOpenSet(set) {
  if (typeof localStorage === 'undefined') return;
  try {
    writeStorageValueWithAlias(localStorage, SIDEBAR_ARCHIVE_OPEN_KEY, JSON.stringify([...set]));
  } catch (_) {}
}

/**
 * Parent chat ids whose "settled subchats" group the user expanded. Default is
 * collapsed, so only expanded parents are persisted.
 *
 * @returns {Set<string>}
 */
function readSubchatExpandedSet() {
  if (typeof localStorage === 'undefined') return new Set();
  try {
    const raw = readStorageValueWithAlias(localStorage, SIDEBAR_SUBCHAT_EXPANDED_KEY, '');
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.map((item) => String(item || '').trim()).filter(Boolean));
  } catch (_) {
    return new Set();
  }
}

/**
 * @param {Set<string>} set
 */
function writeSubchatExpandedSet(set) {
  if (typeof localStorage === 'undefined') return;
  try {
    writeStorageValueWithAlias(localStorage, SIDEBAR_SUBCHAT_EXPANDED_KEY, JSON.stringify([...set]));
  } catch (_) {}
}

function normalizePath(p) {
  if (typeof p !== 'string') return '';
  return p.replace(/\\/g, '/').replace(/\/$/, '').trim();
}

function getViewportWidth() {
  return typeof window !== 'undefined' ? window.innerWidth : 0;
}

function clampToViewport(value) {
  return clampSidebarWidth(value, getViewportWidth());
}

function readSidebarWidth() {
  if (typeof localStorage === 'undefined') return 0;
  try {
    const raw = readStorageValueWithAlias(localStorage, SIDEBAR_WIDTH_KEY, '');
    const n = parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  } catch (_) {
    return 0;
  }
}

function writeSidebarWidth(value) {
  if (typeof localStorage === 'undefined') return;
  try {
    writeStorageValueWithAlias(
      localStorage,
      SIDEBAR_WIDTH_KEY,
      String(clampToViewport(value))
    );
  } catch (_) {}
}

function applySidebarWidth() {
  const aside = document.getElementById('app-sidebar');
  if (!aside) return;
  const saved = readSidebarWidth();
  if (saved > 0) {
    aside.style.setProperty('--sidebar-width', `${clampToViewport(saved)}px`);
  } else {
    aside.style.removeProperty('--sidebar-width');
  }
  const resizer = document.getElementById('sidebar-resizer');
  if (!resizer) return;
  const vw = getViewportWidth();
  const rendered = Math.round(aside.getBoundingClientRect().width) || clampToViewport(saved);
  resizer.setAttribute('aria-valuemin', String(clampSidebarWidth(0, vw)));
  resizer.setAttribute('aria-valuemax', String(clampSidebarWidth(Number.MAX_SAFE_INTEGER, vw)));
  resizer.setAttribute('aria-valuenow', String(rendered));
}

/**
 * Harness icon file for a sidebar chat row.
 *
 * A persisted local chat whose plugin is unavailable/disabled/incompatible must not show
 * a built-in brand icon (the default would suggest Cursor), so it resolves to `''` and the
 * row renders the neutral `--local` badge with only the localized title tooltip.
 *
 * @param {{ agentTransport?: unknown, harnessState?: { code?: unknown } | null } | null | undefined} chat
 * @returns {string} icon file name under /harness-icons, or '' for no image
 */
export function resolveSidebarHarnessIcon(chat) {
  if (resolvePersistedLocalChatHarnessDisplay(chat).blocked) return '';
  const harness = String(chat?.agentTransport || 'sdk').trim().toLowerCase();
  return ({
    sdk: 'cursor.svg',
    'cursor-sdk': 'cursor.svg',
    openrouter: 'openrouter.svg',
    opencode: 'opencode.svg',
    codebuddy: 'codebuddy.svg',
    deepseek: 'deepseek.svg',
    codex: 'codex.svg',
    qwen: 'qwen.svg',
    claude: 'claude.svg',
  })[harness] || 'cursor.svg';
}

/**
 * Pure decision for a partial workspace rebuild (leaf 00df6141 item 6): given the
 * signatures that produced the currently mounted `<li>` nodes, the ordered keys
 * of the next render and each key's fresh signature, decide which workspace
 * nodes can be reused as-is, which must be rebuilt, and which are gone.
 *
 * Reusing a node keeps its chat rows (and any in-flight DOM/animation) intact,
 * so a change in one workspace must not recreate the others.
 *
 * @param {Map<string, string>} previousSigs key → signature currently mounted
 * @param {string[]} orderedKeys sidebar keys in render order
 * @param {Map<string, string>} sigByKey fresh key → signature
 * @returns {{ reuseKeys: Set<string>, rebuildKeys: string[], removeKeys: string[] }}
 */
export function planWorkspaceRebuild(previousSigs, orderedKeys, sigByKey) {
  const reuseKeys = new Set();
  const rebuildKeys = [];
  for (const key of orderedKeys) {
    const sig = sigByKey.get(key) || '';
    if (previousSigs.get(key) === sig) reuseKeys.add(key);
    else rebuildKeys.push(key);
  }
  const ordered = new Set(orderedKeys);
  const removeKeys = [...previousSigs.keys()].filter((key) => !ordered.has(key));
  return { reuseKeys, rebuildKeys, removeKeys };
}

export function createSidebarView(deps) {
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

  let open = readOpenFlag();
  let pinned = readPinFlag();
  const collapsed = readCollapsedSet();
  const archiveOpen = readArchiveOpenSet();
  const subchatExpanded = readSubchatExpandedSet();
  setSidebarArchiveSectionOpen(archiveOpen.size > 0);
  let lastRenderSignature = '';
  /** Previous NAMED signature segments, held only while the trace flag is on. */
  let lastRenderSigParts = null;
  /**
   * Per-pass workspace-tree cache. A single render/update pass computes each
   * workspace's archive-split + flat tree + settled-subchat grouping EXACTLY once
   * and shares the result across the signature, the rendered-id set and the HTML
   * build — previously three independent walks. Reset at the start of every pass.
   * @type {{ activeChatId: string, searching: boolean, map: Map<string, object> } | null}
   */
  let renderPass = null;
  /**
   * Per-workspace `<li class="sidebar-workspace">` nodes kept across renders so a
   * structure change in one workspace only recreates that node. Keyed by
   * sidebar key, with the per-workspace structure signature that produced it.
   * Cleared by `forceRerender()` (language/order changes need fresh text).
   * @type {Map<string, { sig: string, node: Element }>}
   */
  const renderedWorkspaceNodes = new Map();
  /** HTML of the last pinned watcher section, so it is only reshuffled on change. */
  let lastPinnedSectionHtml = '';
  /**
   * Coalesced sidebar update: many callers (`notifySidebar`) fire per frame
   * (presence / title / chatsChanged). One `render()` per animation frame bounds
   * the cost; `forceRerender()` stays synchronous for callers that need the DOM
   * immediately. `render` is a hoisted declaration so the arrow can reference it.
   */
  const updateScheduler = createRafDebouncer(() => {
    render();
  });
  let searchQuery = '';
  let workspaceDrag = { isDragging: () => false };
  let chatDrag = { isDragging: () => false };
  let swipe = { isSwiping: () => false, abort() {} };
  /** @type {Map<string, { allChildIds: string[] }>} */
  let settledGroupsByParent = new Map();
  /** @type {Set<string>} parent ids with an archive request in flight */
  const archivingGroupParents = new Set();

  function getContainer() {
    return document.getElementById('app-sidebar');
  }

  function getBackdrop() {
    return document.getElementById('app-sidebar-backdrop');
  }

  function applyPinButton() {
    const btn = document.getElementById('sidebar-pin-btn');
    if (!btn) return;
    const label = pinned ? t('sidebar.unpin') : t('sidebar.pin');
    btn.setAttribute('aria-pressed', pinned ? 'true' : 'false');
    btn.setAttribute('title', label);
    btn.setAttribute('aria-label', label);
    btn.classList.toggle('is-active', pinned);
    const icon = btn.querySelector('.mdi');
    if (!icon) return;
    icon.classList.toggle('mdi-pin', pinned);
    icon.classList.toggle('mdi-pin-outline', !pinned);
  }

  function applyDockLayout() {
    const docked = isSidebarDocked({
      pinned,
      open,
      isMobile: isMobileViewport(),
    });
    document.body?.classList.toggle('sidebar-docked', docked);
    const root = document.documentElement;
    if (!root) return;
    if (!docked) {
      root.style.setProperty('--sidebar-dock-width', '0px');
      return;
    }
    const aside = getContainer();
    const measured = aside ? Math.round(aside.getBoundingClientRect().width) : 0;
    const width = measured > 0 ? measured : clampToViewport(readSidebarWidth());
    root.style.setProperty('--sidebar-dock-width', `${width}px`);
  }

  function applyVisibility() {
    if (swipe.isSwiping()) return;
    const aside = getContainer();
    const backdrop = getBackdrop();
    if (aside) aside.hidden = !open;
    if (backdrop) backdrop.hidden = !open || !isMobileViewport();
    document.body?.classList.toggle('sidebar-open', open);
    const menuBtn = document.getElementById('header-menu-btn');
    if (menuBtn) {
      menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      menuBtn.classList.toggle('is-active', open);
    }
    applyPinButton();
    applyEdgeOpenHandle();
    if (open) applySidebarWidth();
    applyDockLayout();
  }

  function applyEdgeOpenHandle() {
    const edge = document.getElementById('sidebar-edge-open');
    if (!edge) return;
    edge.hidden = open || !isMobileViewport();
  }

  function revealDrawerPreview() {
    const aside = getContainer();
    const backdrop = getBackdrop();
    if (aside) aside.hidden = false;
    if (backdrop) backdrop.hidden = false;
    applySidebarWidth();
  }

  function hideDrawerPreview() {
    if (open) return;
    applyVisibility();
  }

  function togglePin() {
    pinned = !pinned;
    writePinFlag(pinned);
    if (pinned && !open) {
      open = true;
      writeOpenFlag(true);
    }
    applyVisibility();
  }

  function openSidebar() {
    open = true;
    writeOpenFlag(true);
    applyVisibility();
    // The drawer may have been hidden while the active chat changed. The queued
    // render then skipped the transient patch (the aside was hidden), so repaint
    // the active row / group summaries now that the aside is visible again.
    patchTransientVisualStates();
    refreshStates();
  }

  function closeSidebar() {
    swipe.abort();
    open = false;
    writeOpenFlag(false);
    applyVisibility();
  }

  function toggleSidebar() {
    if (open) closeSidebar();
    else openSidebar();
  }

  function isWorkspaceCollapsed(sidebarKey) {
    return collapsed.has(normalizePath(sidebarKey));
  }

  function setWorkspaceCollapsed(sidebarKey, value) {
    const key = normalizePath(sidebarKey);
    if (!key) return;
    const had = collapsed.has(key);
    if (value === had) return;
    if (value) collapsed.add(key);
    else collapsed.delete(key);
    writeCollapsedSet(collapsed);
    publishSidebarLayout({ collapsedWorkspaces: [...collapsed] });
  }

  function toggleWorkspaceCollapsed(sidebarKey) {
    setWorkspaceCollapsed(sidebarKey, !isWorkspaceCollapsed(sidebarKey));
    render();
  }

  function isArchiveSectionOpen(sidebarKey) {
    return archiveOpen.has(String(sidebarKey || '').trim());
  }

  function setArchiveSectionOpen(sidebarKey, value) {
    const key = String(sidebarKey || '').trim();
    if (!key) return;
    const had = archiveOpen.has(key);
    if (value === had) return;
    if (value) archiveOpen.add(key);
    else archiveOpen.delete(key);
    writeArchiveOpenSet(archiveOpen);
    setSidebarArchiveSectionOpen(archiveOpen.size > 0);
    publishSidebarLayout({ archiveOpen: [...archiveOpen] });
  }

  function isSubchatGroupExpanded(parentId) {
    return subchatExpanded.has(String(parentId || '').trim());
  }

  function setSubchatGroupExpanded(parentId, value) {
    const key = String(parentId || '').trim();
    if (!key) return;
    const had = subchatExpanded.has(key);
    if (value === had) return;
    if (value) subchatExpanded.add(key);
    else subchatExpanded.delete(key);
    writeSubchatExpandedSet(subchatExpanded);
    publishSidebarLayout({ subchatExpanded: [...subchatExpanded] });
  }

  /**
   * @param {Iterable<string>} values
   * @param {(value: string) => string} normalize
   * @returns {Set<string>}
   */
  function replaceSet(values, normalize) {
    const next = new Set();
    (Array.isArray(values) ? values : [...values]).forEach((item) => {
      const value = normalize(String(item || ''));
      if (value) next.add(value);
    });
    return next;
  }

  /**
   * @returns {{
   *   chatOrder: string[],
   *   workspaceOrder: string[],
   *   collapsedWorkspaces: string[],
   *   subchatExpanded: string[],
   *   archiveOpen: string[],
   * }}
   */
  function readLayoutSnapshot() {
    return {
      chatOrder: readChatOrder(),
      workspaceOrder: readWorkspaceOrder(),
      collapsedWorkspaces: [...collapsed],
      subchatExpanded: [...subchatExpanded],
      archiveOpen: [...archiveOpen],
    };
  }

  /**
   * Apply a server layout into the local cache without publishing it back.
   *
   * @param {object | null | undefined} layout
   * @returns {boolean} true when any persisted layout field changed
   */
  function applyLayoutSnapshot(layout) {
    if (!layout || typeof layout !== 'object') return false;
    let changed = false;
    if (Array.isArray(layout.chatOrder)) {
      if (!sidebarLayoutListsEqual('chatOrder', layout.chatOrder, readChatOrder())) {
        writeChatOrder(layout.chatOrder);
        changed = true;
      }
    }
    if (Array.isArray(layout.workspaceOrder)) {
      if (!sidebarLayoutListsEqual('workspaceOrder', layout.workspaceOrder, readWorkspaceOrder())) {
        writeWorkspaceOrder(layout.workspaceOrder);
        changed = true;
      }
    }
    if (Array.isArray(layout.collapsedWorkspaces)) {
      if (!sidebarLayoutListsEqual('collapsedWorkspaces', layout.collapsedWorkspaces, [...collapsed])) {
        collapsed.clear();
        replaceSet(layout.collapsedWorkspaces, normalizePath).forEach((key) => collapsed.add(key));
        writeCollapsedSet(collapsed);
        changed = true;
      }
    }
    if (Array.isArray(layout.subchatExpanded)) {
      if (!sidebarLayoutListsEqual('subchatExpanded', layout.subchatExpanded, [...subchatExpanded])) {
        subchatExpanded.clear();
        replaceSet(layout.subchatExpanded, (value) => value.trim()).forEach((key) => subchatExpanded.add(key));
        writeSubchatExpandedSet(subchatExpanded);
        changed = true;
      }
    }
    if (Array.isArray(layout.archiveOpen)) {
      if (!sidebarLayoutListsEqual('archiveOpen', layout.archiveOpen, [...archiveOpen])) {
        archiveOpen.clear();
        replaceSet(layout.archiveOpen, (value) => value.trim()).forEach((key) => archiveOpen.add(key));
        writeArchiveOpenSet(archiveOpen);
        setSidebarArchiveSectionOpen(archiveOpen.size > 0);
        changed = true;
      }
    }
    return changed;
  }

  function getSearchInput() {
    return document.getElementById('sidebar-search');
  }

  function isSearchActive() {
    return String(searchQuery || '').trim() !== '';
  }

  function isSearchFocused() {
    const el = getSearchInput();
    if (!el || typeof document === 'undefined') return false;
    return document.activeElement === el || el.contains(document.activeElement);
  }

  function setSearchQuery(value) {
    const prevActive = isSearchActive();
    searchQuery = typeof value === 'string' ? value : '';
    const el = getSearchInput();
    if (el && el.value !== searchQuery) el.value = searchQuery;
    if (!prevActive && isSearchActive() && typeof notifySidebarSearchActive === 'function') {
      try {
        notifySidebarSearchActive();
      } catch (_) {}
    }
  }

  function visibleChatsForWorkspace(workspace) {
    const workspaceName = workspace.name || workspace.workspaceFile || '';
    const scoped = orderedChats(chatsForWorkspace(workspace));
    const pool = typeof expandWorkspaceChatsForSearch === 'function'
      ? expandWorkspaceChatsForSearch(workspace, scoped)
      : scoped;
    return pool
      // The durable watcher chat lives in its own "Workspace" section, never in
      // the normal chat list, so it cannot be dragged/reordered like a chat.
      .filter((chat) => chat?.watcherPinned !== true)
      .filter((chat) =>
        matchesSidebarSearch(searchQuery, {
          title: chat.title,
          workspaceName,
        })
      );
  }

  function archivedCountForWorkspace(workspace) {
    const counts = getArchivedCounts() || {};
    const workspaceFile = normalizePath(workspace.workspaceFile);
    if (!workspaceFile) return 0;
    const cloneFolders = listCloneFoldersForWorkspaceFile(
      getWorkspaces(),
      workspaceFile,
      getPreferredWorkspaceFolder,
    );
    const groupFolder = normalizePath(
      getPreferredWorkspaceFolder(workspace.sidebarKey || workspace.workspaceFile),
    );
    let total = 0;
    for (const [key, value] of Object.entries(counts)) {
      const split = String(key).split('\n');
      const stub = { workspaceFile: split[0] || '', workspaceFolder: split[1] || '' };
      if (
        chatBelongsToWorkspaceGroup(stub, {
          workspaceFile,
          groupFolder,
          isClone: workspace.isClone === true,
          cloneFolders,
        })
      ) {
        total += Number(value) || 0;
      }
    }
    return total;
  }

  function chatsForWorkspace(workspace) {
    const workspaceFile = normalizePath(workspace.workspaceFile);
    if (!workspaceFile) return [];
    const cloneFolders = listCloneFoldersForWorkspaceFile(
      getWorkspaces(),
      workspaceFile,
      getPreferredWorkspaceFolder,
    );
    const groupFolder = normalizePath(
      getPreferredWorkspaceFolder(workspace.sidebarKey || workspace.workspaceFile),
    );
    return getChats().filter((chat) =>
      chatBelongsToWorkspaceGroup(chat, {
        workspaceFile,
        groupFolder,
        isClone: workspace.isClone === true,
        cloneFolders,
      }),
    );
  }

  function orderedChats(list) {
    const ranked = sortChatsByFavoriteThenDate(list, (chat) => chatFavorites.isFavorite(chat.id));
    return applyChatOrder(ranked, readChatOrder());
  }

  /**
   * Shared grouping pipeline for a workspace: archive split, tree flatten and
   * settled-subchat folding. `registerWorkspaceGroupEntry` and
   * `collectRenderableChatIds` must agree on the visible rows, so both call this.
   *
   * @param {object[]} chats already search-filtered workspace chats
   * @param {string} activeChatId
   * @param {boolean} searching
   */
  function buildWorkspaceChatTree(chats, activeChatId, searching) {
    const { live, archived } = partitionChatsByArchive(chats);
    const tree = flattenChatsTree(live);
    const grouped = groupSettledChildren(tree, {
      isFavorite: (id) => chatFavorites.isFavorite(id),
      activeChatId,
      searching,
      isExpanded: (parentId) => isSubchatGroupExpanded(parentId),
    });
    return { live, archived, grouped, tree };
  }

  function beginRenderPass() {
    const { blocked } = buildForkArchiveBlockedIds(getChats(), hasLiveHarnessWork);
    beginSidebarChatRowPass();
    beginSidebarSubchatGroupPass();
    beginSidebarArchiveGroupPass();
    beginSidebarWorkspacePass();
    renderPass = {
      activeChatId: getActiveChatId() || '',
      searching: isSearchActive(),
      map: new Map(),
      forkArchiveBlocked: blocked,
    };
    return renderPass;
  }

  /**
   * @param {string} chatId
   * @returns {boolean}
   */
  function isChatForkArchiveBlocked(chatId) {
    if (renderPass?.forkArchiveBlocked) {
      return isForkArchiveBlocked(renderPass.forkArchiveBlocked, chatId);
    }
    const { blocked } = buildForkArchiveBlockedIds(getChats(), hasLiveHarnessWork);
    return isForkArchiveBlocked(blocked, chatId);
  }

  function endRenderPass() {
    renderPass = null;
    endSidebarChatRowPass();
    endSidebarSubchatGroupPass();
    endSidebarArchiveGroupPass();
    endSidebarWorkspacePass();
  }

  function sidebarChatRowDeps() {
    return {
      t,
      escapeHtml,
      resolveChatState,
      getTerminalStateMeta,
      getSidebarChatStateMeta: getTerminalStateMeta,
      canPinChatToUrl,
      resolveSidebarHarnessIcon,
      renderChatActionButtonsHtml,
    };
  }

  /**
   * Archive-split + tree + settled-grouping for a workspace, memoised for the
   * duration of one render/update pass. Outside a pass (e.g. a standalone
   * `renderSignature()` call from tests) it falls back to an uncached compute.
   *
   * @param {object} workspace
   * @returns {{ live: object[], archived: object[], grouped: object, tree: object[] }}
   */
  function workspaceModel(workspace) {
    const key = workspace.sidebarKey || workspace.workspaceFile || '';
    if (renderPass && renderPass.map.has(key)) return renderPass.map.get(key);
    const activeChatId = renderPass ? renderPass.activeChatId : (getActiveChatId() || '');
    const searching = renderPass ? renderPass.searching : isSearchActive();
    const model = buildWorkspaceChatTree(visibleChatsForWorkspace(workspace), activeChatId, searching);
    if (renderPass) renderPass.map.set(key, model);
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

  /**
   * @param {import('./sidebarSubchatGroups.js').SubchatGroupNode} group
   * @param {string} sidebarKey
   * @param {string} parentTitle
   * @returns {string}
   */
  function registerSubchatGroupEntry(group, sidebarKey, parentTitle, continuationLevels = []) {
    const parentId = String(group?.parentId || '').trim();
    if (!parentId) return;
    registerSidebarSubchatGroup(parentId, {
      group,
      sidebarKey,
      parentTitle,
      continuationLevels,
      deps: {
        t,
        escapeHtml,
        lang: getCurrentLang(),
        canArchive: typeof onArchiveSettled === 'function',
        canPin: canPinChatToUrl(),
      },
    });
  }

  /**
   * @param {string} parentId
   * @param {string[]} chatIds
   */
  async function archiveSettledGroup(parentId, chatIds) {
    const key = String(parentId || '').trim();
    const ids = [...new Set((Array.isArray(chatIds) ? chatIds : []).map((id) => String(id || '').trim()).filter(Boolean))];
    if (!key || !ids.length || typeof onArchiveSettled !== 'function') return;
    // A slow confirm + reload must not let a second click archive the same
    // group twice or race the reload.
    if (archivingGroupParents.has(key)) return;
    archivingGroupParents.add(key);
    try {
      let confirmed = false;
      try {
        confirmed = await onArchiveSettled(ids, { parentId: key });
      } catch (_) {
        confirmed = false;
      }
      if (confirmed === false) return;
      subchatExpanded.delete(key);
      writeSubchatExpandedSet(subchatExpanded);
      render();
    } finally {
      archivingGroupParents.delete(key);
    }
  }

  /**
   * Action buttons for a chat row, emitted as HTML so the single delegated
   * `.sidebar-body` listener can dispatch them by class. Previously these were
   * created with `document.createElement` + one listener pair per button inside
   * `wireBodyEvents()`, which ran on every rebuild.
   *
   * @param {object} chat
   * @param {{ archived?: boolean }} [opts]
   * @returns {string}
   */
  function renderChatActionButtonsHtml(chat, opts = {}) {
    const chatId = String(chat?.id || '');
    if (!chatId) return '';
    const archived = opts.archived === true;
    const showPin = canPinChatToUrl();
    const pieces = [];

    if (showPin) {
      const pinnedUrl = typeof chat?.widgetPinnedUrl === 'string' ? chat.widgetPinnedUrl.trim() : '';
      const isPinned = !!pinnedUrl;
      const title = isPinned ? t('sidebar.unpinChatFromUrl', { url: pinnedUrl }) : t('sidebar.pinChatToUrl');
      pieces.push(
        '<button type="button" class="sidebar-chat-action sidebar-chat-action-first sidebar-chat-pin-btn'
        + (isPinned ? ' sidebar-chat-pin-btn--active' : '')
        + '" title="' + escapeHtml(title)
        + '" aria-label="' + escapeHtml(title)
        + '" aria-pressed="' + (isPinned ? 'true' : 'false') + '">'
        + '<span class="mdi ' + (isPinned ? 'mdi-link-variant-off' : 'mdi-link-variant')
        + '" aria-hidden="true"></span>'
        + '</button>',
      );
    }

    const archiveBlocked = !archived && isChatForkArchiveBlocked(chatId);
    const archiveTitle = t(
      archived ? 'sidebar.restoreChat' : (archiveBlocked ? 'sidebar.archiveBusy' : 'sidebar.archiveChat'),
    );
    pieces.push(
      '<button type="button" class="sidebar-chat-action'
      + (showPin ? '' : ' sidebar-chat-action-first')
      + ' ' + (archived ? 'sidebar-chat-restore-btn' : 'sidebar-chat-archive-btn')
      + (archiveBlocked ? ' disabled' : '')
      + '" title="' + escapeHtml(archiveTitle)
      + '" aria-label="' + escapeHtml(archiveTitle) + '">'
      + '<span class="mdi '
      + (archived ? 'mdi-archive-arrow-up-outline' : 'mdi-archive-arrow-down-outline')
      + '" aria-hidden="true"></span>'
      + '</button>',
    );

    const favActive = chatFavorites.isFavorite(chatId);
    const favTitle = favActive ? t('sidebar.removeFavorite') : t('sidebar.addFavorite');
    pieces.push(
      '<button type="button" class="sidebar-chat-action sidebar-chat-fav-btn'
      + '" title="' + escapeHtml(favTitle)
      + '" aria-label="' + escapeHtml(favTitle)
      + '" aria-pressed="' + (favActive ? 'true' : 'false') + '">'
      + '<span class="mdi '
      + (favActive ? 'mdi-star sidebar-chat-fav-btn--active' : 'mdi-star-outline')
      + '" aria-hidden="true"></span>'
      + '</button>',
    );

    return pieces.join('');
  }

  function registerChatRowEntry(chat, activeChatId, opts = {}) {
    if (!chat?.id) return;
    registerSidebarChatRow(chat.id, {
      chat,
      activeChatId,
      opts,
      deps: sidebarChatRowDeps(),
    });
  }

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
      archiveTree: openSection ? archiveTree : [],
      deps: { t, escapeHtml },
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
        settledGroupsByParent.set(group.parentId, group);
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
    /** @type {import('./sidebarWorkspaceModel.js').SidebarListEntry[]} */
    const listEntries = [];
    if (serializeList && count) {
      for (const item of capped.items) {
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
      autopilotBadgeHtml: renderWorkspaceAutopilotBadgeHtml(workspace, preferredFolder, escapeHtml),
      listEntries,
      deps: { t, escapeHtml },
    });
    return !!sidebarKey;
  }

  /**
   * Small pill switch used by the Workspace section: one master gate in the
   * header and one per pinned workspace. Rendered as a real
   * `<button role="switch">` so the delegated sidebar click handler can dispatch
   * it by class like every other row control.
   *
   * @param {{ scope: 'all' | 'workspace', workspaceFolder?: string, checked: boolean, title: string }} input
   * @returns {string}
   */
  function renderWatcherToggleHtml(input) {
    const scope = input.scope === 'all' ? 'all' : 'workspace';
    const folder = String(input.workspaceFolder || '');
    const checked = input.checked === true;
    return (
      '<button type="button" class="sidebar-watcher-toggle" role="switch"' +
      ' aria-checked="' + (checked ? 'true' : 'false') + '"' +
      ' data-watcher-scope="' + escapeHtml(scope) + '"' +
      (folder ? ' data-workspace-folder="' + escapeHtml(folder) + '"' : '') +
      ' aria-label="' + escapeHtml(input.title) + '"' +
      ' title="' + escapeHtml(input.title) + '">' +
      '<span class="sidebar-watcher-toggle-knob" aria-hidden="true"></span>' +
      '</button>'
    );
  }

  /**
   * The dedicated "Workspace" section: one pinned watcher chat per workspace,
   * rendered outside the normal chat list. It is fed by the coalesced
   * `agentPresence` frame (no extra socket), so a newly materialized pinned chat
   * appears live. Each row (and the section header) carries a watcher toggle.
   *
   * @param {string} activeChatId
   * @returns {string}
   */
  /**
   * One row of the Workspace section. `pinnedChatId` is empty for a workspace
   * that has no pinned watcher chat yet (only reachable in "show all" mode); such
   * a row is a plain entry whose switch alone is interactive.
   */
  function renderPinnedWatcherRow(row) {
    const active = !!row.pinnedChatId && row.pinnedChatId === row.activeChatId;
    const toggleTitle = t('sidebar.watcherToggleRowTitle', {
      name: row.name,
      state: row.enabled ? row.stateOn : row.stateOff,
    }) + (row.gated ? ` ${t('sidebar.watcherToggleGated')}` : '');
    return (
      '<li class="sidebar-pinned-chat' + (active ? ' is-active' : '') +
      (row.pinnedChatId ? '' : ' sidebar-pinned-chat--no-chat') +
      '" role="option" aria-selected="' + (active ? 'true' : 'false') +
      (row.pinnedChatId ? '" data-pinned-chat-id="' + escapeHtml(row.pinnedChatId) : '') +
      '" tabindex="' + (active ? '0' : '-1') +
      '" title="' + escapeHtml(row.sub || row.name) + '">' +
      '<span class="mdi mdi-robot-outline sidebar-pinned-chat-icon" aria-hidden="true"></span>' +
      '<span class="sidebar-pinned-chat-main">' +
      '<span class="sidebar-pinned-chat-title">' + escapeHtml(row.name) + '</span>' +
      '<span class="sidebar-pinned-chat-sub">' + escapeHtml(row.sub) + '</span>' +
      '</span>' +
      (row.status
        ? '<span class="sidebar-pinned-chat-status">' + escapeHtml(row.status) + '</span>'
        : '') +
      renderWatcherToggleHtml({
        scope: 'workspace',
        workspaceFolder: row.folder,
        checked: row.enabled,
        title: toggleTitle,
      }) +
      '</li>'
    );
  }

  function renderPinnedWorkspaceSection(activeChatId) {
    const entries = listWorkspaceWatcherPinnedChats();
    const showAll = readWatcherShowAllFlag();
    if (!entries.length && !showAll) return '';
    const chats = getChats();
    const wsList = getWorkspaces();
    const nameFor = (folder) => {
      const norm = normalizePath(folder);
      const ws = wsList.find((workspace) => {
        const key = workspace.sidebarKey || workspace.workspaceFile || '';
        return normalizePath(getPreferredWorkspaceFolder(key)) === norm;
      }) || wsList.find((workspace) => normalizePath(workspace.workspaceFolder) === norm
        || normalizePath(workspace.workspaceDir) === norm);
      return ws?.name || String(folder).replace(/\\/g, '/').split('/').filter(Boolean).pop() || folder;
    };
    // Global start gate: off means every workspace's cycles/scout are blocked.
    const allOn = isWorkspaceWatcherStartsEnabled();
    const gated = !allOn && getWorkspaceWatcherRuntimeControl().known;
    const stateOn = t('sidebar.watcherToggleOn');
    const stateOff = t('sidebar.watcherToggleOff');
    const entryByFolder = new Map(
      entries.map((entry) => [normalizePath(entry.workspaceFolder), entry]),
    );
    const rows = [];
    if (showAll) {
      // One row per workspace group (clones included), so a watcher can be turned
      // on for a workspace that has never had one.
      const seenFolders = new Set();
      for (const workspace of wsList) {
        const sidebarKey = workspace.sidebarKey || workspace.workspaceFile || '';
        const folder = String(
          getPreferredWorkspaceFolder(sidebarKey)
          || workspace.workspaceFolder
          || workspace.workspaceDir
          || '',
        ).trim();
        if (!folder) continue;
        const norm = normalizePath(folder);
        if (seenFolders.has(norm)) continue;
        seenFolders.add(norm);
        const entry = entryByFolder.get(norm) || null;
        const chat = entry ? chats.find((item) => item.id === entry.pinnedChatId) : null;
        rows.push(renderPinnedWatcherRow({
          name: workspace.name || nameFor(folder),
          sub: chat?.title || folder,
          folder,
          pinnedChatId: entry?.pinnedChatId || '',
          enabled: !!resolveWorkspaceWatcherBadge(workspace, folder),
          status: entry?.stopReason || (entry?.paused ? t('sidebar.watcherAutopilotPaused') : ''),
          gated,
          activeChatId,
          stateOn,
          stateOff,
        }));
      }
    } else {
      // Without "show all" the section is the watcher list, so a workspace whose
      // watcher is off stays hidden — the list button reveals it again.
      for (const entry of listEnabledWorkspaceWatcherPinnedChats()) {
        const chat = chats.find((item) => item.id === entry.pinnedChatId);
        if (!chat) continue;
        rows.push(renderPinnedWatcherRow({
          name: nameFor(entry.workspaceFolder),
          sub: chat.title,
          folder: entry.workspaceFolder,
          pinnedChatId: entry.pinnedChatId,
          enabled: true,
          status: entry.stopReason || (entry.paused ? t('sidebar.watcherAutopilotPaused') : ''),
          gated,
          activeChatId,
          stateOn,
          stateOff,
        }));
      }
    }
    // Keep the header (and the list button) reachable while every watcher is
    // off, otherwise the disabled rows could never be shown again.
    if (!rows.length && !entries.length) return '';
    const allTitle = t('sidebar.watcherToggleAllTitle', {
      state: allOn ? stateOn : stateOff,
    });
    const showAllTitle = showAll ? t('sidebar.watcherShowAllHide') : t('sidebar.watcherShowAllShow');
    return (
      '<div class="sidebar-pinned-section' + (gated ? ' is-gated' : '') +
      '" aria-label="' +
      escapeHtml(t('sidebar.workspaceSection')) +
      '">' +
      '<div class="sidebar-pinned-section-header">' +
      '<span class="mdi mdi-robot-outline" aria-hidden="true"></span>' +
      escapeHtml(t('sidebar.workspaceSection')) +
      '<button type="button" class="sidebar-watcher-show-all' + (showAll ? ' is-active' : '') +
      '" aria-pressed="' + (showAll ? 'true' : 'false') +
      '" data-watcher-show-all aria-label="' +
      escapeHtml(showAllTitle) +
      '" title="' +
      escapeHtml(showAllTitle) +
      '">' +
      '<span class="mdi mdi-format-list-bulleted" aria-hidden="true"></span>' +
      '</button>' +
      renderWatcherToggleHtml({ scope: 'all', checked: allOn, title: allTitle }) +
      '</div>' +
      '<ul class="sidebar-pinned-chats" role="listbox">' +
      (rows.length
        ? rows.join('')
        : !showAll
          ? '<li class="sidebar-pinned-empty">' +
            escapeHtml(t('sidebar.watcherNoneEnabled')) +
            '</li>'
          : '') +
      '</ul>' +
      '</div>'
    );
  }

  /**
   * The chat ids the list currently renders (per-workspace cap + open archive
   * sections). Reused by the structural signature so membership changes — and
   * only membership changes — drive a rebuild. Reads the memoised per-pass tree.
   *
   * @returns {Set<string>}
   */
  function collectRenderableChatIds() {
    const ids = new Set();
    const searching = isSearchActive();
    const activeChatId = renderPass ? renderPass.activeChatId : getActiveChatId();
    if (activeChatId) ids.add(activeChatId);
    for (const workspace of getWorkspaces()) {
      const sidebarKey = workspace.sidebarKey || workspace.workspaceFile || '';
      const isCollapsed = !searching && isWorkspaceCollapsed(sidebarKey);
      if (!shouldSerializeWorkspaceChatList(isCollapsed, searching)) continue;
      const { archived, grouped } = workspaceModel(workspace);
      const capped = capSidebarVisibleTreeChats(grouped.items, {
        limit: SIDEBAR_VISIBLE_CHAT_LIMIT,
        activeChatId,
        showAll: searching || showAllChatsBySidebarKey.has(sidebarKey),
      });
      for (const item of capped.items) {
        if (item?.chat?.id) ids.add(item.chat.id);
      }
      if (searching || isArchiveSectionOpen(sidebarKey)) {
        const archiveTree = flattenChatsTree(archived);
        const virtualWindow = resolveArchiveVirtualWindowForPass(sidebarKey, archiveTree);
        for (const id of archiveWindowChatIds(virtualWindow, archiveTree)) {
          ids.add(id);
        }
      }
    }
    return ids;
  }

  /**
   * Membership-only signature of the settled-subchat groups: the folded child id
   * set per parent. A status change that keeps the same members (e.g. completed →
   * interrupted) must NOT rebuild — the summary is repainted in place by
   * `patchTransientVisualStates`. Only a child entering/leaving the folded set
   * changes this string and forces a rebuild.
   *
   * @returns {string}
   */
  function collectSubchatGroupSignature() {
    const parts = [];
    const searching = isSearchActive();
    for (const workspace of getWorkspaces()) {
      const sidebarKey = workspace.sidebarKey || workspace.workspaceFile || '';
      const isCollapsed = !searching && isWorkspaceCollapsed(sidebarKey);
      if (!shouldSerializeWorkspaceChatList(isCollapsed, searching)) continue;
      const { grouped } = workspaceModel(workspace);
      for (const group of grouped.groups) {
        const childIds = Array.isArray(group.childIds)
          ? [...group.childIds].sort().join(',')
          : '';
        parts.push(sidebarKey + ':' + group.parentId + ':' + childIds);
      }
    }
    return parts.join('|');
  }

  /**
   * Per-workspace structural signature: everything that changes the rendered
   * `<li class="sidebar-workspace">` subtree — name, clone marker, active /
   * collapsed state, chat titles / order / favorites / pins, capped membership,
   * settled-group membership and archive-section state. Transient visuals (row
   * status tone, active row class, group summary text) are intentionally
   * excluded because they are patched in place. The render pass shares these
   * strings with the per-group rebuild so a change in one workspace does not
   * recreate the other `<li>` nodes.
   *
   * @param {object} workspace
   * @param {string} activeChatId
   * @param {boolean} searching
   * @returns {string}
   */
  function computeWorkspaceStructureSignature(workspace, activeChatId, searching) {
    const sidebarKey = workspace.sidebarKey || workspace.workspaceFile || '';
    const preferredFolder = getPreferredWorkspaceFolder(sidebarKey);
    const isActive =
      normalizePath(workspace.workspaceFile) === normalizePath(getActiveWorkspaceFile()) &&
      normalizePath(preferredFolder) === normalizePath(getActiveWorkspaceFolder());
    const isCollapsed = !searching && isWorkspaceCollapsed(sidebarKey);
    const { live, grouped } = workspaceModel(workspace);
    const serializeList = shouldSerializeWorkspaceChatList(isCollapsed, searching);
    const capped = serializeList
      ? capSidebarVisibleTreeChats(grouped.items, {
        limit: SIDEBAR_VISIBLE_CHAT_LIMIT,
        activeChatId,
        showAll: searching || showAllChatsBySidebarKey.has(sidebarKey),
      })
      : { items: [], hidden: 0 };
    const rows = serializeList
      ? capped.items
        .map((item) => (item?.isGroup
          ? 'g:' + item.parentId + ':' + (item.childIds || []).join(',')
          : 'c:' + (item.chat?.id || '')))
        .join(',')
      : '';
    const groups = serializeList
      ? grouped.groups
        .map((group) => group.parentId + ':' + [...(group.childIds || [])].sort().join(','))
        .join(',')
      : '';
    return [
      workspace.name || '',
      workspace.workspaceFile || '',
      workspace.isClone ? '1' : '0',
      isActive ? 'A' : '',
      isCollapsed ? 'C' : 'O',
      serializeList ? 'S' : 'H',
      searching ? 'Q' : '',
      showAllChatsBySidebarKey.has(sidebarKey) ? '1' : '0',
      isArchiveSectionOpen(sidebarKey) ? '1' : '0',
      live
        .map((c) =>
          [
            c.id,
            c.title,
            chatFavorites.isFavorite(c.id) ? '1' : '0',
            c.forkParentChatId || '',
            c.todoId ? 'D' : '',
            c.widgetPinnedUrl || '',
          ].join(':'),
        )
        .join(','),
      String(archivedCountForWorkspace(workspace)),
      rows,
      groups,
    ].join('#');
  }

  /**
   * @param {{ layout?: string, structure?: string, status?: string, group?: string, watcher?: string }} [partsOut]
   *   Optional out-param populated with the NAMED signature segments so the trace
   *   diff never has to slice the joined string on '||' (segment values can
   *   themselves contain '||'). `status` is intentionally left unset: per-row tone
   *   / active marker no longer affect the structural signature (they are applied
   *   by a targeted row patch), so status-only frames short-circuit here.
   * @returns {string}
   */
  function renderSignature(partsOut) {
    const ownsPass = !renderPass;
    if (ownsPass) beginRenderPass();
    try {
      const wsList = getWorkspaces();
      const activeWs = normalizePath(getActiveWorkspaceFile());
      const collapsedKey = [...collapsed].sort().join('|');
      const visibleIds = collectRenderableChatIds();
      const groupSig = collectSubchatGroupSignature();
      const structureSig = wsList
        .map((workspace) => {
          const sidebarKey = workspace.sidebarKey || workspace.workspaceFile || '';
          const { live } = workspaceModel(workspace);
          return [
            sidebarKey,
            workspace.name || '',
            workspace.isClone ? '1' : '0',
            isWorkspaceCollapsed(sidebarKey) ? 'C' : 'O',
            live
              .map((c) =>
                [
                  c.id,
                  c.title,
                  chatFavorites.isFavorite(c.id) ? '1' : '0',
                  c.forkParentChatId || '',
                  c.todoId ? 'D' : '',
                  c.widgetPinnedUrl || '',
                ].join(':'),
              )
              .join(','),
            String(archivedCountForWorkspace(workspace)),
          ].join('#');
        })
        .join('||');
      const membershipSig = [...visibleIds].sort().join(',');
      const layoutSig =
        String(open) +
        '||' +
        String(pinned) +
        '||' +
        activeWs +
        '||' +
        String(searchQuery || '') +
        '||' +
        collapsedKey +
        '||' +
        [...showAllChatsBySidebarKey].sort().join('|') +
        '||' +
        [...archiveOpen].sort().join('|') +
        '||' +
        [...subchatExpanded].sort().join('|') +
        '||' +
        readWorkspaceOrder().join('\n') +
        '||' +
        readChatOrder().join('\n') +
        '||' +
        (readPinActiveWorkspaceFlag() ? '1' : '0') +
        '||' +
        (readWatcherShowAllFlag() ? '1' : '0');
      const watcherSig = String(workspaceWatcherPresenceRevision());
      // The master start gate is server-wide state, not part of the presence
      // frame, so its revision is tracked separately to repaint the header switch.
      const runtimeSig = String(workspaceWatcherRuntimeRevision());
      if (partsOut) {
        partsOut.layout = layoutSig;
        partsOut.structure = structureSig + '\n' + membershipSig;
        partsOut.group = groupSig;
        partsOut.watcher = watcherSig;
        partsOut.runtime = runtimeSig;
      }
      return (
        layoutSig +
        '||' +
        structureSig +
        '||' +
        membershipSig +
        '||' +
        groupSig +
        '||' +
        watcherSig +
        '||' +
        runtimeSig
      );
    } finally {
      if (ownsPass) endRenderPass();
    }
  }

  /**
   * When the top-level structural signature is unchanged, reconcile skips DOM
   * rebuild but Lit workspace/row hosts still need fresh pass registrations.
   * @param {Element} body
   */
  function refreshLitWorkspaceHostsOnSignatureMatch(body) {
    const ul = body.querySelector('.sidebar-workspaces');
    if (!ul) return;
    const wsList = getWorkspaces();
    if (!wsList.length) return;
    const activeWorkspaceFile = getActiveWorkspaceFile();
    const activeWorkspaceFolder = getActiveWorkspaceFolder();
    const activeChatId = getActiveChatId();
    const ordered = sortSidebarWorkspaces(wsList, {
      pinActiveOnTop: readPinActiveWorkspaceFlag(),
      activeWorkspaceFile,
      activeWorkspaceFolder,
      getPreferredWorkspaceFolder,
      locale: getCurrentLang(),
      order: readWorkspaceOrder(),
    });
    const searching = isSearchActive();
    setRenderedSidebarChatIds(collectRenderableChatIds());
    settledGroupsByParent = new Map();
    const chatsByKey = new Map();
    for (const workspace of ordered) {
      const sidebarKey = workspace.sidebarKey || workspace.workspaceFile || '';
      chatsByKey.set(sidebarKey, visibleChatsForWorkspace(workspace));
      const { grouped } = workspaceModel(workspace);
      for (const group of grouped.groups) settledGroupsByParent.set(group.parentId, group);
    }
    const visibleWorkspaces = ordered.filter((workspace) => {
      const sidebarKey = workspace.sidebarKey || workspace.workspaceFile || '';
      return !(searching && (chatsByKey.get(sidebarKey) || []).length === 0);
    });
    const renderedIds = new Set();
    for (const workspace of visibleWorkspaces) {
      const sidebarKey = workspace.sidebarKey || workspace.workspaceFile || '';
      registerWorkspaceGroupEntry(
        workspace,
        activeWorkspaceFile,
        activeWorkspaceFolder,
        activeChatId,
        chatsByKey.get(sidebarKey) || [],
        renderedIds,
      );
    }
    // Registrations refreshed above; row status is patched via the status bus, not
    // by re-rendering Lit hosts (unsafeHTML would replace `<li>` nodes).
  }

  /**
   * In-place repaint of the visuals that deliberately live OUTSIDE the structural
   * signature: the active-chat class/ARIA, the settled-subchat group summary, and
   * the collapsed parent badge. Reads the memoised per-pass tree, so calling this
   * on a signature-skip costs one bounded DOM walk — no innerHTML rebuild.
   * Runs inside a render pass (`renderPass` is set).
   */
  function patchTransientVisualStates() {
    const aside = getContainer();
    if (!aside || aside.hidden) return;
    const body = aside.querySelector('.sidebar-body');
    if (!body) return;
    const activeChatId = renderPass ? renderPass.activeChatId : getActiveChatId();

    body.querySelectorAll('.sidebar-chat-item').forEach((el) => {
      const id = el.dataset?.chatId || '';
      const active = !!id && id === activeChatId;
      el.classList?.toggle('is-active', active);
      el.setAttribute?.('aria-selected', active ? 'true' : 'false');
    });
    body.querySelectorAll('.sidebar-pinned-chat').forEach((el) => {
      const id = el.dataset?.pinnedChatId || '';
      const active = !!id && id === activeChatId;
      el.classList?.toggle('is-active', active);
      el.setAttribute?.('aria-selected', active ? 'true' : 'false');
    });

    // Settled-group summaries only repaint when a group is actually on screen.
    const groupEls = body.querySelectorAll('.sidebar-subchat-group');
    if (!groupEls || !groupEls.length) return;
    const groupByKey = new Map();
    const badgeByKey = new Map();
    for (const workspace of getWorkspaces()) {
      const sidebarKey = workspace.sidebarKey || workspace.workspaceFile || '';
      const { grouped } = workspaceModel(workspace);
      for (const group of grouped.groups) {
        const key = sidebarKey + '\u0000' + group.parentId;
        groupByKey.set(key, group);
        if (group.expanded !== true) {
          badgeByKey.set(sidebarKey + '\u0000' + group.parentId, formatSubchatParentBadge(group.summary, t));
        }
      }
    }

    groupEls.forEach((el) => {
      const sidebarKey = el.getAttribute('data-sidebar-key') || '';
      const parentId = el.getAttribute('data-parent-id') || '';
      const group = groupByKey.get(sidebarKey + '\u0000' + parentId);
      if (!group) return;
      const summaryLabel = formatSubchatSummary(group.summary);
      if ((el.getAttribute('data-group-summary') || '') === summaryLabel) return;
      el.setAttribute('data-group-summary', summaryLabel);
      const summaryEl = el.querySelector('.sidebar-subchat-group-summary');
      const summaryTitle = summaryLabel ? t('sidebar.subchatSummary', { summary: summaryLabel }) : '';
      if (summaryEl) {
        summaryEl.textContent = summaryLabel;
        if (summaryTitle) summaryEl.setAttribute('title', summaryTitle);
        summaryEl.toggleAttribute?.('hidden', !summaryLabel);
      }
      const toggleEl = el.querySelector('.sidebar-subchat-group-toggle');
      if (toggleEl && summaryTitle) toggleEl.setAttribute('aria-description', summaryTitle);
    });

    badgeByKey.forEach((badge, key) => {
      if (!badge) return;
      const parentId = key.split('\u0000')[1];
      const row = body.querySelector(`.sidebar-chat-item[data-chat-id="${cssEscape(parentId)}"]`);
      if (!row) return;
      const badgeEl = row.querySelector('.sidebar-chat-item-subchat-summary');
      if (!badgeEl) return;
      if ((badgeEl.getAttribute('data-summary-label') || '') === badge.label) return;
      badgeEl.setAttribute('data-summary-label', badge.label);
      badgeEl.textContent = badge.label;
      badgeEl.setAttribute('title', badge.title);
      badgeEl.setAttribute('aria-label', badge.title);
    });
  }

  function render() {
    const aside = getContainer();
    if (!aside) return;
    // Never rebuild the DOM mid-gesture — a live drag node would detach, and
    // a swipe follows an inline transform on this aside. Coalesce a deferred
    // render onto the next animation frame once the gesture releases; otherwise
    // a change that arrived mid-drag would be dropped and the DOM left stale.
    if (workspaceDrag.isDragging() || chatDrag.isDragging() || swipe.isSwiping()) {
      updateScheduler.schedule();
      return;
    }
    const body = aside.querySelector('.sidebar-body');
    if (!body) return;
    // The whole pass shares one workspace-tree computation (see workspaceModel).
    beginRenderPass();
    try {
      renderPassBody(body);
    } finally {
      endRenderPass();
    }
    // Task 0.1: the mounted row count after the pass (viewport-limited once the
    // archive is virtualized). No-op while diagnostics are off.
    getUiFreezeCounters()?.recordMountedRows(getRenderedSidebarChatIds().size);
  }

  /**
   * The rebuild branch of a render, run inside a `renderPass`. All measurement is
   * opt-in through the uiFreeze trace flag (default off) and guarded at the
   * callsite so production does zero extra work — this never changes what is
   * rendered, only the signature/short-circuit it compares against.
   * @param {Element} body
   */
  function renderPassBody(body) {
    const trace = isUiFreezeTraceActive();
    const metrics = trace ? getUiFreezeMetrics() : null;
    const sigParts = trace ? {} : null;
    const sigStart = trace ? monoNow() : 0;
    const sig = renderSignature(sigParts);
    const sigMs = trace ? monoNow() - sigStart : 0;
    if (sig === lastRenderSignature) {
      // Structural signature unchanged: skip reconcile/innerHTML, but Lit hosts
      // still own row/workspace payloads — refresh registrations and push updates.
      refreshLitWorkspaceHostsOnSignatureMatch(body);
      // Repaint visuals outside the signature (active chat, group summaries, badges).
      patchTransientVisualStates();
      if (trace) lastRenderSigParts = sigParts;
      if (metrics) {
        metrics.recordSidebarRender({
          changed: false,
          changedSegments: [],
          sigMs,
          rows: getRenderedSidebarChatIds().size,
          rebuilt: false,
        });
      }
      return;
    }
    // Segments are diffed ONLY on a real rebuild, against the parts that produced
    // lastRenderSignature (null on the first measured rebuild → all-segment baseline).
    let changedSegments = null;
    if (trace) {
      changedSegments = diffSignatureSegments(lastRenderSigParts, sigParts);
      lastRenderSigParts = sigParts;
    }
    lastRenderSignature = sig;

    const wsList = getWorkspaces();
    const activeWorkspaceFile = getActiveWorkspaceFile();
    const activeWorkspaceFolder = getActiveWorkspaceFolder();
    const activeChatId = getActiveChatId();

    if (!wsList.length) {
      renderedWorkspaceNodes.clear();
      lastPinnedSectionHtml = '';
      const innerStart = trace ? monoNow() : 0;
      body.innerHTML =
        '<div class="sidebar-empty">' +
        '<p class="sidebar-empty-hint">' + escapeHtml(t('workspace.emptyHint')) + '</p>' +
        '<cr-bar-button class="sidebar-empty-add" variant="primary">' +
        escapeHtml(t('workspace.emptyAction')) +
        '</cr-bar-button>' +
        '</div>';
      if (metrics) {
        metrics.recordSidebarRender({
          changed: true,
          changedSegments,
          sigMs,
          innerMs: monoNow() - innerStart,
          rows: 0,
          rebuilt: true,
        });
      }
      body.querySelector('.sidebar-empty-add')?.addEventListener('click', () => {
        openWorkspaceSettings();
      });
      return;
    }

    const ordered = sortSidebarWorkspaces(wsList, {
      pinActiveOnTop: readPinActiveWorkspaceFlag(),
      activeWorkspaceFile,
      activeWorkspaceFolder,
      getPreferredWorkspaceFolder,
      locale: getCurrentLang(),
      order: readWorkspaceOrder(),
    });

    const searching = isSearchActive();
    const focusInfo = captureSidebarFocusInfo(body);
    const scrollTop = typeof body.scrollTop === 'number' ? body.scrollTop : 0;

    // The rendered-id set and the settled groups must stay correct even for the
    // workspaces whose `<li>` node is reused, so they are derived from the shared
    // render pass instead of being accumulated while building HTML.
    setRenderedSidebarChatIds(collectRenderableChatIds());
    settledGroupsByParent = new Map();
    const structureByKey = new Map();
    const chatsByKey = new Map();
    for (const workspace of ordered) {
      const sidebarKey = workspace.sidebarKey || workspace.workspaceFile || '';
      chatsByKey.set(sidebarKey, visibleChatsForWorkspace(workspace));
      const { grouped } = workspaceModel(workspace);
      for (const group of grouped.groups) settledGroupsByParent.set(group.parentId, group);
      // Per-workspace signatures are only needed on a rebuild (this branch), so
      // the signature-only skip in renderSignature() stays cheap.
      structureByKey.set(
        sidebarKey,
        computeWorkspaceStructureSignature(workspace, activeChatId, searching),
      );
    }
    const visibleWorkspaces = ordered.filter((workspace) => {
      const sidebarKey = workspace.sidebarKey || workspace.workspaceFile || '';
      return !(searching && (chatsByKey.get(sidebarKey) || []).length === 0);
    });

    if (!visibleWorkspaces.length) {
      renderedWorkspaceNodes.clear();
      lastPinnedSectionHtml = '';
      const innerStart = trace ? monoNow() : 0;
      body.innerHTML =
        '<div class="sidebar-empty">' + escapeHtml(t('sidebar.noSearchResults')) + '</div>';
      if (metrics) {
        metrics.recordSidebarRender({
          changed: true,
          changedSegments,
          sigMs,
          innerMs: monoNow() - innerStart,
          rows: 0,
          rebuilt: true,
        });
      }
      return;
    }

    const innerStart = trace ? monoNow() : 0;
    reconcileWorkspaceNodes(body, visibleWorkspaces, {
      activeWorkspaceFile,
      activeWorkspaceFolder,
      activeChatId,
      structureByKey,
      chatsByKey,
    });
    applyPinnedSection(body, activeChatId);
    const innerMs = trace ? monoNow() - innerStart : 0;
    const wireStart = trace ? monoNow() : 0;
    wireBodyEvents();
    ensureChatListRovingTabindex(body);
    scheduleSidebarFocusAndScrollRestore(body, focusInfo, scrollTop);
    if (metrics) {
      metrics.recordSidebarRender({
        changed: true,
        changedSegments,
        sigMs,
        innerMs,
        wireMs: monoNow() - wireStart,
        rows: getRenderedSidebarChatIds().size,
        rebuilt: true,
      });
    }
  }

  /**
   * Parse a single workspace `<li>` (or pinned section) out of an HTML string.
   * @param {string} html
   * @returns {Element|null}
   */
  function buildSidebarNode(html) {
    const template = document.createElement('template');
    template.innerHTML = String(html || '').trim();
    return template.content.firstElementChild;
  }

  /**
   * Reuses unchanged workspace `<li>` nodes and swaps only the ones whose
   * per-workspace structure signature changed, then reorders/removes the rest.
   * The `<ul>` itself is never recreated, so delegated listeners and scroll
   * position survive a partial rebuild.
   */
  function reconcileWorkspaceNodes(body, visibleWorkspaces, opts) {
    let ul = body.querySelector('.sidebar-workspaces');
    if (!ul) {
      body.innerHTML = '<ul class="sidebar-workspaces" role="listbox"></ul>';
      ul = body.querySelector('.sidebar-workspaces');
      renderedWorkspaceNodes.clear();
    }
    // A forced render drops the reuse map so every row can be regenerated (for
    // example after a language change). The existing list stays mounted to keep
    // scroll and listeners stable, so remove any rows no longer owned by that
    // map before inserting their replacements. This also repairs stale DOM after
    // a hot module reload resets the closure while preserving the sidebar shell.
    const trackedNodes = new Set(
      [...renderedWorkspaceNodes.values()].map((entry) => entry.node).filter(Boolean),
    );
    for (const child of Array.from(ul.children)) {
      if (!trackedNodes.has(child)) child.remove();
    }
    const orderedKeys = visibleWorkspaces.map(
      (workspace) => workspace.sidebarKey || workspace.workspaceFile || '',
    );
    const previousSigs = new Map();
    for (const [key, entry] of renderedWorkspaceNodes) previousSigs.set(key, entry.sig);
    const plan = planWorkspaceRebuild(previousSigs, orderedKeys, opts.structureByKey);

    visibleWorkspaces.forEach((workspace, index) => {
      const sidebarKey = workspace.sidebarKey || workspace.workspaceFile || '';
      const sig = opts.structureByKey.get(sidebarKey) || '';
      let entry = renderedWorkspaceNodes.get(sidebarKey);
      const mustRebuild = !plan.reuseKeys.has(sidebarKey) || !entry || !entry.node
        || entry.node.parentNode !== ul;
      if (mustRebuild) {
        const registered = registerWorkspaceGroupEntry(
          workspace,
          opts.activeWorkspaceFile,
          opts.activeWorkspaceFolder,
          opts.activeChatId,
          opts.chatsByKey.get(sidebarKey) || [],
          new Set(),
        );
        if (!registered) {
          if (entry?.node?.parentNode) entry.node.remove();
          renderedWorkspaceNodes.delete(sidebarKey);
          return;
        }
        const existingHost = entry?.node;
        const canUpdateInPlace = existingHost instanceof HTMLElement
          && existingHost.localName === 'cr-sidebar-workspace'
          && existingHost.getAttribute('sidebar-key') === sidebarKey;
        let node;
        if (canUpdateInPlace) {
          node = existingHost;
          requestSidebarWorkspaceUpdate(node);
        } else {
          node = createSidebarWorkspaceHostElement(sidebarKey);
          if (!node) return;
          hydrateSidebarWorkspaceHosts(node);
          if (entry?.node?.parentNode) entry.node.replaceWith(node);
        }
        entry = { sig, node };
        renderedWorkspaceNodes.set(sidebarKey, entry);
      } else {
        entry.sig = sig;
      }
      const target = ul.children[index] || null;
      if (target !== entry.node) ul.insertBefore(entry.node, target);
    });
    for (const key of plan.removeKeys) {
      renderedWorkspaceNodes.get(key)?.node?.remove();
      renderedWorkspaceNodes.delete(key);
    }
  }

  /** Rebuild the (small) pinned watcher section only when its HTML changed. */
  function applyPinnedSection(body, activeChatId) {
    const html = renderPinnedWorkspaceSection(activeChatId);
    const existing = body.querySelector('.sidebar-pinned-section');
    if (!html) {
      if (existing) existing.remove();
      lastPinnedSectionHtml = '';
      return;
    }
    if (existing && lastPinnedSectionHtml === html) return;
    const node = buildSidebarNode(html);
    if (!node) return;
    if (existing) existing.replaceWith(node);
    else body.insertBefore(node, body.firstChild);
    lastPinnedSectionHtml = html;
  }

  /**
   * Re-focus after Lit commits (unsafeHTML runs in a microtask).
   *
   * @param {Element} body
   * @param {ReturnType<typeof captureSidebarFocusInfo>} info
   * @param {number} scrollTop
   */
  function scheduleSidebarFocusAndScrollRestore(body, info, scrollTop) {
    if (!info && !(typeof scrollTop === 'number' && scrollTop > 0)) return;
    void (async () => {
      await waitForSidebarLitHostsCommit(body);
      if (typeof body.scrollTop === 'number' && body.scrollTop !== scrollTop) {
        body.scrollTop = scrollTop;
      }
      restoreSidebarFocus(body, info);
    })();
  }

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
    if (!pinned || isMobileViewport()) closeSidebar();
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
      selectChat(chatId);
      closeSidebarAfterMobileAction();
    };
    if (!target) {
      finish();
      return;
    }
    switchWorkspace(target.workspaceFile, target.workspaceFolder).then((ok) => {
      if (ok) render();
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
      Promise.resolve(requestLoadArchivedChats()).catch(() => {});
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
    const group = settledGroupsByParent.get(parentId);
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
    }
  }

  function selectChatRow(el) {
    const chatId = el?.dataset?.chatId || '';
    if (!chatId) return;
    const chat = getChats().find((item) => item.id === chatId);
    if (!chat) return;
    activateChatPanelTab();

    const finishSelect = () => {
      selectChat(chatId);
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
   * @param {Element} btn
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

  /**
   * One keydown listener on `.sidebar-body`: roving focus for the chat lists and
   * Enter/Space activation for the non-button rows. Real `<button>` elements are
   * left to the browser's native activation so a keypress never fires twice.
   */
  function onSidebarBodyKeydown(ev) {
    const target = ev.target instanceof Element ? ev.target : null;
    if (!target) return;
    if (target.closest('button, .sidebar-chat-action')) return;

    const body = target.closest('.sidebar-body');
    if (body && handleSidebarArchiveKeydown(ev, body)) return;

    const chatItem = target.closest('.sidebar-chat-item');
    if (chatItem) {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        chatItem.click();
        return;
      }
      const list = chatItem.closest('.sidebar-chat-list');
      if (!list) return;
      const items = Array.from(list.querySelectorAll('.sidebar-chat-item:not(.is-subchat-hidden)'))
        .filter((el) => !el.closest('[hidden]') && el.hidden !== true);
      const index = items.indexOf(chatItem);
      if (index < 0) return;
      const nextIndex = resolveNextItemIndex(ev.key, index, items.length);
      if (nextIndex === null) return;
      ev.preventDefault();
      items.forEach((el) => el.setAttribute('tabindex', '-1'));
      items[nextIndex].setAttribute('tabindex', '0');
      items[nextIndex].focus();
      return;
    }

    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    const row = target.closest(
      '.sidebar-pinned-chat, .sidebar-workspace-header, .sidebar-archive-header, .sidebar-chat-more',
    );
    if (!row) return;
    ev.preventDefault();
    row.click();
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

  /**
   * Roving-tabindex fallback: with no active chat nothing in a list would be
   * reachable with Tab. Runs after a rebuild, so it only walks the fresh rows.
   * @param {Element} body
   */
  function ensureChatListRovingTabindex(body) {
    body.querySelectorAll('.sidebar-chat-list').forEach((list) => {
      const readItems = () =>
        Array.from(list.querySelectorAll('.sidebar-chat-item:not(.is-subchat-hidden)'))
          .filter((el) => !el.closest('[hidden]') && el.hidden !== true);
      const initial = readItems();
      if (initial.length && !initial.some((el) => el.getAttribute('tabindex') === '0')) {
        initial[0].setAttribute('tabindex', '0');
      }
    });
    body.querySelectorAll('.sidebar-archive-list').forEach((list) => {
      const items = Array.from(list.querySelectorAll('.sidebar-chat-item'))
        .filter((el) => !el.closest('[hidden]') && el.hidden !== true);
      if (!items.length) return;
      if (!items.some((el) => el.getAttribute('tabindex') === '0')) {
        items[0].setAttribute('tabindex', '0');
      }
    });
  }

  /**
   * Index to move the roving focus to, or null when the key is not a
   * navigation key.
   * @param {string} key
   * @param {number} index
   * @param {number} count
   * @returns {number|null}
   */
  function resolveNextItemIndex(key, index, count) {
    if (key === 'ArrowDown') return (index + 1) % count;
    if (key === 'ArrowUp') return (index - 1 + count) % count;
    if (key === 'Home') return 0;
    if (key === 'End') return count - 1;
    return null;
  }

  /**
   * Keyboard support for the chat listboxes (arrows, Home/End, Enter/Space) now
   * lives in the delegated `onSidebarBodyKeydown`; only the pure index helper is
   * kept here (it is pinned by tests/sidebar-keyboard-nav.test.js).
   */

  function initMenuButton() {
    const menuBtn = document.getElementById('header-menu-btn');
    if (menuBtn) {
      menuBtn.addEventListener('click', toggleSidebar);
      menuBtn.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        toggleSidebar();
      });
    }
    const pinBtn = document.getElementById('sidebar-pin-btn');
    if (pinBtn) pinBtn.addEventListener('click', togglePin);
    const closeBtn = document.getElementById('sidebar-close-btn');
    if (closeBtn) closeBtn.addEventListener('click', closeSidebar);
    const backdrop = getBackdrop();
    if (backdrop) backdrop.addEventListener('click', closeSidebar);
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !open) return;
      const blockingModal = document.querySelector('.chat-settings-modal:not([hidden])');
      if (blockingModal) return;
      if (isSearchFocused() && isSearchActive()) {
        e.preventDefault();
        setSearchQuery('');
        forceRerender();
        return;
      }
      closeSidebar();
    });
  }

  function initSearchInput() {
    const el = getSearchInput();
    if (!el) return;
    el.addEventListener('input', () => {
      setSearchQuery(typeof el.value === 'string' ? el.value : '');
      forceRerender();
    });
  }

  function initResizer() {
    const resizer = document.getElementById('sidebar-resizer');
    const aside = getContainer();
    if (!resizer || !aside || typeof PointerEvent === 'undefined') return;
    let dragging = false;
    let startX = 0;
    let startWidth = 0;

    const applyWidth = (width) => {
      const clamped = clampToViewport(width);
      aside.style.setProperty('--sidebar-width', `${clamped}px`);
      return clamped;
    };

    const syncAria = (width) => {
      const vw = getViewportWidth();
      resizer.setAttribute('aria-valuemin', String(clampSidebarWidth(0, vw)));
      resizer.setAttribute('aria-valuemax', String(clampSidebarWidth(Number.MAX_SAFE_INTEGER, vw)));
      resizer.setAttribute('aria-valuenow', String(clampToViewport(width)));
    };

    const onPointerDown = (ev) => {
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      ev.preventDefault();
      dragging = true;
      startX = ev.clientX;
      startWidth = aside.getBoundingClientRect().width;
      document.body.classList.add('sidebar-resizing');
      resizer.classList.add('is-active');
      resizer.setPointerCapture?.(ev.pointerId);
    };

    const onPointerMove = (ev) => {
      if (!dragging) return;
      // Right-edge handle: dragging right grows the left-anchored drawer.
      const next = applyWidth(startWidth + (ev.clientX - startX));
      syncAria(next);
      applyDockLayout();
    };

    const onPointerEnd = (ev) => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove('sidebar-resizing');
      resizer.classList.remove('is-active');
      if (resizer.hasPointerCapture?.(ev.pointerId)) {
        resizer.releasePointerCapture(ev.pointerId);
      }
      const finalWidth = parseFloat(aside.style.getPropertyValue('--sidebar-width'));
      if (!Number.isFinite(finalWidth) || finalWidth <= 0) return;
      syncAria(finalWidth);
      writeSidebarWidth(finalWidth);
      applyDockLayout();
    };

    const onKeyDown = (ev) => {
      const base = aside.getBoundingClientRect().width || SIDEBAR_MIN_WIDTH;
      let next;
      if (ev.key === 'ArrowRight') next = base + SIDEBAR_RESIZE_STEP;
      else if (ev.key === 'ArrowLeft') next = base - SIDEBAR_RESIZE_STEP;
      else if (ev.key === 'Home') next = 0;
      else if (ev.key === 'End') next = Number.MAX_SAFE_INTEGER;
      else return;
      ev.preventDefault();
      const applied = applyWidth(next);
      syncAria(applied);
      writeSidebarWidth(applied);
      applyDockLayout();
    };

    resizer.addEventListener('pointerdown', onPointerDown);
    resizer.addEventListener('pointermove', onPointerMove);
    resizer.addEventListener('pointerup', onPointerEnd);
    resizer.addEventListener('pointercancel', onPointerEnd);
    resizer.addEventListener('keydown', onKeyDown);
    syncAria(aside.getBoundingClientRect().width);
  }

  function initPinActiveWorkspaceSetting() {
    const checkbox = document.getElementById('sidebar-pin-active-workspace-checkbox');
    if (!checkbox) return;
    checkbox.checked = readPinActiveWorkspaceFlag();
    checkbox.addEventListener('change', () => {
      writePinActiveWorkspaceFlag(!!checkbox.checked);
      forceRerender();
    });
  }

  function initChatDrag() {
    const body = getContainer()?.querySelector('.sidebar-body');
    if (!body) return;
    chatDrag = initSidebarChatDrag({
      body,
      isEnabled: () => !isSearchActive() && !workspaceDrag.isDragging(),
      // Even a no-op drag (press-and-hold that never reordered) deferred
      // renders while it ran; flush the backlog once it releases.
      onSettled: () => afterSidebarGestureSettled(),
      onDrop: ({ orderedIds, draggedId, parentChatId }) => {
        const previousOrder = readChatOrder();
        writeChatOrderForList(orderedIds);
        const nextOrder = readChatOrder();
        if (previousOrder.join('\n') !== nextOrder.join('\n')) {
          publishSidebarLayout({ chatOrder: nextOrder });
        }
        const chat = getChats().find((item) => item.id === draggedId);
        const currentParent =
          typeof chat?.forkParentChatId === 'string' ? chat.forkParentChatId.trim() : '';
        if (draggedId && currentParent !== parentChatId) {
          void setChatForkParent(draggedId, parentChatId);
        }
        forceRerender();
      },
    });
  }

  /**
   * Press-and-hold drag & drop for workspace groups. Listeners are delegated
   * on the static `.sidebar-body`, so a single init covers all re-renders.
   */
  function initWorkspaceDrag() {
    const body = getContainer()?.querySelector('.sidebar-body');
    if (!body) return;
    workspaceDrag = initSidebarWorkspaceDrag({
      body,
      isEnabled: () => !isSearchActive(),
      // Flush any render deferred while a workspace group was dragging.
      onSettled: () => afterSidebarGestureSettled(),
      onOrderChange: (keys) => {
        const previousOrder = readWorkspaceOrder();
        writeWorkspaceOrder(keys);
        const nextOrder = readWorkspaceOrder();
        if (previousOrder.join('\n') !== nextOrder.join('\n')) {
          publishSidebarLayout({ workspaceOrder: nextOrder });
        }
        forceRerender();
      },
    });
  }

  function flushArchiveVirtualWindowsAfterGesture() {
    const body = getContainer()?.querySelector('.sidebar-body');
    if (!body) return;
    body.querySelectorAll('cr-sidebar-archive-group').forEach((host) => {
      if (typeof host.flushVirtualWindowAfterGesture === 'function') {
        host.flushVirtualWindowAfterGesture();
      }
    });
    clearArchiveGestureFocusSnapshot();
  }

  function initArchiveVirtualGestureGuard() {
    registerSidebarArchiveGestureGuard(() => {
      const active = chatDrag.isDragging() || workspaceDrag.isDragging() || swipe.isSwiping();
      tickSidebarArchiveGestureFocusSnapshot(active);
      return active;
    });
    registerSidebarArchiveGestureEndFlush(flushArchiveVirtualWindowsAfterGesture);
  }

  function afterSidebarGestureSettled() {
    runSidebarArchiveGestureEndFlush();
    updateScheduler.schedule();
  }

  function initSwipe() {
    swipe = initSidebarSwipe({
      getSidebar: getContainer,
      getBackdrop,
      getEdgeOpen: () => document.getElementById('sidebar-edge-open'),
      isOpen: () => open,
      isMobile: isMobileViewport,
      isResizing: () => document.body?.classList.contains('sidebar-resizing') === true,
      isChatDragging: () => chatDrag.isDragging(),
      isWorkspaceDragging: () => workspaceDrag.isDragging(),
      onClose: closeSidebar,
      onOpen: openSidebar,
      onPreviewReveal: revealDrawerPreview,
      onPreviewHide: hideDrawerPreview,
      // A render requested while the drawer tracked/settled was deferred; flush
      // it on release so the list is never left stale after a swipe.
      onGestureEnd: () => afterSidebarGestureSettled(),
    });
  }

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
      if (swipe.isSwiping()) return;
      applyVisibility();
    });
    // The master switch reads a server-wide gate that the presence frame does not
    // carry: fetch it once, then refresh whenever the watcher reports a change.
    window.addEventListener('cretli:workspace-watcher-changed', () => {
      void refreshWorkspaceWatcherRuntimeControl().then(() => updateScheduler.schedule());
    });
    void refreshWorkspaceWatcherRuntimeControl().then((ok) => {
      if (ok) updateScheduler.schedule();
    });
    render();
  }

  function forceRerender() {
    getUiFreezeCounters()?.bump('sidebar.forceRenders');
    lastRenderSignature = '';
    // Language / explicit force: text must be regenerated, so drop the reuse map.
    renderedWorkspaceNodes.clear();
    lastPinnedSectionHtml = '';
    render();
  }

  return {
    init,
    open: openSidebar,
    close: closeSidebar,
    toggle: toggleSidebar,
    isOpen: () => open,
    isPinned: () => pinned,
    render,
    forceRerender,
    // Coalesced "something changed" entry point — at most one render per frame.
    scheduleUpdate: () => updateScheduler.schedule(),
    // In-place repaint of the visuals kept out of the structural signature
    // (active chat, group summaries, parent badges). Safe to call any time.
    patchTransientVisualStates,
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
