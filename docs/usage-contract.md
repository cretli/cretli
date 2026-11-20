# Usage contract and harness coverage matrix

Status: contract revision `2026-10-25.1`, `schemaVersion = 3`,
`normalizationVersion = 2`, `occupancySchemaVersion = 1`. Code and this
document are reconciled: the earlier mismatch (`2026-10-06.3` here vs
`2026-10-06.2` in code) was closed by revision `2026-10-22.1`. Schema version 3
adds bounded Codex and Claude run-pressure counters to run events; normalization remains
at version 2. Events with
`schemaVersion`/`normalizationVersion` 1 or no version stay readable
(`isReadableUsageVersion`), newer-than-build versions are not.

This document is the human-readable contract for token measurements in the
usage ledger. The machine-readable source of truth is
[`lib/usage/usage-contract.js`](../lib/usage/usage-contract.js); the matrix
below must stay in sync with `USAGE_HARNESS_MATRIX` there. TODO `b390f96e`
owns this contract. Stage 2 (`bbedab87`) applied the per-harness numeric fixes
and bumped the schema/normalization versions accordingly (see section 8).

## 1. Versions and provenance on every new event

Every event produced by `createUsageEvent` carries:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Persisted event shape version (`USAGE_SCHEMA_VERSION`). |
| `normalizationVersion` | Normalization semantics version (`USAGE_NORMALIZATION_VERSION`). |
| `contractRevision` | Matrix/document revision. |
| `provenance` | `reported` \| `estimated` \| `unknown`. |
| `accountingScope` | `own` \| `consolidated`. Never summed together. |
| `usageShape` | `raw` \| `resolved` at the adapter boundary. |
| `measurementKind` | `delta` \| `snapshot` \| `cumulative`. |
| `granularity` | `request` \| `message` \| `turn` \| `run` \| `session`. |
| `inputIncludesCache` | Whether the raw payload input counter already contains cache. |
| `reasoningRelation` | `subset_of_output` \| `separate` \| `unknown`. |
| `contextEpoch` | Explicit reset/compaction epoch when the harness exposes one. |
| `lifecycle` | `running` \| `ended`. |
| `completeness` | `complete` \| `partial` \| `missing` \| `unsupported`. |
| `identityClass` | `provider` \| `durable_sequence` \| `none`. |
| `logicalEventKey` | Dedup key, `null` when the identity class is `none`. |
| `runId`, `sourceSessionId`, `variant` | Durable identity/model inputs. |

A child run's model comes from the child payload. It is never inherited from
the parent model (`resolveChildUsageModel`).

### Price provenance (`pricing`)

Every event whose `usd` was computed by `priceUsage` carries an optional,
additive `pricing` block (not part of the schema version bump; legacy events
simply lack it):

| Field | Meaning |
| --- | --- |
| `source` | `token_rates` (static table, model-prefix match), `provider_fallback` (generic per-provider row for an unlisted model; always `estimated: true`), `openrouter_pricing`, `reported` (provider-reported `reportedUsd`) or `none` (unpriced). |
| `ratesVersion` / `ratesCapturedAt` | Version label and review date of the table (`TOKEN_RATES_VERSION`, `TOKEN_RATES_CAPTURED_AT`). |
| `rates` | Snapshot of the per-million rates actually applied (`textInput`, `cachedInput`, `cacheWrite`, `audioInput`, `textOutput`, `audioOutput`), enough to reproduce `usd` without the current table. |
| `charRatePerMillion` / `minuteRate` | Applied TTS / STT rates, when used. |
| `reportedUsd` | Echo of the reported cost when `source` is `reported`. |
| `reason` | Why an event is unpriced (`unknown_model`) when `source` is `none`. |

Rules: the block is written once at record time and is never recomputed. Changing
`TOKEN_RATES` affects only events recorded afterwards; history is repriced only
by an explicit migration. A model the table does not know yields `usd: null`
with `pricing.reason = 'unknown_model'` unless the provider has a labelled
fallback row (`openrouter`, `google`, `openai`), which is flagged
`provider_fallback` + `estimated: true` and so stays out of `totalUsd`.

## 2. Harness matrix

`usageShape`: raw = adapter must translate provider snake_case; resolved =
harness already sends the canonical shape.

`payload input / bag input`: whether cache is included in the raw payload input
counter / in the stored canonical `tokens.textInput`. The contract layer
subtracts it when deriving disjoint buckets, so the transition is versioned.

| Harness | Shape | Measurement | Granularity | Payload input / bag input includes cache | Reasoning | Cache read | Cache write | Default identity | Reset / context epoch |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `sdk` (Cursor SDK) | resolved | snapshot | turn | yes / yes (transitional) | subset of output | yes | yes | durable_sequence (runId, session, turn) | run reset |
| `claude` | resolved | snapshot | run | yes / no | subset of output (not reported) | yes | yes | durable_sequence (session, request) | run reset |
| `codex` | raw | delta | turn | yes / no | subset of output | yes | yes | durable_sequence (thread, turn) | run reset |
| `deepseek` | resolved | delta | message | no / no | subset of output | yes | yes | durable_sequence (session, message) | run reset |
| `qwen` | raw | delta | run | yes / no | unknown | yes | no | durable_sequence (session, request) | compaction |
| `opencode` | raw | snapshot | message | no / no | separate | yes | yes | durable_sequence (session, message) | run reset |
| `codebuddy` | raw | delta | message | yes / no | unknown | yes | yes | durable_sequence (session, message) | compaction |
| `openrouter` | raw | delta | request | yes / no | unknown | yes | no | provider (event id) | — |
| `mistral` | resolved | delta | run | yes / no | unknown | yes | no | durable_sequence (session, request) | run reset |
| `zai` | raw | snapshot | message | yes / no | separate | yes | no | durable_sequence (session, request) | run reset |
| `mimo` | raw | snapshot | message | yes / no | separate | yes | no | durable_sequence (session, request) | run reset |

The matrix above is the normalizer-level contract: one row per harness, all
eleven required rows (including the API-key harnesses `mistral`, `zai` and
`mimo`). It does not say which individual provider fields feed which derivation
or how well each is evidenced; that field-level view, with evidence tags, is
section 10 and 10.1. The `voice` harness shares the ledger and is described in
the module, but is not one of the eleven required matrix rows.

Contract sources (owned by the named symbol, not duplicated here):

- `sdk`: `lib/usage/usage-normalize.js#fromSdkUsage`
- `claude`: `lib/agent-harness/claude-event-normalizer.ts#resolveClaudeResultUsage`
- `codex`: `lib/usage/usage-normalize.js#fromCodexUsage`
- `deepseek`: `lib/usage/usage-normalize.js#fromDeepSeekUsage`
- `qwen`: `lib/usage/usage-normalize.js#fromQwenUsage`
- `opencode`: `harnesses/opencode/opencode-usage.js#readOpenCodeTokenSnapshot`
- `codebuddy`: `lib/usage/usage-normalize.js#fromClaudeUsage` (raw snake_case)
- `openrouter`: `lib/usage/usage-normalize.js#fromOpenRouterUsage`
- `mistral`: `lib/usage/usage-normalize.js#fromMistralUsage`, called by
  `harnesses/mistral/mistral-client.js`
- `zai`: `harnesses/zai/zai-sdk-client.js` (raw OpenAI-compatible usage)
- `mimo`: `harnesses/mimo/mimo-client.js` (raw OpenAI-compatible usage)

Each matrix entry also carries a **safe example payload** with no conversation
content (`example`). `containsConversationContent` guards that promise.

## 3. Disjoint token buckets

The canonical partition (`partitionUsageTokens`) produces:

1. `inputWithoutCache`
2. `cacheRead`
3. `cacheWrite`
4. `outputWithoutReasoning`
5. `reasoning`
6. `audioInput` / `audioOutput` (proper audio only)

Rules:

- Reasoning that is a **subset of output** is subtracted from
  `outputWithoutReasoning` and stays additive as its own bucket.
- Reasoning with **unknown relation** is kept as a diagnostic subcounter and
  **excluded from the additive total** (`reasoningDiagnostic = true`).
- `own` and `consolidated` scopes are aggregated separately
  (`aggregateAccountingScopes`); the two are never summed into one number.
- `billedTotalTokens` (all disjoint billable buckets) and
  `promptTokensForWindow` (uncached input + cache read + cache write) are
  **different derivatives** of the same contract.
- Cache read/write still occupies the context window.
- Unknown semantics yield `resolveWindowSemantics(...) === 'unknown'` and
  `promptTokensForWindow(...) === null`; callers must not show a certain
  percentage then.

Contract note (stage 2): Claude reaches the adapter boundary as resolved
camelCase and is used as-is; CodeBuddy keeps raw snake_case and is resolved
there. Every harness now stores a first-class `cacheWrite` bucket. Only the
`sdk` bag still stores input inclusive of cache (`bagInputIncludesCache =
true`), so the contract layer subtracts it; the other harnesses store disjoint
input. OpenRouter's `prompt_tokens`/`cached_tokens` relation was verified as
inclusive (cached is a subset of the prompt), so the adapter subtracts cache
before the bag and its window semantics are `inclusive`. Qwen's DashScope
OpenAI-compatible path reports only cache reads; `fromQwenUsage` still accepts
`cache_creation_input_tokens` (and derives it from the ephemeral TTL split when
only that is present), but the contract declares `cacheWrite: false` because a
reliable cache-write bucket is not guaranteed.

## 4. Logical event identity

Identity components: harness + durable `runId`/`attemptId` + `sourceSessionId`
+ source `request`/`message`/`turn`/`event` id + measurement type.

- `identityClass = provider`: provider-issued event id.
- `identityClass = durable_sequence`: a durable run/attempt/session mapping
  **and** a source event id.
- `identityClass = none`: no dedup key (`logicalEventKey = null`).

A sequence ordinal newly assigned when an event is re-received is **not**
durable and must not be passed as `durableSequence`; it does not provide
dedup. Token counts, timestamps and token hashes are never identity.

## 5. Lifecycle and coverage

Lifecycle (`running` / `ended`) is independent from completeness:

- `complete`: `ended` **and** a present measurement **and** proof that every
  request/turn (every child too when `accountingScope = consolidated`) was
  accounted for. A single usage event is therefore never `complete`.
- `partial`: a measurement exists, but there is no final usage report, no
  child scope, or no completeness proof. `interrupted` runs may be `partial`.
- `missing`: `ended` without a measurement even though the harness supports
  usage.
- `unsupported`: the harness does not report usage.

A reported **zero** with a correct final is a measurement; absent data is
`null`/`missing`, not zero.

After a run ends, wait up to **24 h** (`USAGE_FINAL_USAGE_GRACE_MS`) for the
final usage. A later credible measurement may correct **coverage**
(`applyUsageCoverageCorrection`), but it never changes the number of runs.

Stage 3 (`2d05fded`) completed the runtime wiring of that late correction: the
durable journal/read-model keys the run by a durable `runId` (minted and
persisted at run-start), so a late measurement inside the 24 h window corrects
the persisted run's coverage/completeness **without adding a run event**, and a
measurement after the window is kept as a `stale` diagnostic instead of being
counted. See section 9.

## 6. Shared semantics with context measurement (`fbaedde9`)

Window occupancy uses the same contract:

- cache being a subset of input: use the full input counter;
- disjoint buckets: add uncached input + cache read + cache write;
- unknown semantics: no certain percentage, no gating.

Context ("prompt usage") and billing are separate derivations. This contract
does not change totals/rates in this stage.

## 7. Acceptance tests

`tests/usage-contract.test.js` covers:

- all nine harnesses present with shape, granularity, cache and reasoning
  declarations, sources and safe examples;
- `schemaVersion`/`normalizationVersion` present on the first new event;
- provenance `reported` / `estimated` / `unknown`;
- lifecycle `running` / `ended` and completeness
  `complete` / `partial` / `missing` / `unsupported`, including "one usage is
  not complete";
- cache read/write and reasoning subset/separate/unknown bucket math;
- `own` vs `consolidated` never summed;
- `promptTokensForWindow` includes cache and differs from `billedTotalTokens`;
- logical identity classes and the "new ordinal is not durable" rule;
- the 24 h final-usage grace and coverage correction;
- adapter-boundary shape for Claude (resolved) and CodeBuddy (raw).

## 8. Stage 2 deltas applied (`bbedab87`)

Applied under `schemaVersion = 2` / `normalizationVersion = 2`:

- `cacheWrite` is a first-class bucket in the stored token bag
  (`emptyUsageTokens`), is wired through the Claude, CodeBuddy, Codex, Qwen,
  OpenCode, SDK and DeepSeek normalizers, and is priced (input rate unless a
  dedicated `cacheWrite` rate exists).
- Claude no longer re-normalizes its resolved camelCase payload; the raw
  snake_case resolver is used only for the CodeBuddy boundary, so Claude cache
  reads **and** writes survive. The production hook fixture goes through
  `claude-event-normalizer` → WS → room kernel.
- `sdk` keeps its inclusive bag (contract layer subtracts), while OpenRouter
  cache reads are subtracted in the adapter after the relation was verified.
- `summarizeUsage`/`summarizeUsageTimeseries` aggregate disjoint contract
  buckets, so reasoning (subset or diagnostic) and cache are never counted
  twice in totals.
- Run events persist `measurementPresent` and a `coverage` block
  (`proof`, `expectedRequests`, `coveredRequests`, and `expectedChildren`/
  `coveredChildren` for consolidated runs). A Claude `result` is the final
  proof; a single delta is still never `complete`.
- DeepSeek child usage is tagged `accountingScope = consolidated` with its
  `childSessionId`; parent usage stays `own`, and the run coverage reports how
  many expected children actually measured.

### 8.1 Scope-aware read-model (`summarizeUsage`)

The ledger read-model honours the "own and consolidated are never summed"
invariant:

- Top-level `tokens`, `totalUsd`, `estimatedUsd`, `unpricedEvents` and each
  group row's `usd`/`estimatedUsd`/`events`/`tokens` stay the **`own`** view, so
  existing routes/UI keep their meaning.
- New additive subtotals expose both scopes: `tokensByScope`,
  `usdByScope`, `estimatedUsdByScope`, `eventsByScope`, plus an explicit
  `mixed` flag (also on every group row). `mixed === true` means both scopes are
  present and the two must not be added together.
- `summarizeUsageTimeseries` accepts `scope: 'own' | 'consolidated'` (default
  `own`) and echoes it in the result, so a token/usd/event series never mixes
  scopes. `runs` stays scope-agnostic because a late measurement never changes
  the run count.

The scope-aware read-model introduced no persisted event fields, so that change
did not affect `schemaVersion` or `normalizationVersion`.

### 8.2 Harness run-pressure diagnostics (`2026-10-25.1`)

Codex and Claude run events may include a `harnessRunPressure` block with the
number of active runs for that harness and run starts in the previous minute
and five minutes. These counters describe Cretli processes only; they do not
count the CLI's internal HTTP retries or harness activity outside this Cretli
instance. The Harness health card shows these counters with recent errors and
limit hits. No prompts, response bodies, headers, or credentials are stored.

## 9. Stage 3: idempotent ledger and honest historical data (`2d05fded`)

### 9.1 Source of truth and read-model

`lib/persist/usage-persist.js` owns the append-only JSONL journal under
`data/usage/`. New records are versioned envelopes
(`USAGE_JOURNAL_VERSION = 1`):

```
{"v":1,"seq":<n>,"kind":"usage"|"run-start"|"correction"|"retention-prune"|"key-prune",
 "at":"<iso>","event":{...},"crc":"<hex>"}
```

The checksum covers a canonical JSON encoding, so a torn trailing line or a
tampered line is detected and reported as `corrupt` — it is **not** treated as
committed. Legacy raw event lines (written before the envelope) remain readable.

`data/usage/ledger-index.json` (`USAGE_LEDGER_INDEX_VERSION = 1`) is a durable,
rebuildable read-model:

- `keys`: `logicalEventKey -> committed event` (exactly-once dedup);
- `baselines`: `baselineKey -> last accepted cumulative snapshot`;
- `runs`: `runKey -> active|ended run`;
- `corrections` / `supersededKeys`: backfill provenance.

It is never a second source of truth: after a crash between the journal append
and the index write, the missing key/baseline is recovered by tailing the
journal (keyed by per-file size). When more than one day file must be caught up
in the same refresh (full rebuild, explicit repair, or several files grew
together), committed envelopes are merged and replayed in global `seq` order so
a late correction appended to an older day file cannot be skipped after a newer
day file was scanned first. Single-file catch-up keeps the incremental size
check. A full journal rebuild only happens when the index is missing/corrupt or
through the explicit `repairUsageLedger`, never on the hot path
(`readUsageLedgerState().lastScan.filesRead === 0` when current).
Writes are serialized by an inter-process lock (`.ledger.lock/owner`, created
with an exclusive `O_EXCL` token) plus the in-process sync writer, so
concurrent processes commit a logical key once. Only the process that wrote the
token may release the lock. A lock is reclaimed only when the owner PID is no
longer alive; the reclaimer verifies the owner file still holds the same token
before replacing it (mtime alone never steals a live holder).

### 9.2 Identity, runs and snapshots

- Exactly-once applies only to reproducible identities
  (`provider`/`durable_sequence`). `identityClass = none` is never deduped by
  numbers; the ambiguity is surfaced through the `noneIdentity` diagnostic.
- A durable `runId` is written as a `run-start` record **before** the harness
  launches (`beginUsageRun`; room-kernel and the Cursor SDK WS pass the
  persistence seam). Run-ended is recorded exactly once per durable
  run/attempt key; a duplicate finish is a `duplicate` diagnostic and never adds
  a run or tokens.
- Snapshot baselines are keyed by
  `harness + run + attempt + sourceSession + turn + contextEpoch`. The ledger
  recomputes a cumulative snapshot delta against the committed baseline, so a
  restart or an out-of-order snapshot neither double counts nor rolls the
  baseline back. A new run (new `runId`) or an explicit context epoch gets a new
  baseline.
- Active and ended runs are separate metrics (`runLifecycle` on
  `loadUsageSummary`).

### 9.3 Late usage and retention

- A measurement that arrives after run-ended inside the 24 h
  `USAGE_FINAL_USAGE_GRACE_MS` window is counted (it is real usage) and corrects
  the persisted run's coverage/completeness through
  `applyUsageCoverageCorrection`; the run count never changes.
- After the window (or after the run was retired by retention) the record is
  written with `stale: true`, excluded from normal reads, and counted only in
  the `stale` diagnostic. It never starts a new run and is never re-counted.
- Retention keeps the whole active run, then at least
  `USAGE_KEY_RETENTION_MS` (30 days) after close / last accepted late usage, and
  never less than the journal retention or the documented provider redelivery
  horizon (24 h). `pruneUsageRetention` never removes active runs; pruned runs
  become tombstones so a later event is classified `stale` rather than
  resurrecting the run. Identity keys are removed only when their durable
  `runKey` matches a pruned ended run (never by `sourceSessionId` alone). Each
  batch of removed keys and baselines is journaled as `key-prune`
  (`removedKeys`, `removedBaselines`) so `repairUsageLedger` rebuilds the same
  read-model.

### 9.4 Legacy backfill

`applyUsageCorrections` supports a `dryRun` comparison and idempotent
corrections/supersedes keyed by `logicalEventKey`. Before the first mutating
apply it copies the journal and `ledger-index.json` into
`data/usage/.backup-<stamp>/`. Mutating applies update `fileScan` for each
touched day so the next refresh does not rescan unchanged sizes. A superseded
journal line is omitted from `readUsageEvents`; the authoritative replacement
is the last committed `kind: 'usage'` envelope with `supersede` (full event,
including USD/model/provider/outcome/role/delegation/latency attribution),
resolved by scanning only the day files implicated by `index.keys` /
`supersededKeys` (`eventDay`, envelope `at`, and key row `at`, intersected with
the read `from`/`to` range). Superseded keys whose replacement or original day
falls outside the query range are skipped without parsing those journal files.
`readUsageLedgerState().lastReadEventsSupersedeFiles` counts every distinct day
file parsed for supersede resolution in that read (replacement scan plus any
fallback journal lookup). When the journal envelope is missing, the replacement
is rebuilt from the committed original event in the journal (same logical key,
no `supersede`) with corrected tokens, then `index.keys` as a last resort. After
`key-prune` removes `index.keys` but leaves `supersededKeys`, `eventDay`
(persisted on supersede) keeps the original event's calendar day in the scan
set so a correction envelope on a different day still finds the replacement.
Token supersede on a run-ended event does
not reset `outcome`, `measurementPresent`, or `completeness`; run
`lastAcceptedAt` stays `max(previous, event.at)` so retention honors late
corrections. A `kind: 'correction`
record alone marks the key `pendingReplacement` until the matching replacement
usage is committed — reads omit stale tokens rather than replaying the old
version after a crash between the two writes. The same semantics apply to live
commits with `hints.supersedes` / `hints.correction` (usage records carry
`supersede` + `correction` metadata). Appends trim an unterminated journal tail
before writing the next line so a torn crash cannot glue two envelopes into one
corrupt line. Per-file `fileScan.corruptLines` is refreshed from the journal only when a torn
tail was trimmed or the previous scan already recorded corrupt lines; otherwise
only `size` / `maxSeq` are updated so commits do not parse whole day files.
Corrupt diagnostics and `partial` run flags are counted once, scoped to runs
affected by that line, and `partial` clears when the line is repaired or
removed. `repairUsageLedger` always rebuilds the read-model from the committed
journal (ignoring the on-disk index snapshot). A key left at
`pendingReplacement` after a crash between the correction and replacement usage
records may be completed with a second `applyUsageCorrections` call.
`readUsageLedgerState().corrections` exposes each correction's timestamp,
`normalizationVersion` and scope; `diagnostics.corrections` increments once per
applied supersede. A repeated correction is a no-op (`already_superseded`);
duplicate keys in one batch are skipped as `duplicate`. Usage without a prior
`run-start` keeps an active run flagged `inferredWithoutRunStart` and a
diagnostic instead of pretending the run was started cleanly. Legacy events
without a reliable raw payload stay `legacy`/`partial`/`unknown` with no
guessed cache or tokens.

## 10. Harness field evidence matrix (billed/run vs `promptTokensForWindow`)

Sources are the named evidence cards and production symbols below. **Billed/run**
fields feed `billedTotalTokens`; **window candidate** fields are the only ones
that may feed `promptTokensForWindow` (current prompt, never a run aggregate).
`cum` = cumulative and `snap` = snapshot. Cache is separate metadata. A value
marked `no evidence (not audited)` is intentionally not treated as a provider,
model, config, or semantic claim; it cannot establish occupancy completeness.

| Harness | Field | Kind | Source | Provider/model/config | Granularity | Semantics | Completeness | Cache | accountingScope |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `sdk` | `usage.inputTokens` + cache fields | billed/run; window candidate | `SDKUsageMessage.usage`; `lib/usage/usage-normalize.js#fromSdkUsage`; card `docs/usage-audits/cursor-sdk.md` §6 | provider/model/config: no evidence (not audited); SDK-selected | turn | snapshot per message; adapter baseline diffs for ledger | partial; no confirmed prompt scope | read/write separate in SDK; contract conflict documented in card | own; subagents no evidence (not audited) |
| `claude` | `result.usage`, `result.modelUsage[model]` | billed/run | `lib/agent-harness/claude-event-normalizer.js#resolveClaudeResultUsage`; card `docs/usage-audits/claude.md` | provider Anthropic; model from `modelUsage` key; config no evidence (not audited) | run | cumulative per query (not confirmed) | partial | cache fields separate | consolidated across models |
| `claude` | `query.getContextUsage()` / `lastCallUsage` | window + limit | `lib/agent-harness/claude-event-normalizer.js`; `lib/claude/claude-models.js#noteClaudeReportedContextWindows`; card §6 | provider Anthropic; model field in control response; config account window | on demand / call | snapshot | complete only after successful control response | cache relation no evidence (not audited) | own |
| `codex` | `turn.completed.usage` | billed/run | `lib/agent-harness/codex-event-normalizer.js`; `lib/usage/usage-normalize.js#fromCodexUsage`; card `docs/usage-audits/codex.md` §A | provider OpenAI/Codex; model from turn context; config no evidence (not audited) | turn | delta | partial for multi-call turns | cached input is subset of input | own thread |
| `codex` | `info.last_token_usage` + `info.model_context_window` | window + limit | `lib/codex/codex-context-usage.js#parseCodexContextUsage`; card `docs/usage-audits/codex.md` §B | provider Codex CLI; model from `turn_context.payload.model`; config from rollout record | one call | snapshot; compacted resets epoch | partial; internal format not stable | cached input subset | own root session |
| `deepseek` | DSH step usage / wire `usage.prompt_tokens` | billed/run | `lib/usage/usage-normalize.js#fromDeepSeekUsage`; `harnesses/deepseek/deepseek-agent-ws.js`; card `docs/usage-audits/deepseek.md` | provider DeepSeek; model/config no evidence (not audited) | message/request | delta for DSH, snapshot for wire | partial | wire cache hit subset of prompt | own; child sessions consolidated |
| `qwen` | `result.usage` / `result.modelUsage[model]` | billed/run | `lib/usage/harness-usage.ts#resolveHarnessUsageTokens`; card `docs/usage-audits/qwen.md` | provider Qwen; model key; config provider/model payload no evidence (not audited) | run | cumulative per run not confirmed | partial | cache fields separate | consolidated across models |
| `qwen` | `assistant.message.usage.input_tokens` + `modelUsage.contextWindow` | window + limit | `lib/usage/harness-usage.ts#resolveHarnessUsageTokens`; card §6 | provider Qwen; model key; context window from SDK | request | snapshot | input completeness not confirmed | cache inclusion not confirmed | own |
| `opencode` | `tokens.input/output/reasoning/cache.*` | billed/run | `harnesses/opencode/opencode-usage.js#readOpenCodeTokenSnapshot`; card `docs/usage-audits/opencode.md` | provider/model/config: no evidence (not audited); OpenCode session | message/step | cumulative snapshot inferred from adapter diff | partial; no real capture | input excludes cache by contract | own session |
| `opencode` | latest token snapshot + `limit.context` | window + limit | `harnesses/opencode/opencode-usage.js#readOpenCodeTokenSnapshot`; catalog `lib/model-catalog.js#readCatalogContextWindowTokens`; card §6 | provider/model from OpenCode session/catalog; config catalog row | message | snapshot inferred | partial; meaning not confirmed | add cache fields; no provider confirmation | own |
| `codebuddy` | `result.usage` | billed/run | `lib/usage/harness-usage.ts#resolveHarnessUsageTokens` → `resolveClaudeResultUsage`; card `docs/usage-audits/codebuddy.md` | provider CodeBuddy; model/config no evidence (not audited) | run/message | cumulative not confirmed | partial | read/creation fields separate | consolidated not confirmed |
| `codebuddy` | `compact_metadata.pre_tokens/post_tokens` | window candidate | `harnesses/codebuddy/codebuddy-event-normalizer.js`; card §6 | provider CodeBuddy; model/config no evidence (not audited) | compaction event | snapshot | cache n/a | own; post value optional |
| `openrouter` | `usage.prompt_tokens` + cache details | billed/run; window candidate | `lib/usage/usage-normalize.js#fromOpenRouterUsage`; `lib/providers/openrouter/openrouter-models.ts`; card `docs/usage-audits/openrouter.md` | provider OpenRouter; model from response/catalog; config context length not retained | request | snapshot | partial; context limit unavailable | cached subset included in prompt | own request |
| `mistral` | `usage.prompt_tokens` + cache details | billed/run; window candidate | `lib/usage/usage-normalize.js#fromMistralUsage`; `harnesses/mistral/mistral-client.js`; no evidence card | provider Mistral; model/config no evidence (not audited) | request/run | delta contract; prompt snapshot not audited | no evidence (not audited) | cache subset supported by normalizer | own |
| `zai` | raw `prompt_tokens` / `completion_tokens` | billed/run; window candidate | `harnesses/zai/zai-sdk-client.js`; `lib/usage/usage-contract.js` entry; no evidence card | provider Z.AI; model/config no evidence (not audited) | message | snapshot contract; live semantics no evidence (not audited) | no evidence (not audited) | cache details no evidence (not audited) | own |
| `mimo` | raw `prompt_tokens` / `completion_tokens` | billed/run; window candidate | `harnesses/mimo/mimo-client.js`; `lib/usage/usage-contract.js` entry; no evidence card | provider MiMo; model/config no evidence (not audited) | message | snapshot contract; live semantics no evidence (not audited) | no evidence (not audited) | cache details no evidence (not audited) | own |

Rules: a run aggregate (`result.usage`, `total_token_usage`, DeepSeek room sum)
is never a window candidate. A row without a confirmed window size cannot
produce a percent (see section 11).

### 10.1 Field provenance with evidence tags

Per-field provenance for all 11 matrix harnesses. Evidence tags: `[OBSERVED]`
fixture/test, `[CODE]` adapter code, `[DOC]` vendor docs, `[UNCONFIRMED]` no
live payload, `[CONFLICT]` sources or interpretations disagree. No audit pinned
a live provider/model/config payload, so each Provider/model/config cell names
where the model/config comes from, or `UNKNOWN` with the reason (`mistral`,
`zai` and `mimo` have no audit card). None of the window candidates below is
confirmed `complete`, so none can yield an occupancy percentage on this
evidence alone. Where this table and the table above differ in wording, the
table above and the code win.

| Harness | Field | Kind | Source | Provider/model/config | Granularity | Semantics | Completeness | Cache | accountingScope |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `sdk` | `usage.*` | billed/run | `SDKUsageMessage` → `lib/usage/usage-normalize.js#fromSdkUsage` `[CODE]` (`docs/usage-audits/cursor-sdk.md` §6) | UNKNOWN: model is picked by the Cursor SDK per chat; no live payload | turn | per-turn per docs; Cretli diffs as cum `[CONFLICT]` | partial | read+write; input inclusive vs disjoint `[CONFLICT]` | own (subagents `[UNCONFIRMED]`) |
| `sdk` | `usage.inputTokens` + cache | window candidate | same message, `fromSdkUsage` `[CODE]` | UNKNOWN: as above | turn | snap | partial | additive | own |
| `claude` | `result.usage`, `result.modelUsage[m]` | billed/run | Claude Agent SDK `result` → `lib/agent-harness/claude-event-normalizer.ts#resolveClaudeResultUsage` `[CODE]` | per-model map keyed by model id in the payload; no live payload | run | cum `[UNCONFIRMED]` | partial | separate buckets | consolidated |
| `claude` | `assistant.message.usage` | window candidate | `assistant` stream message in `claude-event-normalizer.ts` `[CODE]` | UNKNOWN: model comes from the message; no live payload | request | snap | partial; input excludes cache `[UNCONFIRMED]` | read+write additive | own |
| `claude` | `getContextUsage()` `totalTokens`/`maxTokens` | window + limit | `query.getContextUsage` in `lib/claude/claude-context-breakdown.ts` `[CODE]` (timeout-guarded) | active model of the query; value is whatever the SDK returns | on demand | snap | complete only if the call succeeded | n/a | own |
| `codex` | `turn.completed.usage` | billed/run | `lib/agent-harness/codex-event-normalizer.ts` → `fromCodexUsage` `[CODE]` (`docs/usage-audits/codex.md`) | UNKNOWN: model from Codex CLI config (not read by Cretli); no live payload | turn | delta | partial (multi-call turns) | cached ⊂ input | own thread |
| `codex` | `total_token_usage` | billed/run | rollout `token_count` `info`, `lib/codex/codex-context-usage.ts` `[UNCONFIRMED]` (internal file format) | UNKNOWN: written by Codex CLI, format not versioned | thread | cum | partial | `cached_input_tokens` / cache-write from the same `info` | whole thread |
| `codex` | `last_token_usage` + `model_context_window` | window + limit | rollout `token_count` `info`, `parseCodexContextUsage` `[CODE]` | window size comes from the rollout record itself; no live payload audited | request | snap; `compacted` resets the epoch | partial | cached ⊂ input | own root session |
| `deepseek` | DSH step usage | billed/run | DSH `data.usage` → synthetic `usage` event in `harnesses/deepseek/deepseek-event-normalizer.js`, folded per step in `deepseek-agent-ws.js`; `fromDeepSeekUsage` `[CODE]` | UNKNOWN: DSH config/model; no live payload | message | delta | partial | disjoint | own; child sessions consolidated |
| `deepseek` | DSH `inputTokens`+`cacheReadTokens` / wire `prompt_tokens` | window candidate | DSH event `[CODE]`; wire `prompt_tokens` only in `docs/usage-audits/deepseek.md` `[DOC]` `[UNCONFIRMED]` | UNKNOWN: DSH config/model and window size | request | snap | partial | wire hit ⊂ prompt | own |
| `qwen` | `result.usage` | billed/run | Qwen Code SDK `result` → `harnesses/qwen/qwen-event-normalizer.js` → `fromQwenUsage` `[CODE]` | UNKNOWN: model from Qwen config; no live payload | run | cum vs last call `[UNCONFIRMED]` | partial | read only (`cacheWrite: false` in the contract) | consolidated `[UNCONFIRMED]` |
| `qwen` | `assistant.message.usage.input_tokens` + `modelUsage.contextWindow` | window + limit | Qwen `assistant` message usage; `hasQwenUsageCounts`; static `contextWindowTokens` fallback in `harnesses/qwen/qwen-models.js` `[CODE]` | UNKNOWN: live `contextWindow` never observed; catalog value is static | request | snap; includes cache `[UNCONFIRMED]` | partial | read; write not guaranteed | own |
| `opencode` | `tokens.*` | billed/run | `message.updated` SSE → `harnesses/opencode/opencode-usage.js#readOpenCodeTokenSnapshot` `[CODE]`, fixtures `[OBSERVED]` (`harnesses/opencode/tests/opencode-usage-telemetry.test.js`) | UNKNOWN: provider/model chosen in OpenCode config | message | cum snap `[UNCONFIRMED]` (inferred from adapter diff) | partial | disjoint read+write | own |
| `opencode` | latest `input`+`cache.read`+`cache.write`; `limit.context` | window + limit | same event; `limit.context` from the provider catalog (`lib/model-catalog.js#readCatalogContextWindowTokens`) `[CODE]` | catalog of the local OpenCode server; per-model, not recorded live | message | snap `[UNCONFIRMED]` | partial | additive | own |
| `codebuddy` | `result.usage` | billed/run | CodeBuddy `result` → `harnesses/codebuddy/codebuddy-event-normalizer.js` → `fromClaudeUsage` `[CODE]` | UNKNOWN: model from CodeBuddy config; no live payload | run | cum `[UNCONFIRMED]` | partial | read+write | consolidated `[UNCONFIRMED]` |
| `codebuddy` | `compact_metadata.pre_tokens`/`post_tokens` | window candidate | `system` compaction event in `codebuddy-event-normalizer.js` `[CODE]` | UNKNOWN: window size not reported anywhere in code | compaction event | snap | partial | n/a | own |
| `openrouter` | `usage.*` | billed/run | `lib/usage/usage-normalize.js#fromOpenRouterUsage`, reached through `lib/usage/harness-usage.ts` `[CODE]`; payload is the OpenAI-compatible chat-completion `usage` `[DOC]` | model id from Settings → Harness → OpenRouter; no live payload | request | snap | partial | read ⊂ prompt (verified; adapter subtracts) | own |
| `openrouter` | `prompt_tokens` | window candidate | same `usage.prompt_tokens`, same `[CODE]` path; field meaning `[DOC]` | window size UNKNOWN: catalog `context_length` (`lib/providers/openrouter/openrouter-models.ts`) is not wired into the occupancy limit | request | snap | partial | included | own |
| `mistral` | `usage.prompt_tokens`/`completion_tokens`/`total_tokens` | billed/run | SDK stream chunk `usage` → `fromMistralUsage` via `harnesses/mistral/mistral-client.js` `[CODE]`; last chunk per response in `lib/agent-harness/llm-tool-loop.js` | model id from Mistral settings; no live payload | request/run | delta contract; prompt snap UNKNOWN | UNKNOWN: no audit card | cache ⊂ prompt supported by the normalizer; live UNKNOWN | own |
| `mistral` | window | window + limit | `maxContextLength` from the model list in `harnesses/mistral/mistral-models.js` `[CODE]` | UNKNOWN: catalog value, never matched to a live request | request | UNKNOWN | UNKNOWN | UNKNOWN | own |
| `zai` | `usage.prompt_tokens`/`completion_tokens`/`total_tokens` | billed/run | worker stream event `usage`, `harnesses/zai/zai-sdk-client.js#normalizeUsage` `[CODE]` | `getZaiSdkProvider() === 'zai-coding-plan'` selects the coding endpoint, any other provider the general `paas` endpoint; model from `harnesses/zai/zai-models.js`; no live payload | message | snap (contract); live UNKNOWN | UNKNOWN: no audit card | UNKNOWN | own |
| `zai` | window | window + limit | `contextWindowTokens` in `harnesses/zai/zai-models.js` `[CODE]` | UNKNOWN: static catalog, not matched to a live request | request | UNKNOWN | UNKNOWN | UNKNOWN | own |
| `mimo` | `usage.*` | billed/run | OpenAI-compatible `chat/completions` `usage` passed through unchanged by `harnesses/mimo/mimo-client.js` `[CODE]` | base URL from `getEffectiveMimoBaseUrl()`; model from `harnesses/mimo/mimo-models.js`; no live payload | message | snap (contract); live UNKNOWN | UNKNOWN: no audit card | UNKNOWN | own |
| `mimo` | window | window + limit | static `contextWindowTokens` in `harnesses/mimo/mimo-models.js` `[CODE]` | UNKNOWN: static catalog value, not matched to a live request | request | UNKNOWN | UNKNOWN | UNKNOWN | own |

## 11. Occupancy assessment schema (`assessContextOccupancy`)

A token count is not an occupancy. The pure helper
`assessContextOccupancy` (`USAGE_OCCUPANCY_SCHEMA_VERSION = 1`) returns
`{schemaVersion, reliable, percent, promptTokens, limitTokens, reasons[],
cache:{read, write, separate:true}}`. `percent` is non-null only when **all**
hold; each failure appends a reason code and forces `percent = null`:

| Requirement | Reason code when violated |
| --- | --- |
| prompt size known (explicit or from `promptTokensForWindow`) | `prompt_tokens_unknown` |
| window semantics (inclusive/disjoint) known | `window_semantics_unknown` |
| scope is `current_prompt` (not `run_billing`/`cumulative`/`unknown`) | `scope_not_current_prompt` |
| granularity `request`/`message`/`turn` (not run/session) | `granularity_unreliable` |
| completeness is confirmed `complete` (`partial`/`missing`/`unsupported`/absent never yield a percent) | `measurement_incomplete` |
| `observedAt` known, not in the future, within `maxAgeMs` (default 10 min) | `stale_or_unknown_time` |
| measurement `contextEpoch` equals the current epoch | `context_epoch_mismatch` |
| window limit known and positive | `limit_unknown` |

Cache stays separate metadata (`cache.*`); it is never subtracted from
occupancy without evidence. An empty token bag is a missing measurement (`promptTokensForWindow = null`);
a reported explicit zero stays `0`. Window semantics must be known (a contract
is required) even when `promptTokens` is passed explicitly.

### 11.1 Eligibility predicate (extended)

`assessContextOccupancy` adds these rules on top of the table above (all
append a reason code and force `percent = null`):

| Requirement | Reason code |
| --- | --- |
| `provenance === 'reported'`; `estimated`, `unknown` and absent (legacy) never qualify | `provenance_not_reported` |
| `accountingScope` is `own`; `consolidated` aggregates children | `accounting_scope_consolidated` |
| `measurementKind` is not `cumulative` | `measurement_cumulative` |
| `run`/`session` granularity only with adapter-confirmed current-prompt semantics (`currentPromptConfirmed`) **and** a `snapshot` | `granularity_unreliable` |
| cache read + write never exceeds the prompt it belongs to | `cache_exceeds_prompt` |
| a keyed `limit` belongs to the measurement's `limitKey` | `limit_key_mismatch` |

`assessEventOccupancy(event, ctx)` maps a persisted event onto the predicate.
Events from schema 1 (no provenance/granularity/epoch) stay readable but are
never eligible; a schema newer than this build gets `schema_unreadable`. The
event is never mutated, so billed totals and the history ledger are untouched.

**Freshness.** The timestamp is the event `at` (`observedAt`).
`resolveOccupancyFreshness` gives a TTL relative to the transport: `live`
10 min (`USAGE_OCCUPANCY_MAX_AGE_MS`), `closed`/unknown 2 min
(`USAGE_OCCUPANCY_CLOSED_TRANSPORT_MAX_AGE_MS`, nothing can refresh the number),
or an explicit `maxAgeMs`. Timestamps more than 5 s in the future are rejected.
Stale behavior: `percent = null`, `stale = true`, `expiresAt` set, and
`lastKnown = {promptTokens, observedAt}` so a reader may show "last seen" text;
no automatic decision may use it.

**contextEpoch.** A monotonic per-conversation counter. These lifecycle events
bump it by exactly one (`advanceContextEpoch`,
`USAGE_CONTEXT_EPOCH_BUMP_EVENTS`): `fresh_session`, `reset`, `compaction`,
`model_switch`. Requests, retries, reconnects and usage re-delivery keep it.
`compareContextEpoch` orders numeric epochs (`older`/`newer`); labels only
compare for equality. An event from an older epoch is `context_epoch_mismatch`
+ `context_epoch_old` for occupancy only; it still counts in billed totals.

**Limits.** Keyed by `harness|provider|model|config`
(`buildOccupancyLimitKey`; any missing part gives `null`, no fuzzy fallback).
`normalizeOccupancyLimit` keeps four distinct numbers: `contextWindowTokens`
(the percent denominator), `maxInputTokens`, `maxOutputTokens` and
`responseReserveTokens`; `usableInputTokens = min(window - reserve (or output
cap), maxInput)` feeds `headroomTokens`. Unknown window gives `null`, never a
guessed percent.

## 12. Open human decision: billing boundary

**Status: OPEN — requires a human decision; not resolved in code.** Question:
which quantity is the product's "billed" boundary — (a) per-request provider
usage summed by Cretli (`own`), (b) the harness-reported run aggregate
(`consolidated`, e.g. Claude `result.usage`, Codex thread totals), or (c)
provider-invoiced cost (`usd`)? Today the ledger sums disjoint `own` buckets and
keeps `consolidated` separate and never added. Until decided, no adapter,
UI or server propagation may change which scope feeds headline totals.

## 13. History and diagnostics propagation (`usageMeta`)

`lib/usage/usage-history-meta.ts` stamps every `usage` / `context_usage` sdk
event once, in `broadcastRoom`, before WS fan-out and history persistence. The
additive `event.usageMeta` block carries `provenance`, `accountingScope`,
`measurementKind`, `granularity`, `completeness`, `contextEpoch`
(`contextEpochSource`: `event` when the adapter carried it, else `room_at_observation`, or `room_implicit_zero` when the room never advanced it),
`observedAt`, `sourceSessionId`, `logicalEventKey` and a structural
`occupancy {eligible, reasons, promptTokens, limitTokens}`. The raw payload is
never rewritten and billed totals are untouched.

- A `usage` event is billing-shaped: never `complete`, never an occupancy
  reading (`measurement_incomplete`, `limit_unknown`).
- A `context_usage` event is one call snapshot (`request`/`snapshot`); its
  `sessionUsage` totals are ignored. Prompt size follows the harness window
  semantics (inclusive: `inputTokens`; disjoint: input + cache); unknown
  semantics give no prompt size.
- Zero vs missing: a reported all-zero bag is `tokensPresent: true`; no bag is
  `completeness: 'missing'`; per-scope totals stay `null` until a counter is
  actually reported.

`summarizeChatHistoryUsage` adds `usageMeta` (counts, `latestContextEpoch`,
`lastUsageMeta`, `byScope.own|consolidated|unknown`, `currentPrompt`). Lateness is provable only for `event`-sourced epochs; a room-stamped epoch never claims it. Only own, non-late events advance the epoch/session/model markers (child, late and billing events do not). Replays
with the same `logicalEventKey` count once inside `usageMeta` only (legacy summary fields still see every event; a bare turn id is identity only for turn-granularity harnesses); a newer epoch, a different source
session or a different model clears `currentPrompt`; an event from an older epoch
delivered late is counted in `lateEpoch` and never becomes current. `GET
/api/chats/:id/diag` exposes it as `contextStats.history.usageMeta` plus
`currentPromptOccupancy`, re-assessed at read time with
`assessContextOccupancy` (freshness, epoch), so a stale snapshot yields
`percent: null`.

Historical events written before `usageMeta` are labelled `legacy: true` and
keep only what the record holds (harness, `createdAt`); provenance, scope,
completeness and epoch stay `null`, with the single reason
`legacy_no_metadata`. Coverage: `tests/usage-history-propagation.test.js` with
fixture `tests/fixtures/usage/history/raw-usage-sdk-events.json`.

## Live context measurement (history path)

- **One derivation.** The prompt size of a `context_usage` snapshot is computed by
  `promptTokensForWindow` only (the raw payload is first mapped onto the canonical
  token bag); there is no second implementation.
- **`occupancy.source`.** `snapshot` = a per-call prompt snapshot (the only value
  that can be occupancy-eligible); `estimated` = anything else, in particular
  billing `usage` events of harnesses without a per-call snapshot. An `estimated`
  event is never eligible and never becomes `currentPrompt`.
- **Out-of-order rejection.** Besides the epoch carried by an event
  (`counts.lateEpoch`), an adapter source timestamp (`sourceObservedAt`, from
  `sourceObservedAt` / `sourceAt` / `sourceTimestamp` on the event) older than one
  already accepted is rejected (`counts.lateTime`).
- **Epoch advance.** `recordContextRestart({ room })` advances `_contextEpoch` for
  `model_change`, `session_drop` and `process_recreated`; the room kernel also
  advances it when any `usage` / `context_usage` event shows a different explicit
  model or source session than the previous one (`noteRoomMeasurementIdentity`).
  Events that carry their own epoch and child (consolidated) events never move
  that baseline.
- Billing (`billedTotalTokens`, `accountingScope`) is untouched by this path.
