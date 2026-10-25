/** Builds the SPA navigation controller (history, route restore, panel apply) for the shell. */
import { appLogger } from '../../core/logging/logger.js';
import { t } from '../../i18n/index.js';
import { selectChat } from '../../features/chat/index.js';
import { openTodo } from '../../features/todo/index.js';
import { openFilesRoutePath } from '../../features/files/index.js';
import { getTerminalSession } from '../../core/api/index.js';
import { applyGitSubviewFromRoute } from '../../features/git/worktreeList.js';
import { clearTerminalSessionFromRoute, joinTerminalSessionFromRoute } from '../../features/terminal/index.js';
import { listScopedTaskRunIdsForRoute, restoreTaskRunFromRoute } from '../../features/tasks/index.js';
import { listScopedAgentRunIdsForRoute, restoreAgentRunFromRoute } from '../../features/agents/index.js';
import {
  listBrowserSessionsForRoute,
  listBrowserTabsForRoute,
  restoreBrowserRouteTarget,
} from '../../features/browser/browserPanel.js';
import { createSpaNavigation } from './spaNavigation.js';
import { getSharedSpaNavigation, setSharedSpaNavigation } from './spaNavigationBridge.js';
import { createRouteResourceRestorer } from './routeResourceRestore.js';
import { persistViewRoute } from './viewRouteStorage.js';
import { restoreViewMemoryForRoute } from './viewMemoryBridge.js';
import { showNavigationResourceNotice } from './navigationResourceNotice.js';
import { whenViewContextScopedAccessAllowed } from './viewContextBridge.js';
import { APP_MODES } from './startup.js';

/**
 * @param {{
 *   applyRouteContext: () => unknown,
 *   ensurePanelReady: (panelKey: string) => Promise<void>,
 *   showPanel: any,
 *   applySettingsTab: (tabId: string) => void,
 *   applyRouteGitScope: () => void,
 *   isPanelAllowed: any,
 *   setMainTabHandler: (handler: (panelId: string) => void) => void,
 * }} deps
 */
export function createSpaNavigationController({
  applyRouteContext,
  ensurePanelReady,
  showPanel,
  applySettingsTab,
  applyRouteGitScope,
  isPanelAllowed,
  setMainTabHandler,
}) {
  let spaNavModeConfig = APP_MODES.main;

  /**
   * @param {object} modeConfig
   * @param {{ popstate?: boolean }} [options]
   */
  function initSpaNavigationController(modeConfig, options = {}) {
    spaNavModeConfig = modeConfig;
    const restoreRouteResources = createRouteResourceRestorer({
      replaceCanonical: (url) => getSharedSpaNavigation()?.replaceCanonicalUrl(url),
      showResourceNotice: (messageKey, detail) => {
        appLogger.log('route-restore', t(messageKey));
        showNavigationResourceNotice(messageKey, detail);
      },
      restoreChat: (chatId) => selectChat(chatId),
      restoreTodo: (todoId) => openTodo(todoId),
      restoreFilesPath: (path) => openFilesRoutePath(path),
      listTerminalSessionIds: async () => {
        try {
          const data = await getTerminalSession();
          if (!data?.ok || !data.sessionId) return [];
          return [String(data.sessionId)];
        } catch {
          return null;
        }
      },
      restoreTerminalSession: (sessionId) => joinTerminalSessionFromRoute(sessionId),
      clearTerminalSession: () => clearTerminalSessionFromRoute(),
      listBrowserSessions: () => listBrowserSessionsForRoute(),
      listBrowserTabs: (sessionId) => listBrowserTabsForRoute(sessionId),
      restoreBrowser: (sessionId, tabId) => restoreBrowserRouteTarget(sessionId, tabId),
      listTaskRunIds: async () => listScopedTaskRunIdsForRoute(),
      restoreTaskRun: (runId) => restoreTaskRunFromRoute(runId),
      listAgentRunIds: async () => listScopedAgentRunIdsForRoute(),
      restoreAgentRun: (runId) => restoreAgentRunFromRoute(runId),
      isCurrentGeneration: (token) => getSharedSpaNavigation()?.isCurrentGeneration(token) !== false,
    });
    const nav = createSpaNavigation({
      readLocation: () => ({
        pathname: window.location.pathname || '/',
        search: window.location.search || '',
      }),
      readHistoryState: () => (typeof window !== 'undefined' ? window.history?.state || {} : {}),
      writeHistory: (url, mode, state) => {
        if (typeof window === 'undefined' || !window.history) return;
        if (mode === 'push') window.history.pushState(state, '', url);
        else if (mode === 'replace') window.history.replaceState(state, '', url);
      },
      applyRouteContext: () => applyRouteContext(),
      ensurePanelReady,
      showPanel,
      applySettingsTab,
      applyGitSubview: (subview) => applyGitSubviewFromRoute(subview),
      applyRouteGitScope,
      restoreRouteResources,
      persistRoute: (route) => {
        try {
          persistViewRoute(route, {
            sessionStorage: typeof sessionStorage !== 'undefined' ? sessionStorage : null,
            localStorage: typeof localStorage !== 'undefined' ? localStorage : null,
          });
        } catch (_) {}
      },
      restoreViewMemory: (route) => restoreViewMemoryForRoute(route),
      isPanelAllowed,
      getModeConfig: () => spaNavModeConfig,
      whenScopedAccessAllowed: () => whenViewContextScopedAccessAllowed(),
      registerPopstate: (handler) => {
        window.addEventListener('popstate', handler);
      },
    });
    setSharedSpaNavigation(nav);
    setMainTabHandler((panelId) => {
      void nav.navigate({ panel: panelId }, { explicit: true });
    });
    if (options.popstate !== false) nav.initPopstate();
    return nav;
  }

  return initSpaNavigationController;
}
