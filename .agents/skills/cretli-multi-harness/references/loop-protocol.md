# Loop protocol

Detail for `cretli-multi-harness` — read when starting, waiting on or closing a
child.

## Start a child

`delegation_start` requires `harness`, `model`, `idempotency_key`, and
**exactly one** source (the server already validates this; send one, not two):

- `plan_revision`, **or**
- `history_seq` **and** `content_hash`, **or**
- `task_text`

Idempotency key: stable per role and source, unique per round, for example
`mh-<role>-<short-source>-r<n>`. Replays with the same key and same params
return the existing job. An infra retry **must** use a new key (same key
returns the failed/cancelled job).

Set `assignment` to `review` or `implement` (plan/fix are mapped). On **every**
review start pass `review_subject` explicitly: `code` for a code review, `plan`
for a plan review. The server default is a safety net for ad-hoc starts, not the
normal path; a job with no subject reads as `other` and never makes `code` or
`plan` `passed`. In `loop`
or `fanout-review`, persist loop state with `workflow_update` (role,
round, last implementer, last reviewer, findings, deadline, `material_revision`,
and `idempotency_key` unique per review event) so a parent restart does not
reset the round cap. `role` is this step (`plan|implement|review|fix`); `round`
is the 1-based number of the current implement/fix cycle — start at 1 for a fresh
leaf and increment before every new implement or fix; a review PASS resets it.
Skip workflow tools in `named` mode.
Replaying any previously applied key with the same parameters is a no-op; the
same key with different parameters is `CONFLICT`.

`material_revision` is a code/artifact id, not findings text. Prefer
`readDelegationMaterialRevision(cwd)` (short `HEAD` plus dirty `status`
fingerprint). Snapshot it before review and after implement/fix.

After **every** report, persist the outcome before picking the next role: call
`workflow_update` with `last_verdict` (or `fanout_verdicts` for a
fanout), `report_text`, and the fresh `material_revision` from
`readDelegationMaterialRevision(cwd)`, under a stable per-review
`idempotency_key`. A parent restart must not lose the last verdict or the
artifact revision that verdict reviewed.

## Review status on the todo

The server writes `todo.review` from delegation records; you cannot set it
(`todo_update`/`todo_create` reject `review`). Before closing a leaf, call
`todo_show` and confirm `review.code` is `passed` (or `manual`, which only a human
UI accept produces) and not `stale`/`unknown`/`pending`. A `plan` review is not a
code review and never makes `code` `passed`. An agent `delegation_ack` with
`reason=accepted` does not yield `manual`. The badge is not a content guarantee:
see `docs/todo-review-contract.md` §17.

## Wait

After N `delegation_start` calls (each with a **different** `idempotency_key`),
loop `delegation_wait({ ids, until: "all" })` while `status=pending`. Do not
busy-poll `delegation_show`. Default `timeout_ms` is 20000, max 25000 (below
the ~30s bridge HTTP timeout). Call again on `pending`. `until=any` returns
when the first listed job is terminal **and** `slot_occupied` is false.

A job is not free while `run_stopping=true` or `slot_occupied=true`, even if
`status=completed`. Do not start the next **implement** / **fix** until every
watched implement job has `slot_occupied` false. There is no `finished`
status.

After you read each terminal report (via `delegation_show` / `delegation_inbox`),
call `delegation_ack({ delegation_id })` from the parent chat so `unverified`
clears and `acknowledgedAt` / `acknowledgedReason` are set; use
`reason: "accepted"` only when you explicitly accept the cycle by hand
(`reviewed` is the default). Otherwise every finished job keeps
`unverified: true`.

`delegation_wait` returns per-id `status`, `slot_occupied`, `run_stopping`,
`task_outcome`, `interrupt_code`, `verdict`, and a short summary — not the
report body. Page `delegation_show` / `delegation_inbox` for content. Follow
`truncated=true next_cursor=…` until the cursor is empty. List **text** uses
the full UUID (do not invent prefix lookup).

`delegation_inbox` list rows are 240-character previews and often omit the
ending `VERDICT`. Pass `id` and follow `next_cursor`, or page `delegation_show`.
Cross-workspace jobs need `scope=all` on `delegation_list` / `delegation_inbox`
(same idea as `chat_show`).

Missing `VERDICT` is `unspecified`. Two different VERDICT lines in one report
are `conflict`. Treat unspecified/conflict as not PASS. With fanout 2,
aggregate conservatively: BLOCKED wins, then FAIL, then conflict; PASS only if
every review is PASS.

With fanout 1, do not start the next child first. With fanout 2, a second
**review** may run in parallel; stop one job at a time (no cancel-all). Extra
reviews beyond the cap wait until a slot frees. Default width is two review
children (`CRETLI_DELEGATION_REVIEW_FANOUT` unset/`2`). `=1` keeps a single
review slot. When the flag is `2`, two concurrent **review** jobs are allowed;
a third review is `review_fanout_full`. Queue extra reviews yourself — the
server does not enqueue them. Mixed review+implement stays exclusive. This is
not an executor pool.

## Verdict → next step

- **PASS** on plan → implement. **PASS** on implement → run parent
  `delegation_verify` on that job, then review when verify passes. **PASS** on
  review in `loop` → stop (success). **PASS** on fix → `delegation_verify`, then
  review again. Do not start review while verify for the latest implement/fix is
  still failed for the same material (`verify_failed_before_review`).
- **FAIL** or **conflict** on review → fix (if rounds remain), then review with
  `exclude_model` = last implementer/fixer, then the last reviewer.
  Opt-in reviewer pool: when Settings → Delegations has `reviewer_pair_enabled`
  with two `reviewer_pair_members`, pass them to `model_pick` as `prefer_models`
  with `count=2` and start one fresh review per pick (no `resume_session_of`);
  any FAIL fails the round, both must PASS, the round counts once toward the
  closure cap (applied when the round resolves), and the implementer exclude
  still wins (`rotation.pool.degraded=true` → `picks[1]` is the replacement). Off or
  incomplete = this loop unchanged.
- After a child **PASS** on implement/fix, independently reproduce 1–2 claims
  (test or minimal repo). Child PASS without that evidence is `unspecified`.
  If the reviewer's `traits.review_can_run_tests` is `false` (no native shell or
  a read-only hook), `model_pick` returns `review_requires_verify: true` and the
  job is persisted with `verify_required: true`; the **parent MUST** call
  `delegation_verify` for that job. The server gate is hard: a PASS review with
  `verify_required` and no passed verify never counts as accepted, so the leaf
  does not close on the child's word alone. Read the stored `verify_result`
  (now with `verdict` and `exitCode`) from `delegation_show` separately from
  `VERDICT`; a failed
  review-verify is a hard failure even when the child says PASS. Findings are
  defects to fix, not a map for further exploration.
- **`waiting_for_input`** (OpenCode question/permission or SDK Ask on
  implement/fix): keep polling `delegation_wait`; do not infra-retry or free
  the fanout slot until the user approves in the child chat or the job reaches
  a terminal status.
- **Infra** (`failed`/`cancelled` with empty report, `code=adapter_timeout`,
  `adapter_incomplete`, `adapter_no_verdict` (report without VERDICT even after the server follow-up; no answer, never a FAIL), first-event timeout, ChatGPT/Codex **usage limit**,
  harness quota, one-line thinking dump): wait until `slot_occupied` is false,
  then `model_pick` with `exclude_model` = the failed id. Review never picks
  `*flash*` ids. Use `exclude_harness` **only** with concrete evidence that the
  harness itself is unavailable, rate-limited, or over quota (a usage-limit
  error, `adapter not ready`, provider outage); otherwise exclude just that
  model with `exclude_model` and keep the harness. Start the next candidate
  with a **new** idempotency key (replay returns the failed job). Never retry
  the same model/harness after an infra failure. If no different candidate
  exists, stop as `BLOCKED` and include the provider/quota reason; do not burn
  three retries on a dead sub-chat. Example: child `1502cdb2` on `codex` /
  `gpt-6-astra` hit a usage limit — fall back to Composer on `sdk` and, because
  the quota evidence is concrete, use `exclude_harness=codex`. Cap 1 infra
  retry per role. Do not stop sibling fanout reviews. Do not infra-retry
  `VERDICT: FAIL`/`BLOCKED`.
- **BLOCKED**, unspecified after a full report read **and** infra retry, or
  loop **timeout** → stop. Do not start another child in `loop` mode.
- **`interrupted`**: only a job with `interrupt_code=server_restart` may be
  continued, and at most **once** per record. Continue it with a new
  idempotency key, then never continue that record again. `starting_timeout`,
  `running_orphan`, any other `interrupt_code`, and legacy interrupted rows
  with an empty code are stop-only — report the code to the user and do not
  retry the record.

## Rate the job (`delegation_rate`)

After you read a report, rate the finished job as its parent:

```
delegation_rate({ delegation_id, score, tags?, note? })
```

`score` is an integer **1–5** (5 = best). `tags` are optional telemetry only —
allow-list `missed_bug`, `false_positive`, `scope_creep`, `too_slow`, `great`,
`caught_bug` (max 5, de-duplicated); they never move the speed/cost axes. `note`
is an optional short line (max 500 chars).

Tag rubric (the server rejects a contradictory payload with
`contradictory_rating`):

- a critical tag (`missed_bug`, `false_positive`, `scope_creep`, `too_slow`)
  is accepted only at score **1–3**;
- `great` is accepted only at score **4–5**;
- a review whose **FAIL was real** (the cycle proved it: FAIL → fix → PASS) is
  score **5** with `caught_bug` — **never** `missed_bug` at 5;
- ratings are autonomous: no human rates, so your ratings feed model ranking;
  the anti-bias rule below stops you from inflating your own base model.

Rules (the server enforces them; do not work around them):

- **Terminal jobs only** — rating a running job is `CONFLICT`.
- **Parent only** — the calling session must be the job parent; a child chat is
  rejected, and you cannot rate someone else's job (`OUT_OF_SCOPE`).
- **Anti-bias** — a parent cannot rate a job on its own base model
  (`self_model_rating_denied`); rate a job run by another model.
- **Immutable** — one rating per (job, rater). An identical replay succeeds
  (`replayed: true`), a changed payload is `CONFLICT`. There is no edit or
  delete; a mistake stays on record.
- The card shows your rating read-only; there is no manual rating UI.

**Required** — rate **every** terminal job you read, as soon as you have
judged its report (no human does this; ratings drive `model_pick`):

1. after a review cycle **FAIL → fix → PASS**: rate the review job that issued
   the FAIL **score 5 + `caught_bug`**;
2. when you **reject a report** (`conflict`, empty/thinking-dump body, a report
   you discard): rate it down and tag why (typically `missed_bug` /
   `false_positive`);
3. otherwise: rate by usefulness (PASS review, accepted implement/fix, a job
   that failed on infra and forced a re-route).

`delegation_rate` rows update `rating_avg_scored` / `rating_n_scored` and blend
into `model_pick` observed quality.

## Caps and tie-break

Store round/findings on `workflow_update` with a stable
`idempotency_key` per review event (for example `mh-workflow-r<n>-review`).
The server keeps every applied key→fingerprint, not only the last patch.
Replaying any previously applied key with the same parameters is a no-op (the
current state is unchanged). The same key with different parameters is
`CONFLICT`, including after later updates or reload. Distinct reviews increment
`consecutiveSameFail`. Default `max_rounds` is 4. Pass `material_revision` when
code or artifacts change (findings text is not a material revision). A second
identical FAIL (`findings_hash` unchanged **and** `material_revision` unchanged
**since the last FAIL review**) sets `stop_reason=same_findings`. Example
deadline (ISO-8601): `deadline_at: "2026-09-20T22:00:00.000Z"` — the worker
requests cancel and the parent waits for `slot_occupied=false`. Do not burn
remaining rounds after the same-findings stop.

## Handoff (parent model switch)

If this chat is handed to another harness, put these 10 lines in the first
parent message: mode, round, last implementer, last reviewer, material
revision, open findings (one line), whether a fix is in flight, full job
UUIDs, stop reason, next role. Do not start a second implement/fix.

## After the loop

Report files, tests, leftover gaps. In `fanout-review`, optionally
`todo_create` a synthesis plan when the user will implement later. The parent
still does not commit or push. A loop is not closed until finished reports are
acknowledged (`delegation_ack`) and, where the rubric requires it, rated
(`delegation_rate`); read the per-leaf loop read-model via `workflow_show`
(returns `loop` — rounds, models per role, verdicts, verify, stop reason,
wall/cost per leaf).
