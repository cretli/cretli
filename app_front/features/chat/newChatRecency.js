import { chatOpenedMs } from '../sidebar/sidebarOpenedOrder.js';
import { chatWorktreeTodoId } from '../sidebar/sidebarOnlyActiveFilter.js';
import { decodeNewChatModelChoice } from './newChatModelOptions.js';
import { decodeNewChatLocation } from './newChatLocationOptions.js';

/**
 * "Recently used" ordering for the new-chat modal. Recency comes from the chats themselves:
 * a workspace, harness+model pair, folder or worktree counts as used when a chat that
 * carries it was last opened.
 */

/** @param {any} chat */
function usedMs(chat) {
  const created = typeof chat?.createdAt === 'string' ? Date.parse(chat.createdAt) : 0;
  return Math.max(chatOpenedMs(chat), Number.isFinite(created) ? created : 0);
}

/** Keep the newest time per key. */
function bump(map, key, ms) {
  if (key && ms > (map.get(key) || 0)) map.set(key, ms);
}

/**
 * @param {any[]} chats
 * @returns {{ workspace: Map<string, number>, model: Map<string, number>, folder: Map<string, number>, worktree: Map<string, number> }}
 */
export function buildNewChatRecency(chats) {
  const workspace = new Map();
  const model = new Map();
  const folder = new Map();
  const worktree = new Map();
  for (const chat of Array.isArray(chats) ? chats : []) {
    if (!chat || chat.archived) continue;
    const ms = usedMs(chat);
    if (!ms) continue;
    bump(workspace, chat.workspaceFile, ms);
    const harness = String(chat.agentTransport || 'sdk').trim().toLowerCase();
    if (chat.model) bump(model, `${harness}\u0000${chat.model}`, ms);
    const dir = chat.workspaceFolder;
    if (dir) {
      bump(folder, dir, ms);
      const todoId = chatWorktreeTodoId(chat);
      if (todoId) bump(worktree, `${dir}\u0000${todoId}`, ms);
    }
  }
  return { workspace, model, folder, worktree };
}

/** Cheap change detector for memoized option lists. */
export function newChatRecencyStamp(chats) {
  let newest = 0;
  const list = Array.isArray(chats) ? chats : [];
  for (const chat of list) newest = Math.max(newest, usedMs(chat));
  return `${list.length}:${newest}`;
}

/**
 * Stable sort, newest first; items without a time keep their relative order after used ones.
 *
 * @template T
 * @param {T[]} items
 * @param {(item: T) => number} score
 * @returns {T[]}
 */
export function sortByRecency(items, score) {
  return items
    .map((item, idx) => ({ item, idx, s: score(item) || 0 }))
    .sort((a, b) => (b.s - a.s) || (a.idx - b.idx))
    .map((entry) => entry.item);
}

/** Workspaces (`workspaceFile`) most recently used first. */
export function sortWorkspacesByRecency(workspaces, recency) {
  return sortByRecency(workspaces, (w) => recency.workspace.get(w.workspaceFile));
}

/**
 * Picker rows grouped by `group` (harness): groups ordered by their newest model, models inside a
 * group by their own recency. Effort variants of one model stay together in their original order.
 *
 * @param {any[]} rows rows whose `value` is a harness+model choice
 * @param {{ model: Map<string, number> }} recency
 */
export function sortModelOptionsByRecency(rows, recency) {
  const rowScore = (row) => {
    const choice = decodeNewChatModelChoice(row.value);
    return choice ? recency.model.get(`${choice.harness}\u0000${choice.model}`) || 0 : 0;
  };
  const modelKey = (row) => row.variantOf || row.value;
  const maxBy = (list, key) => {
    const best = new Map();
    for (const row of list) best.set(key(row), Math.max(best.get(key(row)) || 0, rowScore(row)));
    return best;
  };
  const groupScore = maxBy(rows, (row) => row.group);
  const modelScore = maxBy(rows, modelKey);
  const groups = sortByRecency([...new Set(rows.map((row) => row.group))], (g) => groupScore.get(g));
  return groups.flatMap((group) => {
    const inGroup = rows.filter((row) => row.group === group);
    const models = sortByRecency([...new Set(inGroup.map(modelKey))], (key) => modelScore.get(key));
    return models.flatMap((key) => inGroup.filter((row) => modelKey(row) === key));
  });
}

/**
 * Location rows (`[folder, todoId]` values): folders newest first; inside a folder the plain
 * project row stays first, worktrees follow by recency.
 *
 * @param {any[]} rows
 * @param {{ folder: Map<string, number>, worktree: Map<string, number> }} recency
 */
export function sortLocationOptionsByRecency(rows, recency) {
  const decoded = (row) => decodeNewChatLocation(row.value);
  const folders = [...new Set(rows.map((row) => decoded(row)?.folder))];
  const ordered = sortByRecency(folders, (folder) => recency.folder.get(folder));
  return ordered.flatMap((folder) => {
    const inFolder = rows.filter((row) => decoded(row)?.folder === folder);
    const plain = inFolder.filter((row) => !decoded(row)?.todoId);
    const worktrees = sortByRecency(inFolder.filter((row) => decoded(row)?.todoId),
      (row) => recency.worktree.get(`${folder}\u0000${decoded(row).todoId}`));
    return [...plain, ...worktrees];
  });
}
