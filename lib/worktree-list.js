/**
 * Worktree list read model: the registry reconciled with `git worktree list`
 * and the task integration state, for one workspace folder.
 *
 * Read-only. Every path comes from a server-side registry record; nothing a
 * client sends is ever used as a filesystem location.
 */

import fs from 'node:fs';
import path from 'node:path';
import { readWorktreeRegistry } from './persist/worktree-registry-persist.js';
import { loadTodosData } from './persist/todos-persist.js';
import { loadChats } from './persist/chats-persist.js';
import { isChatInWorkspace } from './mcp/builtin/tool-context.js';
import { verifyWorktreeRecord } from './worktree-manager.js';
import { listGitWorktrees, listWorktreeStatusEntries, resolveCommit, runGit } from './worktree/git-worktree.js';
import { preflightGitBranchMerge } from './worktree-merge.js';
import { SMART_MERGE_RUNNING } from './workspace-watcher-integration.js';

/** Row `state` vocabulary shown by the UI. */
export const WORKTREE_LIST_STATES = Object.freeze([
  'cleaned', 'missing', 'foreign', 'creating', 'active', 'execution_closed',
  'integration_ready', 'merging', 'integrated', 'rejected',
]);

/**
 * @param {unknown} value
 * @returns {string}
 */
function readString(value) {
  return String(value ?? '').trim();
}

/**
 * @param {string} left
 * @param {string} right
 * @returns {boolean}
 */
function samePath(left, right) {
  if (!left || !right) return false;
  return path.resolve(left) === path.resolve(right);
}

/**
 * @param {string} repoRoot
 * @param {string} base
 * @param {string} head
 * @returns {number} commits `head` has beyond `base`, or 0 when unreadable
 */
function countAheadCommits(repoRoot, base, head) {
  if (!base || !head || base === head) return 0;
  const result = runGit(['rev-list', '--count', `${base}..${head}`], repoRoot, { allowFailure: true });
  const count = Number.parseInt(result.stdout.trim(), 10);
  return result.status === 0 && Number.isFinite(count) ? count : 0;
}

/**
 * @param {string} repoRoot
 * @param {string} base
 * @param {string} head
 * @returns {boolean}
 */
function isAncestor(repoRoot, base, head) {
  if (!base || !head) return false;
  return runGit(['merge-base', '--is-ancestor', base, head], repoRoot, { allowFailure: true }).status === 0;
}

/**
 * Derive the single row state from the registry record, the Git verification
 * and the todo pointer. Order matters: a physical problem outranks the
 * integration decision because the decision cannot be acted on.
 *
 * @param {{ record: object, gitStatus: string, todo: object | null }} input
 * @returns {string}
 */
export function deriveWorktreeRowState(input) {
  const { record, gitStatus, todo } = input;
  if (record.cleanedAt) return 'cleaned';
  if (record.creationState === 'reserved') return 'creating';
  if (gitStatus === 'missing') return 'missing';
  if (gitStatus === 'foreign' || gitStatus === 'owner_mismatch' || gitStatus === 'repo_unavailable') return 'foreign';
  if (record.integrationState === 'integrated') return 'integrated';
  if (record.integrationState === 'rejected') return 'rejected';
  const integration = todo?.integration || null;
  if (integration && readString(integration.reason) === SMART_MERGE_RUNNING) return 'merging';
  if (record.integrationState === 'ready' || integration?.state === 'ready') return 'integration_ready';
  if (record.executionState === 'execution_closed') return 'execution_closed';
  return 'active';
}

/**
 * @param {{
 *   record: object,
 *   gitWorktrees: ReturnType<typeof listGitWorktrees> | null,
 *   todo: object | null,
 *   chatCount: number,
 *   workspaceFolder: string,
 *   dataDir?: string,
 * }} input
 * @returns {object}
 */
function buildRow(input) {
  const { record, todo } = input;
  const repoRoot = readString(record.repoRoot) || readString(record.workspaceFolder);
  const worktreePath = readString(record.worktreePath);
  const exists = Boolean(worktreePath) && fs.existsSync(worktreePath);
  let gitStatus = 'cleaned';
  let message = '';
  let headCommit = readString(record.headCommit);
  let ahead = 0;
  let changedFiles = 0;
  let error = '';
  if (!record.cleanedAt) {
    const verification = verifyWorktreeRecord(record, input.gitWorktrees ? { gitWorktrees: input.gitWorktrees } : {});
    gitStatus = verification.status;
    message = verification.message;
    if (exists) {
      const entry = (input.gitWorktrees || []).find((candidate) => samePath(candidate.path, worktreePath));
      if (entry?.head) headCommit = entry.head;
      // The frozen-base check reports a committed worktree as "external_change";
      // for the list that is just a branch that moved ahead of its base.
      if (gitStatus === 'external_change' && entry && isAncestor(repoRoot, readString(record.baseCommit), entry.head)) {
        gitStatus = 'ahead';
        message = '';
      }
      ahead = countAheadCommits(repoRoot, readString(record.baseCommit), headCommit);
      try {
        changedFiles = listWorktreeStatusEntries(worktreePath).length;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
    }
  }
  const state = deriveWorktreeRowState({ record, gitStatus, todo });
  const live = !record.cleanedAt && exists && state !== 'foreign' && state !== 'creating';
  return {
    todoId: readString(record.todoId),
    title: readString(todo?.title),
    todoExists: Boolean(todo),
    todoStatus: readString(todo?.status),
    chatCount: input.chatCount,
    branch: readString(record.branch),
    baseCommit: readString(record.baseCommit),
    headCommit,
    worktreePath,
    exists,
    state,
    gitStatus,
    message,
    error,
    executionState: readString(record.executionState),
    integrationState: readString(record.integrationState),
    integrationReason: readString(todo?.integration?.reason),
    mergeRunning: state === 'merging',
    aheadCommits: ahead,
    uncommittedFiles: changedFiles,
    updatedAt: readString(record.updatedAt),
    actions: {
      merge: live && state !== 'integrated' && state !== 'merging' && record.executionState !== 'active' && record.executionState !== 'preparing',
      reject: live && (state === 'integration_ready' || state === 'merging'),
      cleanup: !record.cleanedAt && state !== 'creating' && state !== 'merging' && record.executionState !== 'active' && record.executionState !== 'preparing',
      diff: live,
    },
  };
}

/**
 * @param {{ dataDir?: string, workspaceFolder: string }} input
 * @returns {{ rows: object[], foreign: object[], counts: Record<string, number> }}
 */
export function listWorkspaceWorktrees(input) {
  const workspaceFolder = readString(input.workspaceFolder);
  const registry = readWorktreeRegistry(input.dataDir ? { dataDir: input.dataDir } : {});
  const records = Object.values(registry.items || {}).filter((record) => samePath(readString(record.workspaceFolder), workspaceFolder));
  let todos = [];
  try {
    todos = loadTodosData(input.dataDir, workspaceFolder).items || [];
  } catch {
    todos = [];
  }
  const todoById = new Map(todos.map((row) => [String(row.id), row]));
  const chatsByTodoId = new Map();
  const chats = loadChats().filter((chat) => isChatInWorkspace(chat, workspaceFolder));
  const workspaceChatIds = new Set(chats.map((chat) => readString(chat.id)).filter(Boolean));
  for (const chat of chats) {
    const todoId = readString(chat.todoId);
    if (!todoId) continue;
    if (!chatsByTodoId.has(todoId)) chatsByTodoId.set(todoId, new Set());
    chatsByTodoId.get(todoId).add(readString(chat.id));
  }
  /** @type {Map<string, ReturnType<typeof listGitWorktrees> | null>} */
  const gitCache = new Map();
  const gitFor = (repoRoot) => {
    if (!gitCache.has(repoRoot)) {
      let list = null;
      try {
        list = listGitWorktrees(repoRoot);
      } catch {
        list = null;
      }
      gitCache.set(repoRoot, list);
    }
    return gitCache.get(repoRoot);
  };
  const rows = records.map((record) => {
    const todoId = readString(record.todoId);
    const todo = todoById.get(todoId) || null;
    const linkedChatIds = new Set(chatsByTodoId.get(todoId) || []);
    const directChatId = readString(todo?.chatId);
    if (directChatId && workspaceChatIds.has(directChatId)) linkedChatIds.add(directChatId);
    for (const chatId of Array.isArray(todo?.linkedChatIds) ? todo.linkedChatIds : []) {
      const id = readString(chatId);
      if (id && workspaceChatIds.has(id)) linkedChatIds.add(id);
    }
    return buildRow({
      record,
      gitWorktrees: gitFor(readString(record.repoRoot) || readString(record.workspaceFolder)),
      todo,
      chatCount: linkedChatIds.size,
      workspaceFolder,
      dataDir: input.dataDir,
    });
  });
  rows.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  /** @type {Record<string, number>} */
  const counts = {};
  for (const row of rows) counts[row.state] = (counts[row.state] || 0) + 1;
  return { rows, foreign: [], counts };
}

/**
 * Diff of one registry worktree against its frozen base: stat + patch. The
 * location is always the record's own path.
 *
 * @param {{ dataDir?: string, workspaceFolder: string, todoId: string, maxBytes?: number }} input
 * @returns {{ ok: boolean, reason?: string, stat?: string, patch?: string, truncated?: boolean }}
 */
export function readWorktreeDiff(input) {
  const record = readWorktreeRegistry(input.dataDir ? { dataDir: input.dataDir } : {}).items?.[readString(input.todoId)];
  if (!record || !samePath(readString(record.workspaceFolder), readString(input.workspaceFolder))) return { ok: false, reason: 'not_found' };
  const worktreePath = readString(record.worktreePath);
  if (record.cleanedAt || !worktreePath || !fs.existsSync(worktreePath)) return { ok: false, reason: 'worktree_missing' };
  const base = readString(record.baseCommit);
  const stat = runGit(['diff', '--stat', base, '--'], worktreePath, { allowFailure: true });
  const patch = runGit(['diff', base, '--'], worktreePath, { allowFailure: true });
  if (patch.status !== 0) return { ok: false, reason: 'git_failed' };
  const limit = Number(input.maxBytes) > 0 ? Number(input.maxBytes) : 512 * 1024;
  const truncated = Buffer.byteLength(patch.stdout, 'utf8') > limit;
  return {
    ok: true,
    stat: stat.stdout,
    patch: truncated ? patch.stdout.slice(0, limit) : patch.stdout,
    truncated,
  };
}

/**
 * Merge preview for the modal: the same preflight the merge action enforces.
 *
 * @param {{ dataDir?: string, workspaceFolder: string, todoId: string }} input
 * @returns {{ ok: boolean, reason?: string, preflight?: object }}
 */
export function readWorktreeMergePreview(input) {
  const record = readWorktreeRegistry(input.dataDir ? { dataDir: input.dataDir } : {}).items?.[readString(input.todoId)];
  if (!record || !samePath(readString(record.workspaceFolder), readString(input.workspaceFolder))) return { ok: false, reason: 'not_found' };
  if (record.cleanedAt) return { ok: false, reason: 'worktree_missing' };
  const baseCommit = readString(record.baseCommit);
  const preflight = preflightGitBranchMerge({ workspaceFolder: input.workspaceFolder, record, dataDir: input.dataDir });
  let diffStat = '';
  const worktreePath = readString(record.worktreePath);
  if (fs.existsSync(worktreePath)) {
    diffStat = runGit(['diff', '--shortstat', baseCommit, '--'], worktreePath, { allowFailure: true }).stdout.trim();
  }
  return { ok: true, preflight: { ...preflight, diffStat, headCommit: readString(resolveCommit(readString(record.branch), preflight.repoRoot || input.workspaceFolder)) } };
}
