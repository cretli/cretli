---
name: cretli-orchestrator-resume-foreign-round
description: As the Cretli Workspace Watcher parent, continue a multi-harness loop a PREVIOUS cycle abandoned (implement done + review FAIL + fix never started): loop/round state is unreadable cross-chat so rebuild it from the old chat's transcript and job reports, recover the hidden model_pick pickId from data/model-pick-decisions.json, re-verify each blocker in the live tree before delegating, treat a premium candidate as never an infra retry, judge a stalled-looking reviewer by head_seq rather than cancelling it, and on a split FAIL+PASS review fanout run a round-2 fix scoped to ONLY the contested blocker (re-review via the blocker's own author).
source: auto-skill
extracted_at: '2026-10-07T15:16:58.408Z'
---

# Resuming a delegation round another cycle left unfinished

Trigger: the cycle prompt lists a PREVIOUS CYCLES table with an entry for **the same todo** as
`outcome=failure`, or WORKSPACE MEMORY says "next cycle: start the fix immediately, do NOT redo the
implement". The todo is usually still `doing` (already claimed) — do not re-claim it, and do not
re-run the implement.

This is the *parent's* pickup procedure. Companion: **cretli-orchestrator-stale-finding** (deciding
whether the finding is live at all, foreign-slot bounded waits, `blocked` vs `failure`,
record_findings, HEAD-attribution for lint/test dupes), **cretli-multi-harness** (the loop contract).

## 1. Loop state does NOT survive across cycles — rebuild it from the transcript

- `delegation_workflow_show({chat_id: "<prior cycle chat>", leaf_id: …})` returns
  `CONFLICT: Workflow state applies only to the calling parent chat.` Your round counter starts at
  zero; the prior cycle's round/verdict/findings are NOT inherited.
- Recover the substance instead:
  1. `chat_show({chat: "<prior cycle chat full UUID>", tail: 60})` — the compact tail shows the whole
     arc (implement started → reviews → the CONFLICT that killed it) in one read.
  2. `delegation_list({chat_id: "<prior chat full UUID>", scope: "all", limit: 20})` — this DOES work
     cross-chat (unlike `workflow_show`) and gives the terminal job UUIDs.
  3. `delegation_show` each review job and **follow `next_cursor` to the end**. The verdict-bearing
     tail and the `[nieistotne]` list live past the first 4000 chars. Never aggregate from the
     `delegation_inbox` preview.
- Write your OWN `workflow_update` (omit `chat_id`; pass `leaf_id`) with the recovered
  `last_implementer`, `last_reviewer`, `fanout_verdicts`, `findings_text` and a fresh
  `material_revision` before starting the fix, so a restart of *this* cycle is resumable.

## 2. Re-verify every blocker in the live tree before writing the fix brief

The failed cycle's anchors are ~1-2 h old and other cycles edit the same dirty tree. Grep/read each
cited `file:line` and confirm the defect is still present. It was in this run (all three anchors
live), but the check also caught the file path being wrong: the review cited
`lib/workspace-watchers-persist.js`, the real module is `lib/persist/workspace-watchers-persist.js`.
A paraphrased path in a brief sends the child hunting; quote the verified path.

Also measure a **baseline test run before delegating** (`for f in <area suites>; do node
tests/$f.test.js; done`). If they are green before AND after, green proves nothing — say exactly
that in the review brief so the reviewer grades the code and the new assertions, not the color.

## 3. `model_pick` hides the pickId in its compact rendering — read the durable store

`delegation_start` must forward `pick_id`, and every `model_pick` response here rendered as
`harness model role=… reason=…` with **no pickId line**. Recover it from the store (read-only; it is
gitignored runtime state, no secrets in it — never read `.env`/`data/` for credentials):

```bash
python3 -c "
import json
d=json.load(open('data/model-pick-decisions.json'))['picks']   # {pickId: record}
rows=[r for r in d.values() if r.get('chatId','').startswith('<8-hex calling chat>') and r.get('role')=='fix']
rows.sort(key=lambda r: r['createdAt'])
for r in rows[-1:]:
    print('PICKID', r['id'], r['createdAt'], r['expiresAt'],
          {p.get('selectionSlot'):(p.get('harness'),p.get('model')) for p in r.get('picks',[])},
          'used', r.get('slots'))
"
```

- The record is `{id, chatId (FULL uuid), role, createdAt, expiresAt, candidates[], picks[], slots{}}`.
  `r['id']` **is** the `pick_id`. Filter with the 8-hex display prefix (`startswith`) — the stored
  `chatId` is the full UUID.
- TTL is ~30 min (`createdAt` → `expiresAt`). If you burned a bounded wait on a foreign slot, the
  pick may expire mid-wait: re-pick *after* the slot frees, then start immediately.
- **Foreign mutating-slot CONFLICT is retryable with the SAME pick and the SAME idempotency key.**
  A `delegation_start` for fix/implement can be rejected with `CONFLICT: Another parent already has a
  mutating job in this workspace. Blocker delegation id: …, Blocker parent chat: …` — a *sibling*
  watcher cycle holds the exclusive slot; this is not your failure and the todo stays `doing`. It
  creates **no job**, so your idempotency key is still free — do NOT mint a new key. Confirm the slot
  cleared with `delegation_list({scope:"all", status:"running"})` (empty = free) after a bounded
  `sleep … # intentional-sleep:`, then retry `delegation_start` with the **same `pick_id` + same
  `idempotency_key`** as long as the pick's TTL has not lapsed; only re-pick if it expired mid-wait.
- `slots: {}` = unused. Each pick slot starts at most once, and each `model_pick` call creates a NEW
  record (several rows per chat), so use the newest unused one; a reused/expired link is stored as
  unknown/rejected but does not block the start.
- `count: 2` + `diverse: true` yields ONE record holding both slots (`selectionSlot` 0 and 1) — start
  both children with the same `pick_id` and different `idempotency_key`s.

## 4. A premium candidate is never your infra retry

Real sequence: the review fanout's `sdk/grok` started fine; `claude/claude-sonnet-5-5` failed with
`You've hit your session limit · resets 7pm (Europe/Warsaw)` — concrete quota evidence, so
`exclude_harness=claude` (not just `exclude_model`). The next-ranked candidate was
**`codex/gpt-6-astra` (cost tier 5, observed 69% infra fail)**. Selecting it would violate the
premium-restraint rule ("not as an infra retry"), and Codex also risks `review_uncertified`. Re-pick
with widening excludes until a *cheaper different harness* surfaces:
`model_pick({role:"review", exclude_harnesses:["claude","codex"],
exclude_models:["grok-4.7::…","composer-2.5::fast=true"]})` → `qwen/qwen3.8-max`,
`tests=yes verify=self` — a reviewer that can run the catalog itself. Cap 1 infra retry per role and
never reuse the failed job's idempotency key.

Corollary: prefer `tests=yes` for the retry — it removes your `delegation_verify` obligation and
gives reproduced numbers (this one ran 44 catalog cases + 5 suites and reported per-suite counts).

## 5. Do not cancel a "stalled" child — watch `head_seq`, not elapsed time

`qwen3.8-max` ran ~30 min. Two `chat_show({chat:<child>, tail:4})` polls 10 min apart both showed
`head_seq: 199`, which looks like the known `qwen: slow_read_loop` failure mode. It then completed
with a PASS and real test output. Judge by whether `head_seq` AND the per-tool call counters advance
between polls, keep bounded `sleep … # intentional-sleep:` windows, and treat
`status=running slot_occupied=true` with no verdict as "still working" rather than infra.

## 6. You cannot rate the previous cycle's review — rate what you own

The loop requires rating the review that issued the FAIL in a FAIL→fix→PASS cycle. If that review
belongs to another chat, `delegation_rate` returns
`OUT_OF_SCOPE: delegation_rate is limited to jobs started by this parent chat.` Do not work around
it. Rate your own jobs instead (the fix child and both re-reviewers here, 5 each) and note in
`workflow_update.report_text` that the prior cycle's FAIL reviews were unrateable from here, so the
quality signal is not silently lost.

## 7. Close-out order on a resumed round

Review PASS+PASS → `delegation_verify` on every `verify_required` job (the scout area has exactly one
catalog id, `workspace-watcher-scout`; there is NO id for the editor/profiles suites, so also run
those files yourself) → `todo_update` with a FRESH `expected_updated_at` from `todo_show` (the prior
cycle changed it) → `workflow_update` final verdict → `workspace_memory_add` decision →
`watcher_update({action:"record_findings", todo_id, findings_text:""})` to CLEAR the stored blocker
so the Scout stops re-filing it → `watcher_update({action:"report", outcome:"success"})`. Stale
Workspace Memory gets corrected the same way: a saved "deepseek insufficient balance" blocker was
disproven by a successful deepseek run in this cycle.

## 8. A split review fanout (one FAIL + one PASS) — fix ONLY the contested blocker

With `CRETLI_DELEGATION_REVIEW_FANOUT=2` the two reviewers can disagree on the SAME point. Observed
2026-10-07 on the resumed todo 54db8983: fanout `sdk/grok-4.7` = FAIL (one blocker) and
`qwen/qwen3.8-max` = PASS (ran 6 suites + the full review-verify catalog, no blockers) — the two
*agreed on the mechanism* but graded it blocking vs "cosmetic in effect". Aggregate conservatively
(any FAIL ⇒ not PASS): the FAIL is authoritative, so a round-2 fix is required even though the other
reviewer passed the artifact.

- **Narrow the fix to the one contested defect.** Both reviewers confirmed the other defect(s) closed,
  so the round-2 `task_text` must EXPLICITLY forbid touching the already-closed files ("you MUST NOT
  change DEFECT 1 code … / the two new regression tests") and require the child prove scope with
  `git status --porcelain` / mtimes — a flash fixer will happily re-edit the whole area otherwise.
- **Re-review with the reviewer that authored the blocker**, not a fresh model. It already knows the
  acceptance criterion and can confirm closure precisely; if it now PASSes, the split resolves.
- Record the split in your OWN `workflow_update`: `fanout_verdicts:["FAIL","PASS"]`, the FAIL's
  `findings_hash`/`findings_text` scoped to the contested point, and a fresh material revision.
- **Compute the material revision** (short HEAD + dirty-status fingerprint) with the project helper
  instead of eyeballing it — pass it to every `workflow_update` so a `same_findings` stop is judged
  against the real artifact, not findings text:
  ```bash
  node --input-type=module -e \
    "import { readDelegationMaterialRevision } from './lib/delegation-material-revision.js';
     console.log(readDelegationMaterialRevision(process.cwd()));"
  ```
- Then continue the normal loop: round-2 PASS on the contested point + verify backstop → PASS/PASS →
  close out via step 7. Rate your own round-1 FAIL reviewer HIGH (it caught the residual the
  implementer missed); a `delegation_rate` on a NON-qwen job (your orchestrator base) is allowed even
  though the same-base `qwen3.8-max` PASS review would be `self_model_rating_denied`.

## 8.5. A fanout child can DIE on delivery while writing a complete, correct verdict — a THIRD case (observed 2026-10-08, todo 63fe60ce, cycle 93e9d14c)

§8 distinguishes a real `VERDICT: FAIL`. §4 distinguishes an infra `usage_limit`. There is a third,
easily-mis-read shape: the reviewer **finished its analysis** (a full, correct PASS, every acceptance
bullet + the regression gate enumerated with `file:line`), but the job landed as

```
status=failed  verdict=unspecified
error: [adapter_incomplete] Review ended without a VERDICT report.
```

i.e. it omitted the trailing `TASK:`/`VERDICT:` terminator, so the server never extracted a machine
verdict (the child-side cause and prevention live in **cretli-delegation-report-delivery**). On the
parent side the traps are:

- **It is NOT a FAIL — do not aggregate it as one and do not open a fix round.** A `status=failed`
  review carries no verdict; conflating it with §8's authoritative FAIL burns a whole round on green
  code. Equally it is **not a PASS** — `verdict=unspecified` never satisfies the loop's "PASS only if
  every review PASSes". Keep its prose as *informative corroboration* (read the full report with
  `delegation_show`, follow `next_cursor`) but do not let its "PASS" word count.
- **If the SURVIVOR of the fanout emitted a clean `VERDICT: PASS`, close on the survivor + your own
  `delegation_verify` — do NOT re-run the whole round.** This is the key judgement: a dead sibling is
  not automatically a reason to retry. §4's infra-retry budget is for a role that has NO usable
  verdict (usage-limit / quota / adapter never started). Here you already hold one authoritative PASS,
  so consuming the single retry per role would be waste and risks the contended review slots.
- **`verify_required` is PER-JOB and mandatory when both reviewers are `tests=no`.** With
  `traits.review_can_run_tests=false` a survivor PASS does not close the leaf on the child's word —
  run `delegation_verify({delegation_id:<survivor>, ids:[<leaf's catalog/area ids>]})` and require
  `review_verify=passed exit=0` beside `verdict=PASS`. Running it against the `status=failed` job is
  pointless: it prints `review_verify: not recorded (required: executor cannot run the runner)` and a
  failed job can never be the close gate anyway.
- **`delegation_ack` the dead job with `reason:"reviewed"` (NOT `accepted`) and rate it LOW as a
  DELIVERY failure, not a content failure** — e.g. `score:2`, note "complete correct analysis, omitted
  the VERDICT terminator, unusable as a machine verdict". Don't tag `false_positive`/`missed_bug` (its
  substance was right); those imply content error and would be a `contradictory_rating` against a
  report that actually agreed with you. Rating it is allowed because it ran on another harness than
  your orchestrator base (`claude` child under a `qwen` parent → not `self_model_rating_denied`).
- **Don't `delegation_cancel` it and don't keep `delegation_wait`-polling it.** It is already terminal
  (`slot_occupied=false`); a further wait returns the same `status=failed` forever. Switch to
  `delegation_show` to read the prose, then move on.
- Record the asymmetry in `workflow_update.report_text` so the next cycle (or a hand-off) knows the
  leaf closed on ONE clean reviewer + host verify, with the second reviewer lost to delivery.

Quick classifier for a fanout child that looks "bad":

| signal | it is | parent action |
|---|---|---|
| `verdict=FAIL`, clean terminator | real finding | §8 fix round, scope to the contested defect |
| `status=failed`, `usage_limit`/quota/never started, empty report | infra, no verdict | §4: 1 retry, different harness/model, new key |
| `status=failed`, `[adapter_incomplete] … without a VERDICT`, full correct prose | delivery loss, `unspecified` | §8.5: close on the survivor + `delegation_verify`; ack `reviewed`; rate 2; NO retry, NO re-run |

