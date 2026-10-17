# Model pick decisions and cycle outcomes

Contract for stage 4 of the token/model plan (`5af7d7aa`): persisted
`model_pick` proposals, optional `pick_id` on `delegation_start`, and
cycle-level quality/cost metrics exposed on `GET /api/delegations/stats`.

## Pick proposal (`model_pick`)

Every successful MCP `model_pick` call persists a proposal:

| Field | Meaning |
| --- | --- |
| `pickId` | Stable UUID returned in tool metadata (`pickId` / `pick_id`). |
| `pickExpiresAt` | `createdAt + 30 minutes` (TTL). |
| `policyVersion` | From `MODEL_PICK_POLICY_VERSION` in `lib/model-pick-policy.js`. |
| `role` | Logical role (`plan`, `implement`, `review`, `fix`). |
| `candidates` | Bounded candidate set (max 12) copied from the pick response. |
| `picks` | Fanout slots (max 5), slot `0` = primary selection. |
| `complexity` | `{ level, signals[] }` from the task complexity signal (below). Every `model_pick` response (success and error) carries it; the journal stores it on each persisted proposal (failed picks create no proposal). |

Retention: unclaimed proposals older than 30 days are purged on the next write.
Executed links remain on delegation rows.

Decision journal stores metadata only (no prompts). Pick candidates keep
`harness`/`model`/`selectionSlot`/`originDetailHint`; the human-readable
`reason` and any prompt/task text are never copied into the journal.

## Task complexity signal (shadow)

`lib/model-pick-complexity.js` exports `classifyTaskComplexity({ role, leafBody,
leafSize, heavy, history, sourceKind })` and returns `{ level, signals }`. It is
computed for every `model_pick` (also without a leaf), written to the decision
journal and returned as `complexity` in the `model_pick` response. It is a
shadow signal: it never changes candidate selection.

`level` is `trivial`, `standard` or `demanding`. `signals` is a list of codes
from a **closed list**; the persistence layer drops anything else, so the leaf
body (or any free text) cannot reach the journal.

| Signal | Meaning |
| --- | --- |
| `no_leaf_context` | Neither a leaf body nor a leaf size was available (level defaults to `standard`). |
| `leaf_size_small` / `leaf_size_large` | Result of `classifyLeafSize`; large raises to at least `standard`. |
| `few_files` / `many_files` | Existing file paths named in the leaf; more than 6 raises to `demanding`. |
| `risk_keywords` | Security, auth, migration, schema, concurrency, encryption, secret, credential, data loss, breaking change and similar words (Polish: `migracja`, `kontrakt`, `bezpiecze*`); raises to at least `standard`. |
| `review_fail_history` | `history.reviewFailCount` is a per-leaf count of real review delegations (plan-mode `review` rows excluded) whose report carries a `VERDICT: FAIL` line. At least 2 review FAILs make the leaf `demanding`. |
| `role_floor_standard` | `review`/`plan` role or `sourceKind=plan`; never below `standard`. |
| `explicit_heavy` | `heavy: true` on the pick; `demanding`. |
| `explicit_level` | The `complexity` parameter overrides the heuristic level. |
| `explicit_level_invalid` | The `complexity` parameter was non-empty but not `trivial\|standard\|demanding`; it was ignored and the heuristic level kept. The raw value is never stored. |

For `review` and `plan` picks with a leaf todo the response carries `leaf_size`
and the `leaf_size_*` signals; `implement` already computed its leaf size for
the flash policy and the `leaf=` pick-reason suffix. A `fix` pick deliberately
computes no leaf size at all: its candidate selection must stay unchanged, so it
never emits `leaf_size` or a `leaf_size_*` signal.

Inputs reach the classifier in memory only (`leafBody`, `leafSize`, `heavy`,
`complexity`, `source_kind`); the stored record keeps `level` and `signals` and
nothing else.

## Cost policy (`complexityPolicy`, shadow by default)

`lib/model-pick-cost-policy.js` (rules, config, canary evaluator) and
`lib/model-pick-cost-policy-layer.js` (glue in `pickModelForPurpose`, shared by
`model_pick`, the Watcher orchestrator and the Scout) implement plan v10
§2.3, §2.4 and §2.7. Config: `complexityPolicy` in `data/model-role-profiles.json`.

| Key | Default | Meaning |
| --- | --- | --- |
| `mode` | `shadow` | `off` (no layer), `shadow` (record verdict + counterfactual, selection unchanged), `enforce`. |
| `ceilings.<role>.<level>` | implement/fix 2/3/4, review/plan 4 | Max cost tier (1..4). Candidates above are **filtered**, never silently raised. |
| `autoPremium` | `heavy_only` | Tier 5 is eligible only for `demanding` and (`premium:true` or `heavy:true` when `heavy_only`). `never` requires `premium:true`. |
| `modelPolicy.models` | none | Per model `auto`, `heavy_only`, `manual_only` (never in autopick; explicit `delegation_start` still works). |
| `qualityFloor` | 1/3/4 | Min quality tier per level; review/plan are lifted to 4. Flash is refused for review/plan/demanding. |
| `effortFloorMin` | `medium` | Review/plan/demanding need effort >= this for models with an effort param (`normalizeEffortParam`). |
| `infraFailCeiling` | 0.5, review 0.35 | Per-role infra-fail ceiling (min n = `infraMinN`, default 3). |
| `canary` | 20% / 7 days | See below. |

Rejection reasons are a closed list: `cost_ceiling`, `tier5_not_allowed`,
`model_policy_manual_only`, `model_policy_heavy_only`, `quality_floor`,
`flash_not_allowed`, `effort_floor`, `infra_fail_ceiling`. The journal stores a
`costPolicy` block (mode, bucket, phase, `wouldChange`, `policyPick`,
`counterfactualPick`, rejected candidate ids with codes) and nothing else.

When no candidate is left the pick fails with `MODEL_UNAVAILABLE` and
`reason: cost_ceiling` plus the rejected list (suggestion `premium:true`).
The orchestrator, refine/review loops and the Workspace Scout must report this and ask the human to re-run explicitly with `premium: true` (or a named premium model); they never silently escalate to an expensive model.
Before that, the quality floor is relaxed by one tier **only** for
implement/fix trivial/standard; the ceiling and review/plan floors never relax.

Canary: with `mode: enforce`, the first pick starts a 7-day window
(`data/model-pick-cost-policy-state.json`). Inside it only implement/fix
trivial/standard picks in a deterministic 20% bucket (`sha256(chat|leaf|role|purpose) mod 100`)
are enforced; the rest stay shadow. A rolling evaluator on every pick compares
canary vs control (review FAIL +10 pp, `no_candidate` +5% / +2% for review,
infra-fail +`infraFailMaxIncreasePp`, min 10 samples) and on breach writes
`rolledBackAt` + reason and falls back to `shadow`. Enforce appends
`cost-policy=enforce` to the policy version cohort.

## `delegation_start` link

Optional `pick_id` / `pickId` on MCP/HTTP start. Watcher/Scout/orchestrator
prompts forward the `pickId` returned by `model_pick` straight into
`delegation_start` (one pick → one start) without re-picking or matching the
proposal by time; the server classifies the link at start time.

| `pickOrigin` | When |
| --- | --- |
| `auto` | Valid, non-expired `pick_id` that belongs to the starting chat **and** workspace, with a matching role, a matching executor from the explicit `picks`, and a reserved slot. |
| `manual` | Allow-listed `manual_source` on the start request (see below). |
| `unknown` | Legacy rows, missing link, expired link, cross-chat/cross-workspace link, mismatched executor/role, or a rejected manual/fallback claim. |

| `pickOriginDetail` | When |
| --- | --- |
| `selected` | Primary pick (slot 0). |
| `alternate` / `fanout` | Secondary fanout slot. |
| `fallback` | `pick_fallback_from` or executor change with fallback proof; it is its own job/attempt with its own `attemptId`. |
| `explore` | Cold-start / explore reason on the matched candidate. |
| `rejected-link` | Invalid or expired link (start gates still apply). |
| `legacy` | No `pick_id` on start. |

Invalid links **never** bypass workflow or eligibility gates: the executor
model gate runs before link classification, so an ineligible model stays
unavailable and its pick slot is not consumed.

Binding and evidence:

- A `pick_id` is bound to the chat and workspace that proposed it
  (`pick.chatId` / `pick.workspaceFolder`). A start from another chat, another
  workspace, or without a start context is `unknown` / `rejected-link` and never
  `auto`.
- `manual_source` is an allow-list (`manual`, `user`, `operator`, `ui`,
  `settings-ui`, `todo-assignee`). Any other value is rejected as unknown, so
  free text can never claim manual priority over a `pick_id`.
- `pick_fallback_from` must name a real earlier delegation of the **same**
  parent chat (and the same leaf when both know one) whose executor differs from
  the new start. Unknown ids, another chat's job, a same-executor job, or free
  text are `rejected-link`. A valid fallback is its own job/attempt and reserves
  its own `fallback:<delegationId>` slot, so it never aliases the primary slot 0.

Reservation and counters:

- Any start that carries a `pick_id` requires an `idempotency_key`; without one
  the server refuses it with `400 idempotency_key_required` and reserves
  nothing, so one pick cannot back unlimited `auto` starts.
- The slot is reserved **before** the delegation row exists. A refused
  reservation (`slot_taken`, `expired`, `lock_timeout`) returns `409` and leaves
  no queued orphan behind, so a pick without a real start raises only
  `proposals`. If record creation throws after a successful reservation, the
  slot is released.
- Slot reservation is atomic per `(pickId, selectionSlot)` and cross-process
  safe: the pick document is read-modify-written under the same SQLite
  `BEGIN IMMEDIATE` document lock the workspace watcher store uses. Replays with
  the same `idempotency_key` are idempotent; a taken slot rejects a new key with
  `slot_taken`.
- Only explicit `picks` own a selection slot (max 5). Audit-only `candidates`
  keep a `null` slot and can never be matched into a start, and a numeric slot
  outside the explicit picks is refused.
- A concurrent start for another parent in the same workspace is re-checked
  immediately before the synchronous record create, so two starts cannot both
  pass the `workspace_busy` gate across the pick reservation await.

## Failure classes, exclusion scope and recovery

`lib/delegation-failure-class.js` classifies a failed run from structured error
text: `transient_transport`, `model_unavailable`, `auth`, `quota`,
`harness_outage`, `unknown`. The class drives lockout scope and bounded fallback eligibility; the single blacklist
stays the shared lockout store (`lib/harness-usage-limits.js`,
`lib/delegation-startup-lockout-policy.js`).

| Class | Lockout row | Scope | Expiry |
|---|---|---|---|
| `transient_transport` (startup/first-event timeout) | `code=startup_failure` | workspace + harness + canonical model | 2 h, 12 h on a repeat inside 24 h (unchanged defaults) |
| `model_unavailable` (incl. Codex "selected model may not be available") | `code=model_unavailable` | workspace + canonical model for delegation evidence; legacy provider rows remain model-scoped; siblings stay eligible | 24 h |
| `quota` | usage-limit row | model, or whole harness only for credit exhaustion | provider reset, else TTL |
| `auth`, proven `harness_outage` | separate shared-store row | workspace + harness | startup policy TTL (2 h default); success does not erase auth |
| `unknown` | none | never excludes or authorizes infrastructure fallback | n/a |

Rows carry `failureClass`, `scope` and `expiresAt`; an expired row stops
excluding candidates. A technically successful completion of the same
harness/model in the same workspace clears only the matching
`startup_failure` row (`clearHarnessStartupFailureLockout`, called from
`finishDelegation`); quota/auth rows and other models are untouched. User
exclusions (model overrides) stay separate and authoritative. Old failures are
therefore never prose-only blacklists: eligibility is recomputed by every new
`model_pick`, so a recovered model returns to the candidate set (not
guaranteed to win).

**Bounded fallback.** `pick_fallback_from` is valid only for a real earlier
delegation of the same controller and leaf that is `failed`, no longer holds
its slot (`slot_occupied=false`) and ran on a different executor. The fallback
reserves its own `fallback:<id>` slot, so a second fallback from the same
attempt is `slot_taken`, and the same idempotency key replays. The fallback
executor still comes from a new `model_pick` (`pick_id`). No paid probes and
no blind same-model retries. The row stores `fallbackFailureClass`.

## Automatic start context

Server-owned, never taken from a request body:

| `startContext` | Meaning |
|---|---|
| `automatic` | Controller launched by the server: TODO execution/continue/full/refine (even when clicked by a user) and Watcher cycles. Persisted in `data/delegation-start-context.json` when the parent is created, before any child can start. Older parents are derived once from durable evidence (Watcher active cycle, `pickPurpose=watcher-orchestrator`, the TODO's server-written `chatId`) and then persisted; a caller-editable `orchestrator_chat_id` alone is only a hint. |
| `human_ad_hoc` | Reserved marker for a persisted human ad-hoc chat (same behavior as legacy). |
| `legacy_ad_hoc` | No execution evidence. Existing ad-hoc behavior is unchanged; shown on the card with unknown provenance. |

In an `automatic` context `delegation_start` needs one of:

1. a current `pick_id` that links as `auto` (valid, unexpired, same chat and
   workspace, role and executor match, slot not yet taken);
2. `continuation_of`: a **completed** earlier delegation of the same controller,
   leaf, role family and executor, with a free slot. Recorded as
   `pickOrigin=unknown`, `pickOriginDetail=continuation`, `continuationOf=<id>`
   (never fabricated as auto/manual); every current gate and lockout still
   applies; or
3. a single-use UI action proof (below).

Otherwise it fails before any row, queue entry or slot is touched with
`automatic_start_requires_pick` or `automatic_pick_rejected` (409).
`manual_source` is audit text only: in an automatic context it is ignored when
a valid pick is present and does not exempt the start.

HTTP tooling (`CretliApiClient`) identifies its agent channel at login. The server persists that session restriction, so dropping a later header cannot turn that session into a human. Agent markers only restrict access; no caller marker grants human authority.

**UI action proof.** `POST /api/chats/:id/delegation-ui-actions` (human browser
session only; MCP/widget/integration identities get 403) mints an action bound
to chat, workspace, role, executor (and optional task hash), expiring after two
minutes. `createAndStart` verifies it after the idempotency replay and consumes
it after all gates pass, right before the slot is reserved: the start is
recorded `pickOrigin=manual`, `pickOriginDetail=ui`, `uiActionProof=true`. Reuse,
expiry, a foreign chat/workspace or another role/executor/task yields a typed
403 (`ui_action_used|unknown|expired|foreign|mismatch|forbidden`). The exception
is per action: later agent starts in the same automatic parent are still gated.

The delegation card shows source (picker / continuation / manual / fallback),
controller context, fallback failure class and any active exclusion with scope
and expiry.

Delegation rows store: `pickId`, `pickOrigin`, `pickOriginDetail`,
`pickLinkStatus`, `pickRole`. `pickRole` is the **requested** role captured
before assignment normalization, so a real `fix` job stays `fix`; legacy rows
without that field fall back to the assignment-derived `implement` and are
never guessed as `fix`.

## Cycle outcomes

`buildDelegationQualityCycles` groups terminal implement/fix jobs with their
following review fanout per **cohort** `(parentChatId, leafId)`. Without an
explicit `parentChatId` filter it partitions all rows by cohort before building
timelines, so a review from another leaf never attaches to a foreign implement.
A cycle opens on an `implement`/`fix` (`implementRole` records which) and
closes on the next implement/fix in that cohort.

| Signal | Rule |
| --- | --- |
| `accepted-by-review` | Final implement/fix `completed` with `technicalSuccess` (not user-cancel or infra), ≥1 terminal review, **every** sibling review credible and PASS (infra/conflict/unspecified/cancel siblings block acceptance), and verify per policy (`MODEL_PICK_REQUIRE_VERIFY_FOR_ACCEPTANCE`: missing verify blocks when required; failed verify always blocks). |
| `unreviewed` | No review job at all. |
| `rejected-by-review` | Any sibling FAIL/BLOCKED with a credible verdict. |
| `undecided` | Reviews ran but not all siblings are credible PASS (e.g. infra, conflict, unspecified, or mixed usable verdicts without full PASS). |
| `technicalSuccess` | Terminal `completed`, not user-cancelled, and not classified as infra for that role. |
| `taskOutcome` | Persisted `taskOutcome`, independent of the review verdict. |
| `runClass` | `quality`, `infra`, or `cancel` (user `cancelled` is never infra; generic “aborted” on a cancelled job stays `cancel`). |
| `manualAccepted` | Explicit human accept: `acknowledgedReason === 'accepted'` on a **completed** job (`POST /api/delegations/:id/ack`). Other ack reasons (`reviewed`, `open_child`, failed/interrupted attention) dismiss cards only and do not count. |
| `closed` | Opener and every collected review are terminal. Running cycles only appear with `includeOpen: true`. |

Cycles are scoped by optional `leafId`, expose `workflowId` (`parentChatId:leafId|chat`) and `workflowTaskRevision` (plan hash or task source hash). Usage sums use a 30-day window; `usageRangeTruncated` is set when a cycle opened before that window (partial sum only).

Review FAIL that correctly finds a defect is **not** treated as reviewer infra
failure, and it does not lower `technicalSuccess`.

## Cost per accepted

On `GET /api/delegations/stats`:

- `cycle_cost.effectiveCostPerAcceptedUsd` = priced USD sum of all **closed**
  cycles in scope ÷ count of `accepted-by-review`. `null` when n=0.
- `partialCostUsd`, `pricedEventShare`, `pricedCycleCount`,
  `pricedCycleShare`, and all denominators are always returned.
  `unknownUsageEventCount` / `subscriptionUsageEventCount` keep unknown and
  subscription usage visible instead of collapsing them to USD 0.
- `manualAcceptedCount` / `rejectedCount` / `undecidedCount` /
  `unreviewedCount` are reported separately from `acceptedCount`.
- Running cycles stay out of the closed denominator and effective cost, but
  their accrued usage is visible via `openCycleCount` and
  `openCyclePartialCostUsd`.
- `wallTimeMs` uses the **union of disjoint job intervals** (the stage spec
  also allows a single min-start→max-end span; we chose the union so parallel
  reviews are not double-counted and idle gaps are excluded). A sequential
  implement→review adds durations (10 min + 5 min = 15 min); fully overlapping
  parallel reviews inside the implement window add no extra wall time; a gap
  between jobs (e.g. implement 10:00–10:10, review 11:00–11:05) yields 15 min,
  not 65 min.

`pick_execution` counters: `proposals` (durable pick records, `null` when the
store cannot be read), `executedAuto`, `executedManual`, `executedUnknown`,
`runs` (all delegation rows, always the sum of the three executed counters),
`cycles` (closed quality cycles) and `originDetails` (per-detail breakdown, so
`fallback`/`alternate`/`fanout`/`rejected-link`/`legacy` stay visible). A pick
without a `delegation_start` raises only `proposals` and never touches executed
counters or the cost cohort.

Mapping to decided cycles for shadow ranking (`2584cd05`): use
`qualityOutcome === 'accepted-by-review'` or explicit rejection/exhaustion;
`runClass === 'infra'|'cancel'` keeps infra prior separate from quality prior
(existing shrinkage in `model-pick-history` unchanged).

## Priced statistics (display only)

`/api/delegations/stats` groups finished delegations per (harness, base model,
role, level) and reports `usable_rate`, `infra_fail_rate`, `completion_rate`,
median duration and tokens, `cost_per_pass` and `price_per_1m` (each with
`source` and `captured_at`; USD only for `api_metered`, otherwise an RCU proxy
labelled as such). The level is read from the persisted pick-record complexity
(`unknown` when absent). The decision journal is unchanged and these values
never influence `model_pick`. Shown in Settings -> Harness -> "Model prices and
statistics". Detail: `docs/model-scoring-facts.md` ("Priced statistics").

Infrastructure fallback starts require a fresh `pick_id`. The controller lock and persisted `pickFallbackFrom` enforce one fallback across different picks and concurrent requests. Idempotency replay returns the existing job; a fallback cannot itself authorize another fallback.

Settings → Delegations → Models shows the effective server recovery durations alongside model selection. It is a read-only view of the existing startup policy; it does not create a second settings or lockout store.
