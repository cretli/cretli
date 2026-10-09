/**
 * Local model+harness telemetry: the stage-2 delta on top of the stage-1 fact
 * schema (`lib/model-facts/schema.js`).
 *
 * ## Inventory boundary (what this module does NOT do)
 * Cretli already measures most of a run. This module adds only the missing
 * delta and never re-derives an existing measurement:
 *
 * - Duration, in/out tokens, tok/s, tool calls, files/lines and the infra prior
 *   already exist on delegation records (`lib/delegation-metrics.js`,
 *   `lib/model-pick-history.js`). They are consumed, never recomputed here.
 * - Cache read/write already live in the usage token bag and are split into
 *   disjoint buckets by `partitionUsageTokens`. {@link buildTokenFacts} only
 *   *labels* those existing buckets as facts (cache read, cache write, uncached
 *   input, output, reasoning, audio) so nothing is counted twice.
 * - USD already comes from `lib/usage/usage-rates.js` and the usage ledger.
 *   {@link buildUsdEstimateFact} never re-prices; it only carries a value that
 *   the ledger already produced and refuses to label it USD unless the exact
 *   pair is a matched `api_metered` endpoint.
 * - Plan utilization and lockouts already exist (`lib/usage/plan-limit-history.js`,
 *   `lib/usage/harness-health.js`, `lib/harness-usage-limits.js`).
 *   {@link buildPlanUsageFact} / {@link buildLimitLink} add the explicit
 *   reference that ties a telemetry record to the reading it came from.
 *
 * ## Provenance is mandatory
 * Every field carries where it came from, what kind of claim it is
 * (`actual` | `estimate` | `plan_usage`) and when it was observed. An estimate
 * is never promoted to an invoice: an `actual` fact needs a provider-reported
 * value, everything Cretli derives stays an `estimate`, and a plan reading is
 * `plan_usage` in plan units and is never converted to USD.
 *
 * ## Quality vs failures
 * Infra and quota failures are counted separately and never enter the quality
 * denominator, so a quota/infra incident cannot lower task quality. The
 * `n/(n+10)` shrink weight uses the *full* task counter `n` — every task,
 * including infra and quota failures — and the infra prior mirrors the values
 * that `lib/model-role-profiles.js` already applies (`w = row.n/(row.n+10)`,
 * `infra_eff = prior*(1-w) + infra_rate*w`); this module only records them for a
 * later shadow scorer and changes no ranking. Review quality is recorded for
 * visibility but flagged `quality_ranking_eligible: false` because the existing
 * rule keeps verdict-based quality out of review scoring.
 *
 * Stratification by task type and effort is deliberately out of scope until
 * there are enough trials; the record carries `role` only, matching the current
 * segmentation level.
 *
 * @typedef {'actual' | 'estimate' | 'plan_usage'} TelemetryFactKind
 * @typedef {'quality' | 'infra' | 'quota' | 'cancel'} TelemetryRunClass
 */

import {
  SCORING_FACT_BILLING_CLASSES,
  SCORING_FACT_SCHEMA_VERSION,
  createScoringFact,
  factMayCarryUsd,
  normalizeBillingClass,
} from './schema.js';
import { resolveModelIdentity } from './identity.js';
import {
  billedTotalTokens,
  partitionUsageTokens,
  resolveUsageProvenance,
} from '../usage/usage-contract.js';

/** Bump when a telemetry field, bucket or classification rule changes. */
export const TELEMETRY_SCHEMA_VERSION = 'model-telemetry-2026-10-08';

/** How an outcome may be classified. Failure classes never touch quality. */
export const TELEMETRY_RUN_CLASSES = Object.freeze(['quality', 'infra', 'quota', 'cancel']);

/**
 * Disjoint token metrics emitted by {@link buildTokenFacts}. The sum of their
 * values (reasoning excluded when it is a non-additive diagnostic) equals
 * `billed_tokens`, which is what keeps cache from being counted twice.
 */
export const TELEMETRY_TOKEN_METRICS = Object.freeze([
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'reasoning_tokens',
  'audio_input_tokens',
  'audio_output_tokens',
]);

/**
 * Half-life of the observed-quality/infra blend. Mirrors
 * `OBSERVED_BLEND_HALF_LIFE` in `lib/model-role-profiles.js`; a contract test
 * guards the two against drift. Telemetry only reports the weight, it does not
 * rank anything.
 */
export const TELEMETRY_SHRINKAGE_HALF_LIFE = 10;

/** Infra score penalty ratio, mirroring `INFRA_SCORE_PENALTY_RATIO`. */
export const TELEMETRY_INFRA_PENALTY_RATIO = 0.5;

/** Providers whose usage is pay-per-use and therefore `api_metered`. */
export const TELEMETRY_METERED_PROVIDERS = Object.freeze([
  'openai',
  'google',
  'azure',
  'openrouter',
]);

/** Harnesses whose cost is a prepaid subscription, not a metered API key. */
export const TELEMETRY_SUBSCRIPTION_HARNESSES = Object.freeze(['sdk']);

/** Providers whose tokens are billed against a subscription plan. */
export const TELEMETRY_SUBSCRIPTION_PROVIDERS = Object.freeze(['cursor']);

/** Providers that run on local hardware and have no provider charge. */
export const TELEMETRY_LOCAL_PROVIDERS = Object.freeze(['local', 'ollama', 'lmstudio']);

const BILLING_CLASS_SET = new Set(SCORING_FACT_BILLING_CLASSES);
const RUN_CLASS_SET = new Set(TELEMETRY_RUN_CLASSES);
const METERED_PROVIDER_SET = new Set(TELEMETRY_METERED_PROVIDERS);
const SUBSCRIPTION_HARNESS_SET = new Set(TELEMETRY_SUBSCRIPTION_HARNESSES);
const SUBSCRIPTION_PROVIDER_SET = new Set(TELEMETRY_SUBSCRIPTION_PROVIDERS);
const LOCAL_PROVIDER_SET = new Set(TELEMETRY_LOCAL_PROVIDERS);

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
 * @returns {number | null}
 */
function asFiniteNumber(value) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function asCount(value) {
  const numeric = asFiniteNumber(value);
  if (numeric == null || numeric < 0) return 0;
  return Math.round(numeric);
}

/**
 * @param {number} value
 * @returns {number}
 */
function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

/**
 * @param {unknown} value
 * @param {TelemetryRunClass} [fallback]
 * @returns {TelemetryRunClass}
 */
export function normalizeTelemetryRunClass(value, fallback = 'quality') {
  const id = lower(value);
  return RUN_CLASS_SET.has(id) ? /** @type {TelemetryRunClass} */ (id) : fallback;
}

/**
 * Classify how a run is billed. An explicit `billingClass` always wins; then a
 * prepaid `billingMode`; then the known subscription harnesses/providers; then
 * local hardware; then a provider-reported charge (a prepaid plan never reports
 * a marginal cost), then the pay-per-use providers. Anything else stays
 * `unknown` and may never carry USD.
 *
 * @param {{
 *   billingClass?: unknown,
 *   billing_class?: unknown,
 *   billingMode?: unknown,
 *   reportedUsd?: unknown,
 *   harness?: unknown,
 *   provider?: unknown,
 *   local?: unknown,
 * }} [input]
 * @returns {'api_metered' | 'subscription_quota' | 'local' | 'unknown'}
 */
export function resolveTelemetryBillingClass(input = {}) {
  const declared = lower(input.billingClass ?? input.billing_class);
  if (BILLING_CLASS_SET.has(declared)) {
    return /** @type {'api_metered'|'subscription_quota'|'local'|'unknown'} */ (declared);
  }
  const billingMode = lower(input.billingMode);
  if (billingMode === 'subscription') return 'subscription_quota';
  if (billingMode === 'local' || input.local === true) return 'local';
  const harness = lower(input.harness);
  const provider = lower(input.provider);
  if (SUBSCRIPTION_HARNESS_SET.has(harness) || SUBSCRIPTION_PROVIDER_SET.has(provider)) {
    return 'subscription_quota';
  }
  if (LOCAL_PROVIDER_SET.has(provider)) return 'local';
  // A provider-reported marginal charge is metered by definition: a prepaid
  // plan never reports one (Claude subscription returns before pricing).
  const reported = asFiniteNumber(input.reportedUsd);
  if (reported != null && reported >= 0) return 'api_metered';
  if (METERED_PROVIDER_SET.has(provider)) return 'api_metered';
  return 'unknown';
}

/**
 * Only `api_metered` may carry a USD cost. A subscription plan, local hardware
 * or an unknown billing relationship has no marginal API charge.
 *
 * @param {unknown} billingClass
 * @returns {boolean}
 */
export function billingClassAllowsUsd(billingClass) {
  return normalizeBillingClass(billingClass) === 'api_metered';
}

/**
 * Provenance → fact kind. A provider-reported measurement is `actual`; a
 * derived or unknown one is an `estimate` (never a fact/invoice).
 *
 * @param {unknown} provenance
 * @returns {'actual' | 'estimate'}
 */
function kindFromProvenance(provenance) {
  return lower(provenance) === 'reported' ? 'actual' : 'estimate';
}

/**
 * @param {'actual' | 'estimate'} kind
 * @returns {'provider_actual' | 'ledger_estimate'}
 */
function sourceClassForKind(kind) {
  return kind === 'actual' ? 'provider_actual' : 'ledger_estimate';
}

/**
 * Turn the already-disjoint token buckets of one usage event into facts.
 *
 * The buckets come from `partitionUsageTokens`, so cache read/write are
 * subtracted from the input counter exactly once and reasoning is subtracted
 * from output when the harness reports it as a subset. A zero bucket emits no
 * fact (absent is not zero); the returned `billed_tokens` is the additive total
 * and equals the sum of the emitted fact values.
 *
 * @param {{
 *   harness?: unknown,
 *   model?: unknown,
 *   variant?: unknown,
 *   tokens?: object,
 *   at?: unknown,
 *   source?: unknown,
 *   sourceVersion?: unknown,
 *   normalizationVersion?: unknown,
 *   contractRevision?: unknown,
 *   provenance?: unknown,
 *   estimated?: unknown,
 *   reportedUsd?: unknown,
 *   billingClass?: unknown,
 *   billingMode?: unknown,
 *   provider?: unknown,
 * }} [event]
 * @param {{
 *   source?: string,
 *   sourceVersion?: string,
 *   fetchedAt?: unknown,
 *   aliases?: object[],
 *   index?: object,
 * }} [options]
 * @returns {{
 *   facts: object[],
 *   buckets: {
 *     inputWithoutCache: number,
 *     outputWithoutReasoning: number,
 *     cacheRead: number,
 *     cacheWrite: number,
 *     reasoning: number,
 *     reasoningDiagnostic: boolean,
 *     audioInput: number,
 *     audioOutput: number,
 *   },
 *   billed_tokens: number,
 * }}
 */
export function buildTokenFacts(event = {}, options = {}) {
  const harness = text(event.harness);
  const tokenBag = event.tokens && typeof event.tokens === 'object' ? event.tokens : {};
  const buckets = partitionUsageTokens(tokenBag, harness);
  const provenance = resolveUsageProvenance({ ...event, harness });
  const kind = kindFromProvenance(provenance);
  const billingClass = resolveTelemetryBillingClass({ ...event, harness });
  const source = text(options.source) || text(event.source) || 'usage-ledger';
  const sourceVersion = text(options.sourceVersion)
    || text(event.sourceVersion)
    || text(event.normalizationVersion)
    || text(event.contractRevision);
  const observedAt = event.at;
  const fetchedAt = options.fetchedAt ?? observedAt;
  const values = {
    input_tokens: buckets.inputWithoutCache,
    output_tokens: buckets.outputWithoutReasoning,
    cache_read_tokens: buckets.cacheRead,
    cache_write_tokens: buckets.cacheWrite,
    reasoning_tokens: buckets.reasoningDiagnostic ? 0 : buckets.reasoning,
    audio_input_tokens: buckets.audioInput,
    audio_output_tokens: buckets.audioOutput,
  };
  const facts = [];
  for (const metric of TELEMETRY_TOKEN_METRICS) {
    const value = values[metric];
    if (!(value > 0)) continue;
    facts.push(createScoringFact({
      harness,
      model: event.model,
      variant: event.variant,
      kind,
      metric,
      unit: 'tokens',
      source,
      sourceClass: sourceClassForKind(kind),
      sourceVersion,
      observedAt,
      fetchedAt,
      billingClass,
      value,
    }, options));
  }
  return {
    facts,
    buckets,
    billed_tokens: billedTotalTokens(tokenBag, harness),
  };
}

/**
 * Carry the USD value the usage ledger already produced, but only for a
 * matched `api_metered` pair. A subscription/local/unknown pair returns `null`
 * (no USD fact at all — never USD 0); an unmatched alias returns `null` because
 * stage-1 identity is the gate. A provider-reported value becomes an `actual`
 * fact, a rate-table value stays an `estimate`.
 *
 * @param {{
 *   harness?: unknown,
 *   model?: unknown,
 *   variant?: unknown,
 *   provider?: unknown,
 *   reportedUsd?: unknown,
 *   usd?: unknown,
 *   estimated?: unknown,
 *   billingClass?: unknown,
 *   billing_class?: unknown,
 *   billingMode?: unknown,
 *   at?: unknown,
 *   source?: unknown,
 *   sourceVersion?: unknown,
 * }} [input]
 * @param {{
 *   source?: string,
 *   sourceVersion?: string,
 *   sourceClass?: string,
 *   fetchedAt?: unknown,
 *   aliases?: object[],
 *   index?: object,
 * }} [options]
 * @returns {object | null}
 */
export function buildUsdEstimateFact(input = {}, options = {}) {
  const billingClass = resolveTelemetryBillingClass(input);
  if (!billingClassAllowsUsd(billingClass)) return null;
  const reported = asFiniteNumber(input.reportedUsd);
  const estimated = asFiniteNumber(input.usd);
  const hasReported = reported != null && reported >= 0;
  const hasEstimated = estimated != null && estimated >= 0;
  if (!hasReported && !hasEstimated) return null;
  const fact = createScoringFact({
    harness: input.harness,
    model: input.model,
    variant: input.variant,
    kind: hasReported ? 'actual' : 'estimate',
    metric: 'usd',
    unit: 'usd',
    source: text(options.source) || text(input.source) || 'usage-ledger',
    sourceClass: hasReported
      ? 'provider_actual'
      : text(options.sourceClass) || text(input.sourceClass) || 'ledger_estimate',
    sourceVersion: text(options.sourceVersion) || text(input.sourceVersion),
    observedAt: input.at,
    fetchedAt: options.fetchedAt ?? input.at,
    billingClass,
    value: hasReported ? reported : estimated,
  }, options);
  // The identity registry is the gate: an unmatched pair must not receive a
  // USD estimate even though the ledger computed one for the raw model name.
  if (!factMayCarryUsd(fact)) return null;
  return fact;
}

/**
 * Stable reference of one plan-usage reading, so a telemetry record can point
 * back at exactly the sample it used instead of re-deriving it.
 *
 * @param {{
 *   harness?: unknown,
 *   model?: unknown,
 *   rateLimitType?: unknown,
 *   resetsAt?: unknown,
 *   observedAt?: unknown,
 * }} [reading]
 * @returns {string}
 */
export function planUsageRef(reading = {}) {
  const harness = lower(reading.harness);
  if (!harness) return '';
  return [
    'plan_usage',
    harness,
    lower(reading.model) || '*',
    text(reading.rateLimitType) || 'all',
    text(reading.resetsAt) || 'none',
    text(reading.observedAt) || 'unknown',
  ].join('|');
}

/**
 * A plan-usage fact from an existing plan-limit reading. The reading is
 * provider-reported but is reported in **plan units** (percent utilization or a
 * status), so it is `plan_usage` and `factMayCarryUsd` can never be true for
 * it. Returns `null` when the reading carries neither utilization nor a status.
 *
 * @param {{
 *   harness?: unknown,
 *   model?: unknown,
 *   utilization?: unknown,
 *   status?: unknown,
 *   rateLimitType?: unknown,
 *   resetsAt?: unknown,
 *   observedAt?: unknown,
 *   source?: unknown,
 *   sourceVersion?: unknown,
 * }} [reading]
 * @param {{ fetchedAt?: unknown, aliases?: object[], index?: object }} [options]
 * @returns {object | null}
 */
export function buildPlanUsageFact(reading = {}, options = {}) {
  const harness = lower(reading.harness);
  if (!harness) return null;
  const utilization = asFiniteNumber(reading.utilization);
  const status = text(reading.status);
  const rateLimitType = text(reading.rateLimitType);
  if (utilization == null && !status && !rateLimitType) return null;
  const hasUtilization = utilization != null;
  const observedAt = reading.observedAt;
  return createScoringFact({
    factId: planUsageRef(reading),
    harness,
    model: reading.model,
    kind: 'plan_usage',
    metric: hasUtilization ? 'plan_utilization' : 'plan_signal',
    unit: hasUtilization ? 'percent' : 'state',
    source: text(reading.source) || 'plan-limit-history',
    // The provider measured this reading; the kind (plan_usage) is what keeps
    // it out of any USD group, not a different source class.
    sourceClass: 'provider_actual',
    sourceVersion: text(reading.sourceVersion) || 'plan-limit-2026-10-08',
    observedAt,
    fetchedAt: options.fetchedAt ?? observedAt,
    billingClass: 'subscription_quota',
    value: hasUtilization ? utilization : (status || rateLimitType),
  }, options);
}

/**
 * Explicit link from a telemetry record to the plan usage / lockout row it was
 * built from. A plan reading keeps its `plan_usage` fact id; a lockout has no
 * usage fact, only the binary block reference.
 *
 * ## Contract for stage 4
 * `input.lockout` (see {@link buildModelHarnessTelemetry}) is the **binary
 * lockout record from the limit store**, i.e. the shape `appendLimitHistory`
 * writes in `lib/harness-usage-limits.js`: `{ resetAt, code, detectedAt/ts }`
 * with no plan-reading fields. It must **not** be a row of
 * `lib/usage/plan-limit-history.js`: every such row carries an `observedAt`
 * (see `buildHistoryRow`), so it classifies as `plan_usage` here — and that is
 * correct, because the producer calls the `status: 'rejected'` row it writes
 * "a rejected reading" (a plan signal), not a binary lockout. The
 * `observedAt`/`rateLimitType` clauses of the plan branch therefore exist to
 * keep a real plan reading on the `plan_usage` side and are pinned by tests.
 *
 * @param {{
 *   harness?: unknown,
 *   model?: unknown,
 *   utilization?: unknown,
 *   status?: unknown,
 *   rateLimitType?: unknown,
 *   resetsAt?: unknown,
 *   observedAt?: unknown,
 *   resetAt?: unknown,
 *   code?: unknown,
 * }} [reading]
 * @param {{ fetchedAt?: unknown, aliases?: object[], index?: object }} [options]
 * @returns {{
 *   kind: 'plan_usage' | 'lockout',
 *   ref: string,
 *   harness: string,
 *   model: string,
 *   utilization: number | null,
 *   unit: string,
 *   observed_at: string | null,
 *   resets_at: string | null,
 *   status: string,
 *   fact_id: string | null,
 * } | null}
 */
export function buildLimitLink(reading = {}, options = {}) {
  const harness = lower(reading.harness);
  if (!harness) return null;
  const isPlan = reading.utilization != null || reading.observedAt != null || reading.rateLimitType != null;
  if (isPlan) {
    const fact = buildPlanUsageFact(reading, options);
    return {
      kind: 'plan_usage',
      ref: planUsageRef(reading),
      harness,
      model: lower(reading.model),
      utilization: asFiniteNumber(reading.utilization),
      unit: 'percent',
      observed_at: text(reading.observedAt) || null,
      resets_at: text(reading.resetsAt) || null,
      status: text(reading.status),
      fact_id: fact ? fact.fact_id : null,
    };
  }
  const resetAt = text(reading.resetAt);
  const code = text(reading.code);
  return {
    kind: 'lockout',
    ref: ['lockout', harness, lower(reading.model) || '*', resetAt || 'none', code || 'unknown'].join('|'),
    harness,
    model: lower(reading.model),
    utilization: null,
    unit: 'state',
    observed_at: text(reading.observedAt) || text(reading.detectedAt) || null,
    resets_at: resetAt || null,
    status: code,
    fact_id: null,
  };
}

/**
 * Quality telemetry that keeps failures out of the quality denominator.
 *
 * `decided`/`passed` describe only jobs that could be judged (non-infra,
 * non-quota). Infra and quota failures are counted on their own, so adding
 * either leaves `quality`, `quality_rate` and `n_quality` unchanged while it
 * raises `infra_rate`/`quota_rate`. The `n/(n+10)` shrink weight uses the full
 * task counter `n` (every task, infra/quota included) and the infra prior
 * mirrors `lib/model-role-profiles.js` (`w = row.n/(row.n+10)`,
 * `infra_eff = prior*(1-w) + infra_rate*w`); nothing here changes a ranking, and
 * `quality_ranking_eligible` is false for `review` because the existing rule
 * keeps verdict-based quality out of review scoring.
 *
 * `n` semantics: a finite `n >= 0` from the caller always wins, *including an
 * explicit `n: 0`*; only a missing/non-finite `n` falls back to
 * `decided + infraFails + quotaFails`. Callers are expected to pass `n` already
 * consistent with that sum, so the two values agree; the explicit `0` case is
 * preserved rather than silently overridden by the fallback.
 *
 * @param {{
 *   harness?: unknown,
 *   model?: unknown,
 *   variant?: unknown,
 *   role?: unknown,
 *   n?: unknown,
 *   decided?: unknown,
 *   passed?: unknown,
 *   infraFails?: unknown,
 *   quotaFails?: unknown,
 *   quality?: unknown,
 *   infraFailRate?: unknown,
 *   priorInfra?: unknown,
 *   observedAt?: unknown,
 *   source?: unknown,
 *   sourceVersion?: unknown,
 *   billingClass?: unknown,
 *   billingMode?: unknown,
 *   provider?: unknown,
 * }} [input]
 * @param {{ fetchedAt?: unknown, aliases?: object[], index?: object }} [options]
 * @returns {{
 *   facts: object[],
 *   quality: number | null,
 *   quality_rate: number | null,
 *   quality_ranking_eligible: boolean,
 *   n: number,
 *   n_quality: number,
 *   infra_fails: number,
 *   quota_fails: number,
 *   infra_rate: number,
 *   quota_rate: number,
 *   shrink_weight: number,
 *   infra_eff: number,
 * }}
 */
export function buildTaskQualityTelemetry(input = {}, options = {}) {
  const role = lower(input.role) || 'implement';
  const decided = asCount(input.decided);
  const passed = Math.min(asCount(input.passed), decided);
  const infraFails = asCount(input.infraFails);
  const quotaFails = asCount(input.quotaFails);
  // A finite `n >= 0` wins, including an explicit 0; only a missing/non-finite
  // `n` falls back to the decided + infra + quota sum.
  const explicitN = asFiniteNumber(input.n);
  const n = explicitN != null && explicitN >= 0
    ? Math.round(explicitN)
    : (decided + infraFails + quotaFails);
  const infraRate = asFiniteNumber(input.infraFailRate)
    ?? (n > 0 ? infraFails / n : 0);
  const quotaRate = n > 0 ? quotaFails / n : 0;
  const qualityRate = decided > 0 ? clamp01(passed / decided) : null;
  const explicitQuality = asFiniteNumber(input.quality);
  const quality = explicitQuality != null
    ? explicitQuality
    : (qualityRate == null ? null : 1 + (4 * qualityRate));
  // Full task counter, exactly like `row.n` in `lib/model-role-profiles.js`
  // (`w = row.n/(row.n+OBSERVED_BLEND_HALF_LIFE)`), never `decided` alone.
  const shrinkWeight = n / (n + TELEMETRY_SHRINKAGE_HALF_LIFE);
  const priorInfra = clamp01(asFiniteNumber(input.priorInfra) ?? 0);
  const infraEff = (priorInfra * (1 - shrinkWeight)) + (clamp01(infraRate) * shrinkWeight);
  const billingClass = resolveTelemetryBillingClass(input);
  const source = text(input.source) || 'model-pick-history';
  const sourceVersion = text(input.sourceVersion) || 'model-pick-history-2026-10-08';
  const observedAt = input.observedAt;
  const base = {
    harness: input.harness,
    model: input.model,
    variant: input.variant,
    source,
    sourceClass: 'ledger_estimate',
    sourceVersion,
    observedAt,
    fetchedAt: options.fetchedAt ?? observedAt,
    billingClass,
  };
  const facts = [];
  if (n > 0) {
    // Derived from ledger counts, so `kindFromProvenance` in this module makes
    // the rate an estimate even though the underlying counts were reported;
    // `source_class` stays `ledger_estimate`.
    facts.push(createScoringFact({
      ...base,
      kind: 'estimate',
      metric: 'infra_fail_rate',
      unit: 'ratio',
      value: clamp01(infraRate),
    }, options));
    if (quotaFails > 0) {
      facts.push(createScoringFact({
        ...base,
        kind: 'estimate',
        metric: 'quota_fail_rate',
        unit: 'ratio',
        value: clamp01(quotaRate),
      }, options));
    }
  }
  if (quality != null && decided > 0) {
    facts.push(createScoringFact({
      ...base,
      kind: 'estimate',
      metric: 'quality',
      unit: 'score',
      value: quality,
    }, options));
  }
  return {
    facts,
    quality,
    quality_rate: qualityRate,
    // Review quality is recorded for visibility only; verdict PASS share must
    // not become a review quality score.
    quality_ranking_eligible: role !== 'review',
    n,
    n_quality: decided,
    infra_fails: infraFails,
    quota_fails: quotaFails,
    infra_rate: clamp01(infraRate),
    quota_rate: clamp01(quotaRate),
    shrink_weight: shrinkWeight,
    infra_eff: clamp01(infraEff),
  };
}

/**
 * Compose one telemetry record for an exact `(harness, model, variant)` pair
 * from already-collected local data. The record is additive provenance in
 * front of the existing stores; it selects nothing and changes no pick.
 *
 * Record-level `billing_class` is a **temporary classification from identity**
 * when there is no usage event: with no event there is no proof of a charge, so
 * the class falls back to the resolved identity `provider` (a metered provider
 * reads `api_metered`). Only the per-USD-fact gate in
 * {@link buildUsdEstimateFact} proves a charge; this record-level value is a
 * display/telemetry hint, not an invoice.
 *
 * @param {{
 *   harness?: unknown,
 *   model?: unknown,
 *   variant?: unknown,
 *   usageEvent?: object,
 *   planReading?: object,
 *   lockout?: object,
 *   outcome?: object,
 *   runClass?: unknown,
 *   observedAt?: unknown,
 *   fetchedAt?: unknown,
 * }} [input]
 * @param {{ aliases?: object[], index?: object }} [options]
 * @returns {{
 *   schema_version: string,
 *   telemetry_version: string,
 *   harness: string,
 *   model: string,
 *   variant: string,
 *   identity_key: string,
 *   alias_status: string,
 *   alias_reason: string,
 *   provider: string | null,
 *   provider_endpoint: string | null,
 *   external_model_id: string | null,
 *   billing_class: string,
 *   run_class: TelemetryRunClass,
 *   observed_at: string | null,
 *   fetched_at: string | null,
 *   facts: object[],
 *   token_buckets: object | null,
 *   billed_tokens: number | null,
 *   usd_fact_id: string | null,
 *   limit_ref: string | null,
 *   plan_usage_fact_id: string | null,
 *   quality: object | null,
 * }}
 */
export function buildModelHarnessTelemetry(input = {}, options = {}) {
  const identity = resolveModelIdentity(
    { harness: input.harness, model: input.model, variant: input.variant },
    options,
  );
  const harness = identity.harness;
  const model = identity.model;
  const variant = identity.variant;
  const observedAt = input.observedAt ?? input.usageEvent?.at ?? input.planReading?.observedAt
    ?? input.outcome?.observedAt ?? null;
  const fetchedAt = input.fetchedAt ?? observedAt;
  const usageEvent = input.usageEvent && typeof input.usageEvent === 'object' ? input.usageEvent : null;
  const facts = [];
  let tokenBuckets = null;
  let billedTokens = null;
  if (usageEvent) {
    const tokenResult = buildTokenFacts(
      { ...usageEvent, harness, model, variant },
      { ...options, fetchedAt },
    );
    facts.push(...tokenResult.facts);
    tokenBuckets = tokenResult.buckets;
    billedTokens = tokenResult.billed_tokens;
    const usdFact = buildUsdEstimateFact(
      { ...usageEvent, harness, model, variant },
      { ...options, fetchedAt },
    );
    if (usdFact) facts.push(usdFact);
  }
  const planReading = input.planReading && typeof input.planReading === 'object' ? input.planReading : null;
  const planFact = planReading
    ? buildPlanUsageFact({ ...planReading, harness, model }, { ...options, fetchedAt })
    : null;
  if (planFact) facts.push(planFact);
  const limitLink = input.lockout && typeof input.lockout === 'object'
    ? buildLimitLink({ ...input.lockout, harness, model }, { ...options, fetchedAt })
    : (planReading ? buildLimitLink({ ...planReading, harness, model }, { ...options, fetchedAt }) : null);
  const outcome = input.outcome && typeof input.outcome === 'object' ? input.outcome : null;
  const quality = outcome
    ? buildTaskQualityTelemetry(
      { ...outcome, harness, model, variant, observedAt },
      { ...options, fetchedAt },
    )
    : null;
  if (quality) facts.push(...quality.facts);
  const usdFact = facts.find((fact) => fact && fact.metric === 'usd') || null;
  return {
    schema_version: facts[0]?.schema_version || SCORING_FACT_SCHEMA_VERSION,
    telemetry_version: TELEMETRY_SCHEMA_VERSION,
    harness,
    model,
    variant,
    identity_key: identity.identityKey,
    alias_status: identity.aliasStatus,
    alias_reason: identity.aliasReason,
    provider: identity.provider,
    provider_endpoint: identity.endpoint,
    external_model_id: identity.externalModelId,
    billing_class: resolveTelemetryBillingClass({
      ...(usageEvent || {}),
      harness,
      provider: usageEvent?.provider ?? identity.provider,
    }),
    run_class: normalizeTelemetryRunClass(input.runClass ?? outcome?.runClass),
    observed_at: observedAt,
    fetched_at: fetchedAt,
    facts,
    token_buckets: tokenBuckets,
    billed_tokens: billedTokens,
    usd_fact_id: usdFact ? usdFact.fact_id : null,
    limit_ref: limitLink ? limitLink.ref : null,
    plan_usage_fact_id: planFact ? planFact.fact_id : null,
    quality,
  };
}
