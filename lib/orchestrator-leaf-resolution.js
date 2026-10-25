/**
 * Infer a todo leaf id for orchestrator model_pick / delegation_start when the
 * caller omits leaf_id/todo_id but is the root orchestrator with exactly one
 * doing leaf in the subtree.
 */

import { normalizeTodoRefId } from './todo-ref.js';
import {
  buildTodoIndex,
  collectTodoSubtreeIds,
  readTodoParentId,
  resolveTodoRootId,
} from './todo-tree.js';
import {
  extractDelegationWorkflowLeafIdFromText,
  normalizeDelegationWorkflowLeafId,
} from './delegation-workflow-leaf.js';
import { loadChats } from './persist/chats-persist.js';
import { loadTodosData } from './persist/todos-persist.js';
import { resolveDataPath } from './runtime-paths.js';

export const LEAF_SOURCE_EXPLICIT = 'explicit';
export const LEAF_SOURCE_INFERRED = 'inferred';
export const LEAF_RESOLUTION_WARNING_MISSING = 'leaf_id_missing';
export const LEAF_RESOLUTION_CODE_OUTSIDE_SUBTREE = 'leaf_outside_orchestrator_subtree';
export const LEAF_RESOLUTION_CODE_ALIAS_CONFLICT = 'leaf_id_conflict';

const TODO_ID_PREFIX_MIN_LENGTH = 8;

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function isOrchestratorLeafInferenceEnabled(env = process.env) {
  const raw = String(env?.CRETLI_ORCHESTRATOR_LEAF_INFERENCE ?? '1').trim().toLowerCase();
  return raw !== '0' && raw !== 'false' && raw !== 'off';
}

/**
 * @param {object[]} items
 * @param {string} rootId
 * @param {{ status?: string }} [options]
 * @returns {object[]}
 */
export function listTodoLeavesInSubtree(items, rootId, options = {}) {
  const root = String(rootId || '').trim();
  if (!root || !Array.isArray(items) || !items.length) return [];
  const index = buildTodoIndex(items);
  if (!index.has(root)) return [];
  const subtree = new Set(collectTodoSubtreeIds(items, root));
  /** @type {Set<string>} */
  const parents = new Set();
  for (const row of items) {
    const parentId = readTodoParentId(row);
    if (parentId && subtree.has(parentId)) parents.add(parentId);
  }
  const wantedStatus = String(options.status || '').trim().toLowerCase();
  return items.filter((row) => {
    if (!row?.id || !subtree.has(String(row.id))) return false;
    if (parents.has(String(row.id))) return false;
    if (wantedStatus && String(row.status || '').trim().toLowerCase() !== wantedStatus) return false;
    return true;
  });
}

/**
 * @param {object[]} items
 * @param {string} orchestratorChatId
 * @returns {string[]}
 */
export function findOrchestratorTodoRootsForChat(items, orchestratorChatId) {
  const chatId = String(orchestratorChatId || '').trim();
  if (!chatId || !Array.isArray(items)) return [];
  /** @type {Set<string>} */
  const roots = new Set();
  for (const row of items) {
    if (String(row?.orchestratorChatId || '').trim() !== chatId) continue;
    const rootId = resolveTodoRootId(items, String(row.id || ''));
    if (rootId) roots.add(rootId);
  }
  return [...roots];
}

/**
 * @param {object[]} items
 * @param {string} rawId
 * @returns {{ ok: true, item: object } | { ok: false, code: string, matches?: object[] }}
 */
export function resolveTodoItemByIdOrPrefix(items, rawId) {
  const requested = String(rawId || '').trim();
  if (!requested) return { ok: false, code: 'NOT_FOUND' };
  const list = Array.isArray(items) ? items : [];
  const exact = list.find((row) => String(row?.id || '') === requested);
  if (exact) return { ok: true, item: exact };
  const prefix = requested.toLowerCase();
  if (prefix.length < TODO_ID_PREFIX_MIN_LENGTH) return { ok: false, code: 'NOT_FOUND' };
  const matches = list.filter((row) => String(row?.id || '').toLowerCase().startsWith(prefix));
  if (matches.length === 0) return { ok: false, code: 'NOT_FOUND' };
  if (matches.length > 1) return { ok: false, code: 'AMBIGUOUS', matches };
  return { ok: true, item: matches[0] };
}

/**
 * @param {unknown} input
 * @returns {{ ok: false, status: number, code: string, error: string } | null}
 */
function readExplicitLeafAliasConflict(input) {
  if (!input || typeof input !== 'object') return null;
  const row = /** @type {Record<string, unknown>} */ (input);
  const hasLeaf = row.leaf_id !== undefined || row.leafId !== undefined;
  const hasTodo = row.todo_id !== undefined || row.todoId !== undefined;
  if (!hasLeaf || !hasTodo) return null;
  const leafRaw = String(row.leaf_id ?? row.leafId ?? '').trim();
  const todoRaw = String(row.todo_id ?? row.todoId ?? '').trim();
  if (!leafRaw || !todoRaw) return null;
  const leafNorm = normalizeTodoRefId(leafRaw);
  const todoNorm = normalizeTodoRefId(todoRaw);
  if (leafNorm && todoNorm && leafNorm !== todoNorm) {
    return {
      ok: false,
      status: 400,
      code: LEAF_RESOLUTION_CODE_ALIAS_CONFLICT,
      error: 'leaf_id and todo_id must refer to the same todo leaf.',
    };
  }
  return null;
}

/**
 * @param {object[]} items
 * @param {string} orchestratorChatId
 * @param {string} leafId
 * @returns {boolean}
 */
export function isLeafInOrchestratorSubtree(items, orchestratorChatId, leafId) {
  const wanted = normalizeTodoRefId(leafId);
  const chatId = String(orchestratorChatId || '').trim();
  if (!wanted || !chatId) return true;
  const roots = findOrchestratorTodoRootsForChat(items, chatId);
  if (!roots.length) return true;
  return roots.some((rootId) => collectTodoSubtreeIds(items, rootId).includes(wanted));
}

/**
 * @param {object[]} items
 * @param {string[]} rootIds
 * @returns {object[]}
 */
function listUniqueDoingLeavesForRoots(items, rootIds) {
  /** @type {Map<string, object>} */
  const byId = new Map();
  for (const rootId of rootIds) {
    for (const leaf of listTodoLeavesInSubtree(items, rootId, { status: 'doing' })) {
      const id = String(leaf?.id || '').trim();
      if (!id || byId.has(id)) continue;
      byId.set(id, leaf);
    }
  }
  return [...byId.values()];
}

/**
 * @param {object[]} candidates
 * @returns {Array<{ id: string, title: string, status: string }>}
 */
export function summarizeLeafResolutionCandidates(candidates) {
  return (Array.isArray(candidates) ? candidates : []).map((row) => ({
    id: String(row?.id || '').trim(),
    title: String(row?.title || '').trim(),
    status: String(row?.status || '').trim(),
  })).filter((row) => row.id);
}

/**
 * @param {object[]} items
 * @param {string} parentChatId
 * @param {object[]} candidates
 * @returns {{ code: string, candidates: Array<{ id: string, title: string, status: string }> }}
 */
export function buildLeafIdMissingWarning(items, parentChatId, candidates = []) {
  const roots = findOrchestratorTodoRootsForChat(items, parentChatId);
  const list = candidates.length
    ? candidates
    : (roots.length ? listUniqueDoingLeavesForRoots(items, roots) : []);
  return {
    code: LEAF_RESOLUTION_WARNING_MISSING,
    candidates: summarizeLeafResolutionCandidates(list),
  };
}

/**
 * @param {unknown} role
 * @param {unknown} purpose
 * @returns {boolean}
 */
export function shouldAttemptOrchestratorLeafInference(role, purpose) {
  const purposeKey = String(purpose || '').trim().toLowerCase();
  if (purposeKey === 'delegation_start') return true;
  const wanted = String(role || '').trim().toLowerCase();
  return wanted === 'implement' || wanted === 'fix' || wanted === 'review';
}

/**
 * @param {{
 *   input?: unknown,
 *   parentChatId?: unknown,
 *   parentTodoId?: unknown,
 *   workspaceFolder?: unknown,
 *   dataDir?: unknown,
 *   sourceText?: unknown,
 *   role?: unknown,
 *   purpose?: unknown,
 *   items?: object[],
 *   env?: Record<string, string | undefined>,
 * }} params
 * @returns {{
 *   ok: true,
 *   leafId: string,
 *   leafSource: string,
 *   warning?: { code: string, candidates: Array<{ id: string, title: string, status: string }> },
 * } | { ok: false, status: number, code: string, error: string }}
 */
/**
 * @param {object[]} items
 * @param {string} parentChatId
 * @param {object[]} candidates
 * @returns {{
 *   ok: true,
 *   leafId: string,
 *   leafSource: string,
 *   warning?: { code: string, candidates: Array<{ id: string, title: string, status: string }> },
 * }}
 */
function finishUnresolvedLeafContext(items, parentChatId, candidates) {
  return {
    ok: true,
    leafId: '',
    leafSource: '',
    warning: buildLeafIdMissingWarning(items, parentChatId, candidates),
  };
}

export function resolveRequestLeafContext(params = {}) {
  const aliasConflict = readExplicitLeafAliasConflict(params.input);
  if (aliasConflict) return aliasConflict;
  const parentChatId = String(params.parentChatId || '').trim();
  const workspaceFolder = String(params.workspaceFolder || '').trim();
  const dataDir = String(params.dataDir || '').trim() || resolveDataPath();
  let items = Array.isArray(params.items) ? params.items : [];
  if (!items.length && workspaceFolder) {
    items = loadTodosData(dataDir, workspaceFolder).items;
  }
  const explicitNormalized = normalizeDelegationWorkflowLeafId(params.input);
  const fromText = extractDelegationWorkflowLeafIdFromText(params.sourceText);
  const explicitRaw = explicitNormalized || fromText;
  if (explicitRaw) {
    const resolved = resolveTodoItemByIdOrPrefix(items, explicitRaw);
    if (resolved.ok) {
      const leafId = String(resolved.item.id || '').trim();
      const orchRoots = findOrchestratorTodoRootsForChat(items, parentChatId);
      if (orchRoots.length && !isLeafInOrchestratorSubtree(items, parentChatId, leafId)) {
        return {
          ok: false,
          status: 400,
          code: LEAF_RESOLUTION_CODE_OUTSIDE_SUBTREE,
          error: 'The leaf is outside the orchestrator todo subtree.',
        };
      }
      return { ok: true, leafId, leafSource: LEAF_SOURCE_EXPLICIT };
    }
    if (resolved.code === 'AMBIGUOUS') {
      return {
        ok: false,
        status: 400,
        code: 'leaf_id_ambiguous',
        error: 'The leaf id prefix matches more than one todo.',
      };
    }
    const legacyLeafId = normalizeTodoRefId(explicitRaw);
    if (legacyLeafId) {
      return { ok: true, leafId: legacyLeafId, leafSource: LEAF_SOURCE_EXPLICIT };
    }
    return {
      ok: false,
      status: 404,
      code: 'leaf_not_found',
      error: `Todo leaf not found: ${explicitRaw}`,
    };
  }
  if (!shouldAttemptOrchestratorLeafInference(params.role, params.purpose)) {
    return finishUnresolvedLeafContext(items, parentChatId, []);
  }
  if (!isOrchestratorLeafInferenceEnabled(params.env)) {
    return finishUnresolvedLeafContext(items, parentChatId, []);
  }
  // A chat directly linked to a leaf has an unambiguous scope even when it
  // has not been registered as the root orchestrator. Never use a group as a leaf.
  const parentTodoId = params.parentTodoId ?? loadChats().find((chat) => chat.id === parentChatId)?.todoId;
  const linked = resolveTodoItemByIdOrPrefix(items, String(parentTodoId || ''));
  if (linked.ok && !items.some((row) => readTodoParentId(row) === linked.item.id)
    && isLeafInOrchestratorSubtree(items, parentChatId, linked.item.id)) {
    return { ok: true, leafId: linked.item.id, leafSource: LEAF_SOURCE_INFERRED };
  }
  const roots = findOrchestratorTodoRootsForChat(items, parentChatId);
  if (!roots.length && linked.ok) roots.push(linked.item.id);
  if (!roots.length) {
    return finishUnresolvedLeafContext(items, parentChatId, []);
  }
  const doingLeaves = listUniqueDoingLeavesForRoots(items, roots);
  if (doingLeaves.length === 1) {
    return {
      ok: true,
      leafId: String(doingLeaves[0].id || '').trim(),
      leafSource: LEAF_SOURCE_INFERRED,
    };
  }
  return finishUnresolvedLeafContext(items, parentChatId, doingLeaves);
}

/**
 * @param {object} body
 * @param {{
 *   leafId?: string,
 *   leafSource?: string,
 *   warning?: { code: string, candidates: object[] },
 * } | null | undefined} leafContext
 * @returns {object}
 */
export function attachLeafResolutionFields(body, leafContext) {
  if (!body || typeof body !== 'object' || !leafContext) return body;
  const next = { ...body };
  if (leafContext.leafId) {
    next.leafId = leafContext.leafId;
    if (leafContext.leafSource) next.leaf_source = leafContext.leafSource;
  }
  if (leafContext.warning) next.warning = leafContext.warning;
  return next;
}
