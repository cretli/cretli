import { normalizeSdkMode } from '../../../lib/sdk/sdk-mode.js';
import { normalizeSdkUiMode } from '../../../lib/sdk/sdk-ui-mode.js';
import { resolvePersistedLocalChatTransport, isBlockingPersistedLocalChatHarnessState } from './persistedLocalChatState.js';
import { setActiveChatIdsForEviction } from '../../lib/sdk-chat-history-store.js';
import { migrateChatStorageOutOfLocalStorage } from '../../lib/chatStorageMigration.js';
import { readStorageValueWithAlias, writeStorageValueWithAlias } from '../../lib/storageKeyAlias.js';
import { t } from '../../i18n/index.js';
import { escapeHtml } from './chatHtmlUtils.js';
import { pickNewChatWorkspaceFile, workspaceListEntryKey } from './newChatWorkspacePick.js';
import { buildChatsListApiQuery, mergeChatListLoadQuery } from '../../../lib/chat-list-payload.js';
import {
  readChatLocalBootCache,
  shouldHydrateChatListFromBootCache,
  writeChatLocalBootCache,
} from './chatLocalBootCache.js';

function normalizePath(pathValue) {
  if (!pathValue || typeof pathValue !== 'string') return '';
  return pathValue.replace(/\\/g, '/').replace(/\/$/, '').trim();
}

export function createChatController(deps) {
  const {
    api,
    CHAT_BUFFER_MAX,
    LAST_CHAT_ID_KEY,
    getChats,
    getActiveChatId,
    setActiveChatId,
    getWorkspaces,
    setWorkspaces,
    getSelectedWorkspaceFile,
    setSelectedWorkspaceFile,
    getSelectedWorkspaceFolder,
    setSelectedWorkspaceFolder,
    getSelectedModel,
    setSelectedModel,
    readChatBufferForChatRestore,
    updateFolderSelect,
    renderModelSelectOptions,
    renderChatList,
    updateChatBarSelect,
    selectChat,
    syncBackgroundChatConnections,
    bindChatVisibilityAndReconnect,
    startChatBackgroundMonitor,
    startGlobalChatPingLoop,
    ensureChatConnection,
    teardownBlockedChatRuntime,
    teardownChatRuntime,
    openTerminal,
    getChatsForCurrentWorkspace,
    setChatStatus,
    onAfterBootHydrate,
    onAfterChatsLoad,
  } = deps;
  let chatsLoadPromise = null;
  /** @type {object | null} */
  let pendingLoadQuery = null;
  /** @type {Record<string, number>} */
  let archivedCounts = Object.create(null);
  /** Whether the cold-start local snapshot was already considered this page life. */
  let chatBootCacheHydrated = false;
  /** Last workspace context seen in the boot snapshot (used when the settings fetch is slow). */
  let rememberedWorkspaceContext = { workspaceFile: '', workspaceFolder: '' };

  function readHeaderWorkspaceContext() {
    if (typeof document === 'undefined') return { workspaceFile: '', workspaceFolder: '' };
    const trigger = document.getElementById('header-workspace-trigger');
    return {
      workspaceFile: typeof trigger?.dataset?.workspaceFile === 'string' ? trigger.dataset.workspaceFile : '',
      workspaceFolder: typeof trigger?.dataset?.workspaceFolder === 'string' ? trigger.dataset.workspaceFolder : '',
    };
  }

  /**
   * The server's active workspace arrives with the settings fetch, which is async. Restoring
   * the last known workspace from the boot snapshot lets `getChatsForCurrentWorkspace`
   * filter the cached list on the very first frame; the later settings fetch overwrites the
   * dataset when the value actually changed.
   *
   * @param {{ workspaceFile?: string, workspaceFolder?: string } | null | undefined} context
   */
  function headerWorkspaceMatches(context, header = readHeaderWorkspaceContext()) {
    if (!context) return true;
    return normalizePath(header.workspaceFile) === normalizePath(context.workspaceFile)
      && normalizePath(header.workspaceFolder) === normalizePath(context.workspaceFolder);
  }

  function restoreHeaderWorkspaceContext(context) {
    if (typeof document === 'undefined' || !context) return;
    const trigger = document.getElementById('header-workspace-trigger');
    if (!trigger?.dataset) return;
    if (trigger.dataset.workspaceFile || trigger.dataset.workspaceFolder) return;
    if (context.workspaceFile) trigger.dataset.workspaceFile = context.workspaceFile;
    if (context.workspaceFolder) trigger.dataset.workspaceFolder = context.workspaceFolder;
  }

  function readLastActiveChatId() {
    if (typeof localStorage === 'undefined') return '';
    try {
      return readStorageValueWithAlias(localStorage, LAST_CHAT_ID_KEY, '');
    } catch (_) {
      return '';
    }
  }

  function isEmbedModeActive() {
    return typeof document !== 'undefined' && document.body?.classList.contains('embed-mode');
  }

  /**
   * Cold-start fast path: seed the runtime list (and the last active chat) from the local
   * snapshot so the list and the active pane render before `GET /api/chats` answers. The
   * server response then reconciles the same row objects in place, so there is no flicker.
   * Runs at most once per page life.
   *
   * @param {{ preferChatId?: string, skipAutoSelect?: boolean, skipCache?: boolean }} [query]
   * @returns {boolean} whether cached rows were applied
   */
  function hydrateChatListFromLocalBootCache(query = {}) {
    const runtimeChats = getChats();
    const skipCache = query.skipCache === true;
    const cached = skipCache
      ? null
      : readChatLocalBootCache(typeof localStorage !== 'undefined' ? localStorage : null);
    const shouldHydrate = shouldHydrateChatListFromBootCache({
      alreadyHydrated: chatBootCacheHydrated,
      skipCache,
      runtimeChatCount: runtimeChats.length,
      cachedChatCount: cached ? cached.chats.length : 0,
    });
    chatBootCacheHydrated = true;
    if (!shouldHydrate || !cached) return false;
    if (getWorkspaces().length === 0 && cached.workspaces.length > 0) {
      setWorkspaces(cached.workspaces);
    }
    rememberedWorkspaceContext = {
      workspaceFile: cached.workspaceContext.workspaceFile,
      workspaceFolder: cached.workspaceContext.workspaceFolder,
    };
    const headerBeforeRestore = readHeaderWorkspaceContext();
    restoreHeaderWorkspaceContext(cached.workspaceContext);
    runtimeChats.length = 0;
    cached.chats.forEach((chat) => {
      chat._fromBootCache = true;
      runtimeChats.push(chat);
    });
    setActiveChatIdsForEviction(runtimeChats.map((chat) => chat.id));
    renderChatList();
    if (
      (headerBeforeRestore.workspaceFile || headerBeforeRestore.workspaceFolder)
      && !headerWorkspaceMatches(cached.workspaceContext, headerBeforeRestore)
    ) {
      refreshChatListForWorkspace();
    }
    const preferChatId = typeof query.preferChatId === 'string' ? query.preferChatId.trim() : '';
    if (preferChatId && !runtimeChats.some((chat) => chat.id === preferChatId)) {
      updateChatBarSelect();
      return true;
    }
    const visibleChats = runtimeChats.filter((chat) => !chat.archivedAt);
    let nextActiveId = '';
    if (preferChatId && runtimeChats.some((chat) => chat.id === preferChatId)) {
      nextActiveId = preferChatId;
    } else {
      const lastId = readLastActiveChatId() || cached.activeChatId;
      if (lastId && visibleChats.some((chat) => chat.id === lastId)) nextActiveId = lastId;
      else if (visibleChats.length > 0) nextActiveId = visibleChats[0].id;
    }
    if (nextActiveId) setActiveChatId(nextActiveId);
    updateChatBarSelect();
    const skipAutoSelect = query.skipAutoSelect === true || isEmbedModeActive();
    if (!skipAutoSelect && getActiveChatId()) selectChat(getActiveChatId());
    return true;
  }

  function teardownUnconfirmedBootCacheChat(chat) {
    if (typeof teardownChatRuntime === 'function') {
      teardownChatRuntime(chat);
      return;
    }
    if (typeof teardownBlockedChatRuntime === 'function') {
      teardownBlockedChatRuntime(chat);
    }
  }

  /** Snapshot the freshly reconciled list for the next cold start. Best effort. */
  function persistChatListBootCache() {
    if (typeof localStorage === 'undefined') return false;
    const headerContext = readHeaderWorkspaceContext();
    const workspaceContext = headerContext.workspaceFile || headerContext.workspaceFolder
      ? headerContext
      : rememberedWorkspaceContext;
    if (workspaceContext?.workspaceFile || workspaceContext?.workspaceFolder) {
      rememberedWorkspaceContext = {
        workspaceFile: workspaceContext.workspaceFile || '',
        workspaceFolder: workspaceContext.workspaceFolder || '',
      };
    }
    return writeChatLocalBootCache(localStorage, {
      chats: getChats(),
      workspaces: getWorkspaces(),
      activeChatId: getActiveChatId() || readLastActiveChatId(),
      workspaceContext,
    });
  }

  function renderWorkspacesSelects() {
    const workspaces = getWorkspaces();
    const workspaceSel = document.getElementById('chat-new-workspace-select');
    const folderSel = document.getElementById('chat-new-folder-select');
    const modelSel = document.getElementById('chat-new-model-select');
    if (workspaces.length === 0) {
      if (workspaceSel) workspaceSel.innerHTML = '';
      if (folderSel) folderSel.innerHTML = '';
      if (modelSel) {
        modelSel.innerHTML = `<option value="auto">${escapeHtml(t('workspace.none'))}</option>`;
      }
      return;
    }
    const trigger = document.getElementById('header-workspace-trigger');
    const nextWorkspaceFile = pickNewChatWorkspaceFile({
      workspaces,
      selectedWorkspaceFile: getSelectedWorkspaceFile() || '',
      headerWorkspaceFile: trigger?.dataset?.workspaceFile || '',
    });
    if (nextWorkspaceFile) setSelectedWorkspaceFile(nextWorkspaceFile);
    if (workspaceSel) {
      workspaceSel.innerHTML = workspaces
        .map((w) => {
          const key = workspaceListEntryKey(w);
          return (
            '<option value="' +
            escapeHtml(key) +
            '">' +
            escapeHtml(w.name) +
            ' (' +
            (w.folders || []).map((f) => f.name).join(', ') +
            ')</option>'
          );
        })
        .join('');
      workspaceSel.value = getSelectedWorkspaceFile() || '';
    }
    updateFolderSelect(getSelectedWorkspaceFile());
    if (folderSel) {
      const preferredFolder = getSelectedWorkspaceFolder() || '';
      const preferredOption = Array.from(folderSel.options).find(
        (option) => normalizePath(option.value) === normalizePath(preferredFolder)
      );
      if (preferredOption) {
        folderSel.value = preferredOption.value;
        setSelectedWorkspaceFolder(preferredOption.value);
      } else if (folderSel.value) {
        setSelectedWorkspaceFolder(folderSel.value);
      }
    }
    if (modelSel) modelSel.value = getSelectedModel() || 'auto';
    if (modelSel && typeof renderModelSelectOptions === 'function') {
      renderModelSelectOptions(modelSel, getSelectedModel() || 'auto');
    }
  }

  function loadWorkspaces() {
    return api.getWorkspaces().then((data) => {
      if (!data.ok || !Array.isArray(data.workspaces)) return;
      setWorkspaces(data.workspaces);
      renderWorkspacesSelects();
    });
  }

  function loadChatsFromServer(query = {}) {
    // Render the cached list (and open the last active chat from IndexedDB) before any
    // network wait; the request below only reconciles it.
    hydrateChatListFromLocalBootCache(query);
    if (typeof onAfterBootHydrate === 'function') {
      try {
        onAfterBootHydrate();
      } catch (_) {}
    }
    if (query.skipIfInFlight === true && chatsLoadPromise) {
      return chatsLoadPromise;
    }
    const skipAutoSelect = query.skipAutoSelect === true
      || (typeof document !== 'undefined' && document.body?.classList.contains('embed-mode'));
    const includeArchived = query.includeArchived === true;
    const apiQuery = buildChatsListApiQuery({
      includeArchived,
      pinnedTo: query.pinnedTo,
    });
    const preferChatId = typeof query.preferChatId === 'string' ? query.preferChatId.trim() : '';
    if (chatsLoadPromise) {
      pendingLoadQuery = mergeChatListLoadQuery(pendingLoadQuery || {}, query);
      const inFlight = chatsLoadPromise;
      return inFlight.then(() => {
        if (chatsLoadPromise) return chatsLoadPromise;
        const next = pendingLoadQuery;
        pendingLoadQuery = null;
        if (!next) return;
        return loadChatsFromServer(next);
      });
    }
    chatsLoadPromise = api.getChats(apiQuery).then((data) => {
      if (!data.ok || !Array.isArray(data.chats)) return;
      archivedCounts =
        data.archivedCounts && typeof data.archivedCounts === 'object'
          ? data.archivedCounts
          : Object.create(null);
      const chats = getChats();
      const runtimeById = new Map(chats.map((chat) => [chat.id, chat]));
      /** @type {object[]} Existing chats that flipped from non-blocking to blocking in this refresh. */
      const blockedTransitions = [];
      /** @type {object[]} Existing chats that flipped from blocking to non-blocking in this refresh. */
      const restoredTransitions = [];
      let serverChats = data.chats;
      if (
        data.linkedChat?.id
        && !serverChats.some((chat) => chat.id === data.linkedChat.id)
      ) {
        serverChats = [...serverChats, data.linkedChat];
      }
      const serverChatIds = new Set(serverChats.map((chat) => chat.id));
      const staleBootCacheChats = chats.filter(
        (chat) => chat?._fromBootCache === true && chat.id && !serverChatIds.has(chat.id)
      );
      for (const chat of staleBootCacheChats) {
        teardownUnconfirmedBootCacheChat(chat);
      }
      const nextChats = serverChats.map((serverChat) => {
        const existing = runtimeById.get(serverChat.id);
        if (existing) {
          delete existing._fromBootCache;
          const wasBlocked = isBlockingPersistedLocalChatHarnessState(existing);
          existing.title = serverChat.title;
          if (typeof serverChat.titleSource === 'string' && serverChat.titleSource) {
            existing.titleSource = serverChat.titleSource;
          } else {
            delete existing.titleSource;
          }
          existing.cursorSessionId = serverChat.cursorSessionId;
          existing.model = serverChat.model;
          existing.workspaceFile = serverChat.workspaceFile;
          existing.workspaceFolder = serverChat.workspaceFolder;
          existing.createdAt = serverChat.createdAt;
          existing.updatedAt = serverChat.updatedAt;
          existing.summaries = Array.isArray(serverChat.summaries)
            ? serverChat.summaries
            : (Array.isArray(existing.summaries) ? existing.summaries : []);
          existing.agentTransport = resolvePersistedLocalChatTransport(serverChat);
          existing.sdkMode = normalizeSdkMode(serverChat.sdkMode);
          existing.sdkUiMode = normalizeSdkUiMode(serverChat.sdkUiMode);
          existing.autoContextCompressionEnabled = serverChat.autoContextCompressionEnabled === true;
          existing.autoContextCompressionThreshold = Number.isFinite(
            Number(serverChat.autoContextCompressionThreshold)
          )
            ? Number(serverChat.autoContextCompressionThreshold)
            : 80;
          existing.autoContextCompressionReset = serverChat.autoContextCompressionReset !== false;
          if (serverChat.harnessState && typeof serverChat.harnessState === 'object') {
            existing.harnessState = serverChat.harnessState;
          } else {
            delete existing.harnessState;
          }
          if (!wasBlocked && isBlockingPersistedLocalChatHarnessState(existing)) {
            blockedTransitions.push(existing);
          } else if (wasBlocked && !isBlockingPersistedLocalChatHarnessState(existing)) {
            restoredTransitions.push(existing);
          }
          if (typeof serverChat.sdkAgentId === 'string' && serverChat.sdkAgentId.trim()) {
            existing.sdkAgentId = serverChat.sdkAgentId.trim();
          } else {
            delete existing.sdkAgentId;
          }
          if (typeof serverChat.todoId === 'string' && serverChat.todoId.trim()) {
            existing.todoId = serverChat.todoId.trim();
          } else {
            delete existing.todoId;
          }
          if (serverChat.isTemporary === true) {
            existing.isTemporary = true;
          } else {
            delete existing.isTemporary;
          }
          if (typeof serverChat.forkParentChatId === 'string' && serverChat.forkParentChatId.trim()) {
            existing.forkParentChatId = serverChat.forkParentChatId.trim();
          } else {
            delete existing.forkParentChatId;
          }
          if (typeof serverChat.forkKind === 'string' && serverChat.forkKind.trim()) {
            existing.forkKind = serverChat.forkKind.trim();
          } else {
            delete existing.forkKind;
          }
          if (typeof serverChat.widgetPinnedUrl === 'string' && serverChat.widgetPinnedUrl.trim()) {
            existing.widgetPinnedUrl = serverChat.widgetPinnedUrl.trim();
          } else {
            delete existing.widgetPinnedUrl;
          }
          if (typeof serverChat.archivedAt === 'string' && serverChat.archivedAt.trim()) {
            existing.archivedAt = serverChat.archivedAt.trim();
          } else {
            delete existing.archivedAt;
          }
          if (!existing._buffer) {
            const saved = readChatBufferForChatRestore(serverChat.id, true);
            if (saved && saved.length > 0) existing._buffer = saved.slice(-CHAT_BUFFER_MAX);
          }
          return existing;
        }
        const created = {
          id: serverChat.id,
          title: serverChat.title,
          titleSource: typeof serverChat.titleSource === 'string' ? serverChat.titleSource : undefined,
          cursorSessionId: serverChat.cursorSessionId,
          model: serverChat.model,
          workspaceFile: serverChat.workspaceFile,
          workspaceFolder: serverChat.workspaceFolder,
          createdAt: serverChat.createdAt,
          updatedAt: serverChat.updatedAt,
          summaries: Array.isArray(serverChat.summaries) ? serverChat.summaries : [],
          agentTransport: resolvePersistedLocalChatTransport(serverChat),
          sdkMode: normalizeSdkMode(serverChat.sdkMode),
          sdkUiMode: normalizeSdkUiMode(serverChat.sdkUiMode),
          autoContextCompressionEnabled: serverChat.autoContextCompressionEnabled === true,
          autoContextCompressionThreshold: Number.isFinite(
            Number(serverChat.autoContextCompressionThreshold)
          )
            ? Number(serverChat.autoContextCompressionThreshold)
            : 80,
          autoContextCompressionReset: serverChat.autoContextCompressionReset !== false,
        };
        if (serverChat.harnessState && typeof serverChat.harnessState === 'object') {
          created.harnessState = serverChat.harnessState;
        }
        if (typeof serverChat.sdkAgentId === 'string' && serverChat.sdkAgentId.trim()) {
          created.sdkAgentId = serverChat.sdkAgentId.trim();
        }
        if (typeof serverChat.todoId === 'string' && serverChat.todoId.trim()) {
          created.todoId = serverChat.todoId.trim();
        }
        if (serverChat.isTemporary === true) {
          created.isTemporary = true;
        }
        if (typeof serverChat.forkParentChatId === 'string' && serverChat.forkParentChatId.trim()) {
          created.forkParentChatId = serverChat.forkParentChatId.trim();
        }
        if (typeof serverChat.forkKind === 'string' && serverChat.forkKind.trim()) {
          created.forkKind = serverChat.forkKind.trim();
        }
        if (typeof serverChat.widgetPinnedUrl === 'string' && serverChat.widgetPinnedUrl.trim()) {
          created.widgetPinnedUrl = serverChat.widgetPinnedUrl.trim();
        }
        if (typeof serverChat.archivedAt === 'string' && serverChat.archivedAt.trim()) {
          created.archivedAt = serverChat.archivedAt.trim();
        }
        const saved = readChatBufferForChatRestore(created.id, true);
        if (saved && saved.length > 0) created._buffer = saved.slice(-CHAT_BUFFER_MAX);
        return created;
      });
      const liveOrphans = chats.filter((chat) => {
        if (!chat?.id) return false;
        if (chat._fromBootCache === true) return false;
        if (nextChats.some((entry) => entry.id === chat.id)) return false;
        if (chat.pane) return true;
        const readyState = chat.ws?.readyState;
        return readyState === 0 || readyState === 1;
      });
      if (liveOrphans.length > 0) {
        nextChats.push(...liveOrphans);
      }
      chats.length = 0;
      nextChats.forEach((chat) => chats.push(chat));
      setActiveChatIdsForEviction(nextChats.map((c) => c.id));
      void migrateChatStorageOutOfLocalStorage(nextChats.map((c) => c.id));
      renderChatList();
      const visibleChats = nextChats.filter((chat) => !chat.archivedAt);
      const activeIdBeforeSelect = getActiveChatId();
      if (
        activeIdBeforeSelect
        && staleBootCacheChats.some((chat) => chat.id === activeIdBeforeSelect)
      ) {
        const lastId = typeof localStorage !== 'undefined'
          ? readStorageValueWithAlias(localStorage, LAST_CHAT_ID_KEY, '')
          : '';
        const validLast = lastId && visibleChats.some((chat) => chat.id === lastId);
        if (validLast) {
          setActiveChatId(lastId);
        } else if (visibleChats.length > 0) {
          setActiveChatId(visibleChats[0].id);
        } else {
          setActiveChatId(null);
        }
      }
      if (preferChatId && nextChats.some((chat) => chat.id === preferChatId)) {
        setActiveChatId(preferChatId);
      } else if (!skipAutoSelect) {
        const lastId = typeof localStorage !== 'undefined'
          ? readStorageValueWithAlias(localStorage, LAST_CHAT_ID_KEY, '')
          : null;
        const validLast = lastId && visibleChats.some((chat) => chat.id === lastId);
        if (validLast) {
          setActiveChatId(lastId);
        } else if (visibleChats.length > 0 && !visibleChats.some((chat) => chat.id === getActiveChatId())) {
          setActiveChatId(visibleChats[0].id);
        }
      }
      updateChatBarSelect();
      if (!skipAutoSelect && getActiveChatId()) selectChat(getActiveChatId());
      persistChatListBootCache();
      // A live/resume list refresh mutates an already-hydrated chat in place, so a
      // `skipAutoSelect` pass never reaches selectChat/openTerminal. When a chat just
      // turned blocking, swap any mounted SDK pane for the blocked notice and tear its
      // live socket down. Only a real non-blocking -> blocking edge triggers this, so
      // unblocked/not_loaded rows keep their existing lifecycle untouched.
      for (const chat of blockedTransitions) {
        if (chat.pane?.isConnected === true && typeof openTerminal === 'function') {
          openTerminal(chat);
        }
        if (typeof teardownBlockedChatRuntime === 'function') {
          teardownBlockedChatRuntime(chat);
        } else if (typeof ensureChatConnection === 'function') {
          ensureChatConnection(chat);
        }
      }
      // A chat that turned non-blocking while its minimal blocked notice was mounted must
      // be rebuilt through the ordinary pane path: a mounted notice is a connected pane, so
      // `openTerminal` would otherwise return early. `openTerminal` removes the stale notice
      // and rebuilds exactly one normal pane. Only a real blocking -> non-blocking edge with
      // a mounted pane is queued — never a routine non-blocking refresh or a new chat.
      for (const chat of restoredTransitions) {
        if (chat.pane?.isConnected === true && typeof openTerminal === 'function') {
          openTerminal(chat);
        }
      }
      syncBackgroundChatConnections();
      bindChatVisibilityAndReconnect();
      startChatBackgroundMonitor();
      startGlobalChatPingLoop();
    }).catch((err) => {
      console.warn('[chat] list load failed:', err?.message || err);
    }).finally(() => {
      chatsLoadPromise = null;
      // A push-inbox record for a chat that was not in the (often boot-cache
      // seeded) list must be replayed once the server list has reconciled, so the
      // chat row exists and the record is not lost.
      if (typeof onAfterChatsLoad === 'function') {
        try {
          onAfterChatsLoad();
        } catch (_) {}
      }
    });
    return chatsLoadPromise;
  }

  function isChatsListLoadInFlight() {
    return chatsLoadPromise != null;
  }

  function selectChatController(id) {
    const chats = getChats();
    const chat = chats.find((c) => c.id === id);
    if (chat) openTerminal(chat);
    setActiveChatId(id);
    if (chat?.cursorSessionId && chat.pane) ensureChatConnection(chat);
    if (typeof localStorage !== 'undefined') {
      try {
        writeStorageValueWithAlias(localStorage, LAST_CHAT_ID_KEY, id);
      } catch {}
    }
    document
      .querySelectorAll('.chat-tab-pane')
      .forEach((p) => p.classList.toggle('active', p.dataset.chatId === id));
    updateChatBarSelect();
    setChatStatus(chat ? chat._connectionStatus || 'disconnected' : 'disconnected');
  }

  function refreshChatListForWorkspace() {
    const filtered = getChatsForCurrentWorkspace();
    const activeChatId = getActiveChatId();
    const stillVisible = activeChatId && filtered.some((c) => c.id === activeChatId);
    if (!stillVisible) {
      setActiveChatId(filtered.length ? filtered[0].id : null);
      selectChat(getActiveChatId());
      return;
    }
    updateChatBarSelect();
    if (!activeChatId) return;
    const chat = getChats().find((c) => c.id === activeChatId);
    if (!chat) return;
    setChatStatus(chat._connectionStatus || 'disconnected');
  }

  function initChatPanelBridge() {
    const workspaceSel = document.getElementById('chat-new-workspace-select');
    const folderSel = document.getElementById('chat-new-folder-select');
    const modelSel = document.getElementById('chat-new-model-select');
    if (workspaceSel) {
      workspaceSel.addEventListener('change', () => {
        setSelectedWorkspaceFile(workspaceSel.value || null);
        updateFolderSelect(getSelectedWorkspaceFile());
        const nextFolderSel = document.getElementById('chat-new-folder-select');
        setSelectedWorkspaceFolder(nextFolderSel?.value || null);
      });
    }
    if (folderSel) {
      folderSel.addEventListener('change', () => {
        setSelectedWorkspaceFolder(folderSel.value || null);
      });
    }
    if (modelSel) {
      modelSel.addEventListener('change', () => {
        setSelectedModel(modelSel.value || 'auto');
      });
    }
  }

  return {
    loadWorkspaces,
    renderWorkspacesSelects,
    loadChatsFromServer,
    isChatsListLoadInFlight,
    getArchivedCounts: () => archivedCounts,
    selectChat: selectChatController,
    refreshChatListForWorkspace,
    initChatPanelBridge,
  };
}
