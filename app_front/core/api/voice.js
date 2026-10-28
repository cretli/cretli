// @ts-nocheck
// This module preserves the existing API implementation during the structural split.
import { crHeaders, isApiDebugEnabled, getDebugSinceAppStartMs, formatDebugOffset, debugApiLog, rememberRestoreGeneration, isRestoreGenerationRejection, retryAfterRestoreGenerationRefresh, dedupeGetJson, cloneCached, json, redirectLogin, apiFetchJson, API_DEBUG_FLAG_LS_KEY, STARTUP_GET_TTL_MS, GIT_INFO_TTL_MS, startupGetCache, startupGetInFlight, startupGetEpoch, inFlightGetRequests, appLogger, getCurrentLang, readStorageValueWithAlias, applyChatAuthSessionBoundary, clearPushInboxCache, scopeTodoPayload, todoWorkspaceQuery, VIEW_CONTEXT_STATUS, hasExplicitWorkspace, viewContextRuntimeParams, getViewContextState, isViewContextScopedAccessAllowed, withViewContextQuery, sharedState, isWorkspaceWatcherRetryableBlockedTodo, applyCsrfFromAuthPayload, buildCretliApiHeaders, cretliApiFetch, getCsrfToken, getWidgetAccessToken, onCretliApiWrite, setCsrfToken, setWidgetAccessToken, buildChatIdsQuery, chunkExplicitChatIds, fitsChatIdsQuery, MAX_CHAT_REVISIONS_FETCH_PARTS, normalizeExplicitChatIds } from './runtime.js';
import { invalidateStartupGetCache, sharedStartupGet, getWorkspace, getWorkspaceContext, getSettings, getApprovalAuditSummary, getSidebarLayout, patchSidebarLayout, patchSettings, patchSettingsLanHost, getBrowserPolicy, patchBrowserPolicy, buildApprovalSettingsPatch, patchApprovalBrokerSettings, getLanUrl, logout, getAuthStatus, getTerminalSession, getTaskRuns, getTasks, deleteTaskRun, getChats, getChatListSync, getChatListPage, getChatSdkMessages, getChatHistory, postChatHistoryRevisionsBatch, getChatHistoryRevisions, getChatAgentStates, disposeSdkChatRoom, postChatHistory, postChatHistoryBatch, getAgentSdkStatus, getOpenCodeStatus, getOpenCodeModels, getOpenRouterStatus, getOpenRouterModels, getCodeBuddyStatus, getCodeBuddyModels, getMistralStatus, getMistralModels, getZaiStatus, getZaiModels, getMimoStatus, getMimoModels, getDeepSeekStatus, getDeepSeekModels, getQwenStatus, getQwenModels, getClaudeStatus, getClaudeModels, startClaudePlanLogin, completeClaudePlanLogin, cancelClaudePlanLogin, getClaudePlanLimits, getContextCacheSeries, getCodexPlanLimits, getCodexStatus, getCodexModels, startCodexLogin, getCodexLoginStatus, cancelCodexLogin, logoutCodex, getWorktrees, postChat, postChatFork, postChatForkWithSummary, getChatPlan, getDelegationExecutors, getHarnessCatalog, postManualChatDelegation, postChatDelegation, getChatRecoveryRuns, postRecoveryResume, postRecoveryKeepStopped, getChatDelegations, getDelegation, getDelegationRuntime, getWorkspaceDelegations, getDelegationTree, postDelegationRetryDelivery, postDelegationCancel, postChatSeen, postDelegationAck, getDelegationAcceptContext, getDelegationReportLink, postDelegationAccept, postChatMailboxReply, postChatMailboxRetry, postDelegationRetry, patchChat, getChatTitleHistory, regenerateChatTitle, setChatTitleLock, archiveChat, deleteChat, deleteChatHistory, postChatSyncTodoPlan, getChatDiag, postSdkChatProbe, postChatResetSdkContext, postGenerateChatTitle, postGenerateChatSummary, getWorkspaces, writeWorkspaceFileFolders, convertWorkspaceFileToSelf, exportWorkspaceToFile, getFsEntries, createFsFolder, getStatusFlowScenariosFixture, getFilesEntries, getFileContent, invalidateTodoListCache, getTodos, getTodo, getTodoHistory, postTodo, patchTodo, deferTodo, restoreDeferredTodo, restoreTodoToTree, recoverWorkspaceWatcherTodo, releaseDoingWorkspaceWatcherTodo, retryWorkspaceWatcherTodo, integrateTodo, smartMergeTodo, verifyIntegrationTodo, integrateTodosBatch, getIntegrateBatch, cancelIntegrateBatch, resumeIntegrateBatch, abandonIntegrateBatch, clearIntegrationLock, listWorktrees, getWorktreeDiff, getWorktreeMergePreview, startWorktreeMerge, rejectWorktree, cleanupWorktree, deleteTodo, postTodoStartAgent, getTodoStartAgentStatus, getCursorContext, getGitInfo, getGitBranches, getGitFileDiff, postGitAction, getGithubInfo, getGithubWorkflowRuns, getGithubWorkflowRunJobs, getGithubWorkflowJobLogs, getUpdateStatus, postUpdateApply, postDevAction, getServerHealth, getServerDiagnosticsSummary, listWidgetInstallations, createWidgetInstallation, updateWidgetInstallation, deleteWidgetInstallation, uploadScreenshot, requestSpeech, requestTranscription, postUsageEvent, getCreditLedger, getCreditLedgerForecast, getCreditLedgerHarnessLinks, mutateCreditLedger, getCreditSubscriptions, mutateCreditSubscriptions, getDeepSeekBalanceStatus, refreshDeepSeekBalanceReading, getUsagePlanLimits, getUsageSettings, saveUsageSettings, getUsageLimitResumeSettings, saveUsageLimitResumeSettings, getUsageLimitResumeItems, cancelUsageLimitResume, getUsageSummary, getUsageTimeseries, getUsageModels, getUsageInsights, getUsageCacheFreshness, getUsageResumeAdvice, getUsageKeepAlive, stopUsageKeepAlive, getUsageTop, getUsageLimitBurn, getUsageWorkflowBreakdown, getReviewFindings, postRejectReviewFinding, getDelegationStats, getHarnessHealth, getHarnessDiagnostics, getHarnessModelRoleConfig, previewHarnessModelRoleConfig, putHarnessModelRoleConfig, resetHarnessModelRoleConfig, getModelPickOverrides, putModelPickOverride, revokeModelPickOverride, resetModelPickOverrides, getHarnessBenchmarkSources, putHarnessBenchmarkImport, getWorkspaceModelPickOverrides, putWorkspaceModelPickOverride, revokeWorkspaceModelPickOverride, clearHarnessUsageLimit, ackUnclassifiedError, getHarnessVersions, updateHarnessPackages, installMistralSdk, installZaiSdk, refreshHarnessModelsCatalog } from './index.js';
export async function requestRealtimeToken(payload = {}) {
  return apiFetchJson('/api/voice/realtime-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lang: payload.lang ? String(payload.lang) : undefined,
      voice: payload.voice ? String(payload.voice) : undefined,
      model: payload.model ? String(payload.model) : undefined,
      sessionId: payload.sessionId ? String(payload.sessionId) : undefined,
    }),
  }, 'requestRealtimeToken', { timeoutMs: 20000 });
}

/**
 * Checks whether the Gemini key (paste or the one already on the server) is
 * accepted by Google. Never returns the key.
 *
 * @param {{ geminiApiKey?: string }} [payload]
 * @returns {Promise<{ ok: boolean, model?: string|null, error?: string }>}
 */
export async function probeGeminiApiKey(payload = {}) {
  return apiFetchJson('/api/voice/gemini-probe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      geminiApiKey: payload.geminiApiKey ? String(payload.geminiApiKey) : undefined,
    }),
  }, 'probeGeminiApiKey', { timeoutMs: 15000 });
}

/**
 * Mints an ephemeral Gemini Live token. Setup (instructions, tools) is pinned
 * on the server.
 *
 * @param {{ lang?: string, voice?: string, model?: string, sessionId?: string }} [payload]
 * @returns {Promise<{ ok: boolean, token?: string, wsUrl?: string, model?: string, voice?: string, setup?: object, error?: string }>}
 */
export async function requestGeminiLiveToken(payload = {}) {
  return apiFetchJson('/api/voice/gemini-live-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lang: payload.lang ? String(payload.lang) : undefined,
      voice: payload.voice ? String(payload.voice) : undefined,
      model: payload.model ? String(payload.model) : undefined,
      sessionId: payload.sessionId ? String(payload.sessionId) : undefined,
    }),
  }, 'requestGeminiLiveToken', { timeoutMs: 20000 });
}

/**
 * @param {string} sessionId
 * @param {{
 *   startedAt?: number,
 *   endedAt?: number|null,
 *   provider?: string,
 *   model?: string,
 *   chatId?: string,
 *   entries?: object[],
 * }} payload
 * @returns {Promise<{ ok: boolean, sessionId?: string, entryCount?: number, error?: string }>}
 */
export async function appendVoiceSessionEvents(sessionId, payload = {}) {
  const id = String(sessionId || '').trim();
  return apiFetchJson(`/api/voice/sessions/${encodeURIComponent(id)}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, 'appendVoiceSessionEvents', { timeoutMs: 15000 });
}

/**
 * @param {string} sessionId
 * @returns {Promise<{ ok: boolean, session?: object, error?: string }>}
 */
export async function fetchVoiceSessionLog(sessionId) {
  const id = String(sessionId || '').trim();
  return apiFetchJson(`/api/voice/sessions/${encodeURIComponent(id)}`, {}, 'fetchVoiceSessionLog', {
    timeoutMs: 15000,
  });
}

/**
 * @param {number} [limit]
 * @returns {Promise<{ ok: boolean, sessions?: object[], error?: string }>}
 */
export async function listVoiceSessionLogs(limit = 20) {
  const query = Number.isFinite(limit) && limit > 0 ? `?limit=${Math.floor(limit)}` : '';
  return apiFetchJson(`/api/voice/sessions${query}`, {}, 'listVoiceSessionLogs', { timeoutMs: 15000 });
}

const UPLOAD_MAX_DIMENSION_PX = 1568;
const UPLOAD_JPEG_QUALITY = 0.84;

export async function fileToOptimizedBase64(file) {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return fileToBase64(file);
  }
  if (typeof createImageBitmap !== 'function') {
    return fileToBase64(file);
  }
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return fileToBase64(file);
  }
  const srcW = bitmap.width || 0;
  const srcH = bitmap.height || 0;
  if (srcW <= 0 || srcH <= 0) {
    if (typeof bitmap.close === 'function') bitmap.close();
    return fileToBase64(file);
  }
  const ratio = Math.min(1, UPLOAD_MAX_DIMENSION_PX / Math.max(srcW, srcH));
  const w = Math.max(1, Math.round(srcW * ratio));
  const h = Math.max(1, Math.round(srcH * ratio));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) {
    if (typeof bitmap.close === 'function') bitmap.close();
    return fileToBase64(file);
  }
  ctx.drawImage(bitmap, 0, 0, w, h);
  if (typeof bitmap.close === 'function') bitmap.close();
  const blob =
    (await canvasToBlob(canvas, 'image/jpeg', UPLOAD_JPEG_QUALITY)) ||
    (await canvasToBlob(canvas, 'image/webp', 0.82));
  if (!blob) return fileToBase64(file);
  return blobToBase64(blob);
}

function canvasToBlob(canvas, mimeType, quality) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), mimeType, quality);
  });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const i = typeof dataUrl === 'string' ? dataUrl.indexOf(',') : -1;
      resolve(i >= 0 ? dataUrl.slice(i + 1) : '');
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const i = dataUrl.indexOf(',');
      resolve(i >= 0 ? dataUrl.slice(i + 1) : '');
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Update a benchmark source using the current snapshot revision. */
export async function updateHarnessBenchmarkSource(action, body, etag) {
  return apiFetchJson(`/api/harness-benchmark-sources/${action}`, {
    method: action === 'fetch' || action === 'test' ? 'POST' : 'PUT',
    headers: { 'Content-Type': 'application/json', 'If-Match': String(etag || '') },
    body: JSON.stringify(body || {}),
  }, 'updateHarnessBenchmarkSource');
}

/** Persistent human permission grants, with no command or argument payloads. */
export async function getPermissionGrants() {
  return apiFetchJson('/api/approval-broker/grants', {}, 'getPermissionGrants');
}

export async function revokePermissionGrants(ids) {
  return apiFetchJson('/api/approval-broker/grants/revoke', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }),
  }, 'revokePermissionGrants');
}

/**
 * Wake-up rows of every kind (`GET /api/wakeups`).
 *
 * @param {string} [query] already-encoded query string, e.g. `?kind=x&state=armed`
 * @returns {Promise<{ ok: boolean, items?: object[], error?: string }>}
 */
export async function getWakeups(query = '') {
  return apiFetchJson(`/api/wakeups${query}`, undefined, 'getWakeups');
}

/**
 * @returns {Promise<{ ok: boolean, kinds?: object[], error?: string }>}
 */
export async function getWakeupKinds() {
  return apiFetchJson('/api/wakeups/kinds', undefined, 'getWakeupKinds');
}

/**
 * @returns {Promise<{ ok: boolean, running?: boolean, tickMs?: number, lastTickAt?: string|null, kinds?: object[], jobs?: object[], error?: string }>}
 */
export async function getWakeupStatus() {
  return apiFetchJson('/api/wakeups/status', undefined, 'getWakeupStatus');
}

/**
 * @param {string} kind
 * @param {object} patch
 * @returns {Promise<{ ok: boolean, settings?: object, code?: string, error?: string }>}
 */
export async function saveWakeupKindSettings(kind, patch = {}) {
  return apiFetchJson(`/api/wakeups/kinds/${encodeURIComponent(kind)}/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }, 'saveWakeupKindSettings', { timeoutMs: 15000 });
}

/**
 * @param {string} id wake-up row id
 * @returns {Promise<{ ok: boolean, code?: string, error?: string }>}
 */
export async function cancelWakeup(id) {
  return apiFetchJson(`/api/wakeups/${encodeURIComponent(id)}/cancel`, { method: 'POST' }, 'cancelWakeup');
}

/**
 * Evaluates a scheduled check now. A 409 `condition_not_met` carries the
 * current progress and means nothing changed.
 *
 * @param {string} id wake-up row id
 * @returns {Promise<{ ok: boolean, item?: object, code?: string, progress?: object|null, error?: string }>}
 */
export async function runWakeupNow(id) {
  return apiFetchJson(`/api/wakeups/${encodeURIComponent(id)}/run-now`, { method: 'POST' }, 'runWakeupNow');
}
// TypeScript checks the legacy API contract separately; this split preserves its runtime implementation.
// @ts-nocheck
