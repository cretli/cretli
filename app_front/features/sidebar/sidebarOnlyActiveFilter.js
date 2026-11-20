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
import { isChatArchived } from '../../../lib/chat-tree.js';
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
 *   keepWorkspace?: (workspace: any) => boolean,
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
  const keep = typeof params.keepWorkspace === 'function' ? params.keepWorkspace : () => false;
  const matched = rows.filter((workspace) => workspaceGroupFolder(workspace, wanted) === activeFolder
    || keep(workspace));
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

export const SIDEBAR_ONLY_LIVE_CHATS_KEY = 'cretli-sidebar-only-live-chats';

/**
 * @returns {boolean}
 */
export function readSidebarOnlyLiveChatsFlag() {
  if (typeof localStorage === 'undefined') return false;
  try {
    return readStorageValueWithAlias(localStorage, SIDEBAR_ONLY_LIVE_CHATS_KEY, '') === '1';
  } catch (_) {
    return false;
  }
}

/**
 * @param {boolean} value
 * @returns {void}
 */
export function writeSidebarOnlyLiveChatsFlag(value) {
  if (typeof localStorage === 'undefined') return;
  try {
    writeStorageValueWithAlias(localStorage, SIDEBAR_ONLY_LIVE_CHATS_KEY, value ? '1' : '0');
  } catch (_) {}
}

/**
 * Keep chats with live harness work, the open chat and their fork ancestors, so
 * a running subchat stays nested and the chat in use never disappears under the
 * user. Archived rows pass through: the archive section has its own list.
 *
 * @param {any[]} chats
 * @param {{ isLive: (chat: any) => boolean, activeChatId?: string, keepIds?: Set<string> }} params
 * @returns {any[]}
 */
export function filterChatsToLive(chats, params) {
  const rows = Array.isArray(chats) ? chats : [];
  const pinned = params.keepIds instanceof Set ? params.keepIds : null;
  const byId = new Map(rows.map((chat) => [chat?.id, chat]));
  const keep = new Set();
  for (const chat of rows) {
    if (!params.isLive(chat) && chat?.id !== params.activeChatId && !pinned?.has(chat?.id)) continue;
    let cursor = chat;
    while (cursor && !keep.has(cursor.id)) {
      keep.add(cursor.id);
      cursor = byId.get(cursor.forkParentChatId);
    }
  }
  return rows.filter((chat) => keep.has(chat?.id) || isChatArchived(chat));
}

/**
 * Drop workspace groups with nothing left to show under the live-chats filter.
 * The active workspace stays so its new-chat action remains reachable, and a
 * result with no groups falls back to all of them.
 *
 * @param {any[]} workspaces
 * @param {{
 *   enabled: boolean,
 *   hasChats: (workspace: any) => boolean,
 *   keepWorkspace?: (workspace: any) => boolean,
 *   activeWorkspaceFolder: string,
 *   getPreferredWorkspaceFolder: (sidebarKey: string) => string,
 * }} params
 * @returns {any[]}
 */
export function dropWorkspacesWithoutLiveChats(workspaces, params) {
  const rows = Array.isArray(workspaces) ? workspaces : [];
  if (!params.enabled) return rows;
  const activeFolder = normalizeWorkspacePath(params.activeWorkspaceFolder || '');
  const kept = rows.filter((workspace) => params.hasChats(workspace)
    || (typeof params.keepWorkspace === 'function' && params.keepWorkspace(workspace))
    || workspaceGroupFolder(workspace, params.getPreferredWorkspaceFolder) === activeFolder);
  return kept.length ? kept : rows;
}

/** How long after the last open/send/output a chat still counts as "in use". */
export const SIDEBAR_RECENT_USE_WINDOW_MS = 30 * 60 * 1000;

/**
 * Chat the user is working with right now: live harness work, or opened / written
 * to / producing output within the recent-use window.
 *
 * @param {any} chat
 * @param {{ isLive: (chat: any) => boolean, getActivityAt: (chat: any) => number, now?: number }} deps
 * @returns {boolean}
 */
export function isChatInActiveUse(chat, deps) {
  if (deps.isLive(chat)) return true;
  const at = deps.getActivityAt(chat);
  const now = Number.isFinite(deps.now) ? /** @type {number} */ (deps.now) : Date.now();
  return at > 0 && now - at <= SIDEBAR_RECENT_USE_WINDOW_MS;
}

/**
 * The open chat plus every fork ancestor (across workspaces): these rows, and
 * the workspace groups holding them, must survive every sidebar filter.
 *
 * @param {any[]} chats
 * @param {string} activeChatId
 * @returns {Set<string>}
 */
export function collectActiveChatChain(chats, activeChatId) {
  const chain = new Set();
  const byId = new Map((Array.isArray(chats) ? chats : []).map((chat) => [chat?.id, chat]));
  let cursor = activeChatId ? byId.get(activeChatId) : null;
  while (cursor && !chain.has(cursor.id)) {
    chain.add(cursor.id);
    cursor = cursor.forkParentChatId ? byId.get(cursor.forkParentChatId) : null;
  }
  return chain;
}
