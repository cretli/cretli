// @ts-nocheck
// Shared transport, caching and request-boundary helpers for the domain API modules.
/** API client: /api/workspace, settings, chats, lan-url, terminal-session, workspaces, cursor-context */
import { appLogger } from '../logging/logger.js';
import { getCurrentLang } from '../../i18n/index.js';
import { readStorageValueWithAlias } from '../../lib/storageKeyAlias.js';
import { applyChatAuthSessionBoundary } from '../../features/chat/chatSessionBoundary.js';
import { clearPushInboxCache } from '../../features/pwa/pushInbox.js';
import { scopeTodoPayload, todoWorkspaceQuery } from '../../features/todo/todoWorkspaceScope.js';
// The per-tab view context owns the scope of Git/GitHub reads; this import is
// one-way (the bridge never imports the API layer), so there is no cycle.
import {
  VIEW_CONTEXT_STATUS,
  hasExplicitWorkspace,
  viewContextRuntimeParams,
} from '../../app/appShell/viewContext.js';
import {
  getViewContextState,
  isViewContextScopedAccessAllowed,
  withViewContextQuery,
} from '../../app/appShell/viewContextBridge.js';
import { sharedState } from '../../state/index.js';
import { isWorkspaceWatcherRetryableBlockedTodo } from '../../../lib/workspace-watcher-blocked-reason.js';
import {
  applyCsrfFromAuthPayload,
  buildCretliApiHeaders,
  cretliApiFetch,
  getCsrfToken,
  getWidgetAccessToken,
  onCretliApiWrite,
  setCsrfToken,
  setWidgetAccessToken,
} from '../../lib/cretliApiRequest.js';
import {
  buildChatIdsQuery,
  chunkExplicitChatIds,
  fitsChatIdsQuery,
  MAX_CHAT_REVISIONS_FETCH_PARTS,
  normalizeExplicitChatIds,
} from '../../lib/chatIdsQuery.js';

export {
  applyCsrfFromAuthPayload,
  cretliApiFetch,
  getCsrfToken,
  getWidgetAccessToken,
  setCsrfToken,
  setWidgetAccessToken,
};

export const API_DEBUG_FLAG_LS_KEY = 'cretli-debug-api';

/** Headers sent with every API request; Accept-Language drives the language of backend messages. */
export function crHeaders(extra, url = '/api/') {
  return buildCretliApiHeaders({
    extra,
    url,
    acceptLanguage: getCurrentLang(),
  });
}

export function isApiDebugEnabled() {
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

export function getDebugSinceAppStartMs() {
  if (typeof window !== 'undefined' && typeof window.__crAppBootStartedAtMs === 'number') {
    return window.__crAppBootStartedAtMs;
  }
  return null;
}

export function formatDebugOffset(nowMs) {
  const startMs = getDebugSinceAppStartMs();
  if (!Number.isFinite(startMs)) return `${nowMs.toFixed(1)}ms`;
  return `+${(nowMs - startMs).toFixed(1)}ms`;
}

export function debugApiLog(phase, label, extra = '') {
  if (!isApiDebugEnabled()) return;
  const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const offset = formatDebugOffset(nowMs);
  const suffix = extra ? ` ${extra}` : '';
  const message = `[api ${offset}] ${phase} ${label}${suffix}`;
  console.log(message);
  appLogger.log('api-debug', message);
}

export const inFlightGetRequests = new Map();
export let restoreGeneration = null;

export function rememberRestoreGeneration(data) {
  if (!data || typeof data !== 'object' || !Object.prototype.hasOwnProperty.call(data, 'restoreGeneration')) return data;
  restoreGeneration = typeof data.restoreGeneration === 'string' && data.restoreGeneration.trim()
    ? data.restoreGeneration.trim()
    : null;
  return data;
}

export function isRestoreGenerationRejection(result) {
  return result?.code === 'generation_missing' || result?.code === 'generation_stale';
}

export async function retryAfterRestoreGenerationRefresh(request) {
  let result = await request();
  if (!isRestoreGenerationRejection(result)) return result;
  // Load the settings domain lazily so the shared runtime never imports the API barrel.
  const { getSettings } = await import('./settings.js');
  await getSettings();
  return request();
}

export function dedupeGetJson(url, label, fetchOptions = {}) {
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

export function withResolvedViewContextRuntimeQuery(basePath) {
  const path = withViewContextQuery(basePath);
  const state = getViewContextState();
  if (!state || !hasExplicitWorkspace(state.context || {})) return path;
  const runtime = viewContextRuntimeParams(state);
  if (!runtime.workspaceFolder && !runtime.workspaceFile) return path;
  const qIndex = path.indexOf('?');
  const pathOnly = qIndex === -1 ? path : path.slice(0, qIndex);
  const merged = new URLSearchParams(qIndex === -1 ? '' : path.slice(qIndex + 1));
  if (runtime.workspaceFolder && !merged.has('workspaceFolder')) merged.set('workspaceFolder', runtime.workspaceFolder);
  if (runtime.workspaceFile && !merged.has('workspaceFile')) merged.set('workspaceFile', runtime.workspaceFile);
  const query = merged.toString();
  return query ? `${pathOnly}?${query}` : pathOnly;
}

export function blockedGitScopeResult() {
  return { ok: false, code: 'view-context-pending' };
}

export function bumpStartupGetEpoch() {
  startupGetEpoch += 1;
}

/**
 * Short client-side cache for startup reads that several panels request in the
 * same second (settings, git/github info, notifications). One shared promise per
 * key covers concurrent callers; a resolved ok payload is reused for `ttlMs`.
 * Every write (non-GET API call, git action, notification mutation) clears the
 * whole cache, so a read after a write is always fresh.
 */
export const STARTUP_GET_TTL_MS = 2000;
/** Git/GitHub info is re-read on every panel/tab switch; git writes clear it, so a longer window is safe. */
export const GIT_INFO_TTL_MS = 5000;
/** @type {Map<string, { at: number, value: any }>} */
export const startupGetCache = new Map();
/** @type {Map<string, Promise<any>>} */
export const startupGetInFlight = new Map();
export let startupGetEpoch = 0;

export function invalidateStartupGetCache() {
  startupGetEpoch += 1;
  startupGetCache.clear();
  startupGetInFlight.clear();
}

onCretliApiWrite(invalidateStartupGetCache);

export function cloneCached(value) {
  if (!value || typeof value !== 'object') return value;
  try {
    return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
  } catch (_) {
    return value;
  }
}

/**
 * @param {string} key
 * @param {() => Promise<any>} loader
 * @param {number} [ttlMs]
 * @returns {Promise<any>}
 */
export function sharedStartupGet(key, loader, ttlMs = STARTUP_GET_TTL_MS) {
  const hit = startupGetCache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return Promise.resolve(cloneCached(hit.value));
  const inFlight = startupGetInFlight.get(key);
  if (inFlight) return inFlight.then(cloneCached);
  const epoch = startupGetEpoch;
  const promise = Promise.resolve().then(loader).then((value) => {
    // A write that landed while this read was in flight makes the result stale.
    if (epoch === startupGetEpoch && value && value.ok !== false) {
      startupGetCache.set(key, { at: Date.now(), value });
    }
    return value;
  }).finally(() => {
    if (startupGetInFlight.get(key) === promise) startupGetInFlight.delete(key);
  });
  startupGetInFlight.set(key, promise);
  return promise.then(cloneCached);
}

export async function json(r) {
  if (r && r.status === 401) {
    applyCsrfFromAuthPayload(null);
    if (typeof window !== 'undefined' && !getWidgetAccessToken()) {
      redirectLogin();
    }
  }
  return r.json();
}

export function redirectLogin() {
  if (typeof window === 'undefined') return;
  if (window.location.pathname === '/login') return;
  void applyChatAuthSessionBoundary({ reason: '401' }).finally(() => {
    void clearPushInboxCache();
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.replace(`/login?next=${next}`);
  });
}

export async function apiFetchJson(url, init, label, fetchOptions = {}) {
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


export { appLogger, getCurrentLang, readStorageValueWithAlias, applyChatAuthSessionBoundary, clearPushInboxCache, scopeTodoPayload, todoWorkspaceQuery, VIEW_CONTEXT_STATUS, hasExplicitWorkspace, viewContextRuntimeParams, getViewContextState, isViewContextScopedAccessAllowed, withViewContextQuery, sharedState, isWorkspaceWatcherRetryableBlockedTodo, buildCretliApiHeaders, onCretliApiWrite, buildChatIdsQuery, chunkExplicitChatIds, fitsChatIdsQuery, MAX_CHAT_REVISIONS_FETCH_PARTS, normalizeExplicitChatIds };
// TypeScript checks the legacy API contract separately; this split preserves its runtime implementation.
// @ts-nocheck
