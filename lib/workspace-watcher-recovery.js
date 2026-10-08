/**
 * Workspace Watcher — recovery classification for `doing` todos.
 *
 * This is the read side of the existing claim reconcile
 * (`releaseStaleWorkspaceTodoClaims`), not a second recovery mechanism: it only
 * answers "what is this `doing` row waiting for, and what proves it". The
 * computed state never replaces the durable todo status.
 *
 * States:
 *   - `active`      a run or a delegation slot is confirmed to hold the work,
 *   - `dependency`  the row aggregates children; its status follows them,
 *   - `user_action` a human has to decide (blocker, blocked report, open chat),
 *   - `recoverable` the executor is confirmed finished/gone with no live slot,
 *   - `unknown`     liveness or identity cannot be confirmed.
 *
 * Only `recoverable` may be released, and only after the caller re-validates
 * the same evidence under the store lock. `unknown` never turns into
 * `recoverable` because of age, a transport error or an expired claim lease.
 */

import { isDelegationSlotOccupied } from './delegation-status.js';
import { readTodoParentId } from './todo-tree.js';

export const WORKSPACE_TODO_RECOVERY_STATES = Object.freeze([
  'active',
  'dependency',
  'user_action',
  'recoverable',
  'unknown',
]);

/** Where the durable execution identity of a `doing` row came from. */
export const WORKSPACE_TODO_EXECUTION_SOURCES = Object.freeze({
  WATCHER_CLAIM: 'watcher_claim',
  TODO_CHAT: 'todo_chat',
  ORCHESTRATOR: 'orchestrator_chat',
  ANCESTOR_ORCHESTRATOR: 'ancestor_orchestrator_chat',
  DELEGATION_LEAF: 'delegation_leaf',
  NONE: 'none',
});

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return String(value ?? '').trim();
}

/**
 * @param {object} row
 * @returns {number}
 */
function delegationTime(row) {
  const stamps = [row?.finishedAt, row?.startedAt, row?.createdAt]
    .map((value) => Date.parse(text(value)))
    .filter((value) => Number.isFinite(value));
  return stamps.length ? Math.max(...stamps) : 0;
}

/**
 * Shared release gates for a confirmed-not-alive executor (claimed or unclaimed).
 *
 * @param {object} withRun
 * @param {object} item
 * @param {object[]} related
 * @param {{ known?: boolean, busy?: boolean, reason?: string } | null | undefined} live
 * @param {(chatId: string) => object | null | undefined} [getChat]
 * @param {boolean} [recoverIdleOpenChat]
 * @returns {ReturnType<typeof classifyWorkspaceDoingTodo>}
 */
function classifyExecutorRecoveryGates(withRun, item, related, live, getChat, recoverIdleOpenChat = false) {
  const latest = related.slice().sort((a, b) => delegationTime(b) - delegationTime(a))[0] || null;
  const latestFields = latest ? { delegationId: text(latest.id), runId: text(latest.runId) || withRun.runId } : {};
  if (text(item?.blockedReason)) {
    return { ...withRun, ...latestFields, state: 'user_action', reason: 'blocked_reason', evidence: 'blockedReason' };
  }
  if (latest && text(latest.taskOutcome).toLowerCase() === 'blocked') {
    return { ...withRun, ...latestFields, state: 'user_action', reason: 'delegation_blocked', evidence: 'delegation' };
  }
  if (text(live?.reason) === 'chat_missing') {
    return { ...withRun, ...latestFields, state: 'recoverable', reason: 'chat_missing', evidence: 'chat_run_probe' };
  }
  if (live?.known === true && live.busy === false) {
    const chat = typeof getChat === 'function' ? getChat(withRun.chatId) : null;
    if (chat && chat.archived === true) {
      return { ...withRun, ...latestFields, state: 'recoverable', reason: 'idle_archived_chat', evidence: 'chat_run_probe' };
    }
    if (recoverIdleOpenChat) {
      return { ...withRun, ...latestFields, state: 'recoverable', reason: 'idle_open_chat', evidence: 'chat_run_probe' };
    }
    return { ...withRun, ...latestFields, state: 'user_action', reason: 'idle_open_chat', evidence: 'chat_run_probe' };
  }
  return { ...withRun, ...latestFields, state: 'unknown', reason: text(live?.reason) || 'unknown', evidence: 'chat_run_probe' };
}

/**
 * Resolve who executes a `doing` row. `linkedChatIds` is deliberately ignored:
 * a link records that a chat touched the todo, not that it runs it.
 *
 * @param {object} item
 * @param {Map<string, object>} index
 * @param {object[]} delegations
 * @returns {{ source: string, chatId: string, delegationId: string }}
 */
export function resolveWorkspaceTodoExecutionIdentity(item, index, delegations) {
  const sources = WORKSPACE_TODO_EXECUTION_SOURCES;
  const claimChatId = text(item?.claimedByChatId);
  if (claimChatId) return { source: sources.WATCHER_CLAIM, chatId: claimChatId, delegationId: '' };
  const todoId = text(item?.id);
  const leafJobs = (Array.isArray(delegations) ? delegations : [])
    .filter((row) => todoId && text(row?.leafId) === todoId)
    .sort((a, b) => delegationTime(b) - delegationTime(a));
  if (leafJobs.length && text(leafJobs[0].parentChatId)) {
    return {
      source: sources.DELEGATION_LEAF,
      chatId: text(leafJobs[0].parentChatId),
      delegationId: text(leafJobs[0].id),
    };
  }
  const todoChatId = text(item?.chatId);
  if (todoChatId) return { source: sources.TODO_CHAT, chatId: todoChatId, delegationId: '' };
  const ownOrchestrator = text(item?.orchestratorChatId);
  if (ownOrchestrator) return { source: sources.ORCHESTRATOR, chatId: ownOrchestrator, delegationId: '' };
  const visited = new Set([todoId]);
  let parent = index.get(readTodoParentId(item));
  while (parent?.id && !visited.has(parent.id)) {
    visited.add(parent.id);
    const inherited = text(parent.orchestratorChatId);
    if (inherited) return { source: sources.ANCESTOR_ORCHESTRATOR, chatId: inherited, delegationId: '' };
    parent = index.get(readTodoParentId(parent));
  }
  return { source: sources.NONE, chatId: '', delegationId: '' };
}

/**
 * Classify one `doing` row.
 *
 * @param {{
 *   item: object,
 *   items: object[],
 *   index: Map<string, object>,
 *   childParentIds: Set<string>,
 *   delegations: object[],
 *   cycles: object[],
 *   probe: (input: { chatId?: string, runId?: string }) => { known: boolean, busy: boolean, reason: string },
 *   isCycleChatAlive: (cycle: object, probe: Function, now: number) => boolean,
 *   getChat?: (chatId: string) => object | null,
 *   now: number,
 *   recoverIdleOpenChat?: boolean,
 * }} input
 * @returns {{
 *   todoId: string, state: string, reason: string, source: string, evidence: string,
 *   chatId: string, runId: string, cycleId: string, delegationId: string,
 *   attemptId: string, revision: string, claimed: boolean,
 * }}
 */
export function classifyWorkspaceDoingTodo(input) {
  const { item, index, delegations, cycles, probe, isCycleChatAlive, now } = input;
  const recoverIdleOpenChat = input.recoverIdleOpenChat === true;
  const todoId = text(item?.id);
  const identity = resolveWorkspaceTodoExecutionIdentity(item, index, delegations);
  const base = {
    todoId,
    state: 'unknown',
    reason: '',
    source: identity.source,
    evidence: '',
    chatId: identity.chatId,
    runId: '',
    cycleId: text(item?.execution?.cycleId),
    delegationId: identity.delegationId,
    attemptId: text(item?.execution?.attemptId),
    revision: text(item?.updatedAt),
    claimed: Boolean(text(item?.claimedByChatId)),
  };
  if (input.childParentIds.has(todoId)) {
    return { ...base, state: 'dependency', reason: 'aggregates_children', evidence: 'children' };
  }
  const chatId = identity.chatId;
  const jobs = Array.isArray(delegations) ? delegations : [];
  const related = jobs.filter((row) => (
    (chatId && text(row?.parentChatId) === chatId) || (todoId && text(row?.leafId) === todoId)
  ));
  const occupied = related.find((row) => isDelegationSlotOccupied(row, now));
  if (occupied) {
    return {
      ...base,
      state: 'active',
      reason: text(occupied.runStoppingAt) ? 'run_stopping' : 'delegation_in_progress',
      evidence: 'delegation',
      delegationId: text(occupied.id),
      runId: text(occupied.runId),
    };
  }
  const ownerCycle = chatId
    ? (Array.isArray(cycles) ? cycles : []).find((cycle) => text(cycle?.chatId) === chatId) || null
    : null;
  const runId = text(ownerCycle?.runId);
  const withRun = { ...base, runId, cycleId: text(ownerCycle?.cycleId) || base.cycleId };
  const live = chatId ? probe({ chatId, runId: runId || undefined }) : null;
  if (base.claimed) {
    // Same rule as the claim release: the owning cycle (run-scoped) and the
    // bare chat (chat-scoped) must both be confirmed not alive before release.
    const alive = (ownerCycle && isCycleChatAlive(ownerCycle, probe, now))
      || isCycleChatAlive({ chatId }, probe, now);
    if (!alive) {
      return classifyExecutorRecoveryGates(withRun, item, related, live, input.getChat, recoverIdleOpenChat);
    }
    if (live?.known === true && live.busy === true) {
      return { ...withRun, state: 'active', reason: 'busy', evidence: 'chat_run_probe' };
    }
    const phase = text(ownerCycle?.phase).toLowerCase();
    const startDeadlineAt = Date.parse(text(ownerCycle?.startDeadlineAt));
    if (phase === 'starting') {
      const inStartWindow = Number.isFinite(startDeadlineAt) && now < startDeadlineAt;
      if (inStartWindow || (live?.known === true && live.busy === true)) {
        return { ...withRun, state: 'active', reason: 'starting', evidence: 'watcher_cycle' };
      }
      return classifyExecutorRecoveryGates(withRun, item, related, live, input.getChat, recoverIdleOpenChat);
    }
    return { ...withRun, state: 'unknown', reason: text(live?.reason) || 'unknown', evidence: 'chat_run_probe' };
  }
  if (text(item?.blockedReason)) {
    return { ...withRun, state: 'user_action', reason: 'blocked_reason', evidence: 'blockedReason' };
  }
  if (!chatId) {
    return { ...withRun, state: 'unknown', reason: 'missing_identity', evidence: 'none' };
  }
  if (live?.known === true && live.busy === true) {
    return { ...withRun, state: 'active', reason: 'busy', evidence: 'chat_run_probe' };
  }
  return classifyExecutorRecoveryGates(withRun, item, related, live, input.getChat, recoverIdleOpenChat);
}

/**
 * Classify every `doing` row of one workspace.
 *
 * @param {{
 *   items: object[],
 *   delegations: object[],
 *   cycles: object[],
 *   probe: Function,
 *   isCycleChatAlive: Function,
 *   getChat?: (chatId: string) => object | null,
 *   now?: number,
 *   recoverIdleOpenChat?: boolean,
 * }} input
 * @returns {ReturnType<typeof classifyWorkspaceDoingTodo>[]}
 */
export function classifyWorkspaceDoingTodos(input) {
  const items = Array.isArray(input?.items) ? input.items : [];
  const now = Number.isFinite(input?.now) ? Number(input.now) : Date.now();
  const recoverIdleOpenChat = input?.recoverIdleOpenChat === true;
  const index = new Map(items.filter((row) => row?.id).map((row) => [String(row.id), row]));
  const childParentIds = new Set(items.map((row) => readTodoParentId(row)).filter(Boolean));
  return items
    .filter((row) => row?.status === 'doing' && text(row?.id))
    .map((item) => classifyWorkspaceDoingTodo({
      item,
      items,
      index,
      childParentIds,
      delegations: input.delegations,
      cycles: input.cycles,
      probe: input.probe,
      isCycleChatAlive: input.isCycleChatAlive,
      getChat: input.getChat,
      now,
      recoverIdleOpenChat,
    }));
}

/**
 * Count classified rows per state for the watcher read model.
 *
 * @param {Array<{ state: string }>} states
 * @returns {Record<string, number>}
 */
export function summarizeWorkspaceTodoRecovery(states) {
  /** @type {Record<string, number>} */
  const counts = Object.fromEntries(WORKSPACE_TODO_RECOVERY_STATES.map((state) => [state, 0]));
  for (const row of Array.isArray(states) ? states : []) {
    if (Object.prototype.hasOwnProperty.call(counts, row?.state)) counts[row.state] += 1;
  }
  return counts;
}
