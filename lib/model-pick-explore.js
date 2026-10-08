/**
 * Controlled out-of-band exploration for `model_pick` (stage 6).
 *
 * The rotation band in `lib/model-role-profiles.js` is an *within-band* balance
 * plus a cold-start bonus: a pair that scores below the tie band never gets a
 * job, however little is known about it. This module gives a
 * (harness, base model, role) pair that sits OUTSIDE that band a bounded,
 * quota-limited chance, without touching the band, the score, or any safety
 * filter. The first deployment ships dry-run `would-explore` logging plus tests;
 * real exploration stays behind an explicit flag.
 *
 * Policy implemented here:
 * - unit is the pair `(harness, base model, role)` while it has fewer than
 *   `minObservedN` observations in the 30-day window — not the harness alone, so
 *   a new model on an already-used harness can qualify. At `n >= minObservedN`
 *   the pair returns to normal rotation: the boundary moves the allocation pool
 *   only, the n/(n+10) shrinkage, ratings and infra prior keep working, and the
 *   result of an explore attempt feeds them through the ordinary delegation
 *   record. There is no separate score promotion;
 * - deterministic order: fewest explore attempts in the window -> smallest n ->
 *   earliest attempt (a pair never attempted sorts first) -> stable pair id.
 *   Variants collapse to their base id, so `glm-4.6::effort=high` and `glm-4.6`
 *   cannot multiply one pair's chances;
 * - budget: one slot per `everyAutoExecuted` actually-executed automatic
 *   implement/fix jobs; `manual`/`unknown` origins never enter the denominator.
 *   Caps: per workspace per UTC day, per harness per UTC day, per pair per
 *   interval. Budget and reservation are evaluated atomically at start, from the
 *   durable attempt store — a pick without a start consumes nothing, and a
 *   restart of the same attempt resets nothing;
 * - after an infra fail the pair is on cooldown (>= 72h), and a timeout closes
 *   the attempt instead of opening a fresh one. A user cancel never rate-quality;
 * - plan and review are not explored in this deployment;
 * - every gate fails closed.
 */

/**
 * @typedef {import('./model-pick-policy.js').ModelPickExploreConfig} ModelPickExploreConfig
 */

import fs from 'node:fs';
import { decodeModelValue } from './model-catalog.js';
import { loadDelegations } from './persist/delegations-persist.js';
import {
  MODEL_PICK_EXPLORE_CONFIG_DEFAULTS,
  MODEL_PICK_EXPLORE_WINDOW_MS,
  composeModelPickExploreSegment,
  normalizeModelPickExploreConfig,
} from './model-pick-policy.js';
import { resolveDataPath } from './runtime-paths.js';
import {
  findModelPickExploreAttempt,
  finishModelPickExploreAttempt,
  loadModelPickExploreAttempts,
  releaseModelPickExploreAttempt,
  reserveModelPickExploreAttempt,
  startModelPickExploreAttempt,
} from './persist/model-pick-explore-persist.js';

/** Roles this deployment may explore at all. Plan and review never appear here. */
export const MODEL_PICK_EXPLORE_ROLES = Object.freeze(['implement', 'fix']);

/** `pickOriginDetail` of an out-of-band explore attempt. */
export const MODEL_PICK_EXPLORE_ORIGIN_DETAIL = 'out-of-band-explore';

/** Outcomes that close an attempt. */
export const MODEL_PICK_EXPLORE_OUTCOMES = Object.freeze([
  'completed',
  'infra_fail',
  'cancelled',
  'timeout',
]);

/** Outcomes that consumed the pair's chance (a timeout cannot be retried away). */
const CONSUMED_OUTCOMES = new Set(['completed', 'infra_fail', 'cancelled', 'timeout']);

/** Outcomes that may never rate model quality. */
const UNRATED_OUTCOMES = new Set(['cancelled']);

/** Outcomes that start a pair cooldown. A user cancel is not an infra fault. */
const COOLDOWN_OUTCOMES = new Set(['infra_fail', 'timeout']);

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * @returns {object[]}
 */
function safeLoadDelegations() {
  try {
    return loadDelegations();
  } catch {
    return [];
  }
}

/**
 * @param {unknown} at
 * @returns {number} epoch ms, 0 when the row carries no usable timestamp
 */
function timeOf(at) {
  if (Number.isFinite(Number(at)) && Number(at) > 0) return Number(at);
  const parsed = Date.parse(String(at || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * @param {number} ms
 * @returns {string} UTC day key `YYYY-MM-DD`; the daily caps are UTC-day scoped
 */
export function modelPickExploreUtcDay(ms) {
  const value = Number.isFinite(Number(ms)) ? Number(ms) : Date.now();
  return new Date(value).toISOString().slice(0, 10);
}

/**
 * Pair identity: harness + BASE model + role. Variant parameters are stripped,
 * so variants of one base model share a pair and its chances.
 *
 * @param {string} harness
 * @param {string} model
 * @param {string} role
 * @returns {string} '' when any part is missing
 */
export function modelPickExplorePairKey(harness, model, role) {
  const h = String(harness || '').trim().toLowerCase();
  const base = String(decodeModelValue(model).modelId || model || '').trim().toLowerCase();
  const r = String(role || '').trim().toLowerCase();
  if (!h || !base || !r) return '';
  return `${h}/${base}/${r}`;
}

/**
 * @param {unknown} raw
 * @returns {ModelPickExploreConfig}
 */
export function loadModelPickExploreConfig(input = {}) {
  const filePath = String(input.filePath || '').trim() || resolveDataPath('model-role-profiles.json');
  try {
    return normalizeModelPickExploreConfig(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch {
    return MODEL_PICK_EXPLORE_CONFIG_DEFAULTS;
  }
}

/**
 * @typedef {{
 *   pairKey: string,
 *   harness: string,
 *   baseModel: string,
 *   role: string,
 *   workspaceKey: string,
 *   segment: string,
 *   status: string,
 *   outcome: string,
 *   startedAt: number,
 *   finishedAt: number,
 *   cooldownUntil: number,
 * }} ExploreAttemptView
 */

/**
 * Project one durable row onto the shape the limits read. A row without a pair
 * key is dropped: an attempt that cannot name its pair cannot be counted.
 *
 * @param {object} row
 * @returns {ExploreAttemptView | null}
 */
function normalizeExploreAttempt(row) {
  if (!row || typeof row !== 'object') return null;
  const harness = String(row.harness || '').trim().toLowerCase();
  const baseModel = String(
    row.baseModel || decodeModelValue(row.model).modelId || row.model || '',
  ).trim().toLowerCase();
  const role = String(row.role || '').trim().toLowerCase();
  const pairKey = String(row.pairKey || '').trim().toLowerCase()
    || modelPickExplorePairKey(harness, baseModel, role);
  if (!pairKey || !harness || !role) return null;
  const outcome = String(row.outcome || '').trim().toLowerCase();
  const status = String(row.status || '').trim().toLowerCase();
  const startedAt = timeOf(row.startedAt || row.reservedAt || row.createdAt);
  const finishedAt = timeOf(row.finishedAt);
  const cooldownUntil = timeOf(row.cooldownUntil);
  return {
    pairKey,
    harness,
    baseModel,
    role,
    workspaceKey: String(row.workspaceKey || row.workspaceFolder || '').trim().toLowerCase(),
    segment: String(row.segment || row.explorePolicyVersion || '').trim(),
    status,
    outcome,
    startedAt,
    finishedAt,
    // An infra fail or timeout with no recorded anchor still blocks the pair for
    // at least the configured cooldown from the moment it closed.
    cooldownUntil: cooldownUntil
      || (COOLDOWN_OUTCOMES.has(outcome) && finishedAt > 0
        ? finishedAt + MODEL_PICK_EXPLORE_CONFIG_DEFAULTS.infraCooldownMs
        : 0),
    open: !status ? true : (status === 'reserved' || status === 'started'),
  };
}

/**
 * @typedef {{
 *   attempts: ExploreAttemptView[],
 *   byPair: Record<string, ExploreAttemptView[]>,
 *   firstAttemptByPair: Record<string, number>,
 *   lastAttemptByPair: Record<string, number>,
 *   consumedByPair: Record<string, number>,
 *   cooldownByPair: Record<string, number>,
 *   openByPair: Record<string, ExploreAttemptView>,
 *   workspaceDay: Record<string, number>,
 *   harnessDay: Record<string, number>,
 *   consumed: number,
 * }} ExploreLedger
 */

/**
 * Cohort-scoped allocation counters plus cross-cohort safety counters.
 *
 * `segment` filters the allocation view (per-pair attempts, daily caps, consumed
 * credits): a policyVersion change or a dry-run -> real flip starts a new cohort
 * instead of mixing new attempts into the stage-7 shadow window. The safety view
 * (`cooldownByPair`, `openByPair`) deliberately ignores the segment, so changing
 * the policy version can never forget a cooldown or run two attempts at once.
 *
 * @param {unknown} rows durable explore attempts
 * @param {{ now?: number, windowMs?: number, segment?: string }} [input]
 * @returns {ExploreLedger}
 */
export function summarizeModelPickExploreAttempts(rows, input = {}) {
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const windowMs = Number.isFinite(Number(input.windowMs)) && Number(input.windowMs) > 0
    ? Number(input.windowMs)
    : MODEL_PICK_EXPLORE_WINDOW_MS;
  const segment = typeof input.segment === 'string' ? input.segment : '';
  const cutoff = now - windowMs;
  const attempts = Array.isArray(rows)
    ? rows.map(normalizeExploreAttempt).filter((row) => row !== null)
    : [];
  /** @type {ExploreLedger} */
  const ledger = {
    attempts,
    byPair: {},
    firstAttemptByPair: {},
    lastAttemptByPair: {},
    consumedByPair: {},
    cooldownByPair: {},
    openByPair: {},
    workspaceDay: {},
    harnessDay: {},
    consumed: 0,
  };
  for (const attempt of attempts) {
    if (attempt.cooldownUntil > 0) {
      ledger.cooldownByPair[attempt.pairKey] = Math.max(
        ledger.cooldownByPair[attempt.pairKey] || 0,
        attempt.cooldownUntil,
      );
    }
    // A released row never started, so it holds no slot and consumes nothing;
    // the cooldown above is a safety record, not an allocation, so it stays.
    if (attempt.status === 'released') continue;
    if (attempt.open && attempt.startedAt > 0) ledger.openByPair[attempt.pairKey] = attempt;
    if (segment && attempt.segment !== segment) continue;
    const anchor = attempt.finishedAt || attempt.startedAt;
    if (!(anchor >= cutoff)) continue;
    const bucket = ledger.byPair[attempt.pairKey] || [];
    bucket.push(attempt);
    ledger.byPair[attempt.pairKey] = bucket;
    if (anchor > 0) {
      const first = ledger.firstAttemptByPair[attempt.pairKey];
      ledger.firstAttemptByPair[attempt.pairKey] = first == null || anchor < first ? anchor : first;
      ledger.lastAttemptByPair[attempt.pairKey] = Math.max(
        ledger.lastAttemptByPair[attempt.pairKey] || 0,
        anchor,
      );
    }
    const spent = CONSUMED_OUTCOMES.has(attempt.outcome) || (!attempt.outcome && attempt.startedAt > 0);
    if (spent) {
      ledger.consumedByPair[attempt.pairKey] = (ledger.consumedByPair[attempt.pairKey] || 0) + 1;
      ledger.consumed += 1;
    }
    if (attempt.startedAt > 0) {
      const day = modelPickExploreUtcDay(attempt.startedAt);
      if (attempt.workspaceKey) {
        const key = `${attempt.workspaceKey}|${day}`;
        ledger.workspaceDay[key] = (ledger.workspaceDay[key] || 0) + 1;
      }
      const harnessKey = `${attempt.harness}|${day}`;
      ledger.harnessDay[harnessKey] = (ledger.harnessDay[harnessKey] || 0) + 1;
    }
  }
  return ledger;
}

/**
 * Denominator of the explore budget: automatic implement/fix jobs that really
 * ran in the window. `manual` and `unknown` origins never enter it, so a human
 * choice cannot fund experiments nobody agreed to, and a job that never left the
 * queue did not execute at all.
 *
 * @param {unknown} rows delegation rows
 * @param {{ now?: number, windowMs?: number }} [input]
 * @returns {number}
 */
export function countModelPickAutoExecuted(rows, input = {}) {
  if (!Array.isArray(rows)) return 0;
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const windowMs = Number.isFinite(Number(input.windowMs)) && Number(input.windowMs) > 0
    ? Number(input.windowMs)
    : MODEL_PICK_EXPLORE_WINDOW_MS;
  const cutoff = now - windowMs;
  let count = 0;
  for (const row of rows) {
    if (String(row?.pickOrigin || '').trim().toLowerCase() !== 'auto') continue;
    const role = String(row?.pickRole || '').trim().toLowerCase();
    if (!MODEL_PICK_EXPLORE_ROLES.includes(role)) continue;
    const status = String(row?.status || '').trim().toLowerCase();
    if (status === 'queued' || status === 'rejected') continue;
    if (!(timeOf(row?.startedAt || row?.runningAt || row?.createdAt) >= cutoff)) continue;
    count += 1;
  }
  return count;
}

/**
 * Credits earned by the executed denominator minus the attempts this cohort
 * already spent. Computed inside the reservation lock, so two concurrent starts
 * cannot both read the same free credit.
 *
 * @param {{ autoExecuted?: number, consumed?: number, everyAutoExecuted?: number }} input
 * @returns {{ earned: number, consumed: number, remaining: number }}
 */
export function computeModelPickExploreCredits(input = {}) {
  const every = Math.max(
    1,
    Math.floor(Number(input.everyAutoExecuted) || MODEL_PICK_EXPLORE_CONFIG_DEFAULTS.everyAutoExecuted),
  );
  const autoExecuted = Math.max(0, Math.floor(Number(input.autoExecuted) || 0));
  const consumed = Math.max(0, Math.floor(Number(input.consumed) || 0));
  const earned = Math.floor(autoExecuted / every);
  return { earned, consumed, remaining: Math.max(0, earned - consumed) };
}

/**
 * @typedef {{
 *   task?: {
 *     kind?: string,
 *     afterFail?: boolean,
 *     lastRound?: boolean,
 *     reviewMandatory?: boolean,
 *     boundedChanges?: boolean,
 *     deployOrPublish?: boolean,
 *     dataMigration?: boolean,
 *     externalOps?: boolean,
 *     deadlineAt?: string | number,
 *     remainingDeadlineMs?: number,
 *     executorMaxMs?: number,
 *   },
 *   autopilot?: boolean,
 *   metering?: {
 *     billing?: string,
 *     priceTrusted?: boolean,
 *     enforceableCapUsd?: number | null,
 *     enforcement?: string,
 *     utilizationPct?: number | null,
 *   },
 * }} ModelPickExploreContext
 */

/**
 * `unknown` enforcement of a late usage signal, which is the whole point of the
 * cost gate.
 *
 * @param {ModelPickExploreContext['metering']} [metering]
 * @returns {{ billing: string, priceTrusted: boolean, enforceableCapUsd: number, enforced: boolean, utilizationPct: number, quotaKnown: boolean }}
 */
function normalizeMetering(metering) {
  const src = metering && typeof metering === 'object' ? /** @type {Record<string, unknown>} */ (metering) : {};
  const billingRaw = String(src.billing || '').trim().toLowerCase();
  const billing = ['api', 'metered', 'subscription'].includes(billingRaw) ? billingRaw : 'unknown';
  const cap = Number(src.enforceableCapUsd);
  const utilization = Number(src.utilizationPct);
  const enforcement = String(src.enforcement || '').trim().toLowerCase();
  return {
    billing,
    priceTrusted: src.priceTrusted === true,
    enforceableCapUsd: Number.isFinite(cap) && cap > 0 ? cap : 0,
    enforced: enforcement === 'upstream_limit' || enforcement === 'hard_bound',
    utilizationPct: Number.isFinite(utilization) ? utilization : Number.NaN,
    quotaKnown: Number.isFinite(utilization),
  };
}

/**
 * Task-level gates: what this deployment is willing to explore at all, and what
 * the workflow state forbids. A missing task context blocks the attempt.
 *
 * @param {{ role?: string, config?: ModelPickExploreConfig, context?: ModelPickExploreContext, now?: number }} input
 * @returns {string[]} stable block codes
 */
export function exploreTaskBlocks({ role, config = MODEL_PICK_EXPLORE_CONFIG_DEFAULTS, context, now = Date.now() } = {}) {
  const blocked = [];
  const normalizedRole = String(role || '').trim().toLowerCase();
  if (!MODEL_PICK_EXPLORE_ROLES.includes(normalizedRole)) blocked.push('role_not_explored');
  const ctx = context && typeof context === 'object' ? context : {};
  if (ctx.autopilot === true && config.autopilot !== true) blocked.push('autopilot_opt_in');
  const task = ctx.task && typeof ctx.task === 'object' ? ctx.task : null;
  if (!task) {
    blocked.push('task_context_missing');
    return blocked;
  }
  if (task.afterFail === true) blocked.push('fix_after_fail');
  if (task.lastRound === true) blocked.push('last_round');
  if (task.deployOrPublish === true || task.dataMigration === true || task.externalOps === true) {
    blocked.push('forbidden_operation');
  }
  if (task.boundedChanges !== true) blocked.push('unbounded_changes');
  const kind = String(task.kind || normalizedRole || '').trim().toLowerCase();
  if (kind === 'fix' && task.reviewMandatory !== true && config.allowFixWithoutReview !== true) {
    blocked.push('fix_requires_review');
  }
  const remaining = Number(task.remainingDeadlineMs);
  if (Number.isFinite(remaining)) {
    if (remaining < config.minDeadlineMs) blocked.push('deadline_too_close');
  } else {
    const deadlineAt = timeOf(task.deadlineAt);
    if (deadlineAt > 0 && deadlineAt - now < config.minDeadlineMs) blocked.push('deadline_too_close');
  }
  const executorMs = Number(task.executorMaxMs);
  if (Number.isFinite(executorMs) && executorMs > config.maxExecutorMs) blocked.push('executor_time_limit');
  return blocked;
}

/**
 * Candidate-level gates: sampling, band position, proven winner, usage limits,
 * cost and quota evidence.
 *
 * @param {{ candidate?: object, pick?: object, config?: ModelPickExploreConfig, metering?: ModelPickExploreContext['metering'] }} input
 * @returns {string[]} stable block codes
 */
export function exploreCandidateBlocks({
  candidate,
  pick,
  config = MODEL_PICK_EXPLORE_CONFIG_DEFAULTS,
  metering,
} = {}) {
  const blocked = [];
  if (!candidate || typeof candidate !== 'object') {
    blocked.push('no_candidate');
    return blocked;
  }
  // A proven winner (the last implement->review cycle of this model in the chat
  // PASSed) is never displaced by an experiment.
  if (pick && pick.keep_winner === true) blocked.push('keep_winner');
  if (candidate.in_band === true) blocked.push('inside_band');
  const n = Number(candidate.observed?.n);
  const sample = Number.isFinite(n) && n > 0 ? n : 0;
  if (sample >= config.minObservedN) blocked.push('sample_sufficient');
  // Usage limits are never bypassed: a plan limit at the penalty threshold or a
  // fresh limit hit already removed this pair from rotation for a reason.
  if (Number(candidate.plan_limit_penalty) > 0) blocked.push('plan_limit');
  const meter = normalizeMetering(metering);
  const costTier = Math.max(1, Math.min(5, Math.round(Number(candidate.cost_tier) || 3)));
  if (meter.billing === 'api' || meter.billing === 'metered') {
    const withinBudget = meter.enforceableCapUsd > 0 && meter.enforceableCapUsd <= config.maxAttemptUsd;
    // A trustworthy price and an enforceable upper bound are both required; the
    // usage ledger alone arrives too late to cap anything.
    if (!meter.priceTrusted || !meter.enforced || !withinBudget) blocked.push('cost_not_enforceable');
  } else {
    // Subscription or unknown cost: a bounded fallback tier with a time/step
    // limit, and never a claim of being free.
    if (costTier > config.maxCostTier) blocked.push('cost_tier_above_fallback');
    if (!(Number(config.maxExecutorMs) > 0)) blocked.push('step_limit_missing');
  }
  if (costTier >= 4 && config.premiumOptIn !== true) blocked.push('premium_opt_in');
  if (meter.quotaKnown && meter.utilizationPct >= 90) blocked.push('quota_exhausted');
  // "No quota data" is an unknown state, not an empty one: a metered pair with
  // no quota reading cannot be proven to have room.
  if ((meter.billing === 'api' || meter.billing === 'metered') && !meter.quotaKnown) blocked.push('quota_unknown');
  return blocked;
}

/**
 * Limit gates for one pair, read from the cohort ledger.
 *
 * @param {{ pairKey?: string, harness?: string, workspaceKey?: string, ledger?: ExploreLedger, config?: ModelPickExploreConfig, now?: number, credits?: { remaining: number } }} input
 * @returns {string[]} stable block codes
 */
export function exploreLimitBlocks({
  pairKey = '',
  harness = '',
  workspaceKey = '',
  ledger,
  config = MODEL_PICK_EXPLORE_CONFIG_DEFAULTS,
  now = Date.now(),
  credits,
} = {}) {
  const blocked = [];
  if (!ledger) return blocked;
  const key = String(pairKey || '').trim().toLowerCase();
  if (credits && Number(credits.remaining) <= 0) blocked.push('credit_exhausted');
  if ((ledger.cooldownByPair[key] || 0) > now) blocked.push('pair_cooldown');
  if (ledger.openByPair[key]) blocked.push('attempt_in_flight');
  const last = ledger.lastAttemptByPair[key] || 0;
  if (last > 0 && now - last < config.minPairIntervalMs) blocked.push('pair_interval');
  const day = modelPickExploreUtcDay(now);
  const workspace = String(workspaceKey || '').trim().toLowerCase();
  if (workspace && (ledger.workspaceDay[`${workspace}|${day}`] || 0) >= config.maxPerWorkspacePerUtcDay) {
    blocked.push('workspace_daily_limit');
  }
  const harnessId = String(harness || '').trim().toLowerCase();
  if (harnessId && (ledger.harnessDay[`${harnessId}|${day}`] || 0) >= config.maxPerHarnessPerUtcDay) {
    blocked.push('harness_daily_limit');
  }
  return blocked;
}

/**
 * Everything the atomic reservation needs, computed from one candidate, one
 * ledger and one context. The picker's dry-run and `delegation_start` call this
 * same function, so a `would-explore` line can never disagree with what a real
 * start would have allowed.
 *
 * @param {{
 *   role?: string,
 *   candidate?: object,
 *   pick?: object,
 *   pairKey?: string,
 *   workspaceKey?: string,
 *   config?: ModelPickExploreConfig,
 *   ledger?: ExploreLedger,
 *   credits?: { earned: number, consumed: number, remaining: number },
 *   context?: ModelPickExploreContext,
 *   metering?: ModelPickExploreContext['metering'],
 *   now?: number,
 * }} input
 * @returns {{ allowed: boolean, blocked: string[], limits: object }}
 */
export function evaluateModelPickExploreAttempt(input = {}) {
  const config = input.config || MODEL_PICK_EXPLORE_CONFIG_DEFAULTS;
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const ledger = input.ledger;
  const credits = input.credits;
  const limits = {
    everyAutoExecuted: config.everyAutoExecuted,
    maxPerWorkspacePerUtcDay: config.maxPerWorkspacePerUtcDay,
    maxPerHarnessPerUtcDay: config.maxPerHarnessPerUtcDay,
    minPairIntervalMs: config.minPairIntervalMs,
    infraCooldownMs: config.infraCooldownMs,
    maxAttemptUsd: config.maxAttemptUsd,
    maxExecutorMs: config.maxExecutorMs,
    minDeadlineMs: config.minDeadlineMs,
    earned: credits?.earned ?? 0,
    consumed: credits?.consumed ?? 0,
    remaining: credits?.remaining ?? 0,
    pairAttempts: ledger?.consumedByPair?.[input.pairKey] || 0,
    cooldownUntil: ledger?.cooldownByPair?.[input.pairKey] || 0,
  };
  const blocked = [
    ...exploreTaskBlocks({ role: input.role, config, context: input.context, now }),
    ...exploreCandidateBlocks({
      candidate: input.candidate,
      pick: input.pick,
      config,
      metering: input.metering || input.context?.metering,
    }),
    ...exploreLimitBlocks({
      pairKey: input.pairKey,
      harness: input.candidate?.harness,
      workspaceKey: input.workspaceKey,
      ledger,
      config,
      now,
      credits,
    }),
  ];
  return { allowed: blocked.length === 0, blocked, limits };
}

/**
 * @param {{ n?: unknown }|null} observed
 * @returns {number}
 */
function observedCount(observed) {
  const n = Number(observed?.n);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Deterministic explore choice over the picker's surviving candidates.
 *
 * The pool is what `selectModelPick` already let through, so Settings favorites,
 * `exclude_model`/`exclude_harness`, availability, active lockouts, the flash
 * rule for review and the review-adapter guarantee are applied before an explore
 * pair is ever considered — exploration cannot bypass them.
 *
 * Order: fewest explore attempts in the window -> smallest observed n -> earliest
 * attempt (never-attempted sorts first) -> stable pair key.
 *
 * @param {{
 *   role?: string,
 *   pick?: object,
 *   candidates?: object[],
 *   config?: ModelPickExploreConfig,
 *   context?: ModelPickExploreContext,
 *   metering?: Record<string, ModelPickExploreContext['metering']>,
 *   attempts?: object[],
 *   autoExecuted?: number,
 *   delegationRows?: object[],
 *   workspaceKey?: string,
 *   now?: number,
 * }} input
 * @returns {{
 *   mode: string,
 *   decision: string,
 *   wouldExplore: boolean,
 *   selected: object | null,
 *   pairKey: string,
 *   reason: string,
 *   blocked: string[],
 *   limits: object,
 *   segment: string,
 *   logLine: string,
 * }}
 */
export function selectModelPickExplore(input = {}) {
  const config = input.config || MODEL_PICK_EXPLORE_CONFIG_DEFAULTS;
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const role = String(input.role || '').trim().toLowerCase();
  const segment = composeModelPickExploreSegment(config);
  const ledger = summarizeModelPickExploreAttempts(input.attempts, {
    now,
    windowMs: config.windowMs,
    segment,
  });
  const autoExecuted = Number.isFinite(Number(input.autoExecuted))
    ? Number(input.autoExecuted)
    : countModelPickAutoExecuted(input.delegationRows, { now, windowMs: config.windowMs });
  const credits = computeModelPickExploreCredits({
    autoExecuted,
    consumed: ledger.consumed,
    everyAutoExecuted: config.everyAutoExecuted,
  });
  const workspaceKey = String(input.workspaceKey || '').trim().toLowerCase();
  const taskBlocked = exploreTaskBlocks({ role, config, context: input.context, now });
  /** @type {Map<string, object>} */
  const byPair = new Map();
  for (const candidate of Array.isArray(input.candidates) ? input.candidates : []) {
    const key = modelPickExplorePairKey(candidate?.harness, candidate?.model, role);
    if (!key || byPair.has(key)) continue;
    byPair.set(key, candidate);
  }
  /** @type {{ key: string, candidate: object, verdict: ReturnType<typeof evaluateModelPickExploreAttempt> }[]} */
  const scored = [];
  for (const [key, candidate] of byPair) {
    const verdict = evaluateModelPickExploreAttempt({
      role,
      candidate,
      pick: input.pick,
      pairKey: key,
      workspaceKey,
      config,
      ledger,
      credits,
      context: input.context,
      metering: input.metering?.[key] || input.metering?.[`${String(candidate.harness).toLowerCase()}/${candidate.baseModel || ''}`],
      now,
    });
    if (verdict.allowed) scored.push({ key, candidate, verdict });
  }
  scored.sort((left, right) => {
    const attemptsDiff = (left.verdict.limits.pairAttempts || 0) - (right.verdict.limits.pairAttempts || 0);
    if (attemptsDiff !== 0) return attemptsDiff;
    const nDiff = observedCount(left.candidate.observed) - observedCount(right.candidate.observed);
    if (nDiff !== 0) return nDiff;
    const firstDiff = (ledger.firstAttemptByPair[left.key] || 0) - (ledger.firstAttemptByPair[right.key] || 0);
    if (firstDiff !== 0) return firstDiff;
    return left.key.localeCompare(right.key);
  });
  const chosen = scored[0] || null;
  const limits = chosen?.verdict.limits || {
    earned: credits.earned,
    consumed: credits.consumed,
    remaining: credits.remaining,
    everyAutoExecuted: config.everyAutoExecuted,
    maxPerWorkspacePerUtcDay: config.maxPerWorkspacePerUtcDay,
    maxPerHarnessPerUtcDay: config.maxPerHarnessPerUtcDay,
    minPairIntervalMs: config.minPairIntervalMs,
    infraCooldownMs: config.infraCooldownMs,
    maxAttemptUsd: config.maxAttemptUsd,
    maxExecutorMs: config.maxExecutorMs,
    minDeadlineMs: config.minDeadlineMs,
  };
  // A dry-run never reaches the reservation, so the reason must still read as
  // what a real start would have done.
  const reason = chosen
    ? `out-of-band explore ${chosen.key} (n=${observedCount(chosen.candidate.observed)},`
      + ` attempts=${limits.pairAttempts || 0}, credits=${limits.remaining}/${limits.earned},`
      + ` mode=${config.mode})`
    : `no explorable pair: ${(taskBlocked.length > 0
      ? taskBlocked
      : [...new Set([...byPair.keys()].flatMap(() => []))]
    ).join(', ') || 'every out-of-band pair is inside its band, sampled, or capped'}`;
  const decision = chosen ? (config.mode === 'real' ? 'start' : 'would-explore') : 'blocked';
  const logBits = [
    `role=${role}`,
    `decision=${decision}`,
    `mode=${config.mode}`,
  ];
  if (chosen) {
    logBits.push(`n=${observedCount(chosen.candidate.observed)}`);
  }
  logBits.push(`credits=${limits.remaining}/${limits.earned}`);
  if (!chosen) logBits.push(`blocked=${taskBlocked.join(',') || 'limits_or_gates'}`);
  const logLine = chosen
    ? `${decision} pair=${chosen.key} ${logBits.join(' ')}`
    : `${decision} ${logBits.join(' ')}`;
  return {
    mode: config.mode,
    decision,
    wouldExplore: Boolean(chosen),
    selected: chosen?.candidate || null,
    pairKey: chosen?.key || '',
    reason,
    blocked: chosen ? [] : [...taskBlocked],
    limits,
    segment,
    logLine,
  };
}

/**
 * Cooldown to apply when an attempt closes. `cancelled` is a user decision, not
 * an infra fault, so it never locks the pair out; an infra fail locks it for at
 * least 72 hours, and a timeout for the full pair interval so a burned attempt
 * cannot be bypassed by opening a fresh one.
 *
 * @param {{ outcome?: string, config?: ModelPickExploreConfig }} input
 * @returns {number} milliseconds, 0 when no cooldown applies
 */
export function modelPickExploreCooldownMs({ outcome, config = MODEL_PICK_EXPLORE_CONFIG_DEFAULTS } = {}) {
  const value = String(outcome || '').trim().toLowerCase();
  if (value === 'infra_fail') return config.infraCooldownMs;
  if (value === 'timeout') return Math.max(config.minPairIntervalMs, config.infraCooldownMs);
  return 0;
}

/**
 * The pair an assessment chose, projected for the pick record. It carries no
 * prompt text and no scores, only what a start needs to bind the durable
 * attempt to the proposal.
 *
 * @param {ReturnType<typeof selectModelPickExplore>} assessment
 * @param {string} role
 * @returns {object | null}
 */
export function buildModelPickExploreMarker(assessment, role) {
  const candidate = assessment?.selected;
  if (!assessment?.wouldExplore || !candidate) return null;
  const harness = String(candidate.harness || '').trim().toLowerCase();
  const model = String(candidate.model || '').trim();
  if (!harness || !model) return null;
  return {
    pairKey: assessment.pairKey,
    harness,
    model,
    baseModel: String(decodeModelValue(model).modelId || '').trim().toLowerCase(),
    role: String(role || '').trim().toLowerCase(),
    mode: assessment.mode,
    segment: assessment.segment,
    budgetUsd: assessment.limits?.maxAttemptUsd || MODEL_PICK_EXPLORE_CONFIG_DEFAULTS.maxAttemptUsd,
    maxExecutorMs: assessment.limits?.maxExecutorMs || MODEL_PICK_EXPLORE_CONFIG_DEFAULTS.maxExecutorMs,
  };
}

/**
 * Atomic explore budget check plus reservation, run at `delegation_start`.
 *
 * Every limit is re-evaluated INSIDE the cross-process lock of the attempt
 * store against the durable rows as they are at that instant, so two concurrent
 * starts cannot both see a free slot, and the denominator is read from the
 * durable delegations at the same moment. A refused guard writes nothing: a
 * blocked exploration consumes no budget, and a pick that never started never
 * reaches this function at all. A replay of the same `idempotencyKey` returns
 * the existing attempt untouched, so a restart resets nothing.
 *
 * @param {{
 *   marker: { pairKey: string, harness: string, model?: string, baseModel?: string, role: string, segment?: string, budgetUsd?: number, maxExecutorMs?: number },
 *   delegationId: string,
 *   idempotencyKey: string,
 *   pickId?: string,
 *   workspaceKey?: string,
 *   candidate?: object,
 *   pick?: object,
 *   context?: ModelPickExploreContext,
 *   metering?: ModelPickExploreContext['metering'],
 *   config?: ModelPickExploreConfig,
 *   delegations?: object[],
 *   now?: number,
 *   file?: string,
 *   lockTimeoutMs?: number,
 * }} input
 * @returns {Promise<{ ok: true, replay: boolean, attempt: object } | { ok: false, code: string, error: string, blocked: string[] }>}
 */
export async function reserveModelPickExploreAttemptForStart(input = {}) {
  const config = input.config || MODEL_PICK_EXPLORE_CONFIG_DEFAULTS;
  const marker = input.marker || {};
  const pairKey = String(marker.pairKey || '').trim().toLowerCase();
  const harness = String(marker.harness || '').trim().toLowerCase();
  const role = String(marker.role || input.context?.task?.kind || '').trim().toLowerCase();
  if (!pairKey || !harness || !role) {
    return { ok: false, code: 'validation', error: 'explore reservation needs a pair, a harness and a role', blocked: ['validation'] };
  }
  const reservation = await reserveModelPickExploreAttempt({
    pairKey,
    harness,
    model: String(marker.model || '').trim(),
    baseModel: String(marker.baseModel || '').trim(),
    role,
    workspaceKey: String(input.workspaceKey || '').trim(),
    segment: String(marker.segment || composeModelPickExploreSegment(config)).trim(),
    delegationId: String(input.delegationId || '').trim(),
    pickId: String(input.pickId || '').trim(),
    idempotencyKey: String(input.idempotencyKey || '').trim(),
    budgetUsd: Number(marker.budgetUsd) || config.maxAttemptUsd,
    maxExecutorMs: Number(marker.maxExecutorMs) || config.maxExecutorMs,
    now: input.now,
    file: input.file,
    lockTimeoutMs: input.lockTimeoutMs,
    guard: (rows, attemptNow) => {
      const ledger = summarizeModelPickExploreAttempts(rows, {
        now: attemptNow,
        windowMs: config.windowMs,
        segment: String(marker.segment || composeModelPickExploreSegment(config)).trim(),
      });
      const autoExecuted = countModelPickAutoExecuted(
        Array.isArray(input.delegations) ? input.delegations : safeLoadDelegations(),
        { now: attemptNow, windowMs: config.windowMs },
      );
      const credits = computeModelPickExploreCredits({
        autoExecuted,
        consumed: ledger.consumed,
        everyAutoExecuted: config.everyAutoExecuted,
      });
      const verdict = evaluateModelPickExploreAttempt({
        role,
        candidate: input.candidate || { harness, model: marker.model, in_band: false },
        pick: input.pick || null,
        pairKey,
        workspaceKey: input.workspaceKey,
        config,
        ledger,
        credits,
        context: input.context,
        metering: input.metering || input.context?.metering,
        now: attemptNow,
      });
      if (verdict.allowed) return { ok: true };
      return { ok: false, code: verdict.blocked[0] || 'explore_blocked', blocked: verdict.blocked };
    },
  });
  if (reservation.ok) return reservation;
  return {
    ok: false,
    code: reservation.code,
    error: reservation.error || 'explore reservation failed',
    blocked: Array.isArray(reservation.blocked) ? reservation.blocked : [reservation.code],
  };
}

/**
 * @param {string} wanted
 * @param {object[]} rows
 * @returns {boolean}
 */
function isRealExploreMode(wanted) {
  return String(wanted || '').trim().toLowerCase() === 'real';
}

/**
 * @param {{ delegationId: string, marker?: object | null, config?: ModelPickExploreConfig, mode?: string, now?: number, file?: string }} input
 * @returns {object | null} the durable attempt, or null when this start is not an explore attempt
 */
export function startModelPickExploreAttemptForDelegation(input = {}) {
  const delegationId = String(input.delegationId || '').trim();
  if (!delegationId) return null;
  if (!isRealExploreMode(input.mode ?? input.marker?.mode)) return null;
  return startModelPickExploreAttempt({ delegationId, now: input.now, file: input.file });
}

/**
 * Close the durable attempt with its outcome (and the cooldown that outcome
 * implies). A dry-run has no attempt, so this is a no-op for it.
 *
 * @param {{ delegationId: string, outcome: string, marker?: object | null, config?: ModelPickExploreConfig, mode?: string, now?: number, file?: string }} input
 * @returns {object | null}
 */
export function finishModelPickExploreAttemptForDelegation(input = {}) {
  const delegationId = String(input.delegationId || '').trim();
  const outcome = String(input.outcome || '').trim().toLowerCase();
  if (!delegationId || !MODEL_PICK_EXPLORE_OUTCOMES.includes(outcome)) return null;
  if (!isRealExploreMode(input.mode ?? input.marker?.mode)) return null;
  return finishModelPickExploreAttempt({
    delegationId,
    outcome,
    cooldownMs: modelPickExploreCooldownMs({ outcome, config: input.config }),
    now: input.now,
    file: input.file,
  });
}

/**
 * Roll back a reservation whose start was refused after it was made, so a
 * blocked start consumes nothing.
 *
 * @param {{ delegationId: string, marker?: object | null, file?: string }} input
 * @returns {boolean}
 */
export function releaseModelPickExploreAttemptForDelegation(input = {}) {
  const delegationId = String(input.delegationId || '').trim();
  if (!delegationId) return false;
  return releaseModelPickExploreAttempt({ delegationId, file: input.file });
}

/**
 * @param {{ delegationId?: string, id?: string, file?: string }} input
 * @returns {object | null}
 */
export function findModelPickExploreAttemptForDelegation(input = {}) {
  return findModelPickExploreAttempt(input);
}

/**
 * Public assessment wrapper used by {@link selectModelPick}. Returns null when
 * exploration is disabled (`mode: off`) so callers keep the pre-exploration shape.
 *
 * @param {Parameters<typeof selectModelPickExplore>[0] & { log?: (line: string) => void }} input
 * @returns {ReturnType<typeof selectModelPickExplore> & { candidate: object | null, started: boolean } | null}
 */
export function evaluateModelPickExploration(input = {}) {
  const config = input.config || MODEL_PICK_EXPLORE_CONFIG_DEFAULTS;
  if (config.mode === 'off') return null;
  const raw = selectModelPickExplore(input);
  const decision = raw.wouldExplore
    ? (config.mode === 'real' ? 'start' : 'would-explore')
    : 'blocked';
  const started = config.mode === 'real' && decision === 'start';
  const assessment = {
    ...raw,
    decision,
    candidate: raw.selected,
    started,
  };
  if (typeof input.log === 'function' && assessment.logLine) {
    input.log(assessment.logLine);
  }
  return assessment;
}

/** @type {typeof countModelPickAutoExecuted} */
export const countAutoExecutedWorkload = countModelPickAutoExecuted;

/** @type {typeof reserveModelPickExploreAttemptForStart} */
export const reserveModelPickExploreBudget = reserveModelPickExploreAttemptForStart;

/** @type {typeof modelPickExploreCooldownMs} */
export const exploreCooldownMsForOutcome = modelPickExploreCooldownMs;

/**
 * @param {ReturnType<typeof evaluateModelPickExploration>} assessment
 * @param {string} [role]
 * @returns {object | null}
 */
export function buildExploreAttemptMarker(assessment, role = '') {
  if (!assessment?.wouldExplore) return null;
  return buildModelPickExploreMarker(assessment, role || assessment.role || '');
}

export { loadModelPickExploreAttempts, normalizeModelPickExploreConfig };
