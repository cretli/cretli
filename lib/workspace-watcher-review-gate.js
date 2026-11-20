/**
 * Workspace Watcher review gate (`docs/workspace-watcher-review-gate.md`).
 *
 * Server-side check that an agent-written `status: done` (and a worktree
 * integration result) is backed by a current code review. The default policy
 * (`requireReviewForDone: 'off'`) never reads `todo.review` and changes nothing.
 *
 * Pure helpers live here; the callers (REST route, MCP tool, cycle close,
 * recovery) own the side effects so every path shares one evaluation.
 */

import { todoReviewSubjectSnapshot } from './todo-review-state.js';
import { isTodoAwaitingIntegration } from './todo-integration-state.js';
import { normalizeStatus } from './persist/todos-persist.js';

/** Close/decision reason and todo label for an unsatisfied gate. */
export const REVIEW_MISSING_REASON = 'review_missing';
/** Todo label once the attempt cap is exceeded: a human must intervene. */
export const REVIEW_GATE_EXHAUSTED_REASON = 'review_gate_exhausted';

/** Prefix of the `blockedReason` written for an unsatisfied worktree leaf. */
export const REVIEW_MISSING_BLOCKED_PREFIX = 'Workspace Watcher review gate: review_missing';
/** Prefix of the `blockedReason` written once the attempt cap is exceeded. */
export const REVIEW_GATE_EXHAUSTED_BLOCKED_PREFIX = 'Workspace Watcher review gate: review_gate_exhausted';

const MODES = Object.freeze(['off', 'warn', 'enforce']);
const DEFAULT_MAX_ATTEMPTS = 2;

/**
 * @param {unknown} policy
 * @returns {'off'|'warn'|'enforce'}
 */
export function resolveReviewGateMode(policy) {
  const value = String(/** @type {Record<string, unknown>} */ (policy && typeof policy === 'object' ? policy : {}).requireReviewForDone ?? '')
    .trim()
    .toLowerCase();
  return MODES.includes(value) ? /** @type {'off'|'warn'|'enforce'} */ (value) : 'off';
}

/**
 * @param {unknown} policy
 * @returns {number}
 */
export function resolveReviewGateMaxAttempts(policy) {
  const raw = Number(/** @type {Record<string, unknown>} */ (policy && typeof policy === 'object' ? policy : {}).reviewGateMaxAttempts);
  if (!Number.isInteger(raw) || raw < 1) return DEFAULT_MAX_ATTEMPTS;
  return Math.min(5, raw);
}

/**
 * Whether a `blockedReason` is one of the two review-gate labels.
 *
 * @param {unknown} reason
 * @returns {boolean}
 */
export function isReviewGateBlockedReason(reason) {
  const text = String(reason ?? '').trim();
  return text.startsWith(REVIEW_MISSING_BLOCKED_PREFIX) || text.startsWith(REVIEW_GATE_EXHAUSTED_BLOCKED_PREFIX);
}

/**
 * @param {Record<string, any> | null | undefined} todo
 * @returns {string}
 */
export function resolveReviewGateMaterialRevision(todo) {
  const snapshot = todoReviewSubjectSnapshot(todo, 'code');
  const fromReview = String(snapshot?.material?.revision ?? '').trim();
  if (fromReview) return fromReview;
  const commit = String(todo?.leafMaterial?.lastCheckpoint?.commit ?? '').trim();
  return commit;
}

/**
 * Evaluate the gate condition on one leaf (contract §2.2). Only `review.code`
 * is read; a plan review never satisfies.
 *
 * @param {{ todo: Record<string, any> | null | undefined, policy?: Record<string, any> | null }} input
 * @returns {{ satisfied: boolean, state: string, reason: string }}
 */
export function evaluateReviewGate(input) {
  const todo = input.todo && typeof input.todo === 'object' ? input.todo : null;
  const snapshot = todo ? todoReviewSubjectSnapshot(todo, 'code') : null;
  const state = String(snapshot?.state ?? 'none').trim() || 'none';
  if (!snapshot) return { satisfied: false, state: 'none', reason: 'no_code_review' };
  if (state !== 'passed' && state !== 'manual') return { satisfied: false, state, reason: `review_${state}` };
  if (snapshot.material?.current !== true) return { satisfied: false, state, reason: 'material_not_current' };
  if (state === 'manual') return { satisfied: true, state, reason: 'manual_acceptance' };
  if (snapshot.implementer == null) return { satisfied: false, state, reason: 'no_implementer' };
  const requireIndependent = input.policy && typeof input.policy === 'object'
    && /** @type {Record<string, unknown>} */ (input.policy).requireIndependentReview === true;
  if (requireIndependent && snapshot.independence?.independent !== true) {
    return { satisfied: false, state, reason: 'not_independent' };
  }
  return { satisfied: true, state, reason: 'passed' };
}

/**
 * Next marker map after a close. Unsatisfied -> `attempts + 1` (reset on a
 * material change); satisfied -> the entry is dropped.
 *
 * @param {{
 *   reviewWaits?: Record<string, any> | null,
 *   todoId: string,
 *   gate: { satisfied: boolean, state: string },
 *   materialRevision: string,
 *   worktree: boolean,
 *   maxAttempts: number,
 *   at: string,
 * }} input
 * @returns {{ reviewWaits: Record<string, any>, entry: Record<string, any> | null, exhausted: boolean }}
 */
export function nextReviewWaitsAfterClose(input) {
  const waits = { ...(input.reviewWaits && typeof input.reviewWaits === 'object' ? input.reviewWaits : {}) };
  const previous = waits[input.todoId] || null;
  if (input.gate.satisfied) {
    delete waits[input.todoId];
    return { reviewWaits: waits, entry: null, exhausted: false };
  }
  const changed = Boolean(previous) && String(previous.materialRevision ?? '') !== input.materialRevision;
  const keep = previous && !changed ? previous : null;
  const attempts = (keep ? Number(keep.attempts) || 0 : 0) + 1;
  const phase = input.gate.state === 'failed' || (keep && keep.phase === 'fix') ? 'fix' : 'review';
  const entry = {
    since: keep && keep.since ? String(keep.since) : input.at,
    attempts: Math.min(attempts, input.maxAttempts + 1),
    materialRevision: input.materialRevision,
    phase,
    worktree: input.worktree === true || Boolean(previous && previous.worktree),
  };
  waits[input.todoId] = entry;
  return { reviewWaits: waits, entry, exhausted: attempts > input.maxAttempts };
}

/**
 * Whether a marker holds the leaf in `doing` after the claim is released (a
 * worktree leaf, or an exhausted non-worktree leaf).
 *
 * @param {{ attempts?: number, worktree?: boolean } | null | undefined} marker
 * @param {unknown} policy
 * @returns {boolean}
 */
export function isReviewMarkerHoldingDoing(marker, policy) {
  if (!marker) return false;
  if (resolveReviewGateMode(policy) !== 'enforce') return false;
  return marker.worktree === true || Number(marker.attempts) > resolveReviewGateMaxAttempts(policy);
}

/**
 * @param {{ attempts?: number } | null | undefined} marker
 * @param {unknown} policy
 * @returns {boolean}
 */
export function isReviewMarkerExhausted(marker, policy) {
  return Boolean(marker) && Number(marker.attempts) > resolveReviewGateMaxAttempts(policy);
}

/**
 * Label text for a marker (worktree leaf below the cap, or exhausted).
 *
 * @param {{ attempts?: number } | null | undefined} marker
 * @param {unknown} policy
 * @returns {string}
 */
export function buildReviewGateBlockedReason(marker, policy) {
  if (isReviewMarkerExhausted(marker, policy)) {
    return `${REVIEW_GATE_EXHAUSTED_BLOCKED_PREFIX} (${marker?.attempts}/${resolveReviewGateMaxAttempts(policy)}). A human must review or accept the work.`;
  }
  return `${REVIEW_MISSING_BLOCKED_PREFIX}. A passed code review with an implementer is required before this leaf can be done.`;
}

/**
 * @param {Record<string, { parentId?: unknown }>[] | Record<string, any>[]} items
 * @returns {Map<string, Record<string, any>>}
 */
function indexTodos(items) {
  const map = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const id = String(item?.id ?? '').trim();
    if (id) map.set(id, item);
  }
  return map;
}

/**
 * Whether `todoId` (or an ancestor) is a todo of a live cycle, or the leaf has
 * a durable marker. The marker alone decides membership of the waiting set —
 * never `blockedReason` or `status`.
 *
 * @param {{ row: Record<string, any> | null | undefined, todoId: string, items: Record<string, any>[] }} input
 * @returns {boolean}
 */
export function isReviewGatedTarget(input) {
  const row = input.row && typeof input.row === 'object' ? input.row : {};
  const id = String(input.todoId ?? '').trim();
  if (!id) return false;
  if (row.reviewWaits && Object.prototype.hasOwnProperty.call(row.reviewWaits, id)) return true;
  const cycleIds = new Set();
  const cycles = Array.isArray(row.activeCycles) ? row.activeCycles : (row.activeCycle ? [row.activeCycle] : []);
  for (const cycle of cycles) {
    if (cycle && cycle.planOnly === true) continue;
    for (const todoId of Array.isArray(cycle?.todoIds) ? cycle.todoIds : []) {
      const value = String(todoId ?? '').trim();
      if (value) cycleIds.add(value);
    }
  }
  if (!cycleIds.size) return false;
  const byId = indexTodos(input.items);
  let cursor = id;
  for (let depth = 0; cursor && depth < 64; depth += 1) {
    if (cycleIds.has(cursor)) return true;
    const parent = String(byId.get(cursor)?.parentId ?? '').trim();
    cursor = parent;
  }
  return false;
}

/**
 * Classify the origin of a gated write for logging only.
 *
 * @param {{ chatId?: string, row?: Record<string, any> | null, delegations?: Record<string, any>[] }} input
 * @returns {'cycle_chat'|'other_chat'|'unknown_caller'}
 */
export function classifyReviewGateCaller(input) {
  const chatId = String(input.chatId ?? '').trim();
  if (!chatId) return 'unknown_caller';
  const row = input.row && typeof input.row === 'object' ? input.row : {};
  const cycles = Array.isArray(row.activeCycles) ? row.activeCycles : [];
  const owned = new Set(cycles.map((cycle) => String(cycle?.chatId ?? '').trim()).filter(Boolean));
  if (owned.has(chatId)) return 'cycle_chat';
  const delegations = Array.isArray(input.delegations) ? input.delegations : [];
  let current = chatId;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    const edge = delegations.find((entry) => String(entry?.childChatId ?? entry?.chatId ?? '') === current);
    const parent = String(edge?.parentChatId ?? '').trim();
    if (!parent) break;
    if (owned.has(parent)) return 'cycle_chat';
    current = parent;
  }
  return 'other_chat';
}

/**
 * Guard for a `status: done` write on the REST/MCP entry points (D1/D2).
 *
 * `caller.kind` is derived from the signed token only: `mcp` and `widget` are
 * gated callers, a browser session (`session`) never is. A `done` on a target
 * under `enforce` without a satisfied gate is rejected; `warn` passes and asks
 * the caller to record the finding.
 *
 * @param {{
 *   todo: Record<string, any> | null | undefined,
 *   patch?: Record<string, unknown> | null,
 *   caller: { kind: 'session'|'mcp'|'widget', chatId?: string },
 *   row: Record<string, any> | null | undefined,
 *   policy?: Record<string, any> | null,
 *   items?: Record<string, any>[],
 *   delegations?: Record<string, any>[],
 * }} input
 * @returns {{
 *   allowed: boolean,
 *   warn: boolean,
 *   reason: string,
 *   gate: { satisfied: boolean, state: string, reason: string } | null,
 *   callerClass: string,
 *   clearMarker: boolean,
 *   gated: boolean,
 * }}
 */
export function guardCycleDoneWrite(input) {
  const policy = input.policy || input.row?.policy || {};
  const mode = resolveReviewGateMode(policy);
  const callerKind = input.caller?.kind || 'session';
  const base = {
    allowed: true, warn: false, reason: '', gate: null, callerClass: 'session', clearMarker: false, gated: false,
  };
  const row = input.row && typeof input.row === 'object' ? input.row : {};
  const todoId = String(input.todo?.id ?? '').trim();
  const hasMarker = Boolean(todoId && row.reviewWaits && row.reviewWaits[todoId]);
  // A human in a browser session clears a marker with any status action; the
  // write itself is never judged.
  if (callerKind === 'session') {
    const touchesStatus = input.patch && input.patch.status !== undefined && input.patch.status !== null;
    return { ...base, clearMarker: hasMarker && Boolean(touchesStatus) };
  }
  if (mode === 'off') return base;
  const patch = input.patch && typeof input.patch === 'object' ? input.patch : {};
  // Same normalization as updateTodo (trim + lowercase), so `Done`/`DONE` cannot bypass.
  if (patch.status == null || normalizeStatus(patch.status) !== 'done') return base;
  // Integration-ready leaves are never touched by the gate (table B, last row).
  if (input.todo && isTodoAwaitingIntegration(input.todo)) return base;
  const items = Array.isArray(input.items) ? input.items : [];
  const gated = isReviewGatedTarget({ row, todoId, items });
  if (!gated) return base;
  const callerClass = classifyReviewGateCaller({
    chatId: input.caller?.chatId,
    row,
    delegations: input.delegations,
  });
  const gate = evaluateReviewGate({ todo: input.todo, policy });
  if (gate.satisfied) {
    return { ...base, gate, callerClass, gated: true, clearMarker: hasMarker };
  }
  if (mode === 'warn') {
    return { ...base, warn: true, reason: REVIEW_MISSING_REASON, gate, callerClass, gated: true };
  }
  return { ...base, allowed: false, reason: REVIEW_MISSING_REASON, gate, callerClass, gated: true };
}
