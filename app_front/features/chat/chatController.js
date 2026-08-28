import { normalizeSdkMode } from '../../../lib/sdk/sdk-mode.js';
import { normalizeSdkUiMode } from '../../../lib/sdk/sdk-ui-mode.js';
import { getChatAgentTransport } from '../../../lib/agent-transport.js';
import { setActiveChatIdsForEviction } from '../../lib/sdk-chat-history-store.js';
import { migrateChatStorageOutOfLocalStorage } from '../../lib/chatStorageMigration.js';
import { readStorageValueWithAlias, writeStorageValueWithAlias } from '../../lib/storageKeyAlias.js';
import { t } from '../../i18n/index.js';
import { escapeHtml } from './chatHtmlUtils.js';

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
    openTerminal,
    getChatsForCurrentWorkspace,
    setChatStatus,
  } = deps;
  let chatsLoadPromise = null;

  function renderWorkspacesSelects() {
    const workspaces = getWorkspaces();
    const workspaceSel = document.getElementById('chat-new-workspace-select');
    const folderSel = document.getElementById('chat-new-folder-select');
    const modelSel = document.getElementById('chat-new-model-select');
    if (workspaces.length === 0) {
      setSelectedWorkspaceFile(null);
      setSelectedWorkspaceFolder(null);
      if (workspaceSel) workspaceSel.innerHTML = '';
      if (folderSel) folderSel.innerHTML = '';
      if (modelSel) {
        modelSel.innerHTML = `<option value="auto">${escapeHtml(t('workspace.none'))}</option>`;
      }
      return;
    }
    const trigger = document.getElementById('header-workspace-trigger');
    const headerWorkspaceFile = trigger?.dataset?.workspaceFile || '';
    const selectedWorkspaceFile = getSelectedWorkspaceFile() || '';
    const hasSelectedWorkspace = workspaces.some(
      (item) => normalizePath(item.workspaceFile) === normalizePath(selectedWorkspaceFile)
    );
    const hasHeaderWorkspace = workspaces.some(
      (item) => normalizePath(item.workspaceFile) === normalizePath(headerWorkspaceFile)
    );
    const nextWorkspaceFile = hasSelectedWorkspace
      ? selectedWorkspaceFile
      : hasHeaderWorkspace
        ? headerWorkspaceFile
        : workspaces[0].workspaceFile;

    setSelectedWorkspaceFile(nextWorkspaceFile);
    if (workspaceSel) {
      workspaceSel.innerHTML = workspaces
        .map(
          (w) =>
            '<option value="' +
            escapeHtml(w.workspaceFile) +
            '">' +
            escapeHtml(w.name) +
            ' (' +
            (w.folders || []).map((f) => f.name).join(', ') +
            ')</option>'
        )
        .join('');
      workspaceSel.value = getSelectedWorkspaceFile();
    }
    updateFolderSelect(getSelectedWorkspaceFile());
    if (folderSel) {
      const preferredFolder = getSelectedWorkspaceFolder() || '';
      const preferredOption = Array.from(folderSel.options).find(
        (option) => normalizePath(option.value) === normalizePath(preferredFolder)
      );
      if (preferredOption) {
        folderSel.value = preferredOption.value;
      }
      setSelectedWorkspaceFolder(folderSel.value || null);
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
    const skipAutoSelect = query.skipAutoSelect === true
      || (typeof document !== 'undefined' && document.body?.classList.contains('embed-mode'));
    const includeArchived = query.includeArchived !== false;
    const apiQuery = {};
    if (typeof query.pinnedTo === 'string' && query.pinnedTo.trim()) {
      apiQuery.pinnedTo = query.pinnedTo.trim();
    }
    if (includeArchived) {
      apiQuery.includeArchived = true;
    }
    const preferChatId = typeof query.preferChatId === 'string' ? query.preferChatId.trim() : '';

    // Do not coalesce different loads — a stale in-flight GET must not win over a fresh pinnedTo/select.
    if (chatsLoadPromise) {
      return chatsLoadPromise.then(() => loadChatsFromServer(query));
    }

    chatsLoadPromise = api.getChats(apiQuery).then((data) => {
      if (!data.ok || !Array.isArray(data.chats)) return;
      const chats = getChats();
      const runtimeById = new Map(chats.map((chat) => [chat.id, chat]));
      let serverChats = data.chats;
      if (
        data.linkedChat?.id
        && !serverChats.some((chat) => chat.id === data.linkedChat.id)
      ) {
        serverChats = [...serverChats, data.linkedChat];
      }
      const nextChats = serverChats.map((serverChat) => {
        const existing = runtimeById.get(serverChat.id);
        if (existing) {
          existing.title = serverChat.title;
          existing.cursorSessionId = serverChat.cursorSessionId;
          existing.model = serverChat.model;
          existing.workspaceFile = serverChat.workspaceFile;
          existing.workspaceFolder = serverChat.workspaceFolder;
          existing.createdAt = serverChat.createdAt;
          existing.updatedAt = serverChat.updatedAt;
          existing.summaries = Array.isArray(serverChat.summaries) ? serverChat.summaries : [];
          existing.agentTransport = getChatAgentTransport(serverChat);
          existing.sdkMode = normalizeSdkMode(serverChat.sdkMode);
          existing.sdkUiMode = normalizeSdkUiMode(serverChat.sdkUiMode);
          existing.autoContextCompressionEnabled = serverChat.autoContextCompressionEnabled === true;
          existing.autoContextCompressionThreshold = Number.isFinite(
            Number(serverChat.autoContextCompressionThreshold)
          )
            ? Number(serverChat.autoContextCompressionThreshold)
            : 80;
          existing.autoContextCompressionReset = serverChat.autoContextCompressionReset !== false;
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
          cursorSessionId: serverChat.cursorSessionId,
          model: serverChat.model,
          workspaceFile: serverChat.workspaceFile,
          workspaceFolder: serverChat.workspaceFolder,
          createdAt: serverChat.createdAt,
          updatedAt: serverChat.updatedAt,
          summaries: Array.isArray(serverChat.summaries) ? serverChat.summaries : [],
          agentTransport: getChatAgentTransport(serverChat),
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
      chats.length = 0;
      nextChats.forEach((chat) => chats.push(chat));
      setActiveChatIdsForEviction(nextChats.map((c) => c.id));
      void migrateChatStorageOutOfLocalStorage(nextChats.map((c) => c.id));
      renderChatList();
      const visibleChats = nextChats.filter((chat) => !chat.archivedAt);
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
      syncBackgroundChatConnections();
      bindChatVisibilityAndReconnect();
      startChatBackgroundMonitor();
      startGlobalChatPingLoop();
    }).finally(() => {
      chatsLoadPromise = null;
    });

    return chatsLoadPromise;
  }

  function selectChatController(id) {
    const chats = getChats();
    const chat = chats.find((c) => c.id === id);
    if (chat && !chat.pane) openTerminal(chat);
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
    selectChat: selectChatController,
    refreshChatListForWorkspace,
    initChatPanelBridge,
  };
}
