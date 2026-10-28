/** Boot sequence: wires every panel, the sidebar and the first route once auth passed. */
import {
  initChatPanel,
  openNewChatModal,
  initAutoNameChatSetting,
  loadChatsFromServer,
  ensureEmbedChat,
  getActiveSendInput,
  getActiveChatTerminalState,
  getActiveChatIdValue,
  getChatsList,
  setSidebarRenderHook,
  setSidebarTransientPatchHook,
  setSidebarOpenHook,
  setSidebarCloseHook,
  setWorkspaceSwitchHook,
  openChatFromNotification,
} from '../../features/chat/index.js';
import { maybeShowFirstRunSetup } from '../../features/setup/firstRunSetup.js';
import { installChatActivityStorageListener } from '../../features/chat/chatActivityStore.js';
import { initHarnessSettings } from '../../features/settings/models/harnessSettings.js';
import { initQuickCommands, setQuickCommandHandler } from '../../features/terminal/components/quickCommands.js';
import { initTerminalFontSizeSettings } from '../../features/terminal/services/terminalSettings.js';
import { initConnectionStatus } from '../../features/connection/connectionStatus.js';
import { initConnectionStatusPanel } from '../../features/connection/views/connectionStatusPanel.js';
import { initServerRestartCoordinator } from '../serverRestartCoordinator.js';
import { initSpecialChars, setSpecialCharHandler } from '../../features/terminal/components/specialChars.js';
import { initExtraBarContextPicker } from '../../features/sendBar/sendBarContextPicker.js';
import { initTheme, initThemeSelect } from '../../core/theme/theme.js';
import {
  appLogger,
  initLogsPanel,
  installClientDebugInstrumentation,
  syncClientDebugFlagsFromServer,
  initFreezeLogRecovery,
} from '../../core/logging/logger.js';
import { initClientInstanceHeartbeat } from '../../lib/clientInstanceHeartbeat.js';
import { initClientInstanceCommands } from '../../lib/clientInstanceCommands.js';
import { initKibRadial, initKibRadialSetting } from '../../features/terminal/views/kibRadial.js';
import { initTodoPanel, openTodo } from '../../features/todo/index.js';
import { sendSequenceToTerminalState } from '../../features/terminal/services/inputDispatch.js';
import { hydrateSidebarLayout } from '../../features/sidebar/sidebarLayoutSync.js';
import { shouldCloseSidebarOnResume } from '../../features/sidebar/sidebarDock.js';
import { initVoiceModeButton } from '../../features/voice/voiceModeButton.js';
import { initUsageSettings } from '../../features/usage/usageSettings.js';
import { initWakeupsSettings } from '../../features/wakeups/wakeupsSettings.js';
import { initDelegationCenter } from '../../features/delegations/delegationCenter.js';
import { initDelegationSettings } from '../../features/settings/delegationSettings.js';
import { initAgentPromptsSettings } from '../../features/settings/agentPromptsSettings.js';
import { initMcpOperatorSettings } from '../../features/settings/mcpOperatorSettings.js';
import { initReviewLessonsSettings } from '../../features/settings/reviewLessonsSettings.js';
import { initDataBackupSettings } from '../../features/settings/dataBackupSettings.js';
import { initInstallPrompt } from '../../features/pwa/installPrompt.js';
import { initPwaUpdatePrompt } from '../../features/pwa/pwaUpdatePrompt.js';
import { initPageBackgroundGrace } from '../../lib/pageBackgroundGrace.js';
import { isMobileLikeClient } from '../../lib/mobileClient.js';
import { initPageResumeCleanup, registerPageResumeCleanupHook } from '../../lib/pageResumeCleanup.js';
import { initPushSettingsToggle } from '../../features/pwa/pushSubscription.js';
import { getChatMuteStore } from '../../features/pwa/chatMuteStore.js';
import { initInAppSignals } from '../../features/pwa/inAppSignals.js';
import { initServiceWorkerMessages, readNotificationBootInfo } from '../../features/pwa/swMessages.js';
import { initNotificationCenter } from '../../features/notifications/notificationCenter.js';
import { readStorageValueWithAlias, writeStorageValueWithAlias } from '../../lib/storageKeyAlias.js';
import { parseEmbedModeQuery, resolveEmbedPanel } from './embedMode.js';
import { isEmbedModeEnabled } from './embedWidgetBridge.js';
import { initNavigationResourceNoticeListener } from './navigationResourceNotice.js';
import { readRequestedChatId } from './panelRouter.js';
import { getSharedSpaNavigation } from './spaNavigationBridge.js';
import { whenViewContextReady, whenViewContextScopedAccessAllowed } from './viewContextBridge.js';
import { openNotificationActionUrl } from './headerChrome.js';
import { getActiveChatWorkspaceFolder } from './headerLookups.js';
import { initMobileKeyboardOffsetSync } from './mobileKeyboard.js';
import { getActiveSendBarForPanel, initLangSelect, initPanelCopyButtons } from './panelControls.js';
import {
  ensurePanelReady,
  getTasksTerminalState,
  getTerminalPanelState,
} from './panelLoader.js';
import { applyRouteGitScope } from './gitRouteScope.js';
import { initSettingsTabs } from './settingsTabs.js';
import { initBrowserSelfOriginSetting, initBrowserStorageTools } from './browserStorageTools.js';
import { APP_MODES, measureStartupStep, startupLog } from './startup.js';

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

/**
 * @param {any} deps Shell collaborators created by the runtime module.
 * @returns {() => void} `bootApp`
 */
export function createBootApp(deps) {
  const {
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
  } = deps;

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
        measureStartupStep('initEmbedWidgetHostBridge', () => embedBridge.initEmbedWidgetHostBridge());
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
        embedBridge.notifyWidgetEmbedReady();
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
      measureStartupStep('initWorkspacePopover', () => initWorkspacePopover() || Promise.resolve());
      measureStartupStep('initSpaNavigation', () => initSpaNavigationController(modeConfig));
      measureStartupStep('initTabs', () => initTabs(modeConfig));
      measureStartupStep('initHeaderSettings', () => initHeaderSettings());
      measureStartupStep('initInstallPrompt', () => initInstallPrompt());
      measureStartupStep('initPwaUpdatePrompt', () => initPwaUpdatePrompt());
      measureStartupStep('initNavigationResourceNotice', () => initNavigationResourceNoticeListener());
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
      measureStartupStep('initSettingsWorkspacePicker', () => initSettingsWorkspacePicker() || Promise.resolve());
      measureStartupStep('initChatActivityStore', () => installChatActivityStorageListener());
      // Boot passes that read workspace-scoped data. The bounded view-context wait
      // can expire while an explicit `ws`/`folder` link is still resolving: that is
      // a PENDING target, not a missing one, so nothing scoped may run on the
      // fallback (an unscoped request would be answered from the server's global
      // cwd, i.e. another workspace). The promise settles exactly once, here or on
      // the late resolve, so a slow link still loads its lists and its panel.
      const scopedBootPass = whenViewContextReady().then(() => whenViewContextScopedAccessAllowed());
      measureStartupStep('initSidebar', () => {
        setSidebarRenderHook((opts) => {
          // A pure selection flips the active markers; anything it cannot prove falls back to a full pass.
          if (!(opts?.activeOnly === true && sidebarView.applyActiveChatOnly())) sidebarView.render();
          headerContextTitle.refresh();
          workspaceWorktreeBar.refresh();
          void Promise.resolve(gitContextBadge.refresh()).then(() => workspaceWorktreeBar.refresh());
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
        // Scoped chat reads wait for the tab's own context: an explicit `ws`/folder
        // link that has not resolved must not fetch through the global cwd, and the
        // same pass resumes exactly once when that link resolves late.
        void scopedBootPass.then(() => {
          void loadChatsFromServer({ preferChatId: readRequestedChatId() });
        });
        const sidebarWorkspaceRender = ensureWorkspacesListLoaded()
          .then(() => sidebarView.forceRerender())
          .then(() => (seededBootWorkspaces ? ensureWorkspacesListLoaded({ refresh: true }) : null))
          .then(() => sidebarView.forceRerender());
        sidebarWorkspaceRender.catch(() => {});
      });
      measureStartupStep('initSettingsTabs', () => initSettingsTabs());
      measureStartupStep('initUsageSettings', () => initUsageSettings());
      measureStartupStep('initWakeupsSettings', () => initWakeupsSettings());
      measureStartupStep('initDelegationCenter', () => initDelegationCenter());
      measureStartupStep('initDelegationSettings', () => initDelegationSettings());
      measureStartupStep('initAgentPromptsSettings', () => initAgentPromptsSettings());
      measureStartupStep('initMcpOperatorSettings', () => initMcpOperatorSettings());
      measureStartupStep('initReviewLessonsSettings', () => initReviewLessonsSettings({ openTodo }));
      measureStartupStep('initDataBackupSettings', () => initDataBackupSettings());
      // GitHub only needs to exist to hide/show its tab — load after first paint.
      const scheduleIdle = typeof requestIdleCallback === 'function'
        ? (fn) => requestIdleCallback(fn, { timeout: 4000 })
        : (fn) => setTimeout(fn, 1500);
      scheduleIdle(() => {
        void ensurePanelReady('github');
      });
      measureStartupStep('initTodoPanel', () => initTodoPanel({
        showPanel: (panelId) => {
          void getSharedSpaNavigation()?.navigate({ panel: panelId }, { explicit: true });
        },
      }));
      measureStartupStep('initLogsPanel', () => initLogsPanel());

      setQuickCommandHandler((text) => {
        const terminalPanel = document.getElementById('terminal-panel');
        const chatPanel = document.getElementById('chat-panel');
        const tasksPanel = document.getElementById('tasks-panel');
        if (terminalPanel?.classList.contains('active')) {
          const active = getTerminalPanelState()?.getActiveTerminal?.();
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
        if (terminalPanel?.classList.contains('active')) {
          const active = getTerminalPanelState()?.getActiveTerminal?.();
          if (sendSequenceToTerminalState(active, sequence, { focusDelayMs })) return;
        }
        if (chatPanel?.classList.contains('active')) {
          if (sendSequenceToTerminalState(getActiveChatTerminalState(), sequence, { focusDelayMs })) return;
        }
        if (tasksPanel?.classList.contains('active')) {
          if (sendSequenceToTerminalState(getTasksTerminalState(), sequence, { focusDelayMs })) return;
        }
      });

      // Restore the last panel from localStorage so a reload lands back on the same tab, e.g. Tasks.
      // The visible panel renders only when this tab's scoped context is usable:
      // resolve workspace/folder first, then chat/TODO/Git scope, then data. A
      // pending or unresolvable explicit link keeps its own URL and the offline
      // notice instead of opening a panel that would read the global cwd.
      const initialBoot = resolveInitialBoot(modeConfig);
      const initialPanel = initialBoot.intent?.panel || resolveInitialPanel(modeConfig);
      const spaNav = getSharedSpaNavigation();
      void scopedBootPass.then(() => {
        if (spaNav) {
          void spaNav.bootApply(initialBoot.intent || { panel: initialPanel }).then(() => {
            startupLog(`initial route applied: ${initialPanel} (${initialBoot.source})`);
          });
          return;
        }
        applyRouteGitScope();
        showPanel(initialPanel, modeConfig);
        startupLog(`initial panel rendered: ${initialPanel}`);
      });
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

  return bootApp;
}
