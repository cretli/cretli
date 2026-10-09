# Usage contract and harness coverage matrix

Status: contract revision `2026-10-06.3`, `schemaVersion = 2`,
`normalizationVersion = 2`.

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
| `qwen` | raw | delta | run | yes / no | unknown | yes | yes | durable_sequence (session, request) | — |
| `opencode` | raw | snapshot | message | no / no | separate | yes | yes | durable_sequence (session, message) | run reset |
| `codebuddy` | raw | delta | message | yes / no | unknown | yes | yes | durable_sequence (session, message) | — |
| `openrouter` | raw | delta | request | yes / no | unknown | yes | no | provider (event id) | — |

The `voice` harness shares the ledger and is described in the module, but is
not one of the eight required matrix rows.

Contract sources (owned by the named symbol, not duplicated here):

- `sdk`: `lib/usage/usage-normalize.js#fromSdkUsage`
- `claude`: `lib/agent-harness/claude-event-normalizer.js#resolveClaudeResultUsage`
- `codex`: `lib/usage/usage-normalize.js#fromCodexUsage`
- `deepseek`: `lib/usage/usage-normalize.js#fromDeepSeekUsage`
- `qwen`: `lib/usage/usage-normalize.js#fromQwenUsage`
- `opencode`: `lib/opencode/opencode-usage.js#readOpenCodeTokenSnapshot`
- `codebuddy`: `lib/usage/usage-normalize.js#fromClaudeUsage` (raw snake_case)
- `openrouter`: `lib/usage/usage-normalize.js#fromOpenRouterUsage`

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
before the bag and its window semantics are `inclusive`.

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

This is a read-model change only: no persisted event field changes, so
`schemaVersion`/`normalizationVersion` stay at `2`.

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
