/**
 * Move a todo subtree to another workspace folder.
 *
 * Todos are stored per workspace folder, so a tree created in the wrong
 * workspace is invisible from the right one. This moves a tree that has not
 * started any work yet: no delegation, worktree, claim, `doing` leaf,
 * integration or leaf material. Anything with run history stays where its
 * delegations, workflow rows and worktree records point.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadTodosData, moveTodoDocuments, workspaceKeyFromCwd } from './todos-legacy-adapter.js';
import { loadChats, updateChat } from './chats-persist.js';
import { withWorkspaceWatchersFileLock } from './workspace-watchers-persist.js';
import { listDelegationsForWorkspace } from './delegations-persist.js';
import { readDelegationWorkflowLeafIdFromRow } from '../delegation-workflow-leaf.js';
import { readLiveWorktreeRecord } from '../todo-worktree-manual.js';
import { collectTodoSubtreeIds } from '../todo-tree.js';
import { loadSettings } from './settings.js';
import { toPosixPath } from './workspace-registry.js';
import { findWorkspaceByRef } from '../workspace-ref.js';
import { resolveWorkspaceCwd } from '../workspace-folders.js';

/**
 * @typedef {{
 *   id: string,
 *   title?: string,
 *   status?: string,
 *   parentId?: string,
 *   claimedByChatId?: string,
 *   integration?: { state?: string },
 *   leafMaterial?: { baseCapturedAt?: string },
 *   changelog?: any[],
 *   updatedAt?: string,
 * }} MovableTodo
 */

export const TODO_MOVE_ERROR_CODES = Object.freeze({
  VALIDATION: 'VALIDATION',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  HAS_HISTORY: 'HAS_HISTORY',
});

/**
 * @param {string} code
 * @param {string} message
 * @param {string[]} [reasons]
 * @returns {Error & { code: string, reasons?: string[] }}
 */
export function createMoveError(code, message, reasons) {
  const err = /** @type {Error & { code: string, reasons?: string[] }} */ (new Error(message));
  err.code = code;
  if (reasons) err.reasons = reasons;
  return err;
}

/**
 * Reasons the subtree cannot move, one line per blocking item.
 *
 * @param {{ dataDir: string, sourceFolder: string, items: MovableTodo[], ids: Set<string> }} input
 * @returns {string[]}
 */
export function listMoveBlockers({ dataDir, sourceFolder, items, ids }) {
  const reasons = [];
  for (const item of items) {
    const label = `${item.id} "${String(item.title || '').slice(0, 60)}"`;
    if (item.status === 'doing') reasons.push(`${label}: status doing`);
    if (String(item.claimedByChatId || '').trim()) reasons.push(`${label}: claimed by a chat`);
    if (String(item.integration?.state || '').trim()) reasons.push(`${label}: has integration state`);
    if (item.leafMaterial?.baseCapturedAt) reasons.push(`${label}: has leaf material from a run`);
    if (readLiveWorktreeRecord(item.id, dataDir)) reasons.push(`${label}: has a live worktree`);
  }
  const delegations = listDelegationsForWorkspace(sourceFolder)
    .filter((row) => ids.has(readDelegationWorkflowLeafIdFromRow(row)));
  if (delegations.length > 0) reasons.push(`${delegations.length} delegation(s) reference this tree`);
  return reasons;
}

/**
 * A registered workspace (a `.code-workspace` file or a folder-workspace id)
 * stores its todos in the folder its chats and todo panel run in: the pinned
 * default folder, not the first folder of the file. Resolve it the same way.
 *
 * @param {string} value
 * @returns {string}
 */
function resolveRegisteredWorkspaceFolder(value) {
  const settings = loadSettings();
  const entry = findWorkspaceByRef(settings.workspaces, toPosixPath(value));
  if (!entry) return value;
  return resolveWorkspaceCwd({
    workspaceId: entry.id,
    registry: settings.workspaces,
    sidebarConfig: settings.workspaceSidebarConfig,
    fallbackCwd: value,
  });
}

/**
 * @param {string} folder
 * @returns {string}
 */
export function requireTargetFolder(folder) {
  const value = resolveRegisteredWorkspaceFolder(String(folder || '').trim());
  if (!value || !path.isAbsolute(value)) {
    throw createMoveError(TODO_MOVE_ERROR_CODES.VALIDATION, 'target workspace folder must be an absolute path');
  }
  if (!fs.existsSync(value) || !fs.statSync(value).isDirectory()) {
    throw createMoveError(TODO_MOVE_ERROR_CODES.VALIDATION, `target workspace folder does not exist: ${value}`);
  }
  return value;
}

/**
 * Move the subtree rooted at `todoId` from `sourceFolder` to `targetFolder`.
 * The moved node becomes a root (appended after the target's roots); ids,
 * bodies, plans, changelogs and chat links are kept.
 *
 * @param {{ dataDir: string, sourceFolder: string, targetFolder: string, todoId: string, expectedUpdatedAt: string, chatId?: string, saveDoc?: (dataDir: string, cwd: string, doc: any) => any }} input `saveDoc` is a test seam
 * @returns {{ root: any, movedIds: string[], targetFolder: string }}
 */
export function moveTodoTree(input) {
  const { dataDir, sourceFolder } = input;
  const targetFolder = requireTargetFolder(input.targetFolder);
  if (workspaceKeyFromCwd(sourceFolder) === workspaceKeyFromCwd(targetFolder)) {
    throw createMoveError(TODO_MOVE_ERROR_CODES.VALIDATION, 'target workspace folder is the source workspace');
  }
  return withWorkspaceWatchersFileLock(() => {
    const source = loadTodosData(dataDir, sourceFolder);
    const sourceItems = /** @type {MovableTodo[]} */ (source.items);
    const root = sourceItems.find((item) => item.id === input.todoId);
    if (!root) throw createMoveError(TODO_MOVE_ERROR_CODES.NOT_FOUND, `Todo not found: ${input.todoId}`);
    if (String(input.expectedUpdatedAt || '') !== String(root.updatedAt || '')) {
      throw createMoveError(TODO_MOVE_ERROR_CODES.CONFLICT, 'expected_updated_at is stale; re-read the todo');
    }
    const ids = new Set(collectTodoSubtreeIds(source.items, root.id));
    const moved = sourceItems.filter((item) => ids.has(item.id));
    const blockers = listMoveBlockers({ dataDir, sourceFolder, items: moved, ids });
    if (blockers.length > 0) {
      throw createMoveError(TODO_MOVE_ERROR_CODES.HAS_HISTORY, 'This tree has run history and cannot move', blockers);
    }
    const target = loadTodosData(dataDir, targetFolder);
    const clash = target.items.find((item) => ids.has(item.id));
    if (clash) throw createMoveError(TODO_MOVE_ERROR_CODES.CONFLICT, `Target already has todo ${clash.id}`);
    const now = new Date().toISOString();
    const targetItems = /** @type {MovableTodo[]} */ (target.items);
    const targetRoots = targetItems.filter((item) => !String(item.parentId || '').trim()).length;
    const movedRoot = {
      ...root,
      parentId: '',
      siblingIndex: targetRoots,
      updatedAt: now,
      changelog: [
        ...(Array.isArray(root.changelog) ? root.changelog : []),
        { kind: 'note', text: `moved from workspace ${sourceFolder}`, chatId: input.chatId || '', at: now },
      ],
    };
    const movedItems = moved.map((item) => (item.id === root.id ? movedRoot : item));
    target.items = [...target.items, .../** @type {typeof target.items} */ (movedItems)];
    source.items = source.items.filter((item) => !ids.has(item.id));
    moveTodoDocuments(
      dataDir,
      { cwd: targetFolder, doc: target },
      { cwd: sourceFolder, doc: source },
      { saveDoc: input.saveDoc },
    );
    unlinkSourceChats(ids);
    return { root: movedRoot, movedIds: [...ids], targetFolder };
  }, { dataDir });
}

/**
 * A chat stays in its workspace, so its `todoId` would point at a todo that
 * workspace no longer has. The todo keeps the chat in `linkedChatIds`.
 *
 * @param {Set<string>} ids
 */
export function unlinkSourceChats(ids) {
  /** @type {Array<{ id: string, todoId?: string | null }>} */ (loadChats())
    .filter((chat) => ids.has(String(chat?.todoId || '')))
    .forEach((chat) => updateChat(chat.id, { todoId: null }));
}
