// @ts-nocheck
// This module preserves the existing API implementation during the structural split.
import { crHeaders, isApiDebugEnabled, getDebugSinceAppStartMs, formatDebugOffset, debugApiLog, rememberRestoreGeneration, isRestoreGenerationRejection, retryAfterRestoreGenerationRefresh, dedupeGetJson, cloneCached, json, redirectLogin, apiFetchJson, API_DEBUG_FLAG_LS_KEY, STARTUP_GET_TTL_MS, GIT_INFO_TTL_MS, startupGetCache, startupGetInFlight, bumpStartupGetEpoch, inFlightGetRequests, appLogger, getCurrentLang, readStorageValueWithAlias, applyChatAuthSessionBoundary, clearPushInboxCache, scopeTodoPayload, todoWorkspaceQuery, VIEW_CONTEXT_STATUS, hasExplicitWorkspace, viewContextRuntimeParams, getViewContextState, isViewContextScopedAccessAllowed, withViewContextQuery, sharedState, isWorkspaceWatcherRetryableBlockedTodo, applyCsrfFromAuthPayload, buildCretliApiHeaders, cretliApiFetch, getCsrfToken, getWidgetAccessToken, onCretliApiWrite, setCsrfToken, setWidgetAccessToken, buildChatIdsQuery, chunkExplicitChatIds, fitsChatIdsQuery, MAX_CHAT_REVISIONS_FETCH_PARTS, normalizeExplicitChatIds } from './runtime.js';
import { invalidateStartupGetCache, sharedStartupGet, getWorkspace, getWorkspaceContext, getSettings, getApprovalAuditSummary, getSidebarLayout, patchSidebarLayout, patchSettings, patchSettingsLanHost, getBrowserPolicy, patchBrowserPolicy, buildApprovalSettingsPatch, patchApprovalBrokerSettings, getLanUrl, logout, getAuthStatus, getTerminalSession, getTaskRuns, getTasks, deleteTaskRun, getChats, getChatListSync, getChatListPage, getChatSdkMessages, getChatHistory, postChatHistoryRevisionsBatch, getChatHistoryRevisions, getChatAgentStates, disposeSdkChatRoom, postChatHistory, postChatHistoryBatch, getAgentSdkStatus, getOpenCodeStatus, getOpenCodeModels, getOpenRouterStatus, getOpenRouterModels, getCodeBuddyStatus, getCodeBuddyModels, getMistralStatus, getMistralModels, getZaiStatus, getZaiModels, getMimoStatus, getMimoModels, getDeepSeekStatus, getDeepSeekModels, getQwenStatus, getQwenModels, getClaudeStatus, getClaudeModels, startClaudePlanLogin, completeClaudePlanLogin, cancelClaudePlanLogin, getClaudePlanLimits, getContextCacheSeries, getCodexPlanLimits, getCodexStatus, getCodexModels, startCodexLogin, getCodexLoginStatus, cancelCodexLogin, logoutCodex, getWorktrees, postChat, postChatFork, postChatForkWithSummary, getChatPlan, getDelegationExecutors, getHarnessCatalog, postManualChatDelegation, postChatDelegation, getChatRecoveryRuns, postRecoveryResume, postRecoveryKeepStopped, getChatDelegations, getDelegation, getDelegationRuntime, getWorkspaceDelegations, getDelegationTree, postDelegationRetryDelivery, postDelegationCancel, postChatSeen, postDelegationAck, getDelegationAcceptContext, getDelegationReportLink, postDelegationAccept, postChatMailboxReply, postChatMailboxRetry, postDelegationRetry, patchChat, getChatTitleHistory, regenerateChatTitle, setChatTitleLock, archiveChat, deleteChat, deleteChatHistory, postChatSyncTodoPlan, getChatDiag, postSdkChatProbe, postChatResetSdkContext, postGenerateChatTitle, postGenerateChatSummary, getWorkspaces, writeWorkspaceFileFolders, convertWorkspaceFileToSelf, exportWorkspaceToFile, getFsEntries, createFsFolder, getStatusFlowScenariosFixture, getFilesEntries, getFileContent, getGitInfo, getGitBranches, getGitFileDiff, postGitAction, getGithubInfo, getGithubWorkflowRuns, getGithubWorkflowRunJobs, getGithubWorkflowJobLogs, getUpdateStatus, postUpdateApply, postDevAction, getServerHealth, getServerDiagnosticsSummary, listWidgetInstallations, createWidgetInstallation, updateWidgetInstallation, deleteWidgetInstallation, uploadScreenshot, requestSpeech, requestTranscription, postUsageEvent, getCreditLedger, getCreditLedgerForecast, getCreditLedgerHarnessLinks, mutateCreditLedger, getCreditSubscriptions, mutateCreditSubscriptions, getDeepSeekBalanceStatus, refreshDeepSeekBalanceReading, getUsagePlanLimits, getUsageSettings, saveUsageSettings, getUsageLimitResumeSettings, saveUsageLimitResumeSettings, getUsageLimitResumeItems, cancelUsageLimitResume, getUsageSummary, getUsageTimeseries, getUsageModels, getUsageInsights, getUsageCacheFreshness, getUsageResumeAdvice, getUsageKeepAlive, stopUsageKeepAlive, getUsageTop, getUsageLimitBurn, getUsageWorkflowBreakdown, getReviewFindings, postRejectReviewFinding, getDelegationStats, getHarnessHealth, getHarnessDiagnostics, getHarnessModelRoleConfig, previewHarnessModelRoleConfig, putHarnessModelRoleConfig, resetHarnessModelRoleConfig, getModelPickOverrides, putModelPickOverride, revokeModelPickOverride, resetModelPickOverrides, getHarnessBenchmarkSources, putHarnessBenchmarkImport, getWorkspaceModelPickOverrides, putWorkspaceModelPickOverride, revokeWorkspaceModelPickOverride, clearHarnessUsageLimit, ackUnclassifiedError, getHarnessVersions, updateHarnessPackages, installMistralSdk, installZaiSdk, refreshHarnessModelsCatalog, requestRealtimeToken, probeGeminiApiKey, requestGeminiLiveToken, appendVoiceSessionEvents, fetchVoiceSessionLog, listVoiceSessionLogs, updateHarnessBenchmarkSource, getPermissionGrants, revokePermissionGrants, getWakeups, getWakeupKinds, getWakeupStatus, saveWakeupKindSettings, cancelWakeup, runWakeupNow } from './index.js';
const TODO_LIST_TTL_MS = 3000;

/** Drop cached todo list reads; the next `getTodos` goes to the server. */
export function invalidateTodoListCache() {
  // An in-flight read started before the change must not repopulate the cache.
  bumpStartupGetEpoch();
  for (const key of [...startupGetCache.keys()]) {
    if (key.startsWith('/api/todos')) startupGetCache.delete(key);
  }
  for (const key of [...startupGetInFlight.keys()]) {
    if (key.startsWith('/api/todos')) startupGetInFlight.delete(key);
  }
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('cretli:todo-changed', invalidateTodoListCache);
}

/**
 * Todos for the current workspace, stored server-side in data/todos.
 *
 * `slim` requests the lean list (no bodies, plans or changelogs; see
 * `GET /api/todos?slim=1`) and shares in-flight and very recent reads between
 * callers such as a tab switch and a review refresh.
 *
 * @param {string} [workspaceFolder]
 * @param {{ slim?: boolean }} [options]
 */
export async function getTodos(workspaceFolder, options = {}) {
  const base = `/api/todos${todoWorkspaceQuery(workspaceFolder)}`;
  const withSlim = options.slim ? `${base}${base.includes('?') ? '&' : '?'}slim=1` : base;
  const path = withViewContextQuery(withSlim);
  const load = () => dedupeGetJson(path, path.includes('?') ? `getTodos:${path.slice(path.indexOf('?') + 1)}` : 'getTodos');
  return options.slim ? sharedStartupGet(path, load, TODO_LIST_TTL_MS) : load();
}

/** One complete todo (body, plan, changelog) for the editor. */
export async function getTodo(id, workspaceFolder) {
  const path = withViewContextQuery(`/api/todos/${encodeURIComponent(id)}${todoWorkspaceQuery(workspaceFolder)}`);
  return dedupeGetJson(path, `getTodo:${path}`);
}

/** Detailed TODO timeline; fetched only when its History tab is open. */
export async function getTodoHistory(id, workspaceFolder) {
  const path = withViewContextQuery(`/api/todos/${encodeURIComponent(id)}/history${todoWorkspaceQuery(workspaceFolder)}`);
  return dedupeGetJson(path, `getTodoHistory:${path}`);
}

export async function postTodo(payload) {
  return apiFetchJson(
    '/api/todos',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(scopeTodoPayload(payload || {})),
    },
    'postTodo'
  );
}

export async function patchTodo(id, payload) {
  if (!id) return { ok: false, error: 'Missing id' };
  return apiFetchJson(
    `/api/todos/${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(scopeTodoPayload(payload || {})),
    },
    'patchTodo'
  );
}

/**
 * Postpones a todo on purpose. Date and reason are optional; an empty value is
 * simply not sent so the server stores no metadata for it.
 *
 * @param {string} id
 * @param {{ deferredUntil?: string, deferredReason?: string, moveToLater?: boolean }} [options]
 */
export async function deferTodo(id, options = {}) {
  const payload = { status: 'deferred' };
  if (options.moveToLater) payload.moveToLater = true;
  const until = String(options.deferredUntil || '').trim();
  const reason = String(options.deferredReason || '').trim();
  if (until) payload.deferredUntil = until;
  if (reason) payload.deferredReason = reason;
  return patchTodo(id, payload);
}

/** Brings a deferred todo back as a draft (`idea`); the server drops the deferral metadata. */
export async function restoreDeferredTodo(id) {
  return patchTodo(id, { status: 'idea' });
}

/** Returns a parked leaf to its old parent (server keeps it in `sourceTodoId`) and reopens it as a draft. */
export async function restoreTodoToTree(id) {
  return patchTodo(id, { status: 'idea', restoreToTree: true });
}

export async function recoverWorkspaceWatcherTodo(todoId, workspaceFolder, expectedUpdatedAt, idempotencyKey = '') {
  const id = String(todoId || '').trim();
  const folder = String(workspaceFolder || '').trim();
  const revision = String(expectedUpdatedAt || '').trim();
  if (!id || !folder || !revision) return { ok: false, error: 'Missing task, workspace or revision' };
  return apiFetchJson(
    `/api/workspace-watcher/todos/${encodeURIComponent(id)}/recover`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceFolder: folder,
        expectedUpdatedAt: revision,
        idempotencyKey: String(idempotencyKey || '').trim() || `ui-recover-${id}-${revision}`,
      }),
    },
    'recoverWorkspaceWatcherTodo',
  );
}

export async function releaseDoingWorkspaceWatcherTodo(todoId, workspaceFolder, expectedUpdatedAt, idempotencyKey = '') {
  const id = String(todoId || '').trim();
  const folder = String(workspaceFolder || '').trim();
  const revision = String(expectedUpdatedAt || '').trim();
  if (!id || !folder || !revision) return { ok: false, error: 'Missing task, workspace or revision' };
  return apiFetchJson(
    `/api/workspace-watcher/todos/${encodeURIComponent(id)}/release`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceFolder: folder,
        expectedUpdatedAt: revision,
        confirmUnknownRelease: true,
        idempotencyKey: String(idempotencyKey || '').trim() || `ui-release-unknown-${id}-${revision}`,
      }),
    },
    'releaseDoingWorkspaceWatcherTodo',
  );
}

export async function retryWorkspaceWatcherTodo(todoId, workspaceFolder) {
  const id = String(todoId || '').trim();
  const folder = String(workspaceFolder || '').trim();
  if (!id || !folder) return { ok: false, error: 'Missing task or workspace' };
  const todoData = await getTodos(folder);
  if (!todoData?.ok) return todoData;
  const todo = (Array.isArray(todoData.items) ? todoData.items : []).find((row) => String(row?.id || '') === id);
  if (!todo) return { ok: false, error: 'Task not found' };
  if (!isWorkspaceWatcherRetryableBlockedTodo(todo)) {
    return { ok: false, error: 'This task is no longer blocked by the Workspace Watcher.' };
  }
  const query = `?workspaceFolder=${encodeURIComponent(folder)}`;
  const watcherData = await apiFetchJson(`/api/workspace-watcher${query}`, undefined, 'getWorkspaceWatcherForTodoRetry');
  if (!watcherData?.ok) return watcherData;
  const failures = { ...(watcherData.watcher?.failures || {}) };
  delete failures[id];
  const watcherUpdate = await apiFetchJson('/api/workspace-watcher', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceFolder: folder, failures, backoffUntil: '' }),
  }, 'clearWorkspaceWatcherTodoFailure');
  if (!watcherUpdate?.ok) return watcherUpdate;
  return patchTodo(id, {
    status: todo.status,
    blockedReason: '',
    expectedUpdatedAt: todo.updatedAt,
  });
}

/**
 * Human integration of a worktree result. `merge` prepares the diff when needed
 * and applies it to the logical workspace through a guarded three-way merge;
 * `confirm` marks the todo done and unblocks its sequential siblings; `reject`
 * returns it to ready with a reason. The worktree is always preserved and
 * nothing is committed, pushed or merged at the Git level.
 */
export async function integrateTodo(todoId, workspaceFolder, action, expectedUpdatedAt, reason = '', proof = {}) {
  const id = String(todoId || '').trim();
  const folder = String(workspaceFolder || '').trim();
  const mode = ['confirm', 'reject', 'prepare', 'apply', 'merge', 'invalidate', 'no-code'].includes(action) ? action : 'confirm';
  if (!id || !folder) return { ok: false, error: 'Missing task or workspace' };
  return apiFetchJson(
    `/api/todos/${encodeURIComponent(id)}/integration`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: mode,
        workspaceFolder: folder,
        expectedUpdatedAt: String(expectedUpdatedAt || '').trim(),
        reason: String(reason || '').trim(),
        ...(mode === 'confirm' ? { proof } : {}),
      }),
    },
    'integrateTodo',
  );
}

/**
 * Smart merge: the server prepares the worktree diff and creates an agent chat
 * (chosen harness/model) in the logical workspace; the caller opens it with the
 * returned `initialPrompt`.
 */
export async function smartMergeTodo(todoId, workspaceFolder, options = {}) {
  const id = String(todoId || '').trim();
  const folder = String(workspaceFolder || '').trim();
  if (!id || !folder) return { ok: false, error: 'Missing task or workspace' };
  return apiFetchJson(
    `/api/todos/${encodeURIComponent(id)}/smart-merge`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceFolder: folder,
        workspaceFile: options.workspaceFile || '',
        agentTransport: options.agentTransport || '',
        model: options.model || '',
        conflicts: Array.isArray(options.conflicts) ? options.conflicts : [],
      }),
    },
    'smartMergeTodo',
  );
}

/**
 * Verify integration: the server creates an agent chat that checks a finished
 * todo is in the workspace branch and records the integration proof.
 */
export async function verifyIntegrationTodo(todoId, workspaceFolder, options = {}) {
  const id = String(todoId || '').trim();
  const folder = String(workspaceFolder || '').trim();
  if (!id || !folder) return { ok: false, error: 'Missing task or workspace' };
  return apiFetchJson(
    `/api/todos/${encodeURIComponent(id)}/verify-integration`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceFolder: folder,
        workspaceFile: options.workspaceFile || '',
        agentTransport: options.agentTransport || '',
        model: options.model || '',
      }),
    },
    'verifyIntegrationTodo',
  );
}

/**
 * Bulk "integrate with agent": one agent chat integrates several finished todos
 * strictly one after another, each on top of the already integrated HEAD. The
 * server owns the queue and the workspace lock; see docs/todo-integration-contract.md §6.
 */
export async function integrateTodosBatch(todoIds, workspaceFolder, options = {}) {
  const ids = (Array.isArray(todoIds) ? todoIds : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean);
  const folder = String(workspaceFolder || '').trim();
  if (!ids.length) return { ok: false, error: 'empty' };
  if (!folder) return { ok: false, error: 'Missing workspace' };
  return apiFetchJson(
    '/api/todos/integrate-batch',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        todoIds: ids,
        workspaceFolder: folder,
        workspaceFile: options.workspaceFile || '',
        agentTransport: options.agentTransport || '',
        model: options.model || '',
      }),
    },
    'integrateTodosBatch',
  );
}

/** Active and recent bulk integrate batches of a workspace, plus the current lock. */
export async function getIntegrateBatch(workspaceFolder, batchId = '') {
  const folder = String(workspaceFolder || '').trim();
  const id = String(batchId || '').trim();
  if (id) {
    const query = folder ? `?workspaceFolder=${encodeURIComponent(folder)}` : '';
    return apiFetchJson(
      `/api/todos/integrate-batch/${encodeURIComponent(id)}${query}`,
      {},
      'getIntegrateBatch',
    );
  }
  const path = withViewContextQuery(`/api/todos/integrate-batch${todoWorkspaceQuery(folder)}`);
  return sharedStartupGet(path, () => dedupeGetJson(path, path.includes('?') ? `listIntegrateBatches:${path.slice(path.indexOf('?') + 1)}` : 'listIntegrateBatches'));
}

export async function cancelIntegrateBatch(batchId, workspaceFolder) {
  const id = String(batchId || '').trim();
  if (!id) return { ok: false, error: 'Missing batch' };
  return apiFetchJson(
    `/api/todos/integrate-batch/${encodeURIComponent(id)}/cancel`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(scopeTodoPayload({ workspaceFolder })),
    },
    'cancelIntegrateBatch',
  );
}

export async function resumeIntegrateBatch(batchId, workspaceFolder, options = {}) {
  const id = String(batchId || '').trim();
  if (!id) return { ok: false, error: 'Missing batch' };
  const entryAction = options.entryAction === 'skip' ? 'skip' : 'retry';
  return apiFetchJson(
    `/api/todos/integrate-batch/${encodeURIComponent(id)}/resume`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(scopeTodoPayload({
        workspaceFolder,
        workspaceFile: options.workspaceFile || '',
        entryAction,
        forceLiveness: options.forceLiveness === true,
        // The server opens a new chat for the resume and defaults to sdk, so the
        // harness and model chosen at start must travel with the request.
        agentTransport: options.agentTransport || '',
        model: options.model || '',
      })),
    },
    'resumeIntegrateBatch',
  );
}

export async function abandonIntegrateBatch(batchId, workspaceFolder, options = {}) {
  const id = String(batchId || '').trim();
  if (!id) return { ok: false, error: 'Missing batch' };
  return apiFetchJson(
    `/api/todos/integrate-batch/${encodeURIComponent(id)}/abandon`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(scopeTodoPayload({
        workspaceFolder,
        forceLiveness: options.forceLiveness === true,
      })),
    },
    'abandonIntegrateBatch',
  );
}

/**
 * Explicit operator clear of a stranded integration lock. `force` is not needed;
 * the server only records who owned it. A still-running agent may keep writing.
 */
export async function clearIntegrationLock(workspaceFolder) {
  return apiFetchJson(
    '/api/integration-lock/clear',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(scopeTodoPayload({ workspaceFolder })),
    },
    'clearIntegrationLock',
  );
}

/**
 * @param {string} workspaceFolder
 * @returns {string}
 */
function worktreeWorkspaceQuery(workspaceFolder) {
  const folder = String(workspaceFolder || '').trim();
  return folder ? `?workspaceFolder=${encodeURIComponent(folder)}` : '';
}

/**
 * @param {string} workspaceFolder
 * @returns {{ ok: false, code: string } | null}
 */
function refuseEmptyWorktreeFolder(workspaceFolder) {
  const folder = String(workspaceFolder || '').trim();
  if (folder) return null;
  return { ok: false, code: 'workspace-folder-required' };
}

/** Worktrees of a workspace: registry reconciled with Git, with row states and actions. */
export async function listWorktrees(workspaceFolder) {
  const folder = String(workspaceFolder || '').trim();
  if (!folder) {
    if (!isViewContextScopedAccessAllowed()) return blockedGitScopeResult();
    return { ok: false, code: 'workspace-folder-required' };
  }
  return apiFetchJson(`/api/worktrees/list${worktreeWorkspaceQuery(folder)}`, {}, 'listWorktrees');
}

export async function getWorktreeDiff(todoId, workspaceFolder) {
  const refused = refuseEmptyWorktreeFolder(workspaceFolder);
  if (refused) return refused;
  return apiFetchJson(
    `/api/worktrees/${encodeURIComponent(String(todoId || ''))}/diff${worktreeWorkspaceQuery(workspaceFolder)}`,
    {},
    'getWorktreeDiff',
  );
}

/** Merge preflight for the modal: target branch, blockers, diffstat, conflict forecast. */
export async function getWorktreeMergePreview(todoId, workspaceFolder) {
  const refused = refuseEmptyWorktreeFolder(workspaceFolder);
  if (refused) return refused;
  return apiFetchJson(
    `/api/worktrees/${encodeURIComponent(String(todoId || ''))}/merge-preview${worktreeWorkspaceQuery(workspaceFolder)}`,
    {},
    'getWorktreeMergePreview',
  );
}

/** Start the git-level merge chat (harness/model chosen by the user). */
export async function startWorktreeMerge(todoId, workspaceFolder, options = {}) {
  const refused = refuseEmptyWorktreeFolder(workspaceFolder);
  if (refused) return refused;
  return apiFetchJson(
    `/api/worktrees/${encodeURIComponent(String(todoId || ''))}/merge`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceFolder: String(workspaceFolder || '').trim(),
        workspaceFile: options.workspaceFile || '',
        agentTransport: options.agentTransport || '',
        model: options.model || '',
        instructions: String(options.instructions || ''),
      }),
    },
    'startWorktreeMerge',
  );
}

export async function rejectWorktree(todoId, workspaceFolder, reason = '') {
  const refused = refuseEmptyWorktreeFolder(workspaceFolder);
  if (refused) return refused;
  return apiFetchJson(
    `/api/worktrees/${encodeURIComponent(String(todoId || ''))}/reject`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceFolder: String(workspaceFolder || '').trim(), reason }),
    },
    'rejectWorktree',
  );
}

export async function cleanupWorktree(todoId, workspaceFolder, options = {}) {
  const refused = refuseEmptyWorktreeFolder(workspaceFolder);
  if (refused) return refused;
  return apiFetchJson(
    `/api/worktrees/${encodeURIComponent(String(todoId || ''))}/cleanup`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceFolder: String(workspaceFolder || '').trim(),
        deleteBranch: options.deleteBranch === true,
        discard: options.discard === true,
        confirmBranch: String(options.confirmBranch || ''),
      }),
    },
    'cleanupWorktree',
  );
}

export async function deleteTodo(id, workspaceFolder) {
  if (!id) return { ok: false, error: 'Missing id' };
  return apiFetchJson(`/api/todos/${encodeURIComponent(id)}${todoWorkspaceQuery(workspaceFolder)}`, { method: 'DELETE' }, 'deleteTodo');
}

/**
 * Starts or opens the agent chat linked to a Todo.
 * `payload` is forwarded as-is; pass `{ forceNew: true }` to always create a
 * fresh chat instead of reusing the linked one.
 */
export async function postTodoStartAgent(id, payload = {}) {
  if (!id) return { ok: false, error: 'Missing id' };
  return apiFetchJson(
    `/api/todos/${encodeURIComponent(id)}/start-agent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(scopeTodoPayload(payload || {})),
    },
    'postTodoStartAgent'
  );
}

/** Read-only warm-chat choices for continuing a todo. */
export async function getTodoReuseCandidates(id, workspaceFolder = '') {
  if (!id) return { ok: false, error: 'Missing id' };
  return apiFetchJson(
    `/api/todos/${encodeURIComponent(id)}/reuse-candidates${todoWorkspaceQuery(workspaceFolder)}`,
    undefined,
    'getTodoReuseCandidates'
  );
}

/**
 * Poll a two-phase manual start. A worktree prepare may take minutes, so the
 * POST answers 202 and the UI polls until the chat is created (or fails).
 */
export async function getTodoStartAgentStatus(id, workspaceFolder = '', forceNew = false, reuseChatId = '') {
  if (!id) return { ok: false, error: 'Missing id' };
  const params = new URLSearchParams();
  const folder = String(workspaceFolder || '').trim();
  if (folder) params.set('workspaceFolder', folder);
  if (forceNew) params.set('forceNew', 'true');
  if (reuseChatId) params.set('reuseChatId', String(reuseChatId));
  const query = params.toString() ? `?${params.toString()}` : '';
  return apiFetchJson(
    `/api/todos/${encodeURIComponent(id)}/start-agent/status${query}`,
    undefined,
    'getTodoStartAgentStatus'
  );
}

export async function getCursorContext(workspaceFolder = '') {
  const query = workspaceFolder ? `?workspaceFolder=${encodeURIComponent(workspaceFolder)}` : '';
  return dedupeGetJson(`/api/cursor-context${query}`, 'getCursorContext');
}

/**
 * Chat/TODO scope forwarded to the Git routes. Only ids and the logical
 * workspace are sent; the server resolves the authorized execution folder from
 * its own records (see lib/git-context.js).
 *
 * @param {{ chatId?: string, todoId?: string, workspaceFolder?: string } | null | undefined} scope
 * @returns {URLSearchParams}
 */
/**
 * Chat list reads need durable route keys plus resolved runtime paths when the
 * tab owns an explicit ws/folder scope (including resource conflicts).
 *
 * @param {string} basePath
 * @returns {string}
 */
import { blockedGitScopeResult } from './runtime.js';
// TypeScript checks the legacy API contract separately; this split preserves its runtime implementation.
// @ts-nocheck
