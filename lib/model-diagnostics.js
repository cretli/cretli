/**
 * Read-only model-pick diagnostics.
 *
 * One pure computation, next to the selector, reproduces the picker for the
 * exact inputs it was given: the chosen model and the candidate order come from
 * `selectModelPick` itself, never from a second scoring formula in a route or
 * in the UI. The route only loads inputs (catalog, favorites, history,
 * aggregates, config) and calls {@link buildModelDiagnostics}; the UI renders
 * the response.
 *
 * Hard constraints baked into this module:
 * - no I/O, no persistence, no network — every input is injected;
 * - eligibility and ranking reuse the picker's own output (`candidates`,
 *   `diagnosis.rows`) and the existing pure helpers, so a diagnostics row can
 *   never disagree with what the picker would do;
 * - history that does not exist is reported as an explicit `unknown`, not as a
 *   guessed zero;
 * - cost is taken from the usage ledger when it exists; an unpriced or
 *   subscription cohort is `known: false`, never `usd: 0`.
 */

import { decodeModelValue } from './model-catalog.js';
import {
  DEFAULT_MODEL_ROLE_PROFILES,
  MODEL_PICK_ROLES,
  buildModelPickEligibilityCohort,
  describeModelRoleMatchers,
  describeRoleRejection,
  hasActiveLockout,
  isHighInfraRiskObserved,
  selectModelPick,
} from './model-role-profiles.js';
import {
  MODEL_STATS_LOW_SAMPLE_N,
  buildCanonicalModelStats,
} from './model-stats.js';

/** @typedef {import('./model-role-profiles.js').ModelPickRole} ModelDiagnosticsRole */

/**
 * Cost of one harness/model from the usage ledger; `known: false` is never
 * rendered as 0.
 *
 * @typedef {{
 *   known: boolean,
 *   usd: number | null,
 *   estimatedUsd: number | null,
 *   unpricedEvents: number,
 *   events: number,
 *   runs: number,
 *   scope: string,
 *   note: string,
 * }} ModelDiagnosticsCost
 */

/** @typedef {{ events?: number, unpricedEvents?: number, usd?: number, estimatedUsd?: number, runs?: number }} ModelDiagnosticsUsageBucket */

/**
 * @typedef {{
 *   runs?: number,
 *   byHarness?: Record<string, ModelDiagnosticsUsageBucket>,
 *   byModel?: Record<string, ModelDiagnosticsUsageBucket>,
 * }} ModelDiagnosticsUsageSummary
 */

/**
 * One aggregate outcome row (see `ModelPickHistoryOutcome`), optionally with a
 * joined cost.
 *
 * @typedef {Partial<import('./model-pick-history.js').ModelPickHistoryOutcome> & {
 *   cost?: ModelDiagnosticsCost | null,
 * }} ModelDiagnosticsStatsRow
 */

/**
 * @typedef {{
 *   lowSampleN?: number,
 *   priorInfra?: number,
 *   now?: number,
 *   windowMs?: number,
 *   minJobs?: number,
 * }} ModelDiagnosticsCohortOptions
 */

/**
 * @typedef {{
 *   harness: string | undefined,
 *   model: string | undefined,
 *   role: string | undefined,
 *   quality: { pass_rate: number | null, quality: number | null, decided: number },
 *   reliability: { infra_fail_rate: number | null, infra_fails: number, n: number, high_infra_risk: boolean },
 *   sample: {
 *     n: number,
 *     decided: number,
 *     window_ms: number | null,
 *     min_jobs: number | null,
 *     last_used_at: string | null,
 *     age_ms: number | null,
 *     low_sample: boolean,
 *   },
 *   cost: ModelDiagnosticsCost | null,
 *   rating: { avg: number | null, n: number, avg_scored: number | null, n_scored: number },
 *   times: {
 *     median_min: number | null,
 *     p95_min: number | null,
 *     median_tokens_per_sec: number | null,
 *     median_tool_calls: number | null,
 *     median_files_changed: number | null,
 *   },
 *   uncertainty: { low_sample: boolean, note: string, prior_infra: number },
 * }} ModelDiagnosticsCohortStats
 */

/** Candidate copied into the response (fields from `CANDIDATE_FIELDS` plus the explanation). */
/** @typedef {Record<string, unknown>} ModelDiagnosticsCandidate */

/**
 * The picker's own explanation row for one favorite.
 *
 * @typedef {{
 *   harness?: string,
 *   model?: string,
 *   eligible?: boolean,
 *   selected?: boolean,
 *   filter_reasons?: string[],
 *   penalties?: unknown[],
 *   ranking_note?: string | null,
 * }} ModelDiagnosticsDiagnosisRow
 */

/**
 * Subset of the `selectModelPick` result read here (it also carries the
 * diagnosis block and policy version on both success and failure).
 *
 * @typedef {{
 *   ok: boolean,
 *   code?: string,
 *   error?: string,
 *   policyVersion?: string,
 *   pick?: ModelDiagnosticsCandidate | null,
 *   picks?: ModelDiagnosticsCandidate[],
 *   candidates?: ModelDiagnosticsCandidate[],
 *   rotation?: unknown,
 *   exploration?: unknown,
 *   diagnosis?: { rows?: ModelDiagnosticsDiagnosisRow[] } | null,
 * }} ModelDiagnosticsSelection
 */

/** @typedef {import('./model-role-profiles.js').ModelPickHarnessRow & { available?: boolean, label?: string }} ModelDiagnosticsHarness */

/**
 * @typedef {import('./model-role-profiles.js').ModelPickModelRow & {
 *   enabled?: boolean,
 *   usage_limited?: boolean,
 *   usage_limit?: Record<string, unknown> | null,
 * }} ModelDiagnosticsModelRow
 */

/** @typedef {{ items?: ModelDiagnosticsModelRow[], favorites_configured?: boolean }} ModelDiagnosticsHarnessModels */

/**
 * @typedef {{
 *   eligible: boolean,
 *   reasons: string[],
 *   penalties: unknown[],
 *   ranking_note: string | null,
 *   selected: boolean,
 *   source: string,
 * }} ModelDiagnosticsEligibility
 */

/** @typedef {{ lastSuccessAt?: string, lastAttemptAt?: string, stale?: boolean }} ModelDiagnosticsHarnessMeta */

/**
 * @typedef {{
 *   lockouts?: import('./model-pick-gate-primitives.js').ModelPickLockoutRow[],
 *   prior?: { infra_fail_rate?: number },
 * }} ModelDiagnosticsHistory
 */

/**
 * @typedef {{
 *   id?: string,
 *   policyVersion?: string,
 *   role?: string,
 *   createdAt?: string,
 *   candidates?: unknown[],
 *   picks?: unknown[],
 * }} ModelDiagnosticsProposal
 */

/**
 * One model row of the report.
 *
 * @typedef {{
 *   harness: string,
 *   model: string,
 *   base_model: string,
 *   label: string,
 *   favorite: boolean,
 *   enabled: boolean,
 *   harness_state: { enabled: boolean, ready: boolean, available: boolean, can_delegate: boolean, label: string },
 *   roles: string[],
 *   role_matchers: ReturnType<typeof describeModelRoleMatchers>,
 *   excluded: boolean,
 *   eligibility: ModelDiagnosticsEligibility,
 *   availability: {
 *     available: boolean,
 *     usage_limited: boolean,
 *     usage_limit: Record<string, unknown> | null,
 *     locked_out: boolean,
 *     last_known_at: string | null,
 *     last_known_source: string,
 *     stale: boolean,
 *   },
 *   last_use: { at: string | null, source: string | null, unknown: boolean, age_ms: number | null },
 *   cost: ModelDiagnosticsCost,
 *   stats: { by_role: Record<string, (ModelDiagnosticsCohortStats & { shares_implement_aggregate: boolean }) | null> },
 * }} ModelDiagnosticsModel
 */

/**
 * @typedef {{
 *   ok: false,
 *   code: string,
 *   error: string,
 *   roles: string[],
 * } | {
 *   ok: true,
 *   generated_at: string,
 *   role: string,
 *   roles: string[],
 *   eligibility_cohort: string,
 *   policy_version: string | null,
 *   config: unknown,
 *   selection: {
 *     ok: boolean,
 *     code: string | null,
 *     error: string | null,
 *     pick: ModelDiagnosticsCandidate | null,
 *     picks: ModelDiagnosticsCandidate[],
 *     candidates: ModelDiagnosticsCandidate[],
 *     rotation: unknown,
 *     exploration: unknown,
 *     favorite_diagnosis: unknown,
 *     note: string,
 *   },
 *   models: ModelDiagnosticsModel[],
 *   stats: {
 *     window_ms: number | null,
 *     generated_at: string | null,
 *     min_jobs: number | null,
 *     low_sample_n: number,
 *     cohorts: Array<ModelDiagnosticsCohortStats & { cost: ModelDiagnosticsCost }>,
 *     cost: {
 *       window: { runs: number } | null,
 *       range: unknown,
 *       by_harness: Record<string, ModelDiagnosticsUsageBucket> | null,
 *       by_model: Record<string, ModelDiagnosticsUsageBucket> | null,
 *     },
 *     canonical: import('./model-stats.js').ModelStatsResult,
 *     usage_link: { settings_tab: string, group_by: string },
 *   },
 *   persisted: {
 *     pick_id: string | undefined,
 *     policy_version: string | null,
 *     role: string | null,
 *     created_at: string | null,
 *     candidates: unknown[],
 *     picks: unknown[],
 *   } | null,
 *   unknowns: string[],
 * }} ModelDiagnosticsResult
 */

/**
 * A cohort below this many terminal jobs is flagged as a low sample. The
 * canonical stats module owns the value; it is re-exported here so existing
 * diagnostics callers keep their import.
 */
export const DIAGNOSTICS_LOW_SAMPLE_N = MODEL_STATS_LOW_SAMPLE_N;

/** Fields copied from a picker candidate into the response (bounded payload). */
const CANDIDATE_FIELDS = Object.freeze([
  'harness',
  'model',
  'label',
  'provider',
  'cost_tier',
  'quality_tier',
  'speed_tier',
  'priority',
  'score',
  'heuristic_score',
  'rotation_score',
  'weights',
  'in_band',
  'cold_start',
  'plan_limit_penalty',
  'chat_uses',
  'role_uses_7d',
  'model_uses_7d',
  'last_used_at',
  'keep_winner',
  'reason',
  'prior_infra',
  'traits',
  'observed',
  'observed_applied',
  'observed_penalty',
  'observed_changed',
  'rating_applied',
  'high_infra_risk',
  'explore_out_of_band',
  // Explanation fields copied from the picker's own diagnosis row: a filter
  // reason (why a model is out) is always shown separately from a score
  // penalty or an out-of-band position.
  'filter_reasons',
  'penalties',
  'ranking_note',
  'eligible',
]);

/**
 * @param {unknown} model
 * @returns {string} base model id without the `::params`
 */
function baseModelId(model) {
  const raw = String(model || '').trim();
  if (!raw) return '';
  const decoded = decodeModelValue(raw);
  return String(decoded.modelId || raw).trim();
}

/**
 * @param {unknown} harness
 * @param {unknown} model
 * @returns {string}
 */
function pairKey(harness, model) {
  return `${String(harness || '').trim().toLowerCase()}/${String(model || '').trim()}`;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function iso(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

/**
 * Index the existing delegation aggregate by (role, harness, base model) and
 * collect the newest terminal timestamp per (harness, base model).
 *
 * @param {ReturnType<import('./model-pick-history.js').summarizeDelegationOutcomes> | undefined} outcomes
 * @returns {{ byCohort: Map<string, Record<string, any>>, lastUse: Map<string, string> }}
 */
function indexOutcomes(outcomes) {
  /** @type {Map<string, Record<string, any>>} */
  const byCohort = new Map();
  /** @type {Map<string, string>} */
  const lastUse = new Map();
  for (const row of Array.isArray(outcomes?.list) ? outcomes.list : []) {
    const harness = String(row?.harness || '').trim().toLowerCase();
    const model = String(row?.model || '').trim();
    const role = String(row?.role || '').trim().toLowerCase();
    if (!harness || !model || !role) continue;
    const base = baseModelId(model);
    byCohort.set(`${role}:${pairKey(harness, model)}`, row);
    if (base && base !== model) byCohort.set(`${role}:${pairKey(harness, base)}`, row);
    const at = iso(row?.last_used_at);
    if (!at) continue;
    for (const key of [pairKey(harness, model), pairKey(harness, base)]) {
      const prev = lastUse.get(key);
      if (!prev || at > prev) lastUse.set(key, at);
    }
  }
  return { byCohort, lastUse };
}

/**
 * Cost is a ledger read, not a guess. `known: false` covers "no priced event in
 * the window" (for example a subscription harness) and is never rendered as 0.
 *
 * @param {Record<string, any> | undefined} usageSummary
 * @param {string} harness
 * @param {string} model
 * @returns {Record<string, any>}
 */
function costFor(usageSummary, harness, model) {
  const byHarness = usageSummary?.byHarness?.[harness] || null;
  const byModel = usageSummary?.byModel && typeof usageSummary.byModel === 'object'
    ? usageSummary.byModel
    : {};
  const exact = byModel[String(model || '').trim()] || byModel[baseModelId(model)] || null;
  const source = exact || byHarness;
  if (!source) {
    return {
      known: false,
      usd: null,
      estimatedUsd: null,
      unpricedEvents: 0,
      events: 0,
      runs: 0,
      scope: 'unknown',
      note: 'no usage events in the selected window',
    };
  }
  const events = Number(source.events) || 0;
  const unpricedEvents = Number(source.unpricedEvents) || 0;
  const known = events > 0 && unpricedEvents < events;
  return {
    known,
    usd: known ? Number(source.usd) || 0 : null,
    estimatedUsd: known ? Number(source.estimatedUsd) || 0 : null,
    unpricedEvents,
    events,
    runs: Number(source.runs) || 0,
    scope: exact ? 'model' : 'harness',
    note: known ? '' : 'cost unknown: no priced event in the selected window (subscription or unmetered)',
  };
}

/**
 * Split one existing aggregate row into quality, reliability and sample
 * uncertainty, keeping missing denominators explicit.
 *
 * @param {Record<string, any>} row
 * @param {{ lowSampleN?: number, priorInfra?: number }} [options]
 * @returns {Record<string, any>}
 */
function cohortStats(row, options = {}) {
  const lowSampleN = Number.isFinite(Number(options.lowSampleN))
    ? Number(options.lowSampleN)
    : DIAGNOSTICS_LOW_SAMPLE_N;
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const n = Number(row.n) || 0;
  const decided = Number(row.decided) || 0;
  const lastUsedAt = iso(row.last_used_at);
  const lowSample = n < lowSampleN || decided === 0;
  return {
    harness: row.harness,
    model: row.model,
    role: row.role,
    // Quality and reliability stay separate: a model can be useful yet flaky.
    quality: {
      pass_rate: row.pass_rate ?? null,
      quality: row.quality ?? null,
      decided,
    },
    reliability: {
      infra_fail_rate: row.infra_fail_rate ?? null,
      infra_fails: Number(row.infra_fails) || 0,
      n,
      high_infra_risk: isHighInfraRiskObserved({
        n,
        infra_fail_rate: row.infra_fail_rate,
      }),
    },
    sample: {
      n,
      decided,
      window_ms: Number(options.windowMs) || null,
      min_jobs: Number(options.minJobs) || null,
      last_used_at: lastUsedAt || null,
      age_ms: lastUsedAt ? Math.max(0, now - Date.parse(lastUsedAt)) : null,
      low_sample: lowSample,
    },
    cost: row.cost || null,
    rating: {
      avg: row.rating_avg ?? null,
      n: Number(row.rating_n) || 0,
      avg_scored: row.rating_avg_scored ?? null,
      n_scored: Number(row.rating_n_scored) || 0,
    },
    times: {
      median_min: row.median_min ?? null,
      p95_min: row.p95_min ?? null,
      median_tokens_per_sec: row.median_tokens_per_sec ?? null,
      median_tool_calls: row.median_tool_calls ?? null,
      median_files_changed: row.median_files_changed ?? null,
    },
    uncertainty: {
      low_sample: lowSample,
      note: lowSample ? 'fewer than the low-sample threshold of terminal jobs or no decided cycle' : '',
      prior_infra: Number(options.priorInfra) || 0,
    },
  };
}

/**
 * @param {Record<string, any>} candidate
 * @returns {Record<string, any>}
 */
function copyCandidate(candidate) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const field of CANDIDATE_FIELDS) {
    if (candidate && Object.prototype.hasOwnProperty.call(candidate, field)) {
      out[field] = candidate[field];
    }
  }
  return out;
}

/**
 * Attach the picker's own explanation row (hard filter reasons, score
 * penalties, ranking note, eligibility) to a candidate, so the UI can explain
 * "why not chosen" without re-deriving a second scoring formula.
 *
 * @param {Record<string, any>} row
 * @param {Map<string, Record<string, any>>} diagnosisRows
 * @returns {Record<string, any>}
 */
function candidateWithExplanation(row, diagnosisRows) {
  const out = copyCandidate(row);
  const diagnosis = diagnosisRows.get(pairKey(row?.harness, row?.model));
  if (!diagnosis) return out;
  if (!Array.isArray(out.filter_reasons) || out.filter_reasons.length === 0) {
    out.filter_reasons = Array.isArray(diagnosis.filter_reasons) ? [...diagnosis.filter_reasons] : [];
  }
  if (!Array.isArray(out.penalties) || out.penalties.length === 0) {
    out.penalties = Array.isArray(diagnosis.penalties) ? [...diagnosis.penalties] : [];
  }
  if (out.ranking_note == null) out.ranking_note = diagnosis.ranking_note ?? null;
  out.eligible = diagnosis.eligible === true;
  return out;
}

/**
 * Per-model eligibility. Favorite rows reuse the picker's own `diagnosis` row
 * (the single source for caller/history excludes, lockouts, flash and role
 * mismatch); non-favorite rows are labelled with the same vocabulary instead of
 * re-deriving a ranking.
 *
 * @param {{
 *   harness: ModelDiagnosticsHarness,
 *   harnessId: string,
 *   row: ModelDiagnosticsModelRow,
 *   listed: ModelDiagnosticsHarnessModels | undefined,
 *   role: string,
 *   diagnosisRow: ModelDiagnosticsDiagnosisRow | undefined,
 *   roleMatchers: Record<string, { eligible: boolean, flash_blocked: boolean }>,
 *   lockouts: import('./model-pick-gate-primitives.js').ModelPickLockoutRow[],
 *   now: number,
 * }} input
 * @returns {Record<string, any>}
 */
function eligibilityFor(input) {
  const {
    harness,
    harnessId,
    row,
    listed,
    role,
    diagnosisRow,
    roleMatchers,
    lockouts,
    now,
  } = input;
  if (!harness?.enabled || !harness?.ready || !harness?.can_delegate) {
    return {
      eligible: false,
      reasons: ['harness-disabled'],
      penalties: [],
      ranking_note: null,
      selected: false,
      source: 'harness',
    };
  }
  if (diagnosisRow) {
    return {
      eligible: diagnosisRow.eligible === true,
      reasons: Array.isArray(diagnosisRow.filter_reasons) ? [...diagnosisRow.filter_reasons] : [],
      penalties: Array.isArray(diagnosisRow.penalties) ? [...diagnosisRow.penalties] : [],
      ranking_note: diagnosisRow.ranking_note ?? null,
      selected: diagnosisRow.selected === true,
      source: 'picker-diagnosis',
    };
  }
  const model = String(row?.id || '').trim();
  /** @type {string[]} */
  const reasons = [];
  if (!listed || listed.favorites_configured !== true) reasons.push('no-favorites');
  else reasons.push('not-favorite');
  if (row?.available === false) reasons.push('unavailable');
  if (hasActiveLockout(Array.isArray(lockouts) ? lockouts : [], harnessId, model, now)) {
    reasons.push('active-lockout');
  }
  const matcher = roleMatchers?.[role];
  if (matcher && matcher.eligible !== true) reasons.push(describeRoleRejection(model, /** @type {ModelDiagnosticsRole} */ (role)));
  return {
    eligible: reasons.length === 0,
    reasons,
    penalties: [],
    ranking_note: null,
    selected: false,
    source: 'display-row',
  };
}

/**
 * Build the read-only diagnostics report.
 *
 * @param {{
 *   role?: string,
 *   now?: number,
 *   harnesses?: Partial<ModelDiagnosticsHarness>[],
 *   modelsByHarness?: Record<string, ModelDiagnosticsHarnessModels>,
 *   allModelsByHarness?: Record<string, ModelDiagnosticsHarnessModels>,
 *   harnessMeta?: Record<string, ModelDiagnosticsHarnessMeta>,
 *   history?: ModelDiagnosticsHistory,
 *   profiles?: import('./model-role-profiles.js').ModelRoleProfiles,
 *   weights?: import('./model-role-profiles.js').ModelRoleScoreWeightsByRole,
 *   rotation?: unknown,
 *   adaptive?: boolean | import('./model-role-profiles.js').ModelPickAdaptiveConfig,
 *   allowHighInfra?: boolean,
 *   exploreLedger?: unknown,
 *   exploreConfig?: unknown,
 *   exploreContext?: Record<string, unknown>,
 *   outcomes?: import('./model-pick-history.js').ModelPickHistoryOutcomes,
 *   delegationRows?: import('./model-pick-history.js').ModelPickHistoryRow[],
 *   usageEvents?: Partial<import('./shared-types/index.js').UsageEvent>[],
 *   usageSummary?: ModelDiagnosticsUsageSummary,
 *   usageRange?: unknown,
 *   config?: unknown,
 *   latestProposal?: ModelDiagnosticsProposal | null,
 * }} [input]
 * @returns {Record<string, any>}
 */
export function buildModelDiagnostics(input = {}) {
  const role = String(input.role || '').trim().toLowerCase();
  if (!MODEL_PICK_ROLES.includes(/** @type {import('./model-role-profiles.js').ModelPickRole} */ (role))) {
    return {
      ok: false,
      code: 'VALIDATION',
      error: 'role must be plan, implement, review, or fix',
      roles: [...MODEL_PICK_ROLES],
    };
  }
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const profiles = input.profiles || DEFAULT_MODEL_ROLE_PROFILES;
  const harnesses = Array.isArray(input.harnesses)
    ? /** @type {ModelDiagnosticsHarness[]} */ (input.harnesses)
    : [];
  const modelsByHarness = input.modelsByHarness && typeof input.modelsByHarness === 'object'
    ? input.modelsByHarness
    : {};
  const allModelsByHarness = input.allModelsByHarness && typeof input.allModelsByHarness === 'object'
    ? input.allModelsByHarness
    : modelsByHarness;
  const history = input.history && typeof input.history === 'object' ? input.history : {};
  const lockouts = Array.isArray(history.lockouts) ? history.lockouts : [];

  // The one selection computation. Every candidate/eligibility field below is
  // read back from this result; nothing here re-scores a model.
  const selected = /** @type {ModelDiagnosticsSelection} */ (selectModelPick({
    role,
    now,
    harnesses,
    modelsByHarness,
    history,
    profiles,
    weights: input.weights,
    rotation: input.rotation,
    adaptive: /** @type {boolean} */ (input.adaptive),
    allowHighInfra: input.allowHighInfra === true,
    checkReviewAdapter: true,
    ...(input.exploreLedger ? { exploreLedger: input.exploreLedger } : {}),
    ...(input.exploreConfig ? { exploreConfig: input.exploreConfig } : {}),
    ...(input.exploreContext ? { exploreContext: input.exploreContext } : {}),
  }));

  /** @type {Map<string, ModelDiagnosticsDiagnosisRow>} */
  const diagnosisRows = new Map();
  for (const row of Array.isArray(selected?.diagnosis?.rows) ? selected.diagnosis.rows : []) {
    diagnosisRows.set(pairKey(row.harness, row.model), row);
  }
  const outcomes = input.outcomes && typeof input.outcomes === 'object' ? input.outcomes : null;
  const { byCohort, lastUse } = indexOutcomes(outcomes);
  const usageSummary = input.usageSummary && typeof input.usageSummary === 'object'
    ? input.usageSummary
    : null;
  const priorInfra = Number(history?.prior?.infra_fail_rate) || 0;
  // Canonical, display-only stats contract. It is built from the aggregates the
  // route already loads; the optional delegation rows and usage events let it
  // attribute cycles and cost per cohort without any extra I/O here.
  const canonical = buildCanonicalModelStats({
    role,
    now,
    outcomes,
    delegations: input.delegationRows,
    usageEvents: /** @type {import('./shared-types/index.js').UsageEvent[]} */ (input.usageEvents),
    priorInfra,
    lowSampleN: DIAGNOSTICS_LOW_SAMPLE_N,
  });

  /** @type {Record<string, any>[]} */
  const models = [];
  for (const harness of harnesses) {
    const harnessId = String(harness?.id || '').trim();
    if (!harnessId) continue;
    const listed = allModelsByHarness[harnessId] || modelsByHarness[harnessId];
    const items = Array.isArray(listed?.items) ? listed.items : [];
    for (const row of items) {
      const model = String(row?.id || '').trim();
      if (!model) continue;
      const base = baseModelId(model);
      const roleMatchers = describeModelRoleMatchers(model, profiles);
      const diagnosisRow = diagnosisRows.get(pairKey(harnessId, model));
      const eligibility = eligibilityFor({
        harness,
        harnessId,
        row,
        listed,
        role,
        diagnosisRow,
        roleMatchers,
        lockouts,
        now,
      });
      const favorite = listed?.favorites_configured === true && row?.enabled !== false;
      /** @type {Record<string, Record<string, any> | null>} */
      const byRole = {};
      for (const statRole of MODEL_PICK_ROLES) {
        // `fix` shares the persisted `implement` aggregate (same contract as
        // `buildModelPickHistory`); the flag keeps that explicit.
        const aggregateRole = statRole === 'fix' ? 'implement' : statRole;
        const statsRow = byCohort.get(`${aggregateRole}:${pairKey(harnessId, base)}`)
          || byCohort.get(`${aggregateRole}:${pairKey(harnessId, model)}`)
          || null;
        byRole[statRole] = statsRow
          ? {
            ...cohortStats(statsRow, {
              now,
              priorInfra,
              windowMs: outcomes?.window_ms,
              minJobs: outcomes?.min_jobs,
            }),
            shares_implement_aggregate: statRole === 'fix',
          }
          : null;
      }
      const lastUsedAt = lastUse.get(pairKey(harnessId, base)) || lastUse.get(pairKey(harnessId, model)) || '';
      const usageLimit = row?.usage_limit && typeof row.usage_limit === 'object' ? row.usage_limit : null;
      const meta = input.harnessMeta?.[harnessId] || null;
      models.push({
        harness: harnessId,
        model,
        base_model: base,
        label: String(row?.label || model),
        favorite,
        enabled: row?.enabled !== false,
        harness_state: {
          enabled: harness?.enabled === true,
          ready: harness?.ready === true,
          available: harness?.available === true,
          can_delegate: harness?.can_delegate === true,
          label: String(harness?.label || harnessId),
        },
        roles: Array.isArray(row?.roles) ? [...row.roles] : [],
        role_matchers: roleMatchers,
        excluded: eligibility.reasons.some((reason) => (
          reason === 'caller-excluded'
          || reason === 'history-excluded'
          || reason === 'history-excluded-soft'
          || reason === 'harness-excluded'
          || reason === 'excluded'
        )),
        eligibility,
        availability: {
          available: row?.available !== false,
          usage_limited: row?.usage_limited === true || Boolean(usageLimit),
          usage_limit: usageLimit,
          locked_out: lockouts.length > 0
            ? hasActiveLockout(lockouts, harnessId, model, now)
            : eligibility.reasons.includes('active-lockout'),
          // Per-model availability history is not persisted: only the current
          // catalog state and the harness snapshot stamps are known.
          last_known_at: meta?.lastSuccessAt || meta?.lastAttemptAt || null,
          last_known_source: meta?.lastSuccessAt ? 'snapshot-success' : (meta?.lastAttemptAt ? 'snapshot-attempt' : ''),
          stale: meta?.stale === true,
        },
        last_use: lastUsedAt
          ? { at: lastUsedAt, source: 'delegation-outcomes', unknown: false, age_ms: Math.max(0, now - Date.parse(lastUsedAt)) }
          : { at: null, source: null, unknown: true, age_ms: null },
        cost: costFor(usageSummary, harnessId, model),
        stats: { by_role: byRole },
      });
    }
  }

  models.sort((left, right) => (
    left.harness.localeCompare(right.harness)
    || left.model.localeCompare(right.model)
  ));

  const cohorts = Array.isArray(outcomes?.list)
    ? outcomes.list.map((row) => ({
      ...cohortStats(row, {
        now,
        priorInfra,
        windowMs: outcomes?.window_ms,
        minJobs: outcomes?.min_jobs,
      }),
      // Cost is measured per harness/model, not per role; joining it here keeps
      // the cohort row useful while the `scope` field stays explicit.
      cost: costFor(usageSummary, row.harness, row.model),
    }))
    : [];

  return {
    ok: true,
    generated_at: new Date(now).toISOString(),
    role,
    roles: [...MODEL_PICK_ROLES],
    eligibility_cohort: buildModelPickEligibilityCohort(),
    policy_version: selected?.policyVersion ?? null,
    config: input.config ?? null,
    selection: {
      ok: selected?.ok === true,
      code: selected?.code ?? null,
      error: selected?.error ?? null,
      pick: selected?.pick ? candidateWithExplanation(selected.pick, diagnosisRows) : null,
      picks: Array.isArray(selected?.picks) ? selected.picks.map((row) => candidateWithExplanation(row, diagnosisRows)) : [],
      candidates: Array.isArray(selected?.candidates) ? selected.candidates.map((row) => candidateWithExplanation(row, diagnosisRows)) : [],
      rotation: selected?.rotation ?? null,
      exploration: selected?.exploration ?? null,
      favorite_diagnosis: selected?.diagnosis ?? null,
      note: 'pick and candidate order are reproduced by lib/model-role-profiles.js selectModelPick for these exact inputs',
    },
    models,
    stats: {
      window_ms: Number(outcomes?.window_ms) || null,
      generated_at: outcomes?.generated_at || null,
      min_jobs: Number(outcomes?.min_jobs) || null,
      low_sample_n: DIAGNOSTICS_LOW_SAMPLE_N,
      cohorts,
      cost: {
        window: usageSummary ? { runs: Number(usageSummary.runs) || 0 } : null,
        range: input.usageRange ?? null,
        by_harness: usageSummary?.byHarness ?? null,
        by_model: usageSummary?.byModel ?? null,
      },
      // Canonical, display-only contract with separate job / reviewed-cycle /
      // cost / latency denominators. It never feeds the ranking above.
      canonical,
      usage_link: { settings_tab: 'usage', group_by: 'harness' },
    },
    // The picker persists these shapes; the diagnostics reuses them instead of
    // inventing a parallel record.
    persisted: input.latestProposal
      ? {
        pick_id: input.latestProposal.id,
        policy_version: input.latestProposal.policyVersion ?? null,
        role: input.latestProposal.role ?? null,
        created_at: input.latestProposal.createdAt ?? null,
        candidates: Array.isArray(input.latestProposal.candidates) ? input.latestProposal.candidates : [],
        picks: Array.isArray(input.latestProposal.picks) ? input.latestProposal.picks : [],
      }
      : null,
    unknowns: [
      'task-type and effort cohorts are not aggregated; stats stay on harness/base-model/role',
      'cost per (harness, base-model, role) is not measured; cost is per harness/model from the usage ledger',
      'availability history per model is not persisted; only current state, lockouts and harness snapshot stamps are shown',
      'a cohort without terminal jobs in the window stays unknown (n=0) and is never rendered as a measured zero',
    ],
  };
}
