// @ts-nocheck
// This module preserves the existing API implementation during the structural split.
import { crHeaders, isApiDebugEnabled, getDebugSinceAppStartMs, formatDebugOffset, debugApiLog, rememberRestoreGeneration, isRestoreGenerationRejection, retryAfterRestoreGenerationRefresh, dedupeGetJson, cloneCached, json, redirectLogin, apiFetchJson, API_DEBUG_FLAG_LS_KEY, STARTUP_GET_TTL_MS, GIT_INFO_TTL_MS, startupGetCache, startupGetInFlight, startupGetEpoch, inFlightGetRequests, appLogger, getCurrentLang, readStorageValueWithAlias, applyChatAuthSessionBoundary, clearPushInboxCache, scopeTodoPayload, todoWorkspaceQuery, VIEW_CONTEXT_STATUS, hasExplicitWorkspace, viewContextRuntimeParams, getViewContextState, isViewContextScopedAccessAllowed, withViewContextQuery, sharedState, isWorkspaceWatcherRetryableBlockedTodo, applyCsrfFromAuthPayload, buildCretliApiHeaders, cretliApiFetch, getCsrfToken, getWidgetAccessToken, onCretliApiWrite, setCsrfToken, setWidgetAccessToken, buildChatIdsQuery, chunkExplicitChatIds, fitsChatIdsQuery, MAX_CHAT_REVISIONS_FETCH_PARTS, normalizeExplicitChatIds } from './runtime.js';
import { getViewContextRuntimeScope } from '../../app/appShell/viewContextBridge.js';
import { invalidateStartupGetCache, sharedStartupGet, getTaskRuns, getTasks, deleteTaskRun, getAgentRuns, getAgents, getAgentsSchedule, patchAgentsSchedule, getChats, getChatListSync, getChatListPage, getChatSdkMessages, getChatHistory, postChatHistoryRevisionsBatch, getChatHistoryRevisions, getChatAgentStates, disposeSdkChatRoom, postChatHistory, postChatHistoryBatch, getAgentSdkStatus, getOpenCodeStatus, getOpenCodeModels, getOpenRouterStatus, getOpenRouterModels, getCodeBuddyStatus, getCodeBuddyModels, getMistralStatus, getMistralModels, getZaiStatus, getZaiModels, getMimoStatus, getMimoModels, getDeepSeekStatus, getDeepSeekModels, getQwenStatus, getQwenModels, getClaudeStatus, getClaudeModels, startClaudePlanLogin, completeClaudePlanLogin, cancelClaudePlanLogin, getClaudePlanLimits, getContextCacheSeries, getCodexPlanLimits, getCodexStatus, getCodexModels, startCodexLogin, getCodexLoginStatus, cancelCodexLogin, logoutCodex, getWorktrees, postChat, postChatFork, postChatForkWithSummary, getChatPlan, getDelegationExecutors, getHarnessCatalog, postManualChatDelegation, postChatDelegation, getChatRecoveryRuns, postRecoveryResume, postRecoveryKeepStopped, getChatDelegations, getDelegation, getDelegationRuntime, getWorkspaceDelegations, getDelegationTree, postDelegationRetryDelivery, postDelegationCancel, postChatSeen, postDelegationAck, getDelegationAcceptContext, getDelegationReportLink, postDelegationAccept, postChatMailboxReply, postChatMailboxRetry, postDelegationRetry, patchChat, getChatTitleHistory, regenerateChatTitle, setChatTitleLock, archiveChat, deleteChat, deleteChatHistory, postChatSyncTodoPlan, getChatDiag, postSdkChatProbe, postChatResetSdkContext, postGenerateChatTitle, postGenerateChatSummary, getWorkspaces, writeWorkspaceFileFolders, convertWorkspaceFileToSelf, exportWorkspaceToFile, getFsEntries, createFsFolder, getStatusFlowScenariosFixture, getFilesEntries, getFileContent, invalidateTodoListCache, getTodos, getTodo, getTodoHistory, postTodo, patchTodo, deferTodo, restoreDeferredTodo, restoreTodoToTree, recoverWorkspaceWatcherTodo, releaseDoingWorkspaceWatcherTodo, retryWorkspaceWatcherTodo, integrateTodo, smartMergeTodo, verifyIntegrationTodo, integrateTodosBatch, getIntegrateBatch, cancelIntegrateBatch, resumeIntegrateBatch, abandonIntegrateBatch, clearIntegrationLock, listWorktrees, getWorktreeDiff, getWorktreeMergePreview, startWorktreeMerge, rejectWorktree, cleanupWorktree, deleteTodo, postTodoStartAgent, getTodoStartAgentStatus, getCursorContext, getGitInfo, getGitBranches, getGitFileDiff, postGitAction, getGithubInfo, getGithubWorkflowRuns, getGithubWorkflowRunJobs, getGithubWorkflowJobLogs, getUpdateStatus, postUpdateApply, postDevAction, getServerHealth, getServerDiagnosticsSummary, listWidgetInstallations, createWidgetInstallation, updateWidgetInstallation, deleteWidgetInstallation, uploadScreenshot, requestSpeech, requestTranscription, postUsageEvent, getCreditLedger, getCreditLedgerForecast, getCreditLedgerHarnessLinks, mutateCreditLedger, getCreditSubscriptions, mutateCreditSubscriptions, getDeepSeekBalanceStatus, refreshDeepSeekBalanceReading, getUsagePlanLimits, getUsageSettings, saveUsageSettings, getUsageLimitResumeSettings, saveUsageLimitResumeSettings, getUsageLimitResumeItems, cancelUsageLimitResume, getUsageSummary, getUsageTimeseries, getUsageModels, getUsageInsights, getUsageCacheFreshness, getUsageResumeAdvice, getUsageKeepAlive, stopUsageKeepAlive, getUsageTop, getUsageLimitBurn, getUsageWorkflowBreakdown, getReviewFindings, postRejectReviewFinding, getDelegationStats, getHarnessHealth, getHarnessDiagnostics, getHarnessModelRoleConfig, previewHarnessModelRoleConfig, putHarnessModelRoleConfig, resetHarnessModelRoleConfig, getModelPickOverrides, putModelPickOverride, revokeModelPickOverride, resetModelPickOverrides, getHarnessBenchmarkSources, putHarnessBenchmarkImport, getWorkspaceModelPickOverrides, putWorkspaceModelPickOverride, revokeWorkspaceModelPickOverride, clearHarnessUsageLimit, ackUnclassifiedError, getHarnessVersions, updateHarnessPackages, installMistralSdk, installZaiSdk, refreshHarnessModelsCatalog, requestRealtimeToken, probeGeminiApiKey, requestGeminiLiveToken, appendVoiceSessionEvents, fetchVoiceSessionLog, listVoiceSessionLogs, updateHarnessBenchmarkSource, getPermissionGrants, revokePermissionGrants, getWakeups, getWakeupKinds, getWakeupStatus, saveWakeupKindSettings, cancelWakeup, runWakeupNow } from './index.js';
export async function getWorkspace() {
  return sharedStartupGet('/api/workspace', () => dedupeGetJson('/api/workspace', 'getWorkspace'));
}

/**
 * Resolve opaque view-context route ids (`ws`/`folder`) into runtime workspace
 * paths before a panel fetches data. Answers with `{ ok:false, error: code }`
 * for a deleted or foreign id; the caller must keep the link's target then.
 *
 * @param {{ workspaceKey?: string, folderKey?: string }} ids
 */
export async function getWorkspaceContext(ids = {}) {
  const params = new URLSearchParams();
  const workspaceKey = String(ids.workspaceKey || '').trim();
  const folderKey = String(ids.folderKey || '').trim();
  if (workspaceKey) params.set('ws', workspaceKey);
  if (folderKey) params.set('folder', folderKey);
  const qs = params.toString();
  return dedupeGetJson(qs ? `/api/workspace/context?${qs}` : '/api/workspace/context', 'getWorkspaceContext');
}

export async function getSettings() {
  const data = await sharedStartupGet('/api/settings', () => dedupeGetJson('/api/settings', 'getSettings'));
  sharedState.publishSettings(data);
  return rememberRestoreGeneration(data);
}

/**
 * Counters-only summary of approval-audit.jsonl (decisions by source, advisor skips by reason).
 *
 * @param {number} [days]
 */
export async function getApprovalAuditSummary(days = 7) {
  return dedupeGetJson(`/api/approval-broker/audit-summary?days=${encodeURIComponent(days)}`, 'getApprovalAuditSummary');
}

export async function getSidebarLayout() {
  return dedupeGetJson('/api/sidebar-layout', 'getSidebarLayout');
}

export async function patchSidebarLayout(payload) {
  return apiFetchJson('/api/sidebar-layout', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  }, 'patchSidebarLayout');
}

export async function patchSettings(payload) {
  return apiFetchJson('/api/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  }, 'patchSettings');
}

/** Updates only the LAN host; other settings are left untouched. */
export async function patchSettingsLanHost(lanHost) {
  return patchSettings({ lanHost: lanHost != null ? String(lanHost).trim() : '' });
}

/**
 * Workspace of this tab for the Browser policy routes. Without it the server
 * answers for its globally selected workspace, which is not the one an agent
 * of this tab (e.g. a Watcher chat in another folder) reads its policy from.
 *
 * @returns {{ workspaceFile?: string, workspaceFolder?: string }}
 */
function browserPolicyScope() {
  const { workspaceFile, workspaceFolder } = getViewContextRuntimeScope();
  const scope = {};
  if (workspaceFile) scope.workspaceFile = workspaceFile;
  if (workspaceFolder) scope.workspaceFolder = workspaceFolder;
  return scope;
}

export async function getBrowserPolicy() {
  const query = new URLSearchParams(browserPolicyScope()).toString();
  return dedupeGetJson(`/api/browser/policy${query ? `?${query}` : ''}`, 'getBrowserPolicy');
}

/** Browser runtime status (headless vs external CDP Chrome, connection state). */
export async function getBrowserRuntimeStatus() {
  return dedupeGetJson('/api/browser/status', 'getBrowserRuntimeStatus');
}

/** External Chrome (CDP) endpoint configured in Settings or pinned by env. */
export async function getBrowserRuntimeConfig() {
  return apiFetchJson('/api/browser/runtime-config', undefined, 'getBrowserRuntimeConfig');
}

/** Saves the CDP endpoint; the server checks it and swaps the driver in place. */
export async function putBrowserRuntimeConfig(config) {
  return apiFetchJson('/api/browser/runtime-config?mode=agent', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config || {}),
  }, 'putBrowserRuntimeConfig');
}

export async function patchBrowserPolicy(policy) {
  return apiFetchJson('/api/browser/policy?mode=agent', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...browserPolicyScope(), policy: policy || {} }),
  }, 'patchBrowserPolicy');
}

const APPROVAL_SETTINGS_ALLOWED_KEYS = new Set([
  'approvalBroker',
  'approvalAdvisorApiKey',
  'clearApprovalAdvisorApiKey',
]);

/**
 * Pure whitelist/sanitizer for the Approval Broker settings PATCH body. Kept
 * separate from the request so the payload contract can be unit-tested without
 * touching the network; it also guarantees an empty key is never sent (which
 * would otherwise delete the stored key without the explicit Clear action).
 *
 * @param {{ approvalBroker?: object, approvalAdvisorApiKey?: string, clearApprovalAdvisorApiKey?: boolean }|null|undefined} payload
 * @returns {{ approvalBroker?: object, approvalAdvisorApiKey?: string, clearApprovalAdvisorApiKey?: boolean }}
 */
export function buildApprovalSettingsPatch(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const body = {};
  for (const key of Object.keys(source)) {
    if (!APPROVAL_SETTINGS_ALLOWED_KEYS.has(key)) continue;
    if (key === 'approvalAdvisorApiKey') {
      const value = typeof source[key] === 'string' ? source[key].trim() : '';
      if (!value) continue;
      body[key] = value;
      continue;
    }
    body[key] = source[key];
  }
  return body;
}

/**
 * Update the Approval Broker / external advisor settings.
 *
 * Delegates to `patchSettings` (whose debug log prints only the method and URL —
 * never the body), so the write-only API key is never logged or echoed.
 *
 * @param {{ approvalBroker?: object, approvalAdvisorApiKey?: string, clearApprovalAdvisorApiKey?: boolean }} payload
 */
export async function patchApprovalBrokerSettings(payload) {
  return patchSettings(buildApprovalSettingsPatch(payload));
}

export async function getLanUrl() {
  return dedupeGetJson('/api/lan-url', 'getLanUrl');
}

/** Logs out the current session and clears the server-side cookie. */
export async function logout() {
  try {
    const result = await apiFetchJson('/api/logout', { method: 'POST' }, 'logout');
    await applyChatAuthSessionBoundary({ reason: 'logout' });
    return result;
  } finally {
    applyCsrfFromAuthPayload(null);
  }
}

/** Auth status: whether a password is configured and whether login is required. */
export async function getAuthStatus() {
  const data = await sharedStartupGet('/api/auth-status', () => dedupeGetJson('/api/auth-status', 'getAuthStatus'));
  applyCsrfFromAuthPayload(data);
  return data;
}

export async function getTerminalSession() {
  return dedupeGetJson('/api/terminal-session', 'getTerminalSession');
}

/** Active task runs, so a page reload can re-attach to them the same way chat sessions do. */
// TypeScript checks the legacy API contract separately; this split preserves its runtime implementation.
// @ts-nocheck
