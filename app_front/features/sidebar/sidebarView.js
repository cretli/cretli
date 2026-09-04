/**
 * Sidebar listing workspaces and chats. It replaces the chat switcher dropdown as
 * the primary UI, while the dropdown stays available as a fallback.
 * The drawer slides in from the left via the header menu icon.
 */

import { getChatUpdatedAtMs, sortChatsByDate } from '../chat/chatListSort.js';
import { readStorageValueWithAlias, writeStorageValueWithAlias } from '../../lib/storageKeyAlias.js';
import { getCurrentLang, t } from '../../i18n/index.js';
import { matchesSidebarSearch } from './sidebarSearch.js';
import {
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_RESIZE_STEP,
  clampSidebarWidth,
} from './sidebarWidth.js';

const SIDEBAR_OPEN_KEY = 'cretli-sidebar-open';
const SIDEBAR_COLLAPSE_KEY = 'cretli-sidebar-collapsed';
const SIDEBAR_WIDTH_KEY = 'cretli-sidebar-width';

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

export function createSidebarView(deps) {
  const {
    getWorkspaces,
    getChats,
    getActiveWorkspaceFile,
    getActiveWorkspaceFolder = () => '',
    getActiveChatId,
    selectChat,
    switchWorkspace,
    getPreferredWorkspaceFolder = () => '',
    chatFavorites,
    resolveChatState,
    getTerminalStateMeta,
    requestDeleteChat,
    requestNewChat = () => {},
    canPinChatToUrl = () => false,
    toggleChatUrlPinById = async () => {},
    escapeHtml,
    openWorkspaceSettings = () => {},
    refreshStates = () => {},
    isMobileViewport = () =>
      typeof window !== 'undefined' && window.matchMedia
        ? window.matchMedia('(max-width: 768px)').matches
        : false,
  } = deps;

  let open = readOpenFlag();
  const collapsed = readCollapsedSet();
  let lastRenderSignature = '';
  let pollTimer = null;
  let searchQuery = '';

  function getContainer() {
    return document.getElementById('app-sidebar');
  }

  function getBackdrop() {
    return document.getElementById('app-sidebar-backdrop');
  }

  function applyVisibility() {
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
    if (open) {
      startPoll();
      applySidebarWidth();
    } else stopPoll();
  }

  function startPoll() {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      if (!open) {
        stopPoll();
        return;
      }
      refreshStates();
    }, 1500);
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

  function chatsForWorkspace(workspace) {
    const norm = normalizePath(workspace.workspaceFile);
    if (!norm) return [];
    let chats = getChats().filter((c) => c.workspaceFile && normalizePath(c.workspaceFile) === norm);
    if (!workspace.isClone) return chats;

    const folder = normalizePath(getPreferredWorkspaceFolder(workspace.sidebarKey || workspace.workspaceFile));
    if (!folder) return chats;

    return chats.filter((chat) => {
      const chatFolder = normalizePath(chat.workspaceFolder || '');
      return !chatFolder || chatFolder === folder;
    });
  }

  function orderedChats(list) {
    return sortChatsByDate(list);
  }

  function flattenChatsTree(chats) {
    if (!Array.isArray(chats) || !chats.length) return [];
    const byId = new Map(chats.map((chat) => [chat.id, chat]));
    const childrenByParent = new Map();
    const roots = [];
    const resolveRootParentId = (chat) => {
      if (!chat) return '';
      let current = chat;
      const visited = new Set([chat.id]);
      while (current && typeof current.forkParentChatId === 'string') {
        const parentId = current.forkParentChatId.trim();
        if (!parentId || parentId === chat.id || visited.has(parentId)) break;
        const parent = byId.get(parentId);
        if (!parent) break;
        visited.add(parentId);
        current = parent;
      }
      return current?.id || '';
    };

    chats.forEach((chat) => {
      const parentId = typeof chat.forkParentChatId === 'string' ? chat.forkParentChatId.trim() : '';
      if (!parentId || parentId === chat.id) {
        roots.push(chat);
        return;
      }
      const parent = byId.get(parentId);
      if (!parent) {
        roots.push(chat);
        return;
      }
      const rootParentId = resolveRootParentId(parent) || parent.id;
      const list = childrenByParent.get(rootParentId) || [];
      list.push(chat);
      childrenByParent.set(rootParentId, list);
    });

    const linear = [];
    roots.forEach((chat) => {
      linear.push({ chat, level: 0, isLastChild: false });
      const children = childrenByParent.get(chat.id);
      if (!children?.length) return;
      children.forEach((child, idx) => {
        linear.push({ chat: child, level: 1, isLastChild: idx === children.length - 1 });
      });
    });

    return linear;
  }

  function renderChatItem(chat, activeChatId, opts = {}) {
    const level = opts.level === 1 ? 1 : 0;
    const isLastChild = level === 1 && opts.isLastChild === true;
    const state = resolveChatState(chat);
    const meta = getTerminalStateMeta(chat);
    const showMeta = meta.tone !== 'idle';
    return (
      '<li class="sidebar-chat-item' +
      (chat.id === activeChatId ? ' is-active' : '') +
      (level === 1 ? ' is-child' : '') +
      (isLastChild ? ' is-last-child' : '') +
      '" role="option" aria-selected="' +
      (chat.id === activeChatId ? 'true' : 'false') +
      '" data-chat-id="' +
      escapeHtml(chat.id) +
      // Roving tabindex: only the active chat is reachable with Tab, arrows
      // move between the rest (see initChatListKeyboard).
      '" tabindex="' +
      (chat.id === activeChatId ? '0' : '-1') +
      '">' +
      '<span class="sidebar-chat-item-state sidebar-chat-item-state--' +
      state +
      '" title="' +
      escapeHtml(meta.label) +
      '" aria-hidden="true"></span>' +
      '<span class="sidebar-chat-item-title">' +
      escapeHtml(chat.title) +
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
      '<span class="sidebar-chat-item-awaiting sidebar-chat-item-awaiting--' +
      escapeHtml(meta.tone) +
      '" title="' +
      escapeHtml(t('sidebar.stateTitle', { label: meta.label })) +
      '"' +
      (showMeta ? '' : ' hidden') +
      '>' +
      escapeHtml(meta.label) +
      '</span>' +
      '</li>'
    );
  }

  function renderWorkspaceGroup(workspace, activeWorkspaceFile, activeWorkspaceFolder, activeChatId, chats) {
    const sidebarKey = workspace.sidebarKey || workspace.workspaceFile || '';
    const preferredFolder = getPreferredWorkspaceFolder(sidebarKey);
    const isActive =
      normalizePath(workspace.workspaceFile) === normalizePath(activeWorkspaceFile) &&
      normalizePath(preferredFolder) === normalizePath(activeWorkspaceFolder);
    const isCollapsed = !isSearchActive() && isWorkspaceCollapsed(sidebarKey);
    const treeChats = flattenChatsTree(chats);
    const count = chats.length;

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
      (count
        ? treeChats
            .map((item) =>
              renderChatItem(item.chat, activeChatId, {
                level: item.level,
                isLastChild: item.isLastChild,
              })
            )
            .join('')
        : '<li class="sidebar-chat-empty">' + escapeHtml(t('sidebar.noChats')) + '</li>') +
      '</ul>' +
      '</li>'
    );
  }

  function renderSignature() {
    const wsList = getWorkspaces();
    const activeWs = normalizePath(getActiveWorkspaceFile());
    const activeChatId = getActiveChatId();
    const collapsedKey = [...collapsed].sort().join('|');
    const chatsSig = getChats()
      .map((c) =>
        [
          c.id,
          c.title,
          c.workspaceFile,
          chatFavorites.isFavorite(c.id) ? '1' : '0',
          c.id === activeChatId ? 'A' : '',
          resolveChatState(c),
          getTerminalStateMeta(c).tone,
          c.isTemporary ? 'T' : '',
          c.todoId ? 'D' : '',
          c.forkParentChatId || '',
          getChatUpdatedAtMs(c) || 0,
          c.widgetPinnedUrl || '',
        ].join(',')
      )
      .join('|');
    return (
      wsList
        .map((w) =>
          [
            w.sidebarKey || w.workspaceFile,
            w.workspaceFile,
            w.name,
            w.isClone ? '1' : '0',
            w.folders?.length || 0,
          ].join('::')
        )
        .join('|') +
      '||' +
      activeWs +
      '||' +
      normalizePath(getActiveWorkspaceFolder()) +
      '||' +
      activeChatId +
      '||' +
      collapsedKey +
      '||' +
      chatsSig +
      '||' +
      searchQuery
    );
  }

  function render() {
    const aside = getContainer();
    if (!aside) return;
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

    const ordered = wsList.slice().sort((a, b) => {
      const aKey = a.sidebarKey || a.workspaceFile || '';
      const bKey = b.sidebarKey || b.workspaceFile || '';
      const aFolder = normalizePath(getPreferredWorkspaceFolder(aKey));
      const bFolder = normalizePath(getPreferredWorkspaceFolder(bKey));
      const aActive =
        normalizePath(a.workspaceFile) === normalizePath(activeWorkspaceFile) &&
        aFolder === normalizePath(activeWorkspaceFolder)
          ? 0
          : 1;
      const bActive =
        normalizePath(b.workspaceFile) === normalizePath(activeWorkspaceFile) &&
        bFolder === normalizePath(activeWorkspaceFolder)
          ? 0
          : 1;
      if (aActive !== bActive) return aActive - bActive;
      return (a.name || '').localeCompare(b.name || '', getCurrentLang());
    });

    const searching = isSearchActive();
    const groupsHtml = ordered
      .map((workspace) => {
        const chats = visibleChatsForWorkspace(workspace);
        if (searching && chats.length === 0) return '';
        return renderWorkspaceGroup(
          workspace,
          activeWorkspaceFile,
          activeWorkspaceFolder,
          activeChatId,
          chats
        );
      })
      .filter(Boolean);

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
          closeSidebar();
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
        pinBtn.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          void toggleChatUrlPinById(chatId);
        });
        el.appendChild(pinBtn);
        firstActionBtn = pinBtn;
      }

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'sidebar-chat-action sidebar-chat-delete-btn';
      deleteBtn.title = t('sidebar.deleteChat');
      deleteBtn.setAttribute('aria-label', t('sidebar.deleteChat'));
      deleteBtn.innerHTML = '<span class="mdi mdi-trash-can-outline" aria-hidden="true"></span>';
      deleteBtn.addEventListener('pointerdown', (ev) => {
        ev.stopPropagation();
      });
      deleteBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (typeof requestDeleteChat !== 'function') return;
        requestDeleteChat(chatId, {
          preserveListOpen: true,
          forceConfirm: true,
          title: chat?.title || '',
        });
      });
      el.appendChild(deleteBtn);
      if (!firstActionBtn) firstActionBtn = deleteBtn;

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
        const chatWorkspace = normalizePath(chat.workspaceFile || '');
        const finishSelect = () => {
          selectChat(chatId);
          if (isMobileViewport()) closeSidebar();
        };

        if (!chatWorkspace || chatWorkspace === activeWorkspace) {
          finishSelect();
          return;
        }

        switchWorkspace(chat.workspaceFile || '', chat.workspaceFolder || '').then((ok) => {
          if (!ok) return;
          const chatSidebarKey = getWorkspaces().find((workspace) => {
            if (normalizePath(workspace.workspaceFile) !== chatWorkspace) return false;
            const folder = normalizePath(getPreferredWorkspaceFolder(workspace.sidebarKey || workspace.workspaceFile));
            const chatFolder = normalizePath(chat.workspaceFolder || '');
            return !chatFolder || folder === chatFolder;
          })?.sidebarKey;
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
      const readItems = () => Array.from(list.querySelectorAll('.sidebar-chat-item'));
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
    };

    resizer.addEventListener('pointerdown', onPointerDown);
    resizer.addEventListener('pointermove', onPointerMove);
    resizer.addEventListener('pointerup', onPointerEnd);
    resizer.addEventListener('pointercancel', onPointerEnd);
    resizer.addEventListener('keydown', onKeyDown);
    syncAria(aside.getBoundingClientRect().width);
  }

  function init() {
    initMenuButton();
    initSearchInput();
    applySidebarWidth();
    initResizer();
    applyVisibility();
    // The render signature tracks data, not language, so a language switch
    // needs an explicit rerender to pick up new labels.
    window.addEventListener('cr-lang-changed', () => forceRerender());
    window.addEventListener('resize', () => applySidebarWidth());
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
    render,
    forceRerender,
  };
}
