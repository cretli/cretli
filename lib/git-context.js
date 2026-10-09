/**
 * Authorized Git scope resolution for the Git panel and GitHub reads.
 *
 * The Git routes used to run every read and action in the process-wide
 * `getCurrentCwd()`. With worktree-backed TODOs a chat or task may have a
 * different execution folder than the logical project, so the route resolves a
 * scope from durable server records instead of an arbitrary client path:
 *   - `chatId`  -> the chat's `executionFolder` / `workspaceFolder`;
 *   - `todoId`  -> the worktree registry entry for that leaf, else the logical
 *                  workspace the TODO lives in;
 *   - neither   -> the legacy global cwd (backwards compatible).
 *
 * Trust model:
 *   - A client-supplied `executionFolder` is never trusted or read.
 *   - With a `chatId`, the scope comes only from the durable chat record:
 *     `executionFolder` wins, then `workspaceFolder`. A client `workspaceFolder`
 *     may only be the store key for the TODO lookup when the chat stores no
 *     workspace, and it is never promoted to the chat execution folder.
 *   - With only a `todoId`, the client `workspaceFolder` is the per-workspace
 *     TODO store key (the same trust level `todos-routes.js` already uses);
 *     a live worktree record still takes precedence.
 *   - With neither `chatId` nor `todoId`, the request may consciously select a
 *     workspace (the existing workspace picker `cursor-context-routes.js` also
 *     exposes); this is an explicit scope choice, not an authorization bypass.
 */

import path from 'node:path';
import { realpathSync } from 'node:fs';
import { loadChats } from './persist/chats-persist.js';
import { getTodoById } from './persist/todos-persist.js';
import { getWorktreeRecord } from './persist/worktree-registry-persist.js';

export const GIT_SCOPE_ERROR_CODES = Object.freeze({
  CHAT_NOT_FOUND: 'chat_not_found',
  TODO_NOT_FOUND: 'todo_not_found',
  WORKSPACE_REQUIRED: 'workspace_required',
  CONTEXT_CONFLICT: 'context_conflict',
});

/** Scope sources, ordered from the most specific to the legacy fallback. */
export const GIT_SCOPE_SOURCES = Object.freeze(['worktree', 'todo', 'chat', 'workspace', 'global']);

/**
 * @param {unknown} value
 * @returns {string}
 */
function readId(value) {
  return String(value ?? '').trim();
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeFolder(value) {
  const raw = readId(value);
  if (!raw) return '';
  try {
    return path.resolve(raw);
  } catch {
    return raw;
  }
}

/**
 * Read the scope selectors from the request query and body. Query wins so a
 * GET stays a GET; POST actions may carry the same fields in the body.
 *
 * @param {import('express').Request | null | undefined} req
 * @returns {{ chatId: string, todoId: string, workspaceFolder: string }}
 */
export function readGitScopeInput(req) {
  const query = req?.query || {};
  const body = req?.body || {};
  return {
    chatId: readId(query.chatId || body.chatId),
    todoId: readId(query.todoId || body.todoId),
    workspaceFolder: normalizeFolder(query.workspaceFolder || body.workspaceFolder),
  };
}

/**
 * @param {object} record
 * @returns {object | null}
 */
function readWorktreeSummary(record) {
  if (!record || record.cleanedAt || !record.worktreePath) return null;
  return {
    branch: readId(record.branch),
    baseCommit: readId(record.baseCommit),
    worktreePath: normalizeFolder(record.worktreePath),
    repoRoot: normalizeFolder(record.repoRoot),
    executionState: readId(record.executionState) || 'none',
    integrationState: readId(record.integrationState) || 'not_applicable',
    integrationReadyAt: readId(record.integration?.readyAt) || '',
    lastError: record.lastError || null,
  };
}

/**
 * @param {object | null} todo
 * @returns {object | null}
 */
function readTodoSummary(todo) {
  if (!todo) return null;
  const integration = todo.integration && typeof todo.integration === 'object' ? todo.integration : null;
  return {
    id: readId(todo.id),
    title: readId(todo.title),
    status: readId(todo.status),
    executionMode: readId(todo.executionMode) || 'inherit',
    integration: integration
      ? {
        state: readId(integration.state),
        branch: readId(integration.branch),
        baseCommit: readId(integration.baseCommit),
        worktreePath: normalizeFolder(integration.worktreePath),
        reviewOutcome: readId(integration.reviewOutcome),
        testOutcome: readId(integration.testOutcome),
        changedFiles: Array.isArray(integration.changedFiles) ? integration.changedFiles : [],
      }
      : null,
  };
}

/**
 * Resolve the authorized Git scope for one request.
 *
 * Precedence of the returned execution folder:
 *   worktree record > chat `executionFolder` > chat `workspaceFolder` >
 *   client `workspaceFolder` (only without a `chatId`) > global `getCurrentCwd()`.
 * A chat that stores neither folder thus falls back to the global cwd rather
 * than to the client path.
 *
 * @param {import('express').Request | null | undefined} req
 * @param {{
 *   dataDir?: string,
 *   getCurrentCwd?: () => string,
 *   deps?: {
 *     loadChats?: () => object[],
 *     getTodoById?: (dataDir: string, cwd: string, id: string) => object | null,
 *     getWorktreeRecord?: (todoId: string, options: object) => object | null,
 *   },
 * }} [options]
 * @returns {{
 *   ok: true,
 *   source: string,
 *   chatId: string,
 *   todoId: string,
 *   workspaceFolder: string,
 *   executionFolder: string,
 *   isWorktree: boolean,
 *   worktree: object | null,
 *   todo: object | null,
 *   chat: object | null,
 * } | { ok: false, code: string, error: string }}
 */
export function resolveGitRequestContext(req, options = {}) {
  const dataDir = options.dataDir;
  const getCurrentCwd = typeof options.getCurrentCwd === 'function'
    ? options.getCurrentCwd
    : () => process.cwd();
  const loadChatsFn = options.deps?.loadChats || loadChats;
  const getTodoByIdFn = options.deps?.getTodoById || getTodoById;
  const getWorktreeRecordFn = options.deps?.getWorktreeRecord || getWorktreeRecord;
  const registryOptions = dataDir ? { dataDir } : {};
  const input = readGitScopeInput(req);

  let chat = null;
  if (input.chatId) {
    chat = (loadChatsFn() || []).find((row) => readId(row?.id) === input.chatId) || null;
    if (!chat) {
      return { ok: false, code: GIT_SCOPE_ERROR_CODES.CHAT_NOT_FOUND, error: `Unknown chat: ${input.chatId}` };
    }
  }
  const todoId = input.todoId || readId(chat?.todoId);
  if (input.todoId && input.chatId && readId(chat?.todoId) && readId(chat.todoId) !== input.todoId) {
    return {
      ok: false,
      code: GIT_SCOPE_ERROR_CODES.CONTEXT_CONFLICT,
      error: 'The chat and the task context do not belong together.',
    };
  }

  // Server record wins for the TODO store key; the client workspace is only a
  // fallback when the chat stores none. It is a lookup key, not an execution
  // folder by itself.
  const chatWorkspace = normalizeFolder(chat?.workspaceFolder);
  const chatExecution = normalizeFolder(chat?.executionFolder);
  const workspaceFolder = chatWorkspace || input.workspaceFolder;
  let todo = null;
  let worktree = null;
  if (todoId) {
    if (!workspaceFolder) {
      return {
        ok: false,
        code: GIT_SCOPE_ERROR_CODES.WORKSPACE_REQUIRED,
        error: 'A workspace folder is required to resolve a task context.',
      };
    }
    todo = getTodoByIdFn(dataDir, workspaceFolder, todoId);
    if (!todo) {
      return { ok: false, code: GIT_SCOPE_ERROR_CODES.TODO_NOT_FOUND, error: `Unknown task: ${todoId}` };
    }
    worktree = readWorktreeSummary(getWorktreeRecordFn(todoId, registryOptions));
  }

  const hasExplicitScope = Boolean(input.chatId || input.todoId);
  let source = 'global';
  let executionFolder = '';
  if (hasExplicitScope) {
    if (worktree) {
      source = 'worktree';
      executionFolder = worktree.worktreePath;
    } else if (input.chatId) {
      // A chat is scoped by its durable record only: stored execution folder
      // first, then the stored workspace. A client workspace is never promoted
      // to the chat execution folder; with neither field we fall back to the
      // global cwd, the same legacy default as an unscoped request.
      source = 'chat';
      executionFolder = chatExecution || chatWorkspace || normalizeFolder(getCurrentCwd());
    } else {
      // Task-only context: the client workspace is the TODO store key, but a
      // live worktree record above still takes precedence.
      source = 'todo';
      executionFolder = workspaceFolder;
    }
  } else if (workspaceFolder) {
    // No chat and no task: the request may consciously select a workspace, the
    // same workspace selection `cursor-context-routes.js` exposes. There is no
    // server record to scope against, so this is not an authorization bypass.
    source = 'workspace';
    executionFolder = workspaceFolder;
  } else {
    executionFolder = normalizeFolder(getCurrentCwd());
  }

  if (!executionFolder) {
    return {
      ok: false,
      code: GIT_SCOPE_ERROR_CODES.WORKSPACE_REQUIRED,
      error: 'Could not resolve an execution folder for this context.',
    };
  }

  return {
    ok: true,
    source,
    chatId: input.chatId,
    todoId,
    workspaceFolder: workspaceFolder || executionFolder,
    executionFolder,
    isWorktree: Boolean(worktree),
    worktree,
    todo: readTodoSummary(todo),
    chat: chat ? { id: readId(chat.id), title: readId(chat.title) } : null,
  };
}

/**
 * True when `targetReal` is `baseReal` itself or lives below it.
 *
 * @param {string} baseReal
 * @param {string} targetReal
 * @returns {boolean}
 */
export function isPathInsideBase(baseReal, targetReal) {
  if (!baseReal || !targetReal) return false;
  return targetReal === baseReal || targetReal.startsWith(baseReal + path.sep);
}

/**
 * Resolve a workspace-relative path and verify it stays inside `baseDir`.
 * Returns `{ ok: false }` for a traversal or a missing base; deleted files are
 * validated through their real parent so `git diff` still works for them.
 *
 * @param {string} baseDir
 * @param {string} relPath
 * @returns {{ ok: true, resolvedReal: string, relPosix: string } | { ok: false, error: string }}
 */
export function resolvePathWithinBase(baseDir, relPath) {
  const rel = String(relPath ?? '').trim();
  if (!rel) return { ok: false, error: 'Missing path' };
  try {
    const baseReal = realpathSync(baseDir);
    const requested = path.resolve(path.join(baseDir, rel));
    let resolvedReal;
    try {
      resolvedReal = realpathSync(requested);
    } catch {
      // A deleted file has no realpath; validate its real parent instead so a
      // diff of a removed tracked file is still readable.
      const parentReal = realpathSync(path.dirname(requested));
      if (!isPathInsideBase(baseReal, parentReal)) {
        return { ok: false, error: 'Path outside workspace' };
      }
      resolvedReal = requested;
    }
    if (!isPathInsideBase(baseReal, resolvedReal)) {
      return { ok: false, error: 'Path outside workspace' };
    }
    return { ok: true, resolvedReal, relPosix: rel.replace(/\\/g, '/') };
  } catch {
    return { ok: false, error: 'Path outside workspace' };
  }
}
