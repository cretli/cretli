---
name: cretli-orchestrator-failed-child-partial-landing
description: As the Cretli orchestrator parent, when an implement/fix delegation returns status=failed with a thinking-dump report it may still have LANDED working source in the tree: triage git status/grep + node --check + eslint + the existing suites, then issue a COMPLETION brief that enumerates the landed code verbatim and forbids rewriting it — instead of re-running implement from scratch or reporting failure. Also covers the same-executor infra-retry exception, not reusing a completed job's idempotency key, a short foreign-lock poll that beats pre-declaring blocked, and never transcribing delegation UUIDs (re-derive from delegation_list; prefixes are valid).
source: auto-skill
extracted_at: '2026-10-07T16:12:04.107Z'
---

# An infra-failed child may have already done the work

Trigger: you are the Cretli Workspace Watcher / multi-harness **parent** and an
`assignment=implement` (or `fix`) job you started returns terminal
**`status=failed`** with `verdict=unspecified`, an `error` like `Qwen run failed`, and a
`report:` body that is a **thinking dump** ("Zaczynam od rozpoznania stanu repo…",
"Najpierw test warstwy store (klauzula 1a).") and **no `TASK:/VERDICT:` terminator**.

The naive readings are both wrong:

- *"infra failure ⇒ nothing happened, re-run the same brief"* → you churn a model rewriting
  code that is already on disk, and the second child may *revert* or fork it.
- *"the child said it started editing ⇒ treat the leaf as progressing / report failure"* →
  you lose finished, verified work and burn a cycle.

**The report stream is not the filesystem.** A child that died mid-report can still have
written complete, correct, lint-clean source. Triage the tree first.

## 1. Triage the landed state before deciding anything (this is the whole trick)

Do this **before** touching loop state or starting any child:

```bash
git status --porcelain
grep -nE '<symbol the brief demanded, e.g. getRunByRequestId|lookupRequest|transcriptLost>' lib/<area>/*.js
ls tests | grep -iE '<the new test file you asked for>'
ls -lt lib/<area>            # mtime tells you WHICH files this child actually touched
```

Then prove the landed code is *load-bearing-safe*, not just present:

```bash
node --check lib/<each touched file>
npx eslint lib/<each touched file>
for t in <regression suites for the area>; do node tests/$t.test.js 2>&1 | grep -E '^# (tests|pass|fail)'; done
```

Always capture the `# tests / # pass / # fail` lines — `tail -4` shows only `duration_ms`
and hides failures.

On the observed run (R6, leaf `3304322f`, child `4ce6c97c`, qwen3.8-flash, ~40 min then
`Qwen run failed`) the crash landed **clauses 1–6 of 7 fully** (durable `lookupRequest`,
`getRunByRequestId`/`resolveRunRefByRequest`, `describeRecoveryAdapterContract` derived from
the existing MVP table, the tri-state `accepted`, the reattach/resume capability surface,
`transcriptLost`) — eslint clean, `node --check` clean, and every existing suite green
(22/22, 14/14, 18/18, 3/3). Only **clause 7 (tests) was unwritten**. That profile — *source
done, tests missing* — is exactly what a flash model that streams prose before asserting tends
to produce when it dies.

## 2. Issue a COMPLETION brief, not a fresh implement brief

Re-send `assignment=implement` with the **landed code described verbatim** and an explicit
anti-rewrite instruction. The cheap child has no memory of the first attempt, so the brief must
carry the state it is completing:

- `SITUATION: a previous attempt CRASHED near the end. It already LEFT WORKING, LINT-CLEAN
  source on disk. Your job is to FINISH and VERIFY it, not rewrite it. Do not undo it.`
- **Per file, what is already there**, with the exact symbol names and semantics (paste the
  triage from step 1 back into the brief — e.g. "tri-state `accepted`: true = durable
  acceptance proof, false = row without proof, null = unknown/no contract").
- **What you already verified for it** ("node --check + eslint clean; these suites green: …
  — do not redo").
- `A.` audit rules (restate the original acceptance clauses as adjudication rules, including
  the scope boundary and the "no new tables / no schema bump / do not import runtime modules
  into `lib/recovery/**`" style invariants), `B.` the **missing** deliverable (tests, with the
  concrete cases and expected shapes), `C.` run everything and paste real counts.
- Repeat the dirty-tree guard: `branch next/…, DIRTY with many unrelated uncommitted files —
  NEVER revert or stash anything you did not write`, and name the foreign files if you know
  them (see `cretli-orchestrator-stale-finding`).
- Anti-stall line: `produce the final report ONCE with the two terminator lines at the very
  end; do not stream a thinking dump` (see `cretli-delegation-report-delivery`).

Use a **NEW idempotency key** (`…-r2`). Never reuse the key of a job that already produced a
record — a replay returns the failed job. (A key whose start was **CONFLICT-rejected** created
nothing and may be replayed.)

## 3. Same-executor infra retry: normally forbidden, with a stated exception

The loop rule is "never start the same model/harness again for the same role after an infra
failure", and `candidates[1]` is the fallback. But the exception is when **no other eligible
candidate exists**: here opencode+claude were under an active usage limit, deepseek had a
recorded `Insufficient Balance` blocker, and no other harness had an *enabled Settings
favorite* for `implement` — so `model_pick(role:"implement")` returned the same
`qwen/qwen3.8-flash`. Re-picking cannot invent a favorite you don't have, and stopping the
cycle would discard landed work. Retry on the same executor and **write that justification
into `pick_reason`** so the delegation card and future readers see why the rule was bent.
Cap remains 1 infra retry per role; if the completion round also infra-fails, do **not**
fire a third — verify/report per the round rules and leave the todo `doing`.

## 4. A foreign mutating lock: poll a couple of minutes before declaring blocked

`delegation_start` may return
`CONFLICT: Another parent already has a mutating job in this workspace. Blocker delegation id
<UUID>. Blocker parent chat <UUID>.` The workspace write slot is **exclusive** regardless of
`maxParallel`. Cheap sequencing that worked here:

1. `delegation_show({delegation_id: <blocker UUID>, scope: "all"})` → read `status` **and
   `slot_occupied`**. The CONFLICT error already gives you both UUIDs, so no `chat_show` needed.
2. `sleep 60` once (a foreground one-liner is fine), re-poll.
3. Retry `delegation_start` the moment `slot_occupied=false`.

Here the foreign job (`ed3b95c0`, a sidebar-archive fix on `sdk/composer-2.5::fast`) cleared
within **~60 s**, so a pre-emptive `blocked` report would have wasted the whole cycle. If it
stays occupied, check DISJOINTNESS and hold longer per
`cretli-orchestrator-stale-finding`, and report **`blocked`** (not `failure`) — only `failure`
spends the todo's failure budget. Never cancel or touch a foreign parent's job.

## 5. Never transcribe a delegation UUID — re-derive it

I wrote the completion job's UUID into `workflow_update.report_text` and then called
`delegation_wait` with a **fabricated** one and got
`NOT_FOUND: Delegation not found`. Both UUID segments can be invented plausibly, so this
fails late (after you already corrupted durable loop state with the wrong id).

- The authoritative list is `delegation_list()` — no `chat_id` needed for **your own** chat (that
  trap only applies to `scope=all` cross-chat probes), and it renders full UUIDs.
- `delegation_show` / `delegation_wait` accept a **≥8-char unique prefix** — prefer copying a
  prefix over typing 36 chars.
- If a wrong id did reach `workflow_update`, fix it with a **new** event key carrying the
  correction (`report_text` + right UUID). The same key with different params is `CONFLICT`,
  and every applied key→fingerprint is retained.

## Checkpoint

After triage: persist `workflow_update` (omit `chat_id`) with `last_verdict:"infra_failed"`,
the correction/context in `report_text`, the fresh `material_revision`, and a stable per-event
key — so a parent restart resumes the *completion* round instead of starting a third implement.
A crashed child with landed work is neither `PASS` nor a clean `FAIL`: record it as infra, and
let the completion round's verdict be the first real one.
