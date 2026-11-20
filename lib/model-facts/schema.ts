/**
 * Versioned schema for one scoring/usage fact.
 *
 * Stage 1 of the model quality/cost plan (`2584cd05`). A fact is a single
 * observation about one exact Cretli `(harness, model, variant)` pair: what was
 * measured, by which source, when, how confident the source is, and how it is
 * billed. Stage 3/4 feed facts into shadow scoring from these records; nothing
 * in this module ranks models or selects candidates.
 *
 * ## Inventory boundary (what this module is NOT)
 * Cretli already has the mechanisms below. This schema is additive metadata in
 * front of them and must never become a second copy:
 *
 * - `lib/usage/usage-event.js` + `lib/usage/usage-contract.js` — measured token
 *   usage, `provenance` (`reported`/`estimated`/`unknown`) and identity class.
 *   A usage fact wraps one of these; it does not re-normalize tokens.
 * - `lib/usage/usage-rates.js` — the static per-model price table. A catalog
 *   price fact carries its output; it does not re-implement pricing.
 * - `lib/providers/openrouter/openrouter-models.ts` — the existing OpenRouter fetcher
 *   (stage 3 extends it; stage 1 only names the source class).
 * - `lib/model-role-profiles.js` — role weights, observed quality blend and the
 *   infra prior. Quality facts feed that blend; they do not replace it.
 * - `lib/model-alias-policy.js` — name/family eligibility. Identity here is an
 *   exact endpoint mapping, not a name match.
 *
 * ## Candidate gate
 * `SCORING_FACT_CANDIDATE_GATE` is `favorites`: Settings favorites remain the
 * only candidate gate. This module has no `candidates` field and exports no
 * candidate builder; `selectPreferredFacts` only reconciles facts that already
 * describe one known pair.
 *
 * ## USD rule
 * Only `api_metered` may carry a `usd` metric. `subscription_quota` and `local`
 * have no marginal API cost, and `plan_usage` is reported in its own units and
 * is never converted to USD. {@link factMayCarryUsd} enforces this and
 * {@link selectPreferredFacts} drops a non-metered `usd` fact instead of
 * picking it.
 *
 * ## Versioning
 * Every fact carries `schema_version` (this module) and `source_version` (the
 * payload/table version it came from), plus `observed_at` and `fetched_at`.
 * `observed_at` is when the provider measured the value; `fetched_at` is when
 * Cretli last read the source. Neither may be inferred from the other.
 */

import {
  ALIAS_STATUSES,
  resolveModelIdentity,
} from './identity.ts';
import type { ModelIdentityAliasRow, ModelIdentityIndex } from './identity.ts';

export type ScoringFactKind = 'actual' | 'estimate' | 'plan_usage' | 'benchmark';
export type ScoringFactBillingClass = 'api_metered' | 'subscription_quota' | 'local' | 'unknown';
export type ScoringFactSourceClass = 'provider_actual' | 'ledger_estimate' | 'endpoint_catalog' | 'heuristic';

export interface ScoringFactInput {
  kind?: unknown;
  metric?: unknown;
  unit?: unknown;
  source?: unknown;
  sourceClass?: unknown;
  sourceVersion?: unknown;
  observedAt?: unknown;
  fetchedAt?: unknown;
  confidence?: unknown;
  billingClass?: unknown;
  harness?: unknown;
  model?: unknown;
  variant?: unknown;
  value?: unknown;
  factId?: unknown;
}

export interface ScoringFact {
  fact_id: string;
  schema_version: string;
  kind: ScoringFactKind;
  metric: string;
  unit: string;
  source: string;
  source_class: ScoringFactSourceClass;
  source_version: string;
  observed_at: string | null;
  fetched_at: string | null;
  confidence: number;
  billing_class: ScoringFactBillingClass;
  harness: string;
  model: string;
  variant: string;
  identity_key: string;
  provider: string | null;
  provider_endpoint: string | null;
  external_model_id: string | null;
  alias_status: 'matched' | 'unmatched';
  alias_reason: string;
  ranking_eligible: boolean;
  value: unknown;
}

/** Bump when a fact field, an enum or a precedence rule changes. */
export const SCORING_FACT_SCHEMA_VERSION = 'scoring-fact-2026-10-08';

/** Kinds of fact the ranking input may carry. */
export const SCORING_FACT_KINDS: readonly ScoringFactKind[] = Object.freeze([
  'actual',
  'estimate',
  'plan_usage',
  'benchmark',
]);

/** How the pair is billed. Independent of `kind` and of the harness. */
export const SCORING_FACT_BILLING_CLASSES: readonly ScoringFactBillingClass[] = Object.freeze([
  'api_metered',
  'subscription_quota',
  'local',
  'unknown',
]);

/**
 * Cost source classes in strict precedence order, best first:
 *
 * 1. `provider_actual` — a provider-reported charge or invoice for the pair.
 * 2. `ledger_estimate` — Cretli's own ledger estimate for the exact pair.
 * 3. `endpoint_catalog` — the endpoint's published price (metered API only).
 * 4. `heuristic` — a static default. Also the safe default for an undeclared
 *    source, so an unknown source can never outrank a measured one.
 */
export const SCORING_FACT_SOURCE_CLASSES: readonly ScoringFactSourceClass[] = Object.freeze([
  'provider_actual',
  'ledger_estimate',
  'endpoint_catalog',
  'heuristic',
]);

/** Known metric labels. A metric outside this list is allowed but unclaimed. */
export const SCORING_FACT_METRICS = Object.freeze([
  'usd',
  'tokens',
  'latency_ms',
  'throughput',
  'quality',
]);

/** Settings favorites are the candidate gate; this schema never adds one. */
export const SCORING_FACT_CANDIDATE_GATE = 'favorites';

const KIND_SET = new Set<string>(SCORING_FACT_KINDS);
const BILLING_CLASS_SET = new Set<string>(SCORING_FACT_BILLING_CLASSES);
const SOURCE_CLASS_SET = new Set<string>(SCORING_FACT_SOURCE_CLASSES);

const SOURCE_CLASS_RANK: Record<string, number> = Object.freeze(
  SCORING_FACT_SOURCE_CLASSES.reduce((acc: Record<string, number>, key, index) => {
    acc[key] = index;
    return acc;
  }, {}),
);

/** Default confidence per kind when the caller does not state one. */
const DEFAULT_CONFIDENCE: Readonly<Record<ScoringFactKind, number>> = Object.freeze({
  actual: 1,
  estimate: 0.5,
  plan_usage: 1,
  benchmark: 0.7,
});

/** Default unit per metric when the caller does not state one. */
const DEFAULT_UNIT: Readonly<Record<string, string>> = Object.freeze({
  usd: 'usd',
  tokens: 'tokens',
  latency_ms: 'ms',
  throughput: 'tokens_per_second',
  quality: 'score',
});

export function normalizeScoringFactKind(value: unknown): ScoringFactKind {
  const kind = String(value ?? '').trim().toLowerCase();
  return KIND_SET.has(kind) ? (kind as ScoringFactKind) : 'estimate';
}

export function normalizeBillingClass(value: unknown): ScoringFactBillingClass {
  const billing = String(value ?? '').trim().toLowerCase();
  return BILLING_CLASS_SET.has(billing) ? (billing as ScoringFactBillingClass) : 'unknown';
}

export function normalizeSourceClass(value: unknown): ScoringFactSourceClass {
  const sourceClass = String(value ?? '').trim().toLowerCase();
  return SOURCE_CLASS_SET.has(sourceClass)
    ? (sourceClass as ScoringFactSourceClass)
    : 'heuristic';
}

function clampConfidence(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

function toIsoTimestamp(value: unknown, fallback: unknown = null): string | null {
  if (value == null || value === '') {
    if (fallback == null || fallback === '') return null;
    return toIsoTimestamp(fallback, null);
  }
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  const numeric = typeof value === 'number' ? value : Number.NaN;
  if (Number.isFinite(numeric)) {
    const fromNumber = new Date(numeric);
    return Number.isFinite(fromNumber.getTime()) ? fromNumber.toISOString() : null;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function timestampRank(value: unknown): number {
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : -Infinity;
}

/**
 * Build one normalized fact. Never throws on partial input: a fact with a
 * missing or unmatched identity is still returned so a caller can count alias
 * coverage, but it is stamped `ranking_eligible: false` and the reconciliation
 * helpers will drop it.
 *
 * An `aliasStatus` passed by the caller is ignored on purpose — identity is the
 * registry's verdict, not a field a caller may assert.
 *
 * @param {{
 *   kind?: unknown,
 *   metric?: unknown,
 *   unit?: unknown,
 *   source?: unknown,
 *   sourceClass?: unknown,
 *   sourceVersion?: unknown,
 *   observedAt?: unknown,
 *   fetchedAt?: unknown,
 *   confidence?: unknown,
 *   billingClass?: unknown,
 *   harness?: unknown,
 *   model?: unknown,
 *   variant?: unknown,
 *   value?: unknown,
 *   factId?: unknown,
 * }} [input]
 * @param {{
 *   aliases?: import('./identity.js').ModelIdentityAliasRow[],
 *   index?: ReturnType<typeof import('./identity.js').buildModelIdentityIndex>,
 * }} [options]
 * @returns {{
 *   fact_id: string,
 *   schema_version: string,
 *   kind: ScoringFactKind,
 *   metric: string,
 *   unit: string,
 *   source: string,
 *   source_class: ScoringFactSourceClass,
 *   source_version: string,
 *   observed_at: string | null,
 *   fetched_at: string | null,
 *   confidence: number,
 *   billing_class: ScoringFactBillingClass,
 *   harness: string,
 *   model: string,
 *   variant: string,
 *   identity_key: string,
 *   provider: string | null,
 *   provider_endpoint: string | null,
 *   external_model_id: string | null,
 *   alias_status: 'matched' | 'unmatched',
 *   alias_reason: string,
 *   ranking_eligible: boolean,
 *   value: unknown,
 * }}
 */
export function createScoringFact(
  input: ScoringFactInput = {},
  options: { aliases?: ModelIdentityAliasRow[]; index?: ModelIdentityIndex } = {},
): ScoringFact {
  const identity = resolveModelIdentity(
    { harness: input.harness, model: input.model, variant: input.variant },
    options,
  );
  const kind = normalizeScoringFactKind(input.kind);
  const metric = String(input.metric ?? '').trim().toLowerCase() || 'unspecified';
  const source = String(input.source ?? '').trim() || 'unknown';
  const observedAt = toIsoTimestamp(input.observedAt);
  const fetchedAt = toIsoTimestamp(input.fetchedAt, observedAt);
  const factId = String(input.factId ?? '').trim()
    || [
      identity.identityKey,
      kind,
      metric,
      source,
      observedAt ?? 'no-observed-at',
    ].join('|');
  return {
    fact_id: factId,
    schema_version: SCORING_FACT_SCHEMA_VERSION,
    kind,
    metric,
    unit: String(input.unit ?? '').trim() || DEFAULT_UNIT[metric] || '',
    source,
    source_class: normalizeSourceClass(input.sourceClass),
    source_version: String(input.sourceVersion ?? '').trim(),
    observed_at: observedAt,
    fetched_at: fetchedAt,
    confidence: clampConfidence(input.confidence, DEFAULT_CONFIDENCE[kind]),
    billing_class: normalizeBillingClass(input.billingClass),
    harness: identity.harness,
    model: identity.model,
    variant: identity.variant,
    identity_key: identity.identityKey,
    provider: identity.provider,
    provider_endpoint: identity.endpoint,
    external_model_id: identity.externalModelId,
    alias_status: identity.aliasStatus,
    alias_reason: identity.aliasReason,
    ranking_eligible: identity.aliasStatus === 'matched',
    value: input.value ?? null,
  };
}

export function isScoringFactAliasStatus(value: unknown): boolean {
  return ALIAS_STATUSES.some((status) => status === String(value ?? '').trim().toLowerCase());
}

/**
 * Does this fact carry a signal the ranking may use? An unmatched (or missing)
 * alias is never eligible.
 */
export function factInfluencesRanking(fact: unknown): boolean {
  return Boolean(fact) && (fact as ScoringFact).alias_status === 'matched'
    && (fact as ScoringFact).ranking_eligible !== false;
}

/**
 * Only a matched `api_metered` fact with a `usd` metric may carry USD cost.
 * `plan_usage` is reported in its own units and is never money.
 */
export function factMayCarryUsd(fact: unknown): boolean {
  if (!factInfluencesRanking(fact)) return false;
  const row = fact as ScoringFact;
  if (row.metric !== 'usd') return false;
  if (row.kind === 'plan_usage') return false;
  return row.billing_class === 'api_metered';
}

/**
 * Numeric USD value of a fact, or `null` when the fact may not carry one.
 */
export function factUsdValue(fact: unknown): number | null {
  if (!factMayCarryUsd(fact)) return null;
  const value = Number((fact as ScoringFact).value);
  return Number.isFinite(value) ? value : null;
}

function sourceClassRank(sourceClass: unknown): number {
  const rank = SOURCE_CLASS_RANK[String(sourceClass ?? '').trim().toLowerCase()];
  return Number.isFinite(rank) ? rank : SCORING_FACT_SOURCE_CLASSES.length;
}

/**
 * Precedence comparator, best fact first. Order:
 *
 * 1. `source_class` rank (provider actual > ledger estimate > endpoint catalog >
 *    heuristic; an undeclared class is last);
 * 2. newer `observed_at` (freshness only breaks ties **within** one class, so a
 *    newer estimate never outranks an actual charge);
 * 3. higher `confidence`;
 * 4. `source` id, then `fact_id` — stable tie-breaks so the same input always
 *    produces the same winner.
 */
export function compareScoringFacts(left: Partial<ScoringFact>, right: Partial<ScoringFact>): number {
  const rankDiff = sourceClassRank(left?.source_class) - sourceClassRank(right?.source_class);
  if (rankDiff !== 0) return rankDiff;
  const leftRank = timestampRank(left?.observed_at);
  const rightRank = timestampRank(right?.observed_at);
  if (leftRank !== rightRank) return rightRank - leftRank;
  const leftConfidence = Number.isFinite(Number(left?.confidence)) ? Number(left?.confidence) : 0;
  const rightConfidence = Number.isFinite(Number(right?.confidence)) ? Number(right?.confidence) : 0;
  if (leftConfidence !== rightConfidence) return rightConfidence - leftConfidence;
  const sourceDiff = String(left?.source ?? '').localeCompare(String(right?.source ?? ''));
  if (sourceDiff !== 0) return sourceDiff;
  return String(left?.fact_id ?? '').localeCompare(String(right?.fact_id ?? ''));
}

/**
 * Facts compete per `(identity, metric)`: `kind` describes the claim, it does not
 * split the group. That is what lets a provider actual charge beat an estimate
 * for the same pair and metric; `plan_usage` is kept out of a `usd` group by the
 * billing gate, not by a separate group.
 */
function factGroupKey(fact: Partial<ScoringFact>): string {
  return [
    String(fact?.identity_key ?? ''),
    String(fact?.metric ?? ''),
  ].join('\u0000');
}

/**
 * Reconcile facts that describe the same `(identity, metric)` group and
 * return the winner of each group plus the reason every other fact was ignored.
 * This is the source-precedence rule in code.
 *
 * Ignored reasons:
 * - `unmatched-alias` — the pair has no exact provider alias; no signal.
 * - `billing-class-not-metered` — a `usd` fact whose class is not `api_metered`.
 * - `lower-precedence` — a matched, priceable fact that lost the group.
 * - `invalid-fact` — not an object.
 *
 * The group key is `(identity, metric)`; `kind` describes the claim and does not
 * split the group, so an `actual` charge wins over an `estimate` for the same
 * pair and metric. A `plan_usage` fact can never be selected as a USD cost
 * because the billing gate drops it first.
 */
export function selectPreferredFacts(facts: unknown[] = []): {
  selected: ScoringFact[];
  ignored: Array<{ fact?: unknown; reason: string }>;
} {
  const selected: ScoringFact[] = [];
  const ignored: Array<{ fact?: unknown; reason: string }> = [];
  const groups = new Map<string, ScoringFact[]>();
  for (const fact of Array.isArray(facts) ? facts : []) {
    if (!fact || typeof fact !== 'object') {
      ignored.push({ reason: 'invalid-fact' });
      continue;
    }
    if (!factInfluencesRanking(fact)) {
      ignored.push({ fact, reason: 'unmatched-alias' });
      continue;
    }
    if ((fact as ScoringFact).metric === 'usd' && !factMayCarryUsd(fact)) {
      ignored.push({ fact, reason: 'billing-class-not-metered' });
      continue;
    }
    const key = factGroupKey(fact as ScoringFact);
    const group = groups.get(key);
    if (group) group.push(fact as ScoringFact);
    else groups.set(key, [fact as ScoringFact]);
  }
  for (const group of groups.values()) {
    const sorted = group.slice().sort(compareScoringFacts);
    selected.push(sorted[0]);
    for (let i = 1; i < sorted.length; i += 1) {
      ignored.push({ fact: sorted[i], reason: 'lower-precedence' });
    }
  }
  return { selected, ignored };
}

/**
 * Winner for one exact group, or `null`.
 */
export function resolvePreferredFact(
  facts: unknown[] = [],
  query: { harness?: unknown; model?: unknown; variant?: unknown; kind?: unknown; metric?: unknown } = {},
): ScoringFact | null {
  const identity = resolveModelIdentity({
    harness: query.harness,
    model: query.model,
    variant: query.variant,
  });
  const metric = String(query.metric ?? '').trim().toLowerCase();
  const requestedKind = String(query.kind ?? '').trim().toLowerCase();
  const kind = KIND_SET.has(requestedKind) ? requestedKind : '';
  const group = (Array.isArray(facts) ? facts : []).filter((fact) => {
    if (!fact || typeof fact !== 'object') return false;
    const row = fact as ScoringFact;
    if (row.identity_key !== identity.identityKey || row.metric !== metric) return false;
    return kind === '' || row.kind === kind;
  });
  return selectPreferredFacts(group).selected[0] ?? null;
}

/**
 * Human-readable precedence table for docs, diagnostics and tests.
 */
export function describeScoringFactPrecedence(): Array<{
  sourceClass: ScoringFactSourceClass;
  rank: number;
  description: string;
}> {
  const descriptions: Record<ScoringFactSourceClass, string> = {
    provider_actual: 'Provider-reported actual charge or invoice for the exact pair.',
    ledger_estimate: 'Cretli usage-ledger estimate for the exact harness+model pair.',
    endpoint_catalog: 'Published endpoint price; applies to api_metered facts only.',
    heuristic: 'Static default; also the safe fallback for an undeclared source.',
  };
  return SCORING_FACT_SOURCE_CLASSES.map((sourceClass, rank) => ({
    sourceClass: /** @type {ScoringFactSourceClass} */ (sourceClass),
    rank,
    description: descriptions[sourceClass],
  }));
}
