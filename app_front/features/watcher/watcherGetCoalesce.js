/**
 * One in-flight GET /api/workspace-watcher per path. Settings, the todo bar,
 * and a pinned-chat status check share the response.
 */

import { cretliApiFetch } from '../../lib/cretliApiRequest.js';
import { getCurrentLang } from '../../i18n/index.js';

/** @type {Map<string, Promise<{ status: number, json: object | null }>>} */
const inflight = new Map();

/**
 * @param {string} path
 * @param {{ method?: string, body?: unknown }} [options]
 * @returns {boolean}
 */
export function isWorkspaceWatcherRead(path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  if (method !== 'GET' || options.body !== undefined) return false;
  const raw = String(path || '');
  return raw === '/api/workspace-watcher' || raw.startsWith('/api/workspace-watcher?');
}

/**
 * @param {string} path
 * @returns {Promise<{ status: number, json: object | null }>}
 */
export function getWorkspaceWatcherView(path) {
  const key = String(path || '/api/workspace-watcher');
  const existing = inflight.get(key);
  if (existing) return existing;
  const promise = (async () => {
    const res = await cretliApiFetch(key, {
      method: 'GET',
      headers: { Accept: 'application/json', 'Accept-Language': getCurrentLang() },
      credentials: 'include',
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  })();
  inflight.set(key, promise);
  promise.finally(() => {
    if (inflight.get(key) === promise) inflight.delete(key);
  });
  return promise;
}
