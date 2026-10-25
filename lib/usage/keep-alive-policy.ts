/**
 * Pure policy for the optional, paid prompt-cache keep-alive.
 *
 * A keep-alive ping is a REAL provider request in a resumed reviewer session:
 * it costs money (a warm ping still reads the whole cached prefix) and it only
 * pays off when the next round really happens inside the cache TTL. This module
 * therefore decides, without any I/O:
 *
 * - whether manual / automatic keep-alive is AVAILABLE for a session and, when
 *   it is not, a stable reason (resume, TTL policy, cost control, benchmark gate);
 * - whether one concrete ping is due, deferred or must STOP the plan.
 *
 * Nothing here issues a request, reads a clock or mutates state, so the
 * scheduler and the tests share the exact same decisions.
 */

/** Keep-alive modes. `off` is the default: a plan never exists unless asked. */
export const KEEP_ALIVE_MODE = Object.freeze({
  OFF: 'off',
  MANUAL: 'manual',
  AUTO: 'auto',
});

/** Why a plan permanently stopped (terminal; a new plan needs a new decision). */
export const KEEP_ALIVE_STOP_REASON = Object.freeze({
  USER_STOPPED: 'user_stopped',
  CANCELLED: 'cancelled',
  WORKFLOW_ENDED: 'workflow_ended',
  SESSION_RESET: 'session_reset',
  CHAT_MISSING: 'chat_missing',
  BUDGET_EXHAUSTED: 'budget_exhausted',
  COST_UNKNOWN: 'cost_unknown',
  PING_LIMIT: 'ping_limit',
  DEADLINE: 'deadline',
  PROVIDER_LIMIT: 'provider_limit',
  INEFFECTIVE: 'ineffective',
  ERROR: 'error',
  NOT_NEEDED: 'not_needed',
  CACHE_EXPIRED: 'cache_expired',
  NOT_ECONOMIC: 'not_economic',
  SERVER_RESTART: 'server_restart',
  UNAVAILABLE: 'unavailable',
});

/** Why a due ping was postponed (non-terminal; re-evaluated on the next tick). */
export const KEEP_ALIVE_DEFER_REASON = Object.freeze({
  BUSY: 'busy',
  USER_COMMAND: 'user_command',
  MIN_INTERVAL: 'min_interval',
  NOT_DUE: 'not_due',
  PING_IN_FLIGHT: 'ping_in_flight',
});

/** Why a mode is unavailable for a session. */
export const KEEP_ALIVE_UNAVAILABLE_REASON = Object.freeze({
  NO_RESUME: 'resume_unsupported',
  NO_SESSION: 'session_missing',
  TTL_UNKNOWN: 'ttl_unknown',
  COST_UNKNOWN: 'cost_unknown',
  NO_BUDGET: 'budget_required',
  NO_NEXT_ROUND: 'next_round_required',
  GATE_MISSING: 'benchmark_missing',
  GATE_NO_GO: 'benchmark_no_go',
});

const MINUTE_MS = 60 * 1000;

/** Defaults and hard caps. Callers can tighten the caps, never exceed them. */
export const KEEP_ALIVE_LIMITS = Object.freeze({
  defaultMaxPings: 3,
  hardMaxPings: 10,
  defaultMinIntervalMs: MINUTE_MS,
  hardMinIntervalMs: 30 * 1000,
  defaultMaxDurationMs: 30 * MINUTE_MS,
  hardMaxDurationMs: 2 * 60 * MINUTE_MS,
  hardBudgetUsd: 5,
  /** A ping is sent this long before the estimated expiry. */
  leadMs: MINUTE_MS,
  /** A user/other turn this recent on the chat postpones the ping. */
  userQuietMs: 2 * MINUTE_MS,
  /** Consecutive pings without a proven cache read before the plan stops. */
  maxIneffectivePings: 2,
  /** Output cap assumed for the economics estimate of a ping (tokens). */
  pingOutputTokens: 64,
});

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return String(value ?? '').trim();
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function finite(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Clamps a requested plan configuration into the hard limits. Unknown or
 * invalid values fall back to the conservative defaults; a missing or invalid
 * budget defaults to the hard cap, so every plan carries a positive budget and
 * the cost-unknown / budget-exhausted stops always apply.
 *
 * @param {Record<string, any>} [input]
 * @param {number} now
 * @returns {{
 *   maxPings: number,
 *   minIntervalMs: number,
 *   deadlineAt: number,
 *   budgetUsd: number,
 *   expectNextRoundUntil: number|null,
 * }}
 */
export function normalizeKeepAliveLimits(input: Record<string, any> = {}, now = Date.now()) {
  const L = KEEP_ALIVE_LIMITS;
  const pings = finite(input.maxPings ?? input.max_pings);
  const interval = finite(input.minIntervalMs ?? input.min_interval_ms);
  const duration = finite(input.maxDurationMs ?? input.max_duration_ms);
  const budget = finite(input.budgetUsd ?? input.budget_usd);
  const nextRound = input.expectNextRoundUntil ?? input.expect_next_round_until;
  const nextRoundMs = nextRound == null || nextRound === ''
    ? null
    : (finite(nextRound) ?? Date.parse(text(nextRound)));
  const clamp = (value, min, max, fallback) => {
    if (value == null || !Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, value));
  };
  return {
    maxPings: Math.floor(clamp(pings, 1, L.hardMaxPings, L.defaultMaxPings)),
    minIntervalMs: Math.floor(clamp(interval, L.hardMinIntervalMs, L.hardMaxDurationMs, L.defaultMinIntervalMs)),
    deadlineAt: now + Math.floor(clamp(duration, MINUTE_MS, L.hardMaxDurationMs, L.defaultMaxDurationMs)),
    budgetUsd: budget != null && budget > 0 ? Math.min(budget, L.hardBudgetUsd) : L.hardBudgetUsd,
    expectNextRoundUntil: Number.isFinite(nextRoundMs) ? nextRoundMs : null,
  };
}

/**
 * Availability of the manual and automatic modes for one resumed session.
 *
 * Manual only needs a resumable session: the user decides and sees the cost.
 * Auto additionally needs a reliable TTL policy, a priced model with a budget
 * (cost control), a declared next round and a passing benchmark gate. When any
 * is missing, auto is unavailable WITH the reason; it is never silently weaker.
 *
 * @param {{
 *   canResumeSession?: boolean,
 *   hasSessionId?: boolean,
 *   ttlKnown?: boolean,
 *   tariffKnown?: boolean,
 *   budgetUsd?: number|null,
 *   expectNextRoundUntil?: number|null,
 *   gate?: { decision?: string } | null,
 * }} input
 * @returns {{
 *   manual: { available: boolean, reason: string },
 *   auto: { available: boolean, reason: string },
 * }}
 */
export function evaluateKeepAliveAvailability(input: Partial<{ canResumeSession?: boolean, hasSessionId?: boolean, ttlKnown?: boolean, tariffKnown?: boolean, budgetUsd?: number|null, expectNextRoundUntil?: number|null, gate?: { decision?: string } | null }> = {}) {
  const R = KEEP_ALIVE_UNAVAILABLE_REASON;
  let manualReason = '';
  if (input.canResumeSession !== true) manualReason = R.NO_RESUME;
  else if (input.hasSessionId !== true) manualReason = R.NO_SESSION;
  const manual = { available: manualReason === '', reason: manualReason };
  let autoReason = manualReason;
  if (!autoReason && input.ttlKnown !== true) autoReason = R.TTL_UNKNOWN;
  if (!autoReason && input.tariffKnown !== true) autoReason = R.COST_UNKNOWN;
  if (!autoReason && !(Number(input.budgetUsd) > 0)) autoReason = R.NO_BUDGET;
  if (!autoReason && !(Number(input.expectNextRoundUntil) > 0)) autoReason = R.NO_NEXT_ROUND;
  if (!autoReason) {
    const decision = text(input.gate?.decision).toLowerCase();
    if (!decision) autoReason = R.GATE_MISSING;
    else if (decision !== 'go') autoReason = R.GATE_NO_GO;
  }
  return { manual, auto: { available: autoReason === '', reason: autoReason } };
}

/**
 * Cost of one ping versus what keeping the cache warm saves, in USD.
 *
 * A warm ping still reads the whole prefix at the cache-read rate and emits a
 * few tokens. Without a ping the next turn re-writes the prefix at the
 * cache-write rate (or the input rate when no dedicated write rate exists).
 * Unknown rates or context size give `null`, never a guess.
 *
 * @param {{
 *   contextTokens?: number|null,
 *   rates?: { cachedInput?: number, cacheWrite?: number, textInput?: number, textOutput?: number } | null,
 *   outputTokens?: number,
 * }} input
 * @returns {{ known: boolean, pingCostUsd: number|null, savingUsd: number|null, netUsd: number|null }}
 */
export function estimateKeepAliveEconomics(input: Partial<{ contextTokens?: number|null, rates?: { cachedInput?: number, cacheWrite?: number, textInput?: number, textOutput?: number } | null, outputTokens?: number }> = {}) {
  const tokens = finite(input.contextTokens);
  const rates = input.rates && typeof input.rates === 'object' ? input.rates : null;
  const read = finite(rates?.cachedInput);
  const write = finite(rates?.cacheWrite) ?? finite(rates?.textInput);
  const out = finite(rates?.textOutput);
  if (!(tokens > 0) || read == null || write == null || out == null) {
    return { known: false, pingCostUsd: null, savingUsd: null, netUsd: null };
  }
  const outputTokens = finite(input.outputTokens) ?? KEEP_ALIVE_LIMITS.pingOutputTokens;
  const pingCostUsd = (tokens * read + outputTokens * out) / 1e6;
  const savingUsd = (tokens * (write - read)) / 1e6;
  return {
    known: true,
    pingCostUsd: Number(pingCostUsd.toFixed(6)),
    savingUsd: Number(savingUsd.toFixed(6)),
    netUsd: Number((savingUsd - pingCostUsd).toFixed(6)),
  };
}

/**
 * Remaining budget view shared by the scheduler, MCP and UI.
 *
 * `spentUsd` only counts pings whose cost is MEASURED; every ping with an
 * unknown cost is counted separately and the remaining budget becomes
 * `unknown` instead of a number that could be exceeded unnoticed.
 *
 * @param {{ limits: { maxPings: number, budgetUsd: number|null }, pingsDone: number, spentUsd: number, unknownCostPings: number }} plan
 * @returns {{ pingsRemaining: number, budgetUsd: number|null, spentUsd: number, remainingUsd: number|null, unknownCostPings: number, costComplete: boolean }}
 */
export function describeKeepAliveBudget(plan) {
  const limits = plan?.limits || {};
  const spent = Number(plan?.spentUsd) || 0;
  const unknown = Number(plan?.unknownCostPings) || 0;
  const budget = finite(limits.budgetUsd);
  return {
    pingsRemaining: Math.max(0, (Number(limits.maxPings) || 0) - (Number(plan?.pingsDone) || 0)),
    budgetUsd: budget,
    spentUsd: Number(spent.toFixed(6)),
    remainingUsd: budget == null || unknown > 0 ? null : Number(Math.max(0, budget - spent).toFixed(6)),
    unknownCostPings: unknown,
    costComplete: unknown === 0,
  };
}

/**
 * Decides what to do with an ACTIVE plan right now.
 *
 * Order is the contract: terminal conditions first (they must never be
 * outrun by a ping), then deferrals that protect running work and user
 * commands, then due-ness. A `manual` ping uses `forced: true` and skips only
 * the due-ness/economics checks; it never skips a stop or a deferral.
 *
 * @param {{
 *   plan: {
 *     mode: string,
 *     generation: number,
 *     limits: { maxPings: number, minIntervalMs: number, deadlineAt: number, budgetUsd: number|null, expectNextRoundUntil: number|null },
 *     pingsDone: number,
 *     spentUsd: number,
 *     unknownCostPings: number,
 *     ineffectiveStreak: number,
 *     lastPingAt: number|null,
 *     lastEvaluatedAt?: number|null,
 *     inFlight?: boolean,
 *   },
 *   now: number,
 *   forced?: boolean,
 *   chatExists: boolean,
 *   cancelled?: boolean,
 *   workflowEnded?: boolean,
 *   generation: number,
 *   providerLimited?: boolean,
 *   busy?: boolean,
 *   lastForeignTurnAt?: number|null,
 *   freshness?: { ttlKnown?: boolean, expiresAt?: number|null, state?: string } | null,
 *   economics?: ReturnType<typeof estimateKeepAliveEconomics> | null,
 * }} input
 * @returns {{ action: 'ping'|'defer'|'stop', reason: string, retryAt?: number|null }}
 */
export function decideKeepAliveAction(input) {
  const S = KEEP_ALIVE_STOP_REASON;
  const D = KEEP_ALIVE_DEFER_REASON;
  const L = KEEP_ALIVE_LIMITS;
  const { plan, now } = input;
  const forced = input.forced === true;
  const stop = (reason) => ({ action: 'stop', reason });
  if (input.cancelled) return stop(S.CANCELLED);
  if (input.workflowEnded) return stop(S.WORKFLOW_ENDED);
  if (!input.chatExists) return stop(S.CHAT_MISSING);
  if (Number(input.generation) !== Number(plan.generation)) return stop(S.SESSION_RESET);
  if (now >= plan.limits.deadlineAt) return stop(S.DEADLINE);
  if (plan.pingsDone >= plan.limits.maxPings) return stop(S.PING_LIMIT);
  const budget = plan.limits.budgetUsd;
  // A plan always has a positive budget (normalizeKeepAliveLimits), manual included.
  if (plan.unknownCostPings > 0) return stop(S.COST_UNKNOWN);
  if (budget != null && plan.spentUsd >= budget) return stop(S.BUDGET_EXHAUSTED);
  if (input.providerLimited) return stop(S.PROVIDER_LIMIT);
  if (plan.ineffectiveStreak >= L.maxIneffectivePings) return stop(S.INEFFECTIVE);
  if (!forced) {
    const until = plan.limits.expectNextRoundUntil;
    if (until != null && now > until) return stop(S.NOT_NEEDED);
  }
  if (plan.inFlight) return { action: 'defer', reason: D.PING_IN_FLIGHT };
  // Running review (or any run) in the session is never preempted.
  if (input.busy) return { action: 'defer', reason: D.BUSY, retryAt: now + L.userQuietMs };
  const foreign = finite(input.lastForeignTurnAt);
  if (foreign != null && now - foreign < L.userQuietMs) {
    return { action: 'defer', reason: D.USER_COMMAND, retryAt: foreign + L.userQuietMs };
  }
  if (plan.lastPingAt != null && now - plan.lastPingAt < plan.limits.minIntervalMs) {
    return { action: 'defer', reason: D.MIN_INTERVAL, retryAt: plan.lastPingAt + plan.limits.minIntervalMs };
  }
  if (forced) return { action: 'ping', reason: 'manual' };
  const expiresAt = finite(input.freshness?.expiresAt);
  if (input.freshness?.ttlKnown !== true || expiresAt == null) {
    // Without a reliable expiry an automatic ping would be a blind payment.
    return input.freshness?.state === 'cold' ? stop(S.CACHE_EXPIRED) : stop(S.UNAVAILABLE);
  }
  if (now >= expiresAt) return stop(S.CACHE_EXPIRED);
  const economics = input.economics;
  if (!economics || economics.known !== true) return stop(S.COST_UNKNOWN);
  if (!(economics.netUsd > 0)) return stop(S.NOT_ECONOMIC);
  const dueAt = expiresAt - L.leadMs;
  if (now < dueAt) return { action: 'defer', reason: D.NOT_DUE, retryAt: dueAt };
  return { action: 'ping', reason: 'ttl_due' };
}
