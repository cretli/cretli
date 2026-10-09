/**
 * Fact → shadow measurement adapter (stage 7 of `2584cd05`).
 *
 * Stage 2 (`lib/model-facts/telemetry.js`) records versioned scoring facts about
 * a `(harness, model, variant)` pair. The shadow observer stage 4
 * (`lib/model-pick-shadow.js`) consumes a network-free endpoint price and the
 * history `observed` block. This module is the missing input layer between the
 * two: it reconciles a **bounded** list of facts with the stage-1
 * {@link selectPreferredFacts} precedence, attaches provenance (kind,
 * source_class, source_version, observed_at/fetched_at, age, confidence) and a
 * per-signal coverage label, and hands the shadow one measurement packet per
 * candidate.
 *
 * ## Additive by construction
 * A packet never invents a value. A missing cost is `null`, not USD 0; an
 * unmatched alias yields an empty packet; a signal without a fact stays
 * `missing` and the shadow keeps its existing heuristic prior. The packet is a
 * read-only description; this module ranks nothing and consumes no network.
 *
 * ## What it does NOT do
 * - It does not read the usage ledger. A caller that owns the ledger builds a
 *   cohort cost fact **outside** the pick (see {@link buildShadowCycleCostFact})
 *   and passes it in; the pick path only reconciles the already-built facts,
 *   so a pick can never trigger a full-ledger scan.
 * - It does not re-implement pricing. The endpoint catalog price stays on the
 *   stage-3 path; a measured ledger cost is a higher-precedence `usd` fact.
 * - It does not score or select. Quality is labelled for visibility only.
 *
 * @typedef {'measured' | 'estimate' | 'heuristic' | 'missing'} ShadowSignalCoverage
 */

import {
  compareScoringFacts,
  createScoringFact,
  factInfluencesRanking,
  factMayCarryUsd,
  factUsdValue,
  normalizeBillingClass,
  selectPreferredFacts,
} from './model-facts/schema.js';
import {
  buildTaskQualityTelemetry,
  resolveTelemetryBillingClass,
} from './model-facts/telemetry.js';

/** Bump when a packet field, coverage label or reconciliation rule changes. */
export const SHADOW_MEASUREMENT_SCHEMA_VERSION = 'shadow-measurement-2026-10-08';

/** Coverage labels for one shadow signal, best first. */
export const SHADOW_SIGNAL_COVERAGES = Object.freeze([
  'measured',
  'estimate',
  'heuristic',
  'missing',
]);

/**
 * Token metrics that sum to the additive `billed_tokens`. The list mirrors
 * `TELEMETRY_TOKEN_METRICS`; a value stays in its own bucket so cache is never
 * counted twice.
 */
export const SHADOW_TOKEN_METRICS = Object.freeze([
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'reasoning_tokens',
  'audio_input_tokens',
  'audio_output_tokens',
]);

/** Speed metrics the shadow understands, in preference order. */
export const SHADOW_TIME_METRICS = Object.freeze(['throughput', 'latency_ms']);

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return String(value ?? '').trim();
}

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
 * @returns {number | null} epoch ms, or null when the timestamp is unusable
 */
function timeOf(value) {
  const raw = text(value);
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Coverage of one signal: `measured` for a provider actual or a provider
 * reading (a plan-usage fact is provider-reported), `estimate` for a derived or
 * catalog value, `missing` when no fact exists.
 *
 * @param {any} fact
 * @returns {ShadowSignalCoverage}
 */
function coverageOfFact(fact) {
  if (!fact) return 'missing';
  if (fact.kind === 'actual' || fact.source_class === 'provider_actual') return 'measured';
  return 'estimate';
}

/**
 * Provenance label shared by every fact-backed signal.
 *
 * @param {any} fact
 * @param {{ now: number, freshMs: number | null }} context
 * @returns {object}
 */
function labelFact(fact, context) {
  const observedMs = timeOf(fact.observed_at);
  const fetchedMs = timeOf(fact.fetched_at);
  const anchorMs = fetchedMs ?? observedMs;
  const ageMs = anchorMs == null ? null : Math.max(0, context.now - anchorMs);
  const origin = coverageOfFact(fact);
  return {
    fact_id: text(fact.fact_id) || null,
    metric: text(fact.metric),
    unit: text(fact.unit),
    kind: text(fact.kind) || 'estimate',
    origin,
    measured: origin === 'measured',
    source: text(fact.source) || 'unknown',
    source_class: text(fact.source_class) || 'heuristic',
    source_version: text(fact.source_version) || null,
    observed_at: text(fact.observed_at) || null,
    fetched_at: text(fact.fetched_at) || null,
    age_ms: ageMs,
    fresh: ageMs == null || context.freshMs == null ? null : ageMs <= context.freshMs,
    confidence: asFinite(fact.confidence),
    billing_class: normalizeBillingClass(fact.billing_class),
  };
}

/**
 * Build the cost half of a packet. Only a matched `api_metered` `usd` fact may
 * carry a per-cycle or per-token charge; every other class returns `null`.
 *
 * @param {any} fact
 * @param {{ now: number, freshMs: number | null, billingClass: string, tokensBilled?: number | null }} context
 * @returns {object | null}
 */
function describeCost(fact, context) {
  if (!fact || !factMayCarryUsd(fact)) return null;
  if (context.billingClass && context.billingClass !== 'api_metered') return null;
  const value = factUsdValue(fact);
  if (value == null) return null;
  const label = labelFact(fact, context);
  const per = text(fact.per) || 'million_tokens';
  // A cohort fact may not carry its own token total; the packet's additive sum
  // is the conversion basis. Read it without mutating the shared fact.
  const billedTokens = asFinite(fact.billed_tokens) ?? asFinite(context.tokensBilled);
  let normalizedPerMillion = null;
  let derivedPerMillion = false;
  if (per === 'million_tokens') {
    normalizedPerMillion = value;
  } else if (per === 'cycle' && billedTokens != null && billedTokens > 0) {
    // Convert a cohort total to the endpoint price basis so two cost signals on
    // different bases never share one normalization scale.
    normalizedPerMillion = (value / billedTokens) * 1_000_000;
    derivedPerMillion = true;
  }
  return {
    ...label,
    value_usd: value,
    per,
    normalized_per_million_usd: normalizedPerMillion,
    derived_per_million: derivedPerMillion,
    cohort_id: text(fact.cohort_id) || null,
    partial_coverage: fact.partial_coverage === true,
    attempts: asFinite(fact.attempts),
    failures: asFinite(fact.failures),
    fixes: asFinite(fact.fixes),
    usd_allowed: true,
    basis_convertible: per === 'million_tokens' || normalizedPerMillion != null,
  };
}

/**
 * Build the speed half of a packet. Throughput wins over latency; a value that
 * is not positive is absent rather than zero.
 *
 * @param {any} throughput
 * @param {any} latency
 * @param {{ now: number, freshMs: number | null }} context
 * @returns {object | null}
 */
function describeTime(throughput, latency, context) {
  const fact = throughput || latency;
  if (!fact) return null;
  const value = asFinite(fact.value);
  if (value == null || value <= 0) return null;
  const metric = text(fact.metric);
  return {
    ...labelFact(fact, context),
    metric: metric === 'latency_ms' ? 'latency_ms' : 'throughput',
    value,
    // Higher is better for both: a shorter latency is negated for the normalizer.
    goodness: metric === 'latency_ms' ? -value : value,
  };
}

/**
 * Quality is recorded for visibility only. Review verdict pass-rate must never
 * become a review quality score, so the signal is always diagnostic.
 *
 * @param {any} fact
 * @param {{ now: number, freshMs: number | null }} context
 * @returns {object | null}
 */
function describeQuality(fact, context) {
  if (!fact) return null;
  return {
    ...labelFact(fact, context),
    value: asFinite(fact.value),
    ranking_eligible: false,
    review_verdict_excluded: true,
    used_in_score: false,
  };
}

/**
 * Split the reconciled token facts into their disjoint buckets. The additive
 * `billed_tokens` equals the sum of the buckets, which is what keeps cache read
 * and cache write from being counted twice.
 *
 * @param {Map<string, any>} byMetric
 * @returns {object | null}
 */
function describeTokens(byMetric) {
  /** @type {Record<string, number>} */
  const buckets = {};
  let billed = 0;
  let present = false;
  for (const metric of SHADOW_TOKEN_METRICS) {
    const fact = byMetric.get(metric);
    if (!fact) continue;
    const value = asFinite(fact.value);
    if (value == null || value <= 0) continue;
    buckets[metric] = value;
    billed += value;
    present = true;
  }
  if (!present) return null;
  return {
    uncached_input: buckets.input_tokens ?? 0,
    output: buckets.output_tokens ?? 0,
    cache_read: buckets.cache_read_tokens ?? 0,
    cache_write: buckets.cache_write_tokens ?? 0,
    reasoning: buckets.reasoning_tokens ?? 0,
    audio_input: buckets.audio_input_tokens ?? 0,
    audio_output: buckets.audio_output_tokens ?? 0,
    billed_tokens: billed,
    buckets,
  };
}

/**
 * Reconcile the diagnostic (non-scoring) facts per metric without the ranking
 * alias gate. Token buckets and a plan reading still describe the pair even when
 * its alias is unmatched, and neither can move a score, so they are surfaced
 * with coverage rather than silently dropped. `usd` is excluded: cost is the
 * scoring signal and stays gated by `selectPreferredFacts`.
 *
 * @param {any[]} facts
 * @returns {Map<string, any>}
 */
function reconcileDiagnosticFacts(facts) {
  /** @type {Map<string, any[]>} */
  const groups = new Map();
  for (const fact of Array.isArray(facts) ? facts : []) {
    if (!fact || typeof fact !== 'object') continue;
    if (fact.metric === 'usd') continue;
    const list = groups.get(fact.metric);
    if (list) list.push(fact);
    else groups.set(fact.metric, [fact]);
  }
  /** @type {Map<string, any>} */
  const winners = new Map();
  for (const [metric, list] of groups) {
    winners.set(metric, list.slice().sort(compareScoringFacts)[0]);
  }
  return winners;
}

/**
 * Reconcile every fact that describes one exact pair and describe it as a
 * measurement packet.
 *
 * @param {{
 *   candidateId?: string,
 *   identity?: object | null,
 *   billingClass?: string,
 *   role?: string,
 *   facts?: any[],
 *   now?: number,
 *   freshMs?: number | null,
 * }} [input]
 * @returns {object}
 */
export function buildShadowMeasurement(input = {}) {
  const now = asFinite(input.now) ?? Date.now();
  const freshMs = asFinite(input.freshMs);
  const identity = input.identity && typeof input.identity === 'object' ? input.identity : null;
  const matched = identity?.aliasStatus === 'matched';
  const billingClass = normalizeBillingClass(
    input.billingClass ?? (matched ? resolveTelemetryBillingClass({ provider: identity?.provider }) : 'unknown'),
  );
  const context = { now, freshMs };
  /** @type {any[]} */
  const raw = [];
  /** @type {any[]} */
  const scoped = [];
  for (const fact of Array.isArray(input.facts) ? input.facts : []) {
    if (!fact || typeof fact !== 'object') continue;
    // Scope by the exact identity key so a fact for one pair can never leak
    // onto another. An identity without a key (a test double) takes the list
    // as-is; `selectPreferredFacts` still drops an unmatched alias.
    if (identity?.identityKey && fact.identity_key && fact.identity_key !== identity.identityKey) continue;
    raw.push(fact);
    if (factInfluencesRanking(fact)) scoped.push(fact);
  }
  const { selected, ignored } = selectPreferredFacts(scoped);
  /** @type {Map<string, any>} */
  const byMetric = new Map();
  for (const fact of selected) {
    // One winner per `(identity, metric)` from the stage-1 precedence rule.
    if (!byMetric.has(fact.metric)) byMetric.set(fact.metric, fact);
  }
  const diagnostics = reconcileDiagnosticFacts(raw);
  const tokens = describeTokens(diagnostics);
  const cost = matched && billingClass === 'api_metered'
    ? describeCost(byMetric.get('usd'), {
      now,
      freshMs,
      billingClass,
      tokensBilled: tokens ? tokens.billed_tokens : null,
    })
    : null;
  const time = matched
    ? describeTime(byMetric.get('throughput'), byMetric.get('latency_ms'), context)
    : null;
  const quality = describeQuality(byMetric.get('quality'), context);
  const planFact = [...diagnostics.values()].find((fact) => fact.kind === 'plan_usage') || null;
  const planUsage = planFact ? {
    ...labelFact(planFact, context),
    value: planFact.value ?? null,
    utilization: asFinite(planFact.value),
    unit: text(planFact.unit) || 'percent',
  } : null;
  return {
    schema_version: SHADOW_MEASUREMENT_SCHEMA_VERSION,
    candidate_id: text(input.candidateId) || null,
    identity_key: text(identity?.identityKey) || '',
    alias_status: text(identity?.aliasStatus) || 'unmatched',
    matched,
    billing_class: billingClass,
    coverage: {
      cost: coverageOfFact(byMetric.get('usd')),
      time: coverageOfFact(byMetric.get('throughput') || byMetric.get('latency_ms')),
      quality: coverageOfFact(byMetric.get('quality')),
      tokens: tokens ? 'measured' : 'missing',
      plan_usage: coverageOfFact(planFact),
    },
    cost,
    time,
    quality,
    tokens,
    plan_usage: planUsage,
    fact_count: raw.length,
    ignored_count: ignored.length,
  };
}

/**
 * Index facts by `identity_key` once, so a lookup per candidate is O(1) and a
 * pick never iterates the fact list per candidate.
 *
 * @param {any[]} [facts]
 * @returns {Map<string, any[]>}
 */
export function indexFactsByIdentity(facts = []) {
  /** @type {Map<string, any[]>} */
  const index = new Map();
  for (const fact of Array.isArray(facts) ? facts : []) {
    if (!fact || typeof fact !== 'object') continue;
    const key = text(fact.identity_key);
    if (!key) continue;
    const list = index.get(key);
    if (list) list.push(fact);
    else index.set(key, [fact]);
  }
  return index;
}

/**
 * Build one packet per candidate from a flat, bounded fact list.
 *
 * @param {{
 *   candidates?: object[],
 *   facts?: any[],
 *   identityOf?: (input: object) => object,
 *   billingClassOf?: (candidate: object, identity: object) => string,
 *   now?: number,
 *   freshMs?: number | null,
 * }} [input]
 * @returns {Map<string, object>}
 */
export function buildShadowMeasurementIndex(input = {}) {
  const candidates = Array.isArray(input.candidates) ? input.candidates : [];
  const identityOf = typeof input.identityOf === 'function' ? input.identityOf : null;
  const billingClassOf = typeof input.billingClassOf === 'function' ? input.billingClassOf : null;
  const byIdentity = indexFactsByIdentity(input.facts);
  /** @type {Map<string, object>} */
  const packets = new Map();
  for (const candidate of candidates) {
    const harness = text(candidate?.harness).toLowerCase();
    const model = text(candidate?.model);
    const candidateId = harness && model ? `${harness}/${model}` : '';
    if (!candidateId) continue;
    const identity = identityOf ? identityOf({ harness, model }) : null;
    const facts = identity?.identityKey ? (byIdentity.get(identity.identityKey) || []) : [];
    packets.set(candidateId, buildShadowMeasurement({
      candidateId,
      identity,
      billingClass: billingClassOf ? billingClassOf(candidate, identity) : undefined,
      facts,
      now: input.now,
      freshMs: input.freshMs,
    }));
  }
  return packets;
}

/**
 * Build one measured cohort-cost fact for an accepted cycle outside the pick.
 *
 * The caller is responsible for summing the cycle's attempts, failures and
 * fixes (the stage-4 decision/ledger cohort, `sumCycleCohortUsage`) before
 * calling this; the `cohortId` and `partialCoverage` are carried through
 * unchanged so the shadow can show exactly what was summed. A non-`api_metered`
 * pair returns `null`: a subscription/local/unknown pair never receives a
 * fabricated API USD value.
 *
 * @param {{
 *   harness?: unknown,
 *   model?: unknown,
 *   variant?: unknown,
 *   provider?: unknown,
 *   usd?: unknown,
 *   value?: unknown,
 *   reported?: unknown,
 *   billingClass?: unknown,
 *   billing_class?: unknown,
 *   billingMode?: unknown,
 *   cohortId?: unknown,
 *   partialCoverage?: unknown,
 *   attempts?: unknown,
 *   failures?: unknown,
 *   fixes?: unknown,
 *   billedTokens?: unknown,
 *   per?: unknown,
 *   observedAt?: unknown,
 *   fetchedAt?: unknown,
 *   confidence?: unknown,
 *   source?: unknown,
 *   sourceClass?: unknown,
 *   sourceVersion?: unknown,
 * }} [input]
 * @param {{ aliases?: object[], index?: object }} [options]
 * @returns {object | null}
 */
export function buildShadowCycleCostFact(input = {}, options = {}) {
  const billingClass = resolveTelemetryBillingClass(input);
  if (billingClass !== 'api_metered') return null;
  const usd = asFinite(input.usd ?? input.value);
  if (usd == null || usd < 0) return null;
  const reported = input.reported === true;
  const fact = createScoringFact({
    harness: input.harness,
    model: input.model,
    variant: input.variant,
    kind: reported ? 'actual' : 'estimate',
    metric: 'usd',
    unit: 'usd',
    source: text(input.source) || 'usage-ledger',
    sourceClass: reported ? 'provider_actual' : (text(input.sourceClass) || 'ledger_estimate'),
    sourceVersion: text(input.sourceVersion) || 'usage-ledger-2026-10-08',
    observedAt: input.observedAt,
    fetchedAt: input.fetchedAt,
    confidence: input.confidence,
    billingClass,
    value: usd,
  }, options);
  // The identity registry is the gate: an unmatched pair must not carry USD.
  if (!factMayCarryUsd(fact)) return null;
  // Cohort metadata is additive and ignored by the precedence comparator, but
  // it travels with the fact so a measurement stays auditable.
  fact.cohort_id = text(input.cohortId) || null;
  fact.partial_coverage = input.partialCoverage === true;
  fact.attempts = asFinite(input.attempts);
  fact.failures = asFinite(input.failures);
  fact.fixes = asFinite(input.fixes);
  fact.per = text(input.per) || 'cycle';
  fact.billed_tokens = asFinite(input.billedTokens);
  return fact;
}

/**
 * Build the speed facts the pick already has locally, so the shadow can label
 * them with provenance instead of an anonymous `observed` block. Only the
 * throughput the history already measured is emitted; a missing measurement
 * emits no fact and the shadow keeps the existing prior.
 *
 * @param {{
 *   harness?: unknown,
 *   model?: unknown,
 *   variant?: unknown,
 *   observed?: object | null,
 *   role?: unknown,
 * }} [candidate]
 * @param {{
 *   role?: unknown,
 *   source?: unknown,
 *   sourceVersion?: unknown,
 *   observedAt?: unknown,
 *   fetchedAt?: unknown,
 * }} [options]
 * @returns {object[]}
 */
export function buildObservedMeasurementFacts(candidate = {}, options = {}) {
  const observed = candidate.observed && typeof candidate.observed === 'object' ? candidate.observed : null;
  if (!observed) return [];
  const harness = text(candidate.harness);
  const billingClass = resolveTelemetryBillingClass({ harness, provider: candidate.provider });
  const source = text(options.source) || 'model-pick-history';
  const sourceVersion = text(options.sourceVersion) || 'model-pick-history-2026-10-08';
  const base = {
    harness,
    model: candidate.model,
    variant: candidate.variant,
    source,
    sourceClass: 'ledger_estimate',
    sourceVersion,
    observedAt: options.observedAt,
    fetchedAt: options.fetchedAt,
    billingClass,
  };
  const facts = [];
  const throughput = asFinite(observed.median_tokens_per_sec);
  if (throughput != null && throughput > 0) {
    facts.push(createScoringFact({
      ...base,
      kind: 'estimate',
      metric: 'throughput',
      unit: 'tokens_per_second',
      value: throughput,
    }, options));
  }
  const quality = buildTaskQualityTelemetry({
    ...base,
    role: options.role ?? candidate.role,
    n: observed.n,
    decided: observed.n_quality ?? observed.decided,
    passed: observed.passed,
    quality: observed.quality,
    infraFailRate: observed.infra_fail_rate,
    observedAt: options.observedAt,
  }, options);
  facts.push(...quality.facts);
  return facts;
}

/**
 * Build a bounded fact list for a whole candidate set from the history block
 * each candidate already carries. Pure and network-free; used as the default
 * measurement input so every speed signal is provenance-labelled.
 *
 * @param {object[]} [candidates]
 * @param {{ role?: unknown, source?: unknown, sourceVersion?: unknown, observedAt?: unknown }} [options]
 * @returns {object[]}
 */
export function buildObservedMeasurementFactsForCandidates(candidates = [], options = {}) {
  const facts = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    facts.push(...buildObservedMeasurementFacts(candidate, options));
  }
  return facts;
}

/**
 * Compact coverage summary for the explanation: how many candidates had a
 * measured/estimate/missing signal, so a rollout reader can see data coverage
 * without re-reading the fact list.
 *
 * @param {Array<object | null>} [packets]
 * @returns {object}
 */
export function summarizeMeasurementCoverage(packets = []) {
  /** @type {Record<string, Record<string, number>>} */
  const counts = {
    cost: { measured: 0, estimate: 0, heuristic: 0, missing: 0 },
    time: { measured: 0, estimate: 0, heuristic: 0, missing: 0 },
    quality: { measured: 0, estimate: 0, heuristic: 0, missing: 0 },
    tokens: { measured: 0, estimate: 0, heuristic: 0, missing: 0 },
    plan_usage: { measured: 0, estimate: 0, heuristic: 0, missing: 0 },
  };
  let total = 0;
  for (const packet of Array.isArray(packets) ? packets : []) {
    total += 1;
    if (!packet || !packet.coverage) continue;
    for (const signal of Object.keys(counts)) {
      const label = packet.coverage[signal];
      if (counts[signal] && label && counts[signal][label] != null) counts[signal][label] += 1;
    }
  }
  return { total, by_signal: counts };
}
