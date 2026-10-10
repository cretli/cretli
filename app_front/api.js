/** API client: /api/workspace, settings, chats, lan-url, terminal-session, workspaces, cursor-context */
import { appLogger } from './logger.js';
import { getCurrentLang } from './i18n/index.js';
import { readStorageValueWithAlias } from './lib/storageKeyAlias.js';
import { applyChatAuthSessionBoundary } from './features/chat/chatSessionBoundary.js';
import { clearPushInboxCache } from './features/pwa/pushInbox.js';
import { scopeTodoPayload, todoWorkspaceQuery } from './features/todo/todoWorkspaceScope.js';
import { isWorkspaceWatcherRetryableBlockedTodo } from '../lib/workspace-watcher-blocked-reason.js';
import {
  applyCsrfFromAuthPayload,
  buildCretliApiHeaders,
  cretliApiFetch,
  getCsrfToken,
  getWidgetAccessToken,
  setCsrfToken,
  setWidgetAccessToken,
} from './lib/cretliApiRequest.js';
import {
  buildChatIdsQuery,
  chunkExplicitChatIds,
  fitsChatIdsQuery,
  MAX_CHAT_REVISIONS_FETCH_PARTS,
  normalizeExplicitChatIds,
} from './lib/chatIdsQuery.js';

export {
  applyCsrfFromAuthPayload,
  cretliApiFetch,
  getCsrfToken,
  getWidgetAccessToken,
  setCsrfToken,
  setWidgetAccessToken,
};

const API_DEBUG_FLAG_LS_KEY = 'cretli-debug-api';

/** Headers sent with every API request; Accept-Language drives the language of backend messages. */
function crHeaders(extra, url = '/api/') {
  return buildCretliApiHeaders({
    extra,
    url,
    acceptLanguage: getCurrentLang(),
  });
}

function isApiDebugEnabled() {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search || '');
  const query = (params.get('debugApi') || '').trim().toLowerCase();
  if (query === '1' || query === 'true' || query === 'yes') return true;
  try {
    const stored = readStorageValueWithAlias(localStorage, API_DEBUG_FLAG_LS_KEY, '');
    if (!stored) return false;
    const normalized = String(stored).trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
  } catch (_) {
    return false;
  }
}

function getDebugSinceAppStartMs() {
  if (typeof window !== 'undefined' && typeof window.__crAppBootStartedAtMs === 'number') {
    return window.__crAppBootStartedAtMs;
  }
  return null;
}

function formatDebugOffset(nowMs) {
  const startMs = getDebugSinceAppStartMs();
  if (!Number.isFinite(startMs)) return `${nowMs.toFixed(1)}ms`;
  return `+${(nowMs - startMs).toFixed(1)}ms`;
}

function debugApiLog(phase, label, extra = '') {
  if (!isApiDebugEnabled()) return;
  const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const offset = formatDebugOffset(nowMs);
  const suffix = extra ? ` ${extra}` : '';
  const message = `[api ${offset}] ${phase} ${label}${suffix}`;
  console.log(message);
  appLogger.log('api-debug', message);
}

const inFlightGetRequests = new Map();

function dedupeGetJson(url, label, fetchOptions = {}) {
  const key = String(url || '');
  if (!key) return apiFetchJson(url, undefined, label, fetchOptions);
  const inFlight = inFlightGetRequests.get(key);
  if (inFlight) {
    debugApiLog('REUSE', label, key);
    return inFlight;
  }
  const promise = apiFetchJson(url, undefined, label, fetchOptions).finally(() => {
    inFlightGetRequests.delete(key);
  });
  inFlightGetRequests.set(key, promise);
  return promise;
}

async function json(r) {
  if (r && r.status === 401) {
    applyCsrfFromAuthPayload(null);
    if (typeof window !== 'undefined' && !getWidgetAccessToken()) {
      redirectLogin();
    }
  }
  return r.json();
}

function redirectLogin() {
  if (typeof window === 'undefined') return;
  if (window.location.pathname === '/login') return;
  void applyChatAuthSessionBoundary({ reason: '401' }).finally(() => {
    void clearPushInboxCache();
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.replace(`/login?next=${next}`);
  });
}

async function apiFetchJson(url, init, label, fetchOptions = {}) {
  const startedAtMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
  debugApiLog('START', label, url);
  const isGet = !init || !init.method || String(init.method).toUpperCase() === 'GET';
  const defaultTimeoutMs = isGet ? 10000 : 20000;
  const timeoutMs = Number.isFinite(fetchOptions.timeoutMs)
    ? Math.max(1000, Number(fetchOptions.timeoutMs))
    : defaultTimeoutMs;
  let timeoutId = null;
  let finalInit = init;
  let controller = null;
  if (typeof AbortController !== 'undefined') {
    controller = new AbortController();
    finalInit = { ...(init || {}), signal: controller.signal };
    finalInit.headers = crHeaders(finalInit.headers, url);
    finalInit.credentials = 'include';
    timeoutId = setTimeout(() => {
      try {
        controller.abort();
      } catch (_) {}
    }, timeoutMs);
  } else {
    finalInit = { ...(init || {}) };
    finalInit.headers = crHeaders(finalInit.headers, url);
    finalInit.credentials = 'include';
  }
  try {
    if (isGet && !finalInit.cache) finalInit.cache = 'no-store';
    const response = await cretliApiFetch(url, finalInit);
    const finishedAtMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const elapsedMs = (finishedAtMs - startedAtMs).toFixed(1);
    debugApiLog('END', label, `${response.status} (${elapsedMs}ms)`);
    if (timeoutId) clearTimeout(timeoutId);
    return json(response);
  } catch (err) {
    const finishedAtMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const elapsedMs = (finishedAtMs - startedAtMs).toFixed(1);
    const isTimeoutAbort = !!(controller && controller.signal && controller.signal.aborted);
    debugApiLog('ERROR', label, `${elapsedMs}ms ${isTimeoutAbort ? `timeout>${timeoutMs}ms` : (err?.message || 'fetch failed')}`);
    if (timeoutId) clearTimeout(timeoutId);
    throw err;
  }
}

export async function getWorkspace() {
  return dedupeGetJson('/api/workspace', 'getWorkspace');
}

export async function getSettings() {
  return dedupeGetJson('/api/settings', 'getSettings');
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

export async function getBrowserPolicy() {
  return dedupeGetJson('/api/browser/policy', 'getBrowserPolicy');
}

export async function patchBrowserPolicy(policy) {
  return apiFetchJson('/api/browser/policy?mode=agent', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ policy: policy || {} }),
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
  const data = await dedupeGetJson('/api/auth-status', 'getAuthStatus');
  applyCsrfFromAuthPayload(data);
  return data;
}

export async function getTerminalSession() {
  return dedupeGetJson('/api/terminal-session', 'getTerminalSession');
}

/** Active task runs, so a page reload can re-attach to them the same way chat sessions do. */
export async function getTaskRuns() {
  return dedupeGetJson('/api/task-runs', 'getTaskRuns');
}

export async function getTasks(options = {}) {
  const params = new URLSearchParams();
  if (options.workspaceFile) params.set('workspaceFile', String(options.workspaceFile).trim());
  const query = params.toString() ? `?${params.toString()}` : '';
  if (options.fresh || query) {
    return apiFetchJson(`/api/tasks${query}`, { cache: 'no-store' }, 'getTasks');
  }
  return dedupeGetJson('/api/tasks', 'getTasks');
}

export async function deleteTaskRun(runId) {
  if (!runId) return { ok: false, error: 'Missing runId' };
  return apiFetchJson(`/api/task-runs/${encodeURIComponent(runId)}`, { method: 'DELETE' }, 'deleteTaskRun');
}

/** Active runs of agents defined in .cursor/agents. */
export async function getAgentRuns() {
  return dedupeGetJson('/api/agent-runs', 'getAgentRuns');
}

export async function getAgents() {
  return dedupeGetJson('/api/agents', 'getAgents');
}

export async function getAgentsSchedule() {
  return dedupeGetJson('/api/agents/schedule', 'getAgentsSchedule');
}

export async function patchAgentsSchedule(schedules) {
  return apiFetchJson('/api/agents/schedule', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ schedules }),
  }, 'patchAgentsSchedule');
}

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
  const path = qs ? `/api/chats?${qs}` : '/api/chats';
  return dedupeGetJson(path, qs ? `getChats:${qs}` : 'getChats');
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
export async function postChatHistory(id, cursorSessionId, events) {
  return apiFetchJson(`/api/chats/${encodeURIComponent(id)}/history`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cursorSessionId: cursorSessionId || '', events: Array.isArray(events) ? events : [] }),
  }, 'postChatHistory');
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
  return dedupeGetJson('/api/agent-sdk', 'getAgentSdkStatus');
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

export async function postChatDelegation(id, payload) {
  if (!id) return { ok: false, error: 'Missing chat id' };
  return apiFetchJson(`/api/chats/${encodeURIComponent(id)}/delegations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  }, `postChatDelegation:${id}`);
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

export async function postDelegationRetryDelivery(id, payload = {}) {
  if (!id) return { ok: false, error: 'Missing delegation id' };
  return apiFetchJson(`/api/delegations/${encodeURIComponent(id)}/retry-delivery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  }, `postDelegationRetryDelivery:${id}`);
}

export async function postDelegationCancel(id) {
  if (!id) return { ok: false, error: 'Missing delegation id' };
  return apiFetchJson(`/api/delegations/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
  }, `postDelegationCancel:${id}`);
}

export async function postDelegationAck(id, payload = {}) {
  if (!id) return { ok: false, error: 'Missing delegation id' };
  return apiFetchJson(`/api/delegations/${encodeURIComponent(id)}/ack`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  }, `postDelegationAck:${id}`);
}

/** User rating from the delegation card (rater is fixed server-side to `user`). */
export async function postDelegationRate(id, payload = {}) {
  if (!id) return { ok: false, error: 'Missing delegation id' };
  return apiFetchJson(`/api/delegations/${encodeURIComponent(id)}/rate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  }, `postDelegationRate:${id}`);
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
  return apiFetchJson(`/api/chats/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  }, `deleteChat:${id}`);
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
export async function postChatResetSdkContext(id) {
  if (!id) return { ok: false, error: 'Missing chat id' };
  return apiFetchJson(
    `/api/chats/${encodeURIComponent(id)}/reset-sdk-context`,
    { method: 'POST' },
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

export async function getWorkspaces(options = {}) {
  const params = new URLSearchParams();
  if (options.refresh) params.set('refresh', '1');
  if (options.scan) params.set('scan', '1');
  if (options.sync) params.set('sync', '1');
  const query = params.toString() ? `?${params.toString()}` : '';
  if (query) {
    return apiFetchJson(`/api/workspaces${query}`, { cache: 'no-store' }, 'getWorkspaces');
  }
  return dedupeGetJson('/api/workspaces', 'getWorkspaces');
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

/** Todos for the current workspace, stored server-side in data/todos. */
export async function getTodos(workspaceFolder) {
  return dedupeGetJson(`/api/todos${todoWorkspaceQuery(workspaceFolder)}`, 'getTodos');
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

export async function retryWorkspaceWatcherTodo(todoId, workspaceFolder) {  const id = String(todoId || '').trim();
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
export async function integrateTodo(todoId, workspaceFolder, action, expectedUpdatedAt, reason = '') {
  const id = String(todoId || '').trim();
  const folder = String(workspaceFolder || '').trim();
  const mode = ['confirm', 'reject', 'prepare', 'apply', 'merge'].includes(action) ? action : 'confirm';
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

/**
 * Poll a two-phase manual start. A worktree prepare may take minutes, so the
 * POST answers 202 and the UI polls until the chat is created (or fails).
 */
export async function getTodoStartAgentStatus(id, workspaceFolder = '', forceNew = false) {
  if (!id) return { ok: false, error: 'Missing id' };
  const params = new URLSearchParams();
  const folder = String(workspaceFolder || '').trim();
  if (folder) params.set('workspaceFolder', folder);
  if (forceNew) params.set('forceNew', 'true');
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
 * @param {string} basePath
 * @param {URLSearchParams} params
 * @returns {string}
 */
function withQuery(basePath, params) {
  const query = params.toString();
  return query ? `${basePath}?${query}` : basePath;
}

export async function getGitInfo(scope = null) {
  return cretliApiFetch(withQuery('/api/git/info', buildGitScopeParams(scope)), {}, { acceptLanguage: getCurrentLang() }).then(json);
}

/** Diff of a single file against HEAD; path is relative to the execution folder. */
export async function getGitFileDiff(filePath, scope = null) {
  const params = buildGitScopeParams(scope);
  params.set('path', String(filePath));
  return cretliApiFetch(withQuery('/api/git/file-diff', params), {}, { acceptLanguage: getCurrentLang() }).then(json);
}

export async function postGitAction(payload, scope = null) {
  const body = { ...(payload || {}) };
  for (const [key, value] of buildGitScopeParams(scope)) body[key] = value;
  return cretliApiFetch('/api/git/run', {
    method: 'POST',
    headers: crHeaders({ 'Content-Type': 'application/json' }, '/api/git/run'),
    body: JSON.stringify(body),
  }, { acceptLanguage: getCurrentLang() }).then(json);
}

export async function getGithubInfo(scope = null) {
  return cretliApiFetch(withQuery('/api/github/info', buildGitScopeParams(scope)), {}, { acceptLanguage: getCurrentLang() }).then(json);
}

export async function getGithubWorkflowRuns(options = {}) {
  const params = buildGitScopeParams(options.scope);
  if (options.perPage) params.set('per_page', String(options.perPage));
  if (options.page) params.set('page', String(options.page));
  return cretliApiFetch(withQuery('/api/github/actions/runs', params), {}, { acceptLanguage: getCurrentLang() }).then(json);
}

export async function getGithubWorkflowRunJobs(runId, options = {}) {
  const params = buildGitScopeParams(options.scope);
  return cretliApiFetch(
    withQuery(`/api/github/actions/runs/${encodeURIComponent(String(runId))}/jobs`, params),
    {},
    { acceptLanguage: getCurrentLang() },
  ).then(json);
}

export async function getGithubWorkflowJobLogs(jobId, options = {}) {
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
export async function getUpdateStatus({ check = false } = {}) {
  const query = check ? '?check=1' : '';
  return apiFetchJson(`/api/update/status${query}`, undefined, 'getUpdateStatus', {
    timeoutMs: check ? 70000 : 15000,
  });
}

export async function postUpdateApply() {
  return apiFetchJson('/api/update/apply', { method: 'POST' }, 'postUpdateApply');
}

export async function postDevAction(action = 'restart-server') {
  return apiFetchJson('/api/dev-actions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  }, 'postDevAction');
}

export async function getServerHealth() {
  return cretliApiFetch('/api/health', { cache: 'no-store' }, { acceptLanguage: getCurrentLang() }).then(json);
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

export async function getUsagePlanLimits() {
  return dedupeGetJson('/api/usage/plan-limits', 'getUsagePlanLimits');
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
  return dedupeGetJson(`/api/usage/summary${suffix}`, 'getUsageSummary');
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
  return dedupeGetJson(`/api/usage/timeseries${suffix}`, 'getUsageTimeseries');
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
  return dedupeGetJson(`/api/usage/models${suffix}`, 'getUsageModels');
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
  return dedupeGetJson(`/api/usage/insights${suffix}`, 'getUsageInsights');
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
  return dedupeGetJson(`/api/delegations/stats${suffix}`, 'getDelegationStats');
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

/** Install the optional Mistral SDK in the Cretli project. */
export async function installMistralSdk() {
  return apiFetchJson('/api/harness/mistral/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  }, 'installMistralSdk', { timeoutMs: 180000 });
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

async function fileToOptimizedBase64(file) {
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
