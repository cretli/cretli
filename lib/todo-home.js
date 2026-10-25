/**
 * Todo home: the single folder that keys a registered workspace's todo list,
 * Workspace Watcher row and worktree namespace.
 *
 * Todos used to be keyed by whatever folder the caller (chat, MCP session,
 * panel) passed, so two chats of one workspace could see different lists and
 * two workspaces pinned to the same folder shared one. The home is derived from
 * the workspace alone (pinned sidebar folder, else first enabled folder, else
 * the workspace file's directory) and must be unique across the registry.
 */

import { loadSettings, resolveWorkspaceAlias } from './persist/settings.js';
import { isFolderWorkspaceId, sanitizeWorkspaces, toPosixPath } from './persist/workspace-registry.js';
import { normalizeFolderPath, resolveWorkspaceCwd } from './workspace-folders.js';
import { findWorkspaceByRef } from './workspace-ref.js';

const NO_HOME = '\0no-todo-home';

export const TODO_HOME_ERROR_CODES = Object.freeze({
  SHARED: 'todo_home_shared',
  WORKSPACE_REQUIRED: 'workspace_required',
});

/**
 * Folders belonging to a registry entry: its stored (enabled) folder list. The
 * optional `loadFileFolders` is an import-time seam; nothing reads a file by default.
 *
 * @param {{ id: string, kind?: string, workspaceFile?: string }} entry
 * @param {Record<string, any>} [sidebarConfig]
 * @param {(file: string) => string[]} [loadFileFolders]
 * @returns {string[]}
 */
export function workspaceFolders(entry, sidebarConfig, loadFileFolders = undefined) {
  /** @type {any[]} */
  const out = [];
  const add = (/** @type {any} */ dir) => {
    const key = normalizeFolderPath(dir);
    if (key && !out.includes(key)) out.push(key);
  };
  const overlay = sidebarConfig?.[entry.id]?.folders;
  if (overlay && typeof overlay === 'object') {
    for (const [dir, meta] of Object.entries(overlay)) {
      if (meta?.enabled !== false) add(dir);
    }
  }
  if (typeof loadFileFolders === 'function' && entry.kind === 'file' && entry.workspaceFile) {
    for (const dir of loadFileFolders(entry.workspaceFile)) add(dir);
  }
  return out;
}

/**
 * Home folder of one workspace (the caller's folder is deliberately ignored).
 *
 * @param {{ id: string }} entry
 * @param {{ registry: unknown, sidebarConfig?: Record<string, any>, existsSet?: Set<string> }} ctx
 * @returns {string}
 */
export function todoHomeOf(entry, ctx) {
  // resolveWorkspaceCwd falls back to the server cwd; a sentinel lets us tell
  // "no usable folder" (home = '') apart from a real folder.
  const resolved = normalizeFolderPath(resolveWorkspaceCwd({
    workspaceId: entry.id,
    registry: ctx.registry,
    sidebarConfig: ctx.sidebarConfig,
    existsSet: ctx.existsSet,
    fallbackCwd: NO_HOME,
  }));
  return resolved === NO_HOME ? '' : resolved;
}

/**
 * Homes shared by more than one registered workspace.
 *
 * @param {unknown} registry
 * @param {Record<string, any>} [sidebarConfig]
 * @param {{ existsSet?: Set<string> }} [opts]
 * @returns {Map<string, string[]>} home -> workspace ids (only entries with 2+)
 */
export function todoHomeConflicts(registry, sidebarConfig, opts = {}) {
  const byHome = new Map();
  for (const entry of sanitizeWorkspaces(registry)) {
    const home = todoHomeOf(entry, { registry, sidebarConfig, existsSet: opts.existsSet });
    if (!home) continue;
    if (!byHome.has(home)) byHome.set(home, []);
    byHome.get(home).push(entry.id);
  }
  for (const [home, ids] of [...byHome]) {
    if (ids.length < 2) byHome.delete(home);
  }
  return byHome;
}

/**
 * Homes that become shared by a sidebar-config change (already-shared homes are
 * not reported, so existing installs can still save unrelated settings).
 *
 * @param {unknown} registry
 * @param {Record<string, any> | undefined} before
 * @param {Record<string, any> | undefined} after
 * @param {{ existsSet?: Set<string> }} [opts]
 * @returns {string[]}
 */
export function findIntroducedSharedHomes(registry, before, after, opts = {}) {
  const had = new Set(todoHomeConflicts(registry, before, opts).keys());
  return [...todoHomeConflicts(registry, after, opts).keys()].filter((home) => !had.has(home));
}

/**
 * Would pinning `folder` as the home of `workspaceId` collide with another
 * workspace's home? Returns the colliding workspace ids.
 *
 * @param {{ registry: unknown, sidebarConfig?: Record<string, any>, workspaceId: string, folder: string, existsSet?: Set<string> }} p
 * @returns {string[]}
 */
export function findPinConflicts(p) {
  const folder = normalizeFolderPath(p.folder);
  if (!folder) return [];
  const next = { ...(p.sidebarConfig || {}), [p.workspaceId]: { ...(p.sidebarConfig?.[p.workspaceId] || {}), folder } };
  const others = [];
  for (const entry of sanitizeWorkspaces(p.registry)) {
    if (entry.id === p.workspaceId) continue;
    if (todoHomeOf(entry, { registry: p.registry, sidebarConfig: next, existsSet: p.existsSet }) === folder) others.push(entry.id);
  }
  return others;
}

/**
 * `workspaceFile` is treated as a registry id: for folder workspaces the UI
 * sends their `cretli:ws:*` id in that field, so both kinds resolve alike.
 *
 * @typedef {{
 *   ok: true,
 *   workspaceId: string,
 *   homeFolder: string,
 *   executionFolder: string,
 *   folders?: string[],
 *   source: 'workspace' | 'unregistered-folder'
 * } | { ok: false, code: string, others?: string[], candidates?: string[] }} TodoHomeResult
 */

/**
 * @param {{ workspaceId?: string, workspaceFile?: string, workspaceFolder?: string }} input
 * @param {{ registry: unknown, sidebarConfig?: Record<string, any>, existsSet?: Set<string>, loadFileFolders?: (file: string) => string[], resolveAlias?: (ref: string) => string }} ctx
 * @returns {TodoHomeResult}
 */
export function resolveTodoHome(input, ctx) {
  const registry = sanitizeWorkspaces(ctx.registry);
  const folder = normalizeFolderPath(input?.workspaceFolder || '');
  const rctx = { registry, sidebarConfig: ctx.sidebarConfig, existsSet: ctx.existsSet };

  let entry = null;
  for (const key of [input?.workspaceId, input?.workspaceFile]) {
    const id = toPosixPath(String(key || '')) || String(key || '').trim();
    if (!id) continue;
    entry = findWorkspaceByRef(registry, id, ctx.resolveAlias || (() => ''));
    if (entry) break;
  }

  if (!entry && folder) {
    const homeOf = registry.filter((e) => todoHomeOf(e, rctx) === folder);
    if (homeOf.length === 1) {
      entry = homeOf[0];
    } else if (homeOf.length > 1) {
      return { ok: false, code: TODO_HOME_ERROR_CODES.SHARED, others: homeOf.map((e) => e.id) };
    } else {
      const containing = registry.filter((e) => workspaceFolders(e, ctx.sidebarConfig, ctx.loadFileFolders).includes(folder));
      if (containing.length === 1) entry = containing[0];
      else if (containing.length > 1) {
        return { ok: false, code: TODO_HOME_ERROR_CODES.WORKSPACE_REQUIRED, candidates: containing.map((e) => e.id) };
      }
    }
  }

  if (!entry) {
    if (!folder) return { ok: false, code: TODO_HOME_ERROR_CODES.WORKSPACE_REQUIRED };
    return { ok: true, workspaceId: '', homeFolder: folder, executionFolder: folder, source: 'unregistered-folder' };
  }

  const homeFolder = todoHomeOf(entry, rctx);
  if (!homeFolder) return { ok: false, code: TODO_HOME_ERROR_CODES.WORKSPACE_REQUIRED };
  const sharing = todoHomeConflicts(registry, ctx.sidebarConfig, { existsSet: ctx.existsSet }).get(homeFolder);
  if (sharing && sharing.includes(entry.id)) {
    return { ok: false, code: TODO_HOME_ERROR_CODES.SHARED, others: sharing.filter((id) => id !== entry.id) };
  }
  const own = workspaceFolders(entry, ctx.sidebarConfig, ctx.loadFileFolders);
  const executionFolder = folder && (folder === homeFolder || own.includes(folder)) ? folder : homeFolder;
  const folders = [homeFolder, ...own.filter((dir) => dir !== homeFolder)];
  return { ok: true, workspaceId: entry.id, homeFolder, executionFolder, folders, source: 'workspace' };
}

/**
 * Resolver bound to the persisted settings.
 *
 * @param {{ workspaceId?: string, workspaceFile?: string, workspaceFolder?: string }} input
 * @returns {TodoHomeResult}
 */
export function resolveTodoHomeFromSettings(input) {
  const settings = loadSettings();
  return resolveTodoHome(input, {
    registry: settings.workspaces,
    sidebarConfig: settings.workspaceSidebarConfig,
    resolveAlias: resolveWorkspaceAlias,
  });
}

/** HTTP status for a failed resolution. */
export function todoHomeErrorStatus(/** @type {any} */ result) {
  return result && result.ok === false ? 409 : 200;
}

export { isFolderWorkspaceId };
