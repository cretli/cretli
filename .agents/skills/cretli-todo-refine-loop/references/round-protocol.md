# Round protocol

Detail for `cretli-todo-refine-loop` — read while running a round.

## 0. Prepare the version session

After normalising/saving the plan, and after every rewrite, call
`reviewer_session({ todo_id: <root id>, cooperation_mode: <mode from prompt, default independent> })`.
Use the returned `session.id` on both review starts with
`plan_reviewer_session_id`, distinct `plan_reviewer_slot` values 0 and 1,
and `plan_reviewer_phase: "independent"`. Never reuse a session id after a
plan change; ask `reviewer_session` again. Repeated calls reuse the current revision without clearing
reports or reopening a closed phase. No plan approval or status change occurs.
If a concurrent plan edit makes a start `stale`, reload the canonical plan and
prepare its session before retrying; do not bypass revision checks or review an
unsaved copy. Preserve the requested cooperation mode across all versions.

Exchange mode: wait until the session phase is `exchange` before starting
delegations with `plan_reviewer_phase: "exchange"`. Collaborative mode:
reviewers may POST peer messages to
`/api/plan-reviewer-sessions/:sessionId/messages` (audit log on the session).

## 1. Reviewer rotation between rounds

Keep one reviewer whose FAIL drove this revision, so it can confirm its own
blockers are gone. Replace a reviewer that PASSed a version another reviewer
validly FAILed: its PASS carried no signal. The rule is mechanical and uses only
persisted records, so it survives a context loss.

**Tokens.** `delegation_list` and `delegation_show` text carry, per delegation:
`status`, `verdict`, `review_subject`, `session=<full id>`, `phase`,
`uncertified=true|false|unknown`, `leaf=<full id>`, `outcome`, `interrupt`
(`-` when none), `err=0|1` (error non-empty), `report=0|1` (report non-empty)
and `queued=<ISO of the current attempt>`.

**Procedure.**

1. Read rows with `delegation_list` text; walk `next_cursor` copied verbatim
   (page max 100). After a `force_new`, also read the earlier coordinators of
   the todo (full ids from `todo_show` structuredContent, or `chat_show` prefix
   to full id) with `delegation_list({ chat_id })` and merge all rows before
   ordering.
2. Keep only rows with `leaf` equal to the todo under review,
   `review_subject=plan` and `phase=independent`. Skip rows with an empty
   session (`session=-`), exchange rows and consult rows.
3. A round is the set of kept rows sharing one `session`. A FAIL is valid when
   `verdict=FAIL`, `report=1`, `err=0` and `interrupt` is `-`. Interrupted rows
   and infrastructure failures are never a valid FAIL and never a PASS.
4. A round's time is the minimum `queued` of its rows (a retried old row does
   not move its round). A round is finished when no row has an active status
   (`queued`, `starting`, `running`, `waiting_for_input`, `cancelling`);
   `completed`, `failed`, `cancelled` and `interrupted` are terminal. The
   latest finished round has the greatest time, ties broken by the greater
   `session` string.
5. Before round N+1 build `exclude_models` for `model_pick` from the latest
   finished round only: every base model (strip `::effort=`) that PASSed in a
   round in which a different reviewer validly FAILed, plus rows with
   `uncertified=true` when a certified pick exists. `uncertified=unknown` is not
   excluded. Keep one reviewer whose FAIL drove the rewrite.
6. If `model_pick` returns no candidate, drop exclusions one at a time
   (`uncertified=true` rows first, then ascending round time, then ascending
   session) until a pick exists, and report the relaxation as a deviation
   (model_pick's own soft exclusion of the last reviewer may overlap; report it
   once). A higher effort of the same base model is not a replacement.

**Worked example.** Round S2 (`session=s2`, `queued=2026-01-02T10:00Z`):

```
completed  d1  claude/opus     verdict=PASS session=s2 phase=independent leaf=T err=0 report=1 interrupt=-
completed  d2  codex/gpt       verdict=FAIL session=s2 phase=independent leaf=T err=0 report=1 interrupt=-
```

The round is finished and d2's FAIL is valid, so Opus is excluded for round 3
and the GPT reviewer is kept. An `interrupted` row or `err=1` FAIL would not
count as valid; a row with `starting`, `waiting_for_input` or `cancelling`
makes the round unfinished.

Nothing else is written to the plan or to workflow state. The final PASS round
goes in the final report, never in the plan text.

**Extra round on an unchanged plan version.** A closed session cannot be
reopened by calling `reviewer_session` again. A replacement reviewer inside a
still-open session reuses the session. An additional round after a closed one
(for example a failed verify) requires a plan save: add a line under "Changes
since version N" stating the reason, which changes the revision key, so
`reviewer_session` opens a new session; then start both reviewers in it.
Earlier reviews become stale by design. This is the only plan write the
rotation procedure allows.

## 2. Shared `task_text` for both reviewers

```
Independent review of a PLAN (not code): todo <root id> "<title>", version <N>.
Read-only: do not edit files, change any todo, or commit.

Load the plan with todo_show(todo_id, field=plan) and follow every next_cursor.
Load the root's children with todo_show and read each leaf body.

Check:
1. Every stage has measurable, testable acceptance criteria.
2. Every code and doc reference (path, line range, section number) exists and
   says what the plan claims.
3. The plan agrees with the contracts it touches (<docs/...>, sections <...>).
4. The todo tree matches the plan: which leaves exist, their order and status,
   and whether each leaf body describes the same work as its stage.
5. Blockers named in the previous round are resolved: <one line each>.
6. The plan does not approve itself and does not start any leaf.
7. Task decomposition is proportionate: identify missing boundaries that make
   execution impractical, and unnecessary leaves whose extra research, agent
   starts, reviews and integration outweigh their benefit. Research, tests and
   docs for one outcome normally belong in its implementation leaf. Check the
   split/no-split rationale, leaf scopes, acceptance criteria and dependencies.

Report only real blockers, each with a plan section and a file:line. List
non-blocking notes separately. Do not judge style. At most 400 words.
Write in <user's language>. End with exactly:
TASK: review
VERDICT: PASS|FAIL|BLOCKED
```

Point 5 is empty in the first round. Fill in the concrete contract paths; a
reviewer told only "check the contracts" checks nothing.

## 3. Wait, read, verify, ack

- Loop `delegation_wait({ ids, until: "all", timeout_ms: 25000 })` until both
  are terminal and `slot_occupied` is false.
- Read each full report with `delegation_show`, following `next_cursor`. The
  `VERDICT` line is at the end and inbox previews drop it.
- If a PASS attempt is `verify_required` (the `todo_show` review block shows
  `usable: false` / `verifyStatus: required-missing`), call `delegation_verify`
  on it straight away. A PASS with missing verify does not count, and the plan
  review stays `failed` on the server however the reports read.
- `delegation_ack` each report. After a FAIL that the next round confirms, rate
  the review per the multi-harness rubric (score 5, `caught_bug`).

## 4. Rewrite the plan

- Verify every path, line range and section number you write. A reference
  copied from a reviewer report is unverified until you have opened it.
- Check a proposed fix against the contract before writing it. A fix that only
  moves the conflict to another section costs a full round.
- When a stage cannot be made consistent without a contract change, move it out
  rather than bend it: create a separate `idea` todo, and record it under "Out
  of scope" in the plan with the new todo id. This is the default resolution;
  it is reversible and needs no approval.
- Keep the tree and the plan in step in the same round: rewrite the leaf bodies
  whose stage changed, re-parent removed stages, and update the plan's own tree
  section. A plan that describes the tree as it was one round ago fails the
  next review.
- `todo_show` immediately before every `todo_update` and use that
  `expected_updated_at`. The review sync writes to the root after each report,
  so a timestamp from before the round is stale. On `CONFLICT`, re-read, confirm
  the plan text is still yours, and retry once.

## 5. Open questions

A design question that the findings raise but do not answer (which of two
variants, where a limit sits, whether a stage is worth keeping) does not stop
the loop. Settle it in this order:

1. **Decide yourself** when the code or a contract answers it. Open the source
   first.
2. **Ask other models.** Start two consult children from a fresh
   `model_pick({ role: "review", count: 2, diverse: true })`, with
   `assignment: "review"` and `review_subject: "other"` so the answer never
   counts as a plan review. Give both the same `task_text`: the question, the
   options with their trade-offs, the plan sections and files involved, and the
   instruction to answer with one option and the evidence for it, read-only.
   Do not state your own preference; it biases the answer. When both agree and
   you have checked their evidence, apply the answer and record the question,
   the answer and the delegation ids in the plan's "Changes" section.
3. **Ask the human** when the models disagree, when their evidence does not hold
   up, or when the question is one of these, which no model consensus settles:
   changing a contract, dropping a stage for good, trading away an invariant,
   or anything that would approve the plan.

Batch the questions of one round into a single consult. Consults do not count
towards the round cap, but run at most two per loop; more than that means the
plan's scope is unclear and the human should see it.
