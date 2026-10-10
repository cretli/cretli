/**
 * Manual (Todo-panel) execution of worktree-mode trees.
 *
 * The Workspace Watcher keys its worktree by the claimed LEAF. A manual start
 * keys the whole tree by its ROOT so every chat and delegated child of the tree
 * shares one worktree. This module owns that root resolution, the prepare call
 * and the error vocabulary the HTTP route renders; it never touches the Watcher
 * keying and never calls `resolveWorktreeMode` with a leaf override.
 *
 * Decisions: D1 (root key only, mixing refused with 409), D2 (one mutating chat
 * per tree at a time — the per-folder write lock is unchanged), D3 (cleanup is a
 * follow-up, not implemented here).
 */

import { resolveTodoRootId } from './todo-tree.js';
import { getWorktreeRecord, readWorktreeRegistry } from './persist/worktree-registry-persist.js';
import { resolveWorktreeMode } from './worktree/worktree-mode.js';
import { WORKTREE_ERROR_CODES } from './worktree/worktree-errors.js';
import { worktreeRegistryOptions } from './workspace-watcher-worktree.js';

/**
 * A live record is one that still owns a worktree on disk. A `cleanedAt` record
 * is history and never blocks a fresh start.
 *
 * @param {object | null | undefined} record
 * @returns {boolean}
 */
export function isLiveWorktreeRecord(record) {
  return Boolean(record && !record.cleanedAt);
}

/**
 * Live worktree record of one todo, or null.
 *
 * @param {string} todoId
 * @param {string} [dataDir]
 * @returns {object | null}
 */
export function readLiveWorktreeRecord(todoId, dataDir) {
  const id = String(todoId ?? '').trim();
  if (!id) return null;
  const record = getWorktreeRecord(id, worktreeRegistryOptions(dataDir));
  return isLiveWorktreeRecord(record) ? record : null;
}

/**
 * Build a cheap predicate over one registry snapshot. Recovery classification
 * asks about many todos, so the registry is read once per pass.
 *
 * @param {string} [dataDir]
 * @returns {(todoId: string) => boolean}
 */
export function buildLiveWorktreePredicate(dataDir) {
  let doc;
  try {
    doc = readWorktreeRegistry(worktreeRegistryOptions(dataDir));
  } catch {
    return () => false;
  }
  const items = doc?.items && typeof doc.items === 'object' ? doc.items : {};
  return (todoId) => isLiveWorktreeRecord(items[String(todoId ?? '').trim()]);
}

/**
 * Resolve the ROOT of the tree `todoId` lives in.
 *
 * @param {object[]} items
 * @param {string} todoId
 * @returns {{ rootId: string, root: object | null }}
 */
export function resolveManualTodoRoot(items, todoId) {
  const id = String(todoId ?? '').trim();
  const list = Array.isArray(items) ? items : [];
  const rootId = resolveTodoRootId(list, id);
  const root = list.find((row) => String(row?.id || '') === rootId) || null;
  return { rootId, root };
}

/**
 * Execution mode for a manual start.
 *
 * The tree ROOT decides: its explicit `worktree`/`project` override wins, and
 * `inherit`/absent falls back to the watcher policy default. The requested
 * leaf's own override is deliberately ignored (the UI hints at this): the whole
 * tree shares the root worktree. `resolveWorktreeMode` is reused unchanged, but
 * it is fed the root — the resolver itself is never modified.
 *
 * @param {{ rootTodo?: object | null, policy?: object | null }} [input]
 * @returns {{ mode: 'worktree' | 'project', source: 'leaf' | 'policy' }}
 */
export function resolveManualTodoExecutionMode(input = {}) {
  return resolveWorktreeMode({
    leafMode: input.rootTodo?.executionMode,
    policyDefault: input.policy?.executionMode,
  });
}

/**
 * Ids on the same direct line as `rootId` that must not already own a worktree.
 * Descendants are included because a manual root start would otherwise collide
 * with a live Watcher leaf record further down the tree.
 *
 * @param {object[]} items
 * @param {string} rootId
 * @returns {string[]}
 */
export function collectManualLineageTodoIds(items, rootId) {
  const list = Array.isArray(items) ? items : [];
  const id = String(rootId ?? '').trim();
  if (!id) return [];
  const out = new Set([id]);
  const collectDescendants = (parentId) => {
    for (const row of list) {
      const rowId = String(row?.id || '').trim();
      if (!rowId || String(row?.parentId || '').trim() !== parentId) continue;
      if (out.has(rowId)) continue;
      out.add(rowId);
      collectDescendants(rowId);
    }
  };
  collectDescendants(id);
  return [...out];
}

/**
 * Whether starting this tree now can require a long prepare step. True only
 * when the resolved mode is `worktree` and the root has no live record yet, so
 * the route can answer with 202 + poll instead of blocking the request for up
 * to the prepare timeout (D4).
 *
 * @param {{ items: object[], rootId: string, policy?: object | null, dataDir?: string }} input
 * @returns {boolean}
 */
export function manualStartNeedsAsyncPrepare(input) {
  const rootTodo = (Array.isArray(input.items) ? input.items : [])
    .find((row) => String(row?.id || '') === String(input.rootId || '')) || null;
  if (!rootTodo) return false;
  const live = readLiveWorktreeRecord(input.rootId, input.dataDir);
  // An already-prepared, active record needs no prepare work: stay synchronous.
  if (live && live.creationState === 'ready' && live.executionState === 'active') return false;
  try {
    return resolveManualTodoExecutionMode({ rootTodo, policy: input.policy }).mode === 'worktree';
  } catch {
    return false;
  }
}

/**
 * Human-readable message for a preparation failure. The route never passes the
 * raw WorktreeError text to the client; it maps the stable code to an i18n key
 * that carries a recovery hint for the operator.
 *
 * @param {unknown} error
 * @returns {{ code: string, key: string, status: number }}
 */
export function describeManualWorktreeError(error) {
  const code = error && typeof error === 'object' && 'code' in error
    ? String(error.code || '')
    : '';
  const known = WORKTREE_ERROR_CODES;
  const sourceDetails = error && typeof error === 'object' && 'details' in error && error.details && typeof error.details === 'object'
    ? error.details
    : {};
  const details = code === known.PREPARE_FAILED
    ? {
      stage: String(sourceDetails.stage || ''),
      command: Array.isArray(sourceDetails.command) ? sourceDetails.command.map(sanitizePrepareOutput) : [],
      cwd: String(sourceDetails.cwd || ''),
      exitCode: String(sourceDetails.exitCode || ''),
      signal: String(sourceDetails.signal || ''),
      stdout: sanitizePrepareOutput(sourceDetails.stdout),
      stderr: sanitizePrepareOutput(sourceDetails.stderr),
    }
    : undefined;
  switch (code) {
    case known.DIRTY:
      return { code, key: 'todo.worktreeDirty', status: 409 };
    case known.BRANCH_COLLISION:
      return { code, key: 'todo.worktreeBranchCollision', status: 409 };
    case known.PATH_EXISTS:
      return { code, key: 'todo.worktreePathExists', status: 409 };
    case known.MISSING:
    case known.RECORD_MISSING:
      return { code, key: 'todo.worktreeMissing', status: 409 };
    case known.FOREIGN:
      return { code, key: 'todo.worktreeForeign', status: 409 };
    case known.OWNER_MISMATCH:
      return { code, key: 'todo.worktreeOwnerMismatch', status: 409 };
    case known.EXTERNAL_CHANGE:
      return { code, key: 'todo.worktreeExternalChange', status: 409 };
    case known.REGISTRY_CONFLICT:
      return { code, key: 'todo.worktreeMixing', status: 409 };
    case known.BUSY:
      return { code, key: 'todo.worktreeBusy', status: 409 };
    case known.UNACCEPTED:
      return { code, key: 'todo.worktreeUnaccepted', status: 409 };
    case known.NOT_GIT:
      return { code, key: 'todo.worktreeNotGit', status: 409 };
    case known.CONFIG_INVALID:
      return { code, key: 'todo.worktreeConfigInvalid', status: 422 };
    case known.MODE_INVALID:
    case known.MODE_NOT_WORKTREE:
      return { code, key: 'todo.worktreeModeInvalid', status: 422 };
    case known.PREPARE_FAILED:
      return { code, key: 'todo.worktreePrepareFailed', status: 422, details };
    default:
      return { code: code || 'WORKTREE_PREPARE_FAILED', key: 'todo.worktreePrepareFailed', status: 422 };
  }
}

/**
 * Keep command output useful while removing common credential formats.
 * @param {unknown} value
 * @returns {string}
 */
function sanitizePrepareOutput(value) {
  return String(value || '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/((?:_authToken|_auth|password|passwd|token)\s*[=:]\s*)[^\s"']+/gi, '$1[redacted]')
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .slice(-4000);
}
