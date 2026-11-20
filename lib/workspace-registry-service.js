/**
 * Workspace registry service shared by the settings routes and the builtin MCP
 * registry tools: the client list with durable route keys, the in-memory
 * GET /api/workspaces cache, and a path lookup used for idempotent adds.
 *
 * Kept free of route/harness imports so the MCP catalog can load it cheaply.
 */

import { buildWorkspacesList } from './workspace-list.js';
import { applyWorkspaceRouteKeys } from './workspace-route-context.js';
import { sanitizeWorkspaces, toPosixPath } from './persist/workspace-registry.js';
import { sanitizeWorkspaceSidebarConfig } from './persist/settings-sidebar.js';

/** @type {{ at: number, key: string, payload: Record<string, any>|null }} */
let workspacesCache = { at: 0, key: '', payload: null };

/**
 * @returns {{ at: number, key: string, payload: Record<string, any>|null }}
 */
export function readWorkspacesCache() {
  return workspacesCache;
}

/**
 * @param {{ at: number, key: string, payload: Record<string, any>|null }} next
 */
export function storeWorkspacesCache(next) {
  workspacesCache = next;
}

/**
 * Drop the in-memory GET /api/workspaces cache.
 */
export function invalidateWorkspacesCache() {
  workspacesCache = { at: 0, key: '', payload: null };
}

/**
 * Build the client workspace list and attach the durable view ids
 * (`workspaceKey` / `folderKey`) beside the legacy fields. Minting new ids
 * mutates `settings`, so the caller persists it when `changed` is true.
 *
 * @param {Record<string, any>} settings
 * @returns {{ list: Array<Record<string, any>>, changed: boolean }}
 */
export function buildWorkspacesListWithRouteKeys(settings) {
  const list = buildWorkspacesList({
    registry: settings.workspaces,
    sidebarConfig: settings.workspaceSidebarConfig,
  });
  const result = applyWorkspaceRouteKeys(settings, list);
  return { list: result.workspaces, changed: result.changed };
}

/**
 * Find a registry row that already covers a path: a file workspace with the
 * same `.code-workspace` file, or any folder workspace whose sidebar overlay
 * lists the folder as enabled.
 *
 * @param {Record<string, any>} settings
 * @param {{ kind: 'file' | 'folders', workspaceFile?: string, folder?: string }} target
 * @returns {import('./persist/workspace-registry.js').WorkspaceRegistryEntry | null}
 */
export function findRegisteredWorkspaceForPath(settings, target) {
  const registry = sanitizeWorkspaces(settings?.workspaces);
  if (target?.kind === 'file') {
    const file = toPosixPath(target.workspaceFile || '');
    if (!file) return null;
    return registry.find((entry) => entry.importedFrom === file || (entry.kind === 'file' && entry.id === file)) || null;
  }
  const folder = toPosixPath(target?.folder || '');
  if (!folder) return null;
  const sidebar = sanitizeWorkspaceSidebarConfig(settings?.workspaceSidebarConfig);
  return registry.find((entry) => {
    if (entry.kind !== 'folders') return false;
    const folders = sidebar[entry.id]?.folders || {};
    return Object.entries(folders).some(
      ([folderPath, meta]) => toPosixPath(folderPath) === folder && meta?.enabled !== false,
    );
  }) || null;
}

/**
 * Registry rows whose sidebar folder list holds `folder` (enabled), any kind.
 *
 * @param {Record<string, any>} settings
 * @param {string} folder
 * @returns {import('./persist/workspace-registry.js').WorkspaceRegistryEntry[]}
 */
export function listRegisteredWorkspacesForFolder(settings, folder) {
  const wanted = toPosixPath(folder || '');
  if (!wanted) return [];
  const sidebar = sanitizeWorkspaceSidebarConfig(settings?.workspaceSidebarConfig);
  return sanitizeWorkspaces(settings?.workspaces).filter((entry) => {
    const folders = sidebar[entry.id]?.folders || {};
    return Object.entries(folders).some(
      ([folderPath, meta]) => toPosixPath(folderPath) === wanted && meta?.enabled !== false,
    );
  });
}

/**
 * The single registry workspace a folder belongs to, or null when it is in none
 * or in several (ambiguous folders are never guessed).
 *
 * @param {Record<string, any>} settings
 * @param {string} folder
 * @returns {import('./persist/workspace-registry.js').WorkspaceRegistryEntry | null}
 */
export function resolveWorkspaceForFolder(settings, folder) {
  const rows = listRegisteredWorkspacesForFolder(settings, folder);
  return rows.length === 1 ? rows[0] : null;
}
