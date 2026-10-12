---
name: cretli-todo-refine-loop
description: Review-and-refine loop for a Cretli todo plan. Two independent reviewers audit the plan, the parent rewrites it from their findings and re-reviews, round after round, until every reviewer PASSes or a stop rule fires. Use when asked to verify, review or polish a todo or its plan in a loop before a human approves it. Plans only; code changes go through cretli-multi-harness.
---

# Cretli todo refine loop

The parent (this chat) owns the plan text. Review children are read-only and
return a report. One invocation runs the whole loop: do **not** ask "shall I run
the next round?" after each review. Stop only on the rules in
[Stop and ask](#stop-and-ask).

This skill builds on `cretli-multi-harness` (`fanout-review` mode). Its rules for
`model_pick`, start errors, `delegation_wait`, infra retries, `delegation_ack`
and `delegation_rate` apply here unchanged; read that skill for the details.

## Scope

- Subject is a **plan** (or a todo body used as one). Every review start passes
  `review_subject: "plan"`.
- The loop ends at "ready for human approval". It never sets `plan.approvedAt`,
  never starts a leaf, never implements, never commits or pushes.
- A plan PASS is not a code review and never closes an implementation leaf.

## Round 0: load and normalise

1. `todo_show` the root (body, then `field: "plan"`, following every
   `next_cursor`) and every descendant (`children_cursor`, then recurse).
2. If the root has no plan, write the body out as plan **v1** with
   `todo_update({ patch: { plan: { markdown } } })` before the first review.
   Reviewers then load one canonical text instead of a copy pasted into the
   task.
3. Head the plan with `Version N` and, from v2 on, a short
   "Changes since version N-1" section naming the findings it answers.

## One round

### 1. Pick two reviewers

`model_pick({ role: "review", count: 2, diverse: true, exclude_models? })`.
Forward the returned `pickId` as `pick_id` on both starts. A tier 4+ pick needs a
`pick_reason`.

Rotation between rounds:

- Keep one reviewer whose FAIL drove this revision, so it can confirm its own
  blockers are gone.
- Replace a reviewer that PASSed a version another reviewer validly FAILed. Its
  PASS carried no signal; a second PASS from it adds none.
- Exclude a reviewer the server marks `review_uncertified`. If one runs anyway,
  report its verdict with that caveat.

### 2. Start both reviews

`delegation_start` with `assignment: "review"`, `review_subject: "plan"`,
`leaf_id: <root id>`, and a distinct `idempotency_key` per reviewer and version
(`refine-<root8>-v<N>-<model-slug>`). Both reviewers get the same `task_text`:

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

Report only real blockers, each with a plan section and a file:line. List
non-blocking notes separately. Do not judge style. At most 400 words.
Write in <user's language>. End with exactly:
TASK: review
VERDICT: PASS|FAIL|BLOCKED
```

Point 5 is empty in the first round. Fill in the concrete contract paths; a
reviewer told only "check the contracts" checks nothing.

### 3. Wait, read, verify, ack

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

### 4. Judge the findings

Aggregate conservatively: BLOCKED, then FAIL, then conflict; PASS only when
every reviewer PASSes the same version.

For each blocker, open the file or contract section it cites before acting on
it. Then either fix the plan or, if the finding is wrong, keep the plan and say
why in the next round's "Changes" section so the next reviewer can check the
argument. Fold in non-blocking notes when they are cheap.

### 5. Rewrite the plan

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

Then start the next round.

## Open questions

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

## Stop and ask

End the loop and report when one of these holds:

- **Ready:** every reviewer PASSed the current version and every required verify
  passed. Confirm with `todo_show` that the plan review block agrees.
- **Round cap:** 5 rounds without a clean round. Say which findings keep
  recurring.
- **Same findings:** a reviewer repeats a blocker on a version that changed that
  section, and you have checked that the blocker is wrong. Report the
  disagreement instead of rewriting again.
- **Human decision:** a question that [Open questions](#open-questions) reserves
  for the human, or one the consulted models could not settle. State the
  options, what each model answered, and your recommendation.
- **Verify fails:** `delegation_verify` fails on a PASS attempt. Retry once; a
  second failure is deterministic. Replace that reviewer with a fresh pick for
  one extra round, and report the failing verify with its exit code.
- **Blocked:** no eligible reviewer, a reviewer returns BLOCKED, or a slot stays
  occupied after a cancel.

## Final report

Write it for a reader who saw none of the rounds:

- Plan version and state: ready for approval, or the stop rule that fired.
- Per round, one line: version, reviewers, verdicts.
- What changed in the tree: todos moved out, created or rewritten, with ids.
- Questions settled by consulting models: the question, the answer, who gave it.
- Open decisions for the human, each with a recommendation.
- Non-blocking notes left unaddressed.
- That nothing was approved, started, committed or pushed.
