/**
 * "Active workspace only" sidebar filter.
 *
 * The flag is per browser (localStorage with the legacy-key alias reader), the
 * filter itself is a pure function so the two `visibleWorkspaces` call sites
 * in sidebarView and the unit tests share one implementation. While a search
 * is active the filter is suspended: search spans every workspace and an AND
 * combination would silently drop results.
 */

import { readStorageValueWithAlias, writeStorageValueWithAlias } from '../../lib/storageKeyAlias.js';
import { normalizeWorkspacePath } from './workspaceChatMatch.js';

export const SIDEBAR_ONLY_ACTIVE_WORKSPACE_KEY = 'cretli-sidebar-only-active-workspace';

/**
 * @returns {boolean}
 */
export function readSidebarOnlyActiveWorkspaceFlag() {
  if (typeof localStorage === 'undefined') return false;
  try {
    return readStorageValueWithAlias(localStorage, SIDEBAR_ONLY_ACTIVE_WORKSPACE_KEY, '') === '1';
  } catch (_) {
    return false;
  }
}

/**
 * @param {boolean} value
 * @returns {void}
 */
export function writeSidebarOnlyActiveWorkspaceFlag(value) {
  if (typeof localStorage === 'undefined') return;
  try {
    writeStorageValueWithAlias(localStorage, SIDEBAR_ONLY_ACTIVE_WORKSPACE_KEY, value ? '1' : '0');
  } catch (_) {}
}

/**
 * @param {object | null | undefined} workspace
 * @param {(sidebarKey: string) => string} getPreferredWorkspaceFolder
 * @returns {string} folder the workspace group resolves to (preferred wins)
 */
export function workspaceGroupFolder(workspace, getPreferredWorkspaceFolder) {
  const sidebarKey = workspace?.sidebarKey || workspace?.workspaceFile || '';
  const preferred =
    typeof getPreferredWorkspaceFolder === 'function'
      ? getPreferredWorkspaceFolder(sidebarKey)
      : '';
  return normalizeWorkspacePath(preferred || workspace?.workspaceFolder || workspace?.workspaceDir || '');
}

/**
 * Keep only workspace groups whose resolved folder is the active one.
 *
 * @param {object[]} workspaces ordered workspace rows
 * @param {{
 *   activeWorkspaceFolder: string,
 *   searching: boolean,
 *   enabled: boolean,
 *   getPreferredWorkspaceFolder: (sidebarKey: string) => string,
 * }} params
 * @returns {{ workspaces: object[], applied: boolean, fallback: boolean }}
 *   `applied` is false when the filter is off or suspended by a search;
 *   `fallback` is true when the filter was on but matched no group, so the
 *   caller shows every workspace instead of an empty sidebar.
 */
export function filterWorkspacesByActiveWorkspace(workspaces, params = {}) {
  const rows = Array.isArray(workspaces) ? workspaces : [];
  const activeFolder = normalizeWorkspacePath(params.activeWorkspaceFolder || '');
  if (!params.enabled || params.searching || !activeFolder) {
    return { workspaces: rows, applied: false, fallback: false };
  }
  const wanted = typeof params.getPreferredWorkspaceFolder === 'function'
    ? params.getPreferredWorkspaceFolder
    : () => '';
  const matched = rows.filter((workspace) => workspaceGroupFolder(workspace, wanted) === activeFolder);
  if (matched.length > 0) {
    return { workspaces: matched, applied: true, fallback: false };
  }
  // The active workspace is not a group in the catalog (stale folder, disabled
  // clone): showing nothing would look like data loss, so show everything.
  return { workspaces: rows, applied: false, fallback: true };
}

export const SIDEBAR_ONLY_WORKTREE_KEY = 'cretli-sidebar-only-worktree';

/**
 * @returns {boolean}
 */
export function readSidebarOnlyWorktreeFlag() {
  if (typeof localStorage === 'undefined') return false;
  try {
    return readStorageValueWithAlias(localStorage, SIDEBAR_ONLY_WORKTREE_KEY, '') === '1';
  } catch (_) {
    return false;
  }
}

/**
 * @param {boolean} value
 * @returns {void}
 */
export function writeSidebarOnlyWorktreeFlag(value) {
  if (typeof localStorage === 'undefined') return;
  try {
    writeStorageValueWithAlias(localStorage, SIDEBAR_ONLY_WORKTREE_KEY, value ? '1' : '0');
  } catch (_) {}
}

/**
 * Root todo id of the worktree the chat runs in (`onWorktree` is set by the
 * server only for live worktrees), or '' when the chat is not on a worktree.
 *
 * @param {object | null | undefined} chat
 * @returns {string}
 */
export function chatWorktreeTodoId(chat) {
  if (!chat || chat.onWorktree !== true) return '';
  return String(chat.todoId || '').trim();
}

/**
 * Keep only chats that belong to the given worktree (same root todo id, which
 * delegated children inherit). An empty id leaves the list untouched.
 *
 * @param {object[]} chats
 * @param {string} worktreeTodoId
 * @returns {object[]}
 */
export function filterChatsByWorktree(chats, worktreeTodoId) {
  const rows = Array.isArray(chats) ? chats : [];
  const wanted = String(worktreeTodoId || '').trim();
  if (!wanted) return rows;
  return rows.filter((chat) => String(chat?.todoId || '').trim() === wanted);
}
