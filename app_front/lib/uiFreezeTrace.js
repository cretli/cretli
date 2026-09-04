/**
 * Cross-cutting resume/freeze tracing (HTTP, WS, phases). Opt-in via UI freeze diag.
 */
import { readStorageValueWithAlias } from './storageKeyAlias.js';

export const UI_FREEZE_DIAG_LS_KEY = 'cretli-ui-freeze-diag';

export const UI_FREEZE_TRACE_TAG = 'ui-freeze-trace';
export const UI_FREEZE_HTTP_TAG = 'ui-freeze-http';
export const UI_FREEZE_WS_TAG = 'ui-freeze-ws';

/** Tags included in the Logs panel freeze filter. */
export const UI_FREEZE_REPORT_TAGS = new Set([
  'ui-freeze',
  'ui-freeze-perf',
  'ui-freeze-touch',
  UI_FREEZE_TRACE_TAG,
  UI_FREEZE_HTTP_TAG,
  UI_FREEZE_WS_TAG,
  'page-resume',
  'chat-sync',
  'chat-ws',
  'chat-background',
]);

export const LOGS_FILTER_ALL = 'all';
export const LOGS_FILTER_FREEZE = 'freeze';
export const LOGS_FILTER_RESUME = 'resume';

const RESUME_TRACE_WINDOW_MS = 30000;
const LONG_TASK_THRESHOLD_MS = 50;

/**
 * @returns {boolean}
 */
export function isUiFreezeDiagnosticsEnabled() {
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search || '');
    const query = (params.get('uiFreezeDiag') || '').trim().toLowerCase();
    if (query === '1' || query === 'true' || query === 'yes' || query === 'on') return true;
    if (query === '0' || query === 'false' || query === 'no' || query === 'off') return false;
  }
  if (typeof localStorage === 'undefined') return false;
  try {
    const stored = readStorageValueWithAlias(localStorage, UI_FREEZE_DIAG_LS_KEY, '');
    if (!stored) return false;
    const normalized = String(stored).trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
  } catch {
    return false;
  }
}

/** @type {{ log?: (tag: string, message: string, payload?: object) => void } | null} */
let logger = null;
let initialized = false;
let resumeSessionId = 0;
let resumeSessionStartedAt = 0;
let resumeTraceUntil = 0;
/** @type {ReturnType<typeof fetch> | null} */
let nativeFetch = null;

/**
 * @returns {boolean}
 */
export function isUiFreezeTraceActive() {
  return isUiFreezeDiagnosticsEnabled();
}

/**
 * @param {string} tag
 * @returns {boolean}
 */
export function isUiFreezeReportTag(tag) {
  return UI_FREEZE_REPORT_TAGS.has(String(tag || '').trim());
}

/**
 * @param {string} tag
 * @param {string} filter
 * @returns {boolean}
 */
export function matchesLogsPanelFilter(tag, filter) {
  const normalizedTag = String(tag || '').trim();
  if (filter === LOGS_FILTER_FREEZE) return isUiFreezeReportTag(normalizedTag);
  if (filter === LOGS_FILTER_RESUME) {
    return (
      isUiFreezeReportTag(normalizedTag) ||
      normalizedTag === 'api-debug' ||
      normalizedTag === 'system'
    );
  }
  return true;
}

/**
 * @returns {number}
 */
export function getUiFreezeResumeSessionId() {
  return resumeSessionId;
}

/**
 * @returns {number}
 */
export function getUiFreezeResumeElapsedMs() {
  if (!resumeSessionStartedAt) return 0;
  return Math.max(0, Date.now() - resumeSessionStartedAt);
}

/**
 * @param {string} reason
 */
export function beginUiFreezeResumeSession(reason) {
  if (!isUiFreezeTraceActive()) return;
  resumeSessionId += 1;
  resumeSessionStartedAt = Date.now();
  resumeTraceUntil = resumeSessionStartedAt + RESUME_TRACE_WINDOW_MS;
  traceUiFreeze('resume-session', 'start', {
    sessionId: resumeSessionId,
    reason,
    visibility: typeof document !== 'undefined' ? document.visibilityState : 'unknown',
    hidden: typeof document !== 'undefined' ? document.hidden === true : false,
  });
}

/**
 * @param {string} category
 * @param {string} event
 * @param {Record<string, unknown>} [payload]
 */
export function traceUiFreeze(category, event, payload = {}) {
  if (!isUiFreezeTraceActive() || !logger?.log) return;
  logger.log(UI_FREEZE_TRACE_TAG, `${category}:${event}`, {
    sessionId: resumeSessionId || undefined,
    elapsedMs: resumeSessionStartedAt ? getUiFreezeResumeElapsedMs() : undefined,
    ...payload,
  });
}

/**
 * @param {string} phase
 * @param {string} label
 * @param {string} url
 * @param {{ status?: number, elapsedMs?: number, error?: string }} [extra]
 */
export function traceUiFreezeHttp(phase, label, url, extra = {}) {
  if (!isUiFreezeTraceActive() || !logger?.log) return;
  logger.log(UI_FREEZE_HTTP_TAG, `${phase} ${label}`, {
    sessionId: resumeSessionId || undefined,
    elapsedMs: resumeSessionStartedAt ? getUiFreezeResumeElapsedMs() : undefined,
    url: String(url || '').slice(0, 160),
    ...extra,
  });
}

/**
 * @param {string} direction
 * @param {string} chatId
 * @param {string} type
 * @param {Record<string, unknown>} [extra]
 */
export function traceUiFreezeWs(direction, chatId, type, extra = {}) {
  if (!isUiFreezeTraceActive() || !logger?.log) return;
  logger.log(UI_FREEZE_WS_TAG, `${direction} ${type}`, {
    sessionId: resumeSessionId || undefined,
    elapsedMs: resumeSessionStartedAt ? getUiFreezeResumeElapsedMs() : undefined,
    chatId: chatId || undefined,
    ...extra,
  });
}

/**
 * @param {number} durationMs
 * @returns {boolean}
 */
export function shouldLogUiFreezeLongTask(durationMs) {
  if (!isUiFreezeTraceActive()) return false;
  if (resumeTraceUntil > Date.now()) return durationMs >= LONG_TASK_THRESHOLD_MS;
  return durationMs >= 200;
}

function installFetchProbe() {
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  if (window.__crUiFreezeFetchProbeInstalled) return;
  nativeFetch = window.fetch.bind(window);
  function readHeaderValue(headers, key) {
    if (!headers) return '';
    const lookup = String(key || '').toLowerCase();
    if (typeof headers.get === 'function') return String(headers.get(lookup) || headers.get(key) || '');
    if (Array.isArray(headers)) {
      for (const pair of headers) {
        if (!Array.isArray(pair) || pair.length < 2) continue;
        if (String(pair[0] || '').toLowerCase() !== lookup) continue;
        return String(pair[1] || '');
      }
      return '';
    }
    if (typeof headers === 'object') {
      for (const [name, value] of Object.entries(headers)) {
        if (String(name || '').toLowerCase() !== lookup) continue;
        return String(value || '');
      }
    }
    return '';
  }
  function shouldSkipFetchProbe(url, init) {
    const normalizedUrl = String(url || '');
    if (normalizedUrl.includes('/api/client-debug-log')) return true;
    const marker = readHeaderValue(init?.headers, 'x-cr-debug-log');
    if (marker === '1' || marker.toLowerCase() === 'true') return true;
    return false;
  }
  window.fetch = async function uiFreezeFetchProbe(input, init) {
    const url = typeof input === 'string' ? input : input?.url || String(input);
    if (shouldSkipFetchProbe(url, init)) {
      return nativeFetch(input, init);
    }
    const method = init?.method || (typeof input === 'object' && input?.method) || 'GET';
    const label = `${String(method).toUpperCase()} ${url}`;
    const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const inResumeWindow = resumeTraceUntil > Date.now();
    if (isUiFreezeTraceActive() && (inResumeWindow || String(url).includes('/api/'))) {
      traceUiFreezeHttp('START', label, url);
    }
    try {
      const response = await nativeFetch(input, init);
      if (isUiFreezeTraceActive()) {
        const elapsedMs = Math.round(
          (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt
        );
        traceUiFreezeHttp('END', label, url, { status: response.status, elapsedMs });
      }
      return response;
    } catch (err) {
      if (isUiFreezeTraceActive()) {
        const elapsedMs = Math.round(
          (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt
        );
        traceUiFreezeHttp('ERROR', label, url, {
          elapsedMs,
          error: String(err?.message || err),
        });
      }
      throw err;
    }
  };
  window.__crUiFreezeFetchProbeInstalled = true;
}

/**
 * @param {{ logger?: { log: (tag: string, message: string, payload?: object) => void } }} [options]
 */
export function initUiFreezeTrace(options = {}) {
  if (initialized || typeof document === 'undefined') return;
  if (!isUiFreezeTraceActive()) return;
  initialized = true;
  logger = options.logger || null;
  installFetchProbe();
  traceUiFreeze('boot', 'trace-ready', {
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 120) : '',
  });
  document.addEventListener('visibilitychange', () => {
    traceUiFreeze('visibility', document.hidden ? 'hidden' : 'visible', {
      visibility: document.visibilityState || 'unknown',
    });
  });
}
