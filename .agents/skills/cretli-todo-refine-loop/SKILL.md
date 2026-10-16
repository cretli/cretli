---
name: cretli-todo-refine-loop
description: Review-and-refine a Cretli todo plan — two independent plan reviewers, parent rewrites, repeat until PASS or a stop rule. Plans only; code changes go through cretli-multi-harness.
---

# Cretli todo refine loop

The parent (this chat) owns the plan text. Review children are read-only and
return a report. One invocation runs the whole loop: do **not** ask "shall I run
the next round?" after each review. Stop only on the rules in
[Stop and ask](#stop-and-ask).

This skill builds on `cretli-multi-harness` (`fanout-review` mode). Do **not**
read that skill in full; read only the two sections this loop needs:

- `../cretli-multi-harness/references/loop-protocol.md` — wait, verdict → next
  step, `delegation_ack`, `delegation_rate`;
- `../cretli-multi-harness/references/model-picking.md` — `model_pick`,
  start errors and the infra-retry rule.

## Invariants

- Subject is a **plan** (or a todo body used as one). Every review start passes
  `review_subject: "plan"`.
- The loop ends at "ready for human approval". It never sets `plan.approvedAt`,
  never starts a leaf, never implements, never commits or pushes.
- A plan PASS is not a code review and never closes an implementation leaf.
- `todo.review` is server-owned: never write it with `todo_update`.

## Round 0: load and normalise

0. Treat notes from earlier chats (a session being "closed", a provider being
   "exhausted", a round cap being "reached") as stale hints, never as facts.
   The prompt carries the cooperation mode, not a session id: prepare the
   session as described below. Only a rejected `delegation_start`
   (`phase_closed`, `stale`) shows a session is unusable. Pick reviewers fresh and let `model_pick` skip models under
   lockout.

1. `todo_show` the root (body, then `field: "plan"`, following every
   `next_cursor`) and every descendant (`children_cursor`, then recurse).
2. If the root has no plan, write the body out as plan **v1** with
   `todo_update({ patch: { plan: { markdown } } })` before the first review.
   Reviewers then load one canonical text instead of a copy pasted into the
   task.
3. Head the plan with `Version N` and, from v2 on, a short
   "Changes since version N-1" section naming the findings it answers.
4. Assess task decomposition with `references/decomposition.md` before the first
   review. Save any justified tree changes and the matching plan together so
   both reviewers audit the same proposed execution structure.

## One round

1. **Prepare the version session** — after normalising/saving the plan, and
   after every rewrite, call `reviewer_session({ todo_id: <root id>,
   cooperation_mode: <mode from prompt, default independent> })` and use the
   returned `session.id` on both starts (`plan_reviewer_session_id`,
   `plan_reviewer_slot` 0 and 1, `plan_reviewer_phase: "independent"`). Details:
   `references/round-protocol.md`.
2. **Pick two reviewers** — apply the mechanical rotation rule of
   `references/round-protocol.md` §1 to build `exclude_models`, then
   `model_pick({ role: "review", count: 2, diverse:
   true, exclude_models? })`; forward the returned `pickId` as `pick_id` on both
   starts. A tier 4+ pick needs a `pick_reason`. Rotation rules:
   `references/round-protocol.md`.
   If the pick fails with `cost_ceiling`: Report it and ask the human to re-run explicitly with `premium: true` (or a named premium model); never silently escalate to an expensive model.
3. **Start both reviews** — `delegation_start` with `assignment: "review"`,
   `review_subject: "plan"`, `leaf_id: <root id>`, a distinct
   `idempotency_key` per reviewer and version, and the shared `task_text`
   template from `references/round-protocol.md`.
4. **Wait, read, verify, ack** — `delegation_wait` until both are terminal and
   `slot_occupied` is false, page `delegation_show` for the full report, call
   `delegation_verify` on a PASS attempt with `verify_required`, then
   `delegation_ack` each report. Run `delegation_verify` for one delegation at
   a time; on a timeout follow the recovery order in
   `references/round-protocol.md`. Pass `cursor` only with a value copied
   verbatim from the previous response's `next_cursor`; never invent one.
5. **Judge the findings** — aggregate conservatively (BLOCKED, then FAIL, then
   conflict; PASS only when every reviewer PASSes the same version). Open the
   file or contract section a blocker cites before acting on it.
6. **Rewrite the plan** — verify every path, line range and section number you
   write, and re-read `todo_show` immediately before each `todo_update` for a
   fresh `expected_updated_at`. Then start the next round.

## Open questions

Settle a design question the findings raise but do not answer in this order:
**decide yourself** when the code or a contract answers it (open the source
first) → **ask other models** (two consult children, `review_subject: "other"`,
batched into one consult, at most two per loop) → **ask the human** when the
models disagree, their evidence does not hold up, or the question changes a
contract, drops a stage for good, trades away an invariant, or would approve
the plan. Full procedure: `references/round-protocol.md`.

## Stop and ask

End the loop and report when one of these holds:

- **Ready:** every reviewer PASSed the current version and every required verify
  passed. Confirm with `todo_show` that `review.plan.state` is `passed` for
  the saved current plan. If the badge disagrees, report the mismatch; never
  write `review` or hide it with another plan edit. Once confirmed, promote
  the root from `idea` to `ready` with `todo_update` and a fresh
  `expected_updated_at` only when the start message contains no limit such as
  "do not change the todo status"; when it does, leave the status and state in
  the final report that it was left because of that limit. Preserve other
  statuses and leave child statuses unchanged. `ready` means
  ready for human approval; it does not set `plan.approvedAt` or start work.
- **Round cap:** 5 rounds without a clean round, counted only over rounds this
  invocation ran. Plan versions, changelog entries and earlier chats are history,
  not a counter: a fresh invocation always starts at round 0 and must run at
  least one review round before this rule can fire. A review that failed on
  infrastructure (provider limit, 429, adapter failure) is not a round. Say
  which findings keep recurring.
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
- What changed in the tree: todos moved out, created or rewritten, with ids,
  and why the chosen split (or keeping one leaf) is worth its execution cost.
- Questions settled by consulting models: the question, the answer, who gave it.
- Open decisions for the human, each with a recommendation.
- Non-blocking notes left unaddressed.
- The root status: promoted to `ready`, or left as is because of the start message's status limit.
- That nothing was approved, started, committed or pushed.
