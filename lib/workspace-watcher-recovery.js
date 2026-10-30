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
 * `recoverable` because of a transport error or an expired claim lease.
 * The single age-based exception is an orphaned `doing` leaf: no claim, no
 * chat or orchestrator identity, no worktree, no delegation and no Watcher
 * cycle, idle longer than `policy.orphanDoingMinMs` (see
 * {@link resolveOrphanDoingMinMs}).
 */

import { delegationController } from './delegation-control.js';
import { isDelegationSlotOccupied } from './delegation-status.js';
import { readTodoParentId } from './todo-tree.js';
import { isTodoAwaitingIntegration } from './todo-integration-state.js';
import { isReviewMarkerHoldingDoing } from './workspace-watcher-review-gate.js';
import { hasWorkspaceWatcherLeafRestartEvidence } from './workspace-watcher-restart-evidence.js';

/** Default idle time before an ownerless `doing` leaf is released (30 min). */
export const WORKSPACE_ORPHAN_DOING_DEFAULT_MS = 30 * 60 * 1000;

/**
 * Idle threshold for orphaned `doing` leaves. Missing/invalid policy values use
 * the default; `0` (or a negative number) disables the rule.
 *
 * @param {Record<string, any> | null | undefined} policy
 * @returns {number} milliseconds, `0` = disabled
 */
export function resolveOrphanDoingMinMs(policy) {
  const raw = policy?.orphanDoingMinMs;
  if (raw === undefined || raw === null || raw === '') return WORKSPACE_ORPHAN_DOING_DEFAULT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return WORKSPACE_ORPHAN_DOING_DEFAULT_MS;
  return n > 0 ? Math.floor(n) : 0;
}

/**
 * Evidence that a `doing` leaf has no owner at all and has been idle long
 * enough. The worktree gate runs earlier in the classifier; here we re-check
 * everything that could mean a cycle is about to start work on the leaf.
 *
 * @param {Record<string, any>} item
 * @param {Record<string, any>[]} related delegations tied to the leaf
 * @param {Record<string, any>[]} cycles active Watcher cycles
 * @param {number} now
 * @param {Record<string, any> | null | undefined} policy
 * @returns {boolean}
 */
function isOrphanDoingLeaf(item, related, cycles, now, policy) {
  const minMs = resolveOrphanDoingMinMs(policy);
  if (!minMs) return false;
  const todoId = text(item?.id);
  if (text(item?.claimedByChatId) || text(item?.claimedAt)) return false;
  if (text(item?.blockedReason)) return false;
  const stamps = [item?.updatedAt, item?.claimedAt, item?.execution?.startedAt, item?.execution?.releasedAt]
    .map((value) => Date.parse(text(value)))
    .filter((value) => Number.isFinite(value));
  if (!stamps.length) return false;
  if (now - Math.max(...stamps) < minMs) return false;
  // A cycle that lists the leaf (starting or running) may still claim it.
  if ((Array.isArray(cycles) ? cycles : []).some((cycle) => (
    Array.isArray(cycle?.todoIds) && cycle.todoIds.map(text).includes(todoId)
  ))) return false;
  return !related.some((row) => isDelegationSlotOccupied(row, now));
}

/** Probe reasons that mean "no room in this process" (never an adapter error). */
const ROOM_ABSENT_REASONS = new Set(['state_missing', 'adapter_missing']);

/**
 * The executor's room is absent in this process AND the recovery registry shows
 * its run was accepted by another process instance and is not being resumed.
 * Adapter errors and run mismatches never qualify.
 *
 * @param {{ reason?: string, known?: boolean } | null | undefined} live
 * @param {string} chatId
 * @param {(chatId: string) => boolean} [hasEvidence]
 * @returns {boolean}
 */
function isRestartOrphan(live, chatId, hasEvidence) {
  if (!chatId || live?.known === true) return false;
  if (!ROOM_ABSENT_REASONS.has(text(live?.reason))) return false;
  const check = typeof hasEvidence === 'function' ? hasEvidence : hasWorkspaceWatcherLeafRestartEvidence;
  return check(chatId) === true;
}

/**
 * A Watcher-started worktree leaf whose cycle died with a server restart: its
 * last closed Watcher cycle ended as `interrupted_restart` (or the executor chat
 * of a Watcher cycle has restart evidence), nothing is delegated and no human
 * gate holds it. Releasing it to `ready` keeps the worktree record, so the next
 * cycle reuses it. A manually started worktree has no Watcher cycle for the
 * leaf and never qualifies.
 *
 * @param {Record<string, any>} item
 * @param {string} chatId
 * @param {{ cycles?: Record<string, any>[], closedCycles?: Record<string, any>[], readWorktreeRecord?: (todoId: string) => Record<string, any> | null, hasRestartEvidence?: (chatId: string) => boolean }} input
 * @param {Record<string, any>[]} delegations
 * @param {number} now
 * @returns {boolean}
 */
function isRestartInterruptedWorktreeLeaf(item, chatId, input, delegations, now) {
  const todoId = text(item?.id);
  if (text(item?.blockedReason)) return false;
  // A leaf the Watcher already picked up again (the new cycle reuses the same
  // worktree) is live work: an older interrupted cycle must not release it.
  const claimant = text(item?.claimedByChatId);
  const activeCycles = Array.isArray(input.cycles) ? input.cycles : [];
  if (activeCycles.some((cycle) => (
    (Array.isArray(cycle?.todoIds) && cycle.todoIds.map(text).includes(todoId))
    || (claimant && text(cycle?.chatId) === claimant)
  ))) return false;
  const closed =(Array.isArray(input.closedCycles) ? input.closedCycles : [])
    .filter((cycle) => Array.isArray(cycle?.todoIds) && cycle.todoIds.map(text).includes(todoId));
  if (!closed.length) return false;
  // Origin binding: the registry record lists the Watcher cycles that prepared
  // this worktree (a manual start records none). Only the cycle that actually
  // used THIS worktree may vouch for it, so an older interrupted cycle of the
  // same todo never turns a manual worktree into a Watcher one.
  const record = typeof input.readWorktreeRecord === 'function' ? input.readWorktreeRecord(todoId) : null;
  const recordCycles = Array.isArray(record?.cycles) ? record.cycles.map(text) : [];
  if (!recordCycles.length) return false;
  const jobs = Array.isArray(delegations) ? delegations : [];
  const busy = jobs.some((row) => (
    ((chatId && text(delegationController(row)) === chatId) || text(row?.leafId) === todoId)
    && isDelegationSlotOccupied(row, now)
  ));
  if (busy) return false;
  const bound = closed.filter((cycle) => recordCycles.includes(text(cycle.cycleId)));
  if (!bound.length) return false;
  const last = bound.slice().sort((a, b) => Date.parse(text(b.at)) - Date.parse(text(a.at)) || 0)[0];
  if (text(last.closeReason) === 'interrupted_restart') return true;
  const check = typeof input.hasRestartEvidence === 'function' ? input.hasRestartEvidence : hasWorkspaceWatcherLeafRestartEvidence;
  const executorChatId = text(item?.claimedByChatId) || chatId;
  return Boolean(executorChatId) && bound.some((cycle) => text(cycle.id) === executorChatId) && check(executorChatId) === true;
}

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
 * @param {Record<string, any>} row
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
 * @param {Record<string, any>} withRun
 * @param {Record<string, any>} item
 * @param {Record<string, any>[]} related
 * @param {{ known?: boolean, busy?: boolean, reason?: string } | null | undefined} live
 * @param {(chatId: string) => Record<string, any> | null | undefined} [getChat]
 * @param {boolean} [recoverIdleOpenChat]
 * @param {(chatId: string) => boolean} [hasRestartEvidence]
 * @returns {ReturnType<typeof classifyWorkspaceDoingTodo>}
 */
function classifyExecutorRecoveryGates(withRun, item, related, live, getChat, recoverIdleOpenChat = false, hasRestartEvidence) {
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
  if (isRestartOrphan(live, /** @type {any} */ (withRun).chatId, hasRestartEvidence)) {
    return /** @type {any} */ ({ ...withRun, ...latestFields, state: 'recoverable', reason: text(live?.reason), evidence: 'restart_instance' });
  }
  return { ...withRun, ...latestFields, state: 'unknown', reason: text(live?.reason) || 'unknown', evidence: 'chat_run_probe' };
}

/**
 * Per-call lookup over one delegation list. Rows keep their original order in
 * every bucket, so results match a linear filter. Built once per classification
 * pass from the caller's arrays and never retained, so there is nothing to
 * invalidate.
 *
 * @typedef {{
 *   byLeaf: Map<string, Record<string, any>[]>,
 *   byController: Map<string, Record<string, any>[]>,
 *   position: Map<Record<string, any>, number>,
 * }} DelegationIndex
 */

/**
 * @param {Record<string, any>[]} delegations
 * @returns {DelegationIndex}
 */
export function buildDelegationIndex(delegations) {
  /** @type {DelegationIndex} */
  const out = { byLeaf: new Map(), byController: new Map(), position: new Map() };
  const push = (map, key, row) => {
    if (!key) return;
    const bucket = map.get(key);
    if (bucket) bucket.push(row);
    else map.set(key, [row]);
  };
  (Array.isArray(delegations) ? delegations : []).forEach((row, i) => {
    out.position.set(row, i);
    push(out.byLeaf, text(row?.leafId), row);
    push(out.byController, text(delegationController(row)), row);
  });
  return out;
}

/**
 * Delegations tied to a todo by controller chat or leaf id, in list order.
 *
 * @param {DelegationIndex} idx
 * @param {string} chatId
 * @param {string} todoId
 * @returns {Record<string, any>[]}
 */
function relatedFromIndex(idx, chatId, todoId) {
  const a = chatId ? idx.byController.get(chatId) || [] : [];
  const b = todoId ? idx.byLeaf.get(todoId) || [] : [];
  if (!a.length) return b.slice();
  if (!b.length) return a.slice();
  const seen = new Set(a);
  const merged = a.concat(b.filter((row) => !seen.has(row)));
  return merged.sort((x, y) => (idx.position.get(x) ?? 0) - (idx.position.get(y) ?? 0));
}

/**
 * Resolve who executes a `doing` row. `linkedChatIds` is deliberately ignored:
 * a link records that a chat touched the todo, not that it runs it.
 *
 * @param {Record<string, any>} item
 * @param {Map<string, Record<string, any>>} index
 * @param {Record<string, any>[]} delegations
 * @param {DelegationIndex} [delegationIndex] prebuilt lookup; avoids scanning `delegations` per row
 * @returns {{ source: string, chatId: string, delegationId: string }}
 */
export function resolveWorkspaceTodoExecutionIdentity(item, index, delegations, delegationIndex) {
  const sources = WORKSPACE_TODO_EXECUTION_SOURCES;
  const claimChatId = text(item?.claimedByChatId);
  if (claimChatId) return { source: sources.WATCHER_CLAIM, chatId: claimChatId, delegationId: '' };
  const todoId = text(item?.id);
  const leafJobs = (delegationIndex
    ? (todoId ? delegationIndex.byLeaf.get(todoId) || [] : [])
    : (Array.isArray(delegations) ? delegations : []).filter((row) => todoId && text(row?.leafId) === todoId))
    .slice()
    .sort((a, b) => delegationTime(b) - delegationTime(a));
  if (leafJobs.length && text(delegationController(leafJobs[0]))) {
    return {
      source: sources.DELEGATION_LEAF,
      chatId: text(delegationController(leafJobs[0])),
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
 *   item: Record<string, any>,
 *   items: Record<string, any>[],
 *   index: Map<string, Record<string, any>>,
 *   childParentIds: Set<string>,
 *   delegations: Record<string, any>[],
 *   delegationIndex?: DelegationIndex,
 *   cycles: Record<string, any>[],
 *   probe: (input: { chatId?: string, runId?: string }) => { known: boolean, busy: boolean, reason: string },
 *   isCycleChatAlive: (cycle: Record<string, any>, probe: Function, now: number) => boolean,
 *   getChat?: (chatId: string) => Record<string, any> | null,
 *   now: number,
 *   recoverIdleOpenChat?: boolean,
 *   hasLiveWorktree?: (todoId: string) => boolean,
 *   closedCycles?: Record<string, any>[],
 *   readWorktreeRecord?: (todoId: string) => Record<string, any> | null,
 *   reviewWaits?: Record<string, Record<string, any>>,
 *   reviewPolicy?: Record<string, any>,
 *   hasRestartEvidence?: (chatId: string) => boolean,
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
  const identity = resolveWorkspaceTodoExecutionIdentity(item, index, delegations, input.delegationIndex);
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
  // A worktree PASS keeps the todo `doing` with no claim; only a human may
  // integrate or reject it, so recovery must not auto-release it (contract
  // §8.3/§8.9, S13).
  if (isTodoAwaitingIntegration(item)) {
    // A failed code review (repair rounds exhausted) is not ready to integrate:
    // surface it as needs-human with the review findings instead.
    if (String(item?.review?.code?.state ?? '').trim() === 'failed') {
      return { ...base, state: 'user_action', reason: 'review_failed', evidence: 'todo_review' };
    }
    return { ...base, state: 'user_action', reason: 'integration_ready', evidence: 'todo_integration' };
  }
  // Review gate: a leaf held by a `reviewWaits` marker (worktree, or past the
  // attempt cap) waits for a human, never for automatic release to `ready`.
  if (input.reviewWaits && isReviewMarkerHoldingDoing(input.reviewWaits[todoId], input.reviewPolicy)) {
    return { ...base, state: 'user_action', reason: 'review_gate', evidence: 'review_waits' };
  }
  // A manually started worktree keeps its todo `doing` while the execution lives
  // in the worktree even when no run/delegation is currently active. Releasing
  // it would abandon the diff, so a live worktree record is a user_action, not
  // a recoverable idle executor.
  if (typeof input.hasLiveWorktree === 'function' && input.hasLiveWorktree(todoId) === true) {
    if (isRestartInterruptedWorktreeLeaf(item, base.chatId, input, delegations, now)) {
      return { ...base, state: 'recoverable', reason: 'restart_interrupted_worktree', evidence: 'restart_instance' };
    }
    // A Watcher cycle that is running this leaf right now (it reuses the same
    // worktree) is live work, not a worktree waiting for a human.
    const activeCycle = (Array.isArray(input.cycles) ? input.cycles : []).find((cycle) => (
      Array.isArray(/** @type {any} */ (cycle)?.todoIds) && /** @type {any} */ (cycle).todoIds.map(text).includes(todoId)
    ));
    if (activeCycle) {
      return { ...base, state: 'active', reason: 'worktree_cycle', evidence: 'watcher_cycle', cycleId: text(/** @type {any} */ (activeCycle).cycleId) || base.cycleId };
    }
    return { ...base, state: 'user_action', reason: 'worktree_open', evidence: 'worktree_record' };
  }
  const chatId = identity.chatId;
  const jobs = Array.isArray(delegations) ? delegations : [];
  const related = input.delegationIndex
    ? relatedFromIndex(input.delegationIndex, chatId, todoId)
    : jobs.filter((row) => (
      (chatId && text(delegationController(row)) === chatId) || (todoId && text(row?.leafId) === todoId)
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
      return classifyExecutorRecoveryGates(withRun, item, related, live, input.getChat, recoverIdleOpenChat, input.hasRestartEvidence);
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
      return classifyExecutorRecoveryGates(withRun, item, related, live, input.getChat, recoverIdleOpenChat, input.hasRestartEvidence);
    }
    // Claim is held and the probe cannot confirm the room: only restart
    // evidence (never age) may turn this into a release.
    if (isRestartOrphan(live, chatId, input.hasRestartEvidence)) {
      return classifyExecutorRecoveryGates(withRun, item, related, live, input.getChat, recoverIdleOpenChat, input.hasRestartEvidence);
    }
    return { ...withRun, state: 'unknown', reason: text(live?.reason) || 'unknown', evidence: 'chat_run_probe' };
  }
  if (text(item?.blockedReason)) {
    return { ...withRun, state: 'user_action', reason: 'blocked_reason', evidence: 'blockedReason' };
  }
  if (!chatId) {
    if (isOrphanDoingLeaf(item, related, cycles, now, input.reviewPolicy)) {
      return { ...withRun, state: 'recoverable', reason: 'orphan_doing_idle', evidence: 'idle_no_owner' };
    }
    return { ...withRun, state: 'unknown', reason: 'missing_identity', evidence: 'none' };
  }
  if (live?.known === true && live.busy === true) {
    return { ...withRun, state: 'active', reason: 'busy', evidence: 'chat_run_probe' };
  }
  return classifyExecutorRecoveryGates(withRun, item, related, live, input.getChat, recoverIdleOpenChat, input.hasRestartEvidence);
}

/**
 * Classify every `doing` row of one workspace.
 *
 * @param {{
 *   items: Record<string, any>[],
 *   delegations: Record<string, any>[],
 *   cycles: Record<string, any>[],
 *   probe: Function,
 *   isCycleChatAlive: Function,
 *   getChat?: (chatId: string) => Record<string, any> | null,
 *   now?: number,
 *   recoverIdleOpenChat?: boolean,
 *   hasLiveWorktree?: (todoId: string) => boolean,
 *   closedCycles?: Record<string, any>[],
 *   readWorktreeRecord?: (todoId: string) => Record<string, any> | null,
 *   reviewWaits?: Record<string, Record<string, any>>,
 *   reviewPolicy?: Record<string, any>,
 *   hasRestartEvidence?: (chatId: string) => boolean,
 * }} input
 * @returns {ReturnType<typeof classifyWorkspaceDoingTodo>[]}
 */
export function classifyWorkspaceDoingTodos(input) {
  const items = Array.isArray(input?.items) ? input.items : [];
  const now = Number.isFinite(input?.now) ? Number(input.now) : Date.now();
  const recoverIdleOpenChat = input?.recoverIdleOpenChat === true;
  const index = new Map(items.filter((row) => row?.id).map((row) => [String(row.id), row]));
  const childParentIds = new Set(items.map((row) => readTodoParentId(row)).filter(Boolean));
  const delegationIndex = buildDelegationIndex(input?.delegations);
  return items
    .filter((row) => row?.status === 'doing' && text(row?.id))
    .map((item) => classifyWorkspaceDoingTodo({
      item,
      items,
      index,
      childParentIds,
      delegations: input.delegations,
      delegationIndex,
      cycles: input.cycles,
      probe: input.probe,
      isCycleChatAlive: input.isCycleChatAlive,
      getChat: input.getChat,
      now,
      recoverIdleOpenChat,
      hasLiveWorktree: input.hasLiveWorktree,
      closedCycles: input.closedCycles,
      readWorktreeRecord: input.readWorktreeRecord,
      reviewWaits: input.reviewWaits,
      reviewPolicy: input.reviewPolicy,
      hasRestartEvidence: input.hasRestartEvidence,
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
