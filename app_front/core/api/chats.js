// @ts-nocheck
// This module preserves the existing API implementation during the structural split.
import { crHeaders, isApiDebugEnabled, getDebugSinceAppStartMs, formatDebugOffset, debugApiLog, rememberRestoreGeneration, isRestoreGenerationRejection, retryAfterRestoreGenerationRefresh, dedupeGetJson, withResolvedViewContextRuntimeQuery, cloneCached, json, redirectLogin, apiFetchJson, API_DEBUG_FLAG_LS_KEY, STARTUP_GET_TTL_MS, GIT_INFO_TTL_MS, startupGetCache, startupGetInFlight, startupGetEpoch, inFlightGetRequests, restoreGeneration, appLogger, getCurrentLang, readStorageValueWithAlias, applyChatAuthSessionBoundary, clearPushInboxCache, scopeTodoPayload, todoWorkspaceQuery, VIEW_CONTEXT_STATUS, hasExplicitWorkspace, viewContextRuntimeParams, getViewContextState, isViewContextScopedAccessAllowed, withViewContextQuery, sharedState, isWorkspaceWatcherRetryableBlockedTodo, applyCsrfFromAuthPayload, buildCretliApiHeaders, cretliApiFetch, getCsrfToken, getWidgetAccessToken, onCretliApiWrite, setCsrfToken, setWidgetAccessToken, buildChatIdsQuery, chunkExplicitChatIds, fitsChatIdsQuery, MAX_CHAT_REVISIONS_FETCH_PARTS, normalizeExplicitChatIds } from './runtime.js';
import { invalidateStartupGetCache, sharedStartupGet, getWorkspace, getWorkspaceContext, getSettings, getApprovalAuditSummary, getSidebarLayout, patchSidebarLayout, patchSettings, patchSettingsLanHost, getBrowserPolicy, patchBrowserPolicy, buildApprovalSettingsPatch, patchApprovalBrokerSettings, getLanUrl, logout, getAuthStatus, getTerminalSession, getTaskRuns, getTasks, deleteTaskRun, getAgentRuns, getAgents, getAgentsSchedule, patchAgentsSchedule, getWorkspaces, writeWorkspaceFileFolders, convertWorkspaceFileToSelf, exportWorkspaceToFile, getFsEntries, createFsFolder, getStatusFlowScenariosFixture, getFilesEntries, getFileContent, invalidateTodoListCache, getTodos, getTodo, getTodoHistory, postTodo, patchTodo, deferTodo, restoreDeferredTodo, restoreTodoToTree, recoverWorkspaceWatcherTodo, releaseDoingWorkspaceWatcherTodo, retryWorkspaceWatcherTodo, integrateTodo, smartMergeTodo, verifyIntegrationTodo, integrateTodosBatch, getIntegrateBatch, cancelIntegrateBatch, resumeIntegrateBatch, abandonIntegrateBatch, clearIntegrationLock, listWorktrees, getWorktreeDiff, getWorktreeMergePreview, startWorktreeMerge, rejectWorktree, cleanupWorktree, deleteTodo, postTodoStartAgent, getTodoStartAgentStatus, getCursorContext, getGitInfo, getGitBranches, getGitFileDiff, postGitAction, getGithubInfo, getGithubWorkflowRuns, getGithubWorkflowRunJobs, getGithubWorkflowJobLogs, getUpdateStatus, postUpdateApply, postDevAction, getServerHealth, getServerDiagnosticsSummary, listWidgetInstallations, createWidgetInstallation, updateWidgetInstallation, deleteWidgetInstallation, uploadScreenshot, requestSpeech, requestTranscription, postUsageEvent, getCreditLedger, getCreditLedgerForecast, getCreditLedgerHarnessLinks, mutateCreditLedger, getCreditSubscriptions, mutateCreditSubscriptions, getDeepSeekBalanceStatus, refreshDeepSeekBalanceReading, getUsagePlanLimits, getUsageSettings, saveUsageSettings, getUsageLimitResumeSettings, saveUsageLimitResumeSettings, getUsageLimitResumeItems, cancelUsageLimitResume, getUsageSummary, getUsageTimeseries, getUsageModels, getUsageInsights, getUsageCacheFreshness, getUsageResumeAdvice, getUsageKeepAlive, stopUsageKeepAlive, getUsageTop, getUsageLimitBurn, getUsageWorkflowBreakdown, getReviewFindings, postRejectReviewFinding, getDelegationStats, getHarnessHealth, getHarnessDiagnostics, getHarnessModelRoleConfig, previewHarnessModelRoleConfig, putHarnessModelRoleConfig, resetHarnessModelRoleConfig, getModelPickOverrides, putModelPickOverride, revokeModelPickOverride, resetModelPickOverrides, getHarnessBenchmarkSources, putHarnessBenchmarkImport, getWorkspaceModelPickOverrides, putWorkspaceModelPickOverride, revokeWorkspaceModelPickOverride, clearHarnessUsageLimit, ackUnclassifiedError, getHarnessVersions, updateHarnessPackages, installMistralSdk, installZaiSdk, refreshHarnessModelsCatalog, requestRealtimeToken, probeGeminiApiKey, requestGeminiLiveToken, appendVoiceSessionEvents, fetchVoiceSessionLog, listVoiceSessionLogs, updateHarnessBenchmarkSource, getPermissionGrants, revokePermissionGrants, getWakeups, getWakeupKinds, getWakeupStatus, saveWakeupKindSettings, cancelWakeup, runWakeupNow } from './index.js';
export async function getChats(query = {}) {
  const params = new URLSearchParams();
  if (typeof query.pinnedTo === 'string' && query.pinnedTo.trim()) {
    params.set('pinnedTo', query.pinnedTo.trim());
  }
  if (query.includeArchived === true) {
    params.set('includeArchived', '1');
  }
  if (typeof query.archiveWorkspace === 'string' && query.archiveWorkspace.trim()) {
    params.set('archiveWorkspace', query.archiveWorkspace.trim());
  }
  if (query.includeSummaries === true) {
    params.set('includeSummaries', '1');
  }
  const qs = params.toString();
  const basePath = qs ? `/api/chats?${qs}` : '/api/chats';
  const path = withResolvedViewContextRuntimeQuery(basePath);
  const data = await dedupeGetJson(path, path.includes('?') ? `getChats:${path.slice(path.indexOf('?') + 1)}` : 'getChats');
  // Only the plain list feeds the shared signal; filtered views (archive, pinned) are not the shared list.
  if (!qs) sharedState.publishChats(data);
  return data;
}

/**
 * @param {object | null | undefined} body
 * @returns {object}
 */
function unwrapChatListSyncBody(body) {
  if (body && body.ok !== false) return body;
  const code = body && typeof body.code === 'string' ? body.code : '';
  const status = code === 'STALE_CURSOR' ? 409 : code === 'INVALID_ARGUMENT' ? 400 : 500;
  throw Object.assign(new Error((body && body.error) || 'Chat list sync failed'), { status, code });
}

/**
 * Delta since a sync position (`<epoch>.<seq>`); an empty `since` asks the server to answer
 * `mode: 'resync'`. Contract: docs/architecture-list-sync-contract.md.
 *
 * @param {string} since
 * @returns {Promise<object>}
 */
export async function getChatListSync(since) {
  const qs = since ? `?since=${encodeURIComponent(since)}` : '';
  const path = withResolvedViewContextRuntimeQuery(`/api/chats/sync${qs}`);
  return unwrapChatListSyncBody(await dedupeGetJson(path, 'getChatListSync'));
}

/**
 * One bounded page of lightweight list DTOs (resync walk).
 *
 * @param {{ cursor?: string, limit?: number, archived?: 'include' | 'exclude' | 'only' | 'tree' }} [query]
 * @returns {Promise<object>}
 */
export async function getChatListPage(query = {}) {
  const params = new URLSearchParams({ view: 'list', archived: query.archived || 'tree' });
  if (query.limit) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  const path = withResolvedViewContextRuntimeQuery(`/api/chats/page?${params.toString()}`);
  return unwrapChatListSyncBody(await dedupeGetJson(path, 'getChatListPage'));
}

/**
 * Message history of an SDK agent (Cursor Cloud). Returns `formatted` (plain text for the terminal buffer)
 * and `messages` (from Agent.messages.list) used to rebuild the rich HTML view.
 *
 * @param {string} id - chat id (uuid)
 * @param {{ limit?: number, offset?: number }} [query]
 */
export async function getChatSdkMessages(id, query = {}) {
  const q = new URLSearchParams();
  if (query.limit != null) q.set('limit', String(query.limit));
  if (query.offset != null) q.set('offset', String(query.offset));
  const qs = q.toString();
  const path = `/api/chats/${encodeURIComponent(id)}/sdk-messages${qs ? `?${qs}` : ''}`;
  return apiFetchJson(path, undefined, 'getChatSdkMessages');
}

/**
 * Pulls the history log from the server (append-only, ordered by seq).
 * `since`/`limit` walk forward (delta sync); `tail`/`before` page backwards (window rendering).
 *
 * @param {string} id
 * @param {{ since?: number, limit?: number, tail?: number, before?: number }} [query]
 */
export async function getChatHistory(id, query = {}) {
  const q = new URLSearchParams();
  if (query.since != null) q.set('since', String(query.since));
  if (query.limit != null) q.set('limit', String(query.limit));
  if (query.tail != null) q.set('tail', String(query.tail));
  if (query.before != null) q.set('before', String(query.before));
  const qs = q.toString();
  const path = `/api/chats/${encodeURIComponent(id)}/history${qs ? `?${qs}` : ''}`;
  return dedupeGetJson(path, 'getChatHistory');
}

/**
 * POST explicit revision index slice (widget scoped on server).
 * @param {string[]} ids
 */
export async function postChatHistoryRevisionsBatch(ids) {
  const normalized = normalizeExplicitChatIds(ids);
  return apiFetchJson('/api/chats/history-revisions-batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: normalized }),
  }, 'postChatHistoryRevisionsBatch');
}

/**
 * @param {string[]} ids
 * @returns {Promise<{ ok?: boolean, revisions?: Record<string, unknown> }>}
 */
async function fetchChatHistoryRevisionsPart(ids) {
  const normalized = normalizeExplicitChatIds(ids);
  if (normalized.length === 0) {
    return apiFetchJson('/api/chats/history-revisions', undefined, 'getChatHistoryRevisions');
  }
  if (fitsChatIdsQuery(normalized)) {
    const qs = buildChatIdsQuery(normalized);
    const path = `/api/chats/history-revisions${qs ? `?${qs}` : ''}`;
    return apiFetchJson(path, undefined, 'getChatHistoryRevisions');
  }
  return postChatHistoryRevisionsBatch(normalized);
}

/**
 * Lightweight server-side history revision index for cross-device pull sync.
 * Empty `chatIds` omits `ids` (all allowed chats, widget scoped). A non-empty list
 * is always scoped to those ids via GET chunks and/or POST batch — never widened
 * to the full allowlist when the query string would overflow.
 * @param {string[]} [chatIds]
 */
export async function getChatHistoryRevisions(chatIds = []) {
  const normalized = normalizeExplicitChatIds(chatIds);
  if (normalized.length === 0) {
    return fetchChatHistoryRevisionsPart([]);
  }
  const chunks = chunkExplicitChatIds(normalized);
  if (chunks.length > MAX_CHAT_REVISIONS_FETCH_PARTS) {
    return { ok: false, revisions: {}, error: 'too_many_revision_parts' };
  }
  /** @type {Record<string, unknown>} */
  const revisions = {};
  let ok = true;
  for (const chunk of chunks) {
    const response = await fetchChatHistoryRevisionsPart(chunk);
    if (!response?.ok) {
      ok = false;
      continue;
    }
    if (response.revisions && typeof response.revisions === 'object') {
      Object.assign(revisions, response.revisions);
    }
  }
  return { ok, revisions };
}

/**
 * Lightweight per-chat agent presence (busy / waiting / attention; idle omitted).
 * Omits `ids` when the list is empty or too long (server returns all allowed chats).
 * @param {string[]} [chatIds]
 */
export async function getChatAgentStates(chatIds = []) {
  const normalized = normalizeExplicitChatIds(chatIds);
  const qs = normalized.length === 0 ? '' : buildChatIdsQuery(normalized);
  const path = qs === null
    ? '/api/chats/agent-states'
    : `/api/chats/agent-states${qs ? `?${qs}` : ''}`;
  return apiFetchJson(path, undefined, 'getChatAgentStates');
}

/**
 * Disposes the in-memory SDK room for a chat (does not delete chat metadata).
 * @param {string} id
 */
export async function disposeSdkChatRoom(id) {
  return apiFetchJson(
    `/api/chats/${encodeURIComponent(id)}/dispose-sdk-room`,
    { method: 'POST' },
    'disposeSdkChatRoom'
  );
}

/**
 * Pushes a batch of events into the server-side history log.
 * @param {string} id
 * @param {string} cursorSessionId
 * @param {Array<{ rec: unknown, clientSeq?: number }>} events
 */
export async function postChatHistory(id, cursorSessionId, events, queue = {}) {
  return retryAfterRestoreGenerationRefresh(() => apiFetchJson(`/api/chats/${encodeURIComponent(id)}/history`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cursorSessionId: cursorSessionId || '',
      events: Array.isArray(events) ? events : [],
      // Queue identity: the producer namespaces clientSeq, chatEpoch pins the history generation the queue was built
      // against, retryToken re-drives an uncertain earlier attempt of the SAME events.
      ...(queue.queueProducerId ? { queueProducerId: queue.queueProducerId } : {}),
      ...(queue.datasetGeneration ? { datasetGeneration: queue.datasetGeneration } : {}),
      ...(restoreGeneration || queue.restoreGeneration ? { restoreGeneration: restoreGeneration || queue.restoreGeneration } : {}),
      ...(queue.chatEpoch ? { chatEpoch: queue.chatEpoch } : {}),
      ...(queue.retryToken ? { retryToken: queue.retryToken } : {}),
    }),
  }, 'postChatHistory'));
}

/**
 * Pull history deltas for an explicit chat list. Missing/empty chats is an error
 * (never "every chat").
 *
 * @param {Array<{ id: string, since?: number, limit?: number }>} chats
 */
export async function postChatHistoryBatch(chats) {
  return apiFetchJson('/api/chats/history-batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chats: Array.isArray(chats) ? chats : [] }),
  }, 'postChatHistoryBatch');
}

/** SDK chat readiness; ready means the server has a CURSOR_API_KEY configured. */
export async function getAgentSdkStatus() {
  // Several startup consumers (chat, model settings, Todo panel) ask within the same second.
  return sharedStartupGet('/api/agent-sdk', () => dedupeGetJson('/api/agent-sdk', 'getAgentSdkStatus'));
}

const OPENCODE_API_TIMEOUT_MS = 120000;

/** OpenCode harness status. */
export async function getOpenCodeStatus(params = {}) {
  const query = params.workspaceFolder
    ? `?workspaceFolder=${encodeURIComponent(params.workspaceFolder)}`
    : '';
  return dedupeGetJson(`/api/opencode/status${query}`, 'getOpenCodeStatus', {
    timeoutMs: OPENCODE_API_TIMEOUT_MS,
  });
}

/** OpenCode model catalog. */
export async function getOpenCodeModels(params = {}) {
  const query = params.workspaceFolder
    ? `?workspaceFolder=${encodeURIComponent(params.workspaceFolder)}`
    : '';
  return dedupeGetJson(`/api/opencode/models${query}`, 'getOpenCodeModels', {
    timeoutMs: OPENCODE_API_TIMEOUT_MS,
  });
}

/** OpenRouter harness status (API key configured). */
export async function getOpenRouterStatus() {
  return dedupeGetJson('/api/openrouter/status', 'getOpenRouterStatus');
}

/** OpenRouter model catalog. */
export async function getOpenRouterModels() {
  return dedupeGetJson('/api/openrouter/models', 'getOpenRouterModels');
}

/** CodeBuddy harness status (SDK + CLI + API key). */
export async function getCodeBuddyStatus() {
  return dedupeGetJson('/api/codebuddy/status', 'getCodeBuddyStatus');
}

const CODEBUDDY_API_TIMEOUT_MS = 45000;

/** CodeBuddy model catalog (Tencent CLI / account). */
export async function getCodeBuddyModels(params = {}) {
  const refresh = params.refresh === true || params.refresh === '1';
  const query = refresh ? '?refresh=1' : '';
  return dedupeGetJson(`/api/codebuddy/models${query}`, 'getCodeBuddyModels', {
    timeoutMs: CODEBUDDY_API_TIMEOUT_MS,
  });
}

/** Mistral Harness status (SDK + API key). */
export async function getMistralStatus() {
  return dedupeGetJson('/api/mistral/status', 'getMistralStatus');
}

/** Mistral Harness model catalog. */
export async function getMistralModels() {
  return dedupeGetJson('/api/mistral/models', 'getMistralModels');
}

export async function getZaiStatus() {
  return dedupeGetJson('/api/zai/status', 'getZaiStatus');
}

export async function getZaiModels() {
  return dedupeGetJson('/api/zai/models', 'getZaiModels');
}

export async function getMimoStatus() {
  return dedupeGetJson('/api/mimo/status', 'getMimoStatus');
}

export async function getMimoModels() {
  return dedupeGetJson('/api/mimo/models', 'getMimoModels');
}

/** DeepSeek Harness status (SDK + CLI + API key). */
export async function getDeepSeekStatus() {
  return dedupeGetJson('/api/deepseek/status', 'getDeepSeekStatus');
}

/** DeepSeek Harness model catalog. */
export async function getDeepSeekModels() {
  return dedupeGetJson('/api/deepseek/models', 'getDeepSeekModels');
}

/** Qwen Code status (SDK + Qwen Cloud API key). CLI is optional (bundled). */
export async function getQwenStatus() {
  return dedupeGetJson('/api/qwen/status', 'getQwenStatus');
}

/** Qwen Code model catalog. */
export async function getQwenModels() {
  return dedupeGetJson('/api/qwen/models', 'getQwenModels');
}

/** Claude Agent SDK status (SDK + Anthropic API key). */
export async function getClaudeStatus() {
  return dedupeGetJson('/api/claude/status', 'getClaudeStatus');
}

/** Claude Agent SDK model catalog. */
export async function getClaudeModels() {
  return dedupeGetJson('/api/claude/models', 'getClaudeModels');
}

export async function startClaudePlanLogin() {
  return apiFetchJson('/api/claude/login/start', { method: 'POST' }, 'startClaudePlanLogin');
}

export async function completeClaudePlanLogin(code) {
  return apiFetchJson('/api/claude/login/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  }, 'completeClaudePlanLogin');
}

export async function cancelClaudePlanLogin() {
  return apiFetchJson('/api/claude/login/cancel', { method: 'POST' }, 'cancelClaudePlanLogin');
}

/** Claude plan quotas; the chat id lets the server use that chat's live session. */
export async function getClaudePlanLimits(chatId = '') {
  const query = chatId ? `?chatId=${encodeURIComponent(chatId)}` : '';
  return dedupeGetJson(`/api/claude/plan-limits${query}`, 'getClaudePlanLimits', { timeoutMs: 12000 });
}

/** Per-chat context and cache time series with detected cache breaks (any harness). */
export async function getContextCacheSeries(chatId) {
  return dedupeGetJson(`/api/usage/context-cache-series?chatId=${encodeURIComponent(chatId)}`, 'getContextCacheSeries');
}

/** Account plan quotas, read without starting an inference turn. */
export async function getCodexPlanLimits() {
  return dedupeGetJson('/api/codex/plan-limits', 'getCodexPlanLimits', { timeoutMs: 12000 });
}

/** Codex SDK status (SDK + CLI + ChatGPT session or API key). */
export async function getCodexStatus() {
  return dedupeGetJson('/api/codex/status', 'getCodexStatus');
}

const CODEX_API_TIMEOUT_MS = 45000;

/** Codex SDK model catalog. */
export async function getCodexModels(params = {}) {
  const refresh = params.refresh === true || params.refresh === '1';
  const query = refresh ? '?refresh=1' : '';
  return dedupeGetJson(`/api/codex/models${query}`, refresh ? 'getCodexModelsRefresh' : 'getCodexModels', {
    timeoutMs: refresh ? CODEX_API_TIMEOUT_MS : undefined,
  });
}

export async function startCodexLogin() {
  return apiFetchJson('/api/codex/login/start', { method: 'POST' }, 'startCodexLogin');
}

export async function getCodexLoginStatus() {
  return apiFetchJson('/api/codex/login/status', undefined, 'getCodexLoginStatus');
}

export async function cancelCodexLogin() {
  return apiFetchJson('/api/codex/login/cancel', { method: 'POST' }, 'cancelCodexLogin');
}

export async function logoutCodex() {
  return apiFetchJson('/api/codex/logout', { method: 'POST' }, 'logoutCodex');
}

/** Live task worktrees of a workspace folder (new-chat picker). */
export async function getWorktrees(workspaceFolder) {
  const folder = String(workspaceFolder || '').trim();
  if (!folder) {
    if (!isViewContextScopedAccessAllowed()) return blockedGitScopeResult();
    return { ok: false, code: 'workspace-folder-required' };
  }
  const params = new URLSearchParams({ workspaceFolder: folder });
  return apiFetchJson(`/api/worktrees?${params.toString()}`, {}, 'getWorktrees');
}

export async function postChat(payload) {
  return apiFetchJson('/api/chats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  }, 'postChat');
}

export async function postChatFork(id, payload) {
  if (!id) return { ok: false, error: 'Missing source chat id' };
  return apiFetchJson(`/api/chats/${encodeURIComponent(id)}/fork`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  }, 'postChatFork');
}

export async function postChatForkWithSummary(id, payload) {
  if (!id) return { ok: false, error: 'Missing source chat id' };
  return apiFetchJson(`/api/chats/${encodeURIComponent(id)}/fork-with-summary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  }, 'postChatForkWithSummary');
}

export async function getChatPlan(id) {
  if (!id) return { ok: false, error: 'Missing chat id' };
  return apiFetchJson(`/api/chats/${encodeURIComponent(id)}/plan`, undefined, `getChatPlan:${id}`);
}

export async function getDelegationExecutors() {
  return apiFetchJson('/api/delegations/executors', undefined, 'getDelegationExecutors');
}

export async function getHarnessCatalog() {
  return dedupeGetJson('/api/harness-catalog/harnesses', 'getHarnessCatalog');
}

/** Mint a single-use action before submitting a direct human executor selection. */
export async function postManualChatDelegation(id, payload) {
  const action = await apiFetchJson(`/api/chats/${encodeURIComponent(id)}/delegation-ui-actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, role: payload.requestedRole || payload.requested_role || payload.assignment || 'implement' }),
  }, `mintChatDelegationAction:${id}`);
  if (!action?.ok) return action;
  return postChatDelegation(id, { ...payload, uiActionId: action.uiActionId });
}

export async function postChatDelegation(id, payload) {
  if (!id) return { ok: false, error: 'Missing chat id' };
  return apiFetchJson(`/api/chats/${encodeURIComponent(id)}/delegations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  }, `postChatDelegation:${id}`);
}

export async function getChatRecoveryRuns(id) {
  if (!id) return { ok: false, error: 'Missing chat id' };
  return apiFetchJson(`/api/chats/${encodeURIComponent(id)}/recovery-runs`, undefined, `getChatRecoveryRuns:${id}`);
}

/**
 * Manual resume of an interrupted run. `run` is a recovery view from
 * `getChatRecoveryRuns`; its state/revision form the CAS token.
 */
export async function postRecoveryResume(chatId, run, confirmUnknown = false) {
  if (!chatId || !run?.logicalRunId) return { ok: false, error: 'Missing run id' };
  return apiFetchJson(
    `/api/chats/${encodeURIComponent(chatId)}/runs/${encodeURIComponent(run.logicalRunId)}/resume`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedState: run.state,
        expectedRevision: run.revision,
        idempotencyKey: `resume:${run.logicalRunId}:${run.revision}`,
        confirmUnknown: confirmUnknown === true,
      }),
    },
    `postRecoveryResume:${run.logicalRunId}`
  );
}

export async function postRecoveryKeepStopped(chatId, run) {
  if (!chatId || !run?.logicalRunId) return { ok: false, error: 'Missing run id' };
  return apiFetchJson(
    `/api/chats/${encodeURIComponent(chatId)}/runs/${encodeURIComponent(run.logicalRunId)}/keep-stopped`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: run.revision }),
    },
    `postRecoveryKeepStopped:${run.logicalRunId}`
  );
}

export async function getChatDelegations(id) {
  if (!id) return { ok: false, error: 'Missing chat id' };
  return apiFetchJson(`/api/chats/${encodeURIComponent(id)}/delegations`, undefined, `getChatDelegations:${id}`);
}

export async function getDelegation(id) {
  if (!id) return { ok: false, error: 'Missing delegation id' };
  return apiFetchJson(`/api/delegations/${encodeURIComponent(id)}`, undefined, `getDelegation:${id}`);
}

export async function getDelegationRuntime(query = {}) {
  const params = new URLSearchParams();
  if (query.workspaceFolder) params.set('workspaceFolder', String(query.workspaceFolder));
  if (query.workspaceFile) params.set('workspaceFile', String(query.workspaceFile));
  const suffix = params.toString() ? `?${params}` : '';
  return apiFetchJson(`/api/delegations/runtime${suffix}`, undefined, 'getDelegationRuntime');
}

export async function getWorkspaceDelegations(query = {}) {
  const params = new URLSearchParams();
  if (query.attention) params.set('attention', String(query.attention));
  if (query.status) params.set('status', String(query.status));
  if (query.cursor) params.set('cursor', String(query.cursor));
  if (query.limit) params.set('limit', String(query.limit));
  if (query.workspaceFolder) params.set('workspaceFolder', String(query.workspaceFolder));
  if (query.workspaceFile) params.set('workspaceFile', String(query.workspaceFile));
  const suffix = params.toString() ? `?${params}` : '';
  return apiFetchJson(`/api/delegations${suffix}`, undefined, 'getWorkspaceDelegations');
}

export async function getDelegationTree(chatId, query = {}) {
  if (!chatId) return { ok: false, error: 'Missing chat id' };
  const params = new URLSearchParams();
  if (query.rootDelegationId) params.set('rootDelegationId', String(query.rootDelegationId));
  if (query.status) params.set('status', String(query.status));
  if (query.cursor) params.set('cursor', String(query.cursor));
  if (query.limit) params.set('limit', String(query.limit));
  if (query.workspaceFolder) params.set('workspaceFolder', String(query.workspaceFolder));
  if (query.workspaceFile) params.set('workspaceFile', String(query.workspaceFile));
  const suffix = params.toString() ? `?${params}` : '';
  return apiFetchJson(
    `/api/chats/${encodeURIComponent(chatId)}/delegation-tree${suffix}`,
    undefined,
    `getDelegationTree:${chatId}`,
  );
}

export async function postDelegationRetryDelivery(id, payload = {}) {
  if (!id) return { ok: false, error: 'Missing delegation id' };
  return apiFetchJson(`/api/delegations/${encodeURIComponent(id)}/retry-delivery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  }, `postDelegationRetryDelivery:${id}`);
}

export async function postDelegationCancel(id, { tree = false } = {}) {
  if (!id) return { ok: false, error: 'Missing delegation id' };
  const init = { method: 'POST' };
  if (tree === true) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify({ tree: true });
  }
  return apiFetchJson(`/api/delegations/${encodeURIComponent(id)}/cancel`, init, `postDelegationCancel:${id}${tree ? ':tree' : ''}`);
}

/**
 * Marks the chat's latest finished run as read (sidebar check turns grey).
 *
 * @param {string} chatId
 * @returns {Promise<object>}
 */
export async function postChatSeen(chatId) {
  if (!chatId) return { ok: false, error: 'Missing chat id' };
  return apiFetchJson(`/api/chats/${encodeURIComponent(chatId)}/seen`, {
    method: 'POST',
  }, `postChatSeen:${chatId}`);
}

export async function postDelegationAck(id, payload = {}) {
  if (!id) return { ok: false, error: 'Missing delegation id' };
  return apiFetchJson(`/api/delegations/${encodeURIComponent(id)}/ack`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  }, `postDelegationAck:${id}`);
}

/**
 * Accept context the card echoes back: the current attempt and material
 * revision of a delegation (`docs/todo-review-contract.md` §7.3).
 */
export async function getDelegationAcceptContext(id) {
  if (!id) return { ok: false, error: 'Missing delegation id' };
  return apiFetchJson(
    `/api/delegations/${encodeURIComponent(id)}?field=accept`,
    undefined,
    `getDelegationAcceptContext:${id}`,
  );
}

/**
 * Honest state of the "open the delegation report" link, resolved on demand
 * (`docs/todo-review-contract.md` §11.3).
 */
export async function getDelegationReportLink(id) {
  if (!id) return { ok: false, error: 'Missing delegation id' };
  return apiFetchJson(
    `/api/delegations/${encodeURIComponent(id)}?field=report-link`,
    undefined,
    `getDelegationReportLink:${id}`,
  );
}

/**
 * Explicit human acceptance from the delegation card. The server derives the
 * actor from the channel and rejects a stale attempt/material with 409.
 */
export async function postDelegationAccept(id, payload = {}) {
  if (!id) return { ok: false, error: 'Missing delegation id' };
  return apiFetchJson(`/api/delegations/${encodeURIComponent(id)}/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  }, `postDelegationAccept:${id}`);
}

export async function postChatMailboxReply(id, payload) {
  if (!id) return { ok: false, error: 'Missing chat id' };
  return apiFetchJson(`/api/chats/${encodeURIComponent(id)}/mailbox/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  }, `postChatMailboxReply:${id}`);
}

export async function postChatMailboxRetry(chatId, messageId) {
  if (!chatId || !messageId) return { ok: false, error: 'Missing mailbox id' };
  return apiFetchJson(
    `/api/chats/${encodeURIComponent(chatId)}/mailbox/${encodeURIComponent(messageId)}/retry`,
    { method: 'POST' },
    `postChatMailboxRetry:${chatId}:${messageId}`,
  );
}

export async function postDelegationRetry(id) {
  if (!id) return { ok: false, error: 'Missing delegation id' };
  return apiFetchJson(`/api/delegations/${encodeURIComponent(id)}/retry`, {
    method: 'POST',
  }, `postDelegationRetry:${id}`);
}

export async function patchChat(id, data) {
  if (!id) return { ok: false, error: 'Missing chat id' };
  return apiFetchJson(`/api/chats/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data || {}),
  }, `patchChat:${id}`);
}

export async function getChatTitleHistory(id) {
  if (!id) return { ok: false, error: 'Missing chat id' };
  return apiFetchJson(`/api/chats/${encodeURIComponent(id)}/title-history`, {}, `getChatTitleHistory:${id}`);
}

export async function regenerateChatTitle(id) {
  if (!id) return { ok: false, error: 'Missing chat id' };
  return apiFetchJson(`/api/chats/${encodeURIComponent(id)}/regenerate-title`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  }, `regenerateChatTitle:${id}`, { timeoutMs: 45000 });
}

export async function setChatTitleLock(id, locked) {
  if (!id) return { ok: false, error: 'Missing chat id' };
  return apiFetchJson(`/api/chats/${encodeURIComponent(id)}/title-lock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locked: locked === true }),
  }, `setChatTitleLock:${id}`);
}

export async function archiveChat(id, archived) {
  if (!id) return { ok: false, error: 'Missing chat id' };
  return patchChat(id, { archived: archived === true });
}

export async function deleteChat(id) {
  if (!id) return { ok: false, error: 'Missing chat id' };
  return retryAfterRestoreGenerationRefresh(() => apiFetchJson(`/api/chats/${encodeURIComponent(id)}${restoreGeneration ? `?restoreGeneration=${encodeURIComponent(restoreGeneration)}` : ''}`, {
    method: 'DELETE',
  }, `deleteChat:${id}`));
}

/** Delete only the persisted history for a chat. */
export async function deleteChatHistory(id, retryToken = '') {
  if (!id) return { ok: false, error: 'Missing chat id' };
  return retryAfterRestoreGenerationRefresh(() => {
    const query = new URLSearchParams();
    if (retryToken) query.set('retryToken', String(retryToken));
    if (restoreGeneration) query.set('restoreGeneration', restoreGeneration);
    const qs = query.toString();
    return apiFetchJson(`/api/chats/${encodeURIComponent(id)}/history${qs ? `?${qs}` : ''}`, { method: 'DELETE' }, `deleteChatHistory:${id}`);
  });
}

/** Sync latest plan from chat history into linked Todo. */
export async function postChatSyncTodoPlan(id, payload = {}) {
  if (!id) return { ok: false, error: 'Missing chat id' };
  return apiFetchJson(
    `/api/chats/${encodeURIComponent(id)}/sync-todo-plan`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    },
    `postChatSyncTodoPlan:${id}`
  );
}

/** Diagnostic chat snapshot: state of the server-side SDK room. */
export async function getChatDiag(id) {
  return cretliApiFetch(`/api/chats/${encodeURIComponent(id)}/diag`, {}, { acceptLanguage: getCurrentLang() }).then(json);
}

/** SDK probe: resume vs fresh agent, context stats, recommendation. */
export async function postSdkChatProbe(id, body = {}) {
  if (!id) return { ok: false, error: 'Missing chat id' };
  return apiFetchJson(
    `/api/chats/${encodeURIComponent(id)}/sdk-probe`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    },
    'postSdkChatProbe'
  );
}

/** Resets the SDK agent context for the given chat without deleting its history. */
export async function postChatResetSdkContext(id, options = {}) {
  if (!id) return { ok: false, error: 'Missing chat id' };
  return apiFetchJson(
    `/api/chats/${encodeURIComponent(id)}/reset-sdk-context`,
    options.auto === true
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ auto: true }) }
      : { method: 'POST' },
    'postChatResetSdkContext'
  );
}

/** Generates a chat title on the backend (one-shot agent + parsing). Body: { workspaceFile?, workspaceFolder?, model?, text }. */
export async function postGenerateChatTitle(payload) {
  return cretliApiFetch('/api/generate-chat-title', {
    method: 'POST',
    headers: crHeaders({ 'Content-Type': 'application/json' }, '/api/generate-chat-title'),
    body: JSON.stringify(payload || {}),
  }, { acceptLanguage: getCurrentLang() }).then(json);
}

/** Generates a batch summary on the backend (background agent + callback). Body: { chatId, workspaceFile?, workspaceFolder?, model?, text }. */
export async function postGenerateChatSummary(payload) {
  return cretliApiFetch('/api/generate-chat-summary', {
    method: 'POST',
    headers: crHeaders({ 'Content-Type': 'application/json' }, '/api/generate-chat-summary'),
    body: JSON.stringify(payload || {}),
  }, { acceptLanguage: getCurrentLang() }).then(json);
}
import { blockedGitScopeResult } from './runtime.js';
// TypeScript checks the legacy API contract separately; this split preserves its runtime implementation.
// @ts-nocheck
