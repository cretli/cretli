/**
 * Pure autopilot guardrails for the Workspace Watcher (stage B).
 *
 * Everything here is deterministic and clock-injected so the timing rules
 * (quiet hours, per-UTC-day budget, cooldown, exponential backoff, repeated
 * findings) can be unit-tested without waiting. The module never writes and
 * never starts anything: it answers whether a cycle may start right now and, if
 * not, why. `decideWorkspaceWatcherAction` maps that answer onto a decision
 * kind; `startWorkspaceWatcherCycle` is the only code that acts on it.
 *
 * Quiet hours are interpreted in UTC (HH:MM, wrapping through midnight). The
 * store carries no timezone on purpose: a server-side guard must not depend on
 * the operator's local clock.
 */

import { createHash } from 'node:crypto';
import { hasExplicitLeafScopeSection } from './todo-parallel-scope.js';
import { evaluateWorkspaceWatcherSafetyValve } from './workspace-watcher-scheduler.js';
import { workspaceWatcherPoolLimit } from './workspace-watcher-pool.js';
import { computeTodoPlanRevisionKey } from './plan-reviewer-cooperation.js';

export const WORKSPACE_WATCHER_GUARDRAIL_KINDS = Object.freeze([
  'allowed',
  'paused',
  'wait_quiet_hours',
  'wait_budget',
  'wait_cooldown',
  'backoff',
  'wait_same_findings',
  'wait_harness_usage',
  'plan_gate',
  'wait_plan_approval',
]);

/**
 * @param {{ byTodo?: Record<string, { hash?: string, streak?: number }> }} [findings]
 * @param {string} todoId
 * @returns {{ hash: string, streak: number, summary: string }}
 */
export function readWorkspaceWatcherTodoFindings(findings, todoId) {
  const id = String(todoId ?? '').trim();
  if (!id) return { hash: '', streak: 0, summary: '' };
  const row = findings?.byTodo?.[id];
  if (!row) return { hash: '', streak: 0, summary: '' };
  return {
    hash: String(row.hash ?? '').trim(),
    streak: Math.max(0, Math.floor(toFiniteNumber(row.streak, 0))),
    summary: String(row.summary ?? '').trim(),
  };
}

/**
 * Harnesses currently blocked by a whole-harness usage limit (empty model row).
 *
 * @param {Record<string, any>[]} activeUsageLimits
 * @param {number} [now]
 * @returns {Set<string>}
 */
export function listWorkspaceWatcherWholeHarnessUsageBlocks(activeUsageLimits, now = Date.now()) {
  /** @type {Set<string>} */
  const blocked = new Set();
  for (const row of Array.isArray(activeUsageLimits) ? activeUsageLimits : []) {
    const harness = String(row?.harness ?? '').trim();
    if (!harness) continue;
    if (String(row?.model ?? '').trim()) continue;
    const resetAt = Date.parse(String(row?.resetAt ?? '').trim());
    if (!Number.isFinite(resetAt) || resetAt <= now) continue;
    blocked.add(harness);
  }
  return blocked;
}

/**
 * Earliest reset among the allowed harnesses when every one of them is
 * whole-harness limited; 0 when some harness is free or the list is empty.
 *
 * @param {Record<string, any>} watcher
 * @param {Record<string, any>[]} activeUsageLimits
 * @param {number} [now]
 * @returns {number} epoch ms
 */
export function earliestWorkspaceWatcherHarnessResetMs(watcher, activeUsageLimits, now = Date.now()) {
  const policy = watcher?.policy && typeof watcher.policy === 'object' ? watcher.policy : {};
  const allowed = Array.isArray(policy.allowedHarnesses)
    ? policy.allowedHarnesses.map((h) => String(h ?? '').trim()).filter(Boolean)
    : [];
  if (!allowed.length || hasWorkspaceWatcherAvailableHarness(watcher, activeUsageLimits, now)) return 0;
  const resets = [];
  for (const harness of allowed) {
    // A harness may carry several whole-harness rows; it frees up at the latest.
    const times = (Array.isArray(activeUsageLimits) ? activeUsageLimits : [])
      .filter((row) => String(row?.harness ?? '').trim() === harness && !String(row?.model ?? '').trim())
      .map((row) => Date.parse(String(row?.resetAt ?? '').trim()))
      .filter((t) => Number.isFinite(t) && t > now);
    if (times.length) resets.push(Math.max(...times));
  }
  return resets.length ? Math.min(...resets) : 0;
}

/**
 * @param {Record<string, any>} watcher
 * @param {Record<string, any>[]} activeUsageLimits
 * @param {number} [now]
 * @returns {boolean}
 */
export function hasWorkspaceWatcherAvailableHarness(watcher, activeUsageLimits, now = Date.now()) {
  const policy = watcher?.policy && typeof watcher.policy === 'object' ? watcher.policy : {};
  const allowedHarnesses = Array.isArray(policy.allowedHarnesses)
    ? policy.allowedHarnesses.map((h) => String(h ?? '').trim()).filter(Boolean)
    : [];
  if (!allowedHarnesses.length) return true;
  const blocked = listWorkspaceWatcherWholeHarnessUsageBlocks(activeUsageLimits, now);
  return allowedHarnesses.some((harness) => !blocked.has(harness));
}

/**
 * `YYYY-MM-DD` in UTC. The budget day is compared as a string, and a store that
 * carries a different day counts as zero used cycles.
 *
 * @param {number} [now]
 * @returns {string}
 */
export function workspaceWatcherUtcDayKey(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * @param {unknown} value
 * @returns {number | null} minutes since UTC midnight, or null when unusable
 */
function parseClockMinutes(value) {
  const raw = String(value ?? '').trim();
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * @param {unknown} quietHours
 * @returns {{ start: number, end: number } | null}
 */
export function parseWorkspaceWatcherQuietHours(quietHours) {
  if (!quietHours || typeof quietHours !== 'object') return null;
  const source = /** @type {{ start?: unknown, end?: unknown }} */ (quietHours);
  const start = parseClockMinutes(source.start);
  const end = parseClockMinutes(source.end);
  if (start == null || end == null) return null;
  // Identical bounds are ambiguous (zero-length or all-day window), so they are
  // treated as "no quiet hours" instead of guessing.
  if (start === end) return null;
  return { start, end };
}

/**
 * @param {unknown} quietHours
 * @param {number} [now]
 * @returns {boolean}
 */
export function isWorkspaceWatcherQuietHours(quietHours, now = Date.now()) {
  const window = parseWorkspaceWatcherQuietHours(quietHours);
  if (!window) return false;
  const date = new Date(now);
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  if (window.start < window.end) return minutes >= window.start && minutes < window.end;
  // Wraps midnight: [start, 24:00) ∪ [00:00, end).
  return minutes >= window.start || minutes < window.end;
}

/**
 * Exponential backoff from the accumulated failure count, capped. Returns an
 * empty string when there is nothing to back off from.
 *
 * @param {{
 *   failures?: Record<string, unknown>,
 *   now?: number,
 *   baseMs?: number,
 *   capMs?: number,
 * }} [input]
 * @returns {string} ISO timestamp, or '' when no backoff applies
 */
export function computeWorkspaceWatcherBackoffUntil(input = {}) {
  const failures = input.failures && typeof input.failures === 'object' ? input.failures : {};
  let total = 0;
  for (const value of Object.values(failures)) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) total += Math.floor(n);
  }
  if (total <= 0) return '';
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const baseMs = Number.isFinite(input.baseMs) && Number(input.baseMs) > 0 ? Number(input.baseMs) : 60_000;
  const capMs = Number.isFinite(input.capMs) && Number(input.capMs) > 0 ? Number(input.capMs) : 6 * 60 * 60_000;
  const delay = Math.min(capMs, baseMs * (2 ** Math.max(0, total - 1)));
  return new Date(now + delay).toISOString();
}

/** Consecutive infra-failure cycles on one harness+model before it cools down. */
export const WORKSPACE_WATCHER_INFRA_STREAK_THRESHOLD = 3;
/** How long a cooled-down orchestrator model/harness stays excluded. */
export const WORKSPACE_WATCHER_ORCHESTRATOR_COOLDOWN_TTL_MS = 2 * 60 * 60_000;
/** A run that errored within this real duration (run-end snapshot) is "short". */
export const WORKSPACE_WATCHER_INFRA_SHORT_RUN_MAX_MS = 60_000;
/** `stopReason` set when no orchestrator candidate is left outside a cooldown. */
export const WORKSPACE_WATCHER_STOP_ORCHESTRATOR_INFRA_STREAK = 'orchestrator_infra_failure_streak';

/** @param {unknown} harness @param {unknown} model */
export function workspaceWatcherInfraStreakKey(harness, model) {
  return `${String(harness ?? '').trim().toLowerCase()}\u0000${String(model ?? '').trim().toLowerCase()}`;
}

/**
 * Classify a closed cycle for the orchestrator circuit breaker. Pure and
 * cause-based: the duration used is the real orchestrator run duration from the
 * run-end snapshot (`cycle.runEnd`), never the time the cycle was closed, so a
 * 10 s failure closed by reconcile after the 2 min room-gone grace is still short.
 *
 * `streak`: 'count' (infra failure before work), 'reset' (the model demonstrably
 * ran: success, todo incomplete, long failure, run ended without a report) or
 * 'ignore' (blocked, interrupted, cancelled, unknown cause).
 *
 * @param {{ outcome?: string, closeReason?: string, cycle?: Record<string, any>, hasReports?: boolean }} [input]
 * @returns {{ cause: string, streak: 'count' | 'reset' | 'ignore', runDurationMs: number | null }}
 */
export function classifyWorkspaceWatcherCycleInfraCause(input = {}) {
  const outcome = String(input.outcome || '').trim();
  const cycle = input.cycle && typeof input.cycle === 'object' ? input.cycle : {};
  const runEnd = cycle.runEnd && typeof cycle.runEnd === 'object' ? cycle.runEnd : null;
  const runDurationMs = Number.isFinite(runEnd?.durationMs) ? Number(runEnd.durationMs) : null;
  const base = { runDurationMs };
  if (outcome === 'success') return { ...base, cause: 'success', streak: 'reset' };
  if (outcome === 'interrupted_restart' || outcome === 'interrupted') {
    return { ...base, cause: 'interrupted', streak: 'ignore' };
  }
  if (outcome !== 'failure') return { ...base, cause: 'blocked', streak: 'ignore' };
  if (runEnd?.status === 'cancelled') return { ...base, cause: 'cancelled', streak: 'ignore' };
  // The orchestrator answered (a report exists or it reported an outcome): the
  // model works, the todo is what is incomplete.
  if (String(cycle.reportedOutcome || '').trim() || input.hasReports === true
    || String(input.closeReason || '') === 'cycle_no_progress') {
    return { ...base, cause: 'todo_incomplete', streak: 'reset' };
  }
  if (!runEnd) return { ...base, cause: 'unknown', streak: 'ignore' };
  if (runEnd.status === 'error') {
    const short = runDurationMs != null && runDurationMs <= WORKSPACE_WATCHER_INFRA_SHORT_RUN_MAX_MS;
    const beforeWork = runEnd.outputSeen !== true && runEnd.errorStage !== 'after_output';
    if (short && beforeWork) {
      const detail = String(runEnd.errorCode || runEnd.errorSource || 'provider').trim().toLowerCase();
      return { ...base, cause: `infra:${detail}`, streak: 'count' };
    }
    return { ...base, cause: 'long_failure', streak: 'reset' };
  }
  return { ...base, cause: 'run_ended_without_report', streak: 'reset' };
}

/**
 * Cooldowns still in force at `now`.
 *
 * @param {Record<string, any> | null | undefined} row
 * @param {number} [now]
 * @returns {Array<Record<string, any>>}
 */
export function activeWorkspaceWatcherOrchestratorCooldowns(row, now = Date.now()) {
  const list = Array.isArray(row?.orchestratorCooldowns) ? row.orchestratorCooldowns : [];
  return list.filter((entry) => Date.parse(String(entry?.until || '')) > now);
}

/**
 * The cooldown covering a harness+model pair, if any.
 *
 * @param {Record<string, any> | null | undefined} row
 * @param {unknown} harness
 * @param {unknown} model
 * @param {number} [now]
 * @returns {Record<string, any> | null}
 */
export function findWorkspaceWatcherOrchestratorCooldown(row, harness, model, now = Date.now()) {
  const h = String(harness ?? '').trim().toLowerCase();
  const m = String(model ?? '').trim().toLowerCase();
  return activeWorkspaceWatcherOrchestratorCooldowns(row, now).find((entry) => entry.harness === h
    && (entry.scope === 'harness' || entry.model === m)) || null;
}

/**
 * Apply one classified close to the streak/cooldown/backoff state. Returns the
 * row patch plus decisions. Idempotent per `runKey`: a run increments a streak
 * at most once. Closes are applied serially inside the row mutation, so with
 * `maxParallel > 1` the result is the deterministic fold in close order.
 *
 * @param {{
 *   row: Record<string, any>,
 *   harness: string,
 *   model: string,
 *   runKey: string,
 *   classification: { cause: string, streak: string },
 *   now: number,
 *   at: string,
 * }} input
 * @returns {{ patch: Record<string, any>, decisions: Record<string, any>[], counted: boolean }}
 */
export function applyWorkspaceWatcherInfraClassification(input) {
  const row = input.row || {};
  const harness = String(input.harness || '').trim().toLowerCase();
  const model = String(input.model || '').trim().toLowerCase();
  const now = input.now;
  const key = workspaceWatcherInfraStreakKey(harness, model);
  const streaks = { ...(row.infraStreaks || {}) };
  const cooldowns = activeWorkspaceWatcherOrchestratorCooldowns(row, now);
  const patch = { infraStreaks: streaks, orchestratorCooldowns: cooldowns };
  const decisions = [];
  if (!harness || !model || input.classification.streak === 'ignore') {
    return { patch, decisions, counted: false };
  }
  if (input.classification.streak === 'reset') {
    delete streaks[key];
    if (Object.keys(streaks).length === 0) patch.infraBackoffUntil = '';
    return { patch, decisions, counted: false };
  }
  const previous = streaks[key] || { harness, model, count: 0, runIds: [], cause: '' };
  const runKey = String(input.runKey || '').trim();
  if (runKey && previous.runIds.includes(runKey)) return { patch, decisions, counted: false };
  const count = previous.count + 1;
  const cause = input.classification.cause;
  const policy = row.policy && typeof row.policy === 'object' ? row.policy : {};
  const baseMs = Number(policy.backoffBaseMs) > 0 ? Number(policy.backoffBaseMs) : 60_000;
  const capMs = Number(policy.backoffCapMs) > 0 ? Number(policy.backoffCapMs) : 6 * 60 * 60_000;
  // Works from the very first infra failure, before the breaker threshold.
  const until = now + Math.min(capMs, baseMs * (2 ** (count - 1)));
  const existingUntil = Date.parse(String(row.infraBackoffUntil || ''));
  patch.infraBackoffUntil = new Date(Math.max(until, Number.isFinite(existingUntil) ? existingUntil : 0)).toISOString();
  if (count < WORKSPACE_WATCHER_INFRA_STREAK_THRESHOLD) {
    streaks[key] = { harness, model, count, cause, runIds: [...previous.runIds, runKey].filter(Boolean).slice(-20), lastAt: input.at };
    return { patch, decisions, counted: true };
  }
  delete streaks[key];
  const ttlUntil = new Date(now + WORKSPACE_WATCHER_ORCHESTRATOR_COOLDOWN_TTL_MS).toISOString();
  const next = cooldowns.filter((entry) => !(entry.scope === 'model' && entry.harness === harness && entry.model === model));
  next.push({ harness, model, scope: 'model', cause, since: input.at, until: ttlUntil });
  decisions.push({
    at: input.at,
    kind: 'orchestrator_model_cooldown',
    reason: `${harness}/${model} cooled down for ${Math.round(WORKSPACE_WATCHER_ORCHESTRATOR_COOLDOWN_TTL_MS / 60_000)} min after ${count} consecutive infrastructure failures (${cause})`,
    readyTodoCount: 0,
    activeAgentCount: 0,
    shouldNotify: false,
    nextTodoId: '',
  });
  // Wider outage evidence: the same cause on at least two models of the harness.
  const sameCause = next.filter((entry) => entry.scope === 'model' && entry.harness === harness && entry.cause === cause);
  const alreadyHarness = next.some((entry) => entry.scope === 'harness' && entry.harness === harness);
  if (!alreadyHarness && new Set(sameCause.map((entry) => entry.model)).size >= 2) {
    next.push({ harness, model: '', scope: 'harness', cause, since: input.at, until: ttlUntil });
    decisions.push({
      at: input.at,
      kind: 'orchestrator_harness_cooldown',
      reason: `${harness} cooled down: same cause (${cause}) on ${sameCause.length} models`,
      readyTodoCount: 0,
      activeAgentCount: 0,
      shouldNotify: false,
      nextTodoId: '',
    });
  }
  patch.orchestratorCooldowns = next;
  return { patch, decisions, counted: true };
}

/**
 * Next per-todo backoff entry after a cycle reported `blocked`. A blocked cycle
 * is not a failure, so it never reaches the failure ceiling; without its own
 * delay the same leaf is claimed again every cooldown while the blocker (a
 * human decision, a structural gate) is unchanged. The delay doubles with each
 * consecutive blocked close, starting at twice the longer of the cooldown and
 * the backoff base, and is capped by `backoffCapMs`.
 *
 * @param {{ previous?: { count?: unknown } | null, policy?: Record<string, any> | null, now?: number }} [input]
 * @returns {{ count: number, until: string }}
 */
export function nextWorkspaceWatcherBlockedBackoff(input = {}) {
  const policy = input.policy && typeof input.policy === 'object' ? input.policy : {};
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const previous = Math.max(0, Math.floor(Number(input.previous?.count) || 0));
  const count = previous + 1;
  const baseMs = Math.max(
    Number(policy.cooldownMs) > 0 ? Number(policy.cooldownMs) : 0,
    Number(policy.backoffBaseMs) > 0 ? Number(policy.backoffBaseMs) : 60_000,
  );
  const capMs = Number(policy.backoffCapMs) > 0 ? Number(policy.backoffCapMs) : 6 * 60 * 60_000;
  const delay = Math.min(capMs, baseMs * (2 ** Math.min(count, 30)));
  return { count, until: new Date(now + delay).toISOString() };
}

/**
 * Whether a todo is still inside its blocked backoff window.
 *
 * @param {unknown} blockedBackoff watcher row `blockedBackoff` map
 * @param {unknown} todoId
 * @param {number} now
 * @returns {boolean}
 */
export function isWorkspaceWatcherTodoInBlockedBackoff(blockedBackoff, todoId, now) {
  const id = String(todoId ?? '').trim();
  if (!id || !blockedBackoff || typeof blockedBackoff !== 'object') return false;
  const until = Date.parse(String(/** @type {Record<string, { until?: unknown }>} */ (blockedBackoff)[id]?.until ?? ''));
  return Number.isFinite(until) && until > now;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function toFiniteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Reasons a watcher parks itself in `stopReason` after a progress loop, kept as
 * constants so the decision, the tick, the settings UI and the tests never
 * drift into different literals for the same state.
 */
export const WORKSPACE_WATCHER_STOP_LOOP_SAME_FINDINGS = 'loop_same_findings';
export const WORKSPACE_WATCHER_STOP_LOOP_NO_ELIGIBLE = 'loop_no_eligible_work';

/**
 * Pure loop-exhaustion check for the autopilot. It answers what
 * `decideWorkspaceWatcherAction` alone cannot: which ready todos have already
 * reached the failure ceiling (so they must be parked as `blocked` instead of
 * being re-picked forever), and whether the watcher has run out of progressable
 * work so it should stop rather than spin in place.
 *
 * - A ready todo whose accumulated failures reached `maxConsecutiveFailures` is
 *   a `blockTodoId`. `0` disables the ceiling (never block on failures).
 * - `same_findings` mirrors the `delegation-workflow` loop rule: identical
 *   review findings seen `maxSameFindings` cycles in a row means the todo the
 *   cycle just attempted is stuck, so it is parked and the findings memory is
 *   cleared (`clearFindings`) to let a different todo advance. `0` disables it.
 * - When every ready todo is at the ceiling (or is the stuck candidate) and
 *   none is eligible, there is nothing left to advance and the watcher stops.
 *
 * Pure: it reads no store and no clock, and never mutates. The caller applies
 * the block/stop/clear as side effects.
 *
 * @param {{
 *   watcher?: Record<string, any>,
 *   snapshot?: { readyLeaves?: Record<string, any>[] },
 *   candidateTodoId?: string,
 * }} [input]
 * @returns {{
 *   blockTodoIds: string[],
 *   findingsLoop: boolean,
 *   clearFindingsTodoIds: string[],
 *   hasEligibleWork: boolean,
 *   stopReason: string,
 *   ceiling: number,
 *   maxSameFindings: number,
 * }}
 */
export function evaluateWorkspaceWatcherLoop(input = {}) {
  const watcher = input.watcher || {};
  const policy = watcher.policy && typeof watcher.policy === 'object' ? watcher.policy : {};
  const snapshot = input.snapshot || {};
  const leaves = Array.isArray(snapshot.readyLeaves) ? snapshot.readyLeaves : [];
  const candidateTodoId = String(input.candidateTodoId ?? '').trim();
  const failures = watcher.failures && typeof watcher.failures === 'object' ? watcher.failures : {};
  const findings = watcher.findings && typeof watcher.findings === 'object' ? watcher.findings : {};
  const maxSameFindings = Math.max(0, Math.floor(toFiniteNumber(policy.maxSameFindings, 0)));
  const isFindingsStuck = (todoId) => {
    const entry = readWorkspaceWatcherTodoFindings(findings, todoId);
    return maxSameFindings > 0 && entry.hash !== '' && entry.streak >= maxSameFindings;
  };
  const findingsLoop = candidateTodoId ? isFindingsStuck(candidateTodoId) : false;

  // `0` means "never skip on failures" (mirrors `resolveMaxFailures`); any other
  // value is the ceiling at which a repeatedly-failing todo stops crowding out
  // fresh work and is instead parked as blocked.
  const ceilingRaw = toFiniteNumber(policy.maxConsecutiveFailures, 0);
  const ceiling = ceilingRaw > 0 ? Math.floor(ceilingRaw) : Number.POSITIVE_INFINITY;

  const atCeiling = (todoId) => {
    const count = toFiniteNumber(failures[todoId], 0);
    return count > 0 && count >= ceiling;
  };
  const isStuck = (todoId) => isFindingsStuck(todoId) || atCeiling(todoId);

  const blockTodoIds = [];
  let hasEligibleWork = false;
  for (const leaf of leaves) {
    const todoId = String(leaf?.id ?? '').trim();
    if (!todoId) continue;
    if (isStuck(todoId)) {
      if (!blockTodoIds.includes(todoId)) blockTodoIds.push(todoId);
      continue;
    }
    hasEligibleWork = true;
  }
  const blockedTodoIds = Array.isArray(snapshot.blockedTodoIds) ? snapshot.blockedTodoIds : [];
  for (const rawId of blockedTodoIds) {
    const todoId = String(rawId ?? '').trim();
    if (!todoId || !atCeiling(todoId)) continue;
    if (!blockTodoIds.includes(todoId)) blockTodoIds.push(todoId);
  }

  let stopReason = '';
  if (blockTodoIds.length > 0 && !hasEligibleWork) {
    const findingsBlocked = blockTodoIds.some((todoId) => isFindingsStuck(todoId));
    stopReason = findingsBlocked ? WORKSPACE_WATCHER_STOP_LOOP_SAME_FINDINGS : WORKSPACE_WATCHER_STOP_LOOP_NO_ELIGIBLE;
  }

  return {
    blockTodoIds,
    findingsLoop,
    clearFindingsTodoIds: blockTodoIds.filter((todoId) => isFindingsStuck(todoId)),
    hasEligibleWork,
    stopReason,
    ceiling,
    maxSameFindings,
  };
}

/**
 * Plan text the gate should see for a picked leaf.
 * Own `plan.markdown` wins, then the nearest ancestor's. Approval is separate:
 * `approvedAt` on this node or any ancestor (including the top parent) covers
 * the leaf, even when a closer draft is still unapproved. When no saved plan
 * exists, the nearest container `body` is the written spec. A leaf body stays
 * task notes. A queued container (ready, doing, or done) has already been
 * accepted by a person, so that description counts as approved.
 *
 * @param {unknown} items
 * @param {Record<string, any> | null | undefined} pickedTodo
 * @returns {{ markdown: string, approvedAt: string }}
 */
/**
 * Walk up the ancestor chain and return the topmost todo (root of the subtree).
 * @param {Record<string, any>[]} items
 * @param {Record<string, any> | null | undefined} pickedTodo
 * @returns {Record<string, any> | null}
 */
export function findWatcherPlanTarget(items, pickedTodo) {
  const list = Array.isArray(items) ? items : [];
  const index = new Map(list.map((row) => [String(row?.id || ''), row]));
  let current = pickedTodo || null;
  let root = current;
  const seen = new Set();
  while (current && !seen.has(String(current.id || ''))) {
    const id = String(current.id || '');
    if (id) seen.add(id);
    root = current;
    const parentId = String(current.parentId || '').trim();
    current = parentId ? index.get(parentId) || null : null;
  }
  return root;
}

/** Body length (chars) from which a leaf without `## Leaf scope` reads as an initiative. */
export const WATCHER_INITIATIVE_BODY_MIN_CHARS = 1200;

/**
 * True when the leaf looks like an initiative rather than a scoped task: no
 * `## Leaf scope` section and a large description.
 *
 * @param {Record<string, any> | null | undefined} todo
 * @returns {boolean}
 */
export function isWatcherInitiativeLeaf(todo) {
  const body = String(todo?.body ?? '');
  return body.trim().length >= WATCHER_INITIATIVE_BODY_MIN_CHARS && !hasExplicitLeafScopeSection(body);
}

function planChain(items, pickedTodo) {
  const index = new Map((Array.isArray(items) ? items : []).map((row) => [String(row?.id || ''), row]));
  const chain = [];
  const seen = new Set();
  let current = pickedTodo || null;
  while (current && !seen.has(String(current.id || ''))) {
    seen.add(String(current.id || ''));
    chain.push(current);
    const parentId = String(current.parentId || '').trim();
    current = parentId ? index.get(parentId) || null : null;
  }
  return chain;
}

function hasMarkdownPlanInChain(items, pickedTodo) {
  return planChain(items, pickedTodo).some((node) => String(node?.plan?.markdown ?? '').trim());
}

function hasExplicitPlanApprovalInChain(items, pickedTodo) {
  return planChain(items, pickedTodo).some((node) => String(node?.plan?.approvedAt ?? '').trim());
}

const PACKAGE_DEPENDENCY_SECTIONS = new Set(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']);
const PACKAGE_NON_DEPENDENCY_KEYS = /^(name|version|description|main|type|license|private|scripts|engines|author|homepage|repository|bugs|keywords|files|bin|module|types)$/;

/**
 * Review/verify gate helper: dependencies newly added to any package.json
 * (including subdirectories such as desktop/package.json) in a unified diff.
 * The gate itself is enforced through the cycle prompt; nothing calls this
 * helper at runtime yet.
 *
 * Section-aware: entries count only inside dependencies / devDependencies /
 * peerDependencies / optionalDependencies. When the hunk does not show the
 * enclosing block, the entry counts unless its key is an obviously unrelated
 * manifest field. A name removed and re-added in the same file (a version
 * bump) is not new.
 *
 * @param {string} diffText unified diff
 * @returns {Array<{ file: string, name: string }>}
 */
export function findNewPackageJsonDependencies(diffText) {
  const found = [];
  let file = '';
  /** @type {Array<{ name: string }>} */
  let added = [];
  let removed = new Set();
  /** @type {string[]} enclosing JSON object keys; empty = not visible in this hunk */
  let stack = [];
  const flush = () => {
    for (const row of added) if (!removed.has(row.name)) found.push({ file, name: row.name });
    added = [];
    removed = new Set();
  };
  for (const line of String(diffText || '').split(/\r?\n/)) {
    const header = /^\+\+\+ b\/(.+)$/.exec(line);
    if (header) { flush(); file = header[1]; stack = []; continue; }
    if (!/(^|\/)package\.json$/.test(file)) continue;
    if (line.startsWith('@@')) { stack = []; continue; }
    const marker = line[0];
    if (marker !== '+' && marker !== '-' && marker !== ' ') continue;
    if (line.startsWith('---')) continue;
    const content = line.slice(1);
    const open = /^\s*"([^"]+)"\s*:\s*\{\s*$/.exec(content);
    if (open) { stack.push(open[1]); continue; }
    if (/^\s*\}\s*,?\s*$/.test(content)) { stack.pop(); continue; }
    const dep = /^\s*"((?:@[^"/]+\/)?[^"]+)"\s*:\s*"[^"]*"\s*,?\s*$/.exec(content);
    if (!dep) continue;
    if (marker === '-') { removed.add(dep[1]); continue; }
    if (marker !== '+') continue;
    const section = stack[stack.length - 1];
    const inDependencies = section ? PACKAGE_DEPENDENCY_SECTIONS.has(section) : !PACKAGE_NON_DEPENDENCY_KEYS.test(dep[1]);
    if (inDependencies) added.push({ name: dep[1] });
  }
  flush();
  return found;
}

export function resolveWatcherGatePlan(items, pickedTodo) {
  const list = Array.isArray(items) ? items : [];
  const index = new Map(list.map((row) => [String(row?.id || ''), row]));
  /** @type {Record<string, any>[]} */
  const chain = [];
  const seen = new Set();
  let current = pickedTodo || null;
  while (current && !seen.has(String(current.id || ''))) {
    const id = String(current.id || '');
    if (id) seen.add(id);
    chain.push(current);
    const parentId = String(current.parentId || '').trim();
    current = parentId ? index.get(parentId) || null : null;
  }
  let markdown = '';
  let approvedAt = '';
  for (const node of chain) {
    if (!markdown) markdown = String(node?.plan?.markdown ?? '').trim();
    if (!approvedAt) approvedAt = String(node?.plan?.approvedAt ?? '').trim();
    if (markdown && approvedAt) break;
  }
  if (markdown) return { markdown, approvedAt };
  const parentIds = new Set(list.map((row) => String(row?.parentId || '').trim()).filter(Boolean));
  for (const node of chain) {
    if (!parentIds.has(String(node?.id || ''))) continue;
    const markdown = String(node?.body ?? '').trim();
    if (!markdown) continue;
    const status = String(node.status || '');
    const accepted = status === 'ready' || status === 'doing' || status === 'done';
    return { markdown, approvedAt: accepted ? String(node.updatedAt || '').trim() || status : '' };
  }
  return { markdown: '', approvedAt: '' };
}

/**
 * Suffix of the `planRequests` key that records the plan version a Watcher
 * plan-review round was started for (`<planHolderId>#plan-review`). The value is
 * the plan revision key, so one plan version gets exactly one automatic round.
 */
export const WORKSPACE_WATCHER_PLAN_REREVIEW_SUFFIX = '#plan-review';

/**
 * Whether a closed plan gate should get an automatic plan-review round: the
 * plan is saved but unapproved, its latest plan review went `stale` because the
 * plan was edited after it (`plan_edited_after_review`), and no round was
 * started yet for this plan version. Pure: the review state is read through the
 * injected `resolvePlanReview(holderTodo)` so tests feed it as plain data. This
 * only ever asks for a REVIEW round; plan approval stays human-only.
 *
 * @param {{
 *   watcher?: Record<string, any>,
 *   items?: Record<string, any>[],
 *   pickedTodo?: Record<string, any> | null,
 *   resolvePlanReview?: ((todo: Record<string, any>) => { state?: string, stateReason?: string } | null) | null,
 * }} [input]
 * @returns {{ due: boolean, reason: string, holderId: string, planKey: string, markerKey: string }}
 */
export function evaluateWorkspaceWatcherPlanRereview(input = {}) {
  const none = (reason, holderId = '', planKey = '') => ({
    due: false, reason, holderId, planKey, markerKey: holderId ? `${holderId}${WORKSPACE_WATCHER_PLAN_REREVIEW_SUFFIX}` : '',
  });
  const policy = input.watcher?.policy && typeof input.watcher.policy === 'object' ? input.watcher.policy : {};
  if (typeof input.resolvePlanReview !== 'function') return none('no_resolver');
  if (!input.pickedTodo) return none('no_todo');
  // A disabled review phase means the Watcher may not start review rounds.
  if (policy.phases && typeof policy.phases === 'object' && policy.phases.review === false) return none('review_phase_disabled');
  const items = Array.isArray(input.items) ? input.items : [];
  const index = new Map(items.map((row) => [String(row?.id || ''), row]));
  // The review belongs to the nearest node that carries the saved plan text.
  /** @type {Record<string, any> | null} */
  let holder = null;
  const seen = new Set();
  let current = input.pickedTodo;
  while (current && !seen.has(String(current.id || ''))) {
    seen.add(String(current.id || ''));
    if (String(current.plan?.markdown ?? '').trim()) { holder = current; break; }
    const parentId = String(current.parentId || '').trim();
    current = parentId ? index.get(parentId) || null : null;
  }
  const holderId = String(holder?.id ?? '').trim();
  if (!holder || !holderId) return none('no_saved_plan');
  const planKey = computeTodoPlanRevisionKey(holder);
  if (String(holder.plan?.approvedAt ?? '').trim()) return none('plan_approved', holderId, planKey);
  const review = input.resolvePlanReview(holder);
  if (!review || review.state !== 'stale' || review.stateReason !== 'plan_edited_after_review') {
    return none('review_not_stale', holderId, planKey);
  }
  const requests = input.watcher?.planRequests && typeof input.watcher.planRequests === 'object'
    ? input.watcher.planRequests
    : {};
  const markerKey = `${holderId}${WORKSPACE_WATCHER_PLAN_REREVIEW_SUFFIX}`;
  if (String(requests[markerKey] ?? '').trim() === planKey) return none('already_requested', holderId, planKey);
  return { due: true, reason: 'plan_rereview', holderId, planKey, markerKey };
}

/**
 * The guardrail answer. `allowed: true` with `planOnly: true` means "start a
 * cycle, but planning only": the operator still has to approve the plan.
 *
 * @param {{
 *   watcher?: Record<string, any>,
 *   pickedTodo?: Record<string, any> | null,
 *   items?: Record<string, any>[],
 *   now?: number,
 *   activeUsageLimits?: Array<{ harness?: string, model?: string, resetAt?: string }>,
 *   planReviewResolver?: ((todo: Record<string, any>) => { state?: string, stateReason?: string } | null) | null,
 * }} [input]
 * @returns {{
 *   allowed: boolean,
 *   kind: string,
 *   reason: string,
 *   planOnly: boolean,
 *   planRereview?: { holderId: string, planKey: string, markerKey: string },
 *   planTargetId?: string,
 *   allowedHarnesses: string[],
 *   blockedHarnesses: string[],
 *   usedToday: number,
 *   maxCyclesPerDay: number,
 * }}
 */
export function evaluateWorkspaceWatcherGuardrails(input = {}) {
  const watcher = input.watcher || {};
  const policy = watcher.policy && typeof watcher.policy === 'object' ? watcher.policy : {};
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const allowedHarnesses = Array.isArray(policy.allowedHarnesses)
    ? policy.allowedHarnesses.map((h) => String(h ?? '').trim()).filter(Boolean)
    : [];
  const limits = Array.isArray(input.activeUsageLimits) ? input.activeUsageLimits : [];
  const blockedHarnesses = [...new Set(limits
    .map((row) => String(row?.harness ?? '').trim())
    .filter(Boolean))];
  const base = {
    planOnly: false,
    allowedHarnesses,
    blockedHarnesses,
    usedToday: 0,
    maxCyclesPerDay: Math.max(0, toFiniteNumber(policy.maxCyclesPerDay, 0)),
  };

  // A paused watcher answers "not allowed, paused" so the settings view is
  // honest about why nothing runs even while quiet hours / budget are fine.
  // `decideWorkspaceWatcherAction` returns `paused` before it ever asks the
  // guardrails, so this only shapes the displayed verdict.
  if (watcher.paused === true) {
    return { ...base, allowed: false, kind: 'paused', reason: 'paused' };
  }

  if (isWorkspaceWatcherQuietHours(policy.quietHours, now)) {
    return { ...base, allowed: false, kind: 'wait_quiet_hours', reason: 'quiet_hours' };
  }

  const day = workspaceWatcherUtcDayKey(now);
  const cycles = watcher.cycles && typeof watcher.cycles === 'object' ? watcher.cycles : {};
  const usedToday = String(cycles.day ?? '').trim() === day
    ? Math.max(0, Math.floor(toFiniteNumber(cycles.count, 0)))
    : 0;
  const maxCyclesPerDay = base.maxCyclesPerDay;
  if (maxCyclesPerDay > 0 && usedToday >= maxCyclesPerDay) {
    return { ...base, usedToday, allowed: false, kind: 'wait_budget', reason: 'daily_budget' };
  }

  const cooldownMs = Math.max(0, toFiniteNumber(policy.cooldownMs, 0));
  const lastCycleAt = Date.parse(String(watcher.lastCycleAt ?? '').trim());
  if (cooldownMs > 0 && Number.isFinite(lastCycleAt) && now - lastCycleAt < cooldownMs) {
    return { ...base, usedToday, allowed: false, kind: 'wait_cooldown', reason: 'cooldown' };
  }

  const backoffUntil = Math.max(
    Date.parse(String(watcher.backoffUntil ?? '').trim()) || 0,
    Date.parse(String(watcher.infraBackoffUntil ?? '').trim()) || 0,
  );
  if (backoffUntil > 0 && now < backoffUntil) {
    return { ...base, usedToday, allowed: false, kind: 'backoff', reason: 'failure_backoff' };
  }

  const maxSameFindings = Math.max(0, toFiniteNumber(policy.maxSameFindings, 0));
  const findings = watcher.findings && typeof watcher.findings === 'object' ? watcher.findings : {};
  const pickedTodo = input.pickedTodo || null;
  const pickedTodoId = String(pickedTodo?.id ?? '').trim();
  const pickedFindings = readWorkspaceWatcherTodoFindings(findings, pickedTodoId);
  if (maxSameFindings > 0 && pickedTodoId && pickedFindings.hash && pickedFindings.streak >= maxSameFindings) {
    return { ...base, usedToday, allowed: false, kind: 'wait_same_findings', reason: 'same_findings' };
  }

  if (!hasWorkspaceWatcherAvailableHarness(watcher, limits, now)) {
    return { ...base, usedToday, allowed: false, kind: 'wait_harness_usage', reason: 'harness_usage_limited' };
  }

  // The plan gate never blocks forever and never auto-approves a draft that
  // lives only in `plan.markdown`. The first time an unapproved plan is picked
  // we allow a planning-only cycle; once that request is durable, further ticks
  // wait for the human. A container description is the plan when nobody saved
  // `plan.markdown`: queuing that container (ready / doing / done) is the human
  // accepting it, so the leaf can be implemented.
  //
  // With planApprovalScope: 'root' the plan is generated and approved once at
  // the subtree root; all leaves under it are unblocked by that single approval.
  if (policy.requirePlanApproval !== false && pickedTodo) {
    const planTarget = policy.planApprovalScope === 'root'
      ? (findWatcherPlanTarget(input.items, pickedTodo) || pickedTodo)
      : pickedTodo;
    const plan = resolveWatcherGatePlan(input.items, pickedTodo);
    const hasMarkdown = plan.markdown.length > 0;
    // A container body only counts as implicit approval for ordinary leaves; an
    // initiative-shaped leaf with no saved plan still gets a plan draft first.
    const approvedAt = plan.approvedAt && !(
      !hasMarkdownPlanInChain(input.items, pickedTodo) && isWatcherInitiativeLeaf(pickedTodo)
        && !hasExplicitPlanApprovalInChain(input.items, pickedTodo)
    ) ? plan.approvedAt : '';
    if (!approvedAt) {
      const todoId = String(pickedTodo.id ?? '').trim();
      const planTargetId = String(planTarget?.id ?? '').trim() || todoId;
      const planRequests = watcher.planRequests && typeof watcher.planRequests === 'object'
        ? watcher.planRequests
        : {};
      if (planTargetId && String(planRequests[planTargetId] ?? '').trim()) {
        // The draft is waiting for a human, but its plan review went stale after
        // an edit: start ONE review round for this plan version (never approve).
        const rereview = evaluateWorkspaceWatcherPlanRereview({
          watcher, items: input.items, pickedTodo, resolvePlanReview: input.planReviewResolver,
        });
        if (rereview.due) {
          return {
            ...base,
            usedToday,
            allowed: true,
            planOnly: true,
            planTargetId: planTargetId !== todoId ? planTargetId : undefined,
            planRereview: { holderId: rereview.holderId, planKey: rereview.planKey, markerKey: rereview.markerKey },
            kind: 'plan_gate',
            reason: 'plan_rereview',
          };
        }
        return { ...base, usedToday, allowed: false, kind: 'wait_plan_approval', reason: 'awaiting_plan_approval' };
      }
      return {
        ...base,
        usedToday,
        allowed: true,
        planOnly: true,
        // When scope is 'root', the cycle should plan for the root, not the leaf.
        planTargetId: planTargetId !== todoId ? planTargetId : undefined,
        // An unplanned todo is always planned, approved or not.
        kind: 'plan_gate',
        reason: hasMarkdown ? 'plan_not_approved' : 'plan_missing',
      };
    }
  }

  return { ...base, usedToday, allowed: true, kind: 'allowed', reason: 'ready' };
}

/**
 * Epoch ms when the currently-active quiet window ends, or `null` when quiet
 * hours are not configured or not active right now. Mirrors the client-side
 * `quietHoursStatus` helper so the panel countdown cannot drift from the gate.
 *
 * @param {unknown} quietHours
 * @param {number} [now]
 * @returns {number | null}
 */
export function nextWorkspaceWatcherQuietHoursEndMs(quietHours, now = Date.now()) {
  if (!isWorkspaceWatcherQuietHours(quietHours, now)) return null;
  const window = parseWorkspaceWatcherQuietHours(quietHours);
  if (!window) return null;
  const date = new Date(now);
  let endsAt = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, window.end);
  if (endsAt <= now) endsAt += 86_400_000;
  return endsAt;
}

/**
 * Epoch ms of the next UTC midnight strictly after `now`. The daily cycle budget
 * resets there, so a spent budget pushes the next possible cycle to this instant.
 *
 * @param {number} now
 * @returns {number}
 */
function nextUtcMidnightMs(now) {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

/**
 * Operator-facing cycle schedule for Settings: when the watcher last ran, when
 * the next autopilot cycle may start, and what (if anything) is holding it back.
 * Pure and clock-injected, mirroring `computeScoutSchedule`, so the "next cycle"
 * the panel shows and the gate the heartbeat applies cannot drift.
 *
 * `nextCycleAt` is the next wall-clock instant the schedule allows (`0` when
 * autopilot is off, paused or stopped). Cooldown, backoff, quiet hours and a
 * spent daily budget each push it forward; a live blocker such as a reached
 * parallel cap is reported in `blockedReason` without inventing an ETA.
 *
 * @param {{
 *   watcher?: Record<string, any>,
 *   now?: number,
 *   activeCycleCount?: number,
 *   worktreeRunning?: number,
 *   projectRunning?: number,
 *   decision?: { reason?: string, pool?: string },
 *   activeUsageLimits?: Array<{ harness?: string, model?: string, resetAt?: string }>,
 * }} [input]
 * @returns {{
 *   enabled: boolean,
 *   mode: string,
 *   paused: boolean,
 *   stopped: boolean,
 *   due: boolean,
 *   nextCycleAt: number,
 *   lastCycleAt: string,
 *   lastTickAt: string,
 *   cooldownEndsAt: number,
 *   backoffUntilMs: number,
 *   quietEndsAt: number,
 *   budgetResetsAt: number,
 *   cyclesToday: number,
 *   maxCyclesPerDay: number,
 *   remainingToday: number | null,
 *   running: number,
 *   maxParallel: number,
 *   worktreeRunning: number,
 *   projectRunning: number,
 *   maxParallelWorktree: number,
 *   maxParallelProject: number,
 *   allowed: boolean,
 *   blockedKind: string,
 *   blockedReason: string,
 * }}
 */
export function computeWatcherSchedule(input = {}) {
  const watcher = input.watcher && typeof input.watcher === 'object' ? input.watcher : {};
  const policy = watcher.policy && typeof watcher.policy === 'object' ? watcher.policy : {};
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const mode = String(watcher.mode || 'off').trim().toLowerCase() || 'off';
  const enabled = mode === 'autopilot';
  const paused = watcher.paused === true;
  const stopReason = String(watcher.stopReason || '').trim();
  const stopped = stopReason.length > 0;

  const maxCyclesPerDay = Math.max(0, Math.floor(toFiniteNumber(policy.maxCyclesPerDay, 0)));
  const cooldownMs = Math.max(0, toFiniteNumber(policy.cooldownMs, 0));
  const maxParallel = Math.max(1, Math.floor(toFiniteNumber(policy.maxParallel, 1)));
  const running = Math.max(0, Math.floor(toFiniteNumber(input.activeCycleCount, 0)));
  const worktreeRunning = Math.max(0, Math.floor(toFiniteNumber(input.worktreeRunning, 0)));
  const projectRunning = Math.max(0, Math.floor(toFiniteNumber(input.projectRunning, 0)));
  const valveCap = evaluateWorkspaceWatcherSafetyValve({ count: running, maxParallel });
  const maxParallelWorktree = workspaceWatcherPoolLimit('worktree', policy);
  const maxParallelProject = workspaceWatcherPoolLimit('project', policy);
  // The candidate decision already tries the other pool before waiting.
  // Occupancy alone must not claim a block while that fallback can run.
  const poolReason = input.decision?.reason === 'cycle_active'
    ? (input.decision.pool === 'worktree' ? 'worktree_parallel'
      : input.decision.pool === 'project' ? 'project_parallel' : '')
    : String(input.decision?.reason || '');

  const day = workspaceWatcherUtcDayKey(now);
  const cycles = watcher.cycles && typeof watcher.cycles === 'object' ? watcher.cycles : {};
  const cyclesToday = String(cycles.day ?? '').trim() === day
    ? Math.max(0, Math.floor(toFiniteNumber(cycles.count, 0)))
    : 0;
  const remainingToday = maxCyclesPerDay > 0 ? Math.max(0, maxCyclesPerDay - cyclesToday) : null;

  const lastCycleAt = String(watcher.lastCycleAt ?? '').trim();
  const lastCycleAtMs = Date.parse(lastCycleAt);
  const cooldownEndsAt = cooldownMs > 0 && Number.isFinite(lastCycleAtMs) ? lastCycleAtMs + cooldownMs : 0;
  const backoffUntilMs = Math.max(
    Date.parse(String(watcher.backoffUntil ?? '').trim()) || 0,
    Date.parse(String(watcher.infraBackoffUntil ?? '').trim()) || 0,
  );
  const quietEndsAt = nextWorkspaceWatcherQuietHoursEndMs(policy.quietHours, now) || 0;
  const budgetResetsAt = nextUtcMidnightMs(now);

  // Which reason wins when several gates are closed: mirror the order the
  // heartbeat's `decideWorkspaceWatcherAction` / guardrails use, so the panel
  // never names a weaker blocker than the one that actually stops the cycle.
  let blockedKind = '';
  let blockedReason = '';
  if (!enabled) {
    blockedKind = 'mode_not_active';
    blockedReason = 'mode_not_active';
  } else if (paused) {
    blockedKind = 'paused';
    blockedReason = 'paused';
  } else if (stopped) {
    blockedKind = 'stopped';
    blockedReason = 'stop_reason';
  } else if (valveCap.reached) {
    blockedKind = 'wait_parallel';
    blockedReason = valveCap.reason;
  } else if (poolReason === 'worktree_parallel' || poolReason === 'project_parallel') {
    blockedKind = `wait_${poolReason}`;
    blockedReason = poolReason;
  } else if (quietEndsAt > now) {
    blockedKind = 'wait_quiet_hours';
    blockedReason = 'quiet_hours';
  } else if (maxCyclesPerDay > 0 && cyclesToday >= maxCyclesPerDay) {
    blockedKind = 'wait_budget';
    blockedReason = 'daily_budget';
  } else if (cooldownEndsAt > now) {
    blockedKind = 'wait_cooldown';
    blockedReason = 'cooldown';
  } else if (backoffUntilMs > now) {
    blockedKind = 'backoff';
    blockedReason = 'failure_backoff';
  } else if (!hasWorkspaceWatcherAvailableHarness(watcher, input.activeUsageLimits, now)) {
    blockedKind = 'wait_harness_usage';
    blockedReason = 'harness_usage_limited';
  }
  const allowed = blockedKind === '';

  // Only a running autopilot has a schedule. A global pause or a stop reason is
  // a deliberate halt with no ETA, so it reports no next cycle.
  let nextCycleAt = 0;
  if (enabled && !paused && !stopped) {
    nextCycleAt = now;
    nextCycleAt = Math.max(nextCycleAt, quietEndsAt);
    if (maxCyclesPerDay > 0 && cyclesToday >= maxCyclesPerDay) {
      nextCycleAt = Math.max(nextCycleAt, budgetResetsAt);
    }
    nextCycleAt = Math.max(nextCycleAt, cooldownEndsAt);
    nextCycleAt = Math.max(nextCycleAt, backoffUntilMs);
    // Every allowed harness limited: the cycle cannot start before the first
    // one resets, so the ETA is that reset rather than a past-due instant.
    nextCycleAt = Math.max(nextCycleAt, earliestWorkspaceWatcherHarnessResetMs(watcher, input.activeUsageLimits, now));
  }

  return {
    enabled,
    mode,
    paused,
    stopped,
    due: enabled && nextCycleAt > 0 && nextCycleAt <= now && allowed,
    nextCycleAt,
    lastCycleAt,
    lastTickAt: String(watcher.lastTickAt ?? '').trim(),
    cooldownEndsAt,
    backoffUntilMs,
    quietEndsAt,
    budgetResetsAt,
    cyclesToday,
    maxCyclesPerDay,
    remainingToday,
    running,
    maxParallel,
    worktreeRunning,
    projectRunning,
    maxParallelWorktree,
    maxParallelProject,
    allowed,
    blockedKind,
    blockedReason,
  };
}

/** Decision kind / reason code recorded in "Why?" for a dead container. */
export const WORKSPACE_WATCHER_DEAD_CONTAINER = 'dead_container';

/**
 * Find "dead containers": `doing` todos with at least one not-done child where
 * every not-done child is still an `idea`, so nothing under them can ever run.
 * Done children are ignored; any other not-done status (ready, doing,
 * deferred, ...) means the container is not dead.
 *
 * @param {Record<string, any>[]} items flat todo list
 * @returns {Array<{ id: string, title: string, idleChildren: Array<{ id: string, title: string }> }>}
 */
export function findWorkspaceWatcherDeadContainers(items) {
  const list = Array.isArray(items) ? items : [];
  /** @type {Map<string, Record<string, any>[]>} */
  const byParent = new Map();
  for (const row of list) {
    const parentId = String(row?.parentId || '').trim();
    if (!parentId) continue;
    if (!byParent.has(parentId)) byParent.set(parentId, []);
    byParent.get(parentId).push(row);
  }
  const order = (row) => (Number.isInteger(row?.siblingIndex) ? row.siblingIndex : Number.MAX_SAFE_INTEGER);
  const out = [];
  for (const row of list) {
    if (String(row?.status || '') !== 'doing') continue;
    const id = String(row?.id || '');
    const open = (byParent.get(id) || []).filter((child) => String(child?.status || '') !== 'done');
    if (!open.length || !open.every((child) => String(child?.status || '') === 'idea')) continue;
    open.sort((a, b) => order(a) - order(b));
    out.push({
      id,
      title: String(row?.title || ''),
      idleChildren: open.map((child) => ({ id: String(child.id || ''), title: String(child.title || '') })),
    });
  }
  return out;
}

/**
 * Stable once-per-episode signature: container ids plus their idle child sets.
 * Empty when nothing is dead (which re-arms the notification).
 *
 * @param {Array<{ id: string, idleChildren: Array<{ id: string }> }>} dead
 * @returns {string}
 */
export function deadContainerSignature(dead) {
  if (!Array.isArray(dead) || !dead.length) return '';
  const text = dead
    .map((c) => `${c.id}:${c.idleChildren.map((k) => k.id).sort().join(',')}`)
    .sort()
    .join('|');
  return createHash('sha1').update(text).digest('hex');
}

/**
 * Whether the container or one of its ancestors has an approved plan.
 *
 * @param {Record<string, any>[]} items
 * @param {string} containerId
 * @returns {boolean}
 */
export function hasApprovedPlanInChain(items, containerId) {
  const list = Array.isArray(items) ? items : [];
  const index = new Map(list.map((row) => [String(row?.id || ''), row]));
  const seen = new Set();
  let current = index.get(String(containerId || '')) || null;
  while (current && !seen.has(String(current.id || ''))) {
    seen.add(String(current.id || ''));
    if (String(current?.plan?.approvedAt ?? '').trim()) return true;
    current = index.get(String(current.parentId || '').trim()) || null;
  }
  return false;
}

/**
 * The first idea child to move to `ready` when
 * `policy.autoReadyDeadContainerChild` is on and a plan is approved in the chain.
 *
 * @param {Record<string, any>[]} items
 * @param {{ autoReadyDeadContainerChild?: boolean } | null | undefined} policy
 * @returns {Array<{ containerId: string, childId: string }>}
 */
export function planDeadContainerAutoReady(items, policy) {
  if (policy?.autoReadyDeadContainerChild !== true) return [];
  return findWorkspaceWatcherDeadContainers(items)
    .filter((c) => hasApprovedPlanInChain(items, c.id))
    .map((c) => ({ containerId: c.id, childId: c.idleChildren[0].id }));
}
