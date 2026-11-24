/** Builds the SPA navigation controller (history, route restore, panel apply) for the shell. */
import { appLogger } from '../../core/logging/logger.js';
import { t } from '../../i18n/index.js';
import { selectChat } from '../../features/chat/index.js';
import { openTodo } from '../../features/todo/index.js';
import { getTerminalSession } from '../../core/api/index.js';
import { applyGitSubviewFromRoute } from '../../features/git/worktreeList.js';
import { loadPanelModule } from './lazyPanelModules.js';
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
   * Panel modules expose different route helpers; the shape is checked at runtime.
   * @param {string} key
   * @returns {Promise<any>}
   */
  const loadAnyPanel = (key) => loadPanelModule(key);
  /** @returns {any} */
  const sharedNav = () => getSharedSpaNavigation();

  /**
   * @param {object} modeConfig
   * @param {{ popstate?: boolean }} [options]
   */
  function initSpaNavigationController(modeConfig, options = {}) {
    spaNavModeConfig = modeConfig;
    const restoreRouteResources = createRouteResourceRestorer({
      replaceCanonical: (url) => sharedNav()?.replaceCanonicalUrl(url),
      showResourceNotice: (messageKey, detail) => {
        appLogger.log('route-restore', t(messageKey));
        showNavigationResourceNotice(messageKey, detail);
      },
      restoreChat: (chatId) => selectChat(chatId),
      restoreTodo: (todoId) => openTodo(todoId),
      restoreFilesPath: async (path) => (await loadAnyPanel('files')).openFilesRoutePath(path),
      listTerminalSessionIds: async () => {
        try {
          const data = await getTerminalSession();
          if (!data?.ok || !data.sessionId) return [];
          return [String(data.sessionId)];
        } catch {
          return null;
        }
      },
      restoreTerminalSession: async (sessionId) => (await loadAnyPanel('terminal')).joinTerminalSessionFromRoute(sessionId),
      clearTerminalSession: async () => (await loadAnyPanel('terminal')).clearTerminalSessionFromRoute(),
      listBrowserSessions: async () => (await loadAnyPanel('browser')).listBrowserSessionsForRoute(),
      listBrowserTabs: async (sessionId) => (await loadAnyPanel('browser')).listBrowserTabsForRoute(sessionId),
      restoreBrowser: async (sessionId, tabId) => (await loadAnyPanel('browser')).restoreBrowserRouteTarget(sessionId, tabId),
      listTaskRunIds: async () => (await loadAnyPanel('tasks')).listScopedTaskRunIdsForRoute(),
      restoreTaskRun: async (runId) => (await loadAnyPanel('tasks')).restoreTaskRunFromRoute(runId),
      isCurrentGeneration: (token) => sharedNav()?.isCurrentGeneration(token) !== false,
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
