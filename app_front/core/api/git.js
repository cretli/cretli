// @ts-nocheck
// This module preserves the existing API implementation during the structural split.
import { crHeaders, isApiDebugEnabled, getDebugSinceAppStartMs, formatDebugOffset, debugApiLog, rememberRestoreGeneration, isRestoreGenerationRejection, retryAfterRestoreGenerationRefresh, dedupeGetJson, cloneCached, json, redirectLogin, apiFetchJson, API_DEBUG_FLAG_LS_KEY, STARTUP_GET_TTL_MS, GIT_INFO_TTL_MS, startupGetCache, startupGetInFlight, startupGetEpoch, inFlightGetRequests, appLogger, getCurrentLang, readStorageValueWithAlias, applyChatAuthSessionBoundary, clearPushInboxCache, scopeTodoPayload, todoWorkspaceQuery, VIEW_CONTEXT_STATUS, hasExplicitWorkspace, viewContextRuntimeParams, getViewContextState, isViewContextScopedAccessAllowed, withViewContextQuery, sharedState, isWorkspaceWatcherRetryableBlockedTodo, applyCsrfFromAuthPayload, buildCretliApiHeaders, cretliApiFetch, getCsrfToken, getWidgetAccessToken, onCretliApiWrite, setCsrfToken, setWidgetAccessToken, buildChatIdsQuery, chunkExplicitChatIds, fitsChatIdsQuery, MAX_CHAT_REVISIONS_FETCH_PARTS, normalizeExplicitChatIds } from './runtime.js';
import { invalidateStartupGetCache, sharedStartupGet, getWorkspace, getWorkspaceContext, getSettings, getApprovalAuditSummary, getSidebarLayout, patchSidebarLayout, patchSettings, patchSettingsLanHost, getBrowserPolicy, patchBrowserPolicy, buildApprovalSettingsPatch, patchApprovalBrokerSettings, getLanUrl, logout, getAuthStatus, getTerminalSession, getTaskRuns, getTasks, deleteTaskRun, getChats, getChatListSync, getChatListPage, getChatSdkMessages, getChatHistory, postChatHistoryRevisionsBatch, getChatHistoryRevisions, getChatAgentStates, disposeSdkChatRoom, postChatHistory, postChatHistoryBatch, getAgentSdkStatus, getOpenCodeStatus, getOpenCodeModels, getOpenRouterStatus, getOpenRouterModels, getCodeBuddyStatus, getCodeBuddyModels, getMistralStatus, getMistralModels, getZaiStatus, getZaiModels, getMimoStatus, getMimoModels, getDeepSeekStatus, getDeepSeekModels, getQwenStatus, getQwenModels, getClaudeStatus, getClaudeModels, startClaudePlanLogin, completeClaudePlanLogin, cancelClaudePlanLogin, getClaudePlanLimits, getContextCacheSeries, getCodexPlanLimits, getCodexStatus, getCodexModels, startCodexLogin, getCodexLoginStatus, cancelCodexLogin, logoutCodex, getWorktrees, postChat, postChatFork, postChatForkWithSummary, getChatPlan, getDelegationExecutors, getHarnessCatalog, postManualChatDelegation, postChatDelegation, getChatRecoveryRuns, postRecoveryResume, postRecoveryKeepStopped, getChatDelegations, getDelegation, getDelegationRuntime, getWorkspaceDelegations, getDelegationTree, postDelegationRetryDelivery, postDelegationCancel, postChatSeen, postDelegationAck, getDelegationAcceptContext, getDelegationReportLink, postDelegationAccept, postChatMailboxReply, postChatMailboxRetry, postDelegationRetry, patchChat, getChatTitleHistory, regenerateChatTitle, setChatTitleLock, archiveChat, deleteChat, deleteChatHistory, postChatSyncTodoPlan, getChatDiag, postSdkChatProbe, postChatResetSdkContext, postGenerateChatTitle, postGenerateChatSummary, getWorkspaces, writeWorkspaceFileFolders, convertWorkspaceFileToSelf, exportWorkspaceToFile, getFsEntries, createFsFolder, getStatusFlowScenariosFixture, getFilesEntries, getFileContent, invalidateTodoListCache, getTodos, getTodo, getTodoHistory, postTodo, patchTodo, deferTodo, restoreDeferredTodo, restoreTodoToTree, recoverWorkspaceWatcherTodo, releaseDoingWorkspaceWatcherTodo, retryWorkspaceWatcherTodo, integrateTodo, smartMergeTodo, verifyIntegrationTodo, integrateTodosBatch, getIntegrateBatch, cancelIntegrateBatch, resumeIntegrateBatch, abandonIntegrateBatch, clearIntegrationLock, listWorktrees, getWorktreeDiff, getWorktreeMergePreview, startWorktreeMerge, rejectWorktree, cleanupWorktree, deleteTodo, postTodoStartAgent, getTodoStartAgentStatus, getCursorContext, getUpdateStatus, postUpdateApply, postDevAction, getServerHealth, getServerDiagnosticsSummary, listWidgetInstallations, createWidgetInstallation, updateWidgetInstallation, deleteWidgetInstallation, uploadScreenshot, requestSpeech, requestTranscription, postUsageEvent, getCreditLedger, getCreditLedgerForecast, getCreditLedgerHarnessLinks, mutateCreditLedger, getCreditSubscriptions, mutateCreditSubscriptions, getDeepSeekBalanceStatus, refreshDeepSeekBalanceReading, getUsagePlanLimits, getUsageSettings, saveUsageSettings, getUsageLimitResumeSettings, saveUsageLimitResumeSettings, getUsageLimitResumeItems, cancelUsageLimitResume, getUsageSummary, getUsageTimeseries, getUsageModels, getUsageInsights, getUsageCacheFreshness, getUsageResumeAdvice, getUsageKeepAlive, stopUsageKeepAlive, getUsageTop, getUsageLimitBurn, getUsageWorkflowBreakdown, getReviewFindings, postRejectReviewFinding, getDelegationStats, getHarnessHealth, getHarnessDiagnostics, getHarnessModelRoleConfig, previewHarnessModelRoleConfig, putHarnessModelRoleConfig, resetHarnessModelRoleConfig, getModelPickOverrides, putModelPickOverride, revokeModelPickOverride, resetModelPickOverrides, getHarnessBenchmarkSources, putHarnessBenchmarkImport, getWorkspaceModelPickOverrides, putWorkspaceModelPickOverride, revokeWorkspaceModelPickOverride, clearHarnessUsageLimit, ackUnclassifiedError, getHarnessVersions, updateHarnessPackages, installMistralSdk, installZaiSdk, refreshHarnessModelsCatalog, requestRealtimeToken, probeGeminiApiKey, requestGeminiLiveToken, appendVoiceSessionEvents, fetchVoiceSessionLog, listVoiceSessionLogs, updateHarnessBenchmarkSource, getPermissionGrants, revokePermissionGrants, getWakeups, getWakeupKinds, getWakeupStatus, saveWakeupKindSettings, cancelWakeup, runWakeupNow } from './index.js';
function buildGitScopeParams(scope) {
  const params = new URLSearchParams();
  const chatId = String(scope?.chatId || '').trim();
  const todoId = String(scope?.todoId || '').trim();
  const workspaceFolder = String(scope?.workspaceFolder || '').trim();
  if (chatId) params.set('chatId', chatId);
  if (todoId) params.set('todoId', todoId);
  if (workspaceFolder) params.set('workspaceFolder', workspaceFolder);
  return params;
}

/**
 * A Git/GitHub request with NO selector makes the route fall back to the
 * server's shared settings cwd (lib/git-context.js). While this tab is under an
 * explicit `ws`/`folder` link that has not resolved (pending, missing or
 * conflicting), that fallback answer belongs to a DIFFERENT workspace, so the
 * request is refused here instead of leaving the tab.
 *
 * @param {{ chatId?: string, todoId?: string, workspaceFolder?: string } | null | undefined} scope
 * @returns {boolean}
 */
function isUnscopedGitRequestBlocked(scope) {
  if (buildGitScopeParams(scope).toString() !== '') return false;
  const state = getViewContextState();
  if (!state || !hasExplicitWorkspace(state.context)) return false;
  if (!isViewContextScopedAccessAllowed()) return true;
  if (state.status === VIEW_CONTEXT_STATUS.CONFLICT) return true;
  return false;
}

/** @returns {{ ok: false, code: string }} */
/**
 * @param {string} basePath
 * @param {URLSearchParams} params
 * @returns {string}
 */
function withQuery(basePath, params) {
  const query = params.toString();
  return query ? `${basePath}?${query}` : basePath;
}

/** Per-URL error backoff for /api/git/info: repeated failures must not hammer the server. */
const GIT_INFO_BACKOFF_BASE_MS = 2000;
const GIT_INFO_BACKOFF_MAX_MS = 30000;
/** @type {Map<string, { failures: number, until: number, last: any }>} */
const gitInfoBackoff = new Map();
onCretliApiWrite(() => gitInfoBackoff.clear());

function noteGitInfoFailure(url, last) {
  const failures = (gitInfoBackoff.get(url)?.failures || 0) + 1;
  const delay = Math.min(GIT_INFO_BACKOFF_MAX_MS, GIT_INFO_BACKOFF_BASE_MS * 2 ** (failures - 1));
  gitInfoBackoff.set(url, { failures, until: Date.now() + delay, last });
}

export async function getGitInfo(scope = null) {
  if (isUnscopedGitRequestBlocked(scope)) return blockedGitScopeResult();
  const url = withQuery('/api/git/info', buildGitScopeParams(scope));
  const backoff = gitInfoBackoff.get(url);
  if (backoff && Date.now() < backoff.until) return cloneCached(backoff.last);
  let data;
  try {
    data = await sharedStartupGet(url, () => cretliApiFetch(url, {}, { acceptLanguage: getCurrentLang() }).then(json), GIT_INFO_TTL_MS);
  } catch (err) {
    noteGitInfoFailure(url, { ok: false, error: err?.message || 'git info failed.' });
    throw err;
  }
  if (data && data.ok === false) noteGitInfoFailure(url, data);
  else gitInfoBackoff.delete(url);
  if (!scope) sharedState.publishGitInfo(data);
  return data;
}

/** Local branches for the workspace quick switch (server parses `for-each-ref`). */
export async function getGitBranches(scope = null) {
  if (isUnscopedGitRequestBlocked(scope)) return blockedGitScopeResult();
  return cretliApiFetch(withQuery('/api/git/branches', buildGitScopeParams(scope)), {}, { acceptLanguage: getCurrentLang() }).then(json);
}

/** Diff of a single file against HEAD; path is relative to the execution folder. */
export async function getGitFileDiff(filePath, scope = null) {
  if (isUnscopedGitRequestBlocked(scope)) return blockedGitScopeResult();
  const params = buildGitScopeParams(scope);
  params.set('path', String(filePath));
  return cretliApiFetch(withQuery('/api/git/file-diff', params), {}, { acceptLanguage: getCurrentLang() }).then(json);
}

export async function postGitAction(payload, scope = null) {
  // A write is the dangerous half: an empty scope would run Git in whatever
  // folder the server happens to default to, not the workspace the link named.
  if (isUnscopedGitRequestBlocked(scope)) return blockedGitScopeResult();
  const body = { ...(payload || {}) };
  for (const [key, value] of buildGitScopeParams(scope)) body[key] = value;
  return cretliApiFetch('/api/git/run', {
    method: 'POST',
    headers: crHeaders({ 'Content-Type': 'application/json' }, '/api/git/run'),
    body: JSON.stringify(body),
  }, { acceptLanguage: getCurrentLang() }).then(json);
}

export async function getGithubInfo(scope = null) {
  if (isUnscopedGitRequestBlocked(scope)) return blockedGitScopeResult();
  const url = withQuery('/api/github/info', buildGitScopeParams(scope));
  return sharedStartupGet(url, () => cretliApiFetch(url, {}, { acceptLanguage: getCurrentLang() }).then(json), GIT_INFO_TTL_MS);
}

export async function getGithubWorkflowRuns(options = {}) {
  if (isUnscopedGitRequestBlocked(options.scope)) return blockedGitScopeResult();
  const params = buildGitScopeParams(options.scope);
  if (options.perPage) params.set('per_page', String(options.perPage));
  if (options.page) params.set('page', String(options.page));
  return cretliApiFetch(withQuery('/api/github/actions/runs', params), {}, { acceptLanguage: getCurrentLang() }).then(json);
}

export async function getGithubWorkflowRunJobs(runId, options = {}) {
  if (isUnscopedGitRequestBlocked(options.scope)) return blockedGitScopeResult();
  const params = buildGitScopeParams(options.scope);
  return cretliApiFetch(
    withQuery(`/api/github/actions/runs/${encodeURIComponent(String(runId))}/jobs`, params),
    {},
    { acceptLanguage: getCurrentLang() },
  ).then(json);
}

export async function getGithubWorkflowJobLogs(jobId, options = {}) {
  if (isUnscopedGitRequestBlocked(options.scope)) return blockedGitScopeResult();
  const params = buildGitScopeParams(options.scope);
  return cretliApiFetch(
    withQuery(`/api/github/actions/jobs/${encodeURIComponent(String(jobId))}/logs`, params),
    {},
    { acceptLanguage: getCurrentLang() },
  ).then(json);
}

/**
 * Ask the server to restart the Node process (local npm start only).
 * @param {'restart-server'} [action]
 */
import { blockedGitScopeResult } from './runtime.js';
// TypeScript checks the legacy API contract separately; this split preserves its runtime implementation.
// @ts-nocheck
