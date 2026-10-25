---
name: cretli-acceptance-coverage-leaf
description: Run a Cretli "final acceptance / odbiór" leaf — a delegated assignment in `implement` mode whose real deliverable is a criteria→evidence coverage report plus docs, where you may ADD tests to close detected coverage gaps but must never touch implementation, and where PASS vs FAIL hinges on proving whether a flagged defect is actually reachable in production.
source: auto-skill
extracted_at: '2026-10-07T18:32:41.503Z'
---

# Cretli acceptance / coverage leaf (implement mode, audit deliverable)

Trigger: a delegated `[TASK]` that is the LAST step of a multi-stage feature (e.g. "Odbiór
całości / MVP acceptance") — `Execution mode: agent`, `Assignment: implement`, a
`cretli-ref todo=…`, an explicit requirement ladder (A1…I3, "D1…D10", "E1…E3") that "each
point = a separate coverage line", and a terminator `TASK: implement` / `VERDICT: PASS|FAIL|BLOCKED`
whose PASS is gated on: *coverage report written · docs F1–F3 updated · rollout procedure
written · C1 regression run green*. It is NOT a fix-a-review-finding leaf and NOT a read-only
review — see **cretli-delegation-review** and **cretli-delegation-implement** for those.

## The scope fence that decides everything
- You MAY edit: the assigned docs, and **add** `tests/**` (`*.test.js`) to close a detected test
  gap — "supplement", i.e. append a new case. The assignment usually names your files exactly.
- You MUST NOT edit: `lib/**`, `app_front/**`, `server.js`, commits/push/merge, `todo_update`
  (leave `doing`), or spawn another delegation. The tree is shared with parallel Watcher cycles,
  so **only additive edits**, never revert anyone else's work.
- The key judgement the ladder hinges on: a "luka" can be a **TEST gap** (→ you close it) or a
  **PRODUCT defect** (→ you do NOT fix it, you report it and lean FAIL). Most leaves are clean on
  behavior and only need a coverage map + docs + one or two missing assertions.

## Step A — map every criterion to a test, by TITLE, before touching anything
Don't read all 29 suites. Run each target suite once, capture `rc` + the per-case tally, then grep
the case titles to attach evidence to each ladder point:
- Detect runner style per file first: `grep -q node:test <f>` → run with `node --test <f>`; else
  plain `node <f>`. Within one feature family BOTH styles coexist.
- Custom suites print one `OK: <case>` line per case (count with `grep -c '^OK:'`);
  `node:test` prints `# tests / # pass / # fail` — quote those verbatim as the per-suite evidence.
- Build the criteria→evidence table from `grep -nE "runCase\(|^\s*test\(|describe\("` across the
  suite set: you now have every case title with a file:line to cite in the report.
- `scripts/review-verify.js <id>` (bare = whole catalog, exit 0 ⇒ every id passed) covers only the
  frozen unit catalog; the NEW feature suites are usually NOT in it, so run them directly. See
  **cretli-delegation-review** Step 3/4 for the catalog nuances and pipe rules.

## Step B — reachability-proof BEFORE calling anything a product defect (the FAIL trap)
A requirement can be "the shipped prompt/behavior must not contain the false statement X". If you
find X still in a source file **plus a passing test that asserts X** (e.g.
`assert.match(prompt, /PLAN mode/)`), the instinct is `VERDICT: FAIL`. Resist it — trace which code
the FEATURE actually executes:
- `grep -nE "<suspect-fn>\b" lib server.js scripts app_front | grep -v "<live-fn-variant>"` for every
  call site. If the only hits are the definition and tests, the suspect function is **production-dead**
  — the live path uses a different builder that already satisfies the spec.
- Confirm the live path is compliant (open the runner's call site: which prompt/config fn does it use?).
- Conclusion: a stale/false artifact in dead code + a lock-in test is **code-hygiene debt, not a
  product defect** → do NOT FAIL (the delivered behavior meets the criterion), disclose it in the
  report's "Luki / remaining" section as a follow-up that needs `lib/**` edits you are fenced out of.
  This is the inverse of review-skill's "dead-but-consistent helper" bullet: here the dead code
  *contradicts* a spec line, and the correct move is still PASS + finding, because the live path
  governs the acceptance criterion.

Mirror-lesson: a spec's "must not claim X" clause binds the RUNTIME surface, not every file that
historically mentioned X. Read what actually runs before you fail the whole MVP on a doc/prompt string.

## Step C — closing a genuine test gap with a mirror assertion
When the ladder has an explicit settlement/coverage TABLE (budget/refund matrix, state transitions)
as an acceptance criterion, each row needs a positive assertion — and rows are easy to leave proven
only in one direction:
- The refund row "normal `started=false` CONSUMES the daily budget, releases only the parallel slot"
  had NO test asserting the counter stayed consumed — existing tests proved only the *opposite*
  direction (`throw → refund, count 0`) and non-counter facts (`scanned:false`, history=`failed`).
- Read the branch that implements the row (`lib/…scout.js` `job.started === false` else-branch:
  reserve bumps profile + workspace counters, `clearActiveScoutScanIfScanId` releases the slot but
  never calls `rollbackScoutScan`) to learn the real invariants, then write a **focused mirror** of
  the existing refund test asserting the consumed direction (profile `count===1`, workspace
  `scoutScans.count===1`, `lastRunAt` advanced = the anti-retry-loop rationale, `activeScoutScans`
  empty, history `failed`). English comments (repo rule). Append into the existing test file
  (additive), not a new one, unless it's someone's untracked WIP — then create a narrow new suite.
- Re-run ONLY the touched suite + re-`lint` it (eslint) to prove rc=0 and the new case ran, because
  the shared tree can change under you. Quote the before/after count (e.g. 39 → 40 OK).

## Step D — docs split by language + the rollout writeup
- Honor the per-file language rule stated in the task: operator reference (`docs/workspace-watcher.md`)
  in **English**, feature spec (`docs/configurable-scouts*.md`) in **Polish**; code/test comments in
  English. Do not "correct" a stale spec by weakening a requirement that is right — the live code
  matching it is the truth; append a dated "Status odbioru" section recording the real state
  (schema bump, which steps landed, the one remaining finding) instead of rewriting the requirement.
- The rollout/backup/restore writeup is usually THE main gap: state the schema-version bump,
  "single-writer migration, lazy v1→v2 normalize on first read, idempotent", the ordered procedure
  (stop writers → back up store+lock db → start one v2 → verify legacy flow end-to-end → only then
  enable extra profiles), and the hard negatives: **no safe downgrade** to the old store, **no
  mixed-version operation**, restore-from-copy is the only rollback. Verify the schema constant and
  new collection names in `lib/persist/*` before writing them — don't invent.
- CHANGELOG: ADD one `[Unreleased] → Added` entry for the whole MVP; check existing Scout entries to
  avoid duplication; do not rewrite the historical base-feature entry even if its wording is now
  stale (shared tree, conflict risk) — note the wording drift in the report instead.
- Write the coverage report as a new doc (`docs/configurable-scouts-acceptance.md`) with the
  A1…I3 + spec "Kryteria" + "Dodatkowe kryteria" tables (criterion → file:line/test → status), a
  per-suite results table, "Zmienione pliki", "Luki/niezgodności pozostające", and a leaf-verdict note.

## Step E — verdict + report delivery
- `PASS` for an acceptance leaf = the four gates met (report written, docs updated, rollout written,
  C1 green) AND no *reachable* product defect / *runtime* unmet criterion. A dead-code finding does
  not flip it to FAIL. `FAIL` only for a genuine unclosed product defect or a criterion the running
  code misses. `BLOCKED` for a dead `cretli_bridge` session (see the reply/delivery fallback in
  **cretli-delegation-report-delivery** / **cretli-delegation-review** Step 6).
- Report in the assignment's language (Polish TODO → Polish `final_report`); `delegation_reply` with
  `reply_kind=final_report`, `task_outcome=success`, stable `idempotency_key`; include one
  `TASK: implement` + one `VERDICT:` line. Never claim PASS for tests you didn't run — quote the
  real rc/counts you captured.
