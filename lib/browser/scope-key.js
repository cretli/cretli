// Lightweight on purpose: the session manager, agent tools and storage state
// import it without the settings stack.
import path from 'path';
import { FOLDER_WORKSPACE_PREFIX } from '../persist/workspace-registry.js';

/**
 * Normalizes a workspace key for the Browser stores. A `cretli:ws:` id is an
 * opaque registry id and is returned unchanged (resolving it against the
 * server cwd made the key depend on where the server started); any other key
 * becomes an absolute path. An empty value stays empty so callers fail closed.
 *
 * @param {unknown} workspaceKey
 * @returns {string}
 */
export function normalizeWorkspaceKey(workspaceKey) {
  const raw = String(workspaceKey ?? '').trim();
  if (!raw) return '';
  if (raw.startsWith(FOLDER_WORKSPACE_PREFIX)) return raw;
  return path.resolve(raw);
}

/**
 * The one runtime scope -> policy key rule shared by the Browser agent tools,
 * the session manager and the Claude Chrome check: a workspace file/id wins,
 * then the chat folder, then the working directory. A folder only decides the
 * key for folder-only scopes, so a chat with a workspace always reads the
 * workspace entry.
 *
 * @param {{ workspaceFile?: unknown, workspaceFolder?: unknown, cwd?: unknown } | null | undefined} scope
 * @returns {string}
 */
export function browserScopeKey(scope) {
  return String(scope?.workspaceFile || '').trim()
    || String(scope?.workspaceFolder || '').trim()
    || String(scope?.cwd || '').trim();
}
