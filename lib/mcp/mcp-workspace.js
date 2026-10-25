/**
 * Match MCP scope against workspace identity (registry id, file, or folder).
 */

import { loadSettings } from '../persist/settings.js';
import { isFolderWorkspaceId, toPosixPath } from '../persist/workspace-registry.js';

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeWorkspaceKey(value) {
  return toPosixPath(String(value || '').trim()) || String(value || '').trim();
}

/**
 * @param {{
 *   workspaceId?: unknown,
 *   workspaceFile?: unknown,
 *   workspaceFolder?: unknown,
 * }} context
 * @returns {Set<string>}
 */
export function collectWorkspaceIdentityKeys(context) {
  const keys = new Set();
  const add = (value) => {
    const key = normalizeWorkspaceKey(value);
    if (key) keys.add(key);
  };
  add(context?.workspaceId);
  add(context?.workspaceFile);
  add(context?.workspaceFolder);
  const settings = loadSettings();
  const registry = Array.isArray(settings.workspaces) ? settings.workspaces : [];
  const sidebar = settings.workspaceSidebarConfig && typeof settings.workspaceSidebarConfig === 'object'
    ? settings.workspaceSidebarConfig
    : {};
  for (const entry of registry) {
    if (!entry || typeof entry !== 'object') continue;
    const id = normalizeWorkspaceKey(entry.id);
    if (!id) continue;
    const file = normalizeWorkspaceKey(entry.workspaceFile);
    const side = sidebar[id] && typeof sidebar[id] === 'object' ? sidebar[id] : {};
    const folder = normalizeWorkspaceKey(side.folder);
    const sideFile = normalizeWorkspaceKey(side.workspaceFile);
    const matches = [...keys].some((key) => key === id || key === file || key === folder || key === sideFile);
    if (!matches) continue;
    add(id);
    add(file);
    add(folder);
    add(sideFile);
  }
  return keys;
}

/**
 * @param {unknown} scope
 * @param {Set<string>} identityKeys
 * @returns {boolean}
 */
export function mcpScopeMatchesWorkspace(scope, identityKeys) {
  if (scope === 'all' || scope == null) return true;
  if (!Array.isArray(scope) || scope.length === 0) return false;
  return scope.some((item) => identityKeys.has(normalizeWorkspaceKey(item)));
}

/**
 * @param {unknown} id
 * @returns {boolean}
 */
export function isKnownWorkspaceIdShape(id) {
  const value = String(id || '').trim();
  if (!value) return false;
  if (isFolderWorkspaceId(value)) return true;
  return value.includes('/') || value.endsWith('.code-workspace');
}
