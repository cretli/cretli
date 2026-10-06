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

Retention: unclaimed proposals older than 30 days are purged on the next write.
Executed links remain on delegation rows.

Decision journal stores metadata only (no prompts). Pick candidates keep
`harness`/`model`/`selectionSlot`/`originDetailHint`; the human-readable
`reason` and any prompt/task text are never copied into the journal.

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
