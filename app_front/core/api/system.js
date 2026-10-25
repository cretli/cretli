// @ts-nocheck
// This module preserves the existing API implementation during the structural split.
import { crHeaders, isApiDebugEnabled, getDebugSinceAppStartMs, formatDebugOffset, debugApiLog, rememberRestoreGeneration, isRestoreGenerationRejection, retryAfterRestoreGenerationRefresh, dedupeGetJson, cloneCached, json, redirectLogin, apiFetchJson, API_DEBUG_FLAG_LS_KEY, STARTUP_GET_TTL_MS, GIT_INFO_TTL_MS, startupGetCache, startupGetInFlight, startupGetEpoch, inFlightGetRequests, appLogger, getCurrentLang, readStorageValueWithAlias, applyChatAuthSessionBoundary, clearPushInboxCache, scopeTodoPayload, todoWorkspaceQuery, VIEW_CONTEXT_STATUS, hasExplicitWorkspace, viewContextRuntimeParams, getViewContextState, isViewContextScopedAccessAllowed, withViewContextQuery, sharedState, isWorkspaceWatcherRetryableBlockedTodo, applyCsrfFromAuthPayload, buildCretliApiHeaders, cretliApiFetch, getCsrfToken, getWidgetAccessToken, onCretliApiWrite, setCsrfToken, setWidgetAccessToken, buildChatIdsQuery, chunkExplicitChatIds, fitsChatIdsQuery, MAX_CHAT_REVISIONS_FETCH_PARTS, normalizeExplicitChatIds } from './runtime.js';
import { invalidateStartupGetCache, sharedStartupGet, getWorkspace, getWorkspaceContext, getSettings, getApprovalAuditSummary, getSidebarLayout, patchSidebarLayout, patchSettings, patchSettingsLanHost, getBrowserPolicy, patchBrowserPolicy, buildApprovalSettingsPatch, patchApprovalBrokerSettings, getLanUrl, logout, getAuthStatus, getTerminalSession, getTaskRuns, getTasks, deleteTaskRun, getAgentRuns, getAgents, getAgentsSchedule, patchAgentsSchedule, getChats, getChatListSync, getChatListPage, getChatSdkMessages, getChatHistory, postChatHistoryRevisionsBatch, getChatHistoryRevisions, getChatAgentStates, disposeSdkChatRoom, postChatHistory, postChatHistoryBatch, getAgentSdkStatus, getOpenCodeStatus, getOpenCodeModels, getOpenRouterStatus, getOpenRouterModels, getCodeBuddyStatus, getCodeBuddyModels, getMistralStatus, getMistralModels, getZaiStatus, getZaiModels, getMimoStatus, getMimoModels, getDeepSeekStatus, getDeepSeekModels, getQwenStatus, getQwenModels, getClaudeStatus, getClaudeModels, startClaudePlanLogin, completeClaudePlanLogin, cancelClaudePlanLogin, getClaudePlanLimits, getContextCacheSeries, getCodexPlanLimits, getCodexStatus, getCodexModels, startCodexLogin, getCodexLoginStatus, cancelCodexLogin, logoutCodex, getWorktrees, postChat, postChatFork, postChatForkWithSummary, getChatPlan, getDelegationExecutors, getHarnessCatalog, postManualChatDelegation, postChatDelegation, getChatRecoveryRuns, postRecoveryResume, postRecoveryKeepStopped, getChatDelegations, getDelegation, getDelegationRuntime, getWorkspaceDelegations, getDelegationTree, postDelegationRetryDelivery, postDelegationCancel, postChatSeen, postDelegationAck, getDelegationAcceptContext, getDelegationReportLink, postDelegationAccept, postChatMailboxReply, postChatMailboxRetry, postDelegationRetry, patchChat, getChatTitleHistory, regenerateChatTitle, setChatTitleLock, archiveChat, deleteChat, deleteChatHistory, postChatSyncTodoPlan, getChatDiag, postSdkChatProbe, postChatResetSdkContext, postGenerateChatTitle, postGenerateChatSummary, getWorkspaces, writeWorkspaceFileFolders, convertWorkspaceFileToSelf, exportWorkspaceToFile, getFsEntries, createFsFolder, getStatusFlowScenariosFixture, getFilesEntries, getFileContent, invalidateTodoListCache, getTodos, getTodo, getTodoHistory, postTodo, patchTodo, deferTodo, restoreDeferredTodo, restoreTodoToTree, recoverWorkspaceWatcherTodo, releaseDoingWorkspaceWatcherTodo, retryWorkspaceWatcherTodo, integrateTodo, smartMergeTodo, verifyIntegrationTodo, integrateTodosBatch, getIntegrateBatch, cancelIntegrateBatch, resumeIntegrateBatch, abandonIntegrateBatch, clearIntegrationLock, listWorktrees, getWorktreeDiff, getWorktreeMergePreview, startWorktreeMerge, rejectWorktree, cleanupWorktree, deleteTodo, postTodoStartAgent, getTodoStartAgentStatus, getCursorContext, getGitInfo, getGitBranches, getGitFileDiff, postGitAction, getGithubInfo, getGithubWorkflowRuns, getGithubWorkflowRunJobs, getGithubWorkflowJobLogs, uploadScreenshot, requestSpeech, requestTranscription, postUsageEvent, getCreditLedger, getCreditLedgerForecast, getCreditLedgerHarnessLinks, mutateCreditLedger, getCreditSubscriptions, mutateCreditSubscriptions, getDeepSeekBalanceStatus, refreshDeepSeekBalanceReading, getUsagePlanLimits, getUsageSettings, saveUsageSettings, getUsageLimitResumeSettings, saveUsageLimitResumeSettings, getUsageLimitResumeItems, cancelUsageLimitResume, getUsageSummary, getUsageTimeseries, getUsageModels, getUsageInsights, getUsageCacheFreshness, getUsageResumeAdvice, getUsageKeepAlive, stopUsageKeepAlive, getUsageTop, getUsageLimitBurn, getUsageWorkflowBreakdown, getReviewFindings, postRejectReviewFinding, getDelegationStats, getHarnessHealth, getHarnessDiagnostics, getHarnessModelRoleConfig, previewHarnessModelRoleConfig, putHarnessModelRoleConfig, resetHarnessModelRoleConfig, getModelPickOverrides, putModelPickOverride, revokeModelPickOverride, resetModelPickOverrides, getHarnessBenchmarkSources, putHarnessBenchmarkImport, getWorkspaceModelPickOverrides, putWorkspaceModelPickOverride, revokeWorkspaceModelPickOverride, clearHarnessUsageLimit, ackUnclassifiedError, getHarnessVersions, updateHarnessPackages, installMistralSdk, installZaiSdk, refreshHarnessModelsCatalog, requestRealtimeToken, probeGeminiApiKey, requestGeminiLiveToken, appendVoiceSessionEvents, fetchVoiceSessionLog, listVoiceSessionLogs, updateHarnessBenchmarkSource, getPermissionGrants, revokePermissionGrants, getWakeups, getWakeupKinds, getWakeupStatus, saveWakeupKindSettings, cancelWakeup, runWakeupNow } from './index.js';
export async function getUpdateStatus({ check = false } = {}) {
  const query = check ? '?check=1' : '';
  return apiFetchJson(`/api/update/status${query}`, undefined, 'getUpdateStatus', {
    timeoutMs: check ? 70000 : 15000,
  });
}

export async function postUpdateApply() {
  return apiFetchJson('/api/update/apply', { method: 'POST' }, 'postUpdateApply');
}

export async function postDevAction(action = 'restart-server', { force = false } = {}) {
  return apiFetchJson('/api/dev-actions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, force: force === true }),
  }, 'postDevAction');
}

export async function getServerHealth() {
  // Restart polling needs live answers, so only concurrent calls share a request (ttl 0).
  return sharedStartupGet('/api/health', () => cretliApiFetch('/api/health', { cache: 'no-store' }, { acceptLanguage: getCurrentLang() }).then(json), 0);
}

/**
 * Authorized server diagnostics (`/api/diagnostics/server`). `codeFreshness`
 * carries the backend-code freshness state and the number of changed files —
 * never paths — so it stays behind the login while `/api/health` only exposes the
 * bare flag. `limit=1` because the recent-event ring is not needed here.
 */
export async function getServerDiagnosticsSummary() {
  return apiFetchJson('/api/diagnostics/server?limit=1', undefined, 'getServerDiagnosticsSummary');
}

export async function listWidgetInstallations() {
  return apiFetchJson('/api/widget-installations', undefined, 'listWidgetInstallations');
}

export async function createWidgetInstallation(payload) {
  return apiFetchJson('/api/widget-installations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  }, 'createWidgetInstallation');
}

export async function updateWidgetInstallation(installationId, payload) {
  return apiFetchJson(`/api/widget-installations/${encodeURIComponent(installationId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  }, 'updateWidgetInstallation');
}

export async function deleteWidgetInstallation(installationId) {
  return apiFetchJson(`/api/widget-installations/${encodeURIComponent(installationId)}`, {
    method: 'DELETE',
  }, 'deleteWidgetInstallation');
}

/**
 * Uploads a screenshot as base64 or a File; the server stores it in data/uploads/.
 * @param {string|File} base64OrFile - image data as base64, or a File object
 * @returns {Promise<{ ok: boolean, path?: string, filename?: string, error?: string }>}
 */
// TypeScript checks the legacy API contract separately; this split preserves its runtime implementation.
// @ts-nocheck
