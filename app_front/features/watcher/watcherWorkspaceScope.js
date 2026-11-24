/** Workspace folder and request scoping shared by Watcher surfaces. */
import { getViewContextRuntimeScope } from '../../app/appShell/viewContextBridge.js';

/** @returns {string} Active folder from the tab context, then the header picker. */
export function getWatcherWorkspaceFolder() {
  return String(getViewContextRuntimeScope().workspaceFolder || '').trim();
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeWatcherWorkspaceFolder(value) {
  const raw = String(value == null ? '' : value).trim().replace(/\\/g, '/');
  if (!raw) return '';
  const trimmed = raw.replace(/\/+$/, '');
  return trimmed || '/';
}

/**
 * Whether the mounted panel must be rebuilt for a different workspace.
 *
 * An empty active folder is "unknown", not a change: callers wait for scope
 * before fetching, and treating it as a switch would refetch on every
 * tab activation. Trailing-slash/backslash differences are not a switch either.
 *
 * @param {string} renderedFolder
 * @returns {boolean}
 */
export function watcherWorkspaceScopeChanged(renderedFolder) {
  const active = normalizeWatcherWorkspaceFolder(getWatcherWorkspaceFolder());
  if (!active) return false;
  return active !== normalizeWatcherWorkspaceFolder(renderedFolder);
}

/**
 * Attach the active workspace folder to a watcher request.
 *
 * Reads (`GET` without a body) carry it as a query param so the in-flight GET
 * coalescer keys per workspace; writes carry it in the JSON body, which is where
 * `watcherCwd()` (and `todosCwd()`) look first. An explicit folder already in the
 * request is left untouched, and a missing active folder is a no-op; the caller must wait for scope
 * before sending a per-workspace request.
 *
 * @param {string} path
 * @param {{ method?: string, body?: unknown }} [options]
 * @param {string} [folder]
 * @returns {{ path: string, options: { method?: string, body?: unknown } }}
 */
export function scopeWatcherRequestToWorkspace(path, options = {}, folder = '') {
  const target = String(path || '');
  const workspaceFolder = String(folder || '').trim();
  const explicitQuery = /[?&]workspaceFolder=/.test(target);
  const body = options.body && typeof options.body === 'object' ? options.body : null;
  const explicitBody = String(body?.workspaceFolder || '').trim();
  if (!workspaceFolder || explicitQuery || explicitBody) {
    return { path: target, options };
  }
  const method = String(options.method || 'GET').toUpperCase();
  if (method === 'GET' && options.body === undefined) {
    const separator = target.includes('?') ? '&' : '?';
    return {
      path: `${target}${separator}workspaceFolder=${encodeURIComponent(workspaceFolder)}`,
      options,
    };
  }
  return {
    path: target,
    options: { ...options, body: { ...(body || {}), workspaceFolder } },
  };
}
