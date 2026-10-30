# Stan pętli delegacji per liść

Dokument opisuje kontrakt `delegation_workflow_*` po wprowadzeniu stanu per
liść. Stan nadal zapisuje parent (serwer nie jest sekwencerem), ale klucz jest
per `(parentChatId, leafId)`, a serwer potrafi odtworzyć rundę i werdykt z
historii terminalnych jobów, gdy parent ich nie zapisze.

Model pick proposals and `pick_id` on start are documented in
[`model-pick-decisions.md`](model-pick-decisions.md). Rola joba jest zapisywana
jawnie w `pickRole` (przed normalizacją `assignment`), więc `fix` nie zlewa się
z legacy `implement`; grupowanie cykli (`delegationCycleRole`) używa tego pola,
a wiersze bez niego pozostają `implement`.

The persisted verdict a leaf carries — who reviewed it, with which model and on
which subject, how independent the reviewer was and whether the review is still
current — is defined in [`todo-review-contract.md`](todo-review-contract.md).
This file stays the per-leaf *loop* contract (rounds, deadlines, budgets); the
review contract owns the `todo.review` snapshot and reads the same attempt
history. Pass `review_subject` (`code` or `plan`) on every review start; the
loop's `last_verdict`/`report_text` are inputs to the loop only — the todo's
review state is recomputed by the server and is not written by `workflow_update`.

## Bounded execution guidance

The generated TODO execution prompt tells the orchestrator to read the existing
`workflow_show` row before each leaf, initialize missing state with `max_rounds=4`,
and persist each review with its verdict, findings, material revision and stable
attempt-specific idempotency key. Existing user budgets and deadlines survive a
resume. Corrections use the `fix` pick role and assignment.

The orchestrator prompt still uses soft checkpoints (15 minutes for fix/review,
30 minutes for initial implement) to inspect progress. Separately, the runtime
worker enforces a **hard per-run limit from `startedAt`**: review and fix jobs
default to 20 minutes, implement jobs to 40 minutes (`CRETLI_DELEGATION_RUN_DEADLINE_*`,
`0` disables the default). Explicit `deadline_at` on `workflow_update` or
`delegation_start` overrides that default; the server never extends a user
deadline. On exceed the worker requests cancel like `delegation_cancel`; the job
finishes as `interrupted` with `interrupt_code=run_deadline_exceeded` (not a
review verdict and not counted as a review round in workflow history). Leaf
`deadline_at` cancels use the same stop path but keep a normal cancel finish
without `run_deadline_exceeded`. The parent waits for `slot_occupied=false`, then hands partial
work to another executor (`exclude_models`). Runs that entered `running` before
this feature shipped keep only explicit deadlines until they finish; new runs
set `runDefaultLimitActive` at first `running`.

After a finding survives a fix, or two code reviews fail, the parent must reconcile
scope and root cause and choose a different eligible executor. Transport failures
lead to a different harness for that recovery attempt. Lack of eligible alternatives
is reported as a blocker. Soft round caps and `same_findings` are not lifted repeatedly
without new evidence and a changed approach.

When the orchestrator omits `leaf_id` / `todo_id`, the server may infer the
active leaf: the calling chat must be the `orchestrator_chat_id` of a todo root
and that subtree must contain exactly one leaf in status `doing`. The resolved id
feeds leaf-size flash policy, per-leaf workflow, delegation `leafId`, and pick
proposal linkage; responses include `leaf_source=inferred` when applicable. With
zero or more than one doing leaf the call proceeds without inference and returns
`warning.code=leaf_id_missing` plus `candidates`. Explicit ids always win; a leaf
outside the orchestrator subtree is rejected. Set
`CRETLI_ORCHESTRATOR_LEAF_INFERENCE=0` to disable inference. The generated TODO
execution prompt still asks the orchestrator to pass `leaf_id` explicitly.

For implement/fix picks on a leaf, pass `leaf_id` (or `todo_id`) to `model_pick`:
after a **completed** implement or fix job on that leaf in the parent chat, the
picker sticky-prefers the same harness/model for the next implement/fix on that
leaf (unless `exclude_model` removes it). Terminal completion rate and median
duration from the last 30 days feed the implement/fix score when
`adaptive.enabled` is on (`data/model-role-profiles.json`).

Implement picks also classify the leaf body as **small** or **large**
(`classifyLeafSize`: at most three listed existing file paths and no configured
large keywords → small; missing file list → large). On a **large** leaf,
`*flash*` catalog ids are merged into `exclude_models` for the pick; the start
gate still blocks flash without a substantive `pick_reason`. When every
implement candidate is flash-only, the leaf gets
`blocked_reason=no_non_flash_candidate` instead of silently picking flash.
Thresholds: `CRETLI_LEAF_SIZE_MAX_FILES`, `CRETLI_LEAF_SIZE_LARGE_KEYWORDS`
(pipe-separated, case-insensitive substring match on the body).

Both fix executors and reviewers receive stored workflow and Watcher findings,
including on retry. The fix checklist asks for `FIXED`/`STILL_OPEN` evidence for
each finding and checks production callers and consumers. An implementer PASS
never satisfies the independent review gate.

Verification starts with named regressions, directly affected suites and required
repository checks. Repeating or broadening checks requires a new change, failure
or concrete unresolved risk. Results for unchanged material can be reused;
unverified attribution of unrelated failures must remain explicit. Full acceptance
checks still run when required at the leaf or final integration boundary.

`review_can_run_tests=false` requires parent host verification through
`delegation_verify`; it does not mean repository reads or guarded read-only shell
are prohibited. The reviewer first establishes a permitted inspection path. If none
exists, the parent supplies the exact diff and relevant sources or chooses another
eligible reviewer. Mutation guards remain unchanged.

After a `completed` **implement** or **fix** the host starts the audited verify
itself (`source: auto_after_implement`, ids mapped from the changed paths, full
catalog when none map; disable with `CRETLI_AUTO_VERIFY_AFTER_IMPLEMENT=0`). A code
review started while it runs is refused with retryable `verify_pending`; poll
`delegation_show` (`verify_running`/`verify_pending`) and retry. A passed,
non-stale result for the current revision is copied onto the review record
(`inherited_from_implement`, manifest-checked, see the manifest section) and its output tail is added to the review prompt.
The parent therefore calls `delegation_verify` only when the result is missing,
stale or failed. The manual rule below still applies in those cases:

After every terminal **implement** or **fix** on a leaf without such a result, the
orchestrator runs `delegation_verify` on that delegation id **before** starting a
code review (or before handing partial work to the next executor). A failed verify sends the
orchestrator to fix with the test output; it must not start review or consume a
review round. The server rejects a code review start when the latest implement/fix
on the same leaf still has a failed verify for the current material revision
(`verify_failed_before_review`; override with `allow_verify_failed_review=true`).
Verify results are stored on the implement/fix record (`verify_result.material_revision`).

The server also refuses to re-run the same reviewer (same transport and base
model; an effort suffix does not make a different reviewer) on unchanged
material (`review_recheck_no_material_change`, HTTP 409, no delegation row is
created). What "unchanged" means depends on the subject:

- `review_subject=code`: the start resolves the live leaf-scoped material
  revision and the review row stores it as `reviewedMaterialRevision`. When both
  the live revision and the one on the reviewer's last usable review are known,
  a different revision admits the start, including a direct edit made without
  any implement/fix delegation. Legacy rows or leaves without a captured
  material base fall back to the row rule: no implement/fix was queued since
  that review.
- `review_subject=plan`: the plan of the todo named by `leaf_id` is unchanged.
  The gate compares a content-only key (hash of `plan.markdown`, stored as
  `todoPlanContentKey`), so saving or approving a plan without changing its text
  does not re-admit a rerun, while a markdown change does. Legacy rows that only
  carry `todoPlanRevisionKey` (hash of `plan.updatedAt` + `plan.markdown`) fall
  back to comparing that key. This holds whatever the delegation source
  (`task_text`, history message or saved chat plan; the chat plan revision is not
  used). A plan start is allowed when the todo or its plan is missing, or when
  the earlier review row carries no key.
- `review_subject=other` is intentionally uncovered: it has no material notion
  and is never refused by this gate.

A reviewer attempt cancelled by the wait limit (`run_deadline_exceeded`) is not a
usable prior review (same notion as the review snapshot), so rerunning the same
reviewer after a timeout needs no `allow_recheck`. A different base model, an
exchange-phase start tied to an independent row, and `allow_recheck=true` are not
refused.
`delegation_start` exposes `allow_recheck` (alias `allowRecheck`) over MCP and REST
as an explicit, audited override: for `assignment=review` only it bypasses
`review_recheck_no_material_change`, which refuses the SAME reviewer (same
transport and base model) for the SAME review subject on unchanged material since
that reviewer's last usable PASS/FAIL/BLOCKED verdict on the leaf; every other gate
stays intact. Cancelled and wait-limit reviewer rows are ignored by that gate, so
replacing a cancelled or timed-out participant is normally not refused. The
persisted `allowRecheck` flag (shown as `allow_recheck` in
`delegation_start`/`delegation_show`) records that the override was REQUESTED, not
that it was used: it is stored whenever the caller passes true, including
non-review starts, and it is not part of the request hash.

Known limitation (plan-write race): the plan key is read once, before the start
commits. A plan write that lands between that read and the row creation is not
re-checked; the row records the key read at gate time, so the next start compares
against that older key and is simply admitted (fail-open). No lock is taken; a
stale read can only admit an extra review, never block one.

### Exit path after `reviewer_timeout`

A round whose reviewer timed out resolves to `unknown` / `reviewer_timeout` and
never closes with a substitute PASS: sibling PASSes do not form a quorum without
it. The orchestrator (or skill) leaves that state in one of two ways: start a new
review round (the timed-out attempt is not a usable prior review, so the same
reviewer may be rerun, or pick another reviewer), or escalate to an explicit human
acceptance of the leaf. An orchestrator must not set the review result itself.

Observation vs decision: the snapshot rounds are bounded by implement/fix
material. A replacement reviewer started on the **same** material is an extra
participant of the timed-out round, so the server badge keeps reading `unknown` /
`reviewer_timeout` (the old-round PASS and the replacement PASS never form a
quorum), while a replacement FAIL/BLOCKED still makes the round `failed`. The
replacement verdict is decision input for the orchestrator; the badge only turns
`passed` in a new material round (new implement/fix followed by its own
reviewers) or through explicit human acceptance. Regression:
`tests/review-reviewer-wait.test.js` ("two rounds after reviewer_timeout").

### Review finish diagnostics (continuation runs)

A codex review guard denial aborts the turn and queues a read-only follow-up; a
review missing its VERDICT line queues one VERDICT follow-up. Both continue the
**same attempt** under a new adapter run id, and the deferred finish of the first
run is not a terminal. `lib/delegation-run-bridge.js` records that hand-over on
the room and, when the next queued prompt starts for the same delegation and
attempt while the record still fences on the deferred run, adopts the new run id
once. Without it the history showed the continuation run finished while the
record stayed `running` (its finish was dropped as foreign), liveness read
`unknown` and a plain cancel targeted the dead run, ending `review_cancel_stuck`.
Adoption is an observation step only: it starts, resumes, cancels and releases
nothing. A late event of the old run is fenced out and cannot finalize the new
run; a confirmed finish of the adopted run without a report goes through the
existing incomplete/no-verdict path; busy (long tool), `waiting_for_input` and
unknown liveness keep the slot occupied as before (owner + `stopProof` model
unchanged). Regression: `tests/delegation-review-continuation-run.test.js`. A
historical `runFinished=cancelled` adapter event is evidence of the adapter's
view, not proof that an external process died.

### Durable continuity confirmation

`sessionContinuityConfirmed` stays `false` until the exact `runFinished` marker
is durably committed with both `eventStreamId` and `roomEventSeq`. A missing
marker, a failed flush, or a worker finish without proof of durability yields
`resume_continuity_unknown`; resumption then safely falls back to a fresh chat.

## Two-phase code review (audit + closure)

For `review_subject=code` on a leaf with an explicit `leaf_id`, the server
stores `reviewMode` on the delegation record (`audit` or `closure`) and keeps
phase counters on the workflow row:

- **`audit`** — first code review of the leaf in the current cycle: full scoped
  audit against leaf acceptance criteria; findings use stable IDs and priority;
  out-of-scope notes are `OUT_OF_SCOPE` and do not block the verdict.
- **`closure`** — later code reviews after the audit: prompt limits work to
  FIXED/STILL_OPEN on open findings plus fix regressions; new non-P1 findings
  go to `FOLLOW_UP` and do not block PASS when audit findings are closed.

Defaults: one audit plus two closure **rounds** per cycle
(`CRETLI_DELEGATION_CODE_REVIEW_MAX_CLOSURES`, default `2`). A round is one
implement/fix material revision: parallel closure fan-out in the same round
counts once. Only terminal reviews with a usable verdict advance counters;
infra/cancel/deadline/unspecified finishes and retries of the same delegation id
do not consume closure budget. A closure FAIL on the last allowed round sets
`stop_reason=closure_rounds_exhausted`; `resume_rounds` on `workflow_update` (or
on `delegation_start`) clears the stop and grants one more closure allowance.
Closure picks sticky-prefer the audit reviewer (`codeReviewAuditReviewer`) when
still eligible; an infra outcome by that reviewer on the leaf drops sticky
automatically. Plan reviews and ad-hoc code reviews without a leaf id keep the legacy
full regression gate (`CRETLI_DELEGATION_CODE_REVIEW_PHASE=0` disables the
split). The orchestrator should create separate todos for `FOLLOW_UP` and
`OUT_OF_SCOPE` items instead of expanding the current leaf.

Opt-in reviewer pool: with a fixed pair (`reviewer_policy`, or the legacy
`reviewer_pair_enabled` + complete `reviewer_pair_members`; Settings → Delegations) the parent passes the two
members to `model_pick` as `prefer_models` with `count=2` and runs two fresh
review jobs per round (no resume). The workflow row keeps one round record
(`codeReviewPoolRound`: round key, epoch, mode, members' results and reviewer
identities) captured when the round starts, so a later settings change or a
replacement start does not reclassify it. The counter/audit/epoch effect is
applied once, when the round resolves: any FAIL resolves it as a failed round
(closure count +1; audit mode sets `codeReviewAuditDone`), two distinct PASS
resolve it as PASS (counter reset). Only distinct reviewer **canonical**
identities count (same harness + base model; an effort suffix or a Claude moving
alias never creates a second identity, and an `outside_pool` reviewer never
supplies one of the pair's two PASS results): a second PASS from the same
reviewer never resolves the round as approval. A
member PASS that finishes first mutates nothing, and a late sibling result of
an already resolved round is ignored. A lone PASS stays pending while a second
distinct member can still arrive; if two credible PASS results come from the
same reviewer identity (the fixed pair never obtained a second eligible
reviewer), the round resolves `DEGRADED` with
`stop_reason=reviewer_pool_degraded`, advances no counter and never approves the
leaf. That stop is actionable: the parent reports it as blocked, and
`resume_rounds` on `workflow_update` clears it once reviewer eligibility is
restored. Consequently `CRETLI_DELEGATION_CODE_REVIEW_MAX_CLOSURES` counts
rounds, not jobs.

Early satisfiability check (fixed-pair code reviews only): at review start the
server asks whether two distinct canonical identities (same harness + base
model, effort ignored) can still be obtained from the pair members plus eligible
stand-ins, after the implementer/orchestrator excludes and members that cannot
be started (`evaluateReviewerPairSatisfiability`, stand-ins from
`listReviewCandidates`). When they cannot (for example both members are Low and
Medium of one base model), the first reviewer of the round still starts, with a
`reviewer_pair_unsatisfiable` start warning naming the missing identity
(`harness/model`) and the reason; a further start whose canonical identity
already started in the same open round is refused with the typed error
`reviewer_pair_unsatisfiable` (HTTP 409). Independence is not relaxed, and
`reviewer_pool_degraded` handling at round end is unchanged. The alert is an
operator journal event (`reviewer_pair_unsatisfiable`, summary with leaf id,
round key and missing identity) written once per leaf and round;
`reviewer_pair_satisfiable` clears it. `operator_handoff` shows the events and
`operator_watcher_status` lists open ones as `reviewer_pair_alerts`
(`[{ leaf_id, missing, since }]`). Plan-review pairs and non-pool reviews are
not checked.

Per-todo override: a todo may carry `reviewer_pair` (`{ enabled?, members? }`),
set through `todo_update`, REST `PATCH /api/todos/:id`, or `todo_create`. A
complete pair with `enabled:true` takes precedence over workspace reviewer
settings for that todo; `enabled:false` disables the fixed pool, and an absent
or malformed value keeps workspace behavior. The selected pair remains sticky
for the todo, while hard exclusions such as the implementer still win and mark
the pool degraded when a replacement is needed.

### Reviewer policy per review kind (`reviewer_policy`)

Settings → Delegations → Review holds one policy per review subject, **plan** and
**code** (`review:other` keeps the legacy `reviewer_pair_*` behavior and is not
configurable in the new UI). Each entry has:

| field | values | meaning |
| --- | --- | --- |
| `selection` | `auto` \| `fixed_pair` | `auto`: `model_pick` chooses each reviewer. `fixed_pair`: the same two reviewers every round. |
| `members_source` | `learned` \| `configured` | `learned`: the first two distinct reviewers of a controller (orchestrator chat) and subject become its pair (`reviewer-pairs.json`, partitioned per subject; an errored member is evicted, a verdict FAIL never evicts). A member that can no longer be started by configuration (its model left the enabled favorites, compared by canonical base model, or its harness is disabled or has no delegation adapter) is evicted on read the same way, unless it still has a non-terminal review of that controller and subject; the next distinct reviewer then joins the pair. Quota/limit lockouts, missing credentials and provider errors never evict, and nothing is evicted when the harness has no favorites configured. `configured`: two chosen favorites (same harness + base model = one reviewer; effort never makes a second reviewer). |
| `session` | `fresh` \| `leaf` \| `orchestrator` | `fresh`: new chat per review. `leaf`: re-enter the member's earlier session of the same leaf. `orchestrator`: any leaf of the same controller. |

One resolver (`lib/reviewer-policy.js`) feeds manual TODO start/continue, full mode,
refine, Watcher cycle prompts (`resolveReviewerPoliciesForPrompt`), MCP
`model_pick` and the server start path, so every route sees the same effective
policy. `model_pick` has no default `review_subject`: it injects a fixed pair as
`prefer_models` only when the caller passes `review_subject=plan|code` explicitly.
Without it no pair is injected (the picker never guesses a subject, so a plan
review cannot silently receive the code pair). **The server enforces it** in
`createAndStart` for every review start, including from an older running
orchestrator; prompts only mirror it. A running job keeps the snapshot stored on
it (`delegation.reviewerPolicy`: subject, revision, selection, session, members,
membership, reuse decision).

Reuse rules (every gate of `inspectDelegationSessionResume` still applies):

- A reviewed round is always a NEW delegation, attempt, report, verdict and material
  id, even when `childChatId` is reused. No earlier PASS is inherited.
- The first known member is reused while the pair is still being learned; a
  reviewer outside a complete pair is started fresh (`reuse_not_pool_member`) and
  never redefines the pair.
- Eviction of an unstartable learned member runs on every policy read that has
  the delegation list: the review start, the `model_pick` fixed-pair injection
  (`prefer_models`, which then offers one member and lets the next reviewer
  join) and prompt/UI policy reads. A `configured` pair is never rewritten. The
  member the current start has just learned is exempt in that start's re-read,
  and an evicted member is not blacklisted: once enabled again it can be learned
  again when a slot is free.
- Audit and closure never share a session (`phase_changed`, both directions);
  with a same-phase candidate available it wins over a newer other-phase one.
- A session whose chat also ran implement/fix work is never reused
  (`resume_implementation_history`); independence is judged against every
  implementer of the *current* leaf. The only exception is the opt-in
  `continue_cross_role_sessions` (see "Cross-role chat reuse" below), and it
  never makes a review independent.
- Execution folder, execution mode, options, effort, permissions, root/depth,
  adapter support, lockouts, busy/claimed/reset/missing sessions and peer-opinion
  (exchange) contamination fall back to ONE fresh chat with a durable reason.
  The fallback never relaxes read-only, independence or model gates.
- Every review records its decision (`reuse_fresh_by_policy`, `reuse_first_session`,
  `reuse_learning_pair`, `reuse_no_eligible_source`, `reuse_not_pool_member`,
  `resumed`, or a `resume_*` fallback code) on `sessionResume` (when a policy asked
  for reuse) and always on `reviewerPolicy.reuse`; the delegation card shows
  "same chat, round N" or the reason a new chat opened.
- Implement/fix/planner continuation is separate from reviewer policy and uses
  the three switches under Settings → Delegations → Sessions described below.
  Reviewer membership never enables or disables those work-role switches.

Migration (read-time, deterministic, idempotent; legacy fields stay stored so a
reset or downgrade keeps working): `strict` -> `fixed_pair` + `session=leaf` (the
boundary strict mode really enforced; `members_source=configured` with a stored
pair, else `learned`); `enabled` + complete pair without strict -> `fixed_pair`,
`configured`, `fresh`; anything else -> `auto`, `fresh`. Orchestrator-wide reuse
is a new opt-in (the Settings view shows a notice). Saving a `reviewer_policy`
overrides the derived value per subject; clearing it returns to the derivation.
Learned pairs migrate lazily per controller and subject: the legacy mixed pair is
filtered to the members that actually reviewed that subject (original order, at
most two); rows without a plan/code subject infer nothing and stay in the legacy
`other` pair.

### Session continuation for plan, implement and fix (Settings → Delegations → Sessions)

Chat continuation is one server-side decision per start, taken **after** the
executor is chosen (picker, `pick_id`, `continuation_of` and lockouts are
unchanged; `continuation_of` is model-affinity evidence, never a chat resume).
The server classifies the start into a persisted `workRole`
(`lib/delegation-work-role.js`): `plan` (plan *authoring*: `requested_role=plan`
with explicit `assignment=implement`), `implement`, `fix`, `review_plan`,
`review_code`, `review_other`. A plan *review* is never `plan`; rows written
before the field existed have no `workRole` and are never a reuse source.
The planner always runs under a server-selected, certified read-only adapter
profile (`executionMode=plan`; the adapter receives the read-only review
assignment). A transport without a pre-execution deny or read-only sandbox is
rejected with `planner_read_only_unsupported`; the review-only uncertified
escape hatch does not apply. Planner rows remain API-compatible
`assignment=implement`, but are excluded from implementation verification,
review independence, sticky-executor selection and implementation outcome
statistics by `workRole=plan`.

| Role | Switch | Default | Re-enters | Never |
|------|--------|---------|-----------|-------|
| `plan` | `continue_plan_sessions` | off (fresh) | newest finished `plan` chat in the selected scope | implement/fix/review chats |
| `implement` | `continue_implement_sessions` | on (scope `leaf`) | newest finished `implement` chat in the selected scope; with `continue_cross_role_sessions` also a code review chat of the same leaf | `fix`, plan, review chats (code review chats only when the cross-role setting is off) |
| `fix` | `continue_fix_sessions` | on (scope `leaf`) | newest finished `fix` or `implement` chat in the selected scope (implement -> fix only when this is on); with `continue_cross_role_sessions` also a code review chat of the same leaf | plan, review chats (code review chats only when the cross-role setting is off) |
| `review_plan` / `review_code` | `reviewer_policy.<subject>.session` (`fresh` \| `leaf` \| `orchestrator`) | legacy-derived | unchanged reviewer behaviour; `review_code` with `continue_cross_role_sessions` may also re-enter the implement/fix chat of the same leaf | implement/fix history (except the cross-role case for `review_code`) |
| `review_other` | legacy pair only | legacy | unchanged | - |

Each work switch has its own `<role>_session_scope` (`plan_session_scope`,
`implement_session_scope`, `fix_session_scope`): `leaf` by default, or
`orchestrator` to reuse across TODOs of the same controller. Existing enabled
switches retain their per-leaf scope until the operator changes it. Scope is
independent for all five roles; choosing orchestrator scope for plan review
never changes code review or implementation. Folder, executor and continuity
checks still apply across leaves; separate worktrees do not share sessions.

When `leaf_id` is omitted, model selection and delegation starts can infer an
existing TODO directly linked to the controller chat, or the unique doing leaf
under its linked group / registered orchestration root. Groups and ambiguous
sets of active leaves are never treated as a leaf. With per-leaf work continuation
enabled, an unresolved TODO-linked start is rejected before creating a child
(`leaf_id_required_for_session_reuse`); the caller must supply the TODO ID.
Unattributed ad-hoc starts record `resume_no_leaf` instead of a generic
missing-source reason. Explicit IDs remain preferable during parallel work.

`continue_implement_sessions` and `continue_fix_sessions` default to **on**
(scope `leaf`); `continue_plan_sessions` and `reviewer_policy` are unchanged.
The default is workspace-wide, not per harness. Only unset values follow the
default: a stored `false` keeps winning, and saving unrelated settings never
writes the switches (the PATCH carries changed fields only). Known behaviour
change: with the switch on and scope `leaf`, a TODO-linked start without a
resolvable `leaf_id` is now rejected with `409 leaf_id_required_for_session_reuse`
instead of silently starting a fresh chat.

Post-change measurement (claude implement is the only harness with evidence):
after 7 days compare `usage_top group_by=resume` for the claude `implement`
role. If resumed weighted tokens per delegation are not lower than fresh, revert
the two defaults to `false` in `lib/delegation-settings-schema.js`.

- Off (an explicitly stored `false`, or the unset `plan` default) always means a
  **fresh chat**; the stage still runs. An explicit
  `resume_session_of` is ignored (recorded `work_fresh_by_policy`) while the
  role's switch is off.
- Gate (`inspectDelegationSessionResume`, work branch): same controller, selected leaf scope (unless orchestrator scope is enabled),
  transport, canonical model, `::` params, options, execution mode, folder,
  delegation rights/depth/root; adapter `canResumeSession`; no lockout; source
  `completed`; no active row on the chat (the check runs synchronously before the
  record exists, so two starts never share a chat — a parked second start gets
  its own chat); chat and harness session exist; no active run; unchanged cache
  configuration; every row of the chat is in the same role family. Session
  continuity is proved by the persisted harness-session identity and
  generation plus the exact durable history head captured when the source
  finished. A reset/compaction advances the persisted generation; any normal
  turn appended afterwards changes the history head. Missing continuity after a
  process restart fails closed instead of assuming generation `0`. Any failure is
  ONE fresh chat with a durable `sessionResume.reasonCode` (`resume_role_changed`,
  `resume_unclassified_source`, `resume_session_reset`,
  `resume_continuity_unknown`, `resume_foreign_history`, `resume_no_leaf`, ...).
- Two fail-safe guards run **per candidate source**, before the gate above
  (work roles, plus cross-role candidates of a code review when
  `continue_cross_role_sessions` is on; same-role reviewer reuse is untouched).
  A hit rejects that candidate; when no other candidate resumes, the start is
  one fresh chat (`sessionResume.status` `fallback`):
  - `work_cache_expired`: the candidate's child chat has cache state `cold` with
    reason `ttl_expired` (read through `buildChatCacheView`). Resuming would
    re-read the whole history at full price. `warm`, `unknown`,
    `context_epoch_changed` and `session_restarted` never block (fail open, as
    does a lookup error). Cache state is process-scoped, so after a server
    restart it is `unknown` and this guard does not fire.
  - `work_previous_empty_report`: keyed on the candidate's **source chat**, not
    on the start's role. The newest terminal (`failed` or `completed`)
    delegation of that chat under the same controller (any role) was a
    `resumed` attempt with an empty or whitespace-only report. This covers a
    failed empty attempt next to an older completed source and a completed
    empty attempt that is itself the selected source. Cancelled or interrupted
    attempts do not count; only the newest attempt does, so a later healthy
    attempt makes the chat resumable again.
  - An explicit `resume_session_of` is exempt from both guards (operator
    intent); it still passes every gate above.
- Every return is a **new** delegation with its own attempt, report, metrics,
  rating and verification; the resumed prompt carries a neutral
  `[RESUMED <ROLE> SESSION, ROUND n]` block and no earlier verdict. Reviewer
  independence is untouched: with `continue_cross_role_sessions` off (the
  default) a review chat never contains implement/fix history and an
  implement/fix chat never contains review history.
- Each start stores `workRole` and a `continuationPolicy` snapshot
  (`field`, `enabled`, `source`, `scope`, `reason`). Changing a switch affects
  later starts only.

### Cross-role chat reuse (opt-in `continue_cross_role_sessions`)

Default **off**. When on, one executor chat may be re-entered when the role
changes between code review (`review_code`) and implement/fix **of the same
leaf and controller**. Plan authoring, plan review and `review_other` never
cross roles; reuse across leaves or watcher cycles is out of scope (the
orchestrator scope never widens a cross-role reuse).

- Widening only: the setting adds candidates, it never enables a start. A
  work start still needs `continue_implement_sessions` / `continue_fix_sessions`;
  a review start still needs `reviewer_policy.code.session != fresh` and pool
  membership.
- Candidates, in order: the same-role source (as today), then cross-role
  sources newest first — one per child chat whose **latest finished row** has
  the other role, the same transport, canonical model, `::` params and options.
  The service tries each candidate until one resumes. Both fail-safe guards
  (`work_cache_expired`, `work_previous_empty_report`) run per candidate before
  the gate: on every candidate of a work start and on the cross-role candidates
  of a review start. When no candidate resumes, the start is fresh and the
  recorded reason is the **first** candidate's (same-role first). With the
  setting off the list is today's single source, so every code is unchanged.
  An explicit `resume_session_of` is exempt from the guards.
- Relaxed checks, only for {`review_code`, implement, fix} rows of one leaf and
  controller: `resume_role_changed`, the role clause of
  `resume_foreign_history` (leaf and controller clauses stay),
  `resume_scope_changed` subject clause, `phase_changed` (compared only for a
  review source), `resume_implementation_history`, and the verdict requirement
  for an implement/fix source (`completed` is still required; a code review
  source still needs a usable verdict). `resume_independence` is relaxed only
  when the source chat is the chat of the current **round implementer** (the
  same choice as the todo review sync, `lib/delegation-round-implementer.js`);
  a chat of an earlier, other implementer still refuses. Every other gate stays.
- Independence is never raised: a resume requires the source row's transport
  and model, so a cross-role review always has the round implementer's base
  model and harness and the server classifies it `same_model_same_harness`
  (or `unknown` for `auto`), never independent. `docs/todo-review-contract.md`
  is unchanged.
- Permissions per run: the run reads the active delegation's assignment, so a
  resumed chat gets the NEW role's permissions (review read-only, write access
  back for implement/fix). Audited transports: `claude`, `codex`, `qwen`, `sdk`.
  `deepseek` rebuilds its harness on a read-only switch and drops the session,
  and `opencode` only logs a failed permission sync (the run would continue
  with the earlier write permissions), so both are excluded; any excluded transport records
  `resume_cross_role_unsupported` and starts fresh. The fallback never relaxes
  read-only.
- Audit trail: `sessionResume.reasonCode` `resumed_cross_role` (status
  `resumed`), `crossRole: true` and `sourceWorkRole` on the record; the card
  shows "same chat, other role". The resume prompt states the new role and, for
  a review, that findings rest on the current material, not on the chat's own
  earlier claims. Two parallel reviews cannot both claim one chat
  (`resume_session_claimed`); the second starts fresh.

Start-path matrix (all callers go through `delegation-service` `createAndStart`,
so HTTP, MCP, manual TODO start/continue, and Watcher get the same effective
policy):

| Start | Role seen by the server | Covered |
|-------|-------------------------|---------|
| Manual TODO start / continue, Watcher cycle orchestrator | orchestrator chat itself (not a delegation) | not a delegated session; no switch |
| HTTP `POST /api/chats/:id/delegations` with `assignment=implement` (or `requestedRole=fix`) | `implement` / `fix` | yes |
| MCP `delegation_start` with `assignment=implement` (or `requested_role=fix`) | `implement` / `fix` | yes |
| HTTP `assignment=implement` + `requestedRole=plan` (snake-case alias accepted) | `plan` | yes; forced read-only |
| MCP `assignment=implement` + `requested_role=plan` (camel-case alias accepted) | `plan` | yes; forced read-only |
| `delegation_start` assignment=review + `review_subject` plan / code | `review_plan` / `review_code` | yes, via reviewer policy |
| `review_subject=other` | `review_other` | legacy only (documented, no control) |
| `full` workflow, `refine` loop controller-side planning | controller chat, not a delegated planner | explicit boundary: not affected; their review/implement children follow the rows above |
| bare `assignment=plan` alias | folds into a plan review | not planning authoring |

Reviewer session reuse (see `docs/plan-reviewer-cooperation.md`) is governed by
`reviewer_policy.<subject>.session`, independently of reviewer membership.
`fresh` always opens a new chat and ignores even an explicit
`resume_session_of`; `leaf` / `orchestrator` select the chosen model's compatible
session automatically, whether selection is `auto` or `fixed_pair`. A closure
review whose audit session has a different `reviewMode` still falls back to a
new chat (`phase_changed`), and the sticky preference for the audit reviewer
(`codeReviewAuditReviewer`) is computed exactly as before.

Cache keep-alive (see `docs/usage-telemetry.md` §10) is likewise optional, off
by default and not wired into this flow. A keep-alive ping is a bounded, paid
request in a resumed reviewer session; it creates no delegation, attempt,
report, verdict or round, does not advance the workflow counters and does not
change the TODO review state. It never preempts a running review or a user
command, stops when the workflow ends (stop reason or PASS), is cancelled, reset
or hits a provider limit, and its cost is reported as a separate `keep_alive`
row per leaf, not as a review round.

## Klucz i dopasowanie liścia

- Klucz wiersza: `parentChatId` + `leafId` (`leaf_id`/`todo_id`); po przejęciu `parentChatId` tego wiersza wskazuje nowego kontrolera. Historyczny rodzic delegacji pozostaje bez zmian. Stan rund, deadline i idempotencji jest przenoszony w całości. Wiersz chat-wide źródła pozostaje; limity celu łączą się przez najmniejszą dodatnią wartość (zero oznacza brak limitu).
- Atrybucja joba do liścia (kolejność):
  1. pole `leafId` zapisane na rekordzie delegacji (ustawiane przy starcie z
     `leaf_id`/`todo_id` w żądaniu MCP/HTTP albo z linku parent→todo, gdy job
     nie ma innej atrybucji),
  2. jawne `leafId`/`todoId` w żądaniu startu (dla bramki przed utworzeniem
     rekordu),
  3. linia `cretli-ref todo=<id>` w `sourceText`.
- Przy starcie z planu (`sourceKind=plan`) `sourceText` bywa puste — wtedy
  `leaf_id` w żądaniu musi trafić do rekordu, inaczej historia liścia, deadline
  i budżet nie widzą joba.
- **Pusty `leafId` nie dopasowuje niczego.** Wiersz bez liścia to zachowanie
  legacy per-czat: brak inferencji z historii, brak auto-sync. Dzięki temu N
  liści nie sumuje rund w jednym wierszu.

## Runda

- `round` = liczba cykli implement/fix **od ostatniego PASS** dla tego liścia.
- Cykl otwiera terminalny `implement`/`fix`; jeżeli historii brakuje
  implementu, cykl otwiera pierwszy terminalny `review`.
- Równoległe review jednej rundy (fan-out) są grupowane: kolejne review bez
  implementu między nimi nie zwiększają rundy. Przy liczeniu `todo.review` awaria
  infrastruktury bez raportu (np. `failed` bez treści) nie blokuje użytecznego
  PASS zastępczego w tej samej rundzie — szczegóły w `docs/todo-review-contract.md` §4.5.
- `review` z `VERDICT: PASS` zeruje rundę; następny implement/fix startuje nowy
  cykl od 1. Auto-reset działa też na ścieżce historii (`resolve` obniża
  zapisane `round`, gdy ostatnie review to PASS).
- `resolve_delegation_workflow_row`/`inspect` syncują w górę przy nowym cyklu i
  w dół przy PASS. Werdykt jest zapisywany razem z tą zmianą, więc zagregowany
  werdykt fan-outu zapisany przez parenta nie jest nadpisywany, dopóki runda
  się nie zmienia.

## Miękki limit rund i wznowienie

- Przekroczenie `max_rounds` ustawia `stop_reason=rounds_exhausted_soft`
  (miękki stop, nie `workflow_stopped`).
- `resume_rounds: true`:
  - bez `max_rounds` — podnosi `max_rounds` o 1 powyżej `max(max_rounds, round)`
    (dokładnie jeden kolejny cykl),
  - z `max_rounds` — ustawia jawny limit.
- Bramka startu (`workflow_rounds_exhausted`) blokuje tylko wtedy, gdy
  `round >= max_rounds`; po poprawnym wznowieniu liść jest odblokowany.

## Deadline

- `deadline_at` jest budżetem czasu per liść. Po jego przekroczeniu worker
  anuluje **wyłącznie joby przypisane do tego liścia** (`cretli-ref todo=` /
  `leafId`). Wiersz bez liścia obejmuje tylko joby bez atrybucji — nigdy
  wszystkie joby parenta.
- Worker zapisuje fence `deadline_cancel_key = deadline_at`, więc przeterminowany
  wiersz nie jest anulowany ponownie w każdym ticku. Zmiana `deadline_at` zeruje
  fence.
- Start dla przeterminowanego liścia zwraca `workflow_deadline`; parent czeka na
  `slot_occupied=false`.
- Domyślny limit czasu pojedynczego joba (review/fix 20 min, implement 40 min od
  `startedAt`) działa tylko gdy job ma `runDefaultLimitActive` (nowe przebiegi po
  wdrożeniu). Jawny `deadline_at` liścia albo `deadline_at`/`deadlineAt` przy
  `delegation_start` wygrywa z domyślnym dla implement/fix; przy obu jawnych
  źródłach obowiązuje wcześniejszy moment. Dla wierszy review limit
  recenzenta (`CRETLI_REVIEW_REVIEWER_WAIT_MS`) jest górną granicą:
  efektywny termin to `min(jawny, startedAt + limit)`, więc jawny termin może
  go tylko skrócić; `0` wyłącza tę granicę. Po przekroczeniu domyślnego limitu joba:
  `interrupt_code=run_deadline_exceeded` (nie liczy się jako runda review).
  Anulowanie przez `deadline_at` liścia kończy się zwykłym cancel bez tego kodu.
  Slot do `slot_occupied=false`. `delegation_show` / `delegation_list` pokazują
  `interrupt_code`.

## Budżet kosztu/tokenów

- Pola per liść: `budget_tokens`, `budget_cost_usd`.
- Egzekwowanie: start zwraca `workflow_budget_exhausted`, gdy usage ledger
  zmierzył zużycie `>=` skonfigurowanego limitu.
- **Bezpieczeństwo przy braku pomiaru:** brak zdarzeń usage dla liścia
  (`measured=false`) nigdy nie blokuje. Podniesienie lub wyzerowanie budżetu
  wznawia liść.
- Ograniczenie: usage ledger nie ma indeksu per delegacja. Pomiar sumuje
  zdarzenia dopasowane po `delegationId` lub `chatId` jobów liścia w zakresie
  dat od najstarszego joba. Dlatego liczenie odbywa się tylko wtedy, gdy budżet
  jest ustawiony; przy dużym dzienniku może to być kosztowny skan. Gdy harness
  nie raportuje usage, budżet pozostaje nieaktywny (żadnej fałszywej blokady).

## Leaf material base and checkpoints

- Before the first implement/fix on a leaf, the server captures a **leaf base**:
  in worktree mode the base commit is the previous sibling's successful checkpoint
  (or the worktree prepare base for the first leaf); in project mode it is a
  manifest of tracked and untracked paths with content hashes (pre-existing dirty
  files are part of the base, not the leaf delta).
- Implement, fix and review prompts include `[LEAF MATERIAL BASE]` with the base
  commit or partial paths after a failed/interrupted run.
- `material_revision` on `workflow_update` is rewritten server-side from the
  leaf-scoped revision when a base exists. Host verify stores the same scoped
  revision on `verify_result`.
- After code review PASS and the leaf moves to `done`, the server writes a
  checkpoint (worktree commit on the prepared branch, or project manifest on the
  todo). Checkpoint failures are visible in `todo_show` (`leaf_material:` line).

## Kody odpowiedzi bramki startu

| Kod | Znaczenie |
| --- | --- |
| `workflow_deadline` | minął `deadline_at` liścia |
| `workflow_rounds_exhausted` | `round >= max_rounds` |
| `workflow_stopped` | twardy `stop_reason` (np. `same_findings`, `blocked`, `closure_rounds_exhausted`) |
| `closure_rounds_exhausted` | wyczerpany domyślny limit rund closure (1 audyt + 2 closure); `resume_rounds` podnosi stop |
| `reviewer_pool_degraded` | stała para nie uzyskała drugiego różnego recenzenta (dwa PASS-y z tej samej tożsamości); runda nie jest zatwierdzona, `resume_rounds` ponawia po przywróceniu kwalifikowalności |
| `workflow_budget_exhausted` | zmierzony koszt/tokeny osiągnęły budżet liścia |

## Controller key

The workflow row is keyed by `(delegationController(row), leafId)`. Rows without `controllerChatId` use the historical parent, so existing workflows are unchanged. Code-review phase patches write to the controller's workflow.

## Reviewer rotation data (refine loop)

`delegation_list` / `delegation_show` expose `plan_reviewer_session_id`,
`plan_reviewer_phase`, `review_uncertified` (`true|false|null`, stored at the
first start and never rewritten by replays; `review_uncertified_now` on the
start response is the live adapter evaluation) and `leaf_id`, plus compact text
tokens (`session=`, `phase=`, `uncertified=`, `leaf=`, `err=`, `report=`,
`queued=`). The `cretli-todo-refine-loop` skill uses them to rotate reviewers
mechanically (references/round-protocol.md §1).

## Verify runs: de-duplication and visibility

`runReviewVerify` keeps an in-flight map keyed by the resolved execution folder
and the sorted resolved ids. Concurrent calls with the same key (from
`delegation_verify` or the harness runner) await one execution and share its
result and `dataDir`; completed results are not cached, and a dropped client
connection does not cancel the run. `delegation_show` reports `verify_running`
(a run is in flight in the delegation's execution folder) and `verify_recorded`
(the current attempt has a `verify_result`). The bridge client gives
`delegation_verify` a 60 s per-call budget (`BRIDGE_VERIFY_TIMEOUT_MS`); every
other API call keeps 30 s.

UI-started plan refinement includes the limit "do not change the todo status".
The refine skill therefore leaves an `idea` todo in `idea` and explains that
limit in its final report. A refine run whose start message has no such limit
may promote `idea` to `ready` after the required plan reviews and verification
pass.

Verify one delegation at a time. Before a call, note the existing result and
its `dataDir`. On a timeout, first use a fresh result, otherwise wait while
`verify_running` (at most four 20-second waits), otherwise retry the call once.
If the run is still active without fresh evidence after those waits, report
"no confirmation yet". An older result is not evidence for the timed-out call.
Pass pagination `cursor` values only by copying the previous `next_cursor`.

## Review findings ledger

Code reviews also feed a durable, server-side findings ledger keyed by
workspace + leaf (`lib/persist/review-findings-ledger-persist.js`). It is
additive: the workflow row, verdicts, findings hash and `same_findings` are
computed from the prose report exactly as before (the optional
` ```findings-json ` block is stripped first). The ledger cycle closes only on a
resolved PASS round (`onReviewRoundResolved`), independent of
`codeReviewClosureEpoch`. `workflow_update.rejected_findings` records
orchestrator rejections and is included in the patch idempotency fingerprint.
See `docs/review-lessons.md` for keys, outcomes and the
`CRETLI_REVIEW_FINDINGS_BLOCK` flag.

## Review lessons prompt blocks

By default the implementer audience is on (planner and reviewer are opt-in;
`CRETLI_REVIEW_LESSONS=0` disables all, see `docs/review-lessons.md`). When
active lessons match, the executor prompt carries one
extra block after the leaf acceptance criteria: `[KNOWN REVIEW LESSONS]`
(implement/fix, with a `LESSONS CHECKED` report section), `[KNOWN FALSE
POSITIVES]` (audit code review) or `[KNOWN PLANNING LESSONS]` (plan review).
Selection and budget: `docs/review-lessons.md`. The injected lesson ids are
stored on the delegation record as `injectedLessonIds`.

## Compact `delegation_list` and report recovery

`delegation_list` (workspace/all scope) returns a **compact DTO v2** by default
(`structuredContent.dto_version: 2`, `detail: "compact"`). Per-row
`verify_result` keeps the gate evidence (`status`, `exitCode`, `verdict`,
`source`, `recordedAt`, `attemptId`, `materialRevision`, `ids`, `stale`,
`rawOk`, `implementDelegationId`) plus `new_failure_count`,
`preexisting_failure_count`, `flaky_failure_count`, the corresponding
`new_failure_ids` / `preexisting_failure_ids` / `flaky_failure_ids` (first 10,
each capped at 240 characters), `baseline_source` and `detail_available: true`, but never
`outputTail`, per-test `results` or `dataDir`. Rows also carry
`verify_recorded`, `verify_pending`, `report_length` and
`report_full_via: "delegation_show"`; `report_preview` stays a 240-char preview
with `truncated` set, so it never stands in for a full read. Compact `error`
is capped at 240 characters. All other fields
(id, status, role/assignment, model, attempt/run, slot, verdict, pagination
`next_cursor`) are unchanged.

Compatibility: pass `detail: "full"` to get the legacy v1 shape
(`dto_version: 1`, unchanged legacy rows including full `verify_result` and
`error`). `detail` accepts only `compact` or `full`; other values return
`VALIDATION_ERROR`. `delegation_show` is the workspace-scoped detail path:
`getDelegation` checks the delegation's scope chat against the caller's workspace,
without requiring the caller to be its parent chat. It returns the full
`verify_result` and the report. Use the full UUID for another chat's delegation;
prefix resolution searches only the calling chat's delegations. `delegation_tree`, `delegation_list
scope=tree`, `delegation_wait` and `delegation_inbox` are unchanged.

Report recovery: `delegation_show` pages the report in slices of 4000 UTF-16 code units bound
to the report revision (`next_cursor`). Concatenating the structured report strings
reproduces the report exactly, including a trailing `P1` / `VERDICT:` line; a stale cursor
returns `CONFLICT`, never a partial PASS.

`delegation_reply` refusals: Claude and Qwen review callbacks reproduced
`Blocked by local approval policy` with broker mode `local_reads`: the first
guard allowed the report, but the broker adapter classified it as mutating.
The adapter now classifies only the exact builtin Cretli `delegation_reply`
names as a read for assignment `review`. Encoded, bridge, dotted, slash and
`functions.` forms are covered in `tests/can-use-tool-adapter.test.js`, together
with production callbacks, external encoded lookalikes, other mutations and
unchanged non-review decisions. The Scout hard block retains precedence.
This grants no general MCP permission.

Replies remain fenced to the executing attempt/run. A mismatched supplied
`run_id` or unknown `attempt_id` is rejected. A known archived `attempt_id`
with omitted or matching executing `run_id` is accepted (`ok: true`, internally
`mutateCurrent: false`): its mailbox report does not replace the current
attempt's state or report. `tests/delegation-reply-fencing.test.js` covers these
cases and same-key/same-content reply replay; different content returns
`idempotency_conflict`. `tests/delegation-mailbox.test.js` also covers mailbox
delivery and idempotency conflicts.

`tests/delegation-list-compact.test.js` pins the legacy full row shape, identity
and verify fields, workspace/all/tree scopes, detail evidence, stale cursors
and lossless report reconstruction. Its size check compares the entire MCP
response against the legacy envelope for the same 30-row fixture: 54,537 vs
913,632 UTF-8 bytes (94.0% less). Repository consumers of `structuredContent`
were checked: `lib/mcp/mcp-runtime.js` handles it generically; in-process and
remote API clients continue to exchange raw delegation records. Clients that
need the former list row shape can request `detail: "full"`.

## Per-attempt metrics (Claude / Codex) and late fill

Each attempt record carries a nullable `metrics` object (`lib/delegation-metrics.js`).
Besides the seven legacy keys it may carry optional keys that exist **only when
measured** (`null`/absent means "not measured", never zero):
`cache_read_tokens`, `cache_write_tokens`, `reported_usd`, `estimated_usd`,
`billing_mode` (`subscription` | `metered`), `usage_coverage`
(`none` | `partial` | `complete`).

- **Source.** Claude/Codex tokens, cache and cost come from the existing usage
  ledger, scoped to one attempt (`lib/usage/attempt-usage.ts`, built on the TODO
  usage join and `aggregateTodoUsageRows` — no second aggregator, no new store).
  The ledger is deduplicated by logical event key and already turns cumulative
  snapshots into deltas at real run/session boundaries, so retry, same-session
  resume, a new session and replayed events never count twice. Tool calls are the
  distinct finished `tool_call` ids (keyed by run id + call id, since Codex `item_N` ids restart per run; real `sdkEvent` payloads carry no `runId`, so the id is the room's `_runId` remembered on `sdkPromptStarted`, then `currentRun.id`, then empty) seen for the attempt (Claude/Codex emit
  `tool_call`, not `tool_result`, which is why the old counter stayed empty).
- **Cache vs ordinary tokens.** One source per transport, so the two never
  overlap. Claude/Codex take `tokens_in`/`tokens_out` **and** cache from the
  ledger, where `tokens_in` excludes cache reads/writes. For sdk/qwen/opencode/
  deepseek, `tokens_in` comes from the room's last usage payload (for sdk and qwen
  it already includes cache), so ledger cache keys are **not** attached and the
  `final_report` path stores no ledger metrics for those transports (the adapter
  finish is the only writer, so the late merge cannot swap the source).
  A room without a usage payload falls back to ledger tokens together with ledger
  cache.
- **Coverage.** `usage_coverage` is `complete` only when every run the ledger saw
  for the attempt has final-usage proof, `partial` when any run lacks it, and
  `none` (omitted from compact rows) when nothing was measured.
- **Cost keys.** `reported_usd` is provider-reported cost. A rate-table price
  (estimated, or priced without the flag) is `estimated_usd`; `billing_mode:
  metered` therefore always has one of the two.
- **Per-attempt vs TODO usage.** `attempt-usage.js` reuses the TODO join and
  `aggregateTodoUsageRows`, but aligns each event's `runId` with the attempt's
  before joining: a same-session resume or a new session mints new run ids under
  one attempt and belongs to it. TODO usage / `workflow-breakdown` keep the strict
  exact join, so their per-attempt sums can be lower when run ids differ.
- **Timing.** `tokens_out_per_sec` is wall-clock of the attempt (start to finish
  write), so it includes waiting for input and silence after an accepted
  `final_report`. Wait/question/slot/tool durations are intentionally not
  exposed: no real events back them.
- **Cycle cost.** Accepted-cycle cost aggregation already exists:
  `summarizeDelegationCycleCostMetrics` (`lib/delegation-cycle-outcomes.js`)
  reports accepted-cycle cost with priced share, unknown/subscription events,
  truncated window and coverage. Per-attempt metrics feed no second aggregator.
  (Known, out of scope: `sumCycleCohortUsage` adds estimated USD into
  `totalCostUsd` without separating reported from estimated.)
- **Subscription.** Under `billing_mode: subscription` the rate-table estimate is
  dropped: an equivalent price is not an extra charge.
- **Late metrics.** Usage and the adapter finish may arrive after a `final_report`
  (or after cancel/error) was accepted. `applyLateDelegationMetrics` only fills the
  matching attempt's metrics (current or archived): ledger-owned keys take the
  recomputed value, other known keys are never overwritten, replay is a no-op and
  the terminal verdict, ACK and slot ownership are untouched.
- **Retry** resets the live metrics; the archived snapshot keeps the old attempt's.
- **MCP.** `delegation_list` (compact) adds `metrics` with only the measured keys;
  `detail: "full"` keeps the legacy row shape.

## Required-test manifest and generated acceptance evidence

`verifyResult.manifest` and `verifyResult.manifestEvidence` (additive, optional;
legacy rows carry neither) are written by `recordDelegationVerifyResult` for every
host verify record: the auto run, `delegation_verify` and the reviewer runner. When
the caller passes no ids, they are derived from the executed `results[].id` (the
runner already checked each against the catalog), so a manual re-run never drops
the manifest. The manifest binds each id (curated or dynamically audited
`tests/<id>.test.js`) to its file SHA-256, plus `attemptId`, `materialRevision`, an
environment key (node version, platform, arch, `NODE_OPTIONS`, `TZ`, `NODE_ENV`)
and a `testSetKey`. It is evidence, **not** a new `done` gate (`resolveVerifyStatus`
is unchanged), and it changes no plan-scope acceptance rule. There is no second
runner: ids resolve only through the existing dynamic catalog
(`resolveReviewVerifyCatalog`), so unknown ids, traversal and absolute paths yield
no manifest.

- **Usable PASS**: at record time `evaluateVerifyManifestEvidence` classifies the
  result into `manifestEvidence: { usable, reason }`. No manifest, stale, failed,
  or a test outside the manifest is `usable: false` (the record is still shown,
  marked). Preexisting and flaky failures stay listed explicitly.
- **Material changed during a run**: the auto run captures the manifest before the
  run; if the test-set key differs (or the manifest can no longer be built) at
  record time the result is recorded `stale`.
- **Reuse**: `findInheritableImplementVerify` accepts an implement pass for a code
  review only when `decideVerifyReuse` agrees (same revision, re-hashed test-set key,
  current environment key, non-stale pass, covered ids). The accepted evidence is
  rebound to the review attempt with `rebindVerifyEvidence` (source stays
  `inherited_from_implement`). Legacy evidence without a manifest is not reused.
- **Validator**: `node scripts/validate-evidence.mjs <canonical.json> <brief.json>`
  compares hashes/numbers quoted in a brief with the canonical manifest/metrics;
  the canonical artifact wins and mismatches are reported. Generate tables with
  `renderEvidenceTable(canonical)` instead of typing hashes or counts.

**Controlled acceptance of the program.** Compare payload sizes before/after the
compact DTO (leaf 1), check per-attempt metric coverage (leaf 2) and report
completeness diagnostics (leaf 3) using generated numbers from the canonical
artifacts. No percentage of USD savings is promised: cost depends on provider
caching and model mix that these checks do not measure.

**Limitations.** The environment key covers only the listed facts; the manifest
hashes test files, not their transitive imports (the revision binding covers
those); reuse across attempts relies on the leaf material revision being accurate.

## Reply fencing (delegation_reply provenance)

A reused child chat can host several attempts, and the MCP session snapshot is
overwritten on every rebind, so it cannot prove which round a call came from.

- **Sender:** `buildManagedBridgeStdio` signs immutable `attemptId` and
  `delegationId` claims into the managed-bridge integration token at spawn.
  `resolveAuthorizedMcpContext` turns them into `callProvenance`, which
  `delegation_reply` forwards as `callAttemptId` / `callDelegationId`. Tokens
  without claims remain valid.
- **Receiver:** `resolveReplyFence` rejects a call whose proven identity differs
  from the active attempt/delegation (`stale_session_provenance`). Explicit
  `attempt_id` / `run_id` still win (`attempt_mismatch` / `run_mismatch`,
  archived attempts write with `mutateCurrent: false`).
- **Fallback C (fail-closed):** with no explicit ids and no claims (older
  token, or the REST `/api/chats/:id/mailbox/reply` route), a chat that hosted
  more than one attempt across its delegations is rejected with
  `stale_session_provenance`; the caller must pass `attempt_id` and `run_id`.
- **Bridge reuse:** the SDK and Claude adapters include the delegation attempt
  in their bridge/session reuse key, so a new round never inherits a token that
  names the previous one.
