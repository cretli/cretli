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
 * @param {object[]} activeUsageLimits
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
 * @param {object} watcher
 * @param {object[]} activeUsageLimits
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
 *   watcher?: object,
 *   snapshot?: { readyLeaves?: object[] },
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
 * @param {object | null | undefined} pickedTodo
 * @returns {{ markdown: string, approvedAt: string }}
 */
/**
 * Walk up the ancestor chain and return the topmost todo (root of the subtree).
 * @param {object[]} items
 * @param {object | null | undefined} pickedTodo
 * @returns {object | null}
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

export function resolveWatcherGatePlan(items, pickedTodo) {
  const list = Array.isArray(items) ? items : [];
  const index = new Map(list.map((row) => [String(row?.id || ''), row]));
  /** @type {object[]} */
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
 * The guardrail answer. `allowed: true` with `planOnly: true` means "start a
 * cycle, but planning only": the operator still has to approve the plan.
 *
 * @param {{
 *   watcher?: object,
 *   pickedTodo?: object | null,
 *   items?: object[],
 *   now?: number,
 *   activeUsageLimits?: Array<{ harness?: string, model?: string, resetAt?: string }>,
 * }} [input]
 * @returns {{
 *   allowed: boolean,
 *   kind: string,
 *   reason: string,
 *   planOnly: boolean,
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

  const backoffUntil = Date.parse(String(watcher.backoffUntil ?? '').trim());
  if (Number.isFinite(backoffUntil) && now < backoffUntil) {
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
    const approvedAt = plan.approvedAt;
    if (!approvedAt) {
      const todoId = String(pickedTodo.id ?? '').trim();
      const planTargetId = String(planTarget?.id ?? '').trim() || todoId;
      const planRequests = watcher.planRequests && typeof watcher.planRequests === 'object'
        ? watcher.planRequests
        : {};
      if (planTargetId && String(planRequests[planTargetId] ?? '').trim()) {
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
