import { openTerminal } from './chatPane.js';
import { syncNewChatWorktreeRow } from './newChatWorktreeRow.js';
import { bindChatPanelWindowEvents } from './chatPanelWindowEvents.js';
import { bindChatPanelModals } from './chatPanelModalWiring.js';
import { bindChatPanelHarnessEvents } from './chatPanelHarnessEvents.js';
import { bindChatPanelToolbar } from './chatPanelToolbar.js';
import {
  applySendFieldPreference,
  bindChatPanelSettings,
  isChatSettingsControlOnVisibleTab,
} from './chatPanelSettings.js';
import { createAppChatTransport } from '../services/chatTransportSetup.js';
import { initChatSyncServices } from '../services/chatSyncSetup.js';
import { installChatMetadataPersistence } from '../services/chatMetadataPersistence.js';
import { renderChatContextPlanLimitsHtml } from '../chatContextPlanLimitsView.js';
import {
  renderChatContextBreakdownHtml,
  renderChatContextCacheHtml,
} from '../chatContextBreakdownView.js';
import { renderChatContextCacheCountdownHtml } from '../chatContextCacheCountdownView.js';
import {
  bindChatContextCacheChart,
  mergeSeriesIntoContextSnapshot,
  renderChatContextCacheChartHtml,
} from '../chatContextCacheChartView.js';
/**
 * Chat panel: chat list, openTerminal(chat), ensureChatConnection, closeChat, selectChat, newChat, model select, send-keys.
 */
import * as api from '../../../core/api/index.js';
import { appLogger } from '../../../core/logging/logger.js';
import { CHAT_BUFFER_MAX, CHAT_BUFFER_LOCALSTORAGE_PREFIX } from '../../../config.js';
import { setChatStatus } from '../../connection/connectionStatus.js';
import { setChatAutoArchiveFavoriteResolver } from '../chatAutoArchiveConfig.js';
import { t, getCurrentLang } from '../../../i18n/index.js';
import { initDropdown } from '../../../lib/dropdown.js';
import { createFavoritesStore } from '../../../lib/favorites.js';
import { chatPresetsStore } from '../chatPresets.js';
import { clearChatBuffer } from '../../../lib/chatBufferStore.js';
import { maybeRecoverMissedSdkRunOutcome } from '../sdkRunOutcomeRecovery.js';
import * as chatStore from '../chatStore.js';
import {
  initChatServerRecovery,
  dismissStaleReconnectUiOnResume,
} from '../chatServerRecovery.js';
import { registerPageResumeCleanupHook } from '../../../lib/pageResumeCleanup.js';
import { initChatContextCompressionRecovery } from '../chatContextCompressionRecovery.js';
import { formatContextTokenCount } from '../../../../lib/sdk/sdk-context-advisory.ts';
import { invalidateAgentPresenceTrust } from '../chatHistorySyncPoll.js';
import { clearSdkChatHistory } from '../../../lib/sdk-chat-history-store.js';
import { createChatView } from '../chatView.js';
import { createChatController } from '../chatController.js';
import { createChatArchiveCatalog } from '../chatArchiveCatalog.js';
import { registerChatSessionBoundaryListFreshnessHook } from '../chatSessionBoundary.js';
import { getChatMetadataIdbOperationEpoch } from '../chatMetadataIdb.js';
import { getChatActivityStore } from '../chatActivityStore.js';
import { getChatPersistenceQueue } from '../chatPersistenceQueue.js';
import { normalizeModelValue, saveLastSelectedModel } from '../chatSettingsPrefs.js';
import { escapeHtml } from '../chatHtmlUtils.js';
import { createChatTitleFork } from '../chatTitleFork.js';
import { createChatModelSelect } from '../chatModelSelect.js';
import { createChatDiagnostics } from '../chatDiagnostics.js';
import { createChatContextMeter } from '../chatContextMeter.js';
import { initAgentWakeLock } from '../../pwa/wakeLock.js';
import { debugAutoTitle, debugFork } from '../services/chatDebugLogs.js';
import {
  isEmbedWidgetMode,
  refreshLocalChatHarnessOptions,
} from '../services/newChatHarnessState.js';
import {
  refreshModelCatalogFromServer,
  reloadOpenCodeModelsCatalog,
  runNewChatHarnessStatusCheck,
} from '../services/newChatHarnessStatus.js';
import {
  closeChatContextDetailsModal,
  formatContextDetailsPercent,
  formatContextDetailsUpdatedAt,
  renderContextQualityRows,
  resolveContextDetailsSourceLabel,
  resolveContextDetailsTransportLabel,
  resolveContextDetailsWarningLabel,
} from './chatContextDetails.js';
import { closeChatSettingsModal } from './chatSettingsModal.js';
import {
  closeNewChatModal,
  isNewChatModalOpen,
  openNewChatModal,
} from './newChatModal.js';
import { chatRuntime, chats } from '../state/chatRuntimeState.js';
import { newChatModalState } from '../state/newChatModalState.js';
import { registerChatHost } from '../services/chatHost.js';
import { createPageLinkedChat, requestWidgetChatBinding } from '../services/chatWidgetPin.js';
import {
  onChatComposerMention,
  openTodoMentionFromMenu,
  sendTextToAgent,
} from '../services/chatComposer.js';
import {
  getArchivedChatsForCurrentWorkspace,
  getChatsForCurrentWorkspace,
  getWorkspaceContextForChat,
} from '../services/chatWorkspaceContext.js';
import {
  canPinChatToUrl,
  getChatAgentState,
  getSidebarChatStateMeta,
  notifySidebar,
  toggleChatUrlPinById,
} from '../services/chatSidebarHooks.js';
import {
  mountSdkModeBarInToolbar,
  setChatModel,
  syncChatSdkModeUi,
} from '../services/chatSdkMode.js';
import {
  forceReconnectChat,
  isAutoContextCompressionEnabled,
  maybeScheduleAutoContextCompression,
  normalizeAutoContextCompressionThreshold,
  runIntentionalSummary,
  setTransientChatActionHint,
  shouldResetAfterContextCompression,
} from '../services/chatContextCompression.js';
import {
  closeChatActionsModal,
  closeChatListModal,
  getChatListAgentState,
  renderChatList,
  renderChatTerminalState,
  scheduleChatListStateRefresh,
  setAgentState,
  updateChatBarSelect,
} from '../services/chatSidebarState.js';
import {
  closeChat,
  getActiveSendInput,
  teardownChatRuntime,
} from '../services/chatLifecycle.js';
import {
  maybeAutoNameNewChat,
  processAgentOutput,
  readChatBufferForChatRestore,
  readChatBufferFromLocalStorage,
} from '../services/chatTitlesOutput.js';
import {
  adoptCreatedChat,
  dismissTemporaryForkChat,
  getWorkspaceDefaultFolder,
  openCreatedForkChat,
  openTemporaryForkChat,
} from '../services/chatCreation.js';
import {
  consumePushInboxFromStore,
  syncSdkHistoryOnResume,
} from '../services/chatHistorySync.js';
import {
  loadChatsFromServer,
  loadWorkspaces,
  markChatSeenIfUnread,
  selectChat,
} from '../services/chatSelection.js';
import {
  closeChatDeleteConfirmModal,
  requestArchiveChat,
  requestArchiveChatConfirmed,
  requestDeleteChat,
  requestRestoreChat,
  settleArchiveConfirm,
} from '../services/chatDeleteArchive.js';
export { ensureEmbedChat, openEmbedGeneralChat, expandSidebarWorkspaceSearchPool, getArchivedCounts, loadChatsFromServer, loadWorkspaces, notifySidebarSearchHydration, openChatFromNotification, selectChat, selectChatFromWidgetHost, setForcedEmbedChatId, syncEmbedChatToHostPage } from '../services/chatSelection.js';
export { applyEnabledModelsForHarness, setWorkspaceCloneFolderLookup, setWorkspacePreferredFolderLookup } from '../services/chatWorkspaceContext.js';
export { canPinChatToUrl, closeChatSidebar, getActiveChatIdValue, getChatFavoritesStore, getChatLastUsedAtPublic, getChatListAgentStatePublic, getChatsList, getTerminalStateMetaPublic, getWorkspacesList, openChatSidebar, setSidebarCloseHook, setSidebarOpenHook, setSidebarRenderHook, setSidebarTransientPatchHook, setWorkspaceSwitchHook, toggleChatUrlPinById } from '../services/chatSidebarHooks.js';
export { refreshSidebarChatStates, scheduleChatListStateRefreshAll } from '../services/chatSidebarState.js';
export { requestArchiveChat, requestArchiveChatConfirmed, requestArchiveSettledChats, requestDeleteChat, requestRestoreChat } from '../services/chatDeleteArchive.js';
export { closeChat, copyActiveChatToClipboard, getActiveChatBufferTail, getActiveChatTerminalState, getActiveSendBar, getActiveSendInput, teardownChatRuntime, waitForEmbedBootReady } from '../services/chatLifecycle.js';
export { openTodoAgentChat } from '../services/chatCreation.js';
export { setActiveChatSdkMode } from '../services/chatSdkMode.js';
export { sendKeySequenceToActiveChat, sendNavKeyToActiveChat } from '../services/chatComposer.js';
export { initAutoNameChatSetting, readChatBufferForChatRestore } from '../services/chatTitlesOutput.js';
export { createPageLinkedChat, resolvePagePinStateForUrl } from '../services/chatWidgetPin.js';
import { chatShell } from '../state/chatShellState.js';
// Custom elements used by the chat panel: side-effect imports register them
// (dropped once by a refactor, which left the chat toolbar empty).
import '../../../components/chat/cr-sdk-mode-bar.js';
import '../../../components/chat/cr-chat-diag.js';
import '../cr-chat-context-panel.js';
export { refreshRelatedChatHistoryLinks } from '../services/harnessSwitch.js';
export { openNewChatModal, openTodoAgentStartModal } from './newChatModal.js';
export { createVoiceChat, listVoiceWorkspaces, switchVoiceWorkspace, listVoiceFolders, switchVoiceFolder, closeVoiceChat, renameVoiceChat } from '../services/voiceWorkspaces.js';
export { listVoiceModels, setVoiceChatModel, switchVoiceHarness, forkVoiceChat } from '../services/voiceChats.js';
const LAST_CHAT_ID_KEY = 'cretli-last-chat-id';
const chatFavorites = createFavoritesStore('cretli-favorites-chats');
// Starred chats are skipped by the auto-archive sweep, so the sidebar countdown
// must not warn about them either.
setChatAutoArchiveFavoriteResolver((chatId) => chatFavorites.isFavorite(chatId));
const chatPresets = chatPresetsStore;
function getChatLastUsedAt(chatId) {
  return chatStore.getChatLastUsedAt(chatId);
}

function recordChatLastUsed(chatId) {
  chatStore.recordChatLastUsed(chatId);
}

function getChatActivityAt(chat) {
  return chatStore.getChatActivityAt(chat, getChatLastUsedAt);
}

function recordChatActivity(chatId) {
  chatStore.recordChatActivity(chatId);
}

function getResizeColsRows(cols, rows) {
  return chatStore.getResizeColsRows(cols, rows);
}

/**
 * Clear all local data tied to a chat (localStorage).
 * Single place for every key — content buffer, etc.
 * @param {string} id - chat id (uuid)
 */
function clearChatLocalData(id) {
  clearChatBuffer(id, CHAT_BUFFER_LOCALSTORAGE_PREFIX);
  chatStore.clearChatLocalData(id);
  void clearSdkChatHistory(id).catch(() => {});
}

function readChatDraft(id) {
  return chatStore.readChatDraft(id);
}

function writeChatDraft(id, value) {
  chatStore.writeChatDraft(id, value);
}

function getSkipChatDeleteConfirm() {
  return chatStore.getSkipChatDeleteConfirm();
}

function setSkipChatDeleteConfirm(value) {
  chatStore.setSkipChatDeleteConfirm(value);
}

function getSkipChatArchiveConfirm() {
  return chatStore.getSkipChatArchiveConfirm();
}

function setSkipChatArchiveConfirm(value) {
  chatStore.setSkipChatArchiveConfirm(value);
}

/** Delay (ms) before sending Enter after text — shared by the Send field and the title request. */
const SEND_ENTER_DELAY_MS = 80;
/** Short margin after xterm focus before sending a bare Enter. */
const ENTER_FOCUS_DELAY_MS = 35;

if (typeof window !== 'undefined') {
  console.log(
    '[cretli] Chat loaded. Logs: auto-title ?debug | fork ?debug-fork | status ?debug-status'
  );
}

export {
  getAutoNameChatEnabled,
  setAutoNameChatEnabled,
  getAutoUpdateChatTitleEnabled,
  setAutoUpdateChatTitleEnabled,
  getSkipCatchUpOnResume,
  setSkipCatchUpOnResume,
  getMaintainSessionsEnabled,
  setMaintainSessionsEnabled,
  getConnectAllChatsOnStartEnabled,
  setConnectAllChatsOnStartEnabled,
  getChatCanvasAddonEnabled,
  setChatCanvasAddonEnabled,
  getReadChatBufferFromLocalStorageEnabled,
  setReadChatBufferFromLocalStorageEnabled,
} from '../chatSettingsPrefs.js';
export { escapeHtml } from '../chatHtmlUtils.js';

function startGlobalChatPingLoop() {
  chatTransport.startGlobalChatPingLoop();
}

function startChatBackgroundMonitor() {
  chatTransport.startChatBackgroundMonitor();
}

function bindChatVisibilityAndReconnect() {
  chatTransport.bindChatVisibilityAndReconnect();
}

function syncBackgroundChatConnections() {
  chatTransport.syncBackgroundChatConnections();
}

function ensureChatConnection(chat) {
  requestWidgetChatBinding(chat);
  chatTransport.ensureChatConnection(chat);
}

if (typeof document !== 'undefined') {
  document.addEventListener('input', onChatComposerMention, true);
  document.addEventListener('keyup', onChatComposerMention, true);
  document.addEventListener('click', onChatComposerMention, true);
  document.addEventListener('cretli-open-todo-mention', openTodoMentionFromMenu);
  document.addEventListener('cretli-open-todo', (event) => {
    const todoId = String(event?.detail?.todoId || '').trim();
    if (!todoId) return;
    void import('../../todo/index.js').then((mod) => mod.openTodo(todoId));
  });
}
api.getSettings().then((data) => {
  if (data?.sdkRoomBus === 'redis') chatShell.sdkRoomBusMode = 'redis';
}).catch(() => {});
function initChatModelSelectApi() {
  chatRuntime.chatModelSelectApi = createChatModelSelect({
    getActiveChatId: () => chatRuntime.activeChatId,
    getChats: () => chats,
    getChatsForCurrentWorkspace,
    getTerminalStateMeta: getSidebarChatStateMeta,
    getSelectedModel: () => chatRuntime.selectedModel,
    syncChatSdkModeUi,
  });
}

function initChatDiagnosticsApi() {
  const contextMeterApi = createChatContextMeter({
    t,
    maybeScheduleAutoContextCompression,
    runIntentionalSummary,
  });
  const diagnosticsApi = createChatDiagnostics({
    api,
    appLogger,
    t,
    getActiveChatId: () => chatRuntime.activeChatId,
    updateChatContextMeter: contextMeterApi.updateChatContextMeter,
    resolveContextMeterModelId: contextMeterApi.resolveContextMeterModelId,
    renderChatTerminalState,
    ensureChatConnection: (chat) => chatTransport.ensureChatConnection(chat),
    setTransientChatActionHint,
    maybeRecoverMissedSdkRunOutcome,
  });
  chatRuntime.chatDiagnosticsApi = {
    ...contextMeterApi,
    ...diagnosticsApi,
  };
}

function initChatTitleForkApi() {
  const apiBundle = createChatTitleFork({
    api,
    appLogger,
    getActiveChatId: () => chatRuntime.activeChatId,
    getChats: () => chats,
    sendTextToAgent,
    getActiveSendInput,
    debugFork,
    debugAutoTitle,
    getWorkspaceContextForChat,
    readChatBufferFromLocalStorage,
    renderChatList,
    openTemporaryForkChat,
    dismissTemporaryForkChat,
  });
  chatShell.requestAutoTitleFromAgent = apiBundle.requestAutoTitleFromAgent;
  chatShell.requestTitleFromFork = apiBundle.requestTitleFromFork;
  chatShell.requestSummaryFromFork = apiBundle.requestSummaryFromFork;
  chatShell.requestSummaryFromForkAsync = apiBundle.requestSummaryFromForkAsync;
  chatRuntime.resolveChatTextForFork = apiBundle.resolveChatTextForFork;
}

/** Mounted chat panes kept for instant switching back (a re-mount replays the whole history). */
const RETAINED_CHAT_PANE_LIMIT = 4;

const chatTransport = createAppChatTransport({ getChatActivityAt, getResizeColsRows, setLaunchCommand });

function appendChatRecoveryNotice(chat, text, _tone = 'warn') {
  if (!chat?._sdkRichView) return;
  chat._sdkRichView.appendMetaNotice(text);
}

initChatServerRecovery({
  getChats: () => chats,
  getActiveChatId: () => chatRuntime.activeChatId,
  ensureChatConnection: chatTransport.ensureChatConnection,
  forceReconnectChat,
  syncBackgroundChatConnections,
  syncSdkHistoryOnResume,
  appendRecoveryNotice: appendChatRecoveryNotice,
  onServerRestart: () => invalidateAgentPresenceTrust(),
  appLogger,
});
registerPageResumeCleanupHook(dismissStaleReconnectUiOnResume);

initChatContextCompressionRecovery({
  setAgentState,
  ensureChatConnection: chatTransport.ensureChatConnection,
  syncBackgroundChatConnections,
  forceReconnectChat,
  appLogger,
});

const chatView = createChatView({
  initDropdown,
  chatFavorites,
  getChats: () => chats,
  getChatsForCurrentWorkspace,
  getArchivedChatsForCurrentWorkspace,
  getActiveChatId: () => chatRuntime.activeChatId,
  getChatLastUsedAt,
  getChatAgentState,
  getTerminalStateMeta: getSidebarChatStateMeta,
  escapeHtml,
  selectChat,
  requestDeleteChat,
  requestArchiveChat: requestArchiveChatConfirmed,
  requestRestoreChat,
  refreshModelSelectLabels: () => chatRuntime.chatModelSelectApi?.refreshModelSelectLabels(),
  onFavoritesChanged: renderChatList,
  isEmbedMode: () => typeof document !== 'undefined' && document.body?.classList.contains('embed-mode'),
  canPinChatToUrl,
  toggleChatUrlPinById,
  openNewChatModal,
  hasPendingRemoteHistory: (chat) => chat?._pendingRemoteHistory === true,
  getPendingRemoteHistoryLabel: () => t('chat.pendingRemoteHistory'),
});
initChatSyncServices({ chatView, getChatController: () => chatController });

const chatArchiveCatalog = createChatArchiveCatalog({
  getChats: () => chats,
  getSession: () => getChatActivityStore().getSession(),
  getIdbEpoch: () => getChatMetadataIdbOperationEpoch(),
  onHydrated: () => renderChatList(),
});

const chatController = createChatController({
  api,
  CHAT_BUFFER_MAX,
  LAST_CHAT_ID_KEY,
  getChats: () => chats,
  getActiveChatId: () => chatRuntime.activeChatId,
  setActiveChatId: (nextId) => {
    chatRuntime.activeChatId = nextId;
  },
  getWorkspaces: () => chatRuntime.workspaces,
  setWorkspaces: (next) => {
    chatRuntime.workspaces = next;
  },
  getSelectedWorkspaceFile: () => chatRuntime.selectedWorkspaceFile,
  setSelectedWorkspaceFile: (next) => {
    chatRuntime.selectedWorkspaceFile = next;
  },
  getSelectedWorkspaceFolder: () => chatRuntime.selectedWorkspaceFolder,
  setSelectedWorkspaceFolder: (next) => {
    chatRuntime.selectedWorkspaceFolder = next;
  },
  getSelectedModel: () => chatRuntime.selectedModel,
  setSelectedModel: (next) => {
    chatRuntime.selectedModel = normalizeModelValue(next);
    saveLastSelectedModel(chatRuntime.selectedModel);
  },
  readChatBufferForChatRestore,
  updateFolderSelect,
  renderModelSelectOptions: (selectEl, selectedValue) =>
    chatRuntime.chatModelSelectApi?.renderModelSelectOptions(selectEl, selectedValue),
  renderChatList,
  updateChatBarSelect,
  selectChat,
  syncBackgroundChatConnections,
  bindChatVisibilityAndReconnect,
  startChatBackgroundMonitor,
  startGlobalChatPingLoop,
  ensureChatConnection,
  teardownBlockedChatRuntime: chatTransport.teardownBlockedChatRuntime,
  teardownChatRuntime,
  openTerminal,
  getChatsForCurrentWorkspace,
  setChatStatus,
  onAfterBootHydrate: consumePushInboxFromStore,
  onAfterChatsLoad: consumePushInboxFromStore,
  onPresenceHydrate: (dirtyIds) => scheduleChatListStateRefresh(dirtyIds),
  scheduleBootCachePersist: () => {
    getChatPersistenceQueue()?.markBootCacheDirty();
  },
  getBootMetadataAdapter: () => chatMetadataPersistenceAdapter,
  getBootIdbEpoch: () => getChatMetadataIdbOperationEpoch(),
  getBootActivitySession: () => getChatActivityStore().getSession(),
  onArchiveCatalogHydrate: () => chatArchiveCatalog.hydrateMissingArchiveIntoRuntime(),
  invalidateArchiveCatalog: () => chatArchiveCatalog.invalidateIdbCache(),
});

registerChatSessionBoundaryListFreshnessHook(() => chatController.invalidateListLoadFreshness());
const chatMetadataPersistenceAdapter = installChatMetadataPersistence({ getChatController: () => chatController });

/** After a header workspace change — refresh the chat list and maybe switch the active chat. */
export function refreshChatListForWorkspace() {
  chatController.refreshChatListForWorkspace({
    preserveActiveChat: chatShell.workspaceRefreshPreserveDepth > 0,
  });
  notifySidebar();
}

function normalizePath(p) {
  if (typeof p !== 'string') return '';
  return p.replace(/\\/g, '/').replace(/\/$/, '').trim();
}

function updateFolderSelect(workspaceFile, preferredFolder = '') {
  const normalized = normalizePath(workspaceFile);
  const w = chatRuntime.workspaces.find((x) => normalizePath(x.workspaceFile) === normalized);
  const folderSel = document.getElementById('chat-new-folder-select');
  if (!folderSel) return;
  if (!w) {
    folderSel.innerHTML = '';
    return;
  }
  const options = [];
  if (w.workspaceDir) {
    options.push(
      '<option value="' + escapeHtml(w.workspaceDir) + '">' + escapeHtml(t('chat.workspaceParent')) + '</option>'
    );
  }
  (w.folders || []).forEach((f) => {
    if (f.resolvedPath && normalizePath(f.resolvedPath) !== normalizePath(w.workspaceDir)) {
      options.push(
        '<option value="' +
          escapeHtml(f.resolvedPath) +
          '">' +
          escapeHtml(f.name) +
          '</option>'
      );
    }
  });
  folderSel.innerHTML = options.join('');
  if (!folderSel.options.length) {
    chatRuntime.selectedWorkspaceFolder = null;
    newChatModalState.chatNewFolderDropdownApi?.refresh?.();
    return;
  }
  const preferred = (preferredFolder || chatRuntime.selectedWorkspaceFolder || '').trim();
  const preferredOption = Array.from(folderSel.options).find(
    (option) => normalizePath(option.value) === normalizePath(preferred)
  );
  if (preferredOption) {
    folderSel.value = preferredOption.value;
    chatRuntime.selectedWorkspaceFolder = preferredOption.value;
    newChatModalState.chatNewFolderDropdownApi?.refresh?.();
    return;
  }
  const fallbackFolder = w.workspaceDir || (w.folders && w.folders[0] && w.folders[0].resolvedPath) || '';
  const fallbackOption = Array.from(folderSel.options).find(
    (option) => normalizePath(option.value) === normalizePath(fallbackFolder)
  );
  folderSel.value = fallbackOption ? fallbackOption.value : folderSel.options[0].value;
  chatRuntime.selectedWorkspaceFolder = folderSel.value || null;
  newChatModalState.chatNewFolderDropdownApi?.refresh?.();
}

function setLaunchCommand(chat, commandLine, cwd) {
  const el = chat.launchCommandEl;
  if (!el) return;
  chat._sdkLaunchCommand = commandLine || '';
  chat._sdkLaunchCwd = cwd || '';
  el.style.display = 'none';
}


if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && chatRuntime.activeChatId) markChatSeenIfUnread(chatRuntime.activeChatId);
  });
}

function ensureEmbedNewChatFolderSelect() {
  if (!isEmbedWidgetMode()) return;
  const ctx = getWorkspaceContextForChat();
  if (!ctx?.workspaceFolder) return;
  const folderSel = document.getElementById('chat-new-folder-select');
  if (!folderSel) return;
  if (folderSel.options.length > 0) return;
  const folderName = ctx.workspaceFolder.split('/').filter(Boolean).pop() || ctx.workspaceFolder;
  folderSel.innerHTML =
    '<option value="' +
    escapeHtml(ctx.workspaceFolder) +
    '">' +
    escapeHtml(folderName) +
    '</option>';
  folderSel.value = ctx.workspaceFolder;
  chatRuntime.selectedWorkspaceFolder = ctx.workspaceFolder;
  newChatModalState.chatNewFolderDropdownApi?.refresh?.();
}


export function fitAllChats() {
  const active = chatRuntime.activeChatId ? chats.find((c) => c.id === chatRuntime.activeChatId) : null;
  active?._sdkRichView?.scrollToBottom?.();
}

/**
 * Toggle chat fullscreen mode (pseudo-fullscreen).
 */
function toggleChatFullscreen() {
  const body = document.body;
  const btn = document.getElementById('chat-fullscreen-btn');
  const isOn = body.classList.toggle('chat-fullscreen-active');
  if (btn) {
    const label = isOn ? t('chat.fullscreenExit') : t('chat.fullscreen');
    const icon = isOn ? 'mdi-fullscreen-exit' : 'mdi-fullscreen';
    btn.setAttribute('data-fullscreen', isOn ? 'on' : 'off');
    btn.setAttribute('title', label);
    btn.setAttribute('aria-label', label);
    btn.innerHTML =
      `<span class="mdi ${icon}" aria-hidden="true"></span>` +
      `<span class="chat-toolbar-action-label">${escapeHtml(label)}</span>`;
  }
  if (isOn) fitAllChats();
}


function renderChatContextDetails(chat) {
  const planEl = document.getElementById('chat-context-details-plan-limits');
  if (planEl) {
    planEl.hidden = !['codex', 'claude'].includes(chat?.agentTransport);
    planEl.innerHTML = planEl.hidden ? '' : renderChatContextPlanLimitsHtml(chat._contextPlanLimits, { t, lang: getCurrentLang(), harness: chat.agentTransport });
  }
  const progressEl = document.getElementById('chat-context-details-progress');
  if (progressEl) progressEl.hidden = true;
  const cacheEl = document.getElementById('chat-context-details-cache');
  if (cacheEl) { cacheEl.innerHTML = ''; cacheEl.hidden = true; }
  const breakdownEl = document.getElementById('chat-context-details-breakdown');
  if (breakdownEl) {
    breakdownEl.innerHTML = '';
    breakdownEl.hidden = true;
  }
  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };
  if (!chat) {
    const qualityEl = document.getElementById('chat-context-details-quality');
    if (qualityEl) {
      qualityEl.textContent = '—';
      qualityEl.classList.remove('chat-diag-badge-ok', 'chat-diag-badge-warn', 'chat-diag-badge-bad');
    }
    setText('chat-context-details-summary', t('chat.contextDetailsUnavailable'));
    setText('chat-context-details-transport', '—');
    setText('chat-context-details-model', '—');
    setText('chat-context-details-source', t('chat.contextDetailsSourceUnknown'));
    setText('chat-context-details-updated', '—');
    renderContextQualityRows(null, setText);
    setText('chat-context-details-fill', '—');
    setText('chat-context-details-peak', '—');
    setText('chat-context-details-window', '—');
    setText('chat-context-details-input', '—');
    setText('chat-context-details-output', '—');
    setText('chat-context-details-total', '—');
    setText('chat-context-details-warnings', t('chat.contextDetailsNoWarnings'));
    return;
  }
  const stateSnapshot = chat?._contextUsageSnapshot && typeof chat._contextUsageSnapshot === 'object'
    ? chat._contextUsageSnapshot
    : null;
  const liveSnapshot = stateSnapshot || chatRuntime.chatDiagnosticsApi?.buildChatContextSnapshot?.(
    chat,
    chatRuntime.chatDiagnosticsApi?.resolveContextMeterModelId?.(chat, chat?.model || 'auto'),
  ) || null;
  const snapshot = mergeSeriesIntoContextSnapshot(liveSnapshot, chat._contextCacheSeries);
  if (progressEl && Number.isFinite(snapshot?.fillPercent) && snapshot.fillPercent != null) {
    progressEl.hidden = false;
    progressEl.value = Math.max(0, Math.min(100, snapshot.fillPercent));
    progressEl.setAttribute('aria-label', snapshot.label || t('chat.contextDetailsFill'));
    progressEl.dataset.level = snapshot.pressureLevel || 'normal';
  }
  if (cacheEl) {
    cacheEl.innerHTML = renderChatContextCacheHtml(snapshot, t);
    cacheEl.hidden = !cacheEl.innerHTML;
  }
  const countdownEl = document.getElementById('chat-context-details-countdown');
  if (countdownEl) {
    countdownEl.innerHTML = renderChatContextCacheCountdownHtml(chat._cacheCountdown, t);
    countdownEl.hidden = !countdownEl.innerHTML;
  }
  const seriesEl = document.getElementById('chat-context-details-series');
  if (seriesEl) {
    seriesEl.innerHTML = renderChatContextCacheChartHtml(chat._contextCacheSeries, t, getCurrentLang(), { range: Number(seriesEl.dataset.chartRange) || 0, mode: seriesEl.dataset.chartMode });
    seriesEl.hidden = !seriesEl.innerHTML;
    bindChatContextCacheChart(seriesEl, chat._contextCacheSeries, t, getCurrentLang());
  }
  if (breakdownEl) {
    breakdownEl.innerHTML = renderChatContextBreakdownHtml(snapshot, t);
    breakdownEl.hidden = !breakdownEl.innerHTML;
  }
  const qualityEl = document.getElementById('chat-context-details-quality');
  if (qualityEl) {
    const fillProvenance = snapshot?.fillProvenance;
    const estimated = snapshot?.isEstimated === true;
    let qualityLabel = t('chat.contextDetailsExact');
    if (fillProvenance === 'none') qualityLabel = t('chat.contextDetailsNoData');
    else if (estimated) qualityLabel = t('chat.contextDetailsEstimated');
    qualityEl.textContent = qualityLabel;
    qualityEl.classList.remove('chat-diag-badge-ok', 'chat-diag-badge-warn', 'chat-diag-badge-bad');
    if (fillProvenance === 'none') qualityEl.classList.add('chat-diag-badge-warn');
    else qualityEl.classList.add(estimated ? 'chat-diag-badge-warn' : 'chat-diag-badge-ok');
  }
  const warnings = Array.isArray(snapshot?.warnings)
    ? snapshot.warnings.filter((entry) => typeof entry === 'string' && entry.trim())
    : [];
  setText('chat-context-details-summary', snapshot?.label || t('chat.contextDetailsOpen'));
  setText(
    'chat-context-details-transport',
    resolveContextDetailsTransportLabel(snapshot?.transport || chat.agentTransport || 'sdk'),
  );
  setText('chat-context-details-model', snapshot?.modelId || normalizeModelValue(chat?.model || 'auto'));
  setText('chat-context-details-source', resolveContextDetailsSourceLabel(snapshot?.source || ''));
  setText('chat-context-details-updated', formatContextDetailsUpdatedAt(snapshot?.updatedAt));
  renderContextQualityRows(snapshot, setText);
  setText('chat-context-details-fill', formatContextDetailsPercent(snapshot?.fillPercent));
  setText('chat-context-details-peak', formatContextDetailsPercent(snapshot?.peakFillPercent));
  setText('chat-context-details-window', formatContextTokenCount(snapshot?.contextWindowTokens));
  setText('chat-context-details-input', formatContextTokenCount(snapshot?.inputTokens));
  setText('chat-context-details-output', formatContextTokenCount(snapshot?.outputTokens));
  setText('chat-context-details-total', formatContextTokenCount(snapshot?.totalTokens));
  setText(
    'chat-context-details-warnings',
    warnings.length > 0
      ? warnings.map((code) => resolveContextDetailsWarningLabel(code)).join(', ')
      : t('chat.contextDetailsNoWarnings'),
  );
}

/**
 * Initialize the chat panel: bar (chat, +, settings, fullscreen), modals (new chat, settings).
 */
export function initChatPanel() {
  const newChatModal = document.getElementById('chat-new-modal');
  if (newChatModal && newChatModal.parentElement !== document.body) {
    document.body.appendChild(newChatModal);
  }
  initAgentWakeLock();
  initChatModelSelectApi();
  initChatDiagnosticsApi();
  initChatTitleForkApi();
  bindChatVisibilityAndReconnect();
  chatController.initChatPanelBridge();
  mountSdkModeBarInToolbar();
  // Warm the enabled-local allowlist so reopened local chats stay local after a
  // sidebar sync/reload. Best-effort; a failure leaves the list empty.
  void refreshLocalChatHarnessOptions();

  bindChatPanelWindowEvents();
  bindChatPanelModals();
  bindChatPanelHarnessEvents();
  void loadWorkspaces();
  bindChatPanelToolbar({ toggleChatFullscreen });

  bindChatPanelSettings();

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (chatView.isChatListDropdownOpen()) {
      closeChatListModal();
      return;
    }
    if (chatView.isChatActionsDropdownOpen()) {
      closeChatActionsModal();
      return;
    }
    const settingsModal = document.getElementById('chat-settings-modal');
    if (settingsModal && !settingsModal.hidden) {
      closeChatSettingsModal();
      return;
    }
    const contextDetailsModal = document.getElementById('chat-context-details-modal');
    if (contextDetailsModal && !contextDetailsModal.hidden) {
      closeChatContextDetailsModal();
      return;
    }
    const newModalEl = document.getElementById('chat-new-modal');
    if (newModalEl && !newModalEl.hidden) {
      closeNewChatModal();
      return;
    }
    const deleteConfirmModal = document.getElementById('chat-delete-confirm-modal');
    if (deleteConfirmModal && !deleteConfirmModal.hidden) {
      closeChatDeleteConfirmModal();
      return;
    }
    const archiveConfirmModal = document.getElementById('chat-archive-confirm-modal');
    if (archiveConfirmModal && !archiveConfirmModal.hidden) {
      settleArchiveConfirm(false);
      return;
    }
    if (!document.body.classList.contains('chat-fullscreen-active')) return;
    document.body.classList.remove('chat-fullscreen-active');
    const fb = document.getElementById('chat-fullscreen-btn');
    if (fb) {
      const fullscreenLabel = t('chat.fullscreen');
      fb.setAttribute('data-fullscreen', 'off');
      fb.setAttribute('title', fullscreenLabel);
      fb.setAttribute('aria-label', fullscreenLabel);
      fb.innerHTML =
        '<span class="mdi mdi-fullscreen" aria-hidden="true"></span>' +
        `<span class="chat-toolbar-action-label">${escapeHtml(fullscreenLabel)}</span>`;
    }
  });
}

registerChatHost({
  ENTER_FOCUS_DELAY_MS,
  LAST_CHAT_ID_KEY,
  RETAINED_CHAT_PANE_LIMIT,
  SEND_ENTER_DELAY_MS,
  adoptCreatedChat,
  applySendFieldPreference,
  chatArchiveCatalog,
  chatController,
  chatFavorites,
  chatPresets,
  chatTransport,
  chatView,
  clearChatLocalData,
  closeChat,
  createPageLinkedChat,
  ensureChatConnection,
  ensureEmbedNewChatFolderSelect,
  getChatLastUsedAt,
  getChatListAgentState,
  getChatsForCurrentWorkspace,
  getSkipChatArchiveConfirm,
  getSkipChatDeleteConfirm,
  getWorkspaceContextForChat,
  getWorkspaceDefaultFolder,
  isAutoContextCompressionEnabled,
  isChatSettingsControlOnVisibleTab,
  isNewChatModalOpen,
  loadChatsFromServer,
  loadWorkspaces,
  maybeAutoNameNewChat,
  normalizeAutoContextCompressionThreshold,
  normalizePath,
  notifySidebar,
  openCreatedForkChat,
  openTerminal,
  processAgentOutput,
  readChatBufferFromLocalStorage,
  readChatDraft,
  recordChatActivity,
  recordChatLastUsed,
  refreshModelCatalogFromServer,
  reloadOpenCodeModelsCatalog,
  renderChatContextDetails,
  renderChatList,
  requestArchiveChat,
  runNewChatHarnessStatusCheck,
  selectChat,
  sendTextToAgent,
  setChatModel,
  setLaunchCommand,
  setSkipChatArchiveConfirm,
  setSkipChatDeleteConfirm,
  shouldResetAfterContextCompression,
  syncBackgroundChatConnections,
  syncChatSdkModeUi,
  syncNewChatWorktreeRow,
  updateChatBarSelect,
  writeChatDraft,
});