/**
 * Canonical, display-only model outcome statistics.
 *
 * One pure contract composes the existing aggregates — `summarizeDelegationOutcomes`
 * (job history) and the delegation cycle summaries (reviewed/accepted cycles and
 * cost) — into comparable cohorts. It is the single place that defines what a
 * cohort key and a denominator mean; it does **not** re-derive scoring and it
 * never calls `selectModelPick`.
 *
 * Hard constraints:
 * - no I/O: every row, cycle and usage event is injected by the caller (the
 *   route is the only loader), so the builder is deterministic and testable;
 * - a cohort below the low-sample threshold is flagged, never hidden;
 * - a missing historical field (a review protocol that was never recorded, an
 *   unpriced cost, a metric with no sample) stays explicit `null`/`unknown` and
 *   is named in `missing_fields` — it is never rendered as a measured zero;
 * - `task_type` and `effort` are not inferred: they are reported as
 *   `not_measured`, not as guessed cohort dimensions;
 * - the block is display-only: it must not feed any ranking until the metrics
 *   are independently validated (see `uncertainty.affects_ranking`).
 */

import { decodeModelValue } from './model-catalog.js';
import {
  MODEL_PICK_POLICY_VERSION,
  MODEL_PICK_REVIEW_PROTOCOL_VERSION,
  MODEL_PICK_USAGE_WINDOW_MS,
} from './model-pick-policy.js';
import { OBSERVED_WINDOW_MS, rolePriorInfra } from './model-pick-history.js';
import {
  MODEL_PICK_ROLES,
  OBSERVED_BLEND_HALF_LIFE,
} from './model-role-profiles.js';
import {
  buildDelegationQualityCycles,
  summarizeDelegationCycleCostMetrics,
} from './delegation-cycle-outcomes.js';

/**
 * Contract version of the canonical stats shape. Bump when a field changes
 * meaning or a denominator is added/removed, so a stored or cached response can
 * be told apart from a newer one.
 */
export const MODEL_STATS_CONTRACT_VERSION = 'model-stats-2026-10-09';

/**
 * Ordered parts of a cohort key, joined with {@link MODEL_STATS_COHORT_KEY_SEPARATOR}.
 * `policy_version` is the picker policy the stats were computed under;
 * `review_protocol_version` is the version recorded on the history, which is
 * `unknown` when the row/cycle predates the field.
 *
 * @type {readonly string[]}
 */
export const MODEL_STATS_COHORT_KEY_PARTS = Object.freeze([
  'role',
  'harness',
  'base_model',
  'policy_version',
  'review_protocol_version',
]);

/** Separator between the ordered {@link MODEL_STATS_COHORT_KEY_PARTS}. */
export const MODEL_STATS_COHORT_KEY_SEPARATOR = '|';

/** A cohort below this many terminal jobs is flagged as a low sample. */
export const MODEL_STATS_LOW_SAMPLE_N = 3;

/** Upper bound on the canonical cohort list carried in one response. */
export const MODEL_STATS_MAX_COHORTS = 200;

/** Placeholder a key part uses when its value was never recorded. */
export const MODEL_STATS_UNKNOWN_KEY_PART = 'unknown';

/**
 * @param {unknown} model
 * @returns {string} base model id with `::params` stripped (same as the picker)
 */
function baseModelId(model) {
  const raw = String(model || '').trim();
  if (!raw) return '';
  const decoded = decodeModelValue(raw);
  return String(decoded.modelId || raw).trim();
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function round4(value) {
  return Number.isFinite(value) ? Math.round(/** @type {number} */ (value) * 10000) / 10000 : null;
}

/**
 * Recorded review protocol version on a history row. Missing means unknown: it
 * is never replaced by the current constant.
 *
 * @param {object | undefined} row
 * @returns {string | null}
 */
function recordedReviewProtocolVersion(row) {
  const raw = row?.reviewProtocolVersion ?? row?.review_protocol_version;
  const value = String(raw || '').trim();
  return value || null;
}

/**
 * @param {{
 *   role: string,
 *   harness: string,
 *   baseModel: string,
 *   policyVersion: string,
 *   reviewProtocolVersion: string | null,
 * }} parts
 * @returns {string}
 */
export function buildModelStatsCohortKey(parts) {
  const values = [
    parts.role,
    parts.harness,
    parts.baseModel,
    parts.policyVersion,
    parts.reviewProtocolVersion,
  ];
  return values
    .map((value) => {
      const text = String(value == null ? '' : value).trim();
      return text || MODEL_STATS_UNKNOWN_KEY_PART;
    })
    .join(MODEL_STATS_COHORT_KEY_SEPARATOR);
}

/**
 * Sample count for a latency metric. When the aggregate predates the explicit
 * count but a median is present, the count is unknown (`null`) rather than 0;
 * a median of `null` with no count means no sample (`0`).
 *
 * @param {unknown} count
 * @param {unknown} median
 * @returns {number | null}
 */
function sampleCount(count, median) {
  const value = Number(count);
  if (Number.isFinite(value) && value >= 0) return value;
  return median == null ? 0 : null;
}

/**
 * Job history denominators for one (role, harness, base model) cohort. Returns
 * `null` when the cohort has no aggregate row at all, so "no terminal jobs
 * recorded" is never confused with an absent source.
 *
 * @param {object | null | undefined} row
 * @returns {object | null}
 */
function jobsBlock(row) {
  if (!row || typeof row !== 'object') return null;
  const n = Number(row.n) || 0;
  const infraFails = Number(row.infra_fails) || 0;
  return {
    terminal_jobs: n,
    non_infra_jobs: Math.max(0, n - infraFails),
    infra_fails: infraFails,
    infra_fail_rate: row.infra_fail_rate ?? null,
    decided: Number(row.decided) || 0,
    pass_rate: row.pass_rate ?? null,
    quality: row.quality ?? null,
    verdict_fail_rate: row.verdict_fail_rate ?? null,
    useful_rate: row.useful_rate ?? null,
  };
}

/**
 * Per-metric latency denominators with their own sample counts.
 *
 * @param {object | null | undefined} row
 * @returns {object}
 */
function latencyBlock(row) {
  const source = row && typeof row === 'object' ? row : {};
  return {
    duration: {
      sample_n: sampleCount(source.duration_n, source.median_min),
      median_min: source.median_min ?? null,
      p95_min: source.p95_min ?? null,
    },
    tokens_per_sec: {
      sample_n: sampleCount(source.tokens_per_sec_n, source.median_tokens_per_sec),
      median: source.median_tokens_per_sec ?? null,
    },
    tool_calls: {
      sample_n: sampleCount(source.tool_calls_n, source.median_tool_calls),
      median: source.median_tool_calls ?? null,
    },
    files_changed: {
      sample_n: sampleCount(source.files_changed_n, source.median_files_changed),
      median: source.median_files_changed ?? null,
    },
  };
}

/**
 * Reviewed/accepted cycle denominators. `reviewed` is derived as
 * `closed - unreviewed` (an unreviewed cycle is one with no review job at all);
 * it is arithmetic over the existing summary, not a second classification.
 *
 * @param {object | null | undefined} metrics
 * @returns {object | null}
 */
function cyclesBlock(metrics) {
  if (!metrics || typeof metrics !== 'object') return null;
  const closed = Number(metrics.closedCycleCount) || 0;
  const unreviewed = Number(metrics.unreviewedCount) || 0;
  const reviewed = Math.max(0, closed - unreviewed);
  const accepted = Number(metrics.acceptedCount) || 0;
  return {
    closed_cycles: closed,
    reviewed_cycles: reviewed,
    accepted_by_review: accepted,
    accepted_rate: reviewed > 0 ? round4(accepted / reviewed) : null,
    manual_accepted: Number(metrics.manualAcceptedCount) || 0,
    rejected_by_review: Number(metrics.rejectedCount) || 0,
    undecided: Number(metrics.undecidedCount) || 0,
    unreviewed,
    open_cycles: Number(metrics.openCycleCount) || 0,
  };
}

/**
 * Cost measurement denominators. `known` is false whenever no priced event
 * exists in the window (subscription, unmetered or no events), so `usd` stays
 * `null` and is never shown as 0.
 *
 * @param {object | null | undefined} metrics
 * @returns {object}
 */
function costBlock(metrics) {
  const source = metrics && typeof metrics === 'object' ? metrics : {};
  const denominators = source.denominators && typeof source.denominators === 'object'
    ? source.denominators
    : {};
  const pricedEvents = Number(denominators.pricedEvents ?? source.pricedEvents) || 0;
  const totalEvents = Number(denominators.totalEvents ?? source.totalEvents) || 0;
  const unknownEvents = Number(denominators.unknownUsageEvents ?? source.unknownUsageEventCount) || 0;
  const subscriptionEvents = Number(denominators.subscriptionUsageEvents ?? source.subscriptionUsageEventCount) || 0;
  const known = pricedEvents > 0 && source.totalCostUsd != null;
  return {
    known,
    usd: known ? source.totalCostUsd : null,
    partial_usd: Number.isFinite(Number(source.partialCostUsd)) ? Number(source.partialCostUsd) : null,
    effective_cost_per_accepted_usd: known ? (source.effectiveCostPerAcceptedUsd ?? null) : null,
    priced_events: pricedEvents,
    total_events: totalEvents,
    unknown_events: unknownEvents,
    subscription_events: subscriptionEvents,
    priced_cycles: Number(source.pricedCycleCount) || 0,
    priced_cycle_share: source.pricedCycleShare ?? null,
    priced_event_share: source.pricedEventShare ?? null,
    window_ms: source.usageWindowMs ?? null,
    truncated: source.usageRangeTruncated === true,
    note: known
      ? ''
      : 'cost unknown: no priced usage event in the window (subscription or unmetered)',
  };
}

/**
 * Uncertainty/shrinkage inputs for a cohort. Exposes the existing blend weight
 * (`w = n / (n + halfLife)`) transparently, but marks it display-only: this
 * block must not be wired into ranking in this task.
 *
 * @param {{ n: number, decided: number, role: string, priorInfra: number, lowSampleN: number }} input
 * @returns {object}
 */
function uncertaintyBlock(input) {
  const { n, decided, role, priorInfra, lowSampleN } = input;
  const lowSample = n < lowSampleN || decided === 0;
  const weight = n > 0 ? n / (n + OBSERVED_BLEND_HALF_LIFE) : 0;
  return {
    n,
    low_sample: lowSample,
    low_sample_n: lowSampleN,
    prior: {
      infra_fail_rate: round4(Math.max(0, Math.min(1, Number(priorInfra) || 0))),
      role,
    },
    shrink: {
      weight: round4(weight),
      half_life: OBSERVED_BLEND_HALF_LIFE,
      formula: 'w = n / (n + half_life)',
      source: 'lib/model-role-profiles.js OBSERVED_BLEND_HALF_LIFE',
    },
    display_only: true,
    affects_ranking: false,
    note: lowSample
      ? 'fewer than the low-sample threshold of terminal jobs or no decided cycle'
      : '',
  };
}

/**
 * Named missing historical fields for one cohort. Nothing here is guessed.
 *
 * @param {{ versions: object, jobs: object | null, cycles: object | null, latency: object, cost: object, role: string }} input
 * @returns {string[]}
 */
function missingFieldsFor(input) {
  const { versions, jobs, cycles, latency, cost, role } = input;
  const missing = [];
  if (versions.review_protocol_version == null) missing.push('review_protocol_version');
  if (!jobs) missing.push('jobs');
  if (latency.duration.sample_n == null) missing.push('latency.duration.sample_n');
  if (latency.tokens_per_sec.sample_n == null) missing.push('latency.tokens_per_sec.sample_n');
  const churnApplies = role === 'implement' || role === 'fix';
  if (churnApplies && latency.tool_calls.sample_n == null) missing.push('latency.tool_calls.sample_n');
  if (churnApplies && latency.files_changed.sample_n == null) missing.push('latency.files_changed.sample_n');
  if (!cost?.known) missing.push('cost.usd');
  if (!cycles) missing.push('cycles');
  return missing;
}

/**
 * Index the injected delegation rows by id to attribute a cycle to the
 * implementer's (harness, base model) cohort.
 *
 * @param {object[]} rows
 * @returns {Map<string, { harness: string, base_model: string }>}
 */
function indexImplementers(rows) {
  const byId = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = String(row?.id || '').trim();
    if (!id) continue;
    const executor = row?.executor && typeof row.executor === 'object' ? row.executor : {};
    byId.set(id, {
      harness: String(executor.transport || '').trim().toLowerCase(),
      base_model: baseModelId(executor.model),
    });
  }
  return byId;
}

/**
 * Group the enriched cycles by their implementer's cohort. Only implement/fix
 * cycles carry a cohort role; the aggregate role is always `implement` because
 * `fix` shares the persisted implement assignment.
 *
 * @param {object[]} cycles
 * @param {Map<string, { harness: string, base_model: string }>} implementers
 * @returns {Map<string, object[]>}
 */
function groupCyclesByCohort(cycles, implementers) {
  const groups = new Map();
  for (const cycle of Array.isArray(cycles) ? cycles : []) {
    const info = implementers.get(String(cycle?.implementId || ''));
    if (!info || !info.harness || !info.base_model) continue;
    const key = `${info.harness}/${info.base_model}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(cycle);
    else groups.set(key, [cycle]);
  }
  return groups;
}

/**
 * Normalize the injected usage events for the per-cohort cost join. The builder
 * stays pure: the default is an empty ledger, never a disk read.
 *
 * @param {unknown} usageEvents
 * @returns {object[]}
 */
function normalizeUsageEvents(usageEvents) {
  return Array.isArray(usageEvents) ? usageEvents : [];
}

/**
 * Build the canonical, display-only stats contract.
 *
 * @param {{
 *   role?: string,
 *   now?: number,
 *   outcomes?: object,
 *   delegations?: object[],
 *   usageEvents?: object[],
 *   priorInfra?: number,
 *   lowSampleN?: number,
 *   policyVersion?: string,
 *   reviewProtocolVersion?: string | null,
 *   windowMs?: number,
 * }} [input]
 * @returns {object}
 */
export function buildCanonicalModelStats(input = {}) {
  const role = String(input.role || '').trim().toLowerCase();
  // `fix` shares the persisted `implement` assignment, exactly like
  // `buildModelPickHistory` and `lib/model-diagnostics.js`.
  const aggregateRole = role === 'fix' ? 'implement' : role;
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const outcomes = input.outcomes && typeof input.outcomes === 'object' ? input.outcomes : null;
  const usageEvents = normalizeUsageEvents(input.usageEvents);
  const lowSampleN = Number.isFinite(Number(input.lowSampleN))
    ? Number(input.lowSampleN)
    : MODEL_STATS_LOW_SAMPLE_N;
  const policyVersion = String(input.policyVersion || MODEL_PICK_POLICY_VERSION).trim()
    || MODEL_PICK_POLICY_VERSION;
  const currentReviewProtocolVersion = String(
    input.reviewProtocolVersion ?? MODEL_PICK_REVIEW_PROTOCOL_VERSION,
  ).trim() || MODEL_PICK_REVIEW_PROTOCOL_VERSION;
  const observedWindowMs = Number.isFinite(Number(input.windowMs)) && Number(input.windowMs) > 0
    ? Number(input.windowMs)
    : Math.max(OBSERVED_WINDOW_MS, MODEL_PICK_USAGE_WINDOW_MS);
  const window = Object.freeze({
    window_ms: observedWindowMs,
    from: new Date(now - observedWindowMs).toISOString(),
    to: new Date(now).toISOString(),
    observed_window_ms: OBSERVED_WINDOW_MS,
    usage_window_ms: MODEL_PICK_USAGE_WINDOW_MS,
  });

  const allCycles = buildDelegationQualityCycles({
    rows: Array.isArray(input.delegations) ? input.delegations : [],
    includeOpen: true,
  });
  const implementers = indexImplementers(input.delegations);
  const cycleGroups = groupCyclesByCohort(allCycles, implementers);
  const readInjectedUsageEvents = () => usageEvents;
  const totalsMetrics = summarizeDelegationCycleCostMetrics(allCycles, {
    now,
    readUsageEvents: readInjectedUsageEvents,
  });

  const priorInfraDefault = aggregateRole && outcomes?.roles?.[aggregateRole]
    ? rolePriorInfra(outcomes.roles[aggregateRole])
    : 0;
  const priorInfra = Number.isFinite(Number(input.priorInfra))
    ? Number(input.priorInfra)
    : priorInfraDefault;

  // (a) JOBS — per-role denominators from the existing outcome aggregate.
  /** @type {Record<string, object>} */
  const byRole = {};
  for (const statRole of MODEL_PICK_ROLES) {
    const sharesImplement = statRole === 'fix';
    const sourceRole = sharesImplement ? 'implement' : statRole;
    const source = outcomes?.roles?.[sourceRole];
    const rowsForRole = source && typeof source === 'object' ? Object.values(source) : [];
    byRole[statRole] = {
      jobs: rowsForRole.length > 0 ? aggregateJobs(rowsForRole) : null,
      latency: aggregateLatency(rowsForRole),
      shares_implement_aggregate: sharesImplement,
    };
  }

  // Cohorts for the requested role only: the endpoint and the picker are
  // role-scoped, so a fix request reads the implement aggregate instead of
  // duplicating every model under two keys.
  /** @type {object[]} */
  const cohorts = [];
  if (aggregateRole) {
    const outcomeRows = Object.values(
      outcomes?.roles?.[aggregateRole] && typeof outcomes.roles[aggregateRole] === 'object'
        ? outcomes.roles[aggregateRole]
        : {},
    ).filter((row) => row && typeof row === 'object');
    const seen = new Set();
    for (const row of outcomeRows) {
      const harness = String(row.harness || '').trim().toLowerCase();
      const baseModel = String(row.model || '').trim();
      if (!harness || !baseModel) continue;
      const key = `${harness}/${baseModel}`;
      seen.add(key);
      cohorts.push(buildCohort({
        role,
        aggregateRole,
        harness,
        baseModel,
        row,
        cycleMetrics: cycleGroupMetrics(cycleGroups.get(key), { now, usageEvents }),
        priorInfra,
        lowSampleN,
        window,
        policyVersion,
      }));
    }
    // An open cycle can exist for a model with no terminal job yet: it still
    // has a cycle denominator even though the job row is absent.
    for (const [key, group] of cycleGroups) {
      if (seen.has(key)) continue;
      const [harness, baseModel] = key.split('/');
      cohorts.push(buildCohort({
        role,
        aggregateRole,
        harness,
        baseModel,
        row: null,
        cycleMetrics: cycleGroupMetrics(group, { now, usageEvents }),
        priorInfra,
        lowSampleN,
        window,
        policyVersion,
      }));
    }
  }
  cohorts.sort((left, right) => {
    const byJobs = (right.jobs?.terminal_jobs || 0) - (left.jobs?.terminal_jobs || 0);
    return byJobs || left.cohort_key.localeCompare(right.cohort_key);
  });
  const cohortsTotal = cohorts.length;
  // Keep the response bounded: the most active cohorts come first, and the
  // caller can see that the list was capped.
  const boundedCohorts = cohorts.slice(0, MODEL_STATS_MAX_COHORTS);
  const missingFields = [...new Set(boundedCohorts.flatMap((cohort) => cohort.missing_fields))];

  return {
    contract_version: MODEL_STATS_CONTRACT_VERSION,
    generated_at: new Date(now).toISOString(),
    role: role || null,
    aggregate_role: aggregateRole || null,
    display_only: true,
    affects_ranking: false,
    cohort_key_parts: [...MODEL_STATS_COHORT_KEY_PARTS],
    cohort_key_separator: MODEL_STATS_COHORT_KEY_SEPARATOR,
    versions: {
      policy_version: policyVersion,
      // The current protocol the field is defined under. A cohort carries its
      // own recorded value (usually `null`); this top-level value never
      // back-fills that history.
      review_protocol_version: currentReviewProtocolVersion,
    },
    window,
    by_role: byRole,
    totals: {
      // (b) REVIEWED/ACCEPTED CYCLES and (c) COST over the whole injected cycle
      // set, not just the cohorts with a terminal job row.
      cycles: cyclesBlock(totalsMetrics),
      cost: costBlock(totalsMetrics),
    },
    cohorts: boundedCohorts,
    cohorts_total: cohortsTotal,
    cohorts_truncated: cohortsTotal > boundedCohorts.length,
    uncertainty: {
      ...uncertaintyBlock({
        n: cohorts.reduce((sum, cohort) => sum + (cohort.jobs?.terminal_jobs || 0), 0),
        decided: cohorts.reduce((sum, cohort) => sum + (cohort.jobs?.decided || 0), 0),
        role: aggregateRole || '',
        priorInfra,
        lowSampleN,
      }),
      // An aggregate note cannot speak for one cohort; point at the rows.
      note: 'per-cohort uncertainty is on each cohort row; this aggregate is not a ranking input',
    },
    // (d) LATENCY is in `by_role[].latency` and on each cohort row, each with
    // its own sample count.
    unknowns: {
      not_measured: ['task_type', 'effort'],
      task_type: { known: false, values: [], note: 'not persisted on delegation records; never inferred' },
      effort: { known: false, values: [], note: 'params are stripped from base_model; not a cohort dimension here' },
      note: 'task type and effort are not inferred as cohorts in this contract',
    },
    missing_fields: missingFields,
  };
}

/**
 * Combine several aggregate rows of one role into a single jobs block. Rates
 * that cannot be summed (pass_rate, quality) stay `null` on the aggregate and
 * remain readable on the cohort rows.
 *
 * @param {object[]} rows
 * @returns {object | null}
 */
function aggregateJobs(rows) {
  if (rows.length === 0) return null;
  const terminal = rows.reduce((sum, row) => sum + (Number(row.n) || 0), 0);
  const infraFails = rows.reduce((sum, row) => sum + (Number(row.infra_fails) || 0), 0);
  const decided = rows.reduce((sum, row) => sum + (Number(row.decided) || 0), 0);
  return {
    terminal_jobs: terminal,
    non_infra_jobs: Math.max(0, terminal - infraFails),
    infra_fails: infraFails,
    infra_fail_rate: terminal > 0 ? round4(infraFails / terminal) : null,
    decided,
    pass_rate: null,
    quality: null,
    verdict_fail_rate: null,
    useful_rate: null,
    note: 'pass_rate/quality are not summable; see per-cohort rows',
  };
}

/**
 * Combine several aggregate rows of one role into latency sample counts. A
 * median cannot be averaged, so the aggregate keeps only the sample counts.
 *
 * @param {object[]} rows
 * @returns {object}
 */
function aggregateLatency(rows) {
  const sum = (pick) => rows.reduce((total, row) => {
    const value = pick(row);
    return total + (Number.isFinite(Number(value)) ? Number(value) : 0);
  }, 0);
  return {
    duration: { sample_n: sum((row) => row.duration_n), median_min: null, p95_min: null },
    tokens_per_sec: { sample_n: sum((row) => row.tokens_per_sec_n), median: null },
    tool_calls: { sample_n: sum((row) => row.tool_calls_n), median: null },
    files_changed: { sample_n: sum((row) => row.files_changed_n), median: null },
    note: 'aggregate medians are not recomputed; see per-cohort rows',
  };
}

/**
 * @param {object[] | undefined} cycles
 * @param {{ now: number, usageEvents: object[] }} context
 * @returns {object | null}
 */
function cycleGroupMetrics(cycles, context) {
  if (!Array.isArray(cycles) || cycles.length === 0) return null;
  return summarizeDelegationCycleCostMetrics(cycles, {
    now: context.now,
    readUsageEvents: () => context.usageEvents,
  });
}

/**
 * One canonical cohort row.
 *
 * @param {{
 *   role: string,
 *   aggregateRole: string,
 *   harness: string,
 *   baseModel: string,
 *   row: object | null,
 *   cycleMetrics: object | null,
 *   priorInfra: number,
 *   lowSampleN: number,
 *   window: object,
 *   policyVersion: string,
 * }} input
 * @returns {object}
 */
function buildCohort(input) {
  const jobs = jobsBlock(input.row);
  const latency = latencyBlock(input.row);
  const cycles = cyclesBlock(input.cycleMetrics);
  const cost = costBlock(input.cycleMetrics);
  const recordedProtocol = recordedReviewProtocolVersion(input.row);
  const versions = {
    policy_version: input.policyVersion,
    review_protocol_version: recordedProtocol,
  };
  const n = jobs ? jobs.terminal_jobs : 0;
  const decided = jobs ? jobs.decided : 0;
  const missingFields = missingFieldsFor({
    versions,
    jobs,
    cycles,
    latency,
    cost,
    role: input.aggregateRole,
  });
  return {
    cohort_key: buildModelStatsCohortKey({
      role: input.role,
      harness: input.harness,
      baseModel: input.baseModel,
      policyVersion: input.policyVersion,
      reviewProtocolVersion: recordedProtocol,
    }),
    role: input.role,
    aggregate_role: input.aggregateRole,
    shares_implement_aggregate: input.role === 'fix',
    harness: input.harness,
    base_model: input.baseModel,
    versions,
    window: input.window,
    jobs,
    // Cycles/cost only exist for implement/fix cohorts; a plan/review cohort
    // reports `null` (unknown) rather than a fabricated zero.
    cycles,
    cost,
    latency,
    uncertainty: uncertaintyBlock({
      n,
      decided,
      role: input.aggregateRole,
      priorInfra: input.priorInfra,
      lowSampleN: input.lowSampleN,
    }),
    missing_fields: missingFields,
    // Contract metadata repeated per row so a stored row is self-describing.
    contract_version: MODEL_STATS_CONTRACT_VERSION,
  };
}

// Re-exported so callers can assert the current protocol without a second
// import path; the canonical builder never back-fills it into history.
export { MODEL_PICK_REVIEW_PROTOCOL_VERSION };
