/**
 * Cost limits and the circuit breaker of the internal operator.
 *
 * Budgets (`operator-settings.js`): runs per hour (global and per workspace),
 * per-run token caps (triage / diagnosis), a daily token budget with a
 * triage-only mode at 80% and a reserve for priority 0-1 events after 100%.
 * Token numbers come from the usage ledger, which lags a run by seconds to
 * minutes, so the daily figure can undercount the newest run; the per-run
 * check therefore reads the ledger again at every supervision tick.
 *
 * Circuit breaker (M7): a persistent count of CONSECUTIVE counted failures in
 * `operator_meta`. Counted: `deadline`, `missing_report`, `token_cap`,
 * `start_failed`. Not counted (they say nothing about run health): restart
 * interruptions, `no_safe_harness`, `no_model`, owner cancel, budget skips. A
 * completed run (`done` or `no_action`) resets the count. A run is counted once
 * (`breaker_last_run`), so a replayed finish cannot double count.
 */

import { getMeta, openOperatorStore, setMeta, withImmediateTx } from './operator-internal-store.js';

export const OPERATOR_COUNTED_FAILURES = Object.freeze(['deadline', 'missing_report', 'token_cap', 'start_failed']);

/** Event priority: lower is more urgent. Unknown kinds are the least urgent. */
export const OPERATOR_EVENT_PRIORITY = Object.freeze({
  owner_message: 0,
  watcher_stopped: 1,
  server_restarted: 1,
  review_failed: 2,
  needs_rescope: 2,
  needs_human: 2,
  blocked: 2,
  operator_test: 2,
  integration_ready: 3,
});

/** @param {string} kind @returns {number} */
export function operatorEventPriority(kind) {
  return OPERATOR_EVENT_PRIORITY[kind] ?? 9;
}

/**
 * `integration_ready` is always triage-only (a cheap "is it really ready" look);
 * `operator_test` is triage so tests stay cheap; everything else is a diagnosis.
 *
 * @param {{ kind: string }[]} events
 * @param {{ triageOnly?: boolean }} [flags]
 * @returns {'triage' | 'diagnosis'}
 */
export function classifyRunKind(events, flags = {}) {
  if (flags.triageOnly) return 'triage';
  return events.some((event) => !['integration_ready', 'operator_test'].includes(event.kind)) ? 'diagnosis' : 'triage';
}

/**
 * @param {number} usedToday tokens already spent today
 * @param {{ dailyTokenBudget: number, triageOnlyAt: number, reserveFraction: number }} settings
 * @param {number} bestPriority priority of the most urgent pending event
 * @returns {{ allowed: boolean, triageOnly: boolean, reason?: string, reserve?: boolean }}
 */
export function evaluateDailyBudget(usedToday, settings, bestPriority) {
  const budget = settings.dailyTokenBudget;
  const ratio = usedToday / budget;
  if (ratio < settings.triageOnlyAt) return { allowed: true, triageOnly: false };
  if (ratio < 1) return { allowed: true, triageOnly: true };
  // Budget spent: only priority 0-1 events may use the reserve.
  const reserveLimit = budget + Math.floor(budget * settings.reserveFraction);
  if (bestPriority <= 1 && usedToday < reserveLimit) return { allowed: true, triageOnly: true, reserve: true };
  return { allowed: false, triageOnly: true, reason: usedToday >= reserveLimit ? 'daily_budget_reserve_spent' : 'daily_budget_spent' };
}

/**
 * Starts within the last hour, overall and for one workspace. Priority 0-1 events skip the hourly limit.
 *
 * @param {Record<string, any>} storeOptions
 * @param {{ now: number, workspace: string, runsPerHour: number, runsPerHourPerWorkspace: number, bestPriority: number }} input
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function evaluateHourlyLimit(storeOptions, input) {
  if (input.bestPriority <= 1) return { allowed: true };
  const since = new Date(input.now - 3_600_000).toISOString();
  const db = openOperatorStore(storeOptions);
  try {
    const all = Number(db.prepare('SELECT COUNT(*) AS n FROM operator_runs WHERE started_at >= ?').get(since).n);
    if (all >= input.runsPerHour) return { allowed: false, reason: 'runs_per_hour' };
    const ws = Number(db.prepare('SELECT COUNT(*) AS n FROM operator_runs WHERE started_at >= ? AND workspace = ?').get(since, input.workspace).n);
    if (ws >= input.runsPerHourPerWorkspace) return { allowed: false, reason: 'runs_per_hour_workspace' };
    return { allowed: true };
  } finally { db.close(); }
}

/**
 * Tokens of every run started since local midnight (finished runs carry the
 * measured figure, a running one counts what was last recorded).
 *
 * @param {Record<string, any>} storeOptions
 * @param {number} now
 * @returns {number}
 */
export function readDailyTokens(storeOptions, now) {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  const db = openOperatorStore(storeOptions);
  try {
    return Number(db.prepare('SELECT COALESCE(SUM(tokens_used), 0) AS n FROM operator_runs WHERE started_at >= ?').get(day.toISOString()).n) || 0;
  } finally { db.close(); }
}

// ---- Circuit breaker ------------------------------------------------------

/**
 * @param {Record<string, any>} storeOptions
 * @returns {{ failures: number, paused: boolean, pausedAt: string, notified: boolean }}
 */
export function readBreaker(storeOptions) {
  const db = openOperatorStore(storeOptions);
  try {
    return {
      failures: Number(getMeta(db, 'breaker_failures', '0')) || 0,
      paused: getMeta(db, 'breaker_paused_at', '') !== '',
      pausedAt: getMeta(db, 'breaker_paused_at', ''),
      notified: getMeta(db, 'breaker_notified', '') === '1',
    };
  } finally { db.close(); }
}

/**
 * Record the end of a run. Idempotent per run id.
 *
 * @param {Record<string, any>} storeOptions
 * @param {{ runId: string, ok: boolean, reason?: string, threshold: number, now?: number }} input
 * @returns {{ failures: number, paused: boolean, tripped: boolean }} `tripped` is true only on the transition to paused
 */
export function recordRunOutcome(storeOptions, input) {
  const db = openOperatorStore(storeOptions);
  try {
    return withImmediateTx(db, () => {
      let failures = Number(getMeta(db, 'breaker_failures', '0')) || 0;
      let paused = getMeta(db, 'breaker_paused_at', '') !== '';
      if (getMeta(db, 'breaker_last_run', '') === input.runId) return { failures, paused, tripped: false };
      setMeta(db, 'breaker_last_run', input.runId);
      if (input.ok) {
        failures = 0;
        setMeta(db, 'breaker_failures', 0);
        return { failures, paused, tripped: false };
      }
      if (!OPERATOR_COUNTED_FAILURES.includes(String(input.reason))) return { failures, paused, tripped: false };
      failures += 1;
      setMeta(db, 'breaker_failures', failures);
      let tripped = false;
      if (!paused && failures >= input.threshold) {
        setMeta(db, 'breaker_paused_at', new Date(input.now ?? Date.now()).toISOString());
        setMeta(db, 'breaker_notified', '');
        paused = true; tripped = true;
      }
      return { failures, paused, tripped };
    });
  } finally { db.close(); }
}

/** @param {Record<string, any>} storeOptions @returns {void} marks the single pause notification as sent */
export function markBreakerNotified(storeOptions) {
  const db = openOperatorStore(storeOptions);
  try { setMeta(db, 'breaker_notified', '1'); } finally { db.close(); }
}

/** Owner action: resume event-triggered runs and reset the counter. */
export function clearBreaker(storeOptions) {
  const db = openOperatorStore(storeOptions);
  try {
    withImmediateTx(db, () => {
      setMeta(db, 'breaker_failures', 0);
      setMeta(db, 'breaker_paused_at', '');
      setMeta(db, 'breaker_notified', '');
    });
  } finally { db.close(); }
}
