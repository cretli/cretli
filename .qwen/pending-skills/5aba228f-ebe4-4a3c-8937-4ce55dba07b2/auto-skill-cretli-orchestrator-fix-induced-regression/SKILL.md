---
name: cretli-orchestrator-fix-induced-regression
description: As the Cretli multi-harness parent, a fix round routinely creates new blockers — aggregate review fanout verdicts conservatively, force reviewers to hunt fix-induced regressions, verify a new gate is actually reachable before crediting a fix, bundle findings to stretch max_rounds, and judge latent-vs-live before spending a round.
source: auto-skill
extracted_at: '2026-10-07T18:21:41.580Z'
---

# Fix-induced regressions in a Cretli delegated loop

Trigger: you are the parent/orchestrator of a `cretli-multi-harness` loop and a review round came
back FAIL on a finding you already "fixed". Observed on R6 (todo 3304322f, cycle 291a8808,
2026-10-07): **three consecutive rounds, where two of the blockers were created by the fix for the
previous blocker.** Round-1 B1/B2 → fix → the B2 fix created N1+N2 → fix → the fix left F1 open →
final round. Default is `max_rounds=4`, so naive one-finding-per-round spends the whole budget.

Companions: **cretli-orchestrator-failed-child-partial-landing** (crashed child, CONFLICT-not-infra),
**cretli-legacy-guards-new-answer** (consumer guards of a producer you made richer),
**cretli-delegation-review** / **cretli-delegation-implement** (child-side mechanics),
**cretli-multi-harness** (loop contract, ratings, fanout caps).

## 1. Every post-fix review brief must ask "what NEW defect did the fix introduce"

A reviewer asked only "is it fixed?" returns PASS. Ask both questions and you get the real outcome.
Verbatim from the R6 re-review brief: *"VERIFY THE FIXES, and specifically whether the fixes
introduced anything new"*, plus per-defect **audit points (a)(b)(c)(d)** rather than a narrative.

That phrasing is what produced the two regressions:
- **N1**: the fix emitted a new enum token (`'no_live_run_match'`) while the frozen vocabulary in
  `RUN_TRANSCRIPT_LOSS_REASONS` still listed four, so the contract's own `normalizeRunTranscriptLossReason()`
  silently returned `''`. The closed-vocabulary test stayed **green because it deep-equals the LIST and
  never inspects the producer's output.**
- **N2**: the fix gated the whole behavior behind a brand-new input flag — and no production caller
  ever passed it.

So in every post-fix brief, demand explicitly:
1. **Producer-output tests, not list-comparison tests.** For any enum/token a leaf may emit: assert
   `normalizeEmitted(value) === value` for *every value the producer can emit*, enumerated at runtime
   from the source table — never a hardcoded list that can drift again.
2. **Default-direction check.** A fix that gates behavior on a NEW input must be reachable by the
   real registrations. Grep it yourself before crediting the fix (step 3).
3. **Cross-surface agreement.** If the leaf exposes the same fact twice (capabilities surface vs
   per-run lookup), require the brief to assert they are equal for every transport and every flag
   combination, and forbid "two independent literals describing one fact".

## 2. Aggregate fanout verdicts CONSERVATIVELY — and distrust the agreeable PASS

`PASS` only if **every** review PASSes: `BLOCKED > FAIL > conflict > PASS`. On R6 the fanout was
`PASS` (sdk/grok-4.7) + `FAIL` (codex/gpt-6-astra) → the leaf is **FAIL**.

- The PASS reviewer had approved material containing two real blockers and listed the very call
  sites in its own consumer audit while judging them correct → rate it `missed_bug`, low score
  (required case 2: you rejected its report). The FAIL reviewer that produced two confirmed
  blockers → 5/5. Ratings feed `model_pick` quality, so this is how the loop gets smarter.
- **Do not treat "one reviewer already PASSed" as progress.** It is the *disagreeing* reviewer that
  carries signal; weight a fresh reviewer's dissent over a friendly consensus.
- Pair the fanout for dissent, not redundancy: a harness that can run tests (`tests=yes`) and a
  different provider. Note `verify=required` candidates (traits `review_can_run_tests:false`) mean
  the parent MUST call `delegation_verify` — a PASS without a passed verify never closes the leaf.

## 3. Verify the child's fix in the CODE before spending another round (the dead-gate check)

Never accept "blocker fixed" on the child's word. When a fix gates behavior behind a new input,
grep for a production caller that supplies it — on R6 this one command exposed the whole defect:

```
grep -rn "reattachCapability" --include=*.js lib tests
```

It appeared **only** inside the adapter and the tests; all five `registerKernelChatRunAdapter` sites
and opencode's direct `createDurableRequestLookup` omitted it, so `effectiveReattach` was always
false in production — the fix's live-reattach path was dead and a healthy run would be reported as
having lost its transcript. Also read the diff hunks of the *invariant claim* (a comment saying
"narrows the SAME way as X") and compare the two expressions character by character; that false
comment was the final blocker F1.

Do the same for vocabulary/doc/revision drift: `grep` the docs and the frozen list for the old
count ("four tokens", "only `room_missing`") after a token is added.

## 4. Latent vs live decides the cost of the round — say it honestly

A defect reachable **only** through an API your own leaf just added is still blocking for a
*contract* leaf (the contract must be internally honest), even when no production path hits it
today. Prove reachability instead of guessing:

- trace whether a **production writer/caller** exists for the shape (`beginRunLaunch` /
  `recordExecutorAck` had zero non-test callers → the mailbox conjunct was LATENT, recorded for
  R8/R10/R12, not a blocker);
- in the brief and the report, label it "pre-existing line, newly reachable" or "latent: no
  production caller sets `canResumeSession:false` today". Never inflate a latent defect into a live
  outage, and never downgrade a contract-honesty defect to a style note.

This distinction is what let R6 spend its last round on F1 alone instead of re-litigating B1/B2/N1.

## 5. Bundle ALL open findings into one fix brief to stretch max_rounds

Rounds are capped (default 4) and a `stop_reason=same_findings` can trip early. After each review:
1. `record_findings` (both `findings_text` AND `findings_hash`) so the Scout dedupes and the state survives;
2. collect blockers from *every* reviewer, plus your own parent-verified findings;
3. issue **one** fix carrying the whole bundle, and freeze what must not be re-touched.

In the fix brief, name closed findings explicitly as **CLOSED — do NOT re-open or restyle**, list
out-of-scope files/symbols one by one (e.g. `lib/delegation-mailbox.js:460/:613`, the inert
`lib/workspace-watcher.js:~1509` duplicate), and state what must not be re-bumped
(`RECOVERY_STORE_SCHEMA_VERSION`, `RECOVERY_CONTRACT_REVISION` when no contract *value* changed).
Otherwise a cheap model "tidies" the previous round and re-opens closed defects.

Also: a fix-start `workflow_update` must NOT re-carry `last_verdict=FAIL` on unchanged material —
that trips a spurious `same_findings` stop (see the loop-mechanics workspace-memory note; clear with
`clear_stop` under a NEW idempotency key).

## 6. Anti-churn exit

If the last round cannot reach an unanimous review PASS **plus** a passed verify, report the cycle
`blocked` with the exact open finding and its file:line — do not mark the todo done, do not start
another cycle. Honest `blocked` on a 4-round exhaustion costs one cycle; a false `done` hands the
next leaf a broken adapter contract.

## Parent-boundary reminder

Everything above is read/execute-only parent work (grep, diff, running suites, verdicts, ratings,
briefs). **Writing the missing code or tests is never the parent's job** — "audit and finish the
fix" is always a child delegation.
