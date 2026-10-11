# TODO `review` Field Contract

Status: contract plus implementation notes. It was frozen before the
implementation leaves started and has since been aligned with the shipped code
(`lib/todo-review-*.js`, `scripts/backfill-todo-review.js`, the badge in
`app_front/`). §15-§17 describe what the code does; §17 lists what the badge does
**not** guarantee. The document does not authorize a commit, push or merge.

- Root TODO: `88cb0a4b-1c63-407a-9670-7ac7484f5dde` — "Explicit review status
  on a todo (who reviewed it and with which model)" (plan approved).
- This leaf: `a2e9adba-4054-4a5a-9593-6e589a9a849f` — "Kontrakt pola
  `todo.review`".
- Related contracts: [`delegation-workflow-per-leaf.md`](delegation-workflow-per-leaf.md),
  [`workspace-watcher.md`](workspace-watcher.md),
  [`todo-worktree-contract.md`](todo-worktree-contract.md).

The contract is self-contained. Every code reference below is a real symbol in
this repository, verified by reading the file. `file:line` anchors name the
public function or the field, not the only place it is used.

## 0. Reading conventions

- **MUST / MUST NOT** is binding. **SHOULD** is a strong default that a later
  leaf may override only with an explicit decision recorded in that leaf.
- The field name is always `todo.review` (camel case, the persisted item shape).
  The MCP/REST surface exposes it as `review`.
- "Implement/fix" means a job whose cycle role is `implement` or `fix`
  (`delegationCycleRole`, `lib/delegation-cycle-classify.js:90`). That role is
  the explicit `pickRole` persisted before assignment normalization; legacy rows
  without it fall back to `implement`. `delegationPersistedRole`
  (`lib/model-pick-history.js:328`) can never return `fix` — it collapses both
  to `implement`, because `normalizeDelegationAssignment`
  (`lib/delegation-assignment.js:29`) only produces `review | implement`.
- "Review attempt" means one attempt of one review job
  (`snapshotDelegationAttempt`, `lib/delegation-attempt.js:9`).
- "Logical workspace" is the todo's workspace identity (`workspaceFolder`),
  never its `executionFolder` (`lib/execution-folder.js`).

## 1. Design principles

These are the approved root-plan principles, restated so every later section
has a single source:

| # | Principle | Enforced in |
| --- | --- | --- |
| P1 | Only the server writes `review`; no agent/client can set the field. | §10 |
| P2 | Aggregation is per leaf and per logical workspace, independent of any orchestrator chat. | §2 |
| P3 | The review subject is declared explicitly at start; code and plan have separate snapshots. | §3 |
| P4 | Evidence is bound to the job attempt; the state is always recomputed from scratch. | §4, §5 |
| P5 | Queuing/starting an implement or fix invalidates a `passed`/`manual` review (`stale`). | §4, §6 |
| P6 | `manual` comes only from an explicit human action; the server derives the actor from the channel. | §7 |
| P7 | No usable verdict or incomplete history is `unknown`, never `passed`. | §4 |
| P8 | A `review` write does not bump the todo CAS token (`item.updatedAt`); restart repairs the snapshot. | §10 |
| P9 | Model rankings and cycle grouping are unchanged; the only deliberate metric change is `manualAccepted` (decision 6). | §7, §13 |
| P10 | `done` is never blocked by this field. | §4, §12 |
| P11 | Human acceptance is a distinct `manual` state; the no-review badge appears for **all** done leaves. | §7, §12 |
| P12 | A same base model on another harness is independent, but is marked separately. | §9 |

## 2. Aggregation scope (leaf body §1)

### 2.1 Source of rows — SETTLED

The snapshot MUST be computed from
`listDelegationsForWorkspace(row.workspaceFolder)` (`lib/persist/delegations-persist.js:480`),
not from `listDelegationsForParent` (`lib/persist/delegations-persist.js:508`).

Rationale: a leaf can be executed by several orchestrator chats over its life
(the Watcher cycle chat, a manual orchestrator, a resumed chat). Parent-scoped
lookup would silently miss every review run under a different parent. The
workspace lookup is keyed by `workspaceIndexKey`
(`lib/persist/delegations-persist.js:368`), the same key the Watcher uses, and
the index is built in `buildDelegationIndexes`
(`lib/persist/delegations-persist.js:391`).

### 2.2 Cost — SETTLED

- JSON store: `byWorkspace` is a prebuilt index, so the per-leaf slice is cheap.
- SQLite store: the same function does `loadDelegations().filter(...)`
  (`lib/persist/delegations-persist.js:484`), i.e. a full scan of the delegation
  table.

Consequence: the snapshot MUST NOT be computed on every list/render request.
It is recomputed on durable review events (§10.4) and repaired once after a
restart (§10.6). Read paths (`todo_list`, `todo_show`, the panel) read the
persisted snapshot.

### 2.3 Chronology — SETTLED

Attempts are ordered by the **attempt start time** with a stable tie-breaker,
never by the job `createdAt`:

- primary key: the attempt's `startedAt`
  (`snapshotDelegationAttempt`, `lib/delegation-attempt.js:15`);
- pre-start ordering (a queued but not yet started attempt): the attempt's
  `queuedAt` (§5.1);
- tie-breaker: `attemptId`, then `delegationId`, both ascending.

A retry archives the old attempt and starts a new one, so the job `createdAt`
does not move (`lib/delegation-service.js:2793`, `retryUnlocked`). Using it
would place a retry before the review it followed and could resurrect a stale
PASS.

### 2.4 Identity — SETTLED

- The snapshot key is the full, unique todo id within the logical workspace.
- `normalizeTodoRefId` (`lib/todo-ref.js:22`) only validates the id/prefix
  shape; it does not resolve a short prefix to the full id. Prefix → full-id
  resolution inside one workspace is required work for the data-model leaf, not
  for this contract.
- A job participates only when its persisted `leafId` normalizes to that full
  id (`normalizeDelegationRecordLeafId`, `lib/persist/delegations-persist.js:265`).
  An empty `leafId` matches nothing — it must never be attributed by chat.
- `executionFolder` MUST NOT be used as the todo's workspace or identity. It is
  the runner folder only, and a worktree-backed leaf has a different
  `executionFolder` than its workspace (`docs/todo-worktree-contract.md` §3.4).

## 3. Review subject (leaf body §2)

### 3.1 The subject is not derivable — SETTLED

`resolveDelegationPickRole` (`lib/model-pick-decisions.js:69`) maps a plan-mode
review to `plan`, but a code review is also started as `assignment=review` with
`executionMode=agent`. `delegationPersistedRole`
(`lib/model-pick-history.js:328`) maps both code and plan review to `review`
unless `executionMode === 'plan'`. `lib/delegation-review-verify-plan.js`
treats plan-mode review as a non-review planner
(`resolveDelegationReviewVerifyPlan`, line 33; its `applies` check is line 38)
but does not identify code review.

Therefore the subject MUST be an explicit, persisted field:

```
reviewSubject: 'code' | 'plan' | 'other'
```

`delegation_start` MUST accept `review_subject` (snake) or `reviewSubject`
(camel). The server validates the enum and persists the value on the job record
and in every attempt snapshot of that job (§5.1).

### 3.2 Missing or legacy subject — SETTLED

- A record without the field is **never** defaulted to `code`.
- Legacy/ambiguous records contribute to `review.other` only; they never make
  `review.code` or `review.plan` `passed` (the backfill leaf restates this as
  "legacy jobs without a subject never yield `passed` for code").
- A job whose stored subject is unrecognized is treated as `other` and the
  snapshot records `subjectSource: 'unknown'`.

### 3.3 Default for new starts — SETTLED

- `assignment=review` and `executionMode=plan` → default `plan`. A plan-mode
  review is a planner review, so the inference is deterministic.
- Any other `review` start without an explicit subject → default `other`.
- The default is recorded with `subjectSource: 'default'` (vs `'explicit'`), so
  a badge can distinguish a declared subject from a fallback.
- The Watcher orchestrator prompts and the per-leaf skill MUST pass the subject
  explicitly on every review start (`code` for code review, `plan` for plan
  review) once the prompt/skill leaf lands. The server default is the safety net
  for ad-hoc starts, not the normal path.

### 3.4 Separate snapshots — SETTLED

`review.code` and `review.plan` are independent snapshots. A later plan PASS
MUST NOT clear, replace or downgrade stored code evidence, and vice versa.
`review.other` is retained for audit but is never rendered as a status badge.

### 3.5 Review without an implement — SETTLED

A review start with no preceding implement/fix for the leaf is allowed:

- `implementer` is `null` and `independence` is `unknown`;
- the state may still be `passed`/`failed`/`unknown` from the reviewer's own
  verdict, but a `passed` with `implementer === null` is **not**
  gate-qualifying: the future review gate (a separate leaf) MUST additionally
  require `implementer !== null` and `material.current === true`;
- a code review with `implementer === null` SHOULD render with an explicit
  "no implementer" marker instead of a bare PASS.

### 3.6 Container review — SETTLED

A review job whose `leafId` is a container or root contributes to that id's
snapshot only. A parent's review evidence MUST NOT certify any descendant; each
descendant needs its own review job with its own `leafId`. The container rollup
is §12.

## 4. State machine (leaf body §4)

### 4.1 The seven states — SETTLED

`state` is exactly one of:

| State | Meaning |
| --- | --- |
| `none` | No review attempt of this subject has ever existed and no invalidation. |
| `pending` | A review attempt of this subject is non-terminal, or a required verify is still expected. |
| `passed` | The current round is fully decided: every subject reviewer is a usable PASS and verify is satisfied. |
| `failed` | At least one usable FAIL/BLOCKED verdict, or a failed verify, in the current round. |
| `manual` | No fresh independent `passed`, but a durable human acceptance exists for this subject. |
| `stale` | The latest subject review predates a queued or started implement/fix. |
| `unknown` | Terminal attempts exist but no usable verdict, the history is incomplete, the subject is unknown, or the round cannot be safely decided. |

### 4.2 Recompute, never mutate — SETTLED

There is no incremental "downgrade" flag. After **every** relevant event —
including cancel, retry, restart and retention — the server recomputes the state
from the current attempts, the material intent and the active reviewers. The
persisted snapshot is a cache of that recomputation, guarded by `generation`
(§5.4).

The sequence `passed` → new review `pending` → fix → cancel review MUST settle
as `stale`, never `passed`. The sequence `passed` → fix queued (never starts) →
fix cancelled settles as `stale` too, because a queued fix is material intent by
decision 1.

### 4.3 Fan-out membership and round close — SETTLED

- A **round** opens at an implement/fix attempt and closes when the next
  implement/fix attempt is queued/started. Reviews between two implement/fix
  attempts belong to the round opened by the earlier one.
- A review with no preceding implement/fix in the leaf forms round 0
  (review-only).
- Fan-out membership: **all** subject-review attempts of the same round.
- A second review started in the same round does **not** replace a failed
  sibling; it joins the fan-out. Because `passed` requires every subject
  reviewer to be a usable PASS, a FAIL stays decisive for that round. The only
  way to recover from `failed` is a new implement/fix (new round) followed by a
  fresh review.

### 4.4 Freshness predicate — SETTLED

For a subject `s`:

1. `lastReviewAt(s)` = the latest start time of a subject-`s` review attempt.
2. `lastMaterialAt` = the latest `queuedAt || startedAt` over all implement/fix
   attempts of the leaf.
3. If `lastReviewAt(s)` is empty → `none`.
4. If `lastMaterialAt > lastReviewAt(s)` → `stale`. This is the narrow meaning
   of "not current" from decision 1 (§6).
5. Otherwise evaluate the latest round that contains a subject-`s` review.

### 4.5 Round evaluation — SETTLED

A review attempt is **usable** when all of the following hold:

- its status is terminal (`completed`, `failed`, `interrupted`, `cancelled`);
- it is not a user/agent cancel (`isUserCancelledDelegation`);
- it is not an infrastructure outcome (`isInfraDelegationOutcomeForCycle`,
  `lib/delegation-cycle-classify.js:63`, called at
  `lib/delegation-cycle-outcomes.js:206, 229`);
- its verdict (`reportVerdict`, falling back to
  `resolveDelegationRecordVerdict`, `lib/delegation-verdict.js:146`, which
  parses the body via `parseDelegationVerdict`, line 122) is `PASS`, `FAIL` or
  `BLOCKED`;
- its verify obligation is satisfied (`resolveDelegationReviewVerifyPlan`,
  `lib/delegation-review-verify-plan.js:33`, and the durable `verifyRequired` /
  `verifyResult` fields, `lib/persist/delegations-persist.js:304-309`).

Given the fresh attempts of the current round:

| Condition | Result |
| --- | --- |
| no attempt | `none` / `stale` per §4.4 |
| at least one non-terminal attempt and no terminal sweep trigger | `pending` |
| any usable `BLOCKED` | `failed` |
| else any usable `FAIL` | `failed` |
| else any verdict `conflict` or `unspecified` | `unknown` |
| else any verify `failed` | `failed` |
| else verify `required` and absent on a terminal attempt | `unknown` (`verify_missing`) |
| else every fresh attempt is a usable `PASS` and every verify obligation is satisfied | `passed` |
| else (some terminal attempt is cancelled / infra / unusable, no FAIL/BLOCKED) | `unknown` |

The last row is deliberately conservative and matches the existing cycle
aggregation, which requires `reviews.every(credibleReview && PASS)` for
acceptance (`lib/delegation-cycle-outcomes.js:211-212`) and treats fan-out as
"any BLOCKED, then FAIL, then conflict, PASS only when all PASS"
(`aggregateReviewFanoutVerdicts`, `lib/delegation-verdict.js:161`). A
cancelled or infra sibling therefore yields `unknown`, not a silent `passed`.

### 4.6 Transition table — SETTLED

| Event | Precondition | Resulting `state` | Notes |
| --- | --- | --- | --- |
| review queued / starting / running | no later implement/fix | `pending` | terminal jobs never stay here forever (§4.7) |
| all reviewers PASS + verify passed | review after `lastMaterialAt` | `passed` | the only PASS path |
| any reviewer terminal FAIL/BLOCKED | review in the current round | `failed` | decisive even with infra siblings |
| verify failed | result recorded for an attempt | `failed` | `verifyResult.status === 'failed'` |
| verify required, missing at terminal | executor cannot run tests | `unknown` | `verify_missing`; never `passed` |
| terminal reviewer, no usable verdict | empty/degraded/repetition/conflict | `unknown` | degraded `size` with a kept VERDICT stays usable (§5.3) |
| one cancelled fan-out participant | other participants exist | `unknown` | conservative; a FAIL/BLOCKED sibling makes it `failed` |
| all fan-out participants cancelled | — | `unknown` | no usable verdict |
| infra failure (`adapter_*`, provider error) | no FAIL/BLOCKED sibling | `unknown` | classified from structured errors, not report text (§5.3) |
| review interrupted (run lost) | terminal `interrupted` | `unknown` | never `passed` |
| implement/fix queued after a review | status `queued` or later | `stale` | decision 5: at queue time, not start |
| implement/fix started after a review | — | `stale` | |
| human accept (actor `human`), no fresh PASS | subject matches | `manual` | §7 |
| human accept after an independent `passed` | — | stays `passed` | acceptance recorded, not overridden |
| plain ack `reviewed` | — | unchanged | dismisses a card only |
| todo checked `done` without accept | — | unchanged | not review |
| retry | new attempt | recomputed; `pending` if restarted | old evidence archived (§5) |
| retention drops a referenced attempt | snapshot references it | `unknown` | `history_truncated` (§11) |
| restart repair | stale snapshot | recomputed | idempotent |

### 4.7 Terminal sweep — SETTLED

A terminal job MUST NOT be rendered as an eternal `pending`:

- when a delegation reaches a terminal status, the attempt's `finishedAt` is
  persisted (`finishDelegation`, `lib/delegation-service.js:628`);
- an attempt that is non-terminal but has no live run after the recovery grace
  (see the server-restart/orphan handling in `lib/delegation-service.js:228-233`)
  is reclassified `unknown` during repair, not left `pending`;
- a subject with no review attempt and no invalidation is `none`, not
  `pending`.

## 5. Field shape and per-attempt evidence (leaf body §3, §5)

### 5.1 Per-attempt evidence — SETTLED

The writer MUST capture, per attempt, at least:

| Field | Source | Why |
| --- | --- | --- |
| `attemptId` | `snapshotDelegationAttempt` | identity and retry fencing |
| `queuedAt` | **new**, captured at queue/start | required for queue-time invalidation (§6) |
| `startedAt`, `finishedAt` | existing | chronology and terminal sweep |
| `reportVerdict` | `assessDelegationReport().verdict` / `resolveDelegationRecordVerdict` | verdict without re-parsing the body |
| `verifyResult` | `recordDelegationVerifyResult` (`lib/delegation-service.js:690`) | hard verify evidence |
| `verifyRequired` / `reviewCanRunTests` | start gate (`lib/delegation-review-verify-plan.js`) | verify obligation |
| `acknowledgedAt` / `acknowledgedReason` / `acknowledgedActor` | `acknowledge` (`lib/delegation-service.js:2447`) + new actor | human acceptance (§7) |
| `reviewSubject` | start request | subject binding (§3) |
| `leafId` | record defaults | leaf binding (§2.4) |
| `status`, `taskOutcome`, `error` | existing | terminal + infra classification |
| `executor.transport`, `executor.model` | existing | independence (§9) |

`snapshotDelegationAttempt` (`lib/delegation-attempt.js:9`) already captures
`acknowledgedAt` (line 23) plus status, `runId`, timestamps, `report`, `error`,
`taskOutcome`, `interruptCode`, `runStoppingAt`, `unverified` and the executor
(`model`, `transport`). It does **not** yet capture `queuedAt`, `reportVerdict`,
`verifyResult`, `reviewSubject`, `acknowledgedReason` or
`acknowledgedAttemptId`. The data-model leaf MUST extend the snapshot with those
fields.

Retry already archives the previous attempt (`lib/delegation-service.js:2793`)
and already clears `acknowledgedAt` / `acknowledgedAttemptId` /
`acknowledgedReason` on the record (`lib/delegation-service.js:2790-2792`). The
extended snapshot only needs to carry the new fields into that archived copy.

### 5.2 Retry resets attempt-scoped evidence — SETTLED

`retryUnlocked` (`lib/delegation-service.js:2765-2793`) archives the old attempt
and clears `report`. It already clears the record-level
`acknowledgedAt` / `acknowledgedAttemptId` / `acknowledgedReason` (lines
2790-2792) and the `finalReportAcceptedAt` / `finalReportAttemptId` /
`finalReportRunId` triple (lines 2786-2788). The contract requires the same
reset for the **new** record-level evidence introduced above:

- `reportVerdict`, `reportDegraded`, `reportSummary`;
- `verifyResult`;
- `reviewSubject`;
- `acknowledgedActor` (the new actor field, §7.2).

The archived snapshot keeps the old values, so §11 retention and §4
recomputation still see the previous attempt. Without this reset, a retried
review would briefly expose the previous verdict on the new attempt.

### 5.3 Credibility is structural, not textual — SETTLED

Infra classification MUST use only structured evidence: terminal status,
`taskOutcome`, the `error` string and the structured `errors[]`
(`delegationErrorText`, `lib/model-pick-history.js:358`) — never the report
body. Consequences:

- a **truncated/degraded** report that kept a usable `VERDICT:` line stays
  usable; only `report_degraded` with reason `repetition` or
  `size+repetition` downgrades a review (`resolveDelegationFinishReport`,
  `lib/delegation-verdict.js:420-429`);
- a report that merely mentions a rate limit is not infra;
- `adapter_after_terminal` entries are not a new failure
  (`lib/model-pick-history.js:352`).

### 5.4 Snapshot shape — SETTLED

```jsonc
"review": {
  "schemaVersion": 1,
  "generation": 7,            // monotonic integer per todo; CAS guard (§10)
  "decisionKey": "sha256:…",  // stable hash of decision-relevant fields, no timestamps
  "computedAt": "…",          // display only; NOT part of decisionKey
  "code": { /* Snapshot */ },
  "plan": { /* Snapshot */ },
  "other": { /* Snapshot | undefined */ },   // audit only
  "aggregate": { /* container rollup, §12; leaf omits this key */ }
}
```

`Snapshot`:

```jsonc
{
  "state": "none|pending|passed|failed|manual|stale|unknown",
  "stateReason": "fresh_review|verify_missing|no_verdict|history_truncated|implement_queued_after_review|…",
  "subject": "code|plan|other",
  "subjectSource": "explicit|default|unknown",
  "round": {
    "index": 3,               // number of implement/fix rounds since the last PASS
    "id": "opening-attempt-id",
    "openedAt": "…",
    "invalidationAt": "…"     // lastMaterialAt used for freshness
  },
  "reviewers": [
    {
      "delegationId": "…",
      "attemptId": "…",
      "leafId": "…",
      "harness": "…",
      "model": "…",
      "baseModel": "…",
      "status": "completed|failed|interrupted|cancelled",
      "verdict": "PASS|FAIL|BLOCKED|unspecified|conflict|",
      "usable": true,
      "queuedAt": "…",
      "startedAt": "…",
      "finishedAt": "…",
      "verifyStatus": "passed|failed|required-missing|not-required|pending|",
      "independence": "different_base_model|same_model_other_harness|same_model_same_harness|unknown"
    }
  ],
  "reviewerCount": 2,
  "truncated": false,
  "implementer": {
    "delegationId": "…", "attemptId": "…", "role": "implement|fix",
    "harness": "…", "model": "…", "baseModel": "…", "startedAt": "…"
  },
  "independence": {
    "independent": true,
    "class": "different_base_model",
    "reference": "implementer"      // "implementer" | "none"
  },
  "material": {
    "current": true,
    "revision": "abc123def456+1a2b3c4d",
    "kind": "trusted|unavailable",
    "reason": "fresh_review|implement_queued_after_review|implement_started_after_review|no_review"
  },
  "acceptance": {
    "actor": "human", "at": "…",
    "delegationId": "…", "attemptId": "…",
    "expectedTodoRevision": "…"
  },
  "updatedAt": "…"
}
```

Rules:

- `implementer` is `null` when there is no implement/fix attempt in the round.
- `implementer.role` (`implement|fix`) is derived with `delegationCycleRole`
  (`lib/delegation-cycle-classify.js:90`) from the persisted `pickRole`, not
  with `delegationPersistedRole` (`lib/model-pick-history.js:328`), which can
  only yield `implement`.
- `acceptance` is `null` unless a durable acceptance exists.
- `material.revision` is the diagnostic fingerprint from
  `readDelegationMaterialRevision` (`lib/delegation-material-revision.js:14`)
  or `readDelegationMaterialRevisionForRecord` (line 41). It is **not** compared
  in v1; `material.current` comes from §6.
- Report bodies are never copied into `review`; only the verdict, the bounded
  `reportSummary` (if needed) and structural flags.

### 5.5 Generation and stable comparison — SETTLED

- `generation` is a monotonic integer per `(workspace, todoId)`.
- The writer computes `decisionKey` = a stable hash over the decision-relevant
  content: round identity, reviewer attempt ids, verdicts, verify status,
  implementer attempt, `material.current`, independence classes. Timestamps,
  `computedAt`, `updatedAt` and free text are excluded.
- If the newly computed `decisionKey` equals the stored one, the writer is a
  no-op: no file write, no `doc.updatedAt` bump.
- Otherwise the writer writes with `generation = max(stored, read) + 1`. A
  writer that read generation `N` while `N+1` is already on disk MUST reload and
  recompute instead of overwriting.

### 5.6 Reviewer limit — SETTLED

- `reviewers[]` MUST contain every subject review attempt of the current round
  that can affect the decision. It is not a "first N" list.
- The durable array is capped (suggested `MAX_REVIEWERS = 64`) for storage
  safety. If a round exceeds the cap, the snapshot sets `truncated: true` and
  `state: "unknown"`; a partial list MUST NOT produce `passed` or `failed`.
- Report bodies are excluded so the cap never loses a verdict.

## 6. Material freshness (leaf body §6)

### 6.1 Narrow "current" — SETTLED (user decision 1)

In v1, a review is **current** iff no implement/fix attempt for the leaf was
**queued or started after** the review attempt. Formally, using §4.4:
`material.current = lastMaterialAt <= lastReviewAt(s)`.

- Invalidating at **queue** time (decision 5) is required: a queued job may sit
  in the queue indefinitely, so waiting for start would leave a `passed` badge
  on a leaf that already has a pending change.
- No stronger content fingerprint is introduced in v1.
- `readDelegationMaterialRevision` is persisted for diagnostics only and MUST
  NOT drive `stale` in v1.

### 6.2 What this does not detect — SETTLED, stated honestly

The narrow rule does **not** detect the following cases. They do **not** turn
the snapshot into `unknown`: `material.current` stays computable and stays
`true` whenever no implement/fix was queued or started after the review, even
though the underlying files may have changed. The limitation is surfaced in the
UI copy / documentation note (U1), never by changing the state or the predicate:

1. **Edits outside a delegation** — a manual edit, another chat, a tool, or a
   human commit in the logical workspace or the worktree. There is no
   delegation attempt, so `lastMaterialAt` does not move.
2. **Requirement/plan edits** — editing `todo.body` or `todo.plan.markdown`
   after a review does not invalidate `review.plan` or `review.code` in v1.
   Only a queued/started implement/fix does.
3. **Worktree changes not driven by an attempt** — a worktree can change
   between the review and the read (e.g. a manual `merge`, a sibling operation).
4. **Same-attempt change after review** — the reviewer is read-only by contract,
   but the field cannot prove it.
5. **Logical workspace vs worktree divergence** — the revision of the logical
   workspace and of the execution folder can differ; v1 does not compare them.

These limits MUST be documented in the UI copy or the changelog so a `passed`
is not read as a content guarantee.

### 6.3 Empty fingerprint — SETTLED

An empty `material.revision` (no Git repo, `readDelegationMaterialRevision`
returns `''`, line 30) means "change detection unavailable", never
"unchanged". It MUST NOT produce a false `stale`; it is recorded as
`material.kind: "unavailable"`.

### 6.4 Future v2 — OUT OF SCOPE

A server-computed content fingerprint (for example a hash of the changed file
contents) persisted per review attempt is a v2 candidate. It is out of scope
for this tree and must not be added opportunistically.

## 7. Human acceptance (leaf body §7)

### 7.1 The `manual` state is reachable only from an explicit human action — SETTLED

Today `manual` is effectively unreachable from the UI: the delegation card
sends `reviewed` / `open_child`, and only the MCP `delegation_ack` tool offers
`accepted` (`lib/mcp/builtin/delegation-tools.js:790-860`;
`DELEGATION_ACK_REASONS = ['reviewed', 'accepted']`, line 48). The contract
adds an explicit UI acceptance action (a button on the delegation card and/or
the task card) that records a human acceptance for the subject.

### 7.2 Actor is derived from the authenticated channel — SETTLED

`acknowledge` (`lib/delegation-service.js:2447`) currently receives no actor,
and the card route, the remote-MCP route and the in-process client all call it
identically (`lib/routes/delegations-routes.js:327` and `:402`). The contract
requires an `actor` on the acknowledge input, derived by the server:

| Channel | Actor |
| --- | --- |
| Authenticated browser session (session cookie) on the UI card route, no widget token and no `req.mcpIntegration` | `human` |
| Any MCP connection (`req.mcpIntegration`, set in `lib/auth.js:385`) or the remote-MCP route `/api/chats/:id/delegation-ack` | `agent` |
| Any request carrying a widget access token (`req.widgetAccess`) | `agent` (never `human`), including on the card endpoint |
| Server-internal reconciliation / repair | `system` |
| In-process client call or any other channel | `unknown` |

Trust boundary, stated honestly: the actor is a **channel** signal, not a
verified identity. A spoofed header, a stolen cookie or a compromised browser
session is outside this contract's threat model. A `human` value means "the
authenticated UI channel", not "cryptographically proven person".

### 7.3 Acceptance carries the expected attempt and revision — SETTLED

The UI action MUST send the `delegationId`, the `attemptId` and the todo
revision it displayed. The server compares them with the current values and
rejects a mismatch (HTTP 409 / MCP `CONFLICT`) instead of accepting a stale
screen.

### 7.4 Precedence — SETTLED

- An independent `passed` is not replaced by a later ack. If the subject is
  already `passed` and current, a human acceptance is stored in `acceptance`
  and the `state` stays `passed`.
- With no fresh independent `passed`, a human acceptance sets `state: "manual"`.
- A queued/started implement/fix after the acceptance makes it `stale` (§4.4).
- A plain "reviewed" ack and a plain todo `done` transition do NOT create
  `manual` and do not change `review`.
- If the subject was `passed` and later a human accepts for a **different**
  subject, the accept applies to that subject's snapshot only.

### 7.5 The `manualAccepted` metric — SETTLED (root decision 6)

`enrichDelegationCycle` currently counts any `acknowledgedReason === 'accepted'`
job (`lib/delegation-cycle-outcomes.js:251-256`). The contract makes the metric
count **only** `actor === 'human'` acceptances. This changes existing
statistics: agent `accepted` acknowledgements stop counting. The change needs a
test and a changelog entry; every other `buildDelegationQualityCycles` result is
unchanged (P9). The metric reads the same durable acceptance record as §7.2.

### 7.6 The "no review" badge — SETTLED (user decision 3)

The "no review" badge is shown for **all** `done` leaves, not only leaves that
were closed by an agent cycle. A human acceptance remains a distinct `manual`
state, visually different from both `passed` and `none`.

## 8. Worktree integration (leaf body §8)

### 8.1 Different scopes — SETTLED

- `todo.review` is the **current** review state of the leaf.
- The worktree integration result is a **per-cycle artifact** stored under
  `record.results[cycleId]` (`markTodoIntegrationReady`,
  `lib/workspace-watcher-integration.js:123`).

The integration result's review evidence is pinned to the cycle, attempt and
material. The "latest leaf review" MUST NOT be copied into the result, and
`todo.review` MUST NOT be overwritten from the result.

### 8.2 No hardcoded PASS — SETTLED

`prepareWorktreeIntegrationResult`
(`lib/workspace-watcher-integration.js:68`) accepts `reviewOutcome` and
`reviewVerified` as inputs. Today the caller hardcodes `reviewOutcome: 'PASS'`
and `reviewVerified: true` in `lib/workspace-watcher-cycle.js:1371-1372`. That
is a caller bug for this contract: the caller MUST derive the values from the
actual review snapshot of the leaf/cycle (independent PASS + satisfied verify).
When there is no fresh independent PASS, the result MUST carry honest evidence
(`outcome: 'unknown'`, `verified: false`) even if the cycle closes as
`success`.

### 8.3 Manual integration — SETTLED

- Manual prepare records `reviewOutcome: 'manual'`,
  `reviewVerified: false` and `test.outcome: 'unknown'`
  (`lib/workspace-watcher-integration.js:291-292`). That is **not** human
  acceptance of a review.
- A manual integration may target the tree root. The root's `todo.review` does
  not inherit a child's PASS; the root has its own snapshot (§3.6, §12).
- The historical `integration.reviewOutcome` on the todo pointer
  (`lib/persist/todos-persist.js:857`, written by `markTodoIntegrationPointer`,
  `lib/workspace-watcher-integration.js:186`) is artifact metadata. It is set
  from `input.result.review.outcome` (line 168), never from `todo.review`.
- Rejecting integration does not change `todo.review`; returning the leaf to
  `ready` (or a retry) leads to a new implement/fix, which invalidates review at
  queue time (§4.6).
- `confirm` / `merge` do not create a review `passed` and do not set `manual`.
  Integration confirmation is not the review acceptance action; only the explicit
  accept action (§7) writes `manual`.

### 8.4 Integration state transition — SETTLED

The integration flow keeps its existing state model
(`docs/todo-worktree-contract.md` §13.1 S11/S12, `docs/workspace-watcher.md`
"Worktree execution, Git context and integration" §4):
`prepare` → `integration.state = ready` while `status` stays `doing`;
`confirm` → `status = done`, `integration.state = integrated`; `reject` →
`status = ready`, `integration.state = rejected`. This contract adds no
transition; it only removes the hardcoded review PASS.

## 9. Independence (leaf body §9)

### 9.1 Helpers — SETTLED

The independence predicate is **new code** and MUST use only existing exports:

- `decodeModelValue` (`lib/model-catalog.js:220`) to strip model parameters and
  normalize provider aliases;
- `isExcludedDelegationModel` (`lib/model-role-profiles.js:845`) as the base
  model identity check.

`baseModelIdOf` (`lib/delegation-service.js:2482`) and the parent-rating
anti-bias logic (`inspectParentRatingBias`, line 2499) are local to
`createDelegationService`; they MUST NOT be imported or copied.

### 9.2 Classes — SETTLED

| Class | Meaning | Independent? |
| --- | --- | --- |
| `different_base_model` | Reviewer base model differs from the implementer's. | yes |
| `same_model_other_harness` | Same base model, different harness/transport. | **yes** (decision 2), marked separately |
| `same_model_same_harness` | Same base model and same harness. | no |
| `unknown` | `auto`, missing model, or no implementer to compare against. | no (not gate-qualifying) |

### 9.3 Aggregation over the round — SETTLED

- Every fresh reviewer is classified against the round's implementer.
- The round `independence.class` is:
  - `same_model_same_harness` if any fresh reviewer is that class;
  - else `same_model_other_harness` if any is that class;
  - else `different_base_model` if at least one reviewer exists and all are
    that class;
  - else `unknown`.
- `independence.independent` is `true` only for `different_base_model` and
  `same_model_other_harness`, and `false` for `same_model_same_harness` and
  `unknown`.
- A review-only round has `reference: 'none'` and `class: 'unknown'`.
- The future review gate MUST require `independence.independent === true` in
  addition to `passed` and `material.current`.

## 10. Write and concurrency (leaf body §10)

### 10.1 Only the server writes — SETTLED

- The `review` field is written by a dedicated server function, never by an
  agent, widget or REST client.
- MCP `todo_update` already rejects unknown patch keys
  (`TODO_PATCH_KEYS`, `lib/mcp/builtin/todo-tools.js:14`, and the check at
  line 411-413). This contract requires only a regression test.
- REST `PATCH /api/todos/:id` (`lib/routes/todos-routes.js:268`) currently
  silently ignores unknown body keys. Per user decision 4, a body containing a
  `review` field (or `review_subject` / `reviewSubject`) MUST return an explicit
  validation error — HTTP 400 with the standard payload
  (`jsonTodosError`, `lib/routes/todos-routes.js`) — and MUST never be silently
  ignored. `review` MUST NOT be added to the REST → `updateTodo` mapping.
- `todo_create` MUST NOT accept `review` either.

### 10.2 Dedicated writer and CAS token — SETTLED

- A dedicated `writeTodoReview(dataDir, workspaceFolder, todoId, snapshot,
  { expectedGeneration })` writes only the target item's `review`.
- It MUST take the same workspace file lock as `updateTodo`
  (`withWorkspaceWatchersFileLock`, `lib/persist/todos-persist.js:895`) so it
  serializes with agent edits.
- It MUST NOT call `updateTodo` and MUST NOT bump `item.updatedAt`. The CAS
  token for agent edits is `item.updatedAt`; a background review write must not
  turn a concurrent agent's `expected_updated_at` stale.
- Concurrency is handled server-side with `generation` (§5.5), not by a client
  retry. One recompute-and-write decision; if the generation moved, reload and
  recompute.

### 10.3 File-write side effects — SETTLED

`saveTodosData` (`lib/persist/todos-persist.js:606`) always sets
`doc.updatedAt` (line 636), runs `synchronizeTodoParentStatuses` (line 631) and
fires the watcher nudge (`maybeScheduleWorkspaceWatcherAfterTodosSave`, line
639). The dedicated writer MUST:

- change only the target item's `review` (no status change), so
  `synchronizeTodoParentStatuses` (line 631) does not bump any other item's
  `updatedAt`;
- suppress the watcher nudge (`withTodosWatcherNudgeSuppressed`,
  `lib/persist/todos-persist.js:85`), because a review refresh is not a
  scheduling change;
- accept that `doc.updatedAt` changes; that is a document revision, not the
  per-item CAS token.

### 10.4 Recompute triggers — SETTLED

The snapshot is recomputed (and written if `decisionKey` changed) on:

1. delegation start for a queued implement/fix/review of the leaf;
2. attempt finalization (`finishDelegation`);
3. `recordDelegationVerifyResult`;
4. a human/agent acknowledgement (`acknowledge`);
5. retry;
6. cancel;
7. server restart repair.

The read surfaces (`todo_list`, `todo_show`, REST list, the panel) only read
the persisted snapshot.

### 10.5 Restart repair — SETTLED

A startup pass recomputes `review` for every todo that has review-relevant
delegations but no snapshot, or a snapshot whose `decisionKey` no longer matches
the recomputation. The repair MUST be idempotent and MUST NOT bump
`item.updatedAt`.

### 10.6 Read surface — SETTLED

- `todo_show` exposes the snapshot; `todo_list` exposes a compact per-subject
  state summary (for example `review: { code: 'passed', plan: 'none' }`).
- `lib/mcp/builtin/todo-tools.js` `summarizeTodo` (line 27) and
  `lib/routes/todos-routes.js` `jsonTodosPayload` (line 142) are the two
  payload builders that gain the field. They do not compute it. The one derived
  value a read surface adds is the container rollup from its direct children
  (`§12`).

### 10.7 Live refresh frame — SETTLED (leaf 4)

A review snapshot change is announced on the existing chat-list WebSocket
channel, never a new socket. The frame carries identifiers only:

```json
{ "type": "todosChanged", "reason": "review", "workspaceFolder": "…", "todoId": "…" }
```

- Emission is driven by `writeTodoReview`'s `changed` flag through the
  debounced `lib/todo-review-live.js`; an unchanged `decisionKey` emits nothing
  (`§5.5`).
- Server-side scope filtering (`lib/chat-list-updates.js`): a widget scope never
  receives the frame in v1 (decision U7); any other scope that declares an
  authorized `workspaceFolder` receives only frames for that exact workspace. A
  bare session scope is the trusted logged-in browser and may receive all, but
  the panel still drops a frame for another selected workspace.
- The client transport (`app_front/features/chat/chatTransport.js`) turns the
  frame into the `cretli:todo-changed` DOM event that the Todo panel refreshes
  on.

## 11. Retention (leaf body §5, plan point 11)

### 11.1 The caps — SETTLED (as they exist)

- `MAX_ATTEMPT_HISTORY = 20` (`lib/delegation-retention.js:12`);
  `applyDelegationRetention` trims to `attempts.slice(-20)` (line 46).
- A finished delegation is archived after `DELEGATION_RETENTION_MS` = 30 days
  (line 10); archival clears `sourceText`/`planMarkdown` and truncates
  `report` to 2000 chars (lines 56-58).

### 11.2 Loss of history must surface as `unknown` — SETTLED

- A snapshot's decision may reference only attempts still present in the record
  (`attempts[]` plus the current attempt).
- If retention removes a referenced attempt, the next recomputation MUST set the
  affected subject to `unknown` with `stateReason: "history_truncated"`.
- Retention MAY instead keep every attempt referenced by a live snapshot (an
  optimization), but it MUST NOT silently keep a `passed` whose evidence was
  dropped.
- `reportVerdict` and `verifyResult` for the current attempt are small; retention
  SHOULD preserve them so the state can be recomputed after a restart.

### 11.3 Delegation-report link — SETTLED (read side, leaf 4)

The `review` block stores reviewer identity and verdict, never a report body, a
chat id or a link (`§5.4`). A read surface that wants to offer an "open the
delegation report" link resolves its state from the referenced delegation record
with `resolveTodoReviewReportLinkState` (`lib/todo-review-read.js`):

| State | When | Link behaviour |
| --- | --- | --- |
| `available` | report body present, owning chat still exists | link opens the report card |
| `report_missing` | no report body (queued/running job) | link disabled, reviewer identity still shown |
| `report_trimmed` | `archivedAt` set and the retained `report` is body-capped at 2000 chars (`applyDelegationRetention`) | link opens the partial retained report, labelled as trimmed |
| `chat_deleted` | the delegation's chat no longer exists | link disabled; reviewer identity and verdict still shown |
| `delegation_missing` | the delegation record is gone entirely | link disabled; the persisted reviewer row is still shown |

A trimmed retained report is never hidden and never silently clears the
reviewer row: the state is the honest reason, not a `none`. The resolution is
read-side only; it MUST NOT feed back into the snapshot, the `decisionKey` or
any state transition.

## 12. Parent aggregate (plan point 12)

### 12.1 Separate, derived rollup — SETTLED

A container/root `todo.review.aggregate` is a computed rollup over its direct
children:

```jsonc
"aggregate": {
  "source": "children",
  "code": { "passed": 2, "failed": 1, "pending": 0, "none": 3, "unknown": 1, "stale": 0, "manual": 0 },
  "plan": { "passed": 1, "failed": 0, "pending": 0, "none": 5, "unknown": 0, "stale": 0, "manual": 0 },
  "computedAt": "…",
  "truncated": false
}
```

- It is marked `aggregate: true` (or lives only under the `aggregate` key) and
  MUST NOT contain `reviewers[]`.
- It MUST NOT certify the container. A container's own `review.code` /
  `review.plan` stay `none`/`unknown` unless the container itself had review
  jobs.
- A parent aggregate MUST NOT be used to satisfy any gate on a child.
- The rollup includes direct children only; a deeper rollup is computed
  bottom-up by the same rule and is out of scope for display in v1 beyond
  direct children.

### 12.2 Badges — SETTLED

- A leaf's badge is its per-subject state.
- A container's badge shows the aggregate counts; it is never a single
  `passed`.
- The "no review" badge is shown for **all** `done` leaves (decision 3), whether
  they were closed by an agent cycle or by a human. A `manual` state is a
  separate visual state.

### 12.3 `done` is not blocked — SETTLED

Nothing in this contract changes status transitions. A todo can reach `done`
with `review.state = none`, `unknown` or `stale`. `done` is not gated (P10); the
future review gate for autopilot is a separate leaf and is out of scope here.

## 13. Out-of-scope metrics (plan point 13)

The following are explicitly unchanged or out of scope. A later leaf that
touches any of them needs its own decision.

| Area | Status |
| --- | --- |
| `model_pick` / model scoring / rankings | unchanged (P9); no new independence input to the picker in this tree |
| `buildDelegationQualityCycles` grouping and every result field except `manualAccepted` | unchanged (`lib/delegation-cycle-outcomes.js:155`) |
| `manualAccepted` | the only deliberate metric change: counts `actor === 'human'` only (decision 6, §7.5) |
| `usage-insights` / `model-stats` fields other than `manualAccepted` | unchanged |
| Scout | untouched |
| Autopilot review gate | separate leaf; `done` is not blocked here |
| Widgets receiving a todo-change event | not in v1 (decision 7); only the existing Todo-panel channel |
| Content fingerprint, logical-vs-worktree diff detection, plan-edit invalidation | v2 candidates (§6.2, §6.4) |
| Automatic commit / push / merge / rebase / cherry-pick | out of scope (`docs/todo-worktree-contract.md` S15) |
| Card/panel visual design and i18n strings | the UI leaf materializes this contract; not decided here |

## 14. Decision register

### 14.1 Settled by user decisions

| # | Decision |
| --- | --- |
| U1 | Material freshness is the narrow meaning of "current": no implement/fix queued or started after the review. No content fingerprint in v1; the undetected cases (§6.2) are stated honestly. |
| U2 | The same base model on another harness is independent, marked `same_model_other_harness`. |
| U3 | The "no review" badge is shown for all `done` leaves; human acceptance remains a distinct `manual` state. |
| U4 | A REST PATCH carrying `review` returns an explicit validation error, never a silent ignore. |
| U5 | Invalidation happens at queue time, not at start. |
| U6 | `manualAccepted` counts only `actor === 'human'`; existing agent `accepted` acknowledgements stop counting; test + changelog required. |
| U7 | Widgets do not receive the todo-change event in v1. |

### 14.2 Settled by this contract

| # | Decision |
| --- | --- |
| C1 | Aggregation source is `listDelegationsForWorkspace`, off the hot path. |
| C2 | `reviewSubject` is explicit and persisted; defaults are `plan` for plan-mode review, else `other`; legacy records never default to `code`. |
| C3 | Code and plan snapshots are independent; `other` is audit-only. |
| C4 | State is always recomputed; `passed` requires every fresh reviewer to be a usable PASS with satisfied verify. |
| C5 | One cancelled/infra sibling makes the round `unknown`, matching the existing cycle aggregation. |
| C6 | Per-attempt evidence includes `reportVerdict`, `verifyResult`, `acknowledged*`, `reviewSubject`, `queuedAt`; retry resets the record-level copy and archives it. |
| C7 | Credibility uses structured errors only; a degraded `size` report with a kept VERDICT stays usable. |
| C8 | No hardcoded `reviewOutcome: 'PASS'` in the integration caller. |
| C9 | Actor is channel-derived (`human` only on the authenticated UI card channel); trust boundary is stated. |
| C10 | A dedicated writer with `generation` CAS does not bump `item.updatedAt` and suppresses the watcher nudge. |
| C11 | Retention dropping referenced evidence yields `unknown`, not a silent `passed`. |
| C12 | The parent aggregate is derived and never certifies children. |

### 14.3 Open / deferred

| # | Item | Owner |
| --- | --- | --- |
| D1 | Exact UI acceptance button and confirmation copy | UI leaf |
| D2 | Whether a plain integration `confirm` should also count as human acceptance | product decision, not this tree |
| D3 | Prefix → full todo id resolution | data-model leaf |
| D4 | v2 content fingerprint | later tree |
| D5 | Whether the claim is held from PASS to integration (existing OPEN O2) | `docs/todo-worktree-contract.md` |

## 15. UI materialization (leaf 5)

This section describes how leaf 5 materializes the contract above. It does not
change any SETTLED decision in §1-§14; where the UI could not follow a decision
it says so under "Open points".

Implemented in `app_front/components/ui/cr-todo-review-badge.js`, the pure model
`app_front/features/todo/todoReviewBadge.js` and the panel wiring in
`app_front/todoPanel.js`. The component follows the workspace `cr-*` rules:
Shadow DOM, `static styles` with `--cr-*` tokens only, and MDI icons as
light-DOM `<span class="mdi …">` children projected through named slots and
styled with `::slotted(.mdi)`. It is a domain component, so it is not in the
`components/ui/index.js` barrel. The row host box (`.todo-row-review`) and the
detail wrapper (`.todo-review-detail`) stay in `app.scss`.

- **Badge**: a code badge (`passed`/`failed`/`pending`/`stale`/`manual`/
  `unknown`/`none`) and, only when it has a state, a separate dashed **plan**
  badge. `passed` and `manual` share the success tone and differ by icon, label
  and a tint rule on `data-state='manual'`. A leaf shows one when it is `done`
  (so "no review" appears for every done leaf, U3) or has any review evidence. A
  container shows the derived `reviewed/total` rollup and never a single PASS.
- **Markers**: `same_model_other_harness`, `same_model_same_harness` and "no
  implementer" get an extra marker on the CODE badge only; the plan badge never
  borrows it. Fan-out shows the model count ("modeli: N" in Polish, no
  count-dependent plural).
- **Responsive**: labels collapse to the icon below 640px in CSS inside the
  component (no JS snapshot), so a window resize needs no repaint.
- **Details** (editor card): reviewers, verdict, verify status, implementer,
  acceptance, update time and the report link. The v1 limits of §6.2 are printed
  next to the details.
- **Report link**: the list read never computes `reportLinkState`
  (`resolveTodoReviewReportLinkState` is only reached by
  `GET /api/delegations/:id?field=report-link`). The link is therefore resolved
  lazily on click; the badge then relabels the row with the honest state
  (`report_trimmed` opens the partial report with a notice, `chat_deleted`,
  `report_missing` and `delegation_missing` become disabled text). The state is
  read-side only and never feeds back into the snapshot (§11.3).
- **Filters**: "No review" and "Review out of date" in the Todo filter menu,
  per workspace, leaves plus ancestors.
- **Live refresh**: `todosChanged` frames and socket reconnects become one
  debounced list fetch (`todoReviewRefresh.js`); a review write never bumps
  `item.updatedAt`, so an open editor keeps its CAS token.
- **Accept**: the delegation card of a completed review attempt shows "Accept"
  unless the SAME attempt already has a `human` acceptance; an agent/system
  `accepted` ack neither hides the button nor shows "accepted manually". When the
  card appears it pins the attempt id, the material revision and the todo
  revision (`GET /api/delegations/:id?field=accept`), shows them next to the
  button and, after the existing confirmation prompt, posts exactly those pinned
  values — never a later one — to `POST /api/delegations/:id/accept` (§7.3). A
  failed context load is reported on the card and retried on click.
- **Server comparison** (§6.3, §7.3): the server distinguishes an OMITTED
  expectation from a captured empty one. For a human acceptance an omitted
  material/todo revision is refused (400) when the server can read a current
  value; a captured empty value never hides a known current value (409); an
  unavailable current fingerprint (no Git) accepts a captured empty one, so no
  false `stale` is produced. The todo is resolved from the logical workspace by
  full id or by a unique prefix; an ambiguous or missing todo with a pinned
  revision is a 409. The displayed todo revision is persisted as
  `acknowledgedExpectedTodoRevision` on the job and attempt snapshot and as
  `acceptance.expectedTodoRevision` on the todo review snapshot.
- **`round.index`**: counts implement/fix rounds since the last credible PASS of
  the subject (all of them when there was none).

### 15.1 Open points

- Browser verification of the rendered badge was not possible in the delivery
  environment (navigation to the app origin was blocked), so the visual result
  is covered by source-level and unit tests only.

## 16. Rollout backfill (leaf 6)

Leaves that predate this field have delegation history but no stored snapshot.
The rollout leaf materializes the fill-in step as `scripts/backfill-todo-review.js`
(a thin CLI over `lib/todo-review-backfill.js`), which recomputes each leaf with
the **same** function the live sync uses (`computeTodoReviewSnapshotForTodo`,
`lib/todo-review-sync.js`) and persists it through the dedicated `writeTodoReview`
(§10.2). It is an operator tool, run once per workspace: no read path calls it and
nothing is written lazily on `todo_list` / `todo_show` / `GET /api/todos` (§2.2,
§10.4).

### 16.1 Sources and boundaries — SETTLED

- Jobs come from `listDelegationsForWorkspace(folder, { dataDir })` (§2.1) and
  todos from `loadTodosData`; the CLI never reads a `data/` file to decide
  anything. The only files it touches outside the stores are the backup and the
  checkpoint below.
- Verdicts come from the durable `reportVerdict` (§5.1), never by re-parsing a
  body that retention already cut at 2000 characters (§11.1). A job with no
  durable verdict and a cut body is `unknown`, never `passed`.
- Attribution comes from the record `leafId` only (§2.4). An archived job whose
  attribution lived in the cleared `sourceText` is unattributable, and no
  backfill may attribute it by chat or by text.
- A job that never declared a subject reads `other` (§3.2), so a backfill can
  never produce `code: passed` from it; its result stays visible as an
  unknown-subject review.
- `status`, the changelog, the sibling order and `item.updatedAt` are untouched
  (§10.2, P8). `doc.updatedAt` advances, because that is a document revision.

### 16.2 History completeness — SETTLED

§11.2 requires incomplete evidence to surface as `unknown` rather than a silent
claim. The live sync only ever sees the jobs attributed to the leaf, so it cannot
know how much of the workspace's history retention dropped. The backfill adds
that judgement, from evidence and not from the todo's age:

A subject with no review attempt is `none` **only** when no job inside the leaf's
lifetime is unattributable and review-relevant (assignment `review`, or — for a
row that predates the vocabulary — neither an assignment nor a persisted role).
An unattributable job inside that window makes the affected subject `unknown`
with `stateReason: "history_truncated"` and `truncated: true`, including for an
old open leaf, whose lifetime never ended. A job attributed to a different leaf
is not a gap for this leaf, and a trimmed attempt history on the leaf's own job
is already settled by the live builder (§11.2).

The gate applies where the leaf has no stored subject snapshot yet. A `none` the
live sync already wrote is that path's own §4.1 answer and is not rewritten by
the rollout inference; once the leaf gains new activity the live recomputation is
the authority again.

### 16.3 Never a downgrade — SETTLED

A stored subject whose state is `passed`, `failed`, `manual`, `stale` or
`pending` is never replaced by a recomputation that yields `none` or `unknown`.
The backfill simply omits that subject from the write, so `mergeTodoReviewSubjects`
keeps the snapshot that was computed while the evidence still existed (§10.2).
Improving a stored `unknown` into a decided state is allowed and is the normal
second pass.

### 16.4 Operator surface — SETTLED

```
node scripts/backfill-todo-review.js --workspace DIR [--data-dir DIR]
  [--dry-run | --apply] [--checkpoint PATH] [--restart] [--json]
```

- `--dry-run` is the default and writes nothing at all: not the todos document,
  not a checkpoint, not a backup. It prints one line per subject with the state
  matrix, the action tally, the evidence signals and the rollback command.
- `--apply` persists exactly what the dry run planned: the planner predicts the
  writer's own `decisionKey` test, so a predicted `unchanged` is not a write.
  Re-running is a no-op (idempotent, §5.5).
- Before its first write `--apply` copies the workspace's todos document to
  `<data-dir>/backups/todo-review-backfill/<workspace-key>.<stamp>.json`.
- Processing is checkpointed in
  `<data-dir>/backfill/todo-review.checkpoint.json`, scoped to the workspace and
  the data directory: a leaf is committed only after a successful write, a leaf
  whose write failed stays pending, an interrupted run resumes with the rest, and
  a complete pass removes the file. `--restart` ignores an existing checkpoint.
- Exit codes: `0` clean, `1` at least one leaf failed, `2` a usage or store
  error.

### 16.5 Rollback — SETTLED

Restoring operator data is a file write this script deliberately never automates:

1. stop the server (or keep the workspace idle) so no writer races the restore;
2. `cp <data-dir>/backups/todo-review-backfill/<file> <data-dir>/todos/<workspace-key>.json`;
3. restart — the boot repair (§10.5) re-derives the snapshots from the delegation
   records again.

For a single leaf no rollback file is needed: `review` is only a cache of a
recomputation, so the next delegation event for that leaf restates it from the
records (§10.4).

## 17. Baseline, guarantees and non-guarantees

### 17.1 What already existed

Before `todo.review`, the server already computed `acceptedByReview` in the
delegation/usage metrics (cycle acceptance from review verdicts). What was
**prompt-only** was the rule "a leaf is `done` only after an independent review
PASS": it lived in the orchestrator prompt and skill text and nothing persisted
or displayed the outcome on the todo. `todo.review` persists and exposes that
evidence; it does not enforce the rule (`done` is not blocked, §12.3).

### 17.2 Who writes it

Only the server writes `todo.review`, from delegation records, through the
dedicated writer (§10.2). `todo_create`/`todo_update` and `PATCH /api/todos/:id`
reject a payload carrying `review`; an agent cannot set, clear or overwrite it.
`manual` is reachable only from the human accept action on the authenticated UI
card channel (§7). An MCP `delegation_ack` with `reason=accepted` from an agent
is recorded as an acknowledgement but never yields `manual`.

### 17.3 What the badge does NOT guarantee

- **Not a content guarantee.** Freshness is the narrow rule of §6.1: a review is
  stale only when an implement/fix was queued or started after it. Edits outside
  a delegation, requirement/plan edits, and manual worktree changes are not
  detected (§6.2).
- **Retention.** Finished delegations are archived after 30 days (report cut to
  2000 chars) and attempt history is capped at 20 (§11.1). When a referenced
  attempt is gone the subject becomes `unknown` (`history_truncated`), not
  `passed`. Archived jobs whose leaf attribution lived in the cleared
  `sourceText` cannot be attributed at all.
- **`unknown` is an honest answer**, not an error: incomplete history, a
  cancelled/infra sibling in a fan-out, or a verify obligation that was never
  satisfied all land there. The backfill (§16.2) only claims `none` when no
  unattributable review-relevant job falls inside the leaf's lifetime.
- **A plan review is not a code review.** `plan` and `code` are separate
  snapshots; a job with no declared subject reads `other` and can never make
  `code` `passed`.
- **A parent/container is never certified** by its children's badges (§12).
- **Worktree integration is not review.** `integration.reviewOutcome` is
  historical artifact metadata from the cycle (see
  [`todo-worktree-contract.md`](todo-worktree-contract.md)); `confirm`/`merge`
  neither create `passed` nor `manual`.
- **Scout is outside the mechanism.** Workspace Scout findings and proposals do
  not read or write `todo.review`.
- **`manualAccepted`** now counts only acceptances whose actor is `human`
  (§7.5). Earlier agent `accepted` acknowledgements no longer count, so the
  metric can drop versus previous releases.
