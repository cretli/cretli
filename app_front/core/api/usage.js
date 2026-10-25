// @ts-nocheck
// This module preserves the existing API implementation during the structural split.
import { crHeaders, isApiDebugEnabled, getDebugSinceAppStartMs, formatDebugOffset, debugApiLog, rememberRestoreGeneration, isRestoreGenerationRejection, retryAfterRestoreGenerationRefresh, dedupeGetJson, cloneCached, json, redirectLogin, apiFetchJson, API_DEBUG_FLAG_LS_KEY, STARTUP_GET_TTL_MS, GIT_INFO_TTL_MS, startupGetCache, startupGetInFlight, startupGetEpoch, inFlightGetRequests, appLogger, getCurrentLang, readStorageValueWithAlias, applyChatAuthSessionBoundary, clearPushInboxCache, scopeTodoPayload, todoWorkspaceQuery, VIEW_CONTEXT_STATUS, hasExplicitWorkspace, viewContextRuntimeParams, getViewContextState, isViewContextScopedAccessAllowed, withViewContextQuery, sharedState, isWorkspaceWatcherRetryableBlockedTodo, applyCsrfFromAuthPayload, buildCretliApiHeaders, cretliApiFetch, getCsrfToken, getWidgetAccessToken, onCretliApiWrite, setCsrfToken, setWidgetAccessToken, buildChatIdsQuery, chunkExplicitChatIds, fitsChatIdsQuery, MAX_CHAT_REVISIONS_FETCH_PARTS, normalizeExplicitChatIds } from './runtime.js';
import { invalidateStartupGetCache, sharedStartupGet, getWorkspace, getWorkspaceContext, getSettings, getApprovalAuditSummary, getSidebarLayout, patchSidebarLayout, patchSettings, patchSettingsLanHost, getBrowserPolicy, patchBrowserPolicy, buildApprovalSettingsPatch, patchApprovalBrokerSettings, getLanUrl, logout, getAuthStatus, getTerminalSession, getTaskRuns, getTasks, deleteTaskRun, getAgentRuns, getAgents, getAgentsSchedule, patchAgentsSchedule, getChats, getChatListSync, getChatListPage, getChatSdkMessages, getChatHistory, postChatHistoryRevisionsBatch, getChatHistoryRevisions, getChatAgentStates, disposeSdkChatRoom, postChatHistory, postChatHistoryBatch, getAgentSdkStatus, getOpenCodeStatus, getOpenCodeModels, getOpenRouterStatus, getOpenRouterModels, getCodeBuddyStatus, getCodeBuddyModels, getMistralStatus, getMistralModels, getZaiStatus, getZaiModels, getMimoStatus, getMimoModels, getDeepSeekStatus, getDeepSeekModels, getQwenStatus, getQwenModels, getClaudeStatus, getClaudeModels, startClaudePlanLogin, completeClaudePlanLogin, cancelClaudePlanLogin, getClaudePlanLimits, getContextCacheSeries, getCodexPlanLimits, getCodexStatus, getCodexModels, startCodexLogin, getCodexLoginStatus, cancelCodexLogin, logoutCodex, getWorktrees, postChat, postChatFork, postChatForkWithSummary, getChatPlan, getDelegationExecutors, getHarnessCatalog, postManualChatDelegation, postChatDelegation, getChatRecoveryRuns, postRecoveryResume, postRecoveryKeepStopped, getChatDelegations, getDelegation, getDelegationRuntime, getWorkspaceDelegations, getDelegationTree, postDelegationRetryDelivery, postDelegationCancel, postChatSeen, postDelegationAck, getDelegationAcceptContext, getDelegationReportLink, postDelegationAccept, postChatMailboxReply, postChatMailboxRetry, postDelegationRetry, patchChat, getChatTitleHistory, regenerateChatTitle, setChatTitleLock, archiveChat, deleteChat, deleteChatHistory, postChatSyncTodoPlan, getChatDiag, postSdkChatProbe, postChatResetSdkContext, postGenerateChatTitle, postGenerateChatSummary, getWorkspaces, writeWorkspaceFileFolders, convertWorkspaceFileToSelf, exportWorkspaceToFile, getFsEntries, createFsFolder, getStatusFlowScenariosFixture, getFilesEntries, getFileContent, invalidateTodoListCache, getTodos, getTodo, getTodoHistory, postTodo, patchTodo, deferTodo, restoreDeferredTodo, restoreTodoToTree, recoverWorkspaceWatcherTodo, releaseDoingWorkspaceWatcherTodo, retryWorkspaceWatcherTodo, integrateTodo, smartMergeTodo, verifyIntegrationTodo, integrateTodosBatch, getIntegrateBatch, cancelIntegrateBatch, resumeIntegrateBatch, abandonIntegrateBatch, clearIntegrationLock, listWorktrees, getWorktreeDiff, getWorktreeMergePreview, startWorktreeMerge, rejectWorktree, cleanupWorktree, deleteTodo, postTodoStartAgent, getTodoStartAgentStatus, getCursorContext, getGitInfo, getGitBranches, getGitFileDiff, postGitAction, getGithubInfo, getGithubWorkflowRuns, getGithubWorkflowRunJobs, getGithubWorkflowJobLogs, getUpdateStatus, postUpdateApply, postDevAction, getServerHealth, getServerDiagnosticsSummary, listWidgetInstallations, createWidgetInstallation, updateWidgetInstallation, deleteWidgetInstallation, requestRealtimeToken, probeGeminiApiKey, requestGeminiLiveToken, appendVoiceSessionEvents, fetchVoiceSessionLog, listVoiceSessionLogs, updateHarnessBenchmarkSource, getPermissionGrants, revokePermissionGrants, getWakeups, getWakeupKinds, getWakeupStatus, saveWakeupKindSettings, cancelWakeup, runWakeupNow } from './index.js';
/**
 * Ledger aggregations scan days of journal on the server; under load they can
 * take longer than the 10 s GET default, which made the Usage tab report a
 * failure for data that was only slow.
 */
const USAGE_READ_OPTIONS = Object.freeze({ timeoutMs: 25000 });

export async function uploadScreenshot(base64OrFile) {
  let base64;
  if (typeof base64OrFile === 'string') {
    base64 = base64OrFile.trim();
  } else if (base64OrFile instanceof File) {
    base64 = await fileToOptimizedBase64(base64OrFile);
  } else {
    return { ok: false, error: 'Oczekiwano base64 lub File' };
  }
  const res = await cretliApiFetch('/api/upload-screenshot', {
    method: 'POST',
    headers: crHeaders({ 'Content-Type': 'application/json' }, '/api/upload-screenshot'),
    body: JSON.stringify({ base64 }),
  }, { acceptLanguage: getCurrentLang() });
  if (res && res.status === 401 && typeof window !== 'undefined' && !getWidgetAccessToken()) redirectLogin();
  return res.json();
}

/**
 * Server-side text-to-speech. Provider keys stay on the server; the browser only
 * ever receives the rendered audio.
 *
 * @param {{ text: string, voice?: string, speed?: number, provider?: string, lang?: string }} payload
 * @returns {Promise<{ ok: boolean, audioBase64?: string, mimeType?: string, error?: string }>}
 */
export async function requestSpeech(payload) {
  return apiFetchJson('/api/voice/speak', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: String(payload?.text || ''),
      voice: payload?.voice ? String(payload.voice) : undefined,
      speed: Number.isFinite(payload?.speed) ? Number(payload.speed) : undefined,
      provider: payload?.provider ? String(payload.provider) : undefined,
      lang: payload?.lang ? String(payload.lang) : undefined,
    }),
  }, 'requestSpeech', { timeoutMs: 30000 });
}

/**
 * Server-side speech to text for browsers without the Web Speech API.
 *
 * @param {{ base64: string, mimeType?: string, lang?: string }} payload
 * @returns {Promise<{ ok: boolean, text?: string, error?: string }>}
 */
export async function requestTranscription(payload) {
  return apiFetchJson('/api/voice/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base64: String(payload?.base64 || ''),
      mimeType: payload?.mimeType ? String(payload.mimeType) : undefined,
      lang: payload?.lang ? String(payload.lang) : undefined,
    }),
  }, 'requestTranscription', { timeoutMs: 60000 });
}

/**
 * Reports raw OpenAI Realtime usage. The server prices it; do not send usd.
 *
 * @param {{ provider?: string, feature?: string, model?: string, usage?: object, tokens?: object, chatId?: string, workspaceFile?: string }} payload
 * @returns {Promise<{ ok: boolean, event?: { id: string, usd: number|null } }>}
 */
export async function postUsageEvent(payload = {}) {
  return apiFetchJson('/api/usage/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: payload.provider ? String(payload.provider) : undefined,
      feature: payload.feature ? String(payload.feature) : undefined,
      model: payload.model ? String(payload.model) : undefined,
      usage: payload.usage,
      tokens: payload.tokens,
      chatId: payload.chatId ? String(payload.chatId) : undefined,
      workspaceFile: payload.workspaceFile ? String(payload.workspaceFile) : undefined,
    }),
  }, 'postUsageEvent', { timeoutMs: 8000 });
}

/**
 * Credit ledger read model (accounts, history, derived views, revision).
 *
 * @returns {Promise<{ ok: boolean, revision?: number, accounts?: object[], transactions?: object[], snapshots?: object[], views?: object, error?: string }>}
 */
export async function getCreditLedger() {
  return dedupeGetJson('/api/credit-ledger', 'getCreditLedger', USAGE_READ_OPTIONS);
}

/** @returns {Promise<{ ok: boolean, forecasts?: object[], alerts?: object[], now?: string, error?: string }>} */
export async function getCreditLedgerForecast() {
  return dedupeGetJson('/api/credit-ledger/forecast', 'getCreditLedgerForecast', USAGE_READ_OPTIONS);
}

/** @returns {Promise<{ ok: boolean, links?: object[], error?: string }>} */
export async function getCreditLedgerHarnessLinks() {
  return dedupeGetJson('/api/credit-ledger/harness-links', 'getCreditLedgerHarnessLinks', USAGE_READ_OPTIONS);
}

/**
 * Ledger mutation. Every write carries the revision the caller last saw as
 * `If-Match`; a stale one answers 409 with the current `revision`.
 *
 * @param {'POST'|'PUT'|'DELETE'} method
 * @param {string} path
 * @param {number} revision
 * @param {object} [body]
 */
export async function mutateCreditLedger(method, path, revision, body = {}) {
  return apiFetchJson(`/api/credit-ledger${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'If-Match': `"${Number(revision) || 0}"` },
    body: JSON.stringify(body),
  }, 'mutateCreditLedger', { timeoutMs: 15000 });
}

/** @returns {Promise<{ ok: boolean, revision?: number, subscriptions?: object[], cash?: object, suggestions?: object[], error?: string }>} */
export async function getCreditSubscriptions() {
  return dedupeGetJson('/api/credit-ledger/subscriptions', 'getCreditSubscriptions', USAGE_READ_OPTIONS);
}

/**
 * Subscription register mutation (own revision, sent as `If-Match`).
 *
 * @param {'POST'|'PUT'} method
 * @param {string} path suffix after `/subscriptions`
 * @param {number} revision
 * @param {object} [body]
 */
export async function mutateCreditSubscriptions(method, path, revision, body = {}) {
  return apiFetchJson(`/api/credit-ledger/subscriptions${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'If-Match': `"${Number(revision) || 0}"` },
    body: JSON.stringify(body),
  }, 'mutateCreditSubscriptions', { timeoutMs: 15000 });
}

/** @returns {Promise<{ ok: boolean, lastAttempt?: { at: string, ok: boolean, kind: string } | null }>} */
export async function getDeepSeekBalanceStatus() {
  return dedupeGetJson('/api/credit-ledger/deepseek-balance', 'getDeepSeekBalanceStatus');
}

/** @returns {Promise<{ ok: boolean, error?: string }>} */
export async function refreshDeepSeekBalanceReading() {
  return apiFetchJson('/api/credit-ledger/deepseek-balance/refresh', { method: 'POST' }, 'refreshDeepSeekBalanceReading', { timeoutMs: 20000 });
}

export async function getUsagePlanLimits() {
  return dedupeGetJson('/api/usage/plan-limits', 'getUsagePlanLimits', USAGE_READ_OPTIONS);
}

/**
 * Usage telemetry settings + `data/usage/` size from GET /api/usage/settings.
 *
 * @returns {Promise<{ ok: boolean, settings?: object, storage?: object, error?: string }>}
 */
export async function getUsageSettings() {
  return dedupeGetJson('/api/usage/settings', 'getUsageSettings');
}

/**
 * Persist a usage settings patch (retention + alert thresholds) and optionally
 * run the retention sweep now.
 *
 * @param {{ retentionDays?: number, alerts?: object, usage?: object, pruneNow?: boolean }} patch
 * @returns {Promise<{ ok: boolean, settings?: object, storage?: object, pruned?: object, error?: string }>}
 */
export async function saveUsageSettings(patch = {}) {
  return apiFetchJson('/api/usage/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }, 'saveUsageSettings', { timeoutMs: 15000 });
}

/**
 * Usage-limit auto-resume settings block from GET /api/usage/limit-resume/settings.
 *
 * @returns {Promise<{ ok: boolean, settings?: object, error?: string }>}
 */
export async function getUsageLimitResumeSettings() {
  return dedupeGetJson('/api/usage/limit-resume/settings', 'getUsageLimitResumeSettings');
}

/**
 * Persist a partial auto-resume settings patch; the server clamps every value.
 *
 * @param {object} patch
 * @returns {Promise<{ ok: boolean, settings?: object, error?: string }>}
 */
export async function saveUsageLimitResumeSettings(patch = {}) {
  return apiFetchJson('/api/usage/limit-resume/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }, 'saveUsageLimitResumeSettings', { timeoutMs: 15000 });
}

/**
 * Pauses from GET /api/usage/limit-resume.
 *
 * @returns {Promise<{ ok: boolean, items?: object[], error?: string }>}
 */
export async function getUsageLimitResumeItems() {
  return apiFetchJson('/api/usage/limit-resume', undefined, 'getUsageLimitResumeItems');
}

/**
 * @param {string} id pause id
 * @returns {Promise<{ ok: boolean, changed?: boolean, error?: string }>}
 */
export async function cancelUsageLimitResume(id) {
  return apiFetchJson(`/api/usage/limit-resume/${encodeURIComponent(id)}/cancel`, { method: 'POST' }, 'cancelUsageLimitResume');
}

/**
 * Shared query builder for the stage-8 usage read endpoints, so the summary,
 * chart, table and insights always carry the same window and filters.
 *
 * @param {object} [query]
 * @returns {URLSearchParams}
 */
function buildUsageQueryParams(query = {}) {
  const params = new URLSearchParams();
  for (const key of ['from', 'to', 'tz', 'range', 'role', 'harness', 'origin', 'scope', 'subject']) {
    if (query[key]) params.set(key, String(query[key]));
  }
  if (query.purpose) params.set('purpose', String(query.purpose));
  if (query.workspaceFile || query.workspace) params.set('workspaceFile', String(query.workspaceFile || query.workspace));
  if (query.chatId || query.chat) params.set('chatId', String(query.chatId || query.chat));
  if (query.bucket) params.set('bucket', String(query.bucket));
  if (query.groupBy) params.set('groupBy', String(query.groupBy));
  if (query.metric) params.set('metric', String(query.metric));
  if (query.limit) params.set('limit', String(query.limit));
  return params;
}

export async function getUsageSummary(query = {}) {
  const params = buildUsageQueryParams(query);
  const suffix = params.toString() ? `?${params}` : '';
  return dedupeGetJson(`/api/usage/summary${suffix}`, 'getUsageSummary', USAGE_READ_OPTIONS);
}

/**
 * Bucketed usage from GET /api/usage/timeseries.
 *
 * @param {{ from?: string, to?: string, tz?: string, range?: string, bucket?: 'hour'|'day', groupBy?: 'model'|'harness'|'feature', metric?: 'usd'|'tokens'|'events'|'runs', role?: string, scope?: 'own'|'consolidated' }} [query]
 * @returns {Promise<{ ok: boolean, from?: string, to?: string, tz?: string, bucket?: string, groupBy?: string, metric?: string, buckets?: string[], series?: Array<{ group: string, values: number[] }>, error?: string }>}
 */
export async function getUsageTimeseries(query = {}) {
  const params = buildUsageQueryParams(query);
  const suffix = params.toString() ? `?${params}` : '';
  return dedupeGetJson(`/api/usage/timeseries${suffix}`, 'getUsageTimeseries', USAGE_READ_OPTIONS);
}

/**
 * Ranked per-model usage from GET /api/usage/models.
 *
 * @param {{ from?: string, to?: string, tz?: string, range?: string, metric?: 'tokens'|'usd'|'events'|'runs', limit?: number, role?: string, scope?: 'own'|'consolidated' }} [query]
 * @returns {Promise<{ ok: boolean, from?: string, to?: string, tz?: string, metric?: string, models?: object[], error?: string }>}
 */
export async function getUsageModels(query = {}) {
  const params = buildUsageQueryParams(query);
  const suffix = params.toString() ? `?${params}` : '';
  return dedupeGetJson(`/api/usage/models${suffix}`, 'getUsageModels', USAGE_READ_OPTIONS);
}

/**
 * Single filter-consistent stage-8 payload from GET /api/usage/insights:
 * disjoint token buckets, coverage, executed choices, acceptance signals and
 * cost provenance. The chart/table/CSV read their numbers from here.
 *
 * @param {{ from?: string, to?: string, tz?: string, range?: string, role?: string, harness?: string, origin?: 'auto'|'manual'|'unknown', scope?: 'own'|'consolidated', workspaceFile?: string, subject?: 'chat'|'delegation'|'internal', chatId?: string }} [query]
 * @returns {Promise<{ ok: boolean, from?: string, to?: string, tz?: string, window?: object, insights?: object, error?: string }>}
 */
export async function getUsageInsights(query = {}) {
  const params = buildUsageQueryParams(query);
  const suffix = params.toString() ? `?${params}` : '';
  return dedupeGetJson(`/api/usage/insights${suffix}`, 'getUsageInsights', USAGE_READ_OPTIONS);
}

/**
 * Local cache freshness / session generation of one chat (read-only; never
 * triggers a model request).
 *
 * @param {string} chatId
 * @returns {Promise<{ ok: boolean, freshness?: object, error?: string }>}
 */
export async function getUsageCacheFreshness(chatId) {
  const qs = new URLSearchParams({ chat_id: String(chatId || '') });
  return dedupeGetJson(`/api/usage/cache-freshness?${qs}`, `getUsageCacheFreshness:${chatId}`);
}

/**
 * Advice for resuming a chat whose prompt cache is likely cold (local read;
 * never triggers a model request).
 *
 * @param {string} chatId
 * @returns {Promise<{ ok: boolean, advice?: object, error?: string }>}
 */
export async function getUsageResumeAdvice(chatId) {
  const qs = new URLSearchParams({ chat_id: String(chatId || '') });
  return dedupeGetJson(`/api/usage/resume-advice?${qs}`, `getUsageResumeAdvice:${chatId}`);
}

/**
 * Keep-alive plans and the benchmark gate (local read; never pings).
 *
 * @returns {Promise<{ ok: boolean, plans?: object[], gate?: object, error?: string }>}
 */
export async function getUsageKeepAlive() {
  return dedupeGetJson('/api/usage/keep-alive', 'getUsageKeepAlive');
}

/**
 * Stops one keep-alive plan (terminal; never sends a request).
 *
 * @param {{ controllerChatId: string, delegationId: string }} input
 * @returns {Promise<{ ok: boolean, plan?: object, reason?: string }>}
 */
export async function stopUsageKeepAlive(input = {}) {
  return apiFetchJson('/api/usage/keep-alive', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'stop',
      controllerChatId: String(input.controllerChatId || ''),
      delegationId: String(input.delegationId || ''),
    }),
  }, 'stopUsageKeepAlive', { timeoutMs: 15000 });
}

/**
 * Top token consumers along one axis (fresh tokens, cache reads excluded).
 *
 * @param {object} [query] window/filter fields plus `groupBy`, `metric`, `limit`
 * @returns {Promise<{ ok: boolean, rows?: object[], totals?: object, error?: string }>}
 */
export async function getUsageTop(query = {}) {
  const params = buildUsageQueryParams(query);
  const suffix = params.toString() ? `?${params}` : '';
  return dedupeGetJson(`/api/usage/top${suffix}`, 'getUsageTop', USAGE_READ_OPTIONS);
}

/**
 * Chats that burned a harness's tokens in the look-back before each limit hit.
 *
 * @param {object} [query] window/filter fields plus `lookbackHours`, `limit`
 * @returns {Promise<{ ok: boolean, recent?: object[], culprits?: object[], error?: string }>}
 */
export async function getUsageLimitBurn(query = {}) {
  const params = buildUsageQueryParams(query);
  if (query.lookbackHours) params.set('lookbackHours', String(query.lookbackHours));
  const suffix = params.toString() ? `?${params}` : '';
  return dedupeGetJson(`/api/usage/limit-burn${suffix}`, 'getUsageLimitBurn', USAGE_READ_OPTIONS);
}

/**
 * Usage per delegation leaf and round for the same window/filters as insights.
 *
 * @param {object} [query]
 * @returns {Promise<{ ok: boolean, breakdown?: object, error?: string }>}
 */
export async function getUsageWorkflowBreakdown(query = {}) {
  const params = buildUsageQueryParams(query);
  const suffix = params.toString() ? `?${params}` : '';
  return dedupeGetJson(`/api/usage/workflow-breakdown${suffix}`, 'getUsageWorkflowBreakdown', USAGE_READ_OPTIONS);
}

/**
 * Review findings ledger of one todo leaf (scrubbed read model).
 *
 * @param {string} leafId
 * @param {{ workspaceFolder?: string }} [query]
 * @returns {Promise<{ ok: boolean, seq?: number, rejectReasons?: string[], findings?: object[], error?: string, code?: string }>}
 */
export async function getReviewFindings(leafId, query = {}) {
  const params = new URLSearchParams({ leafId: String(leafId || '') });
  if (query.workspaceFolder) params.set('workspaceFolder', String(query.workspaceFolder));
  return apiFetchJson(`/api/review-findings?${params}`, undefined, `getReviewFindings:${leafId}`);
}

/**
 * Human rejection of one finding. `expectedSeq` is the CAS token from the last read;
 * a 409 `CONFLICT` means the ledger moved and the caller must reload.
 *
 * @param {{ workspaceFolder?: string, leafId: string, key: string, reason: string, note?: string, expectedSeq?: number }} payload
 * @returns {Promise<{ ok: boolean, changed?: boolean, seq?: number, error?: string, code?: string }>}
 */
export async function postRejectReviewFinding(payload) {
  return apiFetchJson('/api/review-findings/reject', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  }, `postRejectReviewFinding:${payload?.key || ''}`);
}

/**
 * Model × role delegation outcomes from GET /api/delegations/stats.
 *
 * Same scope gate as the delegations list (workspace + widget installation):
 * the server never returns another installation's aggregate. Pass the active
 * workspace scope so the panel only aggregates chats of the workspace selected
 * in the header; an empty query falls back to the server's default.
 *
 * @param {{ workspaceFolder?: string, workspaceFile?: string }} [query]
 * @returns {Promise<{ ok: boolean, window_ms?: number, generated_at?: string, min_jobs?: number, roles?: object, list?: object[], unused_14d?: string[], unused_14d_error?: boolean, error?: string }>}
 */
export async function getDelegationStats(query = {}) {
  const params = new URLSearchParams();
  if (query.workspaceFolder) params.set('workspaceFolder', String(query.workspaceFolder));
  if (query.workspaceFile) params.set('workspaceFile', String(query.workspaceFile));
  const suffix = params.toString() ? `?${params}` : '';
  return dedupeGetJson(`/api/delegations/stats${suffix}`, 'getDelegationStats', USAGE_READ_OPTIONS);
}

/**
 * Per-harness health (runs, plan limits, lockouts) from GET /api/harnesses/health.
 * One call returns every catalog harness, keyed by id.
 *
 * `fresh: true` skips the URL-keyed dedupe: a forced card refresh after the
 * lockout-clear POST would otherwise re-attach to the identical in-flight GET
 * that started before the POST and commit its stale payload.
 *
 * @param {{ from?: string, to?: string, fresh?: boolean }} [query]
 * @returns {Promise<{ ok: boolean, from?: string, to?: string, harnesses?: Record<string, object>, error?: string }>}
 */
export async function getHarnessHealth(query = {}) {
  const params = new URLSearchParams();
  if (query.from) params.set('from', String(query.from));
  if (query.to) params.set('to', String(query.to));
  const suffix = params.toString() ? `?${params}` : '';
  const url = `/api/harnesses/health${suffix}`;
  // GETs already send cache: 'no-store', so a cache-buster query is not needed.
  if (query.fresh) return apiFetchJson(url, undefined, 'getHarnessHealth');
  return dedupeGetJson(url, 'getHarnessHealth');
}

/**
 * Read-only model diagnostics for Settings → Harness (GET /api/harness-diagnostics).
 *
 * The endpoint reproduces the picker for the current catalog snapshot and
 * returns eligibility, availability, stats and the candidate order. Opening the
 * panel starts no inference; the call only reads server-side catalogs and
 * aggregates.
 *
 * @param {{ role?: string, from?: string, to?: string, fresh?: boolean }} [query]
 * @returns {Promise<object>}
 */
export async function getHarnessDiagnostics(query = {}) {
  const params = new URLSearchParams();
  if (query.role) params.set('role', String(query.role));
  if (query.from) params.set('from', String(query.from));
  if (query.to) params.set('to', String(query.to));
  const suffix = params.toString() ? `?${params}` : '';
  const url = `/api/harness-diagnostics${suffix}`;
  if (query.fresh) return apiFetchJson(url, undefined, 'getHarnessDiagnostics');
  return dedupeGetJson(url, 'getHarnessDiagnostics');
}

/**
 * Audited model-role config for Settings → Harness. Returns the editable view,
 * the effective weights/rotation/adaptive values and the content ETag.
 *
 * @returns {Promise<object>}
 */
export async function getHarnessModelRoleConfig() {
  return dedupeGetJson('/api/harness-model-role-config', 'getHarnessModelRoleConfig');
}

/**
 * Preview a model-role delta without writing (`PUT ...?dryRun=1`).
 *
 * @param {object} delta
 * @returns {Promise<object>}
 */
export async function previewHarnessModelRoleConfig(delta) {
  return apiFetchJson('/api/harness-model-role-config?dryRun=1', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(delta || {}),
  }, 'previewHarnessModelRoleConfig');
}

/**
 * Write a model-role delta guarded by the current content ETag (`If-Match`).
 *
 * @param {object} delta
 * @param {string} etag
 * @returns {Promise<object>}
 */
export async function putHarnessModelRoleConfig(delta, etag) {
  return apiFetchJson('/api/harness-model-role-config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'If-Match': String(etag || '') },
    body: JSON.stringify(delta || {}),
  }, 'putHarnessModelRoleConfig');
}

/**
 * Back up and reset the operator model-role config to the built-in defaults.
 *
 * @param {string} [etag]
 * @returns {Promise<object>}
 */
export async function resetHarnessModelRoleConfig(etag) {
  const headers = etag ? { 'If-Match': String(etag) } : {};
  return apiFetchJson('/api/harness-model-role-config/reset', {
    method: 'POST',
    headers,
  }, 'resetHarnessModelRoleConfig');
}

/**
 * List the audited global model-selection overrides (Settings → Harness).
 *
 * @returns {Promise<object>}
 */
export async function getModelPickOverrides() {
  return dedupeGetJson('/api/harness-model-role-config/overrides', 'getModelPickOverrides');
}

/**
 * Create one audited global override, guarded by the store ETag.
 *
 * @param {object} override
 * @param {string} etag
 * @returns {Promise<object>}
 */
export async function putModelPickOverride(override, etag) {
  return apiFetchJson('/api/harness-model-role-config/overrides', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'If-Match': String(etag || '') },
    body: JSON.stringify(override || {}),
  }, 'putModelPickOverride');
}

/**
 * Revoke one audited global override.
 *
 * @param {string} id
 * @param {string} etag
 * @param {string} [reason]
 * @returns {Promise<object>}
 */
export async function revokeModelPickOverride(id, etag, reason = '') {
  return apiFetchJson('/api/harness-model-role-config/overrides/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(etag ? { 'If-Match': String(etag) } : {}) },
    body: JSON.stringify({ id, reason }),
  }, 'revokeModelPickOverride');
}

/**
 * Back up and reset the audited global overrides.
 *
 * @param {string} [etag]
 * @returns {Promise<object>}
 */
export async function resetModelPickOverrides(etag) {
  return apiFetchJson('/api/harness-model-role-config/overrides/reset', {
    method: 'POST',
    headers: etag ? { 'If-Match': String(etag) } : {},
  }, 'resetModelPickOverrides');
}

/**
 * Read-only benchmark source registry and local snapshot store (Settings → Harness).
 *
 * @returns {Promise<object>}
 */
export async function getHarnessBenchmarkSources() {
  return dedupeGetJson('/api/harness-benchmark-sources', 'getHarnessBenchmarkSources');
}

/**
 * Import a bounded local benchmark snapshot (no outbound fetch).
 *
 * @param {object} body
 * @param {string} etag
 * @returns {Promise<object>}
 */
export async function putHarnessBenchmarkImport(body, etag) {
  return apiFetchJson('/api/harness-benchmark-sources/import', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'If-Match': String(etag || '') },
    body: JSON.stringify(body || {}),
  }, 'putHarnessBenchmarkImport');
}

/**
 * List the audited workspace-scoped overrides for one folder.
 *
 * @param {string} workspaceFolder
 * @returns {Promise<object>}
 */
export async function getWorkspaceModelPickOverrides(workspaceFolder) {
  const query = new URLSearchParams({ workspaceFolder: String(workspaceFolder || '') });
  return dedupeGetJson(`/api/workspace-watcher/overrides?${query}`, 'getWorkspaceModelPickOverrides');
}

/**
 * Create one audited workspace override, guarded by the store ETag.
 *
 * @param {string} workspaceFolder
 * @param {object} override
 * @param {string} etag
 * @returns {Promise<object>}
 */
export async function putWorkspaceModelPickOverride(workspaceFolder, override, etag) {
  const query = new URLSearchParams({ workspaceFolder: String(workspaceFolder || '') });
  return apiFetchJson(`/api/workspace-watcher/overrides?${query}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'If-Match': String(etag || '') },
    body: JSON.stringify(override || {}),
  }, 'putWorkspaceModelPickOverride');
}

/**
 * Revoke one audited workspace override.
 *
 * @param {string} workspaceFolder
 * @param {string} id
 * @param {string} etag
 * @param {string} [reason]
 * @returns {Promise<object>}
 */
export async function revokeWorkspaceModelPickOverride(workspaceFolder, id, etag, reason = '') {
  const query = new URLSearchParams({ workspaceFolder: String(workspaceFolder || '') });
  return apiFetchJson(`/api/workspace-watcher/overrides/revoke?${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(etag ? { 'If-Match': String(etag) } : {}) },
    body: JSON.stringify({ id, reason }),
  }, 'revokeWorkspaceModelPickOverride');
}

/**
 * Manually clears a cached lockout for one harness (optionally one model).
 *
 * @param {string} harness
 * @param {{ model?: string }} [payload]
 * @returns {Promise<{ ok: boolean, harness?: string, model?: string|null, removed?: number, error?: string }>}
 */
export async function clearHarnessUsageLimit(harness, payload = {}) {
  const id = encodeURIComponent(String(harness || '').trim().toLowerCase());
  const model = payload?.model ? String(payload.model).trim() : '';
  return apiFetchJson(`/api/harnesses/${id}/usage-limit/clear`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(model ? { model } : {}),
  }, 'clearHarnessUsageLimit', { timeoutMs: 8000 });
}

/**
 * Marks an unrecognized provider-error signature as reviewed (ACK). `version` is the
 * occurrence counter the user saw; a newer occurrence makes the server answer 409.
 *
 * @param {{ id: string, version?: number }} payload
 * @returns {Promise<object>}
 */
export async function ackUnclassifiedError(payload) {
  return apiFetchJson('/api/usage/unclassified-errors/ack', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: String(payload.id || ''), ...(payload.version ? { version: payload.version } : {}) }),
  }, 'ackUnclassifiedError', { timeoutMs: 8000 });
}

/**
 * Read-only harness CLI/SDK version inventory (optional registry check).
 *
 * @param {{ check?: boolean, persist?: boolean }} [query]
 * @returns {Promise<object>}
 */
export async function getHarnessVersions(query = {}) {
  const params = new URLSearchParams();
  if (query.persist === false) params.set('persist', '0');
  if (query.check) params.set('check', '1');
  const suffix = params.toString() ? `?${params.toString()}` : '';
  return apiFetchJson(`/api/harness/versions${suffix}`, undefined, 'getHarnessVersions');
}

/**
 * Install the newer upstream versions of one harness's packages.
 *
 * @param {string} harness
 * @returns {Promise<object>}
 */
export async function updateHarnessPackages(harness) {
  return apiFetchJson('/api/harness/packages/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ harness: String(harness || '').trim().toLowerCase() }),
  }, 'updateHarnessPackages', { timeoutMs: 660000 });
}

/** Install the optional Mistral SDK in the Cretli project. */
export async function installMistralSdk() {
  return apiFetchJson('/api/harness/mistral/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  }, 'installMistralSdk', { timeoutMs: 180000 });
}

/** Install the official Z.AI Python SDK into Cretli's managed virtual environment. */
export async function installZaiSdk() {
  return apiFetchJson('/api/harness/zai/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  }, 'installZaiSdk', { timeoutMs: 180000 });
}

/**
 * Explicit model catalog refresh for one harness (Settings action).
 *
 * @param {string} harness
 * @returns {Promise<object>}
 */
export async function refreshHarnessModelsCatalog(harness) {
  const id = String(harness || '').trim().toLowerCase();
  return apiFetchJson('/api/harness/models/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ harness: id }),
  }, 'refreshHarnessModelsCatalog', { timeoutMs: 120000 });
}

/**
 * Mints an ephemeral Realtime token. Instructions and tools are pinned on the
 * server, so this call carries only preferences.
 *
 * @param {{ lang?: string, voice?: string, model?: string, sessionId?: string }} [payload]
 * @returns {Promise<{ ok: boolean, clientSecret?: string, model?: string, voice?: string, expiresAt?: number, error?: string }>}
 */
import { fileToOptimizedBase64 } from './voice.js';
// TypeScript checks the legacy API contract separately; this split preserves its runtime implementation.
// @ts-nocheck
