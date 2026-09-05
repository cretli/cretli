/**
 * Shared headers for same-origin Cretli `/api/` requests (CSRF, widget bearer).
 * External URLs must not receive these headers.
 */

export const CRETILI_CSRF_HEADER = 'X-Cretli-Csrf';
const AUTH_STATUS_PATH = '/api/auth-status';

let widgetAccessToken = '';
let csrfToken = '';
let csrfRefreshPromise = null;

/**
 * @param {string} token
 * @returns {void}
 */
export function setWidgetAccessToken(token) {
  widgetAccessToken = typeof token === 'string' ? token.trim() : '';
}

/**
 * @returns {string}
 */
export function getWidgetAccessToken() {
  return widgetAccessToken;
}

/**
 * @param {string} token
 * @returns {void}
 */
export function setCsrfToken(token) {
  csrfToken = typeof token === 'string' ? token.trim() : '';
}

/**
 * @returns {string}
 */
export function getCsrfToken() {
  return csrfToken;
}

/**
 * Stores a session CSRF token from `/api/auth-status` or login. Clears memory
 * when the payload shows no session token.
 * @param {object|null|undefined} payload
 * @returns {void}
 */
export function applyCsrfFromAuthPayload(payload) {
  const token = payload && typeof payload.csrfToken === 'string' ? payload.csrfToken.trim() : '';
  setCsrfToken(token);
}

/**
 * @param {string} url
 * @param {string} [pageOrigin]
 * @returns {URL|null}
 */
function parseApiUrl(url, pageOrigin = '') {
  const value = String(url || '').trim();
  if (!value) return null;
  const origin = pageOrigin
    || (typeof window !== 'undefined' && window.location?.origin ? window.location.origin : '');
  try {
    if (value.startsWith('/')) {
      return new URL(value, origin || 'http://cretli.local');
    }
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * @param {string} url
 * @param {string} [pageOrigin]
 * @returns {boolean}
 */
export function isCretliApiUrl(url, pageOrigin = '') {
  const value = String(url || '').trim();
  if (!value) return false;
  if (value.startsWith('/api/') || value === '/api') return true;
  const origin = pageOrigin
    || (typeof window !== 'undefined' && window.location?.origin ? window.location.origin : '');
  const parsed = parseApiUrl(value, pageOrigin);
  if (!parsed) return false;
  if (parsed.pathname !== '/api' && !parsed.pathname.startsWith('/api/')) return false;
  if (!origin) return false;
  try {
    return parsed.origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

/**
 * @param {string} url
 * @param {string} [pageOrigin]
 * @returns {boolean}
 */
function isAuthStatusUrl(url, pageOrigin = '') {
  const parsed = parseApiUrl(url, pageOrigin);
  return !!parsed && parsed.pathname === AUTH_STATUS_PATH;
}

/**
 * @param {{ extra?: HeadersInit, url?: string, acceptLanguage?: string, pageOrigin?: string }} [options]
 * @returns {Record<string, string>}
 */
export function buildCretliApiHeaders(options = {}) {
  const extra = options.extra;
  const headers = {};
  if (typeof extra?.forEach === 'function') {
    extra.forEach((value, key) => {
      headers[key] = value;
    });
  } else if (Array.isArray(extra)) {
    for (const pair of extra) {
      if (!Array.isArray(pair) || pair.length < 2) continue;
      headers[String(pair[0])] = String(pair[1]);
    }
  } else if (extra) {
    Object.assign(headers, extra);
  }
  if (!isCretliApiUrl(options.url || '/api/', options.pageOrigin)) return headers;
  if (options.acceptLanguage) headers['Accept-Language'] = options.acceptLanguage;
  if (widgetAccessToken) headers.Authorization = `Bearer ${widgetAccessToken}`;
  if (csrfToken) headers[CRETILI_CSRF_HEADER] = csrfToken;
  else delete headers[CRETILI_CSRF_HEADER];
  return headers;
}

/**
 * @param {Response} response
 * @returns {Promise<boolean>}
 */
async function isExplicitCsrfRequired(response) {
  if (response.status !== 403) return false;
  let payload;
  try {
    payload = await response.clone().json();
  } catch {
    return false;
  }
  return payload?.csrfRequired === true;
}

/**
 * @param {{ acceptLanguage?: string, pageOrigin?: string }} [options]
 * @returns {Promise<boolean>}
 */
function refreshCsrfTokenShared(options = {}) {
  if (csrfRefreshPromise) return csrfRefreshPromise;
  csrfRefreshPromise = (async () => {
    const response = await cretliApiFetch(AUTH_STATUS_PATH, { cache: 'no-store' }, {
      ...options,
      skipCsrfRetry: true,
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    applyCsrfFromAuthPayload(payload);
    return !!getCsrfToken();
  })().finally(() => {
    csrfRefreshPromise = null;
  });
  return csrfRefreshPromise;
}

/**
 * Fetch wrapper for Cretli API calls. Keeps caller `keepalive` and other init fields.
 * Does not attach CSRF or credentials to third-party URLs.
 * @param {string} url
 * @param {RequestInit} [init]
 * @param {{ acceptLanguage?: string, pageOrigin?: string, skipCsrfRetry?: boolean }} [options]
 * @returns {Promise<Response>}
 */
export async function cretliApiFetch(url, init = {}, options = {}) {
  const next = { ...init };
  const isApi = isCretliApiUrl(url, options.pageOrigin);
  if (isApi && next.credentials == null) next.credentials = 'include';
  next.headers = buildCretliApiHeaders({
    extra: init.headers,
    url,
    acceptLanguage: options.acceptLanguage,
    pageOrigin: options.pageOrigin,
  });
  const response = await fetch(url, next);
  if (response.status === 401 && isApi) applyCsrfFromAuthPayload(null);
  const canRetry = isApi
    && options.skipCsrfRetry !== true
    && !isAuthStatusUrl(url, options.pageOrigin);
  if (!canRetry) return response;
  if (!await isExplicitCsrfRequired(response)) return response;
  const refreshed = await refreshCsrfTokenShared(options);
  if (!refreshed) return response;
  return cretliApiFetch(url, init, { ...options, skipCsrfRetry: true });
}
