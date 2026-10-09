# Scoring and usage facts — schema, identity and billing classes

Stage 1 of the plan "Dopracować dobór modeli i harnessów na podstawie jakości i
kosztów" (todo `2584cd05`, leaf `23868d4b`), extended by stage 2 (leaf
`759aeadd`, local telemetry), stage 3 (leaf `551bb46e`, endpoint pricing cache;
§10) and stage 4 (leaf `a23f8715`, explainable shadow scoring; §11). This
document defines the shared fact record, the exact provider identity mapping, the
source precedence rules, the local telemetry builders and the network-free read
path that stages 3–4 build on. It does not enable any new ranking: `model_pick`
selection is unchanged and Settings favorites remain the only candidate gate.

Implementation: `lib/model-facts/identity.js`, `lib/model-facts/schema.js`,
`lib/model-facts/telemetry.js`, barrel `lib/model-facts/index.js`. Contract
tests: `tests/model-fact-schema.test.js`, `tests/model-fact-telemetry.test.js`.

## 1. Inventory — what already exists

The schema is deliberately a thin provenance layer in front of the mechanisms
that already exist. No second ranker, no second importer and no re-derived
measurement were added.

| Existing mechanism | What it already provides | What stage 1 adds around it |
| --- | --- | --- |
| `lib/usage/usage-event.js`, `lib/usage/usage-contract.js` | Token usage, `provenance` (`reported`/`estimated`/`unknown`), identity class, schema/normalization versions | A fact wraps one observation with `source`, `source_class` and alias status; token normalization is untouched |
| `lib/usage/usage-rates.js` | Static per-model price table; estimates vs provider-reported cost | A catalog-price fact names its `source_class`, it does not re-price |
| `lib/usage/usage-ledger.js` | Ledger aggregation and USD estimation | Ledger estimates are the `ledger_estimate` source class |
| `lib/openrouter/openrouter-models.js` | The only OpenRouter model fetcher; stage 3 extends it with pricing + cache | Stage 1 only reserves `endpoint_catalog` for its output |
| `lib/model-role-profiles.js` | Role weights, observed quality blend with `n/(n+10)` shrinkage, infra prior, rotation | Quality facts feed that blend; they never replace it |
| `lib/model-pick-history.js`, `lib/model-score-heuristics*` | Local observed statistics and static tier heuristics | Heuristic facts are the lowest precedence class |
| `lib/model-alias-policy.js` | Name/family eligibility and tiers (boundary-aware name matching) | Identity here is an **exact endpoint mapping**; eligibility stays in the alias policy |
| `lib/harness-catalog.js` | Harness registry and `can_delegate`/readiness facts | Identity uses the harness id; the registry is not duplicated |
| `lib/delegation-cycle-outcomes.js` | Reads `billingClass`/`billing_class` on usage events (`unknown`, `subscription_quota`) | The billing enum below is the formal contract for those values |

## 2. Fact record

`createScoringFact(input)` returns a normalized, immutable-by-convention record:

| Field | Type | Meaning |
| --- | --- | --- |
| `fact_id` | string | Stable id; caller-supplied or composed from identity/kind/metric/source/observed_at |
| `schema_version` | string | Version of this schema (`scoring-fact-2026-10-08`) |
| `kind` | `actual` \| `estimate` \| `plan_usage` \| `benchmark` | What kind of claim the fact is |
| `metric` | string | What is measured: `usd`, `tokens`, `latency_ms`, `throughput`, `quality`, … |
| `unit` | string | Unit of `value`; defaulted per metric |
| `source` | string | Source id, e.g. `usage-ledger`, `openrouter-catalog`, `provider-invoice` |
| `source_class` | `provider_actual` \| `ledger_estimate` \| `endpoint_catalog` \| `heuristic` | Precedence class; an undeclared value falls back to `heuristic` |
| `source_version` | string | Version of the source payload/table the value came from |
| `observed_at` | ISO timestamp \| null | When the provider/source measured the value |
| `fetched_at` | ISO timestamp \| null | When Cretli read the source; defaults to `observed_at` |
| `confidence` | 0..1 | Source-declared confidence; defaulted per kind |
| `billing_class` | `api_metered` \| `subscription_quota` \| `local` \| `unknown` | How the pair is billed |
| `harness`, `model`, `variant` | string | The exact Cretli pair |
| `identity_key` | string | Composed exact key (NUL-separated) |
| `provider`, `provider_endpoint`, `external_model_id` | string \| null | Resolved provider identity |
| `alias_status` | `matched` \| `unmatched` | Registry verdict |
| `alias_reason` | string | `exact-match`, `exact-variant-neutral`, `no-exact-alias`, `conflicting-alias`, `missing-identity` |
| `ranking_eligible` | boolean | `true` only when `alias_status === 'matched'` |
| `value` | any | The observed value, in `unit` |

`observed_at` and `fetched_at` are distinct on purpose: a cached catalog price
can be fetched today while the provider observed it last week. Neither is
inferred from the other. Versioning is two-level — the schema version plus the
per-source `source_version` — so a source can change its payload without
silently changing the meaning of stored facts.

Default confidence: `actual` and `plan_usage` = 1, `benchmark` = 0.7,
`estimate` = 0.5. An unrecognized `kind` is treated as `estimate`; an
unrecognized `billing_class` as `unknown`; an unrecognized `source_class` as
`heuristic` (lowest precedence). `alias_status` is never read from the input —
identity is the registry's verdict.

## 3. Billing classes

| Class | Meaning | May carry `usd`? |
| --- | --- | --- |
| `api_metered` | Pay-per-use API key: provider-reported or catalog-priced | Yes |
| `subscription_quota` | Prepaid plan / quota (e.g. a subscription login); no marginal USD | No |
| `local` | Runs on local hardware; no provider charge | No |
| `unknown` | Billing not established | No |

`factMayCarryUsd(fact)` is true only for a matched `api_metered` fact whose
metric is `usd` and whose kind is not `plan_usage`. `factUsdValue(fact)` returns
`null` otherwise. `selectPreferredFacts` drops a non-metered `usd` fact with
reason `billing-class-not-metered` instead of picking it.

Plan usage is reported in its own units and is **never** converted to USD.
The precedence group key is `(identity, metric)` — `kind` describes the claim
and does not split a group — so a `plan_usage`/`usd` fact is rejected by the
billing gate in `factMayCarryUsd`, not isolated by a separate group.

## 4. Exact identity mapping

### Key

```
identity_key = harness \0 model \0 variant
```

Key parts are trimmed and lower-cased; a missing variant is the empty string.
The NUL separator guarantees two different triples cannot compose the same key.
There is no name parsing, no prefix/substring test, no regex and no family
expansion anywhere in the new code path — see the guard test "no substring
joins".

### Declared aliases

Each row in `DEFAULT_MODEL_IDENTITY_ALIASES` maps exactly one
`(harness, model, variant)` to one `(provider, endpoint, externalModelId)` and
records the in-repo `evidence` file. The harness is part of the key, so the
**same model on two harnesses is two independent pairs**; a fact for the Codex
harness never aliases onto another harness.

### Variant only where it exists

`variant` is part of the key only where the provider actually distinguishes it.
A harness that sends effort as a separate request parameter (Codex
`modelReasoningEffort`) declares `variantNeutral: true`, and that row covers
every variant of the `(harness, model)` pair. This coverage is **declared per
row, never inferred**: a row without `variantNeutral` matches its literal
variant only, so `effort=high` on that pair stays `unmatched` rather than
borrowing the base row.

### Unmatched

`resolveModelIdentity` returns `alias_status: 'unmatched'` when nothing matches
(`no-exact-alias`), when the identity is incomplete (`missing-identity`), or
when a key resolves to more than one mapping (`conflicting-alias`). Unmatched
data **must not influence ranking**: `ranking_eligible` is `false` and
`selectPreferredFacts` drops the fact with reason `unmatched-alias` before any
precedence comparison. An unmatched fact is a coverage signal, never a penalty
or a bonus.

### Conflicts

Two declared rows with the same key but different
`(provider, endpoint, externalModelId)` are a conflict. The key resolves to
`unmatched` / `conflicting-alias` and carries the distinct mappings in
`conflicts`; no mapping is chosen. The same applies to two variant-neutral rows
for one `(harness, model)`.

## 5. Source precedence

Facts are grouped by `(identity_key, metric)` and the winner is chosen by
`compareScoringFacts`:

1. **`source_class` rank** — `provider_actual` (0) > `ledger_estimate` (1) >
   `endpoint_catalog` (2) > `heuristic` (3); an undeclared class ranks last.
2. **Newer `observed_at`** — freshness breaks ties **within one class only**, so
   a newer ledger estimate never outranks a provider actual charge.
3. **Higher `confidence`**.
4. **`source` id, then `fact_id`** — stable tie-breaks.

The cost order is the plan's: **provider actual charge (if any) > Cretli ledger
estimate for the exact harness+model > endpoint catalog price for `api_metered`
only > heuristic**. `kind` describes the claim and does not split the group, so
an `actual` charge competes with and beats an `estimate` for the same pair and
metric. `plan_usage` is never converted to USD: `factMayCarryUsd` rejects it and
`selectPreferredFacts` drops it from a `usd` group. Benchmarks form their own
`quality`/`throughput` groups.

`selectPreferredFacts(facts)` returns `{ selected, ignored }`. Ignored reasons:
`unmatched-alias`, `billing-class-not-metered`, `lower-precedence`,
`invalid-fact`. `resolvePreferredFact(facts, query)` returns the winner of one
exact group or `null`.

## 6. Candidate gate

Settings favorites remain the candidate gate. `SCORING_FACT_CANDIDATE_GATE` is
`favorites`, `createScoringFact` produces no candidate/eligibility field, and
this module exports no candidate builder or model selector. Precedence only
reconciles facts that already describe a known pair; a fact cannot add a model
to the picker.

## 7. Versioning and extension

- `SCORING_FACT_SCHEMA_VERSION` and `MODEL_IDENTITY_SCHEMA_VERSION` are bumped
  when a field, enum, key rule or precedence rule changes.
- Stage 3 extends the identity table (OpenRouter endpoints and external ids) and
  the catalog-price facts through `buildModelIdentityIndex` /
  `createScoringFact({ aliases })`; it does not create a second fetcher.
- Stage 4 reads `selected` facts only. Unmatched or stale facts do not change the
  pick; explanations show `kind` / `source` / `source_class` / `observed_at` /
  `confidence` / `alias_status`.

## 8. Stage 2 — local model+harness telemetry

`lib/model-facts/telemetry.js` is the inventory-driven delta on top of the fact
record. It reads only data Cretli already stores and turns it into facts; it
selects nothing and changes no pick. Every field it emits carries a
`kind`, a `source`/`source_class`, a `source_version` and `observed_at` /
`fetched_at`, so an estimate can never be mistaken for an invoice.

### What already existed vs the delta

| Data | Already existed | Stage 2 delta |
| --- | --- | --- |
| Duration, in/out tokens, tok/s, tool calls, files/lines | `lib/delegation-metrics.js` + `lib/model-pick-history.js` observed stats | Consumed as-is; no re-measurement |
| Infra/quota failures, lockouts, plan utilization | `lib/model-pick-history.js`, `lib/harness-usage-limits.js`, `lib/usage/harness-health.js`, `lib/usage/plan-limit-history.js` | An explicit `limit_ref` tying a telemetry record to the exact reading |
| Cache read / cache write | Usage token bag (`cachedInput`/`cacheWrite`), split by `partitionUsageTokens` | Disjoint `cache_read_tokens` / `cache_write_tokens` facts |
| Audio input/output | Usage token bag (`audioInput`/`audioOutput`) | Disjoint `audio_input_tokens` / `audio_output_tokens` facts |
| USD | `lib/usage/usage-rates.js` + usage ledger | `buildUsdEstimateFact` labels an existing value `actual`/`estimate` behind the `api_metered` + matched-identity gate |
| `n/(n+10)` shrinkage, infra prior | `lib/model-role-profiles.js` (`w = row.n/(row.n+10)`, `row.n` includes infra fails) | Recorded (`shrink_weight`, `infra_eff`) for stage 4; `n` is the full task counter (infra/quota included), the constants are parity-tested, ranking is untouched |

Stratification by task type and effort is deferred until enough trials exist;
the record stays segmented by `role` only, matching the current level.

### Token facts (`buildTokenFacts`)

Buckets come from `partitionUsageTokens`, so cached input is removed from the
input counter exactly once and reasoning is removed from output only when the
harness reports it as a subset. Metrics: `input_tokens` (uncached),
`output_tokens` (without reasoning), `cache_read_tokens`, `cache_write_tokens`,
`reasoning_tokens`, `audio_input_tokens`, `audio_output_tokens`. A zero bucket
emits no fact; the sum of the emitted values equals the returned
`billed_tokens`. A provider-reported measurement is `actual`
(`source_class: provider_actual`, confidence 1); an estimated one is `estimate`
(`ledger_estimate`, confidence 0.5).

### USD facts (`buildUsdEstimateFact`)

The value must already exist (the ledger computed it); this module never
re-prices. Billing class gates it:

| Signal | Class |
| --- | --- |
| Explicit `billingClass` / `billing_class` | as declared |
| `billingMode: 'subscription'`, harness `sdk`, provider `cursor` | `subscription_quota` |
| `local: true`, `billingMode: 'local'`, provider `local`/`ollama`/`lmstudio` | `local` |
| Provider-reported `reportedUsd` (a prepaid plan never reports one) | `api_metered` |
| provider `openai`/`google`/`azure`/`openrouter` | `api_metered` |
| anything else | `unknown` |

Only `api_metered` may carry USD. `subscription_quota`, `local` and `unknown`
return **no usd fact** (not USD 0). OpenRouter / AA endpoint prices are
`api_metered` regardless of route, so a catalog price never charges a
subscription; a prepaid plan (`billingMode: 'subscription'`) still charges
nothing. A `reportedUsd` becomes `actual`/`provider_actual`; a rate-table value
stays `estimate`/`ledger_estimate`. If the exact pair is `unmatched` in the
stage-1 identity registry, the fact is dropped — the raw model name is not an
identity.

### Plan usage and limits (`buildPlanUsageFact`, `buildLimitLink`)

A plan-limit reading becomes a `kind: plan_usage` fact in plan units
(`plan_utilization` percent, or `plan_signal` state) with
`billing_class: subscription_quota`; it is never converted to USD. A telemetry
record carries `plan_usage_fact_id` and a stable `limit_ref`
(`planUsageRef`: harness, model, rate-limit type, reset, observed time), so a
later scorer can point back at the exact sample. A lockout row links the same
way with `kind: lockout` and no usage fact.

Stage 4 passes its lockout as `input.lockout` in the **binary shape**
`appendLimitHistory` writes in `lib/harness-usage-limits.js`:
`{ resetAt, code, detectedAt/ts }`, no plan-reading fields. It must **not** be a
`lib/usage/plan-limit-history.js` row: every such row carries an `observedAt`
(see `buildHistoryRow`), so it classifies as `plan_usage` here — and that is
correct, because the producer calls the `status: 'rejected'` row it writes "a
rejected reading", a plan signal rather than a binary block. Both branches are
pinned by contract tests.

### Quality vs failures (`buildTaskQualityTelemetry`)

`decided`/`passed` cover only jobs that could be judged. Infra and quota
failures are counted on their own (`infra_fails`, `quota_fails`,
`infra_fail_rate`, `quota_fail_rate`), so adding either leaves `quality`,
`quality_rate` and `n_quality` unchanged while it raises the failure rate. The
failure-rate facts are `estimate` (`source_class: ledger_estimate`): they are
derived from ledger counts, not a provider-reported rate. The shrink weight is
`n/(n+10)` — `n` is the **full task counter, infra and quota failures included**,
exactly `row.n` in `lib/model-role-profiles.js` (`w = row.n/(row.n+10)`), not
`decided` alone — and the infra prior is `prior_infra*(1-w) + infra_rate*w`,
mirroring that module without changing ranking. A finite `n >= 0` from the
caller wins, including an explicit `n: 0`; only a missing/non-finite `n` falls
back to `decided + infra_fails + quota_fails`. Review quality is recorded but
`quality_ranking_eligible: false`, because the existing rule keeps verdict-based
quality out of review scoring; implement/fix read the implement stats exactly as
before.

### Composed record (`buildModelHarnessTelemetry`)

One record per exact `(harness, model, variant)` collects the token, USD, plan
and quality facts plus the resolved identity, `billing_class`, `run_class` and
the `limit_ref`. `run_class` is one of `quality`/`infra`/`quota`/`cancel`;
failure classes never touch quality. The record-level `billing_class` is a
temporary classification from the resolved identity when there is no usage
event (no proof of a charge); only the per-USD-fact gate proves one. The record
is additive telemetry: stage 4 is the first consumer and remains in shadow mode.
`schema_version` comes from the stage-1 schema (`SCORING_FACT_SCHEMA_VERSION`)
and is used as the fallback when the record carries no facts.

## 9. Non-goals (stages 1–2)

No network access, no new importer, no second ranker, no candidate set, no
scoring change, no USD conversion for plan usage, no removal of the infra prior
or the review quality rule. No stratification by task type or effort yet.

## 10. Stage 3 — OpenRouter endpoint catalog pricing cache

Stage 3 (leaf `551bb46e`) extends the existing OpenRouter fetcher
`lib/openrouter/openrouter-models.js`; it does **not** add a second HTTP client.
The new sibling module `lib/openrouter/openrouter-pricing-cache.js` only stores
and reads the catalog — it never calls `fetch`.

### What the cache holds

`GET /api/v1/models` rows carry a flat `pricing` object of USD-per-token strings
(`prompt`, `completion`, `request`, `image`, `web_search`,
`internal_reasoning`, …). The fetcher preserves that object on each catalog row
and persists the last good catalog to
`data/openrouter-models-pricing.json` (`writeJsonAtomic`). The file survives a
server restart; a later process (or an offline period) serves it without any
live request.

### Failure and freshness rules

| Live outcome | Result |
| --- | --- |
| Fresh response | `modelsSource: live`, persisted, `stale: false` |
| Within in-memory TTL | served from memory, `fromCache: true`, `stale: false` |
| Past TTL with a last good copy | stale copy served immediately, background revalidation (`stale: true`) |
| 429 / 5xx / timeout / network error / empty list / missing key with a last good copy | last good copy with `stale: true`, `modelsSource: stale` and a warning; never an empty list |
| Any failure with no last good copy | empty `fallback` with the warning (unchanged legacy shape) |

The live request is capped by `OPENROUTER_MODELS_TIMEOUT_MS` (10 s,
`AbortSignal.timeout`), so a hanging refresh can never block a consumer. The
persisted last-good copy is not deleted by `invalidateOpenRouterModelsCache()`.

### Local, network-free read path (stage 4)

`getOpenRouterEndpointPricing(exactModelId, { dataDir })` is synchronous: memory
first, then the persisted copy. It performs no `fetch`, no `await` and no
blocking, so `model_pick` can read a price from the cache module directly.
Lookup is an exact, case-sensitive match on the OpenRouter model id — no
substring, prefix, fuzzy or case-folded join; a near miss returns `null`.

### Provenance and attribution

Every value carries the stage-1-compatible fields `source: 'openrouter-catalog'`,
`source_class: 'endpoint_catalog'`, `kind: 'estimate'`, `metric: 'usd'`,
`billing_class: 'api_metered'`, `source_version`, `fetched_at`/`observed_at` and
an attribution string. The attribution states explicitly that these are
**endpoint** prices for a metered API key — not a direct provider API price and
not a subscription charge. Stage 4 wraps them as `endpoint_catalog` /
`api_metered` facts.

### Deferred sources

Artificial Analysis (needs a key, rate limits, per-value attribution and a
cache/redistribution ToS check, plus ≥50% favorites coverage) and the
SWE-rebench / Terminal-Bench / SWE-bench snapshots (no stable API; results depend
on scaffold/release/effort) are **not** implemented. If either returns later, it
must be a manual, versioned snapshot keyed by the exact agent name; a miss never
lowers a score.

## 11. Stage 4 — explainable shadow scoring (`model_pick`)

Stage 4 (leaf `a23f8715`) adds `lib/model-pick-shadow.js` (the pure observer) and
`lib/model-pick-shadow-gates.js` (agreement report + dormant rollout gate). It is
an **observer**, not a ranker: `selectModelPick` in `lib/model-role-profiles.js`
is untouched and the shipped selection is byte-identical with the shadow on or
off.

### Structural "selected unchanged"

`selectModelPick` still runs first and produces the selected pair, the fanout
`picks`, the ordered `candidates` and every filter decision. `applyShadowLayer`
then returns a shallow copy of that result with three added keys
(`shadow_top`, `shadow_explanation`, `shadow_agreement`). It reads the existing
candidate objects and never writes to them or re-filters them, so the eligible
set (`eligibility_parity: true`), role matchers, Settings-favorites gate,
`ready`/`can_delegate`, lockouts, the review certification/read-only guarantee,
the review `*flash*` exclusion, the history excludes, the infra prior and the
review quality policy are all exactly the ones `selectModelPick` applied.
`shadow: false` (or `mode: 'off'`) returns the historical response shape.

### What the shadow score is

```
shadow_score = base_score (existing heuristic + observed n/(n+10) blend + infra prior)
             + cost_adjustment   (fresh api_metered endpoint price, bounded ±0.05)
             + time_adjustment   (local observed median, same fresh api_metered gate, bounded ±0.05)
```

The local `n/(n+10)` blend and the observed statistics are **consumed** from the
candidate (`lib/model-pick-history.js` → `lib/model-role-profiles.js`); this stage
does not re-derive them. The only new signals are the stage-3 endpoint price and
the observed latency, both deliberately small so the observer cannot outrank the
shipped picker by luck.

### Neutrality and billing rules

- **Unmatched identity** (stage-1 `alias_status !== 'matched'`) is neutral: no
  cost and no time adjustment (`skipped_reason: 'unmatched-alias'`), never a
  penalty or a bonus.
- **`subscription_quota` / `local` / `unknown`** never receive an API cost
  adjustment (`billing-class-*`); a subscription plan's usage/limit remains its
  own signal, never USD from OpenRouter.
- **Review** quality is never the verdict pass rate. The observer starts from the
  already-blended `base_score`, and that blend keeps review verdict quality out
  by policy; `quality_source` is `existing-observed-blend` and
  `review_pass_rate_in_quality_score` is the guard/stop flag.

### Freshness

A price is **fresh** when `now - fetched_at <= MODEL_PICK_SHADOW_PRICE_FRESH_MS`
(24 h). The stage-3 cache keeps the last good catalog indefinitely, so a served
price can be arbitrarily old; the field historically named `stale_after_ms`
actually holds `stored_at_ms` and is used only as a last-resort fetch time. A
stale price is still reported with its `age_ms`/`fetched_at`, but it is not
applied (`skipped_reason: 'stale-price'`). The getter is synchronous and
network-free, so a pick makes zero requests.

### Persistence, agreement and stop flags

`persistModelPickShadowComparison` (in `lib/model-pick-decisions.js`) appends each
comparison to `data/model-pick-shadow-comparisons.json` with per-role counters
(`n`, `agree`, `first_at`, `last_at`) and a bounded recent-row list. The report
exposes `agreement_rate` per role and the stop flags:

- `review_agreement_below_floor` — review agreement below 70%;
- `review_pass_rate_in_quality_score` — the review quality guard tripped;
- `stop` — either of the two.

A stop flag is a report signal, never a runtime kill: the selection is unchanged
regardless.

### Dormant rollout gate

`evaluateShadowRolloutGate` implements, but does not enable, promotion. It is
`implement`-only and `api_metered`-only, and requires at least 20 decided cycles
on divergent pairs, a Newcombe/Wilson lower bound of the pass-rate difference
`>= 0`, an infra-fail increase `<= 5` pp, and a USD/successful-cycle growth
`<= 15%` unless the pass rate improved by `>= 10` pp. The minimum observation
window is the later of 14 days and 200 calls (`evaluateShadowWindow`).
`promotion` defaults to `false`, so `eligible` is `false` and `dormant` is
`true` while `metrics_eligible` still reports what the numbers would say.

### Shadow policy config

The policy lives in `lib/model-pick-policy.js` (`MODEL_PICK_SHADOW_*`, defaults
`mode: 'shadow'`, `promotion: false`) and follows the exploration pattern;
`normalizeModelPickShadowConfig` accepts a `shadow` key, a mode string or a
boolean. Safety bounds cannot be weakened by an operator file: the day window,
call floor, overhead ceiling, review floor, decided-cycle floor and cost/infra
thresholds are clamped to their documented values. The policy version gains a
`;shadow=<mode>+<policy>[+promoted]` segment (`composeModelPickShadowSegment`), so
the agreement cohort never mixes with the pre-shadow one.

### Deferred (no code in this stage)

Artificial Analysis / benchmark priors, task-type stratification, effort,
a separate UI for the shadow report and any auto-learning are explicitly out of
scope.

