// @ts-nocheck
// This module preserves the existing API implementation during the structural split.
import { crHeaders, isApiDebugEnabled, getDebugSinceAppStartMs, formatDebugOffset, debugApiLog, rememberRestoreGeneration, isRestoreGenerationRejection, retryAfterRestoreGenerationRefresh, dedupeGetJson, cloneCached, json, redirectLogin, apiFetchJson, API_DEBUG_FLAG_LS_KEY, STARTUP_GET_TTL_MS, GIT_INFO_TTL_MS, startupGetCache, startupGetInFlight, startupGetEpoch, inFlightGetRequests, appLogger, getCurrentLang, readStorageValueWithAlias, applyChatAuthSessionBoundary, clearPushInboxCache, scopeTodoPayload, todoWorkspaceQuery, VIEW_CONTEXT_STATUS, hasExplicitWorkspace, viewContextRuntimeParams, getViewContextState, isViewContextScopedAccessAllowed, withViewContextQuery, sharedState, isWorkspaceWatcherRetryableBlockedTodo, applyCsrfFromAuthPayload, buildCretliApiHeaders, cretliApiFetch, getCsrfToken, getWidgetAccessToken, onCretliApiWrite, setCsrfToken, setWidgetAccessToken, buildChatIdsQuery, chunkExplicitChatIds, fitsChatIdsQuery, MAX_CHAT_REVISIONS_FETCH_PARTS, normalizeExplicitChatIds } from './runtime.js';
import { invalidateStartupGetCache, sharedStartupGet, getWorkspace, getWorkspaceContext, getSettings, getApprovalAuditSummary, getSidebarLayout, patchSidebarLayout, patchSettings, patchSettingsLanHost, getBrowserPolicy, patchBrowserPolicy, buildApprovalSettingsPatch, patchApprovalBrokerSettings, getLanUrl, logout, getAuthStatus, getTerminalSession, getTaskRuns, getTasks, deleteTaskRun, getAgentRuns, getAgents, getAgentsSchedule, patchAgentsSchedule, getChats, getChatListSync, getChatListPage, getChatSdkMessages, getChatHistory, postChatHistoryRevisionsBatch, getChatHistoryRevisions, getChatAgentStates, disposeSdkChatRoom, postChatHistory, postChatHistoryBatch, getAgentSdkStatus, getOpenCodeStatus, getOpenCodeModels, getOpenRouterStatus, getOpenRouterModels, getCodeBuddyStatus, getCodeBuddyModels, getMistralStatus, getMistralModels, getZaiStatus, getZaiModels, getMimoStatus, getMimoModels, getDeepSeekStatus, getDeepSeekModels, getQwenStatus, getQwenModels, getClaudeStatus, getClaudeModels, startClaudePlanLogin, completeClaudePlanLogin, cancelClaudePlanLogin, getClaudePlanLimits, getContextCacheSeries, getCodexPlanLimits, getCodexStatus, getCodexModels, startCodexLogin, getCodexLoginStatus, cancelCodexLogin, logoutCodex, getWorktrees, postChat, postChatFork, postChatForkWithSummary, getChatPlan, getDelegationExecutors, getHarnessCatalog, postManualChatDelegation, postChatDelegation, getChatRecoveryRuns, postRecoveryResume, postRecoveryKeepStopped, getChatDelegations, getDelegation, getDelegationRuntime, getWorkspaceDelegations, getDelegationTree, postDelegationRetryDelivery, postDelegationCancel, postChatSeen, postDelegationAck, getDelegationAcceptContext, getDelegationReportLink, postDelegationAccept, postChatMailboxReply, postChatMailboxRetry, postDelegationRetry, patchChat, getChatTitleHistory, regenerateChatTitle, setChatTitleLock, archiveChat, deleteChat, deleteChatHistory, postChatSyncTodoPlan, getChatDiag, postSdkChatProbe, postChatResetSdkContext, postGenerateChatTitle, postGenerateChatSummary, invalidateTodoListCache, getTodos, getTodo, getTodoHistory, postTodo, patchTodo, deferTodo, restoreDeferredTodo, restoreTodoToTree, recoverWorkspaceWatcherTodo, releaseDoingWorkspaceWatcherTodo, retryWorkspaceWatcherTodo, integrateTodo, smartMergeTodo, verifyIntegrationTodo, integrateTodosBatch, getIntegrateBatch, cancelIntegrateBatch, resumeIntegrateBatch, abandonIntegrateBatch, clearIntegrationLock, listWorktrees, getWorktreeDiff, getWorktreeMergePreview, startWorktreeMerge, rejectWorktree, cleanupWorktree, deleteTodo, postTodoStartAgent, getTodoStartAgentStatus, getCursorContext, getGitInfo, getGitBranches, getGitFileDiff, postGitAction, getGithubInfo, getGithubWorkflowRuns, getGithubWorkflowRunJobs, getGithubWorkflowJobLogs, getUpdateStatus, postUpdateApply, postDevAction, getServerHealth, getServerDiagnosticsSummary, listWidgetInstallations, createWidgetInstallation, updateWidgetInstallation, deleteWidgetInstallation, uploadScreenshot, requestSpeech, requestTranscription, postUsageEvent, getCreditLedger, getCreditLedgerForecast, getCreditLedgerHarnessLinks, mutateCreditLedger, getCreditSubscriptions, mutateCreditSubscriptions, getDeepSeekBalanceStatus, refreshDeepSeekBalanceReading, getUsagePlanLimits, getUsageSettings, saveUsageSettings, getUsageLimitResumeSettings, saveUsageLimitResumeSettings, getUsageLimitResumeItems, cancelUsageLimitResume, getUsageSummary, getUsageTimeseries, getUsageModels, getUsageInsights, getUsageCacheFreshness, getUsageResumeAdvice, getUsageKeepAlive, stopUsageKeepAlive, getUsageTop, getUsageLimitBurn, getUsageWorkflowBreakdown, getReviewFindings, postRejectReviewFinding, getDelegationStats, getHarnessHealth, getHarnessDiagnostics, getHarnessModelRoleConfig, previewHarnessModelRoleConfig, putHarnessModelRoleConfig, resetHarnessModelRoleConfig, getModelPickOverrides, putModelPickOverride, revokeModelPickOverride, resetModelPickOverrides, getHarnessBenchmarkSources, putHarnessBenchmarkImport, getWorkspaceModelPickOverrides, putWorkspaceModelPickOverride, revokeWorkspaceModelPickOverride, clearHarnessUsageLimit, ackUnclassifiedError, getHarnessVersions, updateHarnessPackages, installMistralSdk, installZaiSdk, refreshHarnessModelsCatalog, requestRealtimeToken, probeGeminiApiKey, requestGeminiLiveToken, appendVoiceSessionEvents, fetchVoiceSessionLog, listVoiceSessionLogs, updateHarnessBenchmarkSource, getPermissionGrants, revokePermissionGrants, getWakeups, getWakeupKinds, getWakeupStatus, saveWakeupKindSettings, cancelWakeup, runWakeupNow } from './index.js';
export async function getWorkspaces(options = {}) {
  const params = new URLSearchParams();
  if (options.refresh) params.set('refresh', '1');
  if (options.scan) params.set('scan', '1');
  if (options.sync) params.set('sync', '1');
  const query = params.toString() ? `?${params.toString()}` : '';
  if (query) {
    return apiFetchJson(`/api/workspaces${query}`, { cache: 'no-store' }, 'getWorkspaces');
  }
  return sharedStartupGet('/api/workspaces', () => dedupeGetJson('/api/workspaces', 'getWorkspaces'));
}

export async function writeWorkspaceFileFolders(workspaceFile) {
  return apiFetchJson('/api/workspace-file/folders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceFile, writeback: true }),
  }, 'writeWorkspaceFileFolders');
}

/** Convert a .code-workspace (file) workspace into a self-config Cretli workspace. */
export async function convertWorkspaceFileToSelf(workspaceFile) {
  return apiFetchJson('/api/workspace/convert', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceFile }),
  }, 'convertWorkspaceFileToSelf');
}

/** Explicit "refresh from file": add folders of the imported .code-workspace the workspace lacks. */
export async function refreshWorkspaceFromFile(workspaceId) {
  return apiFetchJson('/api/workspace/refresh-from-file', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId }),
  }, 'refreshWorkspaceFromFile');
}

/** Export a workspace's enabled folders into a .code-workspace file. */
export async function exportWorkspaceToFile(workspaceFile, targetFile = '') {
  return apiFetchJson('/api/workspace/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceFile, targetFile }),
  }, 'exportWorkspaceToFile');
}

/** Directory listing anywhere on the server disk (path pickers). */
export async function getFsEntries(pathValue = '', includeHidden = false) {
  const params = new URLSearchParams();
  if (pathValue) params.set('path', pathValue);
  if (includeHidden) params.set('includeHidden', '1');
  return apiFetchJson(`/api/fs/entries?${params.toString()}`, undefined, 'getFsEntries');
}

/** Create a folder under an absolute parent path (path pickers). */
export async function createFsFolder(parentPath, name) {
  return apiFetchJson('/api/fs/mkdir', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: parentPath, name }),
  }, 'createFsFolder');
}

export async function getStatusFlowScenariosFixture() {
  return apiFetchJson('/fixtures/status-flow-scenarios.json', { cache: 'no-store' }, 'getStatusFlowScenariosFixture');
}

/** Directory listing for the file tree. dir is a relative path; empty means the workspace root. */
export async function getFilesEntries(dir = '', includeHidden = false) {
  const params = new URLSearchParams();
  if (dir) params.set('dir', dir);
  if (includeHidden) params.set('includeHidden', '1');
  const q = params.toString() ? `?${params.toString()}` : '';
  return apiFetchJson(`/api/files/entries${q}`, undefined, 'getFilesEntries');
}

/** File contents as text; path is relative to the workspace root. */
export async function getFileContent(filePath) {
  return cretliApiFetch(`/api/files/read?path=${encodeURIComponent(filePath)}`, {}, { acceptLanguage: getCurrentLang() }).then(json);
}

/**
 * How long a lean todo list is reused. The server pushes `todosChanged` only for
 * review and takeover changes; MCP writes, watcher claims and chat links emit
 * nothing, so the window stays short. Local API writes, those frames and the
 * Refresh button invalidate it sooner.
 */
// TypeScript checks the legacy API contract separately; this split preserves its runtime implementation.
// @ts-nocheck
