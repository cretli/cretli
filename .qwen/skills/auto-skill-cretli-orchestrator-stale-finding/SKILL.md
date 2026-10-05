---
name: cretli-orchestrator-stale-finding
description: As the Workspace Watcher / multi-harness orchestrator (parent), verify a delegated Scout finding against the live tree BEFORE delegating; if it is already fixed, skip the implement child — but scope the independent review to the in-tree DELTA that fixed it, because "stale" often means "someone's uncommitted change replaced the bug with a different bug" (escaped-quote privilege bypass found this way), which then requires fix→review→PASS; gate "todo done" on that review, backstop with delegation_verify only when the area has an audited catalog id (else disclose its absence and reproduce via the module's own `npm run test:<area>` script — an "Unknown review verify id" is NOT a failed review), attribute child scope by mtime on a dirty branch, and memory-dedupe before reporting success. Also covers a PRODUCT-DECISION todo whose stated current-defect is already partly satisfied in the predicate: trace the real blocker to the upstream PRODUCER (classifier), keep an out-of-scope producer fix to its sibling/idea todo, shrink the deliverable to a non-tautological regression-TEST LOCK + clarifying comment, resolve the plan scope INLINE instead of burning a premium plan child, hard-scope-lock adjacent intentional code in the brief, and do a bounded wait (delegation_list scope=all + sleeps + retry delegation_start) on a foreign parent's exclusive write slot before reporting blocked. Also: audit for the DEAD-ON-ARRIVAL time gate (an idle/grace window measured from `updatedAt` checked only at the moment the event refreshes it, with its retry path living solely in process boot — green tests faking an old timestamp cannot catch it), trace WHO CALLS the periodic path before accepting that a fix works on the live path, handle a SPLIT fanout verdict (one reviewer FAIL, one PASS on the same defect = FAIL, and verify the call graph yourself before writing the fix brief), report `blocked` (not `failure`) for foreign-slot contention because only `failure` spends the todo's failure budget, and resolve open code questions yourself so the fix brief states facts instead of guesses. Also (2026-10-05 Area 3): workflow-write tools reject a chat-id PREFIX so omit `chat_id` entirely, adjudicate a same-line split fanout verdict against the implementer's OWN doc invariant, rate the defect-catcher 5 / the same-line-misser 4 `missed_bug`, and finalize a FIX-round that a CHAINED foreign parent starved (>14 min, implement+review already done) — rate, record_findings the exact pending one-liner, memory "don't re-implement", leave todo doing, report blocked.
source: auto-skill
extracted_at: '2026-10-05T07:06:10.246Z'
---

# Orchestrating a delegated finding that may already be fixed

Trigger: you are the **parent/orchestrator** ("You are the Workspace Watcher orchestrator for
exactly ONE cycle", `cretli-ref todo=…`, or a `cretli-multi-harness` `loop`). The required loop
says "proceed directly to implementation", then "run a review delegation", then "never mark a
todo done before the review PASS". Those steps *assume there is work*. The hard part is deciding
what to do when the cited defect is **already resolved** in the working tree (a common case for
auto-generated `[Scout]` findings, which are captured at scan time and drift).

Companion skills: **cretli-delegation-implement** (executor child) and
**cretli-delegation-review** (reviewer child). This file is the *parent's* decision path, not
theirs.

## Step 0 — verify the finding is real *before* starting any child (cheap; prevents invented work)
The Scout `[TASK]` text is a hypothesis with **drifted line numbers and code shapes**. Re-derive
ground truth now:
- `read_file` the exact lines the finding cites. On 2026-10-05 the finding said
  `later = Date.now() + 7 * 3600_000` at "line 431 / assert at 445", but the file already had
  `const base = Math.floor(Date.now()/86_400_000)*86_400_000 + 3600_000` (L401) and
  `const later = base + 7 * 3600_000` (L443) with the assert at L457 — i.e. the finding's own
  suggested fix was already present, with a comment documenting it. Mismatched line numbers +
  the "fix" already in the shape of the code are the tell.
- `git status --short <files>` / `git ls-files <files>`: Scout findings often cite **untracked**
  (`??`) WIP files. `git log --oneline -- <file>` on an untracked path returns **empty** (not an
  error), and `git diff HEAD -- <file>` shows **nothing** for `??` — do not mistake that for
  "unchanged since HEAD"; the file simply isn't in HEAD. Judge staleness from the on-disk source,
  not the git baseline.

## Step 1 — reproduce the finding's exact failing condition (no libfaketime needed)
Prove *both* directions in one throwaway `node -e` that recomputes the code's arithmetic against
simulated wall clocks, instead of trusting a green run at a lucky hour:
```bash
node -e 'const k=n=>new Date(n).toISOString().slice(0,10);
for (const [h,m] of [[6,57],[17,30],[20,30],[23,59]]) {
  const wall=Date.UTC(2026,9,5,h,m,0);
  const base=Math.floor(wall/86400000)*86400000+3600000, later=base+7*3600000;
  console.log(h+": "+m, "sameDay(new)=",k(base)===k(later)," sameDay(OLD wall+7h)=",k(wall)===k(wall+7*3600000)); }'
```
For a per-UTC-day budget flakiness: `workspaceWatcherUtcDayKey` is
`new Date(now).toISOString().slice(0,10)` → UTC-day-keyed, timezone-independent, so
`floor(Date.now()/86400000)*86400000 + Nh` stays inside one UTC day for **any** clock. The
finding's raw `Date.now()+Nh` crosses midnight only when run late in the UTC day — exactly the
window it reported. `sameDay(new)=true / sameDay(OLD)=false` across late clocks is the proof the
current code is fixed. Also run the named suite (`node tests/<x>.test.js`) and grep the review-verify
catalog for the id (`lib/sdk/sdk-review-verify.js`, e.g. `'workspace-watcher-scout': 'tests/…'`) to
confirm the transitive `review-verify.test.js` claim is satisfied.

## Step 2 — do NOT start an implement child when there is no diff
Premium-model restraint / "don't invent work": starting a child to "fix" an already-correct,
deliberate fix risks regressing it and spends a model. Skip implementation entirely. This does
**not** mean skip the review gate — the loop's hard rule still applies.

## Step 2.5 — "stale" does NOT mean "safe to close": audit the DELTA, not just the claim
The in-tree change that made the finding stale is **unreviewed work**, and it is the thing most
likely to be broken. Do not scope the review to "is the original defect gone?" — that question is
already answered by Step 0/1. Add an explicit item: *"what new defect did this change introduce?"*

Real case, todo a6265f19 (2026-10-05, cycle 3f8db2d9): the Scout finding about a `within_workspace`
false positive was stale — `relativeScanText = readCommandPositionText(command)` already shipped in
the dirty tree, and the todo also cited the **wrong root cause** (`hasCretliDataSecretToken()`'s
quote-strip, which is a separate `data/` secret check). So there was nothing to implement. But that
same fix had rerouted `APPROVAL_ENV_DUMP_RE` / `APPROVAL_PRIVILEGE_COMMAND_RE` through the
quote-zeroed text, and `APPROVAL_QUOTED_TEXT_RE = /'[^']*'|"(?:\\.|[^"\\])*"/g` has **no escape
handling in the single-quote alternative**, so a `\'…\'` pair swallowed real command text:

```
echo \'; sudo systemctl stop x; echo \'   → risk=low, categories=[], within=true, decision=allow, reply=once
```

i.e. an **auto-approved privilege escalation**, and the shell genuinely runs the hidden stage.
Measured `raw_priv=true / zeroed_priv=false` and `raw_env=true / zeroed_env=false` proved it was a
regression from this change, not a pre-existing bug — that raw-vs-transformed comparison is the
cheapest way to classify "new" vs "old" defect.

So the shape of the cycle was: **stale finding → review r1 FAIL → fix child → review r2 PASS → done.**
Budget for it: this is why `max_rounds` exists, and the review FAIL was worth a whole extra model.

Give the reviewer concrete adversarial families to reason over rather than "looks fine" — for a
quoting policy that means mixed quote nesting, reversed order, `\\` before the quote, and an
escaped quote *inside* an otherwise valid quoted region — plus the guard that the intentional
false-positive removal still holds (`grep -r 'foo' '../i18n'` → inside; `rg 'sudo|kill|docker' lib/`
→ no categories). Direction matters: an extra **false positive** toward `ask_user` is an acceptable
trade-off and is not a FAIL reason; a remaining **false negative** that auto-approves is.

Corollary for Step 3: the review prompt must not lead the child to a rubber stamp. Asking "is this
resolved?" on a no-diff audit yields a lazy PASS; asking "is this resolved, and what did the
uncommitted fix break?" is what surfaced the bypass.

Also, when you write your own verification probe for quoting/escape code, **never** put the fixtures
in an inline `node -e` shell argument — see the `quote-safe-probe-files` skill (in this very session
an inline probe's mangled quoting made bash execute `env` and leak API keys into the transcript).


## Step 3 — still close on an INDEPENDENT review PASS (the orchestrator cannot self-certify done)
The rule "never mark a todo done before the review PASS" exists so the parent does not rubber-stamp
its own check. So run ONE read-only review delegation (an audit of "is this resolved / any residual
flakiness / is the catalog satisfied?" — TASK: review, not implement):
- `model_pick({role:"review"})`. In the observed run only ONE candidate existed and it was
  `sdk`/grok with **`tests=no`** (`traits.review_can_run_tests=false`). One reviewer is proportionate
  for a no-diff audit — do not fan out.
- Write a self-contained `[TASK]` (the child never saw this chat): state the hypothesis ("finding is
  stale, fix already in tree"), enumerate the file:line facts to re-verify, give an explicit PASS
  criterion (deterministic + catalog mapping present + no sibling time-of-day case) and
  FAIL-only-if-concrete-residual. Instruct read-only and end with `TASK: review` / `VERDICT: …`.
- Because the reviewer can't run the catalog, **you (parent) MUST** run
  `delegation_verify({delegation_id, ids:["<audited-catalog-id>"]})` — it persists the hard
  catalog result beside VERDICT. `review_verify=passed exit=0` + `verdict=PASS` is your gate. A
  child PASS with `review_can_run_tests=false` and no `delegation_verify` is `unspecified`.
- **"Unknown review verify id" is NOT a failed review** — it means the area simply has no audited
  catalog entry. Confirmed 2026-10-05 for `approval-advisor`: `delegation_verify ids:["approval-advisor"]`
  returned `review_verify=failed exit=1 / Unknown review verify id`, and `node scripts/review-verify.js
  --list` shows the valid ids (this area is absent; only mcp-*/sdk-*/delegation-*/todo-*/workspace-watcher-*/
  notices/claude-* etc. exist). In that case the authoritative hard check is the module's OWN suite run
  directly on the working tree (`npm run test:approval-advisor` → `node tests/approval-advisor.test.js`
  → exit 0), and you DISCLOSE the catalog absence in the report + memory rather than treat the unknown id
  as a gate failure. (`scripts/review-verify.js` also accepts a named area id to run just that area's cases
  cheaply on a large dirty tree — but only for areas that actually have an id.)
- Persist loop state around the review: `delegation_workflow_update` (role/round/last_reviewer/
  last_model/`material_revision` = `HEAD:<short>-dirty:<sha256 of git status --porcelain>`/deadline,
  stable `idempotency_key` per event) before AND after the report.

## Step 4 — close the cycle
On review PASS + catalog passed:
1. `todo_show` → fresh `expected_updated_at`, then `todo_update({patch:{status:"done"}})` (a status
   change appends the changelog note; a stale CAS token is rejected).
2. `workspace_memory_add({type:"finding", key:"todo-<id>-…-stale-fixed", ttl_ms:…, value:…})` so the
   next Scout scan dedupes this area instead of re-filing it (Scout drops areas covered by memory).
3. Optional `delegation_rate` — allowed here (the review ran on a different base model than the
   parent, satisfying the anti-self-rating rule); a thorough no-fabrication audit that honestly
   disclosed its shell limit earns 5.
4. `workspace_watcher_update({action:"report", outcome:"success", todo_ids:[…], cycle_id:<active
   cycle>, report_id:<cycle>, summary:"…stale/already-fixed; review PASS + delegation_verify
   passed; no code change…"} )`. "report ok" = durable. Then STOP — the watcher starts the next
   cycle; never spawn one yourself, never commit/push/merge.

## If the finding is NOT stale
Only if Step 0/1 shows a concrete residual (a sibling case still crosses UTC midnight, the assert
still fails, or the catalog entry is missing) do you run an implement child (`model_pick
role:"implement"` → `delegation_start` assignment=implement) and continue the normal loop.

## Variant: a PRODUCT-DECISION todo whose stated defect is already partly satisfied
A todo titled "Decyzja produktowa …" (product decision) is NOT a Scout bug, but the **verify-first**
discipline still applies: the body asserts a *desired* behavior AND a *current defect*, and the
current-defect claim is frequently already (partly) true in the tree. Real case, todo 84cda936 / Area
2 (2026-10-05, cycle 5c2a8c88): body claimed "`resolveApprovalAdvisorPlan` rejects `edit`/`mutation`
via `not_low_risk`/`unsafe_category`; make `ask_user, risk=low, categories=[]` eligible regardless of
action type". Reading the live predicate showed it was **already action-type-agnostic** — it reads only
`mode/shadow/decision/risk/categories/command`, never the action *name* — so the named code change was
essentially already done and the requested functional edit would have been a no-op.

What to do when the named change is already satisfied:
1. **Trace the upstream PRODUCER to find the REAL blocker.** A real `edit` never reached the eligible
   tuple because the *classifier* (`classifyOpenCodePermissionRisk` + `isOpenCodePlanMutatingPermission`
   in `lib/opencode/opencode-permission.js`) forces any mutating permission to `risk=medium` +
   `categories=['mutation']`, so `low + []` never occurs for edit. The eligibility gate was innocent.
2. **Check scope before you reach for the producer.** The producer fix belongs to a *sibling / idea*
   todo (here Area 1, already `done`, plus idea todo a66d8d5a "expand eligibility to in-workspace edits").
   Keep it OUT of this todo's scope and say so in the brief + report + memory: the manual test-plan line
   "OpenCode edit outside workspace → Jev consulted" is **not** satisfiable by this todo alone — disclose it
   instead of silently over-reaching into the classifier.
3. **Shrink the deliverable to a non-tautological regression TEST LOCK + a clarifying comment.** The
   right output was: a comment at the risk gate documenting type-agnosticism, and a test block that
   (a) proves `edit`+`low`+`[]` is eligible AND `assert.deepEqual`s the identical `{eligible,reason}`
   against the SAME tuple as `action:'bash'` (so the test genuinely fails if the gate ever branches on
   the action name — a bare `eligible===true` would be tautological), (b) `edit`+`medium`+`[]` → `not_low_risk`,
   (c) `edit`+`low`+`['mutation'|'network'|'secrets']` → `unsafe_category`. Do not invent a functional
   predicate change that the tuple logic already gives you.
4. **Resolve the plan scope INLINE — do NOT burn a premium plan child.** `model_pick role:"plan"` returned
   `codex/gpt-6-astra` (cost tier 5). Premium restraint + "proceed directly to implementation" meant the
   parent could answer the one real design question (predicate-only vs classifier-reconciliation) with three
   `read_file`s, so I skipped the plan delegation entirely and delegated only implement+review. A separate
   plan child is for genuinely hard-to-resolve design forks, not for confirming a predicate's shape.
5. **Hard-scope-lock adjacent intentional code in the brief** — enumerate what the implement child must NOT
   touch, each with WHY, because a cheap/flash implementer will happily "tidy" an adjacent branch:
   the `mutationOnlyMedium` review-verify branch (`isReviewVerifyInvocation(command)`, covered by its own
   tests ~L210-230/L340-365), the config gates (`advisor.enabled`, model/protocol, HTTPS, no-userinfo,
   API key), and the upstream classifier. State "naruszenie = FAIL" / boundary violations fail the round.
   Then in the review brief restate these as ACCEPTANCE items (type-agnostic predicate, exclusions intact,
   config/classifier untouched, `mutationOnlyMedium`+tests intact, non-tautological test) — do not just ask
   "looks ok?".

A cheap `*flash*` implementer (here qwen3.8-flash) is proportionate for a bounded "add tests + a comment"
task (reviewer catches issues); note qwen HAS shell so its `npm run`/eslint claims are reproducible,
unlike the `sdk`/grok reviewer (`tests=no`).

## Bounded wait on a FOREIGN parent's exclusive write slot before declaring blocked
`delegation_start` for an implement/fix can fail `CONFLICT / reason:"job_in_progress"` because the
workspace **write slot is exclusive** even though `maxParallel=2` (that cap governs the orchestrator's own
fanout, not cross-parent writes). Here the blocker was another parent's *live* mutating job:
`d310d259` on `deepseek/deepseek-flash`, parent chat `a4c6ab56` (I saw the trio with
`delegation_list({chat_id:"a4c6ab56…", scope:"all"})` → running/failed/completed). NEVER cancel or touch a
foreign parent's job. Instead: poll the blocker's status with `delegation_list scope:"all"`, and between
polls run a standalone foreground `sleep N # intentional-sleep: <why>` (a bare `sleep` chained with `&& echo`
gets blocked — split it), then **retry `delegation_start` with the SAME idempotency_key** — it re-probes the
slot atomically and starts the job the instant it frees (here it freed after ~3 min and `9097af52` started).
Only report `outcome:"blocked"` if it stays occupied past a few bounded windows (precedent: cycle 3d020d01
blocked on exactly this foreign-slot condition; the still-`doing` todo is rescheduled by the watcher next cycle).

## Operational refinements (2026-10-05, Area 3 todo 61555144, cycle ba7d0015)

**Workflow-write tools are bound to the FULL calling-chat id — omit `chat_id`.** The cycle snapshot
shows the orchestrator chat as an 8-hex prefix (`chat=ef93ac6a`), and `model_pick({chat_id:"ef93ac6a"})`
accepted that prefix. But `delegation_workflow_update({chat_id:"ef93ac6a", …})` returned
`CONFLICT: Workflow state applies only to the calling parent chat.` Dropping `chat_id` entirely let it
resolve to the real full UUID (`parent=ef93ac6a-4847-4325-…`) and succeed. Rule: for the workflow/loop
state writers, omit `chat_id` and let it default; a display prefix is not the calling identity.

**Adjudicate a same-line split fanout verdict against the implementer's OWN contract.** Here the two
reviewers disagreed on the *exact same line*: claude-sonnet-5-5 PASS'd Area 3 and explicitly cleared
`opencode-agent-ws.js`'s post-gate `if (!room._pendingOpenCodePermissions.has(requestId)) return;` as
"a human-reply race, not a delta defect"; grok-4.7 FAIL'd it because the function's own doc comment
(asserted in the same implement) says *"Every path that does not reach the advisor writes an
`advisor_skip` audit entry."* The parent re-read the code and settled it: the change introduced a
stated invariant, and the silent return violates that self-imposed invariant — so the FAIL is REAL even
though the line is a plausible race. **A doc-comment / in-code contract that the code then breaks is a
cheap tiebreaker that outranks each reviewer's runtime intuition.** Conservative aggregate = FAIL → fix
round (see the existing SPLIT-fanout note above).

**Rate both reviewers after a split (ratings feed `model_pick` review quality).** The reviewer who
caught the real defect → 5 (`great`, note the exact file:line + remedy it pinned). The reviewer who
CLEARED that same line → 4 with the **`missed_bug`** tag, even when its overall read was thorough —
a same-line miss is worth tagging separately from a "good audit." (Mandatory cases: FAIL→fix→PASS rates
the FAIL-ing review; a rejected report rates down. A split that goes to fix-but-cannot-finish is neither,
so these are discretionary-but-valuable.)

**Distinguish WHICH delegation is slot-blocked, and cap the wait against a CHAINING foreign parent.**
Prior precedent blocked on the *initial* implement. Here the implement (7 files) AND the fanout review
both completed (parent reproduced them: `node tests/approval-advisor.test.js` green, backend `npx eslint`
clean); the only unfinished step was the one-line FIX child, which could not start because foreign parent
`348f4aa9` **chained** mutating jobs — `54fa6a85` completed, then immediately `df008386` deepseek-flash —
holding the exclusive write slot **>14 min across ~6 bounded-window retries** (`delegation_list scope:"all"`
+ `sleep N # intentional-sleep:…` + retry the SAME key). A chaining parent can starve the slot
indefinitely, so cap at a few windows, then stop and report `blocked`. Finalize EXACTLY (the todo is NOT
done — review wasn't PASS):
1. rate both reviewers (above);
2. `workspace_watcher_update({action:"record_findings", todo_id, findings_hash:<sha of the one-liner>,
   findings_text:"<file:line + the precise `recordApprovalAdvisorSkipAudit({room,permissionEvent,
   approvalAction,requestId,reason:'permission_gone'})` call to add before the silent return>"})` — persists
   the fix text (not just an opaque hash) for the next cycle AND scout dedupe;
3. `workspace_memory_add({type:"decision", key:"todo-<id>-…-implemented-<N>-line-fix-blocked",
   value:"implement DONE + reproduced green; fanout = 1 PASS + 1 real FAIL (the one-liner); fix could not
   start (foreign write slot). NEXT cycle: start the single-line fix immediately, then a fresh review —
   do NOT redo the implement."})`;
4. leave the todo `doing` (never `done`);
5. `workspace_watcher_update({action:"report", outcome:"blocked", …})` — `blocked` keeps the failure budget
   intact (only `failure` spends it), and the watcher reschedules the still-`doing` todo next cycle.

**Prove a dirty-tree lint dupe / failing sibling test is NOT your child's** before a reviewer FAILs on it.
`git show HEAD:app_front/i18n/en.js | grep -c "archiveBusy:"` = **0** vs worktree `grep -c` = **4**, and the
failing suites (`approval-broker.test.js`, `opencode-permission.test.js`) only import a file the child never
touched (`lib/opencode/opencode-permission.js`, a human +72-line edit). So it's pre-existing → leave for the
human, and tell the reviewer explicitly it is **out-of-scope, not a FAIL cause**. Attribution on a ~180-path
dirty tree: `git diff --stat HEAD -- <the touched files>` bounds the footprint but the big i18n /
`sdk-rich-view.js` deltas were mostly the human's concurrent work, so combine the `--stat` with greps for the
EXACT new identifiers (`recordApprovalAdvisorSkipAudit`, `markOpenCodePermissionAdvisor`, the two i18n keys)
to confirm what the child actually added.

## Language
`cretli` TODO bodies here are Polish → instruct the child to report **in Polish** and write your
end-of-turn summary in Polish; keep code/paths/verdicts verbatim.
