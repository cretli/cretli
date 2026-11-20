/**
 * One in-flight GET per watcher path (`/api/workspace-watcher*`, runtime-control).
 * Settings, the todo bar, the sidebar toggle and a pinned-chat status check share
 * the response, and a successful answer is reused for a short window so a tab
 * switch re-reads it instead of refetching. Any API write clears the window.
 */

import { cretliApiFetch, onCretliApiWrite } from '../../lib/cretliApiRequest.js';
import { getCurrentLang } from '../../i18n/index.js';

/** @type {Map<string, Promise<{ status: number, json: object | null }>>} */
const inflight = new Map();
const RECENT_TTL_MS = 2000;
/** @type {Map<string, { at: number, promise: Promise<{ status: number, json: object | null }> }>} */
const recent = new Map();
let epoch = 0;

onCretliApiWrite(() => {
  epoch += 1;
  recent.clear();
});

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
  const fresh = recent.get(key);
  if (fresh && Date.now() - fresh.at < RECENT_TTL_MS) return fresh.promise;
  const startedEpoch = epoch;
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
  void promise.then((value) => {
    // A write that landed mid-flight makes the answer stale; error statuses are never reused.
    if (startedEpoch === epoch && value.status >= 200 && value.status < 300) {
      recent.set(key, { at: Date.now(), promise });
    }
  }).catch(() => {}).finally(() => {
    if (inflight.get(key) === promise) inflight.delete(key);
  }).catch(() => {
    // Cleanup chain must not become an unhandled rejection when callers handle `promise`.
  });
  return promise;
}
