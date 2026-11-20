/**
 * Look up a registry row by any id the workspace is known by: its current id, or
 * (through the SQL workspaces store) its UUID or a former id such as the path of the
 * `.code-workspace` file it was migrated from. Keeps saved chats, links and tool
 * arguments valid after the id changed.
 */

import { findWorkspace, toPosixPath } from './persist/workspace-registry.js';
import { resolveWorkspaceAlias } from './persist/settings.js';

/**
 * @param {unknown} registry settings.workspaces
 * @param {string} ref
 * @param {(ref: string) => string} [resolveAlias] test seam; defaults to the store
 * @returns {import('./persist/workspace-registry.js').WorkspaceRegistryEntry | null}
 */
export function findWorkspaceByRef(registry, ref, resolveAlias = resolveWorkspaceAlias) {
  const direct = findWorkspace(registry, ref);
  if (direct) return direct;
  const raw = String(ref || '').trim();
  if (!raw) return null;
  const resolved = resolveAlias(toPosixPath(raw) || raw);
  return resolved ? findWorkspace(registry, resolved) : null;
}
