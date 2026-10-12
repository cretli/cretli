/**
 * Workspace route context: mint durable ids for the workspace list and resolve
 * an id from a view URL back into a workspace + folder, validating membership.
 *
 * The URL only ever carries opaque ids (`ws=`, `folder=`); paths stay inside the
 * server. Resolution is read-only — ids are registered when the registry or a
 * folder is added/discovered, never from an arbitrary URL, so a hand-crafted
 * `ws=` cannot onboard a folder the operator has not registered.
 */

import fs from 'fs';
import path from 'path';
import { sanitizeWorkspaceSidebarConfig } from './persist/settings-sidebar.js';
import { isFolderWorkspaceId, sanitizeWorkspaces, toPosixPath } from './persist/workspace-registry.js';
import {
  findFolderByRouteKey,
  findWorkspaceByRouteKey,
  folderRouteKey,
  isWorkspaceRouteId,
  pruneWorkspaceRouteKeys,
  sanitizeWorkspaceRouteKeys,
  workspaceRouteKey,
} from './persist/workspace-route-keys.js';

const CLONE_KEY_SEPARATOR = '#clone-';

/**
 * Sidebar keys that belong to a workspace: its own entry plus every clone row
 * (`<id>#clone-<label>`) created from it.
 *
 * @param {Record<string, object>} sidebar
 * @param {string} workspaceId
 * @returns {Array<[string, object]>}
 */
/**
 * Client folder row for a sidebar-registered path (main overlay or clone row).
 *
 * @param {object} settings
 * @param {string} workspaceId
 * @param {string} folderPath
 * @returns {object|null}
 */
function clientFolderFromSidebar(settings, workspaceId, folderPath) {
  const sidebar = sanitizeWorkspaceSidebarConfig(settings?.workspaceSidebarConfig);
  const resolved = toPosixPath(folderPath);
  if (!resolved) return null;
  for (const [, entry] of sidebarEntriesForWorkspace(sidebar, workspaceId)) {
    const meta = entry?.folders?.[resolved];
    if (!meta) continue;
    return {
      name: typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : path.posix.basename(resolved),
      path: resolved,
      resolvedPath: resolved,
      exists: true,
      source: meta.source,
      enabled: meta.enabled !== false,
    };
  }
  return null;
}

function sidebarEntriesForWorkspace(sidebar, workspaceId) {
  const id = String(workspaceId || '').trim();
  if (!id) return [];
  const clonePrefix = `${id}${CLONE_KEY_SEPARATOR}`;
  return Object.entries(sidebar).filter(([key]) => key === id || key.startsWith(clonePrefix));
}

/**
 * Folder paths a workspace offers: the sidebar overlay (including clones, so a
 * clone directory is addressable) plus the folders read from the file itself.
 *
 * @param {object} settings
 * @param {string} workspaceId
 * @param {{ loadWorkspaceFn?: (file: string) => { folders?: Array<{ resolvedPath?: string }> } | null }} [options]
 * @returns {string[]}
 */
export function workspaceRouteFolderPaths(settings, workspaceId, options = {}) {
  const sidebar = sanitizeWorkspaceSidebarConfig(settings?.workspaceSidebarConfig);
  const paths = [];
  const seen = new Set();
  const push = (raw) => {
    const value = toPosixPath(raw);
    if (!value || seen.has(value)) return;
    seen.add(value);
    paths.push(value);
  };
  for (const [, entry] of sidebarEntriesForWorkspace(sidebar, workspaceId)) {
    for (const folderPath of Object.keys(entry?.folders || {})) push(folderPath);
  }
  const loadWorkspaceFn = typeof options.loadWorkspaceFn === 'function' ? options.loadWorkspaceFn : null;
  if (loadWorkspaceFn && !isFolderWorkspaceId(workspaceId)) {
    const loaded = loadWorkspaceFn(workspaceId);
    for (const folder of Array.isArray(loaded?.folders) ? loaded.folders : []) push(folder?.resolvedPath);
  }
  return paths;
}

/**
 * Attach `workspaceKey` / `folderKey` to the client workspace list and persist
 * whatever ids had to be minted. Legacy fields are untouched, so every existing
 * API consumer and saved chat keeps working.
 *
 * @param {object} settings
 * @param {Array<object>} list result of buildWorkspacesList()
 * @returns {{ workspaces: Array<object>, changed: boolean }}
 */
export function applyWorkspaceRouteKeys(settings, list) {
  const store = sanitizeWorkspaceRouteKeys(settings?.workspaceRouteKeys);
  const before = JSON.stringify(store);
  const rows = Array.isArray(list) ? list : [];
  const pathsByWorkspaceKey = new Map();
  const workspaces = rows.map((row) => {
    const workspaceKey = workspaceRouteKey(store, { id: row.id, kind: row.kind });
    const paths = new Set(workspaceRouteFolderPaths(settings, row.id));
    // Every folder the client is offered must be addressable, including one a
    // .code-workspace file just added before the sidebar overlay caught up.
    for (const folder of Array.isArray(row.folders) ? row.folders : []) {
      const resolved = toPosixPath(folder?.resolvedPath);
      if (resolved) paths.add(resolved);
    }
    const keyByPath = {};
    if (workspaceKey) {
      for (const folderPath of paths) keyByPath[folderPath] = folderRouteKey(store, workspaceKey, folderPath);
      pathsByWorkspaceKey.set(workspaceKey, paths);
    }
    const decoratedByPath = new Map();
    const baseFolders = Array.isArray(row.folders) ? row.folders : [];
    for (const folder of baseFolders) {
      const resolved = toPosixPath(folder?.resolvedPath);
      if (!resolved || decoratedByPath.has(resolved)) continue;
      decoratedByPath.set(resolved, {
        ...folder,
        folderKey: keyByPath[resolved] || '',
      });
    }
    for (const folderPath of paths) {
      const resolved = toPosixPath(folderPath);
      if (!resolved || decoratedByPath.has(resolved)) continue;
      const fromSidebar = clientFolderFromSidebar(settings, row.id, resolved);
      if (!fromSidebar) continue;
      decoratedByPath.set(resolved, {
        ...fromSidebar,
        folderKey: keyByPath[resolved] || '',
      });
    }
    const folders = Array.from(decoratedByPath.values());
    return { ...row, workspaceKey, folders };
  });
  pruneWorkspaceRouteKeys(store, settings?.workspaces, (workspaceKey, folderPath) => {
    const paths = pathsByWorkspaceKey.get(workspaceKey);
    return paths ? paths.has(toPosixPath(folderPath)) : true;
  });
  const changed = JSON.stringify(store) !== before;
  if (changed) settings.workspaceRouteKeys = store;
  return { workspaces, changed };
}

/**
 * @typedef {{
 *   ok: boolean,
 *   error: string,
 *   workspace: { workspaceKey: string, id: string, kind: string, workspaceFile: string } | null,
 *   folder: { folderKey: string, resolvedPath: string, name: string, enabled: boolean, exists: boolean } | null
 * }} WorkspaceRouteContext
 */

/**
 * @param {string} folderPath
 * @returns {boolean}
 */
function folderExists(folderPath) {
  try {
    return fs.existsSync(folderPath) && fs.statSync(folderPath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve the durable ids of a view URL into a server-side context.
 *
 * Rejections are explicit and never fall back to a similar project:
 * `workspace-unknown` (id not registered, e.g. removed), `folder-unknown`
 * (id never minted), `folder-not-in-workspace` (the folder belongs to another
 * workspace), `folder-unavailable` (registered but currently missing).
 *
 * @param {object} settings
 * @param {{ workspaceKey?: unknown, folderKey?: unknown }} ids
 * @param {{ existsFn?: (folderPath: string) => boolean, loadWorkspaceFn?: Function|null }} [options]
 * @returns {WorkspaceRouteContext}
 */
export function resolveWorkspaceRouteContext(settings, ids, options = {}) {
  const fail = (error, workspace = null, folder = null) => ({ ok: false, error, workspace, folder });
  const workspaceKey = typeof ids?.workspaceKey === 'string' ? ids.workspaceKey.trim() : '';
  const folderKey = typeof ids?.folderKey === 'string' ? ids.folderKey.trim() : '';
  // No explicit context in the URL: the caller keeps its local/default context.
  if (!workspaceKey && !folderKey) return { ok: true, error: '', workspace: null, folder: null };
  if (workspaceKey && !isFolderWorkspaceId(workspaceKey) && !isWorkspaceRouteId(workspaceKey)) {
    return fail('workspace-unknown');
  }
  const store = sanitizeWorkspaceRouteKeys(settings?.workspaceRouteKeys);
  const registry = sanitizeWorkspaces(settings?.workspaces);
  const workspace = findWorkspaceByRouteKey(store, registry, workspaceKey);
  if (!workspace) return fail('workspace-unknown');
  const resolvedWorkspace = {
    workspaceKey,
    id: workspace.id,
    kind: workspace.kind,
    workspaceFile: workspace.workspaceFile,
  };
  if (!folderKey) return { ok: true, error: '', workspace: resolvedWorkspace, folder: null };

  const candidates = workspaceRouteFolderPaths(settings, workspace.id, {
    loadWorkspaceFn: typeof options.loadWorkspaceFn === 'function' ? options.loadWorkspaceFn : null,
  });
  const matchedPath = findFolderByRouteKey(store, workspaceKey, folderKey, candidates);
  if (!matchedPath) {
    const otherWorkspace = Object.keys(store.folders || {}).some((key) => {
      if (key === workspaceKey) return false;
      return Object.values(store.folders[key] || {}).includes(folderKey);
    });
    return fail(otherWorkspace ? 'folder-not-in-workspace' : 'folder-unknown', resolvedWorkspace);
  }
  const sidebar = sanitizeWorkspaceSidebarConfig(settings?.workspaceSidebarConfig);
  let name = path.posix.basename(matchedPath);
  let enabled = true;
  for (const [, entry] of sidebarEntriesForWorkspace(sidebar, workspace.id)) {
    const meta = entry?.folders?.[matchedPath];
    if (!meta) continue;
    if (typeof meta.name === 'string' && meta.name.trim()) name = meta.name.trim();
    if (meta.enabled === false) enabled = false;
  }
  const existsFn = typeof options.existsFn === 'function' ? options.existsFn : folderExists;
  const exists = existsFn(matchedPath) === true;
  const folder = { folderKey, resolvedPath: matchedPath, name, enabled, exists };
  if (!exists) return fail('folder-unavailable', resolvedWorkspace, folder);
  return { ok: true, error: '', workspace: resolvedWorkspace, folder };
}
