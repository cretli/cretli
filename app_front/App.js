/**
 * Entry point: tab initialization, workspace loading and panel wiring.
 */
import './css/generated/mdi-subset.css';
import './css/app.scss';
import * as api from './core/api/index.js';
import {
  initChatPanel,
  openNewChatModal,
  initAutoNameChatSetting,
  loadChatsFromServer,
  getArchivedCounts,
  ensureEmbedChat,
  fitAllChats,
  getActiveSendInput,
  getActiveSendBar,
  getActiveChatTerminalState,
  refreshChatListForWorkspace,
  selectChat,
  setSidebarRenderHook,
  setSidebarTransientPatchHook,
  setSidebarOpenHook,
  setSidebarCloseHook,
  setWorkspaceSwitchHook,
  getChatsList,
  getActiveChatIdValue,
  getChatListAgentStatePublic,
  getTerminalStateMetaPublic,
  getChatFavoritesStore,
  escapeHtml,
  requestArchiveChatConfirmed,
  requestArchiveSettledChats,
  requestRestoreChat,
  requestDeleteChat,
  refreshSidebarChatStates,
  canPinChatToUrl,
  toggleChatUrlPinById,
  createPageLinkedChat,
  resolvePagePinStateForUrl,
  syncEmbedChatToHostPage,
  selectChatFromWidgetHost,
  setForcedEmbedChatId,
  refreshRelatedChatHistoryLinks,
  setWorkspaceCloneFolderLookup,
  setWorkspacePreferredFolderLookup,
  openChatFromNotification,
  notifySidebarSearchHydration,
  expandSidebarWorkspaceSearchPool,
} from './chat.js';
import { initGitContextBadge } from './gitContextBadge.js';
import { deriveWorkspaceKey } from './features/chat/chatMetadataIdbSchema.js';
import { hasLocalChatBootCacheForColdStart, readChatLocalBootCacheForColdStart } from './features/chat/chatLocalBootSync.js';
import { seedLocalBootSyncFromIdbBootCache } from './features/chat/chatOfflineBootSeed.js';
import { resolveBootOnAuthStatusFailure } from './features/chat/chatBootDecision.js';
import { installChatActivityStorageListener } from './features/chat/chatActivityStore.js';
import { applyChatAuthSessionBoundary } from './features/chat/chatSessionBoundary.js';
import { clearPushInboxCache } from './features/pwa/pushInbox.js';
import { copyFromTerminal } from './panelCopy.js';
import { initLanSettings } from './lanSettings.js';
import { initModelSettings, refreshModelSettingsPanel } from './modelSettings.js';
import { initOpenRouterModelSettings, refreshOpenRouterModelSettingsPanel } from './openrouterModelSettings.js';
import { initOpenCodeModelSettings, refreshOpenCodeModelSettingsPanel } from './opencodeModelSettings.js';
import { initCodeBuddyModelSettings, refreshCodeBuddyModelSettingsPanel } from './codebuddyModelSettings.js';
import { initDeepSeekModelSettings, refreshDeepSeekModelSettingsPanel } from './deepseekModelSettings.js';
import { initMistralModelSettings, refreshMistralModelSettingsPanel } from './mistralModelSettings.js';
import { initQwenModelSettings, refreshQwenModelSettingsPanel } from './qwenModelSettings.js';
import { initClaudeModelSettings, refreshClaudeModelSettingsPanel } from './claudeModelSettings.js';
import { initCodexModelSettings, refreshCodexModelSettingsPanel } from './codexModelSettings.js';
import { showHarnessStatistics } from './features/harness-health/harnessHealthCard.js';
import { initHarnessSettings, refreshHarnessSettingsPanel } from './harnessSettings.js';
import { refreshHarnessVersionCardsForTab } from './features/settings/harnessVersionCard.js';
import { maybeShowFirstRunSetup } from './features/setup/firstRunSetup.js';
import { initAppUpdateSettings } from './features/settings/appUpdateSettings.js';
import { safeFit } from './terminalViewport.js';
import { initQuickCommands, setQuickCommandHandler } from './quickCommands.js';
import { initTerminalFontSizeSettings } from './terminalSettings.js';
import { setActivePanel, initConnectionStatus } from './connectionStatus.js';
import { initConnectionStatusPanel } from './connectionStatusPanel.js';
import { initServerRestartCoordinator } from './app/serverRestartCoordinator.js';
import {
  initSpecialChars,
  setSpecialCharHandler,
  setSpecialCharsBarVisibility,
} from './specialChars.js';
import { initExtraBarContextPicker } from './features/sendBar/sendBarContextPicker.js';
import { initTheme, initThemeSelect } from './theme.js';
import { appLogger, initLogsPanel, installClientDebugInstrumentation, syncClientDebugFlagsFromServer, initFreezeLogRecovery } from './logger.js';
import { initClientInstance } from './lib/clientInstance.js';
import { initClientInstanceHeartbeat } from './lib/clientInstanceHeartbeat.js';
import { initClientInstanceCommands } from './lib/clientInstanceCommands.js';
import { initKibRadial, initKibRadialSetting } from './kibRadial.js';
import { initTodoPanel, refreshTodoList } from './todoPanel.js';
import { sendSequenceToTerminalState } from './inputDispatch.js';
import {
  createPanelRouter,
  readRequestedChatId,
  readRequestedSettingsTab,
  replaceLocationView,
} from './app/appShell/panelRouter.js';
import {
  SPA_HARNESS_IDS,
  SPA_SETTINGS_TABS,
  isHarnessSettingsTab,
  isHarnessSubtabOf,
  isInterfaceSettingsTab,
  isChatSettingsTab,
  isWatcherSettingsTab,
  remapSettingsTab,
} from '../lib/spa-routes.js';
import { loadPanelModule, getLoadedPanelModule } from './app/appShell/lazyPanelModules.js';
import { createWorkspaceContext } from './app/appShell/workspaceContext.js';
import { createHeaderContextTitle } from './app/appShell/headerContextTitle.js';
import { createSidebarView } from './features/sidebar/sidebarView.js';
import {
  configureSidebarLayoutSync,
  hydrateSidebarLayout,
  publishSidebarLayout,
} from './features/sidebar/sidebarLayoutSync.js';
import {
  listCloneFoldersForWorkspaceFile,
} from './features/sidebar/workspaceChatMatch.js';
import { shouldCloseSidebarOnResume } from './features/sidebar/sidebarDock.js';
import { wouldCreateChatParentCycle } from '../lib/chat-tree.js';
import {
  EMBED_ALLOWED_PANELS,
  EMBED_DEFAULT_PANEL,
  parseEmbedModeQuery,
  resolveEmbedPanel,
} from './app/appShell/embedMode.js';
import { setWidgetHostPort } from './embed/widgetHostScreenshot.js';
import { requestWidgetHostUrl } from './embed/widgetHostNavigation.js';
import { initI18n, t, getCurrentLang, setLang } from './i18n/index.js';
import { applyStaticTranslations, wireStaticTranslations } from './i18n/applyStatic.js';
import { initVoiceModeButton } from './features/voice/voiceModeButton.js';
import { initUsageSettings, refreshUsageSettings } from './features/usage/usageSettings.js';
import { initApprovalBrokerSettings, refreshApprovalBrokerSettings } from './features/approval/approvalBrokerSettings.js';
import { initDelegationCenter, refreshDelegationCenter } from './features/delegations/delegationCenter.js';
import { initInstallPrompt } from './features/pwa/installPrompt.js';
import { initPwaUpdatePrompt } from './features/pwa/pwaUpdatePrompt.js';
import { initPageBackgroundGrace } from './lib/pageBackgroundGrace.js';
import { isMobileLikeClient } from './lib/mobileClient.js';
import { initPageResumeCleanup, registerPageResumeCleanupHook } from './lib/pageResumeCleanup.js';
import { initPushSettingsToggle } from './features/pwa/pushSubscription.js';
import { getChatMuteStore } from './features/pwa/chatMuteStore.js';
import { getInAppSignalController, initInAppSignals } from './features/pwa/inAppSignals.js';
import { initServiceWorkerMessages, readNotificationBootInfo } from './features/pwa/swMessages.js';
import { initNotificationCenter } from './features/notifications/notificationCenter.js';
import { resolveNotificationActionUrl } from './features/notifications/notificationStore.js';
import { readStorageValueWithAlias, writeStorageValueWithAlias } from './lib/storageKeyAlias.js';
import './components/ui/index.js';
import './components/ui/cr-storage-donut.js';

let filesPanelInitialized = false;
const STARTUP_DEBUG_FLAG_LS_KEY = 'cretli-debug-startup';
const APP_BOOT_STARTED_AT_MS = typeof performance !== 'undefined' ? performance.now() : Date.now();
const MAIN_PANELS = ['chat', 'terminal', 'tasks', 'agents', 'todo', 'browser', 'files', 'git', 'github', 'logs', 'instances', 'tests'];
const RESTORABLE_PANELS = [...MAIN_PANELS, 'settings'];

const APP_MODES = {
  main: {
    id: 'main',
    allowedPanels: RESTORABLE_PANELS,
    defaultPanel: 'chat',
  },
  embed: {
    id: 'embed',
    allowedPanels: EMBED_ALLOWED_PANELS,
    defaultPanel: EMBED_DEFAULT_PANEL,
  },
};

if (typeof window !== 'undefined') {
  window.__crAppBootStartedAtMs = APP_BOOT_STARTED_AT_MS;
}

function isStartupDebugEnabled() {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search || '');
  const query = (params.get('debugStartup') || '').trim().toLowerCase();
  if (query === '1' || query === 'true' || query === 'yes') return true;
  try {
    const stored = readStorageValueWithAlias(localStorage, STARTUP_DEBUG_FLAG_LS_KEY, '');
    if (!stored) return false;
    const normalized = String(stored).trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
  } catch (_) {
    return false;
  }
}

function startupLog(step) {
  if (!isStartupDebugEnabled()) return;
  const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const sinceBootMs = (nowMs - APP_BOOT_STARTED_AT_MS).toFixed(1);
  const message = `[startup +${sinceBootMs}ms] ${step}`;
  console.log(message);
  appLogger.log('startup-debug', message);
}

function measureStartupStep(stepName, fn) {
  const startedAtMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const result = fn();
  const endedAtMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
  startupLog(`${stepName} (${(endedAtMs - startedAtMs).toFixed(1)}ms)`);
  return result;
}

function ensureFilesPanelInitialized() {
  if (filesPanelInitialized) return;
  const filesModule = getLoadedPanelModule('files');
  if (!filesModule) return;
  filesModule.initFilesPanel();
  filesPanelInitialized = true;
}

/** @type {{ getActiveTerminal?: () => object | null } | null} */
let terminalPanelState = null;

/**
 * Loads and initializes a lazy panel module the first time its tab is opened.
 * @param {string} panelKey
 * @returns {Promise<void>}
 */
function ensurePanelReady(panelKey) {
  return loadPanelModule(panelKey).then((mod) => {
    if (panelKey === 'terminal' && !terminalPanelState) {
      terminalPanelState = mod.initTerminalPanel('terminal-container');
      return;
    }
    if (panelKey === 'tasks') {
      initPanelOnce(panelKey, () => mod.initTasksPanel());
      return;
    }
    if (panelKey === 'agents') {
      initPanelOnce(panelKey, () => mod.initAgentsPanel());
      void loadPanelModule('agentsSettings').then((settingsMod) =>
        initPanelOnce('agentsSettings', () => settingsMod.initAgentsPanel())
      );
      return;
    }
    if (panelKey === 'files') {
      ensureFilesPanelInitialized();
      return;
    }
    if (panelKey === 'git') {
      initPanelOnce(panelKey, () => mod.initGitPanel());
      return;
    }
    if (panelKey === 'github') {
      initPanelOnce(panelKey, () => {
        mod.setGithubPanelRouter(showPanel);
        mod.initGithubPanel();
      });
      return;
    }
    if (panelKey === 'widget') {
      initPanelOnce(panelKey, () => initWidgetPanelFromApp(mod));
      return;
    }
    if (panelKey === 'mcpSettings') {
      initPanelOnce(panelKey, () => mod.initMcpSettingsPanel());
      return;
    }
    if (panelKey === 'watcherSettings') {
      initPanelOnce(panelKey, () => mod.initWorkspaceWatcherSettingsPanel());
      return;
    }
    if (panelKey === 'instances') {
      initPanelOnce(panelKey, () => mod.initInstancesPanel());
      return;
    }
    if (panelKey === 'browser') {
      initPanelOnce(panelKey, () => mod.initBrowserPanel({
        getActiveChatId: getActiveChatIdValue,
        getChats: getChatsList,
      }));
      return;
    }
    if (panelKey === 'statusTests') {
      initPanelOnce(panelKey, () => mod.initStatusTestsPanel());
    }
  });
}

const initializedPanels = new Set();

function initPanelOnce(panelKey, initFn) {
  if (initializedPanels.has(panelKey)) return;
  initializedPanels.add(panelKey);
  initFn();
}

function fitTerminalPanel() {
  const activeTerminal = terminalPanelState?.getActiveTerminal?.();
  if (!activeTerminal?.term || !activeTerminal.fitAddon || !activeTerminal.pane) return;
  const viewportWrap = activeTerminal.pane.querySelector('.terminal-viewport-wrap');
  if (!viewportWrap) return;
  safeFit(activeTerminal.term, activeTerminal.fitAddon, viewportWrap);
}

function getTerminalSendBar() {
  return getLoadedPanelModule('terminal')?.getTerminalSendBar?.() ?? null;
}

function getTasksTerminalState() {
  return getLoadedPanelModule('tasks')?.getTasksTerminalState?.() ?? null;
}

function getAgentsTerminalState() {
  return getLoadedPanelModule('agents')?.getAgentsTerminalState?.() ?? null;
}

/**
 * Panels that were never opened have nothing to refresh, so these wrappers stay
 * silent instead of pulling their chunk in the background.
 */
function callLoadedPanel(panelKey, methodName, ...args) {
  const mod = getLoadedPanelModule(panelKey);
  const fn = mod?.[methodName];
  if (typeof fn !== 'function') return undefined;
  return fn(...args);
}

let showSettingsPanelExtras = () => {};
let lastMainPanelId = 'chat';

function setLastMainPanel(panelId) {
  if (!MAIN_PANELS.includes(panelId)) return;
  lastMainPanelId = panelId;
}

function getLastMainPanel() {
  return MAIN_PANELS.includes(lastMainPanelId) ? lastMainPanelId : 'chat';
}

const panelRouter = createPanelRouter({
  appModes: APP_MODES,
  mainPanels: MAIN_PANELS,
  setLastMainPanel,
  setActivePanel,
  setSpecialCharsBarVisibility,
  ensurePanelReady,
  fitTerminalPanel,
  loadChatsFromServer,
  fitAllChats,
  getActiveSendBar,
  getTerminalSendBar,
  fitTasksTerminal: () => callLoadedPanel('tasks', 'fitTasksTerminal'),
  preloadTasksDropdown: () => callLoadedPanel('tasks', 'preloadTasksDropdown'),
  ensureTaskRunsReconnected: () =>
    callLoadedPanel('tasks', 'ensureTaskRunsReconnected') ?? Promise.resolve(),
  refreshTasksList: (options) => callLoadedPanel('tasks', 'refreshTasksList', options),
  fitAgentsTerminal: () => callLoadedPanel('agents', 'fitAgentsTerminal'),
  preloadAgentsDropdown: () => callLoadedPanel('agents', 'preloadAgentsDropdown'),
  ensureAgentRunsReconnected: () =>
    callLoadedPanel('agents', 'ensureAgentRunsReconnected') ?? Promise.resolve(),
  refreshAgentsList: () => callLoadedPanel('agents', 'refreshAgentsList'),
  ensureFilesPanelInitialized,
  refreshFilesPanel: () => callLoadedPanel('files', 'refreshFilesPanel'),
  refreshGitInfo: () => callLoadedPanel('git', 'refreshGitInfo'),
  refreshGithubPanel: () => callLoadedPanel('github', 'refreshGithubPanel'),
  refreshTodoList,
  refreshInstancesPanel: () => callLoadedPanel('instances', 'refreshInstancesPanel'),
  refreshBrowserPanel: () => callLoadedPanel('browser', 'refreshBrowserPanel'),
  onShowSettings: () => showSettingsPanelExtras(),
});

const workspaceContext = createWorkspaceContext({
  api,
  refreshTasksList: () => callLoadedPanel('tasks', 'refreshTasksList', { invalidateCache: true }),
  refreshAgentsList: () => callLoadedPanel('agents', 'refreshAgentsList'),
  refreshChatListForWorkspace,
  ensureFilesPanelInitialized,
  refreshFilesPanel: () => callLoadedPanel('files', 'refreshFilesPanel'),
  refreshGitInfo: () => callLoadedPanel('git', 'refreshGitInfo'),
  updateGithubTabVisibility: () =>
    ensurePanelReady('github').then(() => callLoadedPanel('github', 'updateGithubTabVisibility')),
  refreshGithubPanel: () => callLoadedPanel('github', 'refreshGithubPanel'),
  refreshTodoList,
  refreshBrowserPanel: () => callLoadedPanel('browser', 'refreshBrowserPanel'),
  onWorkspaceLabelChanged: () => headerContextTitle.refresh(),
});

const headerContextTitle = createHeaderContextTitle({
  getActiveChatId: getActiveChatIdValue,
  getChats: getChatsList,
});

const { isPanelAllowed, resolveInitialPanel, showPanel, initTabs } = panelRouter;

// Compact branch/worktree chip in the header. The Git panel itself is a lazy
// chunk; the chip only writes the scope, then asks the router to open it.
const gitContextBadge = initGitContextBadge({
  getActiveChat: () => {
    const id = getActiveChatIdValue();
    if (!id) return null;
    return getChatsList().find((chat) => chat.id === id) || null;
  },
  getActiveWorkspaceFolder: getActiveWorkspaceFolderFromHeader,
});
window.addEventListener('cretli-git-open', () => showPanel('git'));
const {
  applyEmbedWorkspaceContext,
  initWorkspaceHeader,
  initWorkspacePopover,
  initSettingsWorkspacePicker,
  refreshSettingsWorkspacePicker,
  switchWorkspace,
  getSidebarWorkspaceFolder,
  getWorkspacesList: getWorkspacesListFromCtx,
  ensureWorkspacesListLoaded,
  seedWorkspacesList,
} = workspaceContext;

/**
 * Seed the sidebar's workspace list from the cold-start snapshot so cached chats render
 * before `GET /api/workspaces` answers. `ensureWorkspacesListLoaded` still revalidates.
 *
 * @returns {boolean} whether a cached list was installed
 */
function seedWorkspacesListFromBootCache() {
  try {
    const cached = readChatLocalBootCacheForColdStart(typeof localStorage !== 'undefined' ? localStorage : null);
    if (cached && cached.workspaces.length > 0) return seedWorkspacesList(cached.workspaces);
  } catch (_) {}
  return false;
}

setWorkspaceCloneFolderLookup((workspaceFile) =>
  listCloneFoldersForWorkspaceFile(
    getWorkspacesListFromCtx(),
    workspaceFile,
    (sidebarKey) => getSidebarWorkspaceFolder(sidebarKey),
  ),
);
setWorkspacePreferredFolderLookup(getSidebarWorkspaceFolder, getWorkspacesListFromCtx);

let settingsHeavyModulesInitialized = false;

function ensureSettingsHeavyModules() {
  if (settingsHeavyModulesInitialized) return;
  settingsHeavyModulesInitialized = true;
  initLanSettings();
  initModelSettings();
  initOpenRouterModelSettings();
  initOpenCodeModelSettings();
  initCodeBuddyModelSettings();
  initDeepSeekModelSettings();
  initMistralModelSettings();
  initQwenModelSettings();
  initClaudeModelSettings();
  initCodexModelSettings();
  initApprovalBrokerSettings();
}

showSettingsPanelExtras = () => {
  ensureSettingsTabsVisible();
  ensureSettingsHeavyModules();
  initWorkspaceHeader();
  refreshSettingsWorkspacePicker();
  const activeSettingsTab = document.getElementById('settings-panel')?.dataset?.activeSettingsTab
    || document.querySelector('#settings-tabs .settings-tab.active')?.dataset?.settingsTab;
  refreshSettingsTabPanels(activeSettingsTab);
};

function getActiveWorkspaceFileFromHeader() {
  const trigger = document.getElementById('header-workspace-trigger');
  return trigger?.dataset?.workspaceFile || '';
}

function getActiveWorkspaceFolderFromHeader() {
  const trigger = document.getElementById('header-workspace-trigger');
  return trigger?.dataset?.workspaceFolder || '';
}

function getActiveChatWorkspaceFolder() {
  const activeId = getActiveChatIdValue();
  const chat = getChatsList().find((entry) => entry.id === activeId);
  return String(chat?.workspaceFolder || getActiveWorkspaceFolderFromHeader() || '').trim();
}

async function setChatForkParent(chatId, parentChatId) {
  const id = String(chatId || '').trim();
  if (!id) return;
  const chats = getChatsList();
  const chat = chats.find((entry) => entry.id === id);
  if (!chat) return;
  const nextParent = String(parentChatId || '').trim();
  if (nextParent && wouldCreateChatParentCycle(chats, id, nextParent)) return;
  const previousParent = typeof chat.forkParentChatId === 'string' ? chat.forkParentChatId.trim() : '';
  if (nextParent) chat.forkParentChatId = nextParent;
  else delete chat.forkParentChatId;
  sidebarView.forceRerender();
  try {
    const data = await api.patchChat(id, { forkParentChatId: nextParent || null });
    if (!data?.ok || !data.chat) {
      if (previousParent) chat.forkParentChatId = previousParent;
      else delete chat.forkParentChatId;
      sidebarView.forceRerender();
      return;
    }
    if (typeof data.chat.forkParentChatId === 'string' && data.chat.forkParentChatId.trim()) {
      chat.forkParentChatId = data.chat.forkParentChatId.trim();
    } else {
      delete chat.forkParentChatId;
    }
    sidebarView.forceRerender();
    refreshRelatedChatHistoryLinks(chat);
    if (chat.forkParentChatId) {
      refreshRelatedChatHistoryLinks(chats.find((entry) => entry.id === chat.forkParentChatId));
    }
  } catch (_) {
    if (previousParent) chat.forkParentChatId = previousParent;
    else delete chat.forkParentChatId;
    sidebarView.forceRerender();
  }
}

const sidebarView = createSidebarView({
  getWorkspaces: getWorkspacesListFromCtx,
  getChats: getChatsList,
  getArchivedCounts,
  getActiveWorkspaceFile: getActiveWorkspaceFileFromHeader,
  getActiveWorkspaceFolder: getActiveWorkspaceFolderFromHeader,
  getActiveChatId: getActiveChatIdValue,
  selectChat,
  switchWorkspace: (workspaceFile, folder) => switchWorkspace(workspaceFile, folder),
  getPreferredWorkspaceFolder: (sidebarKey) => getSidebarWorkspaceFolder(sidebarKey),
  chatFavorites: getChatFavoritesStore(),
  resolveChatState: getChatListAgentStatePublic,
  getTerminalStateMeta: getTerminalStateMetaPublic,
  requestArchiveChat: requestArchiveChatConfirmed,
  requestRestoreChat,
  requestDeleteChat,
  onArchiveSettled: async (chatIds, { parentId } = {}) => {
    const count = Array.isArray(chatIds) ? chatIds.length : 0;
    if (!count) return false;
    if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
      const message = t('sidebar.archiveSettledConfirm', { count: String(count) });
      if (!window.confirm(message)) return false;
    }
    let result = null;
    try {
      result = await requestArchiveSettledChats(chatIds);
    } catch (_) {
      result = null;
    }
    if (!result?.ok) {
      if (typeof window !== 'undefined' && typeof window.alert === 'function') {
        window.alert(t('sidebar.archiveSettledFailed'));
      }
      // Returning false keeps the group expanded so the user can retry instead of
      // the sidebar pretending the archive succeeded.
      return false;
    }
    // The sidebar clears its per-parent expansion after a confirmed archive.
    void parentId;
    return true;
  },
  requestNewChat: (workspaceContext) => openNewChatModal(workspaceContext),
  requestLoadArchivedChats: (workspaceFile) => loadChatsFromServer({
    includeArchived: true,
    skipAutoSelect: true,
    archiveWorkspace: typeof workspaceFile === 'string' ? workspaceFile : '',
  }),
  expandWorkspaceChatsForSearch: (workspace, list) => {
    const sidebarKey = workspace.sidebarKey || workspace.workspaceFile || '';
    const groupFolder = getSidebarWorkspaceFolder(sidebarKey);
    const workspaceKey = deriveWorkspaceKey({
      workspaceFile: workspace.workspaceFile || '',
      workspaceFolder: groupFolder || '',
    });
    return expandSidebarWorkspaceSearchPool(list, workspaceKey);
  },
  notifySidebarSearchActive: () => notifySidebarSearchHydration(),
  canPinChatToUrl,
  toggleChatUrlPinById,
  escapeHtml,
  openWorkspaceSettings: () => {
    sidebarView.close();
    showPanel('settings');
    applySettingsTab('workspace');
  },
  refreshStates: refreshSidebarChatStates,
  setChatForkParent,
});

configureSidebarLayoutSync({
  readLocal: () => ({
    ...sidebarView.readLayoutSnapshot(),
    favoriteChatIds: getChatFavoritesStore().listFavorites(),
  }),
  apply: (layout) => {
    let needsRender = sidebarView.applyLayoutSnapshot(layout);
    if (Array.isArray(layout.favoriteChatIds)) {
      const before = getChatFavoritesStore().listFavorites().join('\0');
      getChatFavoritesStore().replaceFavorites(layout.favoriteChatIds);
      const after = getChatFavoritesStore().listFavorites().join('\0');
      if (before !== after) needsRender = true;
    }
    if (needsRender) sidebarView.scheduleUpdate();
  },
});
getChatFavoritesStore().setChangeListener((ids) => {
  publishSidebarLayout({ favoriteChatIds: ids });
});

function isEmbedModeEnabled() {
  if (typeof window === 'undefined') return false;
  return parseEmbedModeQuery(window.location.search || '', window.location.pathname || '').embedEnabled;
}

let widgetConnection = null;
let embedModalOn = false;
let embedWidgetBridgeInitialized = false;
/** @type {Map<string, Promise<{ ok: boolean, chat?: object, reused?: boolean, error?: string }>>} */
const widgetCreatePageChatInFlight = new Map();
const WIDGET_BRIDGE_LISTENERS_KEY = '__crWidgetBridgeListenersV1';

function updateEmbedFullscreenButton() {
  const button = document.getElementById('header-app-fullscreen-btn');
  if (!button) return;
  button.dataset.fullscreen = embedModalOn ? 'on' : 'off';
  button.title = embedModalOn ? t('app.closeModal') : t('app.openModal');
  button.setAttribute('aria-label', button.title);
  button.innerHTML = embedModalOn
    ? '<span class="mdi mdi-fullscreen-exit" aria-hidden="true"></span>'
    : '<span class="mdi mdi-fullscreen" aria-hidden="true"></span>';
}

function notifyWidgetEmbedReady() {
  if (!widgetConnection?.parentOrigin) return;
  window.parent.postMessage(
    { type: 'cretli-widget-embed-ready' },
    widgetConnection.parentOrigin,
  );
}

function notifyWidgetSelectChatApplied(chatId) {
  if (!widgetConnection?.parentOrigin) return;
  const normalizedId = String(chatId || '').trim();
  if (!normalizedId) return;
  window.parent.postMessage(
    { type: 'cretli-widget-select-chat-applied', chatId: normalizedId },
    widgetConnection.parentOrigin,
  );
}

/**
 * @param {string} requestedPageUrl
 * @returns {Promise<string>}
 */
async function resolveWidgetCreatePageUrl(requestedPageUrl) {
  const normalizedRequestedPageUrl = String(requestedPageUrl || '').trim();
  if (normalizedRequestedPageUrl) return normalizedRequestedPageUrl;
  try {
    const current = await requestWidgetHostUrl();
    const hostPageUrl = typeof current?.url === 'string' ? current.url.trim() : '';
    return hostPageUrl || '';
  } catch {
    return '';
  }
}

/**
 * @param {{ pageSessionId: string, pageUrl: string, pageTitle: string, harness?: string, forceNew?: boolean }} params
 * @returns {Promise<{ ok: boolean, chat?: object, reused?: boolean, error?: string }>}
 */
function createWidgetPageChatWithDedupe(params) {
  const pageSessionId = String(params.pageSessionId || '').trim();
  const pageUrl = String(params.pageUrl || '').trim();
  const pageTitle = String(params.pageTitle || '').trim();
  const harness = String(params.harness || '').trim().toLowerCase();
  const forceNew = params.forceNew !== false;
  const dedupeKey = `${pageSessionId}|${pageUrl}|${pageTitle}|${harness}|${forceNew ? 'new' : 'reuse'}`;
  const pending = widgetCreatePageChatInFlight.get(dedupeKey);
  if (pending) return pending;
  const promise = createPageLinkedChat({
    pageUrl,
    pageTitle,
    harness,
    forceNew,
  }).finally(() => {
    widgetCreatePageChatInFlight.delete(dedupeKey);
  });
  widgetCreatePageChatInFlight.set(dedupeKey, promise);
  return promise;
}

async function broadcastPagePinStateToParent() {
  if (!widgetConnection?.parentOrigin) return;
  let pageUrl = '';
  try {
    const current = await requestWidgetHostUrl();
    pageUrl = typeof current?.url === 'string' ? current.url.trim() : '';
  } catch {
    return;
  }
  if (!pageUrl) return;
  const linked = await resolvePagePinStateForUrl(pageUrl);
  window.parent.postMessage({
    type: 'cretli-widget-page-pin-state',
    linkedChatId: linked?.id || '',
    linkedChatTitle: linked?.title || '',
  }, widgetConnection.parentOrigin);
}

function initEmbedWidgetHostBridge() {
  if (!isEmbedModeEnabled() || embedWidgetBridgeInitialized) return;
  embedWidgetBridgeInitialized = true;
  const previousListeners = window[WIDGET_BRIDGE_LISTENERS_KEY];
  if (previousListeners?.messageHandler) {
    window.removeEventListener('message', previousListeners.messageHandler);
  }
  if (previousListeners?.bindChatHandler) {
    window.removeEventListener('cr-widget-bind-chat-request', previousListeners.bindChatHandler);
  }
  const messageHandler = (event) => {
    const data = event?.data;
    if (!data || typeof data !== 'object' || event.source !== window.parent) return;

    if (data.type === 'cretli-widget-connect') {
      if (widgetConnection) return;
      const installationId = window.location.pathname.split('/').filter(Boolean)[1] || '';
      const installation = data.installation;
      if (!installationId || installation?.id !== installationId) return;
      if (!Array.isArray(installation.allowedOrigins)
        || !installation.allowedOrigins.includes(event.origin)) return;
      const port = event.ports?.[0];
      if (!port) return;

      widgetConnection = {
        installation,
        pageSessionId: data.pageSessionId,
        parentOrigin: event.origin,
        port,
      };
      setWidgetHostPort(port);
      api.setWidgetAccessToken(data.accessToken);
      applyEmbedWorkspaceContext(installation);
      port.start();
      window.dispatchEvent(new CustomEvent('cr-widget-connected', {
        detail: {
          installation,
          pageSessionId: data.pageSessionId,
        },
      }));
      void broadcastPagePinStateToParent();
      const activeChat = getChatsList().find((chat) => chat.id === getActiveChatIdValue());
      if (activeChat?.cursorSessionId) {
        port.postMessage({
          type: 'cretli-widget-bind-chat',
          chatSessionKey: activeChat.cursorSessionId,
        });
      }
      return;
    }

    if (data.type === 'cretli-widget-select-chat') {
      if (!widgetConnection || event.origin !== widgetConnection.parentOrigin) return;
      const chatId = typeof data.chatId === 'string' ? data.chatId.trim() : '';
      if (!chatId) return;
      appLogger.log('widget-plus', 'select-chat from host', { chatId: chatId.slice(0, 8) });
      setForcedEmbedChatId(chatId);
      void selectChatFromWidgetHost(chatId).then(() => {
        const chat = getChatsList().find((entry) => entry.id === chatId);
        appLogger.log('widget-plus', 'select-chat done', {
          chatId: chatId.slice(0, 8),
          hasPane: !!chat?.pane,
          hasRichView: !!chat?._sdkRichView,
        });
        if (chat?.pane && chat?._sdkRichView) notifyWidgetSelectChatApplied(chatId);
      });
      return;
    }

    if (data.type === 'cretli-widget-create-page-chat') {
      if (!widgetConnection || event.origin !== widgetConnection.parentOrigin) return;
      const requestId = typeof data.id === 'string' ? data.id : '';
      const requestedPageUrl = typeof data.pageUrl === 'string' ? data.pageUrl.trim() : '';
      const pageTitle = typeof data.pageTitle === 'string' ? data.pageTitle.trim() : '';
      const harness = typeof data.harness === 'string' ? data.harness.trim() : '';
      const forceNew = data.forceNew !== false;
      appLogger.log('widget-plus', 'create-page-chat from host', { requestId, requestedPageUrl, pageTitle });
      void resolveWidgetCreatePageUrl(requestedPageUrl)
        .then((resolvedPageUrl) => {
          appLogger.log('widget-plus', 'create-page-chat resolved-url', {
            requestId,
            requestedPageUrl,
            resolvedPageUrl,
            pageTitle,
          });
          return createWidgetPageChatWithDedupe({
            pageSessionId: widgetConnection.pageSessionId,
            pageUrl: resolvedPageUrl,
            pageTitle,
            harness,
            forceNew,
          });
        })
        .then((result) => {
          appLogger.log('widget-plus', 'create-page-chat result', {
            requestId,
            ok: result.ok === true,
            chatId: result.chat?.id ? String(result.chat.id).slice(0, 8) : null,
            reused: result.reused === true,
            error: result.error || null,
          });
          const createdChatId = typeof result?.chat?.id === 'string' ? result.chat.id.trim() : '';
          if (!result.ok || !createdChatId) {
            window.parent.postMessage({
              type: 'cretli-widget-create-page-chat-result',
              id: requestId,
              ok: false,
              chat: null,
              reused: result.reused === true,
              error: result.error || '',
            }, widgetConnection.parentOrigin);
            return;
          }
          setForcedEmbedChatId(createdChatId);
          return selectChatFromWidgetHost(createdChatId)
            .catch(() => null)
            .then(() => {
              window.parent.postMessage({
                type: 'cretli-widget-create-page-chat-result',
                id: requestId,
                ok: true,
                chat: result.chat || null,
                reused: result.reused === true,
                error: '',
              }, widgetConnection.parentOrigin);
              void broadcastPagePinStateToParent();
            });
        });
      return;
    }

    if (data.type === 'cretli-widget-request-page-pin-state') {
      if (!widgetConnection || event.origin !== widgetConnection.parentOrigin) return;
      const requestId = typeof data.id === 'string' ? data.id : '';
      const pageUrl = typeof data.pageUrl === 'string' ? data.pageUrl.trim() : '';
      void resolvePagePinStateForUrl(pageUrl).then((linked) => {
        window.parent.postMessage({
          type: 'cretli-widget-page-pin-state-result',
          id: requestId,
          linkedChat: linked,
        }, widgetConnection.parentOrigin);
      });
      return;
    }

    if (data.type === 'cretli-widget-sync-embed-chat') {
      if (!widgetConnection || event.origin !== widgetConnection.parentOrigin) return;
      void syncEmbedChatToHostPage();
      return;
    }

    if (data.type !== 'cretli-widget-modal-state') return;
    if (!widgetConnection || event.origin !== widgetConnection.parentOrigin) return;
    embedModalOn = !!data.expanded;
    updateEmbedFullscreenButton();
  };

  const bindChatHandler = (event) => {
    const chatSessionKey = event?.detail?.chatSessionKey;
    if (!widgetConnection?.port || typeof chatSessionKey !== 'string' || !chatSessionKey.trim()) return;
    widgetConnection.port.postMessage({
      type: 'cretli-widget-bind-chat',
      chatSessionKey: chatSessionKey.trim(),
    });
  };
  window.addEventListener('message', messageHandler);
  window.addEventListener('cr-widget-bind-chat-request', bindChatHandler);
  window[WIDGET_BRIDGE_LISTENERS_KEY] = {
    messageHandler,
    bindChatHandler,
  };
}

function isEditableElement(el) {
  if (!el || !(el instanceof HTMLElement)) return false;
  const tag = (el.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea') return true;
  return !!el.isContentEditable;
}

function initMobileKeyboardOffsetSync() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const vv = window.visualViewport;
  if (!vv) return;

  let rafId = 0;
  const setOffset = (px) => {
    const value = Math.max(0, Math.round(px || 0));
    document.documentElement.style.setProperty('--cr-keyboard-offset', `${value}px`);
    document.body.classList.toggle('mobile-keyboard-open', value > 0);
    window.dispatchEvent(new CustomEvent('cr-keyboard-offset-change'));
  };
  const computeKeyboardOffset = () => {
    const innerH = Number(window.innerHeight) || 0;
    const docH = Number(document.documentElement?.clientHeight) || innerH;
    const viewportBottom = (Number(vv.height) || 0) + (Number(vv.offsetTop) || 0);
    const fromInner = innerH - viewportBottom;
    const fromDoc = docH - viewportBottom;
    const candidates = [fromInner, fromDoc].filter((n) => Number.isFinite(n) && n > 0);
    if (candidates.length === 0) return 0;
    const raw = Math.min(...candidates);
    if (raw < 48) return 0;
    // Guard: Android sometimes reports an inflated offset (IME plus extra system UI).
    const maxReasonable = Math.round(innerH * 0.55);
    if (raw > maxReasonable) return maxReasonable;
    return raw;
  };

  const updateOffset = () => {
    rafId = 0;
    const activeEl = document.activeElement;
    if (!isEditableElement(activeEl)) {
      setOffset(0);
      return;
    }
    const keyboardPx = computeKeyboardOffset();
    setOffset(keyboardPx);
  };
  const scheduleUpdate = () => {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(updateOffset);
  };

  vv.addEventListener('resize', scheduleUpdate);
  vv.addEventListener('scroll', scheduleUpdate);
  window.addEventListener('orientationchange', scheduleUpdate);
  document.addEventListener('focusin', scheduleUpdate, true);
  document.addEventListener(
    'focusout',
    () => {
      setTimeout(scheduleUpdate, 80);
    },
    true
  );
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    setOffset(0);
  });
  window.addEventListener('pageshow', () => {
    if (document.hidden) return;
    setOffset(0);
  });
  scheduleUpdate();
}

/**
 * Navigate to a notification's `actionUrl` inside the SPA. The URL is validated
 * again here (defence in depth): only same-origin relative paths are followed.
 *
 * @param {string} url
 */
function openNotificationActionUrl(url) {
  const safe = resolveNotificationActionUrl(url);
  if (!safe || typeof window === 'undefined') return;
  let parsed = null;
  try {
    parsed = new URL(safe, window.location.origin);
  } catch {
    return;
  }
  if (document.body?.classList.contains('chat-fullscreen-active')) {
    document.body.classList.remove('chat-fullscreen-active');
  }
  const panel = parsed.searchParams.get('panel') || '';
  const chatId = parsed.searchParams.get('chat') || '';
  if (chatId) {
    openChatFromNotification({ chatId });
    return;
  }
  if (panel === 'settings') {
    showPanel('settings');
    const tab = parsed.searchParams.get('tab') || '';
    if (tab) applySettingsTab(tab);
    return;
  }
  if (panel) {
    showPanel(panel);
    return;
  }
  window.location.assign(`${parsed.pathname || '/'}${parsed.search || ''}`);
}

function initHeaderSettings() {
  const resetChatFullscreenMode = () => {
    if (!document.body.classList.contains('chat-fullscreen-active')) return;
    document.body.classList.remove('chat-fullscreen-active');
    const fullscreenBtn = document.getElementById('chat-fullscreen-btn');
    if (!fullscreenBtn) return;
    fullscreenBtn.setAttribute('data-fullscreen', 'off');
    fullscreenBtn.setAttribute('title', t('common.fullscreen'));
    fullscreenBtn.setAttribute('aria-label', t('common.fullscreen'));
    fullscreenBtn.innerHTML = '<span class="mdi mdi-fullscreen" aria-hidden="true"></span>';
  };

  const appFullscreenBtn = document.getElementById('header-app-fullscreen-btn');
  if (appFullscreenBtn) {
    const isEmbedMode = typeof document !== 'undefined' && document.body?.classList.contains('embed-mode');
    const updateAppFullscreenButton = () => {
      if (isEmbedMode) {
        updateEmbedFullscreenButton();
        return;
      }
      const fullscreenOn = isEmbedMode ? embedModalOn : !!document.fullscreenElement;
      appFullscreenBtn.dataset.fullscreen = fullscreenOn ? 'on' : 'off';
      appFullscreenBtn.title = isEmbedMode
        ? (fullscreenOn ? t('app.closeModal') : t('app.openModal'))
        : (fullscreenOn ? t('app.closeFullscreen') : t('app.openFullscreen'));
      appFullscreenBtn.setAttribute('aria-label', appFullscreenBtn.title);
      appFullscreenBtn.innerHTML = fullscreenOn
        ? '<span class="mdi mdi-fullscreen-exit" aria-hidden="true"></span>'
        : '<span class="mdi mdi-fullscreen" aria-hidden="true"></span>';
    };
    appFullscreenBtn.addEventListener('click', async () => {
      try {
        if (isEmbedMode) {
          // In embed mode we toggle the parent-controlled modal state (widget.js), not browser fullscreen.
          if (window.parent && window.parent !== window && widgetConnection?.parentOrigin) {
            window.parent.postMessage(
              { type: 'cretli-widget-modal', action: 'toggle' },
              widgetConnection.parentOrigin,
            );
          } else {
            embedModalOn = !embedModalOn;
          }
          return;
        }
        if (document.fullscreenElement) {
          await document.exitFullscreen();
          return;
        }
        const root = document.documentElement;
        if (!root || typeof root.requestFullscreen !== 'function') return;
        await root.requestFullscreen();
      } catch (_) {
      } finally {
        updateAppFullscreenButton();
      }
    });
    if (isEmbedMode) {
      initEmbedWidgetHostBridge();
    } else {
      document.addEventListener('fullscreenchange', updateAppFullscreenButton);
    }
    updateAppFullscreenButton();
  }
  const settingsBtn = document.getElementById('header-settings-btn');
  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
      resetChatFullscreenMode();
      showPanel('settings');
    });
  }
  const backBtn = document.getElementById('settings-back-btn');
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      resetChatFullscreenMode();
      showPanel(getLastMainPanel());
    });
  }
  initAccountLogout();
  initAppUpdateSettings();
}

function initAccountLogout() {
  const section = document.getElementById('settings-account-section');
  const btn = document.getElementById('account-logout-btn');
  const status = document.getElementById('account-logout-status');
  if (!section || !btn) return;

  api.getAuthStatus()
    .then((data) => {
      if (data && data.ok && data.configured) {
        section.dataset.accountEnabled = 'true';
        const activeTab = document.getElementById('settings-panel')?.dataset?.activeSettingsTab
          || document.querySelector('#settings-tabs .settings-tab.active')?.dataset.settingsTab;
        if (activeTab === 'account') section.hidden = false;
      }
    })
    .catch(() => {});

  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    if (status) status.textContent = t('app.logoutProgress');
    try {
      await api.logout();
      await clearPushInboxCache();
      if (typeof window !== 'undefined') window.location.assign('/login');
    } catch (err) {
      if (status) status.textContent = t('app.logoutError', { detail: err?.message || t('app.logoutErrorUnknown') });
      btn.disabled = false;
    }
  });
}

const SETTINGS_TAB_LS_KEY = 'cretli-settings-tab';
const SETTINGS_TABS = SPA_SETTINGS_TABS;

/**
 * Returns the harness id for third-level settings tabs such as
 * `harness-opencode-models`, or `''` for the overview/unknown tabs.
 *
 * @param {string} tabId
 * @returns {string}
 */
function getHarnessIdFromSettingsTab(tabId) {
  const raw = typeof tabId === 'string' ? tabId.trim() : '';
  if (!raw.startsWith('harness-')) return '';
  return SPA_HARNESS_IDS.find(
    (harnessId) => raw === `harness-${harnessId}` || raw.startsWith(`harness-${harnessId}-`),
  ) || '';
}

/**
 * True for a harness Keys/Models sub-tab (the model catalog is loaded there).
 * The OpenCode Approvals tab is excluded.
 *
 * @param {string} tabId
 * @param {string} harnessId
 * @returns {boolean}
 */
function isHarnessModelSubtab(tabId, harnessId) {
  if (!isHarnessSubtabOf(tabId, harnessId)) return false;
  return tabId === `harness-${harnessId}-keys` || tabId === `harness-${harnessId}-models`;
}

function ensureSettingsTabsVisible() {
  const tabBar = document.getElementById('settings-tabs');
  if (!tabBar) return;
  tabBar.hidden = false;
  tabBar.style.display = 'flex';
  tabBar.style.visibility = 'visible';
  tabBar.style.opacity = '1';
  tabBar.querySelectorAll('.settings-tab').forEach((btn) => {
    btn.hidden = false;
    btn.style.display = 'inline-flex';
    btn.style.visibility = 'visible';
    btn.style.opacity = '1';
  });
}

/**
 * @param {string} tabId
 */
function refreshSettingsTabPanels(tabId) {
  const settingsPanel = document.getElementById('settings-panel');
  if (!settingsPanel?.classList.contains('active')) return;
  ensureSettingsHeavyModules();
  if (tabId === 'harness') refreshHarnessSettingsPanel();
  refreshHarnessVersionCardsForTab(tabId);
  if (tabId.endsWith('-stats')) void showHarnessStatistics(getHarnessIdFromSettingsTab(tabId));
  if (isHarnessModelSubtab(tabId, 'sdk')) refreshModelSettingsPanel();
  if (isHarnessModelSubtab(tabId, 'openrouter')) refreshOpenRouterModelSettingsPanel();
  if (isHarnessModelSubtab(tabId, 'opencode')) refreshOpenCodeModelSettingsPanel();
  if (isHarnessModelSubtab(tabId, 'codebuddy')) refreshCodeBuddyModelSettingsPanel();
  if (isHarnessModelSubtab(tabId, 'deepseek')) refreshDeepSeekModelSettingsPanel();
  if (isHarnessModelSubtab(tabId, 'mistral')) refreshMistralModelSettingsPanel();
  if (isHarnessModelSubtab(tabId, 'qwen')) refreshQwenModelSettingsPanel();
  if (isHarnessModelSubtab(tabId, 'claude')) refreshClaudeModelSettingsPanel();
  if (isHarnessModelSubtab(tabId, 'codex')) refreshCodexModelSettingsPanel();
  if (tabId === 'harness-opencode-approvals') void refreshApprovalBrokerSettings();
  if (tabId === 'chat') refreshModelSettingsPanel();
  if (tabId === 'usage') void refreshUsageSettings();
  if (tabId === 'delegations') void refreshDelegationCenter();
  if (tabId === 'widgets') {
    void ensurePanelReady('widget').then(() => callLoadedPanel('widget', 'refreshWidgetPanel'));
  }
  if (tabId === 'mcp') {
    void ensurePanelReady('mcpSettings').then(() => callLoadedPanel('mcpSettings', 'refreshMcpSettingsPanel'));
  }
  if (isWatcherSettingsTab(tabId)) {
    void ensurePanelReady('watcherSettings').then(() => {
      const root = document.getElementById('settings-watcher-root');
      if (root?.dataset.rendered === 'true') {
        callLoadedPanel('watcherSettings', 'syncWorkspaceWatcherSettingsTab');
        return;
      }
      callLoadedPanel('watcherSettings', 'refreshWorkspaceWatcherSettingsPanel');
    });
  }
}

/**
 * @param {HTMLElement} btn
 * @param {string} tabId
 * @param {boolean} inMainBar
 * @returns {boolean}
 */
function isSettingsTabButtonActive(btn, tabId, inMainBar) {
  const btnTab = btn.dataset.settingsTab || '';
  if (inMainBar && btnTab === 'harness') return isHarnessSettingsTab(tabId);
  if (inMainBar && btnTab === 'interface') return isInterfaceSettingsTab(tabId);
  if (inMainBar && btnTab === 'chat') return isChatSettingsTab(tabId);
  if (inMainBar && btnTab === 'watcher') return isWatcherSettingsTab(tabId);
  const harnessTab = btn.dataset.harnessTab || '';
  if (harnessTab) return isHarnessSubtabOf(tabId, harnessTab);
  return btnTab === tabId;
}

/**
 * @param {HTMLElement | null} root
 * @param {string} tabId
 * @param {boolean} inMainBar
 * @returns {HTMLElement | null}
 */
function applySettingsTabButtonState(root, tabId, inMainBar) {
  let activeBtn = null;
  root?.querySelectorAll('.settings-tab').forEach((btn) => {
    const isActive = isSettingsTabButtonActive(btn, tabId, inMainBar);
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    if (isActive) activeBtn = btn;
  });
  return activeBtn;
}

function applySettingsTab(tabId) {
  const resolvedTabId = remapSettingsTab(tabId);
  if (!SETTINGS_TABS.includes(resolvedTabId)) return;
  const settingsPanel = document.getElementById('settings-panel');
  if (settingsPanel) settingsPanel.dataset.activeSettingsTab = resolvedTabId;
  const mainBar = document.getElementById('settings-tabs');
  const harnessBar = document.getElementById('settings-harness-tabs');
  const interfaceBar = document.getElementById('settings-interface-tabs');
  const chatBar = document.getElementById('settings-chat-tabs');
  const watcherBar = document.getElementById('settings-watcher-tabs');
  let activeBtn = applySettingsTabButtonState(mainBar, resolvedTabId, true);
  activeBtn = applySettingsTabButtonState(harnessBar, resolvedTabId, false) || activeBtn;
  activeBtn = applySettingsTabButtonState(interfaceBar, resolvedTabId, false) || activeBtn;
  activeBtn = applySettingsTabButtonState(chatBar, resolvedTabId, false) || activeBtn;
  activeBtn = applySettingsTabButtonState(watcherBar, resolvedTabId, false) || activeBtn;

  const activeHarnessId = getHarnessIdFromSettingsTab(resolvedTabId);
  document.querySelectorAll('.settings-harness-subtab-bar').forEach((bar) => {
    const barHarnessId = bar.dataset.harnessId || '';
    const isVisible = Boolean(activeHarnessId) && barHarnessId === activeHarnessId;
    bar.hidden = !isVisible;
    const barActiveBtn = applySettingsTabButtonState(bar, resolvedTabId, false);
    if (isVisible) activeBtn = barActiveBtn || activeBtn;
  });

  if (harnessBar) harnessBar.hidden = !isHarnessSettingsTab(resolvedTabId);
  if (interfaceBar) interfaceBar.hidden = !isInterfaceSettingsTab(resolvedTabId);
  if (chatBar) chatBar.hidden = !isChatSettingsTab(resolvedTabId);
  if (watcherBar) watcherBar.hidden = !isWatcherSettingsTab(resolvedTabId);
  document.querySelectorAll('.settings-section[data-settings-tab]').forEach((section) => {
    if (section.id === 'settings-account-section' && section.dataset.accountEnabled !== 'true') {
      section.hidden = true;
      return;
    }
    const sectionTab = section.dataset.settingsTab || '';
    if (sectionTab === 'watcher') {
      section.hidden = !isWatcherSettingsTab(resolvedTabId);
      return;
    }
    section.hidden = sectionTab !== resolvedTabId;
  });
  try {
    writeStorageValueWithAlias(localStorage, SETTINGS_TAB_LS_KEY, resolvedTabId);
  } catch (_) {}
  if (activeBtn && typeof activeBtn.scrollIntoView === 'function') {
    activeBtn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  }
  refreshSettingsTabPanels(resolvedTabId);
  if (settingsPanel?.classList.contains('active')) {
    replaceLocationView('settings', resolvedTabId);
  }
}

function bindSettingsTabClicks(root) {
  if (!root) return;
  root.querySelectorAll('.settings-tab').forEach((btn) => {
    btn.addEventListener('click', () => applySettingsTab(btn.dataset.settingsTab || 'workspace'));
  });
}

function initSettingsTabs() {
  const tabBar = document.getElementById('settings-tabs');
  if (!tabBar) return;
  ensureSettingsTabsVisible();

  let initialTab = 'workspace';
  const requestedTab = remapSettingsTab(readRequestedSettingsTab());
  if (requestedTab && SETTINGS_TABS.includes(requestedTab)) {
    initialTab = requestedTab;
  } else {
    try {
      const stored = remapSettingsTab(readStorageValueWithAlias(localStorage, SETTINGS_TAB_LS_KEY, ''));
      if (stored && SETTINGS_TABS.includes(stored)) initialTab = stored;
    } catch (_) {}
  }

  bindSettingsTabClicks(tabBar);
  bindSettingsTabClicks(document.getElementById('settings-harness-tabs'));
  bindSettingsTabClicks(document.getElementById('settings-interface-tabs'));
  bindSettingsTabClicks(document.getElementById('settings-chat-tabs'));
  bindSettingsTabClicks(document.getElementById('settings-watcher-tabs'));
  document.querySelectorAll('.settings-harness-subtab-bar').forEach((bar) => {
    bindSettingsTabClicks(bar);
  });
  applySettingsTab(initialTab);
}

function initWidgetPanelFromApp(widgetModule) {
  widgetModule.initWidgetPanel({
    getActiveWorkspaceFile: getActiveWorkspaceFileFromHeader,
    getActiveWorkspaceFolder: getActiveWorkspaceFolderFromHeader,
    getWorkspacesList: getWorkspacesListFromCtx,
    getPreferredWorkspaceFolder: getSidebarWorkspaceFolder,
    ensureWorkspacesListLoaded,
  });
}

function initPanelCopyButtons() {
  async function handleCopy(getTerm) {
    const term = getTerm();
    const ok = await copyFromTerminal(term);
    if (ok) {
      const prev = this.textContent;
      this.textContent = t('app.copied');
      setTimeout(() => { this.textContent = prev; }, 1500);
    }
  }
  const terminalCopyBtn = document.getElementById('terminal-copy-btn');
  if (terminalCopyBtn) {
    terminalCopyBtn.addEventListener('click', async function () {
      await handleCopy.call(this, () => terminalPanelState?.getActiveTerminal?.()?.term ?? null);
    });
  }
  const tasksCopyBtn = document.getElementById('tasks-copy-btn');
  if (tasksCopyBtn) {
    tasksCopyBtn.addEventListener('click', async function () {
      await handleCopy.call(this, () => getTasksTerminalState()?.term ?? null);
    });
  }
  const agentsCopyBtn = document.getElementById('agents-copy-btn');
  if (agentsCopyBtn) {
    agentsCopyBtn.addEventListener('click', async function () {
      await handleCopy.call(this, () => getAgentsTerminalState()?.term ?? null);
    });
  }
}

function getActiveSendBarForPanel() {
  const chatPanel = document.getElementById('chat-panel');
  const terminalPanel = document.getElementById('terminal-panel');
  if (chatPanel?.classList.contains('active')) return getActiveSendBar();
  if (terminalPanel?.classList.contains('active')) return getTerminalSendBar();
  return null;
}

function initLangSelect() {
  const select = document.getElementById('lang-select');
  if (!select) return;
  if (select.tagName === 'CR-BAR-SELECT') {
    select.options = [
      { value: 'en', label: 'English' },
      { value: 'pl', label: 'Polski' },
    ];
  }
  select.value = getCurrentLang();
  select.addEventListener('change', () => void setLang(select.value));
}

const APP_STORAGE_PREFIXES = Object.freeze(['cretli-', 'cursor-remote-', 'cr-debug-overlay']);
const APP_IDB_NAMES = Object.freeze([
  'cretli-chat-metadata',
  'cretli-sdk-chat',
  'cretli-chat-buffers',
  'cretli-preferences',
  'cretli-push-inbox',
]);

function formatBytes(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return '0 B';
  if (num < 1024) return `${Math.round(num)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let current = num / 1024;
  let idx = 0;
  while (current >= 1024 && idx < units.length - 1) {
    current /= 1024;
    idx += 1;
  }
  const rounded = current >= 10 ? Math.round(current) : Math.round(current * 10) / 10;
  return `${rounded} ${units[idx]}`;
}

function formatPercent(value, total) {
  const base = Number(total);
  if (!Number.isFinite(base) || base <= 0) return '—';
  const part = Number(value);
  if (!Number.isFinite(part) || part <= 0) return '0%';
  const ratio = Math.max(0, Math.min(1, part / base));
  const percent = ratio * 100;
  if (percent >= 10) return `${Math.round(percent)}%`;
  return `${Math.round(percent * 10) / 10}%`;
}

function isAppStorageKey(key) {
  if (!key || typeof key !== 'string') return false;
  return APP_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function collectLocalStorageStats() {
  if (typeof localStorage === 'undefined') {
    return { allBytes: 0, appBytes: 0, allCount: 0, appItems: [] };
  }
  let allBytes = 0;
  let appBytes = 0;
  let allCount = 0;
  const appItems = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (!key) continue;
    allCount += 1;
    let value = '';
    try {
      value = localStorage.getItem(key) || '';
    } catch (_) {
      value = '';
    }
    const bytes = (String(key).length + String(value).length) * 2;
    allBytes += bytes;
    if (!isAppStorageKey(key)) continue;
    appBytes += bytes;
    appItems.push({ key, bytes });
  }
  appItems.sort((a, b) => b.bytes - a.bytes);
  return { allBytes, appBytes, allCount, appItems };
}

function collectSessionStorageStats() {
  if (typeof sessionStorage === 'undefined') {
    return { allBytes: 0, appBytes: 0, allCount: 0, appItems: [] };
  }
  let allBytes = 0;
  let appBytes = 0;
  let allCount = 0;
  const appItems = [];
  for (let i = 0; i < sessionStorage.length; i += 1) {
    const key = sessionStorage.key(i);
    if (!key) continue;
    allCount += 1;
    let value = '';
    try {
      value = sessionStorage.getItem(key) || '';
    } catch (_) {
      value = '';
    }
    const bytes = (String(key).length + String(value).length) * 2;
    allBytes += bytes;
    if (!isAppStorageKey(key)) continue;
    appBytes += bytes;
    appItems.push({ key, bytes });
  }
  appItems.sort((a, b) => b.bytes - a.bytes);
  return { allBytes, appBytes, allCount, appItems };
}

async function readStorageEstimate() {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) {
    return { quota: 0, usage: 0, usageDetails: {}, hasUsageDetails: false };
  }
  try {
    const est = await navigator.storage.estimate();
    const usageDetails = est?.usageDetails && typeof est.usageDetails === 'object'
      ? est.usageDetails
      : {};
    return {
      quota: Number(est?.quota) || 0,
      usage: Number(est?.usage) || 0,
      usageDetails,
      hasUsageDetails: Object.keys(usageDetails).length > 0,
    };
  } catch (_) {
    return { quota: 0, usage: 0, usageDetails: {}, hasUsageDetails: false };
  }
}

async function listIndexedDbNames() {
  if (typeof indexedDB === 'undefined') return [];
  if (typeof indexedDB.databases !== 'function') return APP_IDB_NAMES.slice();
  try {
    const rows = await indexedDB.databases();
    const names = rows
      .map((row) => (typeof row?.name === 'string' ? row.name.trim() : ''))
      .filter((name) => name);
    return Array.from(new Set(names));
  } catch (_) {
    return APP_IDB_NAMES.slice();
  }
}

async function listCacheStorageNames() {
  if (typeof caches === 'undefined' || typeof caches.keys !== 'function') return [];
  try {
    const names = await caches.keys();
    return Array.isArray(names) ? names.filter((name) => typeof name === 'string') : [];
  } catch (_) {
    return [];
  }
}

function clearLocalStorageAppData() {
  if (typeof localStorage !== 'undefined') {
    const keys = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!isAppStorageKey(key || '')) continue;
      keys.push(String(key));
    }
    for (const key of keys) {
      try {
        localStorage.removeItem(key);
      } catch (_) {}
    }
  }
  // Task 2.1: dropping the persisted activity maps must also drop the RAM copy,
  // and the fresh session marker keeps later writes re-importable.
  void applyChatAuthSessionBoundary({ reason: 'clear-local-data' });
}

function clearSessionStorageAppData() {
  if (typeof sessionStorage === 'undefined') return;
  const keys = [];
  for (let i = 0; i < sessionStorage.length; i += 1) {
    const key = sessionStorage.key(i);
    if (!isAppStorageKey(key || '')) continue;
    keys.push(String(key));
  }
  for (const key of keys) {
    try {
      sessionStorage.removeItem(key);
    } catch (_) {}
  }
}

async function clearIndexedDbAppData() {
  if (typeof indexedDB !== 'undefined') {
    const known = new Set(APP_IDB_NAMES);
    const discovered = await listIndexedDbNames();
    for (const name of discovered) {
      if (!name || !name.startsWith('cretli-')) continue;
      known.add(name);
    }
    await Promise.all(
      [...known].map(
        (name) =>
          new Promise((resolve) => {
            try {
              const req = indexedDB.deleteDatabase(name);
              req.onsuccess = () => resolve();
              req.onerror = () => resolve();
              req.onblocked = () => resolve();
            } catch (_) {
              resolve();
            }
          })
      )
    );
  }
}

async function clearCacheStorageAppData() {
  if (typeof caches !== 'undefined' && typeof caches.keys === 'function') {
    try {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => typeof name === 'string' && (name.includes('cretli') || name.includes('cursor-remote')))
          .map((name) => caches.delete(name))
      );
    } catch (_) {}
  }
}

async function clearAppStorageData() {
  clearLocalStorageAppData();
  clearSessionStorageAppData();
  await Promise.all([
    clearIndexedDbAppData(),
    clearCacheStorageAppData(),
  ]);
}

function collectCookieStats() {
  if (typeof document === 'undefined') return { count: 0, bytes: 0 };
  const raw = String(document.cookie || '');
  if (!raw) return { count: 0, bytes: 0 };
  const parts = raw.split(';').map((part) => part.trim()).filter((part) => part);
  return {
    count: parts.length,
    bytes: raw.length * 2,
  };
}

function getBrowserEnvironmentLines() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return ['-'];
  const lines = [];
  const timezone = Intl?.DateTimeFormat?.().resolvedOptions?.().timeZone || '—';
  const platform = navigator.userAgentData?.platform || navigator.platform || '—';
  const online = navigator.onLine ? t('common.yes') : t('common.no');
  const touchPoints = Number(navigator.maxTouchPoints) || 0;
  const dpr = Number(window.devicePixelRatio) || 1;
  const viewport = `${window.innerWidth}x${window.innerHeight}`;
  const screenSize = `${window.screen?.width || 0}x${window.screen?.height || 0}`;
  const memoryGb = Number(navigator.deviceMemory) || 0;
  const cores = Number(navigator.hardwareConcurrency) || 0;
  const languages = Array.isArray(navigator.languages) && navigator.languages.length
    ? navigator.languages.join(', ')
    : (navigator.language || '—');
  lines.push(`UA: ${navigator.userAgent || '—'}`);
  lines.push(`Platform: ${platform}`);
  lines.push(`Online: ${online}`);
  lines.push(`Language(s): ${languages}`);
  lines.push(`Timezone: ${timezone}`);
  lines.push(`Viewport: ${viewport} (DPR ${dpr})`);
  lines.push(`Screen: ${screenSize}`);
  lines.push(`Touch points: ${touchPoints}`);
  lines.push(`CPU cores: ${cores || '—'}`);
  lines.push(`Device memory: ${memoryGb > 0 ? `${memoryGb} GB` : '—'}`);
  lines.push(`Cookies enabled: ${navigator.cookieEnabled ? t('common.yes') : t('common.no')}`);
  lines.push(`Standalone/PWA: ${(window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone) ? t('common.yes') : t('common.no')}`);
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (connection) {
    const downlink = Number(connection.downlink);
    const rtt = Number(connection.rtt);
    const effectiveType = connection.effectiveType || '—';
    lines.push(`Network: ${effectiveType}, downlink ${Number.isFinite(downlink) ? `${downlink} Mb/s` : '—'}, RTT ${Number.isFinite(rtt) ? `${rtt} ms` : '—'}`);
    if (typeof connection.saveData === 'boolean') {
      lines.push(`Data saver: ${connection.saveData ? t('common.yes') : t('common.no')}`);
    }
  } else {
    lines.push('Network: —');
  }
  const perfMem = typeof performance !== 'undefined' ? performance.memory : null;
  if (perfMem && Number.isFinite(perfMem.usedJSHeapSize) && Number.isFinite(perfMem.jsHeapSizeLimit)) {
    lines.push(`JS heap: ${formatBytes(perfMem.usedJSHeapSize)} / ${formatBytes(perfMem.jsHeapSizeLimit)}`);
  }
  return lines;
}

async function readStoragePersistence() {
  if (typeof navigator === 'undefined' || !navigator.storage?.persisted) {
    return '—';
  }
  try {
    const persisted = await navigator.storage.persisted();
    return persisted ? t('common.yes') : t('common.no');
  } catch (_) {
    return '—';
  }
}

function renderBrowserStorageCharts(container, charts, onAction) {
  if (!container) return;
  container.textContent = '';
  if (!Array.isArray(charts) || charts.length === 0) return;
  const fragment = document.createDocumentFragment();
  for (const chart of charts) {
    if (!chart || typeof chart !== 'object') continue;
    const donut = document.createElement('cr-storage-donut');
    donut.label = chart.label || '';
    donut.subtitle = chart.subtitle || '';
    donut.hint = chart.hint || '';
    donut.value = Number(chart.value) || 0;
    donut.total = Number(chart.total) || 0;
    donut.tone = chart.tone || 'primary';
    if (chart.actionId && chart.actionLabel) {
      donut.actionLabel = chart.actionLabel;
      donut.dataset.browserStorageInlineAction = chart.actionId;
      donut.addEventListener('cr-clear', () => onAction(chart.actionId));
    }
    fragment.appendChild(donut);
  }
  container.appendChild(fragment);
}

function initBrowserStorageTools() {
  const refreshBtn = document.getElementById('browser-storage-refresh-btn');
  const clearLocalBtn = document.getElementById('browser-storage-clear-local-btn');
  const clearIdbBtn = document.getElementById('browser-storage-clear-idb-btn');
  const clearCacheBtn = document.getElementById('browser-storage-clear-cache-btn');
  const clearAllBtn = document.getElementById('browser-storage-clear-all-btn');
  const chartsEl = document.getElementById('browser-storage-charts');
  const summaryEl = document.getElementById('browser-storage-summary');
  const detailsEl = document.getElementById('browser-storage-details');
  const envEl = document.getElementById('browser-storage-environment');
  const statusEl = document.getElementById('browser-storage-status');
  if (!refreshBtn || !clearLocalBtn || !clearIdbBtn || !clearCacheBtn || !clearAllBtn) return;
  if (!chartsEl || !summaryEl || !detailsEl || !envEl || !statusEl) return;

  const setStatus = (text, isError = false) => {
    statusEl.textContent = text;
    statusEl.style.color = isError ? 'var(--cr-error)' : '';
  };

  const clearLocalAction = () => runClearAction(t('settings.browserStorageConfirmLocal'), async () => {
    clearLocalStorageAppData();
    clearSessionStorageAppData();
  });
  const clearIdbAction = () => runClearAction(t('settings.browserStorageConfirmIdb'), () => clearIndexedDbAppData());
  const clearCacheAction = () => runClearAction(t('settings.browserStorageConfirmCache'), () => clearCacheStorageAppData());
  const clearAllAction = () => runClearAction(t('settings.browserStorageConfirmAll'), async () => {
    await clearAppStorageData();
    setTimeout(() => window.location.reload(), 450);
  });
  const runInlineAction = (actionId) => {
    if (actionId === 'clear-local') {
      void clearLocalAction();
      return;
    }
    if (actionId === 'clear-idb') {
      void clearIdbAction();
      return;
    }
    if (actionId === 'clear-cache') {
      void clearCacheAction();
    }
  };

  const renderSnapshot = async () => {
    setStatus(t('common.loading'));
    const [estimate, localStats, sessionStats, idbNames, cacheNames, persisted] = await Promise.all([
      readStorageEstimate(),
      Promise.resolve(collectLocalStorageStats()),
      Promise.resolve(collectSessionStorageStats()),
      listIndexedDbNames(),
      listCacheStorageNames(),
      readStoragePersistence(),
    ]);
    const cookieStats = collectCookieStats();
    const usagePct = formatPercent(estimate.usage, estimate.quota);
    const idbUsage = Number(estimate.usageDetails?.indexedDB) || 0;
    const cacheUsage = Number(estimate.usageDetails?.caches) || 0;
    const localShareValue = localStats.appBytes;
    const localShareTotal = localStats.allBytes;
    const sessionShareValue = sessionStats.appBytes;
    const sessionShareTotal = sessionStats.allBytes;

    renderBrowserStorageCharts(chartsEl, [
      {
        label: t('settings.browserStorageChartOrigin'),
        subtitle: `${formatBytes(estimate.usage)} / ${formatBytes(estimate.quota)}`,
        value: estimate.usage,
        total: estimate.quota,
        hint: t('settings.browserStorageChartOriginHint', { percent: usagePct }),
        tone: 'primary',
      },
      {
        label: t('settings.browserStorageChartLocal'),
        subtitle: `${formatBytes(localShareValue)} / ${formatBytes(localShareTotal)}`,
        value: localShareValue,
        total: localShareTotal,
        hint: t('settings.browserStorageChartLocalHint', {
          percent: formatPercent(localShareValue, localShareTotal),
        }),
        tone: 'success',
        actionId: 'clear-local',
        actionLabel: t('settings.browserStorageClearLocalShort'),
      },
      {
        label: t('settings.browserStorageChartSession'),
        subtitle: `${formatBytes(sessionShareValue)} / ${formatBytes(sessionShareTotal)}`,
        value: sessionShareValue,
        total: sessionShareTotal,
        hint: t('settings.browserStorageChartSessionHint', {
          percent: formatPercent(sessionShareValue, sessionShareTotal),
        }),
        tone: 'success',
        actionId: 'clear-local',
        actionLabel: t('settings.browserStorageClearLocalShort'),
      },
      {
        label: t('settings.browserStorageChartIdb'),
        subtitle: `${formatBytes(idbUsage)} / ${formatBytes(estimate.usage)}`,
        value: idbUsage,
        total: estimate.usage,
        hint: estimate.hasUsageDetails
          ? t('settings.browserStorageChartIdbHint', { percent: formatPercent(idbUsage, estimate.usage) })
          : t('settings.browserStorageChartBreakdownUnavailable'),
        tone: 'warn',
        actionId: 'clear-idb',
        actionLabel: t('settings.browserStorageClearIdbShort'),
      },
      {
        label: t('settings.browserStorageChartCache'),
        subtitle: `${formatBytes(cacheUsage)} / ${formatBytes(estimate.usage)}`,
        value: cacheUsage,
        total: estimate.usage,
        hint: estimate.hasUsageDetails
          ? t('settings.browserStorageChartCacheHint', { percent: formatPercent(cacheUsage, estimate.usage) })
          : t('settings.browserStorageChartBreakdownUnavailable'),
        tone: 'warn',
        actionId: 'clear-cache',
        actionLabel: t('settings.browserStorageClearCacheShort'),
      },
    ], runInlineAction);

    summaryEl.textContent =
      `${t('settings.browserStorageUsageOrigin')}: ${formatBytes(estimate.usage)} / ${formatBytes(estimate.quota)} (${usagePct})\n` +
      `${t('settings.browserStorageUsagePersisted')}: ${persisted}\n` +
      `${t('settings.browserStorageUsageLocalAll')}: ${formatBytes(localStats.allBytes)} (${localStats.allCount})\n` +
      `${t('settings.browserStorageUsageLocalApp')}: ${formatBytes(localStats.appBytes)} (${localStats.appItems.length})\n` +
      `${t('settings.browserStorageUsageSessionAll')}: ${formatBytes(sessionStats.allBytes)} (${sessionStats.allCount})\n` +
      `${t('settings.browserStorageUsageSessionApp')}: ${formatBytes(sessionStats.appBytes)} (${sessionStats.appItems.length})\n` +
      `${t('settings.browserStorageUsageIdb')}: ${idbNames.length}\n` +
      `${t('settings.browserStorageUsageCache')}: ${cacheNames.length}\n` +
      `${t('settings.browserStorageUsageCookies')}: ${cookieStats.count} (${formatBytes(cookieStats.bytes)})`;

    const topKeys = localStats.appItems
      .slice(0, 12)
      .map((item, idx) => `${idx + 1}. ${item.key} — ${formatBytes(item.bytes)}`);
    const topSessionKeys = sessionStats.appItems
      .slice(0, 12)
      .map((item, idx) => `${idx + 1}. ${item.key} — ${formatBytes(item.bytes)}`);
    const idbLines = idbNames.length ? idbNames.map((name) => `- ${name}`) : ['- (none)'];
    const cacheLines = cacheNames.length ? cacheNames.map((name) => `- ${name}`) : ['- (none)'];
    detailsEl.textContent =
      `${t('settings.browserStorageTopLocal')}:\n${topKeys.length ? topKeys.join('\n') : '- (none)'}\n\n` +
      `${t('settings.browserStorageTopSession')}:\n${topSessionKeys.length ? topSessionKeys.join('\n') : '- (none)'}\n\n` +
      `${t('settings.browserStorageIndexedDbList')}:\n${idbLines.join('\n')}\n\n` +
      `${t('settings.browserStorageCacheList')}:\n${cacheLines.join('\n')}`;
    envEl.textContent = `${t('settings.browserStorageEnvironmentList')}:\n${getBrowserEnvironmentLines().join('\n')}`;
    setStatus('OK');
  };

  const setActionsDisabled = (disabled) => {
    refreshBtn.disabled = disabled;
    clearLocalBtn.disabled = disabled;
    clearIdbBtn.disabled = disabled;
    clearCacheBtn.disabled = disabled;
    clearAllBtn.disabled = disabled;
    const inlineDonuts = chartsEl.querySelectorAll('cr-storage-donut[data-browser-storage-inline-action]');
    for (const donut of inlineDonuts) {
      donut.actionDisabled = disabled;
    }
  };

  const runClearAction = async (confirmText, clearFn) => {
    if (!window.confirm(confirmText)) return;
    setActionsDisabled(true);
    setStatus(t('common.removing'));
    try {
      await clearFn();
      setStatus(t('common.removed'));
      await renderSnapshot();
    } catch (err) {
      setStatus(`${t('settings.browserStorageErrorPrefix')}: ${err?.message || t('errors.unknown')}`, true);
    } finally {
      setActionsDisabled(false);
    }
  };

  refreshBtn.addEventListener('click', () => {
    void renderSnapshot();
  });

  clearLocalBtn.addEventListener('click', () => void clearLocalAction());

  clearIdbBtn.addEventListener('click', () => void clearIdbAction());

  clearCacheBtn.addEventListener('click', () => void clearCacheAction());

  clearAllBtn.addEventListener('click', () => void clearAllAction());

  void renderSnapshot();
}

function initBrowserSelfOriginSetting() {
  const checkbox = document.getElementById('browser-policy-self-origin');
  const privateNetwork = document.getElementById('browser-policy-private-network');
  const insecureTls = document.getElementById('browser-policy-insecure-tls');
  const originsInput = document.getElementById('browser-policy-allowed-origins');
  const saveBtn = document.getElementById('browser-policy-self-origin-save');
  const status = document.getElementById('browser-policy-self-origin-status');
  if (!checkbox || !privateNetwork || !insecureTls || !originsInput || !saveBtn || !status) return;

  const setStatus = (message, isError = false) => {
    status.textContent = message;
    status.style.color = isError ? 'var(--cr-error)' : '';
  };
  const load = async () => {
    try {
      const result = await api.getBrowserPolicy();
      checkbox.checked = result?.policy?.allowSelfOrigin === true;
      privateNetwork.checked = result?.policy?.allowPrivateNetwork === true;
      insecureTls.checked = result?.policy?.allowInsecureTls === true;
      originsInput.value = Array.isArray(result?.policy?.allowedOrigins)
        ? result.policy.allowedOrigins.join('\n')
        : '';
    } catch (err) {
      setStatus(err?.message || t('errors.unknown'), true);
    }
  };
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    setStatus(t('common.saving'));
    try {
      const allowedOrigins = originsInput.value
        .split(/\r?\n/)
        .map((origin) => origin.trim())
        .filter(Boolean);
      await api.patchBrowserPolicy({
        allowSelfOrigin: checkbox.checked,
        allowPrivateNetwork: privateNetwork.checked,
        allowInsecureTls: insecureTls.checked,
        allowedOrigins,
      });
      setStatus(t('common.saved'));
    } catch (err) {
      setStatus(err?.message || t('errors.unknown'), true);
    } finally {
      saveBtn.disabled = false;
    }
  });
  void load();
}

function onDomReady() {
  startupLog('DOMContentLoaded');
  initClientInstance();
  // Non-English dictionaries are separate chunks, so wait for the active one
  // before any text is rendered.
  void initI18n().then(() => {
    applyStaticTranslations();
    wireStaticTranslations();
    ensureAuthenticatedThenBoot();
  });
}

/** Checks the session: redirects to /login when it is missing, otherwise boots the app. */
function ensureAuthenticatedThenBoot() {
  if (isEmbedModeEnabled()) {
    initEmbedWidgetHostBridge();
    if (widgetConnection) {
      bootApp();
      return;
    }
    window.addEventListener('cr-widget-connected', () => bootApp(), { once: true });
    return;
  }
  api.getAuthStatus()
    .then((data) => {
      if (data && data.ok && data.configured && data.authRequired) {
        const next = encodeURIComponent(window.location.pathname + window.location.search);
        window.location.replace(`/login?next=${next}`);
        return;
      }
      if (data && data.ok && !data.configured) {
        window.location.replace('/login');
        return;
      }
      bootApp();
    })
    .catch(() => {
      void resolveBootAfterAuthStatusFailure();
    });
}

/**
 * Offline cold start: the auth-status probe rejected. Boot the SPA when this client is
 * offline and has local chat data to hydrate; otherwise keep the "backend unavailable"
 * overlay. The online auth gate in `ensureAuthenticatedThenBoot().then` is unchanged.
 */
async function resolveBootAfterAuthStatusFailure() {
  const online = typeof navigator !== 'undefined' ? navigator.onLine !== false : true;
  const storage = typeof localStorage !== 'undefined' ? localStorage : null;
  let hasLocalBootCache = hasLocalChatBootCacheForColdStart(storage);
  if (!online && !hasLocalBootCache) {
    // The full snapshot is often only in IndexedDB (localStorage sync doc missing);
    // seed the sync doc from it so the cached chat list renders on this boot.
    try {
      hasLocalBootCache = await seedLocalBootSyncFromIdbBootCache({
        storage,
        preferChatId: readRequestedChatId(),
      });
    } catch (_) {
      hasLocalBootCache = false;
    }
  }
  const decision = resolveBootOnAuthStatusFailure({ online, hasLocalBootCache });
  if (decision === 'boot') {
    bootApp();
    return;
  }
  showBackendUnavailableOverlay(() => ensureAuthenticatedThenBoot());
}

/** "Backend unavailable" overlay with a retry, shown instead of silently booting the SPA. */
function showBackendUnavailableOverlay(retryFn) {
  if (document.getElementById('cr-backend-unavailable')) return;
  const overlay = document.createElement('div');
  overlay.id = 'cr-backend-unavailable';
  overlay.setAttribute('style', [
    'position:fixed', 'inset:0', 'display:flex', 'flex-direction:column',
    'align-items:center', 'justify-content:center', 'gap:1rem',
    'background:#1e1e1e', 'color:#d4d4d4', 'font:14px system-ui, sans-serif',
    'z-index:99999', 'text-align:center', 'padding:1rem',
  ].join(';'));
  const title = document.createElement('div');
  title.textContent = t('app.backendUnavailable');
  const sub = document.createElement('div');
  sub.style.opacity = '0.7';
  sub.textContent = t('app.checkingConnection');
  overlay.appendChild(title);
  overlay.appendChild(sub);
  const btn = document.createElement('button');
  btn.textContent = t('app.tryAgain');
  btn.setAttribute('style', 'padding:0.6rem 1rem;border:1px solid #444;background:#252526;color:#d4d4d4;border-radius:4px;cursor:pointer;');
  btn.addEventListener('click', () => {
    overlay.remove();
    retryFn();
  });
  overlay.appendChild(btn);
  (document.body || document.documentElement).appendChild(overlay);
  setTimeout(() => {
    if (document.getElementById('cr-backend-unavailable')) {
      overlay.remove();
      retryFn();
    }
  }, 4000);
}

/**
 * A notification click with no open window lands on ?source=pwa (full reload).
 * Log it against the in-place 'page-resume' traces so both paths are comparable.
 */
function logNotificationBootResume() {
  if (typeof window === 'undefined') return;
  const info = readNotificationBootInfo(window.location.search || '');
  if (!info) return;
  const bootMs =
    typeof performance !== 'undefined' && Number.isFinite(performance.now())
      ? Math.round(performance.now())
      : 0;
  appLogger.log('page-resume', 'notification boot (full reload)', {
    chatId: info.chatId,
    reason: 'notification',
    notification: true,
    reload: true,
    mobile: isMobileLikeClient(),
    durations: { totalMs: bootMs },
  });
}

function bootApp() {
  const isEmbedMode = isEmbedModeEnabled();
  const modeConfig = isEmbedMode ? APP_MODES.embed : APP_MODES.main;
  const boot = async () => {
    if (!isEmbedMode) {
      await syncClientDebugFlagsFromServer();
    } else {
      void syncClientDebugFlagsFromServer();
    }
    installClientDebugInstrumentation();
    initFreezeLogRecovery();
    initClientInstanceHeartbeat({
      getActiveChatId: getActiveChatIdValue,
      countOpenChatWs: () =>
        getChatsList().filter((chat) => chat.ws?.readyState === WebSocket.OPEN).length,
    });
    initClientInstanceCommands();
    if (isEmbedMode) {
      if (document.body) {
        document.body.classList.add('embed-mode');
      }
      applyEmbedWorkspaceContext();
      try {
        const savedPanel = readStorageValueWithAlias(localStorage, 'cretli-last-panel', '');
        if (!isPanelAllowed(savedPanel, modeConfig)) {
          writeStorageValueWithAlias(localStorage, 'cretli-last-panel', 'chat');
        }
      } catch (_) {}

      measureStartupStep('initTheme', () => initTheme());
      measureStartupStep('initPageBackgroundGrace', () => initPageBackgroundGrace());
      measureStartupStep('initPageResumeCleanup', () => initPageResumeCleanup({ logger: appLogger }));
      measureStartupStep('initMobileKeyboardOffsetSync', () => initMobileKeyboardOffsetSync());
      measureStartupStep('initConnectionStatus', () => initConnectionStatus());
      measureStartupStep('initVoiceModeButton', () => initVoiceModeButton());
      measureStartupStep('initServerRestartCoordinator', () => initServerRestartCoordinator());
      measureStartupStep('initEmbedWidgetHostBridge', () => initEmbedWidgetHostBridge());
      measureStartupStep('initHeaderSettings', () => initHeaderSettings(null));
      measureStartupStep('initChatPanel', () => initChatPanel());
      const embedBootQuery = parseEmbedModeQuery(window.location.search || '', window.location.pathname || '');
      void loadChatsFromServer().then(() => {
        if (embedBootQuery.widgetCreatePageChat) return;
        ensureEmbedChat();
      });
      setSidebarRenderHook(() => headerContextTitle.refresh());
      measureStartupStep('initTabs', () => initTabs(modeConfig));
      measureStartupStep('initAutoNameChatSetting', () => initAutoNameChatSetting());
      measureStartupStep('initSpecialChars', () => initSpecialChars());
      measureStartupStep('initExtraBarContextPicker', () => initExtraBarContextPicker({
        getInputElement: () => getActiveSendBarForPanel()?.input ?? null,
        getWorkspaceFolder: getActiveChatWorkspaceFolder,
      }));
      setSpecialCharHandler((sequence) => {
        if (!sequence) return;
        const focusDelayMs = sequence === '\r' ? 35 : 0;
        const chatPanel = document.getElementById('chat-panel');
        const tasksPanel = document.getElementById('tasks-panel');
        if (chatPanel?.classList.contains('active')) {
          if (sendSequenceToTerminalState(getActiveChatTerminalState(), sequence, { focusDelayMs })) return;
        }
        if (tasksPanel?.classList.contains('active')) {
          sendSequenceToTerminalState(getTasksTerminalState(), sequence, { focusDelayMs });
        }
      });
      const embedQuery = parseEmbedModeQuery(window.location.search || '');
      const defaultInitialPanel = resolveInitialPanel(modeConfig);
      const initialPanel = embedQuery.panel
        ? resolveEmbedPanel(embedQuery.panel, defaultInitialPanel)
        : defaultInitialPanel;
      measureStartupStep(`showPanel(${initialPanel})`, () => showPanel(initialPanel, modeConfig));
      window.dispatchEvent(new CustomEvent('cr-embed-boot-ready'));
      notifyWidgetEmbedReady();
      startupLog('embed boot done');
      return;
    }

    measureStartupStep('initMobileKeyboardOffsetSync', () => initMobileKeyboardOffsetSync());
    measureStartupStep('initTheme', () => initTheme());
    measureStartupStep('initPageBackgroundGrace', () => initPageBackgroundGrace());
    measureStartupStep('initPageResumeCleanup', () => initPageResumeCleanup({ logger: appLogger }));
    measureStartupStep('initConnectionStatus', () => initConnectionStatus());
    measureStartupStep('initVoiceModeButton', () => initVoiceModeButton());
    measureStartupStep('initServerRestartCoordinator', () => initServerRestartCoordinator());
    measureStartupStep('initConnectionStatusPanel', () => initConnectionStatusPanel());
    measureStartupStep('initHarnessSettings', () => initHarnessSettings());
    measureStartupStep('initChatPanel', () => initChatPanel());
    measureStartupStep('initPanelCopyButtons', () => initPanelCopyButtons());
    measureStartupStep('initTabs', () => initTabs(modeConfig));
    measureStartupStep('initHeaderSettings', () => initHeaderSettings());
    measureStartupStep('initInstallPrompt', () => initInstallPrompt());
    measureStartupStep('initPwaUpdatePrompt', () => initPwaUpdatePrompt());
    measureStartupStep('initPushSettingsToggle', () => initPushSettingsToggle());
    measureStartupStep('initServiceWorkerMessages', () =>
      initServiceWorkerMessages({ onOpenChat: openChatFromNotification, logger: appLogger })
    );
    measureStartupStep('initInAppSignals', () => initInAppSignals({
      logger: appLogger,
      chatMuteStore: getChatMuteStore(),
    }));
    measureStartupStep('initNotificationCenter', () => initNotificationCenter({
      logger: appLogger,
      onNavigate: openNotificationActionUrl,
    }));
    measureStartupStep('initWorkspacePopover', () => initWorkspacePopover() || Promise.resolve());
    measureStartupStep('initSettingsWorkspacePicker', () => initSettingsWorkspacePicker() || Promise.resolve());
    measureStartupStep('initChatActivityStore', () => installChatActivityStorageListener());
    measureStartupStep('initSidebar', () => {
      setSidebarRenderHook(() => {
        sidebarView.render();
        headerContextTitle.refresh();
        void gitContextBadge.refresh();
      });
      setSidebarTransientPatchHook(() => sidebarView.patchTransientVisualStates());
      setSidebarOpenHook(() => sidebarView.open());
      setSidebarCloseHook(() => sidebarView.close());
      setWorkspaceSwitchHook((workspaceFile, folder) => switchWorkspace(workspaceFile, folder));
      sidebarView.init();
      void hydrateSidebarLayout();
      registerPageResumeCleanupHook(() => {
        const shouldClose = shouldCloseSidebarOnResume({
          isOpen: sidebarView.isOpen(),
          isPinned: sidebarView.isPinned(),
          isMobile:
            typeof window !== 'undefined' && window.matchMedia
              ? window.matchMedia('(max-width: 768px)').matches
              : false,
        });
        if (!shouldClose) return undefined;
        sidebarView.close();
        return 'sidebar';
      });
      // Push notifications and PWA shortcuts deep-link to ?chat=<id>.
      // The workspace list is seeded from the boot snapshot first so cached chats group
      // immediately, then revalidated from the server and re-rendered once it lands.
      const seededBootWorkspaces = seedWorkspacesListFromBootCache();
      void loadChatsFromServer({ preferChatId: readRequestedChatId() });
      const sidebarWorkspaceRender = ensureWorkspacesListLoaded()
        .then(() => sidebarView.forceRerender())
        .then(() => (seededBootWorkspaces ? ensureWorkspacesListLoaded({ refresh: true }) : null))
        .then(() => sidebarView.forceRerender());
      sidebarWorkspaceRender.catch(() => {});
    });
    measureStartupStep('initSettingsTabs', () => initSettingsTabs());
    measureStartupStep('initUsageSettings', () => initUsageSettings());
    measureStartupStep('initDelegationCenter', () => initDelegationCenter());
    // GitHub only needs to exist to hide/show its tab — load after first paint.
    const scheduleIdle = typeof requestIdleCallback === 'function'
      ? (fn) => requestIdleCallback(fn, { timeout: 4000 })
      : (fn) => setTimeout(fn, 1500);
    scheduleIdle(() => {
      void ensurePanelReady('github');
    });
    measureStartupStep('initTodoPanel', () => initTodoPanel({ showPanel }));
    measureStartupStep('initLogsPanel', () => initLogsPanel());

    setQuickCommandHandler((text) => {
      const terminalPanel = document.getElementById('terminal-panel');
      const chatPanel = document.getElementById('chat-panel');
      const tasksPanel = document.getElementById('tasks-panel');
      const agentsPanel = document.getElementById('agents-panel');
      if (terminalPanel?.classList.contains('active')) {
        const active = terminalPanelState?.getActiveTerminal?.();
        if (active?.term) active.term.write(text + '\r');
      } else if (chatPanel?.classList.contains('active')) {
        const input = getActiveSendInput();
        if (input) {
          input.value = text;
          input.focus();
        }
      } else if (tasksPanel?.classList.contains('active')) {
        const term = getTasksTerminalState()?.term;
        if (term) term.write(text + '\r');
      } else if (agentsPanel?.classList.contains('active')) {
        const term = getAgentsTerminalState()?.term;
        if (term) term.write(text + '\r');
      }
    });
    measureStartupStep('initQuickCommands', () => initQuickCommands());
    measureStartupStep('initTerminalFontSizeSettings', () => initTerminalFontSizeSettings());
    measureStartupStep('initAutoNameChatSetting', () => initAutoNameChatSetting());
    measureStartupStep('initKibRadialSetting', () => initKibRadialSetting());
    measureStartupStep('initKibRadial', () => initKibRadial());
    measureStartupStep('initThemeSelect', () => initThemeSelect());
    measureStartupStep('initLangSelect', () => initLangSelect());
    measureStartupStep('initBrowserStorageTools', () => initBrowserStorageTools());
    measureStartupStep('initBrowserSelfOriginSetting', () => initBrowserSelfOriginSetting());
    measureStartupStep('initSpecialChars', () => initSpecialChars());
    measureStartupStep('initExtraBarContextPicker', () => initExtraBarContextPicker({
      getInputElement: () => getActiveSendBarForPanel()?.input ?? null,
      getWorkspaceFolder: getActiveChatWorkspaceFolder,
    }));
    setSpecialCharHandler((sequence) => {
      if (!sequence) return;
      const focusDelayMs = sequence === '\r' ? 35 : 0;
      const terminalPanel = document.getElementById('terminal-panel');
      const chatPanel = document.getElementById('chat-panel');
      const tasksPanel = document.getElementById('tasks-panel');
      const agentsPanel = document.getElementById('agents-panel');
      if (terminalPanel?.classList.contains('active')) {
        const active = terminalPanelState?.getActiveTerminal?.();
        if (sendSequenceToTerminalState(active, sequence, { focusDelayMs })) return;
      }
      if (chatPanel?.classList.contains('active')) {
        if (sendSequenceToTerminalState(getActiveChatTerminalState(), sequence, { focusDelayMs })) return;
      }
      if (tasksPanel?.classList.contains('active')) {
        if (sendSequenceToTerminalState(getTasksTerminalState(), sequence, { focusDelayMs })) return;
      }
      if (agentsPanel?.classList.contains('active')) {
        sendSequenceToTerminalState(getAgentsTerminalState(), sequence, { focusDelayMs });
      }
    });

    // Restore the last panel from localStorage so a reload lands back on the same tab, e.g. Tasks.
    const initialPanel = resolveInitialPanel(modeConfig);
    showPanel(initialPanel, modeConfig);
    startupLog(`initial panel rendered: ${initialPanel}`);
    startupLog('boot sync phase done');
    logNotificationBootResume();
    // Read by the inline boot guard in index.html: no flag within its timeout
    // means the boot stalled and the failure screen should take over.
    window.__crAppBooted = true;
    void maybeShowFirstRunSetup({
      onConfigured: () => openNewChatModal(),
      onWorkspaceAdded: () => {
        void ensureWorkspacesListLoaded({ refresh: true }).then(() => {
          window.dispatchEvent(new CustomEvent('cretli-workspace-updated'));
          sidebarView.forceRerender();
        });
      },
    });
  };

  if (!isEmbedMode) {
    boot();
    return;
  }

  boot();
}

if (typeof document !== 'undefined' && document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', onDomReady);
} else {
  onDomReady();
}

if (typeof module === 'undefined') {
  // noop outside webpack HMR
} else if (module.hot) {
  // Accept the hot update but force a full reload instead of an in-place re-boot:
  // on mobile that avoids duplicated listeners and leaks.
  // CSS HMR (style-loader) works independently and does not reload the page.
  module.hot.accept(() => {
    if (typeof window !== 'undefined') window.location.reload();
  });
}
