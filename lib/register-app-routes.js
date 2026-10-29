/**
 * HTTP route registration for the Cretli Express app.
 */

import { registerClientInstancesRoutes } from './routes/client-instances-routes.js';
import { registerHealthRoutes } from './routes/health-routes.js';
import { listLargeDataFiles } from './data-dir-size-warning.js';
import { readMemoryMonitorAlerts, mcpResourceObserver } from './memory-monitor.js';
import { readOomMarkers } from './oom-diagnostics.js';
import { getServerCodeFreshnessDetail, isServerCodeStale } from './server-code-freshness-worker.js';
import { registerPushRoutes } from './routes/push-routes.js';
import { registerWidgetInstallationsRoutes } from './routes/widget-installations-routes.js';
import { registerAuthRoutes } from './routes/auth-routes.js';
import { registerNetEnvRoutes } from './routes/net-env-routes.js';
import { registerLanRoutes } from './routes/lan-routes.js';
import { registerSettingsRoutes, registerWorkspaceRoutes } from './routes/settings-routes.js';
import { registerSidebarLayoutRoutes } from './routes/sidebar-layout-routes.js';
import { registerChatsRoutes } from './routes/chats-routes.js';
import { registerChatMediaRoutes } from './routes/chat-media-routes.js';
import { registerDelegationsRoutes } from './routes/delegations-routes.js';
import { registerPromptRegistryRoutes } from './routes/prompt-registry-routes.js';
import { registerReviewLessonsRoutes } from './routes/review-lessons-routes.js';
import { registerDelegationTestRoutes } from './routes/delegation-test-routes.js';
import { registerRecoveryResumeRoutes, registerRecoveryUiRoutes } from './routes/recovery-resume-routes.js';
import { registerFilesRoutes } from './routes/files-routes.js';
import { registerFsBrowseRoutes } from './routes/fs-browse-routes.js';
import { registerGitRoutes } from './routes/git-routes.js';
import { registerTodosRoutes } from './routes/todos-routes.js';
import { registerIntegrateBatchRoutes } from './routes/integrate-batch-routes.js';
import { registerPlanReviewerCooperationRoutes } from './routes/plan-reviewer-cooperation-routes.js';
import { registerWorktreesRoutes } from './routes/worktrees-routes.js';
import { registerWorkspaceWatcherRoutes } from './routes/watcher-routes.js';
import { registerChatAgentRoutes } from './routes/chat-agent-routes.js';
import { registerUploadsRoutes } from './routes/uploads-routes.js';
import { registerVoiceRoutes } from './routes/voice-routes.js';
import { registerUsageRoutes } from './routes/usage-routes.js';
import { registerUsageLimitResumeRoutes } from './routes/usage-limit-resume-routes.js';
import { registerWakeupsRoutes } from './routes/wakeups-routes.js';
import { getPeriodicJobRunner, getWakeupScheduler } from './delegation-runtime-boot.js';
import { createConditionCheckService } from './wakeup-condition-check-service.js';
import { registerCursorContextRoutes } from './routes/cursor-context-routes.js';
import { registerChatContextRoutes } from './routes/chat-context-routes.js';
import { registerContextSettingsRoutes } from './routes/context-settings-routes.js';
import { registerAgentSdkRoutes } from './routes/agent-sdk-routes.js';
import { registerBuiltinHarnessRoutes } from './agent-harness/builtin-harness-providers.ts';
import { registerTasksAgentsRoutes } from './routes/tasks-agents-routes.js';
import { registerTerminalRoutes } from './routes/terminal-routes.js';
import { registerClientDebugRoutes } from './routes/client-debug-routes.js';
import { registerDevActionsRoutes, scheduleServerRestart } from './routes/dev-actions-routes.js';
import { registerUpdateRoutes } from './routes/update-routes.js';
import { registerMcpRoutes } from './routes/mcp-routes.js';
import { registerSettingsBackupRoutes } from './routes/settings-backup-routes.js';
import { registerConversationsBackupRoutes } from './routes/conversations-backup-routes.js';
import { registerOnlineBackupRoutes } from './routes/online-backup-routes.js';
import { registerExternalMcpRoutes } from './routes/mcp-external-routes.js';
import { registerCreditLedgerRoutes } from './routes/credit-ledger-routes.js';
import { registerHarnessCatalogRoutes } from './routes/harness-catalog-routes.js';
import { registerHarnessDiagnosticsRoutes } from './routes/harness-diagnostics-routes.js';
import { registerHarnessModelRoleConfigRoutes } from './routes/harness-model-role-config-routes.js';
import { registerHarnessVersionsRoutes } from './routes/harness-versions-routes.js';
import { registerHarnessModelsRefreshRoutes } from './routes/harness-models-refresh-routes.js';
import { registerNotificationRoutes } from './routes/notification-routes.js';
import path from 'node:path';
import { getTodoById } from './persist/todos-persist.js';
import { setBuiltinMcpRuntimeDeps } from './mcp/builtin/runtime-deps.js';
import { registerBrowserRoutes } from './browser/routes.js';
import { getSessionIdFromRequest } from './auth.js';
import {
  buildWidgetAuthorizationPayload,
  isWidgetAuthRequest,
  parseWidgetAuthParams,
} from './widget/widget-auth-page.ts';
import { getLanHost } from './lan-host.js';
import { setActiveRunCountProvider, setRestartScheduledProvider } from './update-gate.js';
import { countActiveDelegationRuns } from './delegation-service.js';
import { countActiveChatRuns, getChatRunStateForChat, probeChatRunLiveness } from './chat-run-service.js';
import { countActiveTaskRuns } from './dev-build.js';
import { getWorkspaceWatcher } from './persist/workspace-watchers-persist.js';

/**
 * Shared server context handed to every route registrar. It is the intersection of
 * the context each registrar declares, so a member keeps the exact type its
 * consumer expects.
 *
 * @typedef {Parameters<typeof registerClientDebugRoutes>[1]
 *   & Parameters<typeof registerClientInstancesRoutes>[1]
 *   & Parameters<typeof registerHealthRoutes>[1]
 *   & Parameters<typeof registerAuthRoutes>[1]
 *   & Parameters<typeof registerLanRoutes>[1]
 *   & Parameters<typeof registerSettingsRoutes>[1]
 *   & Parameters<typeof registerWorkspaceRoutes>[1]
 *   & Parameters<typeof registerChatsRoutes>[1]
 *   & Parameters<typeof registerDelegationsRoutes>[1]
 *   & Parameters<typeof registerReviewLessonsRoutes>[1]
 *   & Parameters<typeof registerFilesRoutes>[1]
 *   & Parameters<typeof registerGitRoutes>[1]
 *   & Parameters<typeof registerIntegrateBatchRoutes>[1]
 *   & Parameters<typeof registerTodosRoutes>[1]
 *   & Parameters<typeof registerPlanReviewerCooperationRoutes>[1]
 *   & Parameters<typeof registerWorktreesRoutes>[1]
 *   & Parameters<typeof registerWorkspaceWatcherRoutes>[1]
 *   & Parameters<typeof registerTasksAgentsRoutes>[1]
 *   & Parameters<typeof registerCursorContextRoutes>[1]
 *   & Parameters<typeof registerChatContextRoutes>[1]
 *   & Parameters<typeof registerContextSettingsRoutes>[1]
 *   & Parameters<typeof registerChatAgentRoutes>[1]
 *   & Parameters<typeof registerUploadsRoutes>[1]
 *   & Parameters<typeof registerVoiceRoutes>[1]
 *   & Parameters<typeof registerUsageLimitResumeRoutes>[1]
 *   & Parameters<typeof registerWakeupsRoutes>[1]
 *   & Parameters<typeof registerHarnessDiagnosticsRoutes>[1]
 *   & Parameters<typeof registerHarnessModelRoleConfigRoutes>[1]
 *   & Parameters<typeof registerHarnessVersionsRoutes>[1]
 *   & Parameters<typeof registerCreditLedgerRoutes>[1]
 *   & Parameters<typeof registerTerminalRoutes>[1]
 *   & Parameters<typeof registerBrowserRoutes>[1]
 *   & Parameters<typeof registerDevActionsRoutes>[1]
 *   & Parameters<typeof registerUpdateRoutes>[1]
 * } AppRoutesContext
 */

/**
 * @param {import('express').Express} app
 * @param {AppRoutesContext} ctx
 */
export function registerAppRoutes(app, ctx) {
  setBuiltinMcpRuntimeDeps({
    dataDir: ctx.dataDir,
    taskRuns: ctx.taskRuns || new Map(),
    loadTasksForWorkspace: typeof ctx.loadTasksForWorkspace === 'function'
      ? ctx.loadTasksForWorkspace
      : () => null,
    workspaceDirForAgent: typeof ctx.workspaceDirForAgent === 'function'
      ? ctx.workspaceDirForAgent
      : () => '',
  });
  registerClientDebugRoutes(app, {
    dataDir: ctx.dataDir,
    appendClientDebugLogFile: ctx.appendClientDebugLogFile,
  });
  registerClientInstancesRoutes(app, { dataDir: ctx.dataDir });
  registerHealthRoutes(app, /** @type {Parameters<typeof registerHealthRoutes>[1]} */ ({
    serverInstanceToken: ctx.serverInstanceToken,
    serverStartedAt: ctx.serverStartedAt,
    serverDiagnostics: ctx.serverDiagnostics,
    restoreGate: ctx.restoreGate,
    getFrontAssetVersion: ctx.getFrontAssetVersion,
    getInstanceStats: ctx.getInstanceStats,
    readMonitorAlerts: (limit) => readMemoryMonitorAlerts({ dataDir: ctx.dataDir, limit }),
    listLargeDataFiles: () => listLargeDataFiles(ctx.dataDir),
    readOomMarkers: (limit) => readOomMarkers(ctx.dataDir, limit),
    // Backend code freshness: the bare flag goes to the pre-auth /api/health, the
    // changed-file count only to the authorized diagnostics endpoint.
    isServerCodeStale: () => isServerCodeStale(),
    readServerCodeFreshness: () => getServerCodeFreshnessDetail(),
    hasMcpResourceAlarm: () => mcpResourceObserver.hasAlarm(),
    readMcpResources: () => mcpResourceObserver.getReport(),
  }));
  registerPushRoutes(app);
  registerWidgetInstallationsRoutes(app);
  registerAuthRoutes(app, {
    useHttps: ctx.useHttps,
    buildWidgetAuthorizationPayload,
    isWidgetAuthRequest,
    parseWidgetAuthParams,
  });
  registerNetEnvRoutes(app);
  registerLanRoutes(app, { port: ctx.port, useHttps: ctx.useHttps, getLanHost });
  registerSidebarLayoutRoutes(app);
  registerSettingsRoutes(app, /** @type {Parameters<typeof registerSettingsRoutes>[1]} */ ({
    port: ctx.port,
    useHttps: ctx.useHttps,
    serverInstanceToken: ctx.serverInstanceToken,
    frontHotFallbackEnabled: ctx.frontHotFallbackEnabled,
    getLanHost,
    getConfiguredWorkspaceSelection: ctx.getConfiguredWorkspaceSelection,
    isSessionSyncEnabled: ctx.isSessionSyncEnabled,
    restoreGate: ctx.restoreGate,
  }));
  registerWorkspaceRoutes(app, {
    projectRoot: ctx.projectRoot,
    getCurrentWorkspace: ctx.getCurrentWorkspace,
    getCurrentWorkspaceFile: ctx.getCurrentWorkspaceFile,
  });
  registerChatsRoutes(app, {
    dataDir: ctx.dataDir,
    agentSessions: ctx.agentSessions,
    agentCmd: ctx.agentCmd,
    agentModel: ctx.agentModel,
    workspaceDirForAgent: ctx.workspaceDirForAgent,
    getCurrentWorkspaceFile: ctx.getCurrentWorkspaceFile,
    getCurrentCwd: ctx.getCurrentCwd,
    buildAgentSpawnEnv: ctx.buildAgentSpawnEnv,
    widgetChatListScope: ctx.widgetChatListScope,
  });
  registerChatMediaRoutes(app);
  registerDelegationsRoutes(app, {
    workspaceDirForAgent: ctx.workspaceDirForAgent,
    dataDir: ctx.dataDir,
  });
  registerReviewLessonsRoutes(app, { dataDir: ctx.dataDir, getCurrentWorkspace: ctx.getCurrentWorkspace });
  registerPromptRegistryRoutes(app, { dataDir: ctx.dataDir });
  registerDelegationTestRoutes(app);
  registerRecoveryResumeRoutes(app);
  registerRecoveryUiRoutes(app);
  const filesGitTodosCtx = { getCurrentCwd: ctx.getCurrentCwd };
  registerFilesRoutes(app, filesGitTodosCtx);
  registerFsBrowseRoutes(app);
  // The Git routes resolve chat/TODO worktree scope from durable records, so
  // they need the data dir in addition to the legacy cwd fallback.
  registerGitRoutes(app, { getCurrentCwd: ctx.getCurrentCwd, dataDir: ctx.dataDir });
  // Registered before the `/api/todos/:id/*` family so `integrate-batch` is
  // never captured as a todo id.
  registerIntegrateBatchRoutes(app, {
    dataDir: ctx.dataDir,
    getCurrentCwd: ctx.getCurrentCwd,
    getCurrentWorkspaceFile: ctx.getCurrentWorkspaceFile,
    agentModel: ctx.agentModel,
    getLocalCallbackBaseUrl: ctx.getLocalCallbackBaseUrl,
    useHttps: ctx.useHttps,
    worktreeDeps: ctx.worktreeDeps,
    verifyAgentCallback: ctx.verifyAgentCallback,
    probeChatRunLiveness: ctx.probeChatRunLiveness || probeChatRunLiveness,
  });
  registerTodosRoutes(app, {
    dataDir: ctx.dataDir,
    getCurrentCwd: ctx.getCurrentCwd,
    getCurrentWorkspaceFile: ctx.getCurrentWorkspaceFile,
    agentModel: ctx.agentModel,
    getLocalCallbackBaseUrl: ctx.getLocalCallbackBaseUrl,
    useHttps: ctx.useHttps,
    // Manual starts resolve the tree ROOT's execution mode against the watcher
    // policy (non-creating read) and freeze the root worktree on the chat.
    loadWatcherPolicy: (workspaceFolder) => getWorkspaceWatcher(workspaceFolder, { dataDir: ctx.dataDir }),
    worktreeDeps: ctx.worktreeDeps,
    probeChatRunLiveness: ctx.probeChatRunLiveness || probeChatRunLiveness,
  });
  registerPlanReviewerCooperationRoutes(app, { dataDir: ctx.dataDir });
  registerWorktreesRoutes(app, {
    dataDir: ctx.dataDir,
    getCurrentCwd: ctx.getCurrentCwd,
    getCurrentWorkspaceFile: ctx.getCurrentWorkspaceFile,
    agentModel: ctx.agentModel,
    getLocalCallbackBaseUrl: ctx.getLocalCallbackBaseUrl,
    useHttps: ctx.useHttps,
    worktreeDeps: ctx.worktreeDeps,
    probeChatRunLiveness: ctx.probeChatRunLiveness || probeChatRunLiveness,
  });
  registerWorkspaceWatcherRoutes(app, {
    dataDir: ctx.dataDir,
    getCurrentCwd: ctx.getCurrentCwd,
    // Workspace-scoped audited overrides share the global store file.
    modelOverridesFile: ctx.modelOverridesFile,
  });
  registerTasksAgentsRoutes(app, {
    loadCurrentTasks: ctx.loadCurrentTasks,
    loadTasksForWorkspace: ctx.loadTasksForWorkspace,
    taskRuns: ctx.taskRuns,
    devBuildRunId: ctx.devBuildRunId,
    buildTaskRunScopeSnapshot: ctx.buildTaskRunScopeSnapshot,
    isTaskRunInScope: ctx.isTaskRunInScope,
    randomSessionId: ctx.randomSessionId,
    getCurrentCwd: ctx.getCurrentCwd,
  });
  registerCursorContextRoutes(app, { getCurrentCwd: ctx.getCurrentCwd });
  registerChatContextRoutes(app, { getCurrentCwd: /** @type {() => string} */ (ctx.getCurrentCwd) });
  registerContextSettingsRoutes(app, { getCurrentCwd: /** @type {() => string} */ (ctx.getCurrentCwd) });
  registerAgentSdkRoutes(app);
  registerBuiltinHarnessRoutes(app, { workspaceDirForAgent: ctx.workspaceDirForAgent });
  registerChatAgentRoutes(app, {
    dataDir: ctx.dataDir,
    agentCmd: ctx.agentCmd,
    agentModel: ctx.agentModel,
    workspaceDirForAgent: ctx.workspaceDirForAgent,
    getCurrentWorkspaceFile: ctx.getCurrentWorkspaceFile,
    getCurrentCwd: ctx.getCurrentCwd,
    getLocalCallbackBaseUrl: ctx.getLocalCallbackBaseUrl,
    useHttps: ctx.useHttps,
    verifyAgentCallback: ctx.verifyAgentCallback,
  });
  registerUploadsRoutes(app, { uploadsDir: ctx.uploadsDir });
  registerVoiceRoutes(app, { dataDir: ctx.dataDir });
  registerUsageRoutes(app, { getChatRunState: (chat) => getChatRunStateForChat(chat) });
  registerUsageLimitResumeRoutes(app, { dataDir: ctx.dataDir });
  const conditionCheck = createConditionCheckService({
    dataDir: ctx.dataDir,
    getScheduler: getWakeupScheduler,
    getTodo: (workspaceFolder, todoId) => getTodoById(ctx.dataDir, path.resolve(workspaceFolder), todoId),
  });
  // The MCP check_* tools reach the same service through the builtin runtime deps.
  setBuiltinMcpRuntimeDeps({ conditionCheck });
  registerWakeupsRoutes(app, {
    dataDir: ctx.dataDir,
    getScheduler: getWakeupScheduler,
    getPeriodicJobRunner,
    conditionCheck,
    getCurrentCwd: ctx.getCurrentCwd,
  });
  registerHarnessCatalogRoutes(app);
  registerHarnessDiagnosticsRoutes(app, { dataDir: ctx.dataDir });
  registerHarnessModelRoleConfigRoutes(app, /** @type {Parameters<typeof registerHarnessModelRoleConfigRoutes>[1]} */ ({
    dataDir: ctx.dataDir,
    roleProfilesFile: ctx.roleProfilesFile,
    // Read-only explore ledger + the global audited override store.
    exploreFile: ctx.exploreFile,
    modelOverridesFile: ctx.modelOverridesFile,
  }));
  registerHarnessVersionsRoutes(app, { projectRoot: ctx.projectRoot });
  registerHarnessModelsRefreshRoutes(app);
  registerNotificationRoutes(app);
  registerMcpRoutes(app);
  registerSettingsBackupRoutes(app);
  registerConversationsBackupRoutes(app);
  registerOnlineBackupRoutes(app);
  registerExternalMcpRoutes(app);
  registerCreditLedgerRoutes(app, { uploadsDir: /** @type {string} */ (ctx.uploadsDir) });
  registerTerminalRoutes(app, {
    isSessionSyncEnabled: ctx.isSessionSyncEnabled,
    terminalSessions: ctx.terminalSessions,
    getLastTerminalSessionId: ctx.getLastTerminalSessionId,
    setLastTerminalSessionId: ctx.setLastTerminalSessionId,
  });
  if (ctx.browserManager) {
    registerBrowserRoutes(app, {
      browserManager: ctx.browserManager,
      navigationConsent: ctx.navigationConsent,
      dataDir: ctx.dataDir,
      getCurrentCwd: ctx.getCurrentCwd,
      getCurrentWorkspaceFile: ctx.getCurrentWorkspaceFile,
      getOwnerSessionId: (req) => getSessionIdFromRequest(req),
    });
  }
}

/**
 * @param {import('express').Express} app
 * @param {AppRoutesContext} ctx
 */
export function registerDevAndUpdateRoutes(app, ctx) {
  // Shared update gate wiring: the self-updater and the dev restart action
  // must agree on the live run count and the pending-restart flag.
  setActiveRunCountProvider(() => (
    countActiveDelegationRuns()
    + countActiveChatRuns()
    + countActiveTaskRuns(ctx.taskRuns, ctx.devBuildRunId)
  ));
  setRestartScheduledProvider(() => Boolean(
    typeof ctx.getServerRestartScheduled === 'function' && ctx.getServerRestartScheduled(),
  ));
  const devActionsCtx = {
    taskRuns: ctx.taskRuns,
    devBuildRunId: ctx.devBuildRunId,
    serverInstanceToken: ctx.serverInstanceToken,
    projectRoot: ctx.projectRoot,
    getServerRestartScheduled: ctx.getServerRestartScheduled,
    setServerRestartScheduled: ctx.setServerRestartScheduled,
    devBuildRunContext: ctx.devBuildRunContext,
  };
  registerDevActionsRoutes(app, devActionsCtx);
  registerUpdateRoutes(app, {
    projectRoot: ctx.projectRoot,
    getServerRestartScheduled: ctx.getServerRestartScheduled,
    setServerRestartScheduled: ctx.setServerRestartScheduled,
    scheduleServerRestart: (restartRequestId) => scheduleServerRestart(devActionsCtx, restartRequestId),
  });
}
