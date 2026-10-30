import '../../features/approval/cr-permission-grants.js';
/**
 * Application shell orchestrator: builds the panel router, workspace context,
 * sidebar and SPA navigation, then hands control to the auth/boot flow.
 * The heavy pieces live in sibling modules (see `boot.js`).
 */
import '../../css/generated/mdi-subset.css';
import '../../css/app.scss';
import * as api from '../../core/api/index.js';
import {
  fitAllChats,
  getActiveSendBar,
  getActiveChatIdValue,
  getChatsList,
  loadChatsFromServer,
  refreshChatListForWorkspace,
  selectChat,
  setWorkspaceCloneFolderLookup,
  setWorkspacePreferredFolderLookup,
} from '../../features/chat/index.js';
import { initGitContextBadge } from '../../features/git/gitContextBadge.js';
import { readChatLocalBootCacheForColdStart } from '../../features/chat/chatLocalBootSync.js';
import { setActivePanel } from '../../features/connection/connectionStatus.js';
import { setSpecialCharsBarVisibility } from '../../features/terminal/components/specialChars.js';
import { refreshTodoList } from '../../features/todo/index.js';
import { listCloneFoldersForWorkspaceFile } from '../../features/sidebar/workspaceChatMatch.js';
import '../../components/ui/index.js';
import { createPanelRouter } from './panelRouter.js';
import { getSharedSpaNavigation } from './spaNavigationBridge.js';
import { createWorkspaceContext } from './workspaceContext.js';
import { createHeaderContextTitle } from './headerContextTitle.js';
import { initWorkspaceBranchBadge } from './workspaceBranchBadge.js';
import { initWorkspaceBranchMenu } from './workspaceBranchMenu.js';
import { initWorkspaceWorktreeBar } from './workspaceWorktreeBar.js';
import { MAIN_PANELS, setLastMainPanel } from './panelRegistry.js';
import { APP_MODES } from './startup.js';
import {
  callLoadedPanel,
  configurePanelLoader,
  ensureFilesPanelInitialized,
  ensurePanelReady,
  fitTerminalPanel,
  getTerminalSendBar,
} from './panelLoader.js';
import {
  ensureSettingsHeavyModules,
  ensureSettingsTabsVisible,
  refreshSettingsTabPanels,
  applySettingsTab,
} from './settingsTabs.js';
import { createEmbedWidgetBridge } from './embedWidgetBridge.js';
import { createHeaderChrome } from './headerChrome.js';
import { createSpaNavigationController } from './spaNavigationController.js';
import { createSidebarWiring } from './sidebarWiring.js';
import { createBootApp } from './bootApp.js';
import { createAuthBoot } from './authBoot.js';
import { applyRouteGitScope, installRouteWindowListeners } from './gitRouteScope.js';
import { getActiveWorkspaceFolderFromHeader, getActiveWorkspaceFileFromHeader } from './headerLookups.js';

let showSettingsPanelExtras = () => {};

/** Wired after SPA navigation init; until then tabs fall back to paint-only. */
const mainTabNavBridge = {
  /** @type {(panelId: string, modeConfig: object) => void} */
  handler(panelId, modeConfig) {
    showPanel(panelId, modeConfig);
  },
};

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
  ensureFilesPanelInitialized,
  refreshFilesPanel: () => callLoadedPanel('files', 'refreshFilesPanel'),
  refreshGitInfo: () => callLoadedPanel('git', 'refreshGitInfo'),
  refreshGithubPanel: () => callLoadedPanel('github', 'refreshGithubPanel'),
  refreshTodoList,
  refreshAppsPanel: () => callLoadedPanel('apps', 'refreshAppsPanel'),
  refreshInstancesPanel: () => callLoadedPanel('instances', 'refreshInstancesPanel'),
  refreshBrowserPanel: () => callLoadedPanel('browser', 'refreshBrowserPanel'),
  onShowSettings: () => showSettingsPanelExtras(),
  onMainTabSelect: (panelId, modeConfig) => mainTabNavBridge.handler(panelId, modeConfig),
});

const workspaceContext = createWorkspaceContext({
  api,
  refreshTasksList: () => callLoadedPanel('tasks', 'refreshTasksList', { invalidateCache: true }),
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
  onActivate: () => {
    void getSharedSpaNavigation()?.navigate({ panel: 'chat' }, { explicit: true });
  },
});

const {
  isPanelAllowed,
  resolveInitialPanel,
  resolveInitialBoot,
  showPanel,
  initTabs,
} = panelRouter;

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
installRouteWindowListeners();
// Workspace-folder branch chip + its quick menu (branch switch, chat filter).
initWorkspaceBranchBadge({
  getActiveWorkspaceFolder: getActiveWorkspaceFolderFromHeader,
});
initWorkspaceBranchMenu({
  getActiveWorkspaceFolder: getActiveWorkspaceFolderFromHeader,
  refreshMenuContent: () => workspaceContext.refreshWorkspaceQuickMenuContent(),
  onGitMutated: () => {
    void callLoadedPanel('git', 'refreshGitInfo');
  },
  onFilterChanged: () => sidebarView.forceRerender(),
});
const workspaceWorktreeBar = initWorkspaceWorktreeBar({
  getActiveChat: () => {
    const id = getActiveChatIdValue();
    if (!id) return null;
    return getChatsList().find((chat) => chat.id === id) || null;
  },
  getChats: () => getChatsList(),
  onSelectChat: (chatId) => selectChat(chatId, { byUser: true }),
  onFilterChanged: () => sidebarView.forceRerender(),
});
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
  applyRouteContext,
} = workspaceContext;

const embedBridge = createEmbedWidgetBridge({ applyEmbedWorkspaceContext });

const initSpaNavigationController = createSpaNavigationController({
  applyRouteContext,
  ensurePanelReady,
  showPanel,
  applySettingsTab,
  applyRouteGitScope,
  isPanelAllowed,
  setMainTabHandler: (handler) => {
    mainTabNavBridge.handler = handler;
  },
});

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

showSettingsPanelExtras = () => {
  ensureSettingsTabsVisible();
  ensureSettingsHeavyModules();
  initWorkspaceHeader();
  refreshSettingsWorkspacePicker();
  const activeSettingsTab = document.getElementById('settings-panel')?.dataset?.activeSettingsTab
    || document.querySelector('#settings-tabs .settings-tab.active')?.dataset?.settingsTab;
  refreshSettingsTabPanels(activeSettingsTab);
};

const sidebarView = createSidebarWiring({
  getWorkspacesList: getWorkspacesListFromCtx,
  switchWorkspace,
  getSidebarWorkspaceFolder,
});

const { initHeaderSettings } = createHeaderChrome({ embedBridge });

function initWidgetPanelFromApp(widgetModule) {
  widgetModule.initWidgetPanel({
    getActiveWorkspaceFile: getActiveWorkspaceFileFromHeader,
    getActiveWorkspaceFolder: getActiveWorkspaceFolderFromHeader,
    getWorkspacesList: getWorkspacesListFromCtx,
    getPreferredWorkspaceFolder: getSidebarWorkspaceFolder,
    ensureWorkspacesListLoaded,
  });
}

configurePanelLoader({ showPanel, initWidgetPanel: initWidgetPanelFromApp });

const bootApp = createBootApp({
  applyEmbedWorkspaceContext,
  isPanelAllowed,
  embedBridge,
  initHeaderSettings,
  headerContextTitle,
  initTabs,
  resolveInitialPanel,
  resolveInitialBoot,
  showPanel,
  initWorkspacePopover,
  initSpaNavigationController,
  initSettingsWorkspacePicker,
  sidebarView,
  workspaceWorktreeBar,
  gitContextBadge,
  switchWorkspace,
  seedWorkspacesListFromBootCache,
  ensureWorkspacesListLoaded,
});
const { onDomReady } = createAuthBoot({ bootApp, embedBridge });

if (typeof document !== 'undefined' && document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', onDomReady);
} else {
  onDomReady();
}
