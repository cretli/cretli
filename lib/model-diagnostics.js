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
 * @returns {{ byCohort: Map<string, object>, lastUse: Map<string, string> }}
 */
function indexOutcomes(outcomes) {
  /** @type {Map<string, object>} */
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
 * @param {object | undefined} usageSummary
 * @param {string} harness
 * @param {string} model
 * @returns {object}
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
 * @param {object} row
 * @param {{ lowSampleN?: number, priorInfra?: number }} [options]
 * @returns {object}
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
 * @param {object} candidate
 * @returns {object}
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
 * @param {object} row
 * @param {Map<string, object>} diagnosisRows
 * @returns {object}
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
 *   harness: object,
 *   harnessId: string,
 *   row: object,
 *   listed: object | undefined,
 *   role: string,
 *   diagnosisRow: object | undefined,
 *   roleMatchers: Record<string, { eligible: boolean, flash_blocked: boolean }>,
 *   lockouts: object[],
 *   now: number,
 * }} input
 * @returns {object}
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
  const reasons = [];
  if (!listed || listed.favorites_configured !== true) reasons.push('no-favorites');
  else reasons.push('not-favorite');
  if (row?.available === false) reasons.push('unavailable');
  if (hasActiveLockout(Array.isArray(lockouts) ? lockouts : [], harnessId, model, now)) {
    reasons.push('active-lockout');
  }
  const matcher = roleMatchers?.[role];
  if (matcher && matcher.eligible !== true) reasons.push(describeRoleRejection(model, role));
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
 *   harnesses?: object[],
 *   modelsByHarness?: Record<string, object>,
 *   allModelsByHarness?: Record<string, object>,
 *   harnessMeta?: Record<string, object>,
 *   history?: object,
 *   profiles?: object,
 *   weights?: object,
 *   rotation?: object,
 *   adaptive?: unknown,
 *   allowHighInfra?: boolean,
 *   exploreLedger?: object,
 *   exploreConfig?: object,
 *   exploreContext?: object,
 *   outcomes?: object,
 *   delegationRows?: object[],
 *   usageEvents?: object[],
 *   usageSummary?: object,
 *   config?: object,
 *   latestProposal?: object | null,
 * }} [input]
 * @returns {object}
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
  const harnesses = Array.isArray(input.harnesses) ? input.harnesses : [];
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
  const selected = selectModelPick({
    role,
    now,
    harnesses,
    modelsByHarness,
    history,
    profiles,
    weights: input.weights,
    rotation: input.rotation,
    adaptive: input.adaptive,
    allowHighInfra: input.allowHighInfra === true,
    checkReviewAdapter: true,
    ...(input.exploreLedger ? { exploreLedger: input.exploreLedger } : {}),
    ...(input.exploreConfig ? { exploreConfig: input.exploreConfig } : {}),
    ...(input.exploreContext ? { exploreContext: input.exploreContext } : {}),
  });

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
    usageEvents: input.usageEvents,
    priorInfra,
    lowSampleN: DIAGNOSTICS_LOW_SAMPLE_N,
  });

  /** @type {object[]} */
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
      /** @type {Record<string, object | null>} */
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
