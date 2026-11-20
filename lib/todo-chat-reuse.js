import {
  collectWorkspaceWatcherExternalOwners,
  findWorkspaceWatcherExternalTreeOwner,
} from './workspace-watcher-tree-owner.js';
import { readChatExecutionFolder } from './execution-folder.js';
import { readTodoParentId } from './todo-tree.js';

export const TODO_REUSE_MAX_CONTEXT_TOKENS = 300_000;
export const TODO_REUSE_MIN_CACHE_MS = 60_000;
export const TODO_REUSE_RESERVATION_TTL_MS = 120_000;

const reservations = new Map();

function id(value) {
  return String(value ?? '').trim();
}

function numberFromEnv(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function todoReuseLimits(env = process.env) {
  return {
    maxContextTokens: numberFromEnv(env.CRETLI_TODO_REUSE_MAX_CONTEXT_TOKENS, TODO_REUSE_MAX_CONTEXT_TOKENS),
    minRemainingMs: numberFromEnv(env.CRETLI_TODO_REUSE_MIN_CACHE_MS, TODO_REUSE_MIN_CACHE_MS),
  };
}

function pruneReservations(now = Date.now()) {
  for (const [chatId, row] of reservations) {
    if (row.expiresAt <= now) reservations.delete(chatId);
  }
}

/**
 * Reserve a chat for one start request. `owner` is a per-request token: two
 * requests for the same todo must not share a reservation, otherwise the
 * loser's rollback could overwrite the winner's chat link. The owner itself may
 * re-reserve (renew) to outlive a slow worktree prepare.
 */
export function reserveReuseChat(chatId, todoId, ttlMs = TODO_REUSE_RESERVATION_TTL_MS, now = Date.now(), owner = '') {
  const chat = id(chatId);
  const todo = id(todoId);
  if (!chat || !todo) return false;
  pruneReservations(now);
  const current = reservations.get(chat);
  if (current && (current.todoId !== todo || current.owner !== id(owner))) return false;
  reservations.set(chat, {
    todoId: todo,
    owner: id(owner),
    expiresAt: now + Math.max(1, Number(ttlMs) || TODO_REUSE_RESERVATION_TTL_MS),
  });
  return true;
}

export function releaseReuseChat(chatId, todoId, owner = '') {
  const chat = id(chatId);
  const todo = id(todoId);
  const current = reservations.get(chat);
  if (current && (!todo || current.todoId === todo) && current.owner === id(owner)) reservations.delete(chat);
}

export function isReuseChatReserved(chatId, todoId = '', now = Date.now()) {
  pruneReservations(now);
  const current = reservations.get(id(chatId));
  return !!current && (!id(todoId) || current.todoId !== id(todoId));
}

export function clearReuseChatReservationsForTests() {
  reservations.clear();
}

function finishedAt(row) {
  const value = Date.parse(String(row?.finishedAt || row?.updatedAt || ''));
  return Number.isFinite(value) ? value : 0;
}

export function resolveTodoExecutorChatId(todo, delegations = []) {
  const direct = id(todo?.chatId);
  if (direct) return direct;
  const orchestrator = id(todo?.orchestratorChatId);
  if (orchestrator) return orchestrator;
  const leafId = id(todo?.id);
  const finished = (Array.isArray(delegations) ? delegations : [])
    .filter((row) => id(row?.leafId) === leafId
      && ['implement', 'fix'].includes(id(row?.assignment || row?.role || row?.requestedRole).toLowerCase())
      && (!!id(row?.finishedAt) || ['finished', 'completed', 'done'].includes(id(row?.status).toLowerCase()))
      && id(row?.parentChatId || row?.controllerChatId))
    .sort((a, b) => finishedAt(b) - finishedAt(a));
  return id(finished[0]?.parentChatId || finished[0]?.controllerChatId);
}

function treeFor(todo, items) {
  const list = Array.isArray(items) ? items : [];
  const byId = new Map(list.map((row) => [id(row?.id), row]));
  const ancestors = [];
  const seen = new Set();
  let current = todo;
  while (current && !seen.has(id(current.id))) {
    seen.add(id(current.id));
    ancestors.push(current);
    current = byId.get(id(readTodoParentId(current))) || null;
  }
  const rootId = id(ancestors[ancestors.length - 1]?.id);
  const nodes = list.filter((row) => {
    const visited = new Set();
    let node = row;
    while (node && !visited.has(id(node.id))) {
      visited.add(id(node.id));
      if (id(node.id) === rootId) return true;
      node = byId.get(id(readTodoParentId(node))) || null;
    }
    return false;
  });
  return { ancestors, nodes, byId };
}

function candidateSources(todo, items, delegations) {
  const { ancestors, byId } = treeFor(todo, items);
  const out = [];
  const add = (chatId, source) => {
    const value = id(chatId);
    if (value && !out.some((row) => row.chatId === value)) out.push({ chatId: value, source });
  };
  add(todo?.chatId, 'todo');
  const parentId = id(readTodoParentId(todo));
  if (parentId) {
    const siblings = (Array.isArray(items) ? items : [])
      .filter((row) => id(readTodoParentId(row)) === parentId
        && Number(row?.siblingIndex) < Number(todo?.siblingIndex))
      .sort((a, b) => Number(b?.siblingIndex) - Number(a?.siblingIndex));
    for (const sibling of siblings) {
      const executor = resolveTodoExecutorChatId(sibling, delegations);
      if (executor) {
        add(executor, 'previous_sibling');
        break;
      }
    }
  }
  for (const ancestor of ancestors.slice(1)) add(ancestor?.orchestratorChatId, ancestor === byId.get(parentId) ? 'parent_orchestrator' : 'root_orchestrator');
  return out;
}

function isUnfinished(row) {
  return !['done', 'deferred'].includes(id(row?.status).toLowerCase());
}

function claimedByOtherTodo(chatId, todo, nodes, ancestors) {
  const allowed = new Set(ancestors.map((row) => id(row?.id)));
  return nodes.some((row) => id(row?.chatId) === chatId && isUnfinished(row) && !allowed.has(id(row?.id)));
}

export function resolveTodoReuseCandidates(input) {
  const items = Array.isArray(input?.items) ? input.items : [];
  const todo = items.find((row) => id(row?.id) === id(input?.todoId));
  if (!todo) return [];
  const chats = Array.isArray(input?.chats) ? input.chats : [];
  const chatById = new Map(chats.map((row) => [id(row?.id), row]));
  const delegations = Array.isArray(input?.delegations) ? input.delegations : [];
  const { ancestors, nodes } = treeFor(todo, items);
  const cycleTodoIds = new Set(input?.watcherCycleTodoIds || []);
  const maxContextTokens = Number.isFinite(input?.maxContextTokens) ? Number(input.maxContextTokens) : TODO_REUSE_MAX_CONTEXT_TOKENS;
  const minRemainingMs = Number.isFinite(input?.minRemainingMs) ? Number(input.minRemainingMs) : TODO_REUSE_MIN_CACHE_MS;
  const candidates = [];
  for (const source of candidateSources(todo, items, delegations)) {
    const chat = chatById.get(source.chatId);
    if (!chat || chat.deleted || chat.deletedAt) continue;
    const owners = collectWorkspaceWatcherExternalOwners({
      ...(input.ownerInputs || {}),
      excludeChatIds: [source.chatId],
    });
    const foreignOwner = findWorkspaceWatcherExternalTreeOwner(todo, items, owners);
    const freshness = typeof input.getCacheFreshness === 'function' ? input.getCacheFreshness(source.chatId) : null;
    const cache = freshness?.cache || {};
    const contextTokens = Number.isFinite(freshness?.context?.inputTokens) ? Number(freshness.context.inputTokens) : 0;
    const watcherTree = nodes.some((row) => cycleTodoIds.has(id(row?.id))
      || (typeof input.isWatcherCycleChat === 'function' && input.isWatcherCycleChat(id(row?.claimedByChatId))));
    let reason = '';
    if (watcherTree) reason = 'tree_owned_by_watcher';
    else if (typeof input.isWatcherCycleChat === 'function' && input.isWatcherCycleChat(source.chatId)) reason = 'owned_by_watcher';
    else if (foreignOwner?.reason === 'live_chat' || foreignOwner?.reason === 'live_delegation') reason = 'tree_busy';
    else if (foreignOwner?.reason === 'recent_orchestrator') reason = 'tree_owned_by_other';
    else if (typeof input.isChatBusy === 'function' && input.isChatBusy(source.chatId)) reason = 'busy';
    else if (typeof input.hasActiveDelegations === 'function' && input.hasActiveDelegations(source.chatId)) reason = 'delegations_active';
    else if (typeof input.isReserved === 'function' && input.isReserved(source.chatId, id(todo.id))) reason = 'reserved';
    else if (claimedByOtherTodo(source.chatId, todo, items, ancestors)) reason = 'claimed_by_other_todo';
    else if (id(input.executionFolder) !== id(readChatExecutionFolder(chat))) reason = 'folder_mismatch';
    else if (!freshness || cache.ttlKnown !== true) reason = 'cache_unknown';
    else if (cache.state !== 'warm') reason = 'cache_cold';
    else if (!Number.isFinite(cache.expiresInMs) || Number(cache.expiresInMs) < minRemainingMs) reason = 'cache_expiring';
    else if (contextTokens > maxContextTokens) reason = 'context_too_large';
    candidates.push({
      chatId: source.chatId,
      title: id(chat.title) || source.chatId,
      harness: id(chat.agentTransport || chat.harness),
      model: id(chat.model),
      source: source.source,
      eligible: !reason,
      reason,
      cache: {
        state: id(cache.state) || 'unknown',
        ttlKnown: cache.ttlKnown === true,
        expiresInMs: Number.isFinite(cache.expiresInMs) ? Number(cache.expiresInMs) : null,
      },
      contextTokens,
    });
  }
  return candidates.sort((a, b) => Number(b.eligible) - Number(a.eligible));
}
