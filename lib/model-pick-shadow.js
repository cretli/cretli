/**
 * Explainable shadow scoring for `model_pick` (stage 4 of `2584cd05`).
 *
 * The observer runs **after** the ordinary `selectModelPick` and never feeds
 * anything back into it. It receives the exact candidate set the picker
 * produced, the exact selection, the local observed statistics already carried
 * on every candidate (the `n/(n+10)` blend and infra prior live in
 * `lib/model-role-profiles.js`; this module consumes them, it does not re-derive
 * them), and an optional network-free endpoint price lookup (stage 3). It
 * returns `shadow_top`, a human-readable `explanation` and an `agreement` record.
 *
 * Guarantees, pinned by `tests/model-pick-shadow.test.js`:
 * - selected/candidates are read-only inputs; nothing here mutates them;
 * - the candidate set is passed through unchanged (eligibility parity);
 * - an unmatched identity is neutral: no cost and no time adjustment;
 * - an endpoint price may move a cost score only for a fresh `api_metered`
 *   pair; `subscription_quota`, `local` and `unknown` never do;
 * - review quality is never derived from the verdict pass rate. The observer
 *   starts from the picker's already-blended score, and that blend keeps review
 *   quality out by policy.
 *
 * Stage 7 adds an optional, bounded measurement input
 * (`lib/model-pick-shadow-facts.js`): already-built stage-1 scoring facts are
 * reconciled by source precedence and labelled with kind/source_class/version/
 * age/confidence/coverage. A measured `api_metered` cost beats the endpoint
 * catalog estimate; a missing signal degrades to the existing prior rather than
 * a cheap zero. The measurement path is additive: `pick`, `picks` and
 * `candidates` are byte-identical with the observer on or off.
 *
 * The default price lookup is `null` (no prices at all): the caller that owns
 * the stage-3 cache injects the synchronous getter, so this module stays pure
 * and can never trigger a network request by accident.
 */

import fs from 'node:fs';

import { resolveModelIdentity } from './model-facts/identity.js';
import { resolveTelemetryBillingClass } from './model-facts/telemetry.js';
import {
  SHADOW_MEASUREMENT_SCHEMA_VERSION,
  buildShadowMeasurementIndex,
  summarizeMeasurementCoverage,
} from './model-pick-shadow-facts.js';
import {
  MODEL_PICK_SHADOW_CONFIG_DEFAULTS,
  MODEL_PICK_SHADOW_POLICY_VERSION,
  normalizeModelPickShadowConfig,
} from './model-pick-policy.js';
import { resolveDataPath } from './runtime-paths.js';

/** Explanation schema version. Bump when a field or rule changes. */
export const MODEL_PICK_SHADOW_SCHEMA_VERSION = 'model-pick-shadow-2026-10-08';

/** Cost/time nudges are deliberately small; a shadow must not shadow-rank by luck. */
export const SHADOW_COST_ADJUSTMENT_MAX = 0.05;
export const SHADOW_TIME_ADJUSTMENT_MAX = 0.05;

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function asFinite(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return String(value ?? '').trim();
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function lower(value) {
  return text(value).toLowerCase();
}

/**
 * @param {unknown} value
 * @returns {number | null} epoch ms for an ISO timestamp
 */
function timeOf(value) {
  const raw = text(value);
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Shadow policy from `data/model-role-profiles.json`. Mirrors
 * `loadModelPickExploreConfig`: an unreadable or invalid file falls back to the
 * shipped defaults, which observe but never promote.
 *
 * @param {{ filePath?: string }} [input]
 * @returns {import('./model-pick-policy.js').ModelPickShadowConfig}
 */
export function loadModelPickShadowConfig(input = {}) {
  const filePath = text(input.filePath) || resolveDataPath('model-role-profiles.json');
  try {
    return normalizeModelPickShadowConfig(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch {
    return MODEL_PICK_SHADOW_CONFIG_DEFAULTS;
  }
}

/**
 * Blended per-token price of an endpoint catalog entry, in USD per million
 * tokens. OpenRouter publishes `prompt`/`completion` as USD-per-token strings;
 * other endpoints may use `input`/`output`. Returns null when the entry carries
 * no usable numeric price (a missing price is not zero).
 *
 * @param {unknown} pricing
 * @returns {number | null}
 */
export function blendedPricePerMillion(pricing) {
  if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) return null;
  const row = /** @type {Record<string, unknown>} */ (pricing);
  const parts = [];
  for (const key of ['prompt', 'input', 'completion', 'output']) {
    const value = asFinite(row[key]);
    if (value != null && value >= 0) parts.push(value);
  }
  if (parts.length === 0) return null;
  const mean = parts.reduce((sum, value) => sum + value, 0) / parts.length;
  return mean * 1_000_000;
}

/**
 * Freshness of one price entry. The stage-3 `stale_after_ms` field is
 * historically misnamed: it holds `stored_at_ms` (the write timestamp), not a
 * deadline, so it is used only as a last-resort fetch time.
 *
 * @param {object | null} entry
 * @param {number} now
 * @param {number} freshMs
 * @returns {{ age_ms: number | null, stale: boolean, fetched_at: string | null }}
 */
function priceFreshness(entry, now, freshMs) {
  if (!entry || typeof entry !== 'object') return { age_ms: null, stale: true, fetched_at: null };
  const row = /** @type {Record<string, unknown>} */ (entry);
  const fetchedMs = timeOf(row.fetched_at)
    ?? timeOf(row.observed_at)
    ?? asFinite(row.stale_after_ms);
  if (fetchedMs == null) return { age_ms: null, stale: true, fetched_at: null };
  const ageMs = Math.max(0, now - fetchedMs);
  return {
    age_ms: ageMs,
    stale: ageMs > freshMs,
    fetched_at: new Date(fetchedMs).toISOString(),
  };
}

/**
 * @param {object | null} entry
 * @param {number | null} ageMs
 * @param {boolean} stale
 * @returns {object | null}
 */
function describePrice(entry, ageMs, stale) {
  if (!entry) return null;
  return {
    model_id: text(entry.modelId),
    per_million_usd: blendedPricePerMillion(entry.pricing),
    kind: text(entry.kind) || 'estimate',
    source: text(entry.source) || 'unknown',
    source_class: text(entry.source_class) || 'unknown',
    source_version: text(entry.source_version),
    billing_class: text(entry.billing_class) || 'unknown',
    fetched_at: text(entry.fetched_at) || null,
    observed_at: text(entry.observed_at) || null,
    attribution: text(entry.attribution),
    age_ms: ageMs,
    stale,
  };
}

/**
 * Does a review score draw on the verdict pass rate? It must not. The observer
 * never sets `quality_source` to `pass_rate`; this guard makes an accidental
 * future change detectable, and the rollout report turns it into a stop flag.
 *
 * @param {unknown} role
 * @param {unknown[]} contributions
 * @returns {boolean}
 */
export function reviewPassRateInfluencesScore(role, contributions) {
  if (lower(role) !== 'review') return false;
  return (Array.isArray(contributions) ? contributions : [])
    .some((row) => lower(/** @type {any} */ (row)?.quality_source) === 'pass_rate');
}

/**
 * Normalize one ranking signal among the candidates it actually applies to.
 * `goodness` is higher-is-better, so the best candidate gets `+max/2` and the
 * worst `-max/2`; a single value gets a neutral `0`.
 *
 * @param {Array<{ candidateId: string, goodness: number }>} rows
 * @param {number} maxAdjustment
 * @returns {Map<string, number>}
 */
function normalizeAdjustments(rows, maxAdjustment) {
  /** @type {Map<string, number>} */
  const out = new Map();
  if (rows.length === 0) return out;
  const values = rows.map((row) => row.goodness);
  const min = Math.min(...values);
  const max = Math.max(...values);
  for (const row of rows) {
    const position = max === min ? 0.5 : (row.goodness - min) / (max - min);
    out.set(row.candidateId, maxAdjustment * (position - 0.5));
  }
  return out;
}

/**
 * The pure shadow scorer.
 *
 * Measurement input is optional and additive. `measurementFacts` is a bounded
 * list of stage-1 scoring facts reconciled by
 * `lib/model-pick-shadow-facts.js`; `measurementFor` may instead hand back one
 * already-built packet per candidate. A measured `api_metered` cost fact wins
 * over the endpoint catalog estimate; a measured speed fact wins over the
 * history block. Neither can change `pick`, and a missing signal stays neutral.
 *
 * @param {{
 *   role?: string,
 *   selected?: { harness?: string, model?: string } | null,
 *   candidates?: object[],
 *   now?: number,
 *   config?: object,
 *   priceFor?: (candidate: object, identity: object) => object | null,
 *   billingClassOf?: (candidate: object, identity: object) => string,
 *   identityOf?: (input: { harness?: string, model?: string }) => object,
 *   measurementFacts?: object[],
 *   measurementFor?: (candidate: object, identity: object) => object | null,
 * }} [input]
 * @returns {{
 *   ok: boolean,
 *   role: string,
 *   policy: string,
 *   schema: string,
 *   shadow_top: object | null,
 *   explanation: object,
 *   agreement: object,
 *   scores: object[],
 * }}
 */
export function scoreShadowCandidates(input = {}) {
  const role = lower(input.role);
  const now = asFinite(input.now) ?? Date.now();
  const config = normalizeModelPickShadowConfig(input.config ?? MODEL_PICK_SHADOW_CONFIG_DEFAULTS);
  const candidates = Array.isArray(input.candidates) ? input.candidates : [];
  const selected = input.selected && typeof input.selected === 'object' ? input.selected : null;
  const priceFor = typeof input.priceFor === 'function' ? input.priceFor : () => null;
  const billingClassOf = typeof input.billingClassOf === 'function' ? input.billingClassOf : null;
  const identityOf = typeof input.identityOf === 'function' ? input.identityOf : resolveModelIdentity;

  /** @type {object[]} */
  const contributions = [];
  /** @type {Array<{ candidateId: string, value: number, origin: string }>} */
  const costRows = [];
  /** @type {Array<{ candidateId: string, metric: string, value: number, provenance: object }>} */
  const timeObservations = [];

  // Bounded measurement input: a flat fact list is indexed once (O(facts)), so
  // the observer never scans the ledger per candidate. A per-candidate getter
  // may be injected instead; both paths carry the same packet shape.
  const measurementFacts = Array.isArray(input.measurementFacts) ? input.measurementFacts : null;
  const measurementFor = typeof input.measurementFor === 'function' ? input.measurementFor : null;
  const measurementIndex = !measurementFor && measurementFacts
    ? buildShadowMeasurementIndex({
      candidates,
      facts: measurementFacts,
      identityOf,
      billingClassOf,
      now,
      freshMs: config.priceFreshMs,
    })
    : null;

  for (const candidate of candidates) {
    const harness = lower(candidate?.harness);
    const model = text(candidate?.model);
    const candidateId = harness && model ? `${harness}/${model}` : '';
    const baseScore = asFinite(candidate?.score) ?? 0;
    const identity = harness && model ? identityOf({ harness, model }) : null;
    const matched = identity?.aliasStatus === 'matched';
    const billingClass = billingClassOf
      ? lower(billingClassOf(candidate, identity))
      : resolveTelemetryBillingClass({ harness, provider: identity?.provider });
    const entry = matched ? priceFor(candidate, identity) : null;
    const freshness = priceFreshness(entry, now, config.priceFreshMs);
    const price = describePrice(entry, freshness.age_ms, freshness.stale);
    let skippedReason = '';
    let applied = false;
    if (!candidateId) skippedReason = 'missing-identity';
    else if (!matched) skippedReason = 'unmatched-alias';
    else if (billingClass !== 'api_metered') skippedReason = `billing-class-${billingClass || 'unknown'}`;
    else if (!entry) skippedReason = 'no-price';
    else if (price?.per_million_usd == null) skippedReason = 'no-price-value';
    else if (freshness.stale) skippedReason = 'stale-price';
    else applied = true;

    const measurement = measurementFor
      ? measurementFor(candidate, identity)
      : (measurementIndex ? measurementIndex.get(candidateId) : null) || null;

    // Cost precedence: a measured matched api_metered fact (already reconciled
    // by the stage-1 source precedence) beats the endpoint catalog estimate.
    // A missing cost stays null, never USD 0, and a subscription/local/unknown
    // pair never reaches this branch.
    const measurementCost = matched && billingClass === 'api_metered' ? (measurement?.cost ?? null) : null;
    const measuredPerMillion = measurementCost?.normalized_per_million_usd ?? null;
    let costSource = 'missing';
    let costValue = null;
    let costSignal = null;
    if (measuredPerMillion != null) {
      costSource = 'measurement';
      costValue = measuredPerMillion;
      costSignal = measurementCost;
    } else if (applied) {
      costSource = 'endpoint-price';
      costValue = /** @type {number} */ (price.per_million_usd);
      costSignal = {
        ...price,
        origin: 'estimate',
        measured: false,
        value_usd: price.per_million_usd,
        per: 'million_tokens',
        normalized_per_million_usd: price.per_million_usd,
        derived_per_million: false,
        cohort_id: null,
        partial_coverage: false,
        confidence: null,
      };
    }
    if (costValue != null) costRows.push({ candidateId, value: costValue, origin: costSource });

    // Speed precedence: a measured throughput/latency fact wins for that
    // candidate; otherwise the observed block is used only when the endpoint
    // price gate passed, exactly as before, so the historical ranking is kept.
    let timeObservation = null;
    if (measurement?.time) {
      const sourceMetric = measurement.time.metric;
      timeObservation = {
        metric: sourceMetric === 'latency_ms' ? 'latency_min' : 'throughput',
        value: sourceMetric === 'latency_ms' ? measurement.time.value / 60000 : measurement.time.value,
        provenance: {
          from_measurement: true,
          source_metric: sourceMetric,
          origin: measurement.time.origin,
          measured: measurement.time.measured === true,
          kind: measurement.time.kind,
          source: measurement.time.source,
          source_class: measurement.time.source_class,
          source_version: measurement.time.source_version,
          observed_at: measurement.time.observed_at,
          fetched_at: measurement.time.fetched_at,
          age_ms: measurement.time.age_ms,
          confidence: measurement.time.confidence,
        },
      };
    } else if (applied) {
      const observed = candidate?.observed && typeof candidate.observed === 'object' ? candidate.observed : null;
      const throughput = asFinite(observed?.median_tokens_per_sec);
      const medianMin = asFinite(observed?.median_min);
      if (throughput != null && throughput > 0) {
        timeObservation = {
          metric: 'throughput',
          value: throughput,
          provenance: {
            from_measurement: false,
            origin: 'estimate',
            measured: false,
            kind: 'estimate',
            source: 'model-pick-history',
            source_class: 'ledger_estimate',
            observed_at: null,
            age_ms: null,
          },
        };
      } else if (medianMin != null && medianMin >= 0) {
        timeObservation = {
          metric: 'latency_min',
          value: medianMin,
          provenance: {
            from_measurement: false,
            origin: 'estimate',
            measured: false,
            kind: 'estimate',
            source: 'model-pick-history',
            source_class: 'ledger_estimate',
            observed_at: null,
            age_ms: null,
          },
        };
      }
    }
    if (timeObservation) timeObservations.push({ candidateId, ...timeObservation });

    /** @type {object} */
    const contribution = {
      candidateId,
      harness,
      model,
      role,
      base_score: baseScore,
      shadow_score: baseScore,
      cost_adjustment: 0,
      time_adjustment: 0,
      applied,
      skipped_reason: skippedReason || null,
      billing_class: billingClass || 'unknown',
      cost_source: costSource,
      cost_signal: costSignal,
      time_source: 'missing',
      identity: {
        alias_status: lower(identity?.aliasStatus) || 'unmatched',
        alias_reason: text(identity?.aliasReason),
        provider: text(identity?.provider) || null,
        external_model_id: text(identity?.externalModelId) || null,
      },
      price,
      time: null,
      measurement,
      // The shadow never computes its own quality; it consumes the existing
      // observed blend. Naming the source keeps a review pass-rate influence
      // impossible by construction and detectable by the guard.
      quality_source: 'existing-observed-blend',
    };
    contributions.push(contribution);
  }

  // One time scale per pass: throughput when any candidate measured it, else the
  // median duration. Mixing tokens/s with minutes in one normalization would
  // compare incompatible units, so a candidate without the chosen metric is
  // simply left unadjusted.
  const usesThroughput = timeObservations.some((row) => row.metric === 'throughput');
  const timeRows = timeObservations
    .filter((row) => row.metric === (usesThroughput ? 'throughput' : 'latency_min'))
    // Higher is better for both: more tokens/s, or a shorter median duration
    // (negated). The normalizer then rewards the best on one scale.
    .map((row) => ({
      candidateId: row.candidateId,
      goodness: row.metric === 'throughput' ? row.value : -row.value,
    }));
  for (const row of timeObservations) {
    const contribution = contributions.find((entry) => entry.candidateId === row.candidateId);
    if (!contribution || row.metric !== (usesThroughput ? 'throughput' : 'latency_min')) continue;
    contribution.time = {
      metric: row.metric,
      value: row.value,
      kind: row.provenance.kind || 'estimate',
      source: row.provenance.source || 'model-pick-history',
      source_class: row.provenance.source_class || 'ledger_estimate',
      source_version: row.provenance.source_version ?? null,
      // The public observed block carries no timestamp, so the age is honestly
      // unknown rather than guessed.
      observed_at: row.provenance.observed_at ?? null,
      age_ms: row.provenance.age_ms ?? null,
      confidence: row.provenance.confidence ?? null,
      origin: row.provenance.origin || 'estimate',
      measured: row.provenance.measured === true,
      from_measurement: row.provenance.from_measurement === true,
    };
    contribution.time_source = row.provenance.from_measurement ? 'measurement' : 'observed';
  }

  const costAdjustments = normalizeAdjustments(
    costRows.map((row) => ({ candidateId: row.candidateId, goodness: -row.value })),
    SHADOW_COST_ADJUSTMENT_MAX,
  );
  const timeAdjustments = normalizeAdjustments(timeRows, SHADOW_TIME_ADJUSTMENT_MAX);
  for (const row of contributions) {
    row.cost_adjustment = costAdjustments.get(row.candidateId) ?? 0;
    row.time_adjustment = timeAdjustments.get(row.candidateId) ?? 0;
    row.shadow_score = row.base_score + row.cost_adjustment + row.time_adjustment;
  }

  // Ties keep the picker's own order, so an exact tie agrees with the picker
  // instead of inventing a winner from the alphabet.
  let top = null;
  for (const row of contributions) {
    if (!row.candidateId) continue;
    if (top == null || row.shadow_score > top.shadow_score) top = row;
  }

  const selectedHarness = lower(selected?.harness);
  const selectedModel = text(selected?.model);
  const selectedId = selectedHarness && selectedModel ? `${selectedHarness}/${selectedModel}` : '';
  const shadowTopId = top ? top.candidateId : '';
  const agree = Boolean(selectedId) && selectedId === shadowTopId;
  const reviewPassRate = reviewPassRateInfluencesScore(role, contributions);
  // Coverage of the reconciled measurement input: how many candidates had a
  // measured, estimated or missing signal, plus which cost path won. A missing
  // signal is reported as missing, never as a cheap zero.
  const measurementCoverage = summarizeMeasurementCoverage(contributions.map((row) => row.measurement));
  /** @type {Record<string, number>} */
  const costSources = { measurement: 0, 'endpoint-price': 0, missing: 0 };

  /** @type {object | null} */
  const topSummary = top
    ? {
      candidateId: top.candidateId,
      harness: top.harness,
      model: top.model,
      shadow_score: top.shadow_score,
      base_score: top.base_score,
    }
    : null;
  const selectedSummary = selectedId
    ? { candidateId: selectedId, harness: selectedHarness, model: selectedModel }
    : null;

  for (const row of contributions) {
    costSources[row.cost_source] = (costSources[row.cost_source] || 0) + 1;
  }

  return {
    ok: true,
    role,
    policy: MODEL_PICK_SHADOW_POLICY_VERSION,
    schema: MODEL_PICK_SHADOW_SCHEMA_VERSION,
    shadow_top: topSummary,
    explanation: {
      schema: MODEL_PICK_SHADOW_SCHEMA_VERSION,
      policy: MODEL_PICK_SHADOW_POLICY_VERSION,
      role,
      strategy: 'shadow-cost-time-v1',
      selected: selectedSummary,
      shadow_top: topSummary,
      agreement: agree,
      candidate_count: contributions.length,
      // Structural parity: the observer consumes the picker's candidate array
      // as-is and never filters or extends it.
      eligibility_parity: true,
      selected_unchanged: true,
      price_fresh_ms: config.priceFreshMs,
      review_pass_rate_in_quality_score: reviewPassRate,
      measurement_schema: SHADOW_MEASUREMENT_SCHEMA_VERSION,
      measurement_coverage: measurementCoverage,
      cost_sources: costSources,
      contributions,
    },
    agreement: {
      role,
      selected: selectedId || null,
      shadow_top: shadowTopId || null,
      agree,
    },
    scores: contributions,
  };
}

/**
 * Apply the observer to one successful `selectModelPick` result, additively.
 *
 * The returned object is a shallow copy with three added keys. `pick`, `picks`,
 * `candidates` and every candidate object are the same references as the input,
 * so no shadow computation can change the selection.
 *
 * @param {object} picked
 * @param {{
 *   role?: string,
 *   now?: number,
 *   enabled?: boolean,
 *   config?: object,
 *   priceFor?: (candidate: object, identity: object) => object | null,
 *   billingClassOf?: (candidate: object, identity: object) => string,
 *   identityOf?: (input: { harness?: string, model?: string }) => object,
 *   measurementFacts?: object[],
 *   measurementFor?: (candidate: object, identity: object) => object | null,
 * }} [options]
 * @returns {object}
 */
export function applyShadowLayer(picked, options = {}) {
  if (!picked || picked.ok !== true) return picked;
  const config = normalizeModelPickShadowConfig(options.config ?? MODEL_PICK_SHADOW_CONFIG_DEFAULTS);
  if (options.enabled === false || config.mode === 'off') return picked;
  const candidates = Array.isArray(picked.candidates) ? picked.candidates : [];
  if (candidates.length === 0) return picked;
  const shadow = scoreShadowCandidates({
    role: options.role,
    now: options.now,
    config,
    selected: picked.pick,
    candidates,
    priceFor: options.priceFor,
    billingClassOf: options.billingClassOf,
    identityOf: options.identityOf,
    measurementFacts: options.measurementFacts,
    measurementFor: options.measurementFor,
  });
  return {
    ...picked,
    shadow_top: shadow.shadow_top,
    shadow_explanation: shadow.explanation,
    shadow_agreement: shadow.agreement,
  };
}
