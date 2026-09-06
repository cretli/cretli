/**
 * HTTP route registration for the Cretli Express app.
 */

import { registerClientInstancesRoutes } from './routes/client-instances-routes.js';
import { registerHealthRoutes } from './routes/health-routes.js';
import { registerPushRoutes } from './routes/push-routes.js';
import { registerWidgetInstallationsRoutes } from './routes/widget-installations-routes.js';
import { registerAuthRoutes } from './routes/auth-routes.js';
import { registerLanRoutes } from './routes/lan-routes.js';
import { registerSettingsRoutes, registerWorkspaceRoutes } from './routes/settings-routes.js';
import { registerChatsRoutes } from './routes/chats-routes.js';
import { registerDelegationsRoutes } from './routes/delegations-routes.js';
import { registerFilesRoutes } from './routes/files-routes.js';
import { registerFsBrowseRoutes } from './routes/fs-browse-routes.js';
import { registerGitRoutes } from './routes/git-routes.js';
import { registerTodosRoutes } from './routes/todos-routes.js';
import { registerChatAgentRoutes } from './routes/chat-agent-routes.js';
import { registerUploadsRoutes } from './routes/uploads-routes.js';
import { registerVoiceRoutes } from './routes/voice-routes.js';
import { registerUsageRoutes } from './routes/usage-routes.js';
import { registerCursorContextRoutes } from './routes/cursor-context-routes.js';
import { registerAgentSdkRoutes } from './routes/agent-sdk-routes.js';
import { registerOpenRouterRoutes } from './routes/openrouter-routes.js';
import { registerOpenCodeRoutes } from './routes/opencode-routes.js';
import { registerCodeBuddyRoutes } from './routes/codebuddy-routes.js';
import { registerDeepSeekRoutes } from './routes/deepseek-routes.js';
import { registerCodexRoutes } from './routes/codex-routes.js';
import { registerQwenRoutes } from './routes/qwen-routes.js';
import { registerTasksAgentsRoutes } from './routes/tasks-agents-routes.js';
import { registerTerminalRoutes } from './routes/terminal-routes.js';
import { registerClientDebugRoutes } from './routes/client-debug-routes.js';
import { registerDevActionsRoutes, scheduleServerRestart } from './routes/dev-actions-routes.js';
import { registerUpdateRoutes } from './routes/update-routes.js';
import { registerMcpRoutes } from './routes/mcp-routes.js';
import { registerHarnessCatalogRoutes } from './routes/harness-catalog-routes.js';
import { setBuiltinMcpRuntimeDeps } from './mcp/builtin/runtime-deps.js';
import {
  buildWidgetAuthorizationPayload,
  isWidgetAuthRequest,
  parseWidgetAuthParams,
} from './widget/widget-auth-page.js';
import { getLanHost } from './lan-host.js';

/**
 * @param {import('express').Express} app
 * @param {Record<string, unknown>} ctx
 */
export function registerAppRoutes(app, ctx) {
  setBuiltinMcpRuntimeDeps({
    dataDir: ctx.dataDir,
    taskRuns: ctx.taskRuns || new Map(),
    agentRuns: ctx.agentRuns || new Map(),
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
  registerHealthRoutes(app, {
    serverInstanceToken: ctx.serverInstanceToken,
    serverStartedAt: ctx.serverStartedAt,
    getFrontAssetVersion: ctx.getFrontAssetVersion,
  });
  registerPushRoutes(app);
  registerWidgetInstallationsRoutes(app);
  registerAuthRoutes(app, {
    useHttps: ctx.useHttps,
    buildWidgetAuthorizationPayload,
    isWidgetAuthRequest,
    parseWidgetAuthParams,
  });
  registerLanRoutes(app, { port: ctx.port, useHttps: ctx.useHttps, getLanHost });
  registerSettingsRoutes(app, {
    port: ctx.port,
    useHttps: ctx.useHttps,
    serverInstanceToken: ctx.serverInstanceToken,
    frontHmrEnabled: ctx.frontHmrEnabled,
    frontHmrForcedByEnv: ctx.frontHmrForcedByEnv,
    frontHotFallbackEnabled: ctx.frontHotFallbackEnabled,
    getLanHost,
    getConfiguredWorkspaceSelection: ctx.getConfiguredWorkspaceSelection,
    isSessionSyncEnabled: ctx.isSessionSyncEnabled,
    resolveFrontHmrEnabledFromSettings: ctx.resolveFrontHmrEnabledFromSettings,
  });
  registerWorkspaceRoutes(app, {
    projectRoot: ctx.projectRoot,
    getCurrentWorkspace: ctx.getCurrentWorkspace,
    getCurrentWorkspaceFile: ctx.getCurrentWorkspaceFile,
  });
  registerChatsRoutes(app, {
    dataDir: ctx.dataDir,
    agentSessions: ctx.agentSessions,
    getCurrentAgentRunResumeId: ctx.getCurrentAgentRunResumeId,
    setCurrentAgentRunResumeId: ctx.setCurrentAgentRunResumeId,
    agentCmd: ctx.agentCmd,
    agentModel: ctx.agentModel,
    workspaceDirForAgent: ctx.workspaceDirForAgent,
    getCurrentWorkspaceFile: ctx.getCurrentWorkspaceFile,
    getCurrentCwd: ctx.getCurrentCwd,
    buildAgentSpawnEnv: ctx.buildAgentSpawnEnv,
    widgetChatListScope: ctx.widgetChatListScope,
  });
  registerDelegationsRoutes(app, {
    workspaceDirForAgent: ctx.workspaceDirForAgent,
    dataDir: ctx.dataDir,
  });
  const filesGitTodosCtx = { getCurrentCwd: ctx.getCurrentCwd };
  registerFilesRoutes(app, filesGitTodosCtx);
  registerFsBrowseRoutes(app);
  registerGitRoutes(app, filesGitTodosCtx);
  registerTodosRoutes(app, {
    dataDir: ctx.dataDir,
    getCurrentCwd: ctx.getCurrentCwd,
    getCurrentWorkspaceFile: ctx.getCurrentWorkspaceFile,
    agentModel: ctx.agentModel,
    getLocalCallbackBaseUrl: ctx.getLocalCallbackBaseUrl,
    useHttps: ctx.useHttps,
  });
  registerTasksAgentsRoutes(app, {
    loadCurrentTasks: ctx.loadCurrentTasks,
    loadTasksForWorkspace: ctx.loadTasksForWorkspace,
    taskRuns: ctx.taskRuns,
    agentRuns: ctx.agentRuns,
    devBuildRunId: ctx.devBuildRunId,
    buildTaskRunScopeSnapshot: ctx.buildTaskRunScopeSnapshot,
    isTaskRunInScope: ctx.isTaskRunInScope,
    randomSessionId: ctx.randomSessionId,
    loadAgentsSchedule: ctx.loadAgentsSchedule,
    saveAgentsSchedule: ctx.saveAgentsSchedule,
    getCurrentCwd: ctx.getCurrentCwd,
  });
  registerCursorContextRoutes(app, { getCurrentCwd: ctx.getCurrentCwd });
  registerAgentSdkRoutes(app);
  registerOpenRouterRoutes(app);
  registerOpenCodeRoutes(app, { workspaceDirForAgent: ctx.workspaceDirForAgent });
  registerCodeBuddyRoutes(app);
  registerDeepSeekRoutes(app);
  registerCodexRoutes(app);
  registerQwenRoutes(app);
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
  registerUsageRoutes(app);
  registerHarnessCatalogRoutes(app);
  registerMcpRoutes(app);
  registerTerminalRoutes(app, {
    isSessionSyncEnabled: ctx.isSessionSyncEnabled,
    terminalSessions: ctx.terminalSessions,
    getLastTerminalSessionId: ctx.getLastTerminalSessionId,
    setLastTerminalSessionId: ctx.setLastTerminalSessionId,
  });
}

/**
 * @param {import('express').Express} app
 * @param {Record<string, unknown>} ctx
 */
export function registerDevAndUpdateRoutes(app, ctx) {
  const devActionsCtx = {
    taskRuns: ctx.taskRuns,
    devBuildRunId: ctx.devBuildRunId,
    serverInstanceToken: ctx.serverInstanceToken,
    projectRoot: ctx.projectRoot,
    frontHmrForcedByEnv: ctx.frontHmrForcedByEnv,
    frontHmrEnabled: ctx.frontHmrEnabled,
    resolveFrontHmrEnabledFromSettings: ctx.resolveFrontHmrEnabledFromSettings,
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
