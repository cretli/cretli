/**
 * Workspace scope for the Workspace Watcher surfaces.
 *
 * The watcher is keyed by the normalized workspace folder. Every request that
 * does not name one falls back on the server's global "current cwd", which is
 * the workspace the server was last switched to — not necessarily the one the
 * operator is looking at (a chat can carry a different workspace, and the
 * settings panel stays mounted across workspace switches). The settings form and
 * the todo top bar therefore read the active folder off the header workspace
 * trigger and attach it to every watcher request, the same way the usage and
 * delegation panels scope their stats.
 */

/**
 * Active workspace folder as shown by the header workspace picker.
 * Empty before the boot settings resolve; callers then keep the server default.
 *
 * @returns {string}
 */
export function getWatcherWorkspaceFolder() {
  if (typeof document === 'undefined') return '';
  const trigger = document.getElementById('header-workspace-trigger');
  return String(trigger?.dataset?.workspaceFolder || '').trim();
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
 * An empty active folder is "unknown", not a change: the server default is the
 * only scope available then, and treating it as a switch would refetch on every
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
 * request is left untouched, and a missing active folder is a no-op so the
 * request still reaches the server default instead of being dropped.
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
