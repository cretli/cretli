/**
 * Sidebar listing workspaces and chats. It replaces the chat switcher dropdown as
 * the primary UI, while the dropdown stays available as a fallback.
 * The drawer slides in from the left via the header menu icon.
 */

import { applyChatOrder, flattenChatsTree, partitionChatsByArchive } from '../../../lib/chat-tree.js';
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
  setSidebarArchiveSectionOpen,
} from './sidebarVisibleChats.js';
import {
  formatSubchatParentBadge,
  getAncestorContinuationLevels,
  groupSettledChildren,
  renderTreeContinuationHtml,
  renderSubchatGroupHtml,
} from './sidebarSubchatGroups.js';
import { initSidebarChatDrag } from './sidebarChatDrag.js';
import { renderSidebarChatStatusHtml } from './sidebarChatStatus.js';
import { readChatOrder, writeChatOrderForList } from './sidebarChatOrder.js';
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
} from './workspaceChatMatch.js';
import {
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_RESIZE_STEP,
  clampSidebarWidth,
} from './sidebarWidth.js';
import { initSidebarSwipe } from './sidebarSwipe.js';

const SIDEBAR_OPEN_KEY = 'cretli-sidebar-open';
const SIDEBAR_COLLAPSE_KEY = 'cretli-sidebar-collapsed';
const SIDEBAR_ARCHIVE_OPEN_KEY = 'cretli-sidebar-archive-open';
const SIDEBAR_SUBCHAT_EXPANDED_KEY = 'cretli-sidebar-subchat-expanded';
const SIDEBAR_PIN_KEY = 'cretli-sidebar-pinned';
const SIDEBAR_WIDTH_KEY = 'cretli-sidebar-width';
const SIDEBAR_PIN_ACTIVE_WORKSPACE_KEY = 'cretli-sidebar-pin-active-workspace';

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
  let pollTimer = null;
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
    if (open) {
      startPoll();
      applySidebarWidth();
    } else stopPoll();
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

  function startPoll() {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      if (!open) {
        stopPoll();
        return;
      }
      if (typeof document !== 'undefined' && document.hidden) return;
      refreshStates();
    }, 5000);
  }

  function stopPoll() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function openSidebar() {
    open = true;
    writeOpenFlag(true);
    applyVisibility();
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
    if (value) collapsed.add(key);
    else collapsed.delete(key);
    writeCollapsedSet(collapsed);
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
    if (value) archiveOpen.add(key);
    else archiveOpen.delete(key);
    writeArchiveOpenSet(archiveOpen);
    setSidebarArchiveSectionOpen(archiveOpen.size > 0);
  }

  function isSubchatGroupExpanded(parentId) {
    return subchatExpanded.has(String(parentId || '').trim());
  }

  function setSubchatGroupExpanded(parentId, value) {
    const key = String(parentId || '').trim();
    if (!key) return;
    if (value) subchatExpanded.add(key);
    else subchatExpanded.delete(key);
    writeSubchatExpandedSet(subchatExpanded);
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
    searchQuery = typeof value === 'string' ? value : '';
    const el = getSearchInput();
    if (el && el.value !== searchQuery) el.value = searchQuery;
  }

  function visibleChatsForWorkspace(workspace) {
    const workspaceName = workspace.name || workspace.workspaceFile || '';
    return orderedChats(chatsForWorkspace(workspace)).filter((chat) =>
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
   * settled-subchat folding. `renderWorkspaceGroup` and
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

  /**
   * @param {import('./sidebarSubchatGroups.js').SubchatGroupNode} group
   * @param {string} sidebarKey
   * @param {string} parentTitle
   * @returns {string}
   */
  function renderSubchatGroup(group, sidebarKey, parentTitle, continuationLevels = []) {
    return renderSubchatGroupHtml(group, {
      sidebarKey,
      lang: getCurrentLang(),
      translate: t,
      escapeHtml,
      canArchive: typeof onArchiveSettled === 'function',
      canPin: canPinChatToUrl(),
      parentTitle,
      continuationLevels,
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
      forceRerender();
    } finally {
      archivingGroupParents.delete(key);
    }
  }

  function renderChatItem(chat, activeChatId, opts = {}) {
    const level = Math.max(0, Number(opts.level) || 0);
    const indentLevel = Math.min(MAX_SIDEBAR_NEST_INDENT, level);
    const isLastChild = level > 0 && opts.isLastChild === true;
    const parentId = typeof opts.parentId === 'string' ? opts.parentId : '';
    const subchatSummary = opts.subchatSummary || null;
    const archived = opts.archived === true;
    const hasPinAction = !archived && canPinChatToUrl();
    const localHarnessDisplay = resolvePersistedLocalChatHarnessDisplay(chat);
    const state = archived || localHarnessDisplay.blocked ? 'disconnected' : resolveChatState(chat);
    const meta = archived
      ? { tone: 'disconnected', label: t('chatUi.archivedState') }
      : (localHarnessDisplay.blocked
        ? { tone: 'disconnected', label: t(localHarnessDisplay.messageKey) }
        : getTerminalStateMeta(chat));
    const showMeta = meta.tone !== 'idle';
    const harness = String(chat.agentTransport || 'sdk').trim().toLowerCase();
    const harnessIcon = resolveSidebarHarnessIcon(chat);
    const harnessIconHtml = harnessIcon
      ? '<img src="/harness-icons/' + harnessIcon + '" alt="" loading="lazy" decoding="async">'
      : '';
    const harnessLabel = localHarnessDisplay.blocked
      ? localHarnessDisplay.label
      : ({
        sdk: 'Cursor SDK',
        'cursor-sdk': 'Cursor SDK',
        openrouter: 'OpenRouter',
        opencode: 'OpenCode',
        codebuddy: 'CodeBuddy',
        deepseek: 'DeepSeek',
        codex: 'Codex',
        qwen: 'Qwen',
        claude: 'Claude',
      })[harness] || 'Cursor SDK';
    const harnessModifier = localHarnessDisplay.blocked
      ? 'local'
      : (harness === 'cursor-sdk' ? 'sdk' : (['sdk', 'openrouter', 'opencode', 'codebuddy', 'deepseek', 'codex', 'qwen', 'claude'].includes(harness) ? harness : 'sdk'));
    const harnessTitle = localHarnessDisplay.blocked ? t(localHarnessDisplay.messageKey) : harnessLabel;
    return (
      '<li class="sidebar-chat-item' +
      (chat.id === activeChatId ? ' is-active' : '') +
      (level > 0 ? ' is-child' : '') +
      (isLastChild ? ' is-last-child' : '') +
      (archived ? ' is-archived' : '') +
      (hasPinAction ? ' has-pin-actions' : '') +
      '" role="option" aria-selected="' +
      (chat.id === activeChatId ? 'true' : 'false') +
      '" data-chat-id="' +
      escapeHtml(chat.id) +
      '" data-nest-level="' +
      String(archived ? 0 : level) +
      '" data-parent-id="' +
      escapeHtml(archived ? '' : parentId) +
      '"' +
      (archived ? ' data-archived="1"' : '') +
      (indentLevel > 0 && !archived ? ' style="--sidebar-nest-level:' + String(indentLevel) + '"' : '') +
      ' tabindex="' +
      (chat.id === activeChatId ? '0' : '-1') +
      '">' +
      renderTreeContinuationHtml(opts.continuationLevels) +
      '<span class="sidebar-chat-item-state sidebar-chat-item-state--' +
      state +
      '" title="' +
      escapeHtml(meta.label) +
      '" aria-hidden="true"></span>' +
      '<span class="sidebar-chat-item-harness sidebar-chat-item-harness--' +
      harnessModifier +
      '" title="' +
      escapeHtml(harnessTitle) +
      '" aria-hidden="true">' +
      harnessIconHtml +
      '</span>' +
      '<span class="sidebar-chat-item-title">' +
      escapeHtml(chat.title) +
      (archived
        ? '<span class="sidebar-chat-item-temp-badge" title="' +
          escapeHtml(t('chatUi.archivedChat')) +
          '">' +
          escapeHtml(t('chatUi.archivedBadge')) +
          '</span>'
        : '') +
      (chat.isTemporary
        ? '<span class="sidebar-chat-item-temp-badge" title="' + escapeHtml(t('sidebar.tempAgentTitle')) + '">'
          + escapeHtml(t('sidebar.tempBadge')) + '</span>'
        : '') +
      (chat.todoId
        ? '<span class="sidebar-chat-item-todo-badge" title="' + escapeHtml(t('sidebar.todoTitle')) + '">Todo</span>'
        : '') +
      (chat.widgetPinnedUrl
        ? '<span class="sidebar-chat-item-pin-badge" title="' + escapeHtml(t('sidebar.pinnedUrlTitle')) + '">URL</span>'
        : '') +
      '</span>' +
      (subchatSummary && !archived
        ? '<span class="sidebar-chat-item-subchat-summary" title="' +
          escapeHtml(subchatSummary.title) +
          '" aria-label="' +
          escapeHtml(subchatSummary.title) +
          '">' +
          escapeHtml(subchatSummary.label) +
          '</span>'
        : '') +
      '<span class="sidebar-chat-item-awaiting sidebar-chat-item-awaiting--' +
      escapeHtml(meta.tone) +
      '" title="' +
      escapeHtml(t('sidebar.stateTitle', { label: meta.label })) +
      '" data-status-tone="' +
      escapeHtml(meta.tone) +
      '" data-status-outcome="' +
      escapeHtml(meta.status || '') +
      '"' +
      (showMeta ? '' : ' hidden') +
      '>' +
      renderSidebarChatStatusHtml(meta, escapeHtml) +
      '</span>' +
      '</li>'
    );
  }

  function renderArchiveSection(sidebarKey, archivedChats, activeChatId, searching, hintCount = 0) {
    const count = archivedChats.length || Number(hintCount) || 0;
    if (!count) return '';
    const openSection = searching || isArchiveSectionOpen(sidebarKey)
      || archivedChats.some((chat) => chat.id === activeChatId);
    const listHtml = openSection
      ? archivedChats.map((chat) => renderChatItem(chat, activeChatId, { archived: true })).join('')
      : '';
    return (
      '<li class="sidebar-archive-group" data-sidebar-key="' +
      escapeHtml(sidebarKey) +
      '">' +
      '<div class="sidebar-archive-header" role="button" tabindex="0" aria-expanded="' +
      (openSection ? 'true' : 'false') +
      '">' +
      '<span class="sidebar-workspace-chevron mdi mdi-chevron-' +
      (openSection ? 'down' : 'right') +
      '" aria-hidden="true"></span>' +
      '<span class="mdi mdi-archive-outline" aria-hidden="true"></span>' +
      '<span class="sidebar-archive-title">' +
      escapeHtml(t('sidebar.archiveSection')) +
      '</span>' +
      '<span class="sidebar-workspace-count">' +
      String(count) +
      '</span>' +
      '</div>' +
      '<ul class="sidebar-archive-list" role="listbox"' +
      (openSection ? '' : ' hidden') +
      '>' +
      listHtml +
      '</ul>' +
      '</li>'
    );
  }

  function renderWorkspaceGroup(workspace, activeWorkspaceFile, activeWorkspaceFolder, activeChatId, chats, renderedIds) {
    const sidebarKey = workspace.sidebarKey || workspace.workspaceFile || '';
    const preferredFolder = getPreferredWorkspaceFolder(sidebarKey);
    const isActive =
      normalizePath(workspace.workspaceFile) === normalizePath(activeWorkspaceFile) &&
      normalizePath(preferredFolder) === normalizePath(activeWorkspaceFolder);
    const isCollapsed = !isSearchActive() && isWorkspaceCollapsed(sidebarKey);
    const searching = isSearchActive();
    const { live, archived, grouped, tree } = buildWorkspaceChatTree(chats, activeChatId, searching);
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
        for (const chat of archived) {
          if (chat?.id) renderedIds.add(chat.id);
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
    const liveHtml = !serializeList
      ? ''
      : count
      ? capped.items
          .map((item) => {
            if (item?.isGroup) {
              return renderSubchatGroup(
                item,
                sidebarKey,
                parentTitleById.get(item.parentId) || '',
                continuationLevelsFor(item),
              );
            }
            return renderChatItem(item.chat, activeChatId, {
              level: item.level,
              isLastChild: item.isLastChild,
              parentId: item.parentId,
              subchatSummary: collapsedSummariesByParent.get(item.chat.id) || null,
              continuationLevels: continuationLevelsFor(item),
            });
          })
          .join('') +
        (capped.hidden > 0
          ? '<li class="sidebar-chat-more" role="button" tabindex="0" data-sidebar-key="' +
            escapeHtml(sidebarKey) +
            '">' +
            escapeHtml(t('sidebar.showMoreChats', { count: String(capped.hidden) })) +
            '</li>'
          : '')
      : archived.length || archivedCountForWorkspace(workspace)
        ? ''
        : '<li class="sidebar-chat-empty">' + escapeHtml(t('sidebar.noChats')) + '</li>';
    const archiveHtml = serializeList
      ? renderArchiveSection(
          sidebarKey,
          archived,
          activeChatId,
          searching,
          archivedCountForWorkspace(workspace),
        )
      : '';

    return (
      '<li class="sidebar-workspace' +
      (isActive ? ' is-active' : '') +
      (workspace.isClone ? ' is-clone' : '') +
      (isCollapsed ? ' is-collapsed' : '') +
      '" data-sidebar-key="' +
      escapeHtml(sidebarKey) +
      '" data-workspace-file="' +
      escapeHtml(workspace.workspaceFile || '') +
      '">' +
      '<div class="sidebar-workspace-header" role="button" tabindex="0" aria-expanded="' +
      (isCollapsed ? 'false' : 'true') +
      '">' +
      '<span class="sidebar-workspace-chevron mdi mdi-chevron-' +
      (isCollapsed ? 'right' : 'down') +
      '" aria-hidden="true"></span>' +
      '<span class="sidebar-workspace-title">' +
      escapeHtml(workspace.name || workspace.workspaceFile || '(workspace)') +
      '</span>' +
      '<span class="sidebar-workspace-count">' +
      (count ? String(count) : '') +
      '</span>' +
      '<button type="button" class="sidebar-workspace-new-btn" title="' +
      escapeHtml(t('sidebar.newChat')) +
      '" aria-label="' +
      escapeHtml(t('sidebar.newChat')) +
      '" data-sidebar-key="' +
      escapeHtml(sidebarKey) +
      '" data-workspace-file="' +
      escapeHtml(workspace.workspaceFile || '') +
      '">' +
      '<span class="mdi mdi-plus" aria-hidden="true"></span>' +
      '</button>' +
      '</div>' +
      '<ul class="sidebar-chat-list" role="listbox"' +
      (isCollapsed ? ' hidden' : '') +
      '>' +
      liveHtml +
      archiveHtml +
      '</ul>' +
      '</li>'
    );
  }

  function collectRenderableChatIds() {
    const ids = new Set();
    const searching = isSearchActive();
    const activeChatId = getActiveChatId();
    if (activeChatId) ids.add(activeChatId);
    for (const workspace of getWorkspaces()) {
      const sidebarKey = workspace.sidebarKey || workspace.workspaceFile || '';
      const isCollapsed = !searching && isWorkspaceCollapsed(sidebarKey);
      if (!shouldSerializeWorkspaceChatList(isCollapsed, searching)) continue;
      const { archived, grouped } = buildWorkspaceChatTree(
        visibleChatsForWorkspace(workspace),
        activeChatId,
        searching,
      );
      const capped = capSidebarVisibleTreeChats(grouped.items, {
        limit: SIDEBAR_VISIBLE_CHAT_LIMIT,
        activeChatId,
        showAll: searching || showAllChatsBySidebarKey.has(sidebarKey),
      });
      for (const item of capped.items) {
        if (item?.chat?.id) ids.add(item.chat.id);
      }
      if (searching || isArchiveSectionOpen(sidebarKey)) {
        for (const chat of archived) {
          if (chat?.id) ids.add(chat.id);
        }
      }
    }
    return ids;
  }

  /**
   * Signature of the settled-subchat groups (counts + expansion) so a status
   * change inside an already collapsed group still repaints its summary.
   *
   * @returns {string}
   */
  function collectSubchatGroupSignature() {
    const parts = [];
    const searching = isSearchActive();
    const activeChatId = getActiveChatId();
    for (const workspace of getWorkspaces()) {
      const sidebarKey = workspace.sidebarKey || workspace.workspaceFile || '';
      const isCollapsed = !searching && isWorkspaceCollapsed(sidebarKey);
      if (!shouldSerializeWorkspaceChatList(isCollapsed, searching)) continue;
      const { grouped } = buildWorkspaceChatTree(
        visibleChatsForWorkspace(workspace),
        activeChatId,
        searching,
      );
      for (const group of grouped.groups) {
        const summary = group.summary || {};
        parts.push(
          [
            sidebarKey,
            group.parentId,
            summary.total || 0,
            summary.completed || 0,
            summary.failed || 0,
            summary.interrupted || 0,
            summary.idle || 0,
            group.expanded ? '1' : '0',
          ].join(':'),
        );
      }
    }
    return parts.join('|');
  }

  function renderSignature() {
    const wsList = getWorkspaces();
    const activeWs = normalizePath(getActiveWorkspaceFile());
    const activeChatId = getActiveChatId();
    const collapsedKey = [...collapsed].sort().join('|');
    const visibleIds = collectRenderableChatIds();
    const groupSig = collectSubchatGroupSignature();
    const structureSig = wsList
      .map((workspace) => {
        const sidebarKey = workspace.sidebarKey || workspace.workspaceFile || '';
        const { live } = partitionChatsByArchive(visibleChatsForWorkspace(workspace));
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
    const statusSig = getChats()
      .filter((c) => c?.id && visibleIds.has(c.id))
      .map((c) =>
        [c.id, resolveChatState(c), getTerminalStateMeta(c).tone, c.id === activeChatId ? 'A' : ''].join(','),
      )
      .join('|');
    return (
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
      structureSig +
      '||' +
      statusSig +
      '||' +
      groupSig
    );
  }

  function render() {
    const aside = getContainer();
    if (!aside) return;
    // Never rebuild the DOM mid-gesture — a live drag node would detach, and
    // a swipe follows an inline transform on this aside.
    if (workspaceDrag.isDragging() || chatDrag.isDragging() || swipe.isSwiping()) return;
    const sig = renderSignature();
    if (sig === lastRenderSignature) return;
    lastRenderSignature = sig;

    const wsList = getWorkspaces();
    const activeWorkspaceFile = getActiveWorkspaceFile();
    const activeWorkspaceFolder = getActiveWorkspaceFolder();
    const activeChatId = getActiveChatId();

    const body = aside.querySelector('.sidebar-body');
    if (!body) return;

    if (!wsList.length) {
      body.innerHTML =
        '<div class="sidebar-empty">' +
        '<p class="sidebar-empty-hint">' + escapeHtml(t('workspace.emptyHint')) + '</p>' +
        '<cr-bar-button class="sidebar-empty-add" variant="primary">' +
        escapeHtml(t('workspace.emptyAction')) +
        '</cr-bar-button>' +
        '</div>';
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
    const renderedIds = new Set();
    settledGroupsByParent = new Map();
    const groupsHtml = ordered
      .map((workspace) => {
        const chats = visibleChatsForWorkspace(workspace);
        if (searching && chats.length === 0) return '';
        return renderWorkspaceGroup(
          workspace,
          activeWorkspaceFile,
          activeWorkspaceFolder,
          activeChatId,
          chats,
          renderedIds
        );
      })
      .filter(Boolean);
    setRenderedSidebarChatIds(renderedIds);

    if (!groupsHtml.length) {
      body.innerHTML =
        '<div class="sidebar-empty">' + escapeHtml(t('sidebar.noSearchResults')) + '</div>';
      return;
    }

    body.innerHTML =
      '<ul class="sidebar-workspaces" role="listbox">' +
      groupsHtml.join('') +
      '</ul>';

    wireBodyEvents();
  }

  function activateChatPanelTab() {
    const chatTabButton = document.querySelector('.tab[data-panel="chat"]');
    if (!(chatTabButton instanceof HTMLButtonElement)) return;
    chatTabButton.click();
  }

  function wireBodyEvents() {
    const body = getContainer()?.querySelector('.sidebar-body');
    if (!body) return;

    body.querySelectorAll('.sidebar-workspace-new-btn').forEach((newBtn) => {
      const workspaceFile = newBtn.getAttribute('data-workspace-file') || '';
      const sidebarKey = newBtn.getAttribute('data-sidebar-key') || workspaceFile;
      newBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const preferredFolder = getPreferredWorkspaceFolder(sidebarKey);

        const openNewChat = () => {
          activateChatPanelTab();
          requestNewChat({ workspaceFile, workspaceFolder: preferredFolder });
          // A pinned sidebar is docked on desktop, so opening the new-chat
          // modal must not undo the user's layout choice. Mobile remains an
          // overlay, therefore it should still close behind the modal.
          if (!pinned || isMobileViewport()) closeSidebar();
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
      });
    });

    body.querySelectorAll('.sidebar-workspace-header').forEach((header) => {
      const li = header.closest('.sidebar-workspace');
      const workspaceFile = li?.dataset.workspaceFile || '';
      const sidebarKey = li?.dataset.sidebarKey || workspaceFile;
      header.addEventListener('click', (ev) => {
        ev.stopPropagation();
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
      });
      header.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        header.click();
      });
    });

    body.querySelectorAll('.sidebar-archive-header').forEach((header) => {
      header.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const group = header.closest('.sidebar-archive-group');
        const key = group?.getAttribute('data-sidebar-key') || '';
        if (!key) return;
        setArchiveSectionOpen(key, !isArchiveSectionOpen(key));
        if (isArchiveSectionOpen(key)) {
          Promise.resolve(requestLoadArchivedChats()).catch(() => {});
        }
        forceRerender();
      });
      header.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        header.click();
      });
    });

    body.querySelectorAll('.sidebar-subchat-group-toggle').forEach((toggle) => {
      toggle.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const parentId = toggle.getAttribute('data-parent-id') || '';
        if (!parentId) return;
        setSubchatGroupExpanded(parentId, !isSubchatGroupExpanded(parentId));
        forceRerender();
      });
    });

    body.querySelectorAll('.sidebar-subchat-group-archive').forEach((archiveBtn) => {
      archiveBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
      archiveBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const parentId = archiveBtn.getAttribute('data-parent-id') || '';
        const group = settledGroupsByParent.get(parentId);
        if (!group) return;
        void archiveSettledGroup(parentId, group.allChildIds);
      });
    });

    body.querySelectorAll('.sidebar-chat-more').forEach((el) => {
      const key = el.getAttribute('data-sidebar-key') || '';
      const expand = () => {
        if (!key) return;
        showAllChatsBySidebarKey.add(key);
        forceRerender();
      };
      el.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        expand();
      });
      el.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        expand();
      });
    });

    body.querySelectorAll('.sidebar-chat-item').forEach((el) => {
      const chatId = el.dataset.chatId || '';
      if (!chatId) return;

      const chat = getChats().find((item) => item.id === chatId);
      const showPin = canPinChatToUrl();
      let firstActionBtn = null;

      if (showPin) {
        const pinnedUrl = typeof chat?.widgetPinnedUrl === 'string' ? chat.widgetPinnedUrl.trim() : '';
        const pinned = !!pinnedUrl;
        const pinBtn = document.createElement('button');
        pinBtn.type = 'button';
        pinBtn.className = 'sidebar-chat-action sidebar-chat-pin-btn' + (pinned ? ' sidebar-chat-pin-btn--active' : '');
        pinBtn.title = pinned
          ? t('sidebar.unpinChatFromUrl', { url: pinnedUrl })
          : t('sidebar.pinChatToUrl');
        pinBtn.setAttribute('aria-label', pinBtn.title);
        pinBtn.setAttribute('aria-pressed', pinned ? 'true' : 'false');
        pinBtn.innerHTML =
          '<span class="mdi ' +
          (pinned ? 'mdi-link-variant-off' : 'mdi-link-variant') +
          '" aria-hidden="true"></span>';
        pinBtn.addEventListener('pointerdown', (ev) => {
          ev.stopPropagation();
        });
        pinBtn.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          void toggleChatUrlPinById(chatId);
        });
        el.appendChild(pinBtn);
        firstActionBtn = pinBtn;
      }

      const isArchived = el.dataset.archived === '1' || Boolean(chat?.archivedAt);
      const archiveBtn = document.createElement('button');
      archiveBtn.type = 'button';
      archiveBtn.className =
        'sidebar-chat-action ' +
        (isArchived ? 'sidebar-chat-restore-btn' : 'sidebar-chat-archive-btn');
      archiveBtn.title = t(isArchived ? 'sidebar.restoreChat' : 'sidebar.archiveChat');
      archiveBtn.setAttribute('aria-label', archiveBtn.title);
      archiveBtn.innerHTML =
        '<span class="mdi ' +
        (isArchived ? 'mdi-archive-arrow-up-outline' : 'mdi-archive-arrow-down-outline') +
        '" aria-hidden="true"></span>';
      archiveBtn.addEventListener('pointerdown', (ev) => {
        ev.stopPropagation();
      });
      archiveBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (isArchived) {
          if (typeof requestRestoreChat !== 'function') return;
          void requestRestoreChat(chatId);
          return;
        }
        if (typeof requestArchiveChat !== 'function') return;
        void requestArchiveChat(chatId, { preserveListOpen: true });
      });
      el.appendChild(archiveBtn);
      if (!firstActionBtn) firstActionBtn = archiveBtn;

      const favActive = chatFavorites.isFavorite(chatId);
      const favBtn = document.createElement('button');
      favBtn.type = 'button';
      favBtn.className = 'sidebar-chat-action sidebar-chat-fav-btn';
      favBtn.title = favActive ? t('sidebar.removeFavorite') : t('sidebar.addFavorite');
      favBtn.setAttribute('aria-label', favBtn.title);
      const renderFavIcon = (active) => {
        favBtn.title = active ? t('sidebar.removeFavorite') : t('sidebar.addFavorite');
        favBtn.setAttribute('aria-label', favBtn.title);
        favBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
        favBtn.innerHTML =
          '<span class="mdi ' +
          (active ? 'mdi-star sidebar-chat-fav-btn--active' : 'mdi-star-outline') +
          '" aria-hidden="true"></span>';
      };
      renderFavIcon(favActive);
      favBtn.addEventListener('pointerdown', (ev) => {
        ev.stopPropagation();
      });
      favBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        chatFavorites.toggleFavorite(chatId);
        forceRerender();
      });
      el.appendChild(favBtn);

      if (firstActionBtn) {
        firstActionBtn.classList.add('sidebar-chat-action-first');
      }

      el.addEventListener('click', (ev) => {
        if (ev.target instanceof Element && ev.target.closest('.sidebar-chat-action')) return;
        const chat = getChats().find((item) => item.id === chatId);
        if (!chat) return;

        const activeWorkspace = normalizePath(getActiveWorkspaceFile());
        const activeFolder = normalizePath(getActiveWorkspaceFolder());
        const chatWorkspace = normalizePath(chat.workspaceFile || '');
        const chatFolder = normalizePath(chat.workspaceFolder || '');
        const finishSelect = () => {
          selectChat(chatId);
          if (isMobileViewport()) closeSidebar();
        };

        const sameWorkspace =
          chatWorkspace &&
          chatWorkspace === activeWorkspace &&
          (!chatFolder || chatFolder === activeFolder);
        if (!chatWorkspace || sameWorkspace) {
          finishSelect();
          return;
        }

        switchWorkspace(chat.workspaceFile || '', chat.workspaceFolder || '').then((ok) => {
          if (!ok) return;
          const cloneFolders = listCloneFoldersForWorkspaceFile(
            getWorkspaces(),
            chatWorkspace,
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
      });
    });

    initChatListKeyboard(body);
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
   * Keyboard support for the chat listboxes (arrows, Home/End, Enter/Space)
   * using the roving-tabindex pattern: exactly one item is tabbable at a time.
   * @param {HTMLElement} root
   */
  function initChatListKeyboard(root) {
    root.querySelectorAll('.sidebar-chat-list').forEach((list) => {
      const readItems = () =>
        Array.from(
          list.querySelectorAll('.sidebar-chat-item:not(.is-subchat-hidden)'),
        ).filter((el) => !el.closest('[hidden]') && el.hidden !== true);
      const initial = readItems();
      // Without an active chat nothing would be reachable with Tab.
      if (initial.length && !initial.some((el) => el.getAttribute('tabindex') === '0')) {
        initial[0].setAttribute('tabindex', '0');
      }
      list.addEventListener('keydown', (e) => {
        const current = e.target instanceof Element
          ? e.target.closest('.sidebar-chat-item')
          : null;
        if (!current) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          current.click();
          return;
        }
        const items = readItems();
        const index = items.indexOf(current);
        if (index < 0) return;
        const nextIndex = resolveNextItemIndex(e.key, index, items.length);
        if (nextIndex === null) return;
        e.preventDefault();
        items.forEach((el) => el.setAttribute('tabindex', '-1'));
        items[nextIndex].setAttribute('tabindex', '0');
        items[nextIndex].focus();
      });
    });
  }

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
      searchQuery = typeof el.value === 'string' ? el.value : '';
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
      onDrop: ({ orderedIds, draggedId, parentChatId }) => {
        writeChatOrderForList(orderedIds);
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
      onOrderChange: (keys) => {
        writeWorkspaceOrder(keys);
        forceRerender();
      },
    });
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
    });
  }

  function init() {
    initMenuButton();
    initSearchInput();
    initPinActiveWorkspaceSetting();
    initWorkspaceDrag();
    initChatDrag();
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
    render();
  }

  function forceRerender() {
    lastRenderSignature = '';
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
  };
}
