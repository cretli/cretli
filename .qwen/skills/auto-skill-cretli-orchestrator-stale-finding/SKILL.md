---
name: cretli-orchestrator-stale-finding
description: As the Workspace Watcher / multi-harness orchestrator (parent), verify a delegated Scout finding against the live tree BEFORE delegating; if it is already fixed, skip the implement child — but scope the independent review to the in-tree DELTA that fixed it, because "stale" often means "someone's uncommitted change replaced the bug with a different bug" (escaped-quote privilege bypass found this way), which then requires fix→review→PASS; gate "todo done" on that review, backstop with delegation_verify only when the area has an audited catalog id (else disclose its absence and reproduce via the module's own `npm run test:<area>` script — an "Unknown review verify id" is NOT a failed review), attribute child scope by mtime on a dirty branch, and memory-dedupe before reporting success. Also covers a PRODUCT-DECISION todo whose stated current-defect is already partly satisfied in the predicate: trace the real blocker to the upstream PRODUCER (classifier), keep an out-of-scope producer fix to its sibling/idea todo, shrink the deliverable to a non-tautological regression-TEST LOCK + clarifying comment, resolve the plan scope INLINE instead of burning a premium plan child, hard-scope-lock adjacent intentional code in the brief, and do a bounded wait (delegation_list scope=all + sleeps + retry delegation_start) on a foreign parent's exclusive write slot before reporting blocked. Also: audit for the DEAD-ON-ARRIVAL time gate (an idle/grace window measured from `updatedAt` checked only at the moment the event refreshes it, with its retry path living solely in process boot — green tests faking an old timestamp cannot catch it), trace WHO CALLS the periodic path before accepting that a fix works on the live path, handle a SPLIT fanout verdict (one reviewer FAIL, one PASS on the same defect = FAIL, and verify the call graph yourself before writing the fix brief), report `blocked` (not `failure`) for foreign-slot contention because only `failure` spends the todo's failure budget, and resolve open code questions yourself so the fix brief states facts instead of guesses. Also (2026-10-05 Area 3, reaffirmed 2026-10-07 R6): workflow-write tools AND `delegation_start` reject the snapshot's chat-id PREFIX — `workflow_update` as CONFLICT, `delegation_start` as `NOT_FOUND: Chat not found` — so omit `chat_id` and let it default to the calling chat (only `model_pick` accepts the prefix); adjudicate a same-line split fanout verdict against the implementer's OWN doc invariant, rate the defect-catcher 5 / the same-line-misser 4 `missed_bug`, and finalize a FIX-round that a CHAINED foreign parent starved (>14 min, implement+review already done) — rate, record_findings the exact pending one-liner, memory "don't re-implement", leave todo doing, report blocked. Also (2026-10-07, todo ebb50cb8, cycle 822641ed — a finding that was LIVE, not stale): `delegation_list scope=all` without `chat_id` silently lists only the CALLING chat and fakes a free slot; brief ALREADY-SATISFIED finding clauses as "adjudicate, don't re-demand"; invert the in-tree test that ENCODES the vulnerability; treat a complete implement report missing its terminator as unspecified-but-reproduced rather than a reason to stop the cycle; backstop two `tests=no` reviewers by running the WHOLE `tests/*<area>*.test.js` family; and expect `self_model_rating_denied` when the child ran on your own base model. Also (2026-10-07, R6 todo 3304322f, cycle 291a8808 — parent state hygiene): `delegation_start` prints the job id TRUNCATED, so never complete a UUID from memory or a wake prompt (twice produced `NOT_FOUND` and poisoned durable loop state) — resolve it with `delegation_show` on the >=8-hex prefix, which returns the full id; a fix-start `workflow_update` that re-carries `last_verdict=FAIL` on unchanged material trips a SPURIOUS `stop=same_findings` (prevent by omitting `last_verdict`, recover with `clear_stop:true`, which resets verdict to `unspecified`); a `delegation_verify` run while a fix child is still editing reports `failed` on a half-written tree (mtime + test-count drift prove it) so re-run only after terminal AND `slot_occupied=false`; a new reason token must be registered in a CLOSED vocabulary test; and down-rate 2/`missed_bug` a reviewer that PASSed material later confirmed to hold blockers. Also (2026-10-07, R6 todo 3304322f, cycle 37280db6 — resumed after a FAILED SIBLING CYCLE, not a Scout finding): the inherited `outcome=failure` was a crashed infra child, not a code FAIL — first prove the deliverable is landed+green (reconcile local `ls` mtimes against `date -u` before calling a foreign cycle a live writer), then SKIP both re-implement AND the partial-landing delta inventory and go straight to a fresh review fanout; `delegation_verify` accepts the leaf's OWN brand-new test-file id via the dynamic catalog (the curated `REVIEW_VERIFY_CATALOG` is not the only source), and the `verify_required` gate is PER-JOB so you must verify EVERY PASS reviewer in a fanout, not just one. Also (2026-10-07, todo bb8dbad7, cycle 06361610 — foreign-slot contention as a multi-sibling CHAIN at high `maxParallel`): the exclusive write slot can be re-grabbed by a *different* sibling the instant it frees, so each CONFLICT names a new blocker UUID and polling one job to `completed` is a losing race; read `maxParallel` live (don't trust the `2` in this file); after a bounded ~13 min of same-key strikes with a disjointness check first, report `blocked` (not `failure` — only `failure` spends the todo's budget) and leave it `doing`; and when a cycle ends with ZERO delegations, persist the verified-live defect list (SYMBOL anchors) + server/API facts as a `finding` memory and the "fire implement at cycle start, grab the slot the instant it frees" instruction as a `blocker` memory, so the next cycle skips the re-audit. Also (2026-10-07, todo bb8dbad7, cycle 60ba922f — replay of the chain): a prior sibling cycle's own report OVERCLAIMS a clause as done (7fb104b0 asserted "object-fit:contain, all tests green" while `.browser-frame` had NO object-fit) → derive the landed/open split by grepping each acceptance clause's signature token in the actual file, never from a prior report's prose; `chat_show(scope=all, tail)` on the blocker parent reads disjointness + single-parent chaining directly; `blocked` (not `failure`) after ~9.5 min / 3 same-key strikes on a chaining foreign parent, leave `doing`, ONE combined `blocker` memory. Also (2026-10-07, todo 4a9133a0, cycle bcc0057e): a bare `delegation_verify` (no `ids`) can record `review_verify=passed exit=0` while the frozen catalog contains ZERO cases for your leaf's subsystem — grep the spilled >50 KB tool-result file for your area keyword before believing the pass, because a vacuous pass silently satisfies the `verify_required` hard gate; `traits.review_can_run_tests=false` is only a prior that can be wrong in the flattering direction (a `tests=no` claude reviewer really ran both suites), so read the report's numbers and re-run them rather than trusting or discounting the trait; and a NEW orchestrator chat sees `No workflow state for this chat`, so a leaf landed by earlier `outcome=failure` cycles must be proven from the tree alone. Also (2026-10-07, todo bb8dbad7, cycle 016c9fe5 — the contention POLL itself): a multi-KB brief makes `delegation_start` an expensive slot PROBE because every strike re-sends `task_text`, so poll `delegation_list({chat_id:<blocker parent>})` / `delegation_show(scope=all)` and fire the big start only once the blocker is terminal; `delegation_wait` on a foreign job returns `OUT_OF_SCOPE`; never interleave slow read-only work (baseline suites, anchor re-derivation) into the wait window or a sibling takes the slot you were watching — verify FIRST, then poll; a foreign `status=failed` child shifts your anchors mid-cycle (`session-manager.js` `:1283`→`:1629`) and can leave a red shared-suite baseline you must name in the brief as pre-existing-but-not-yours; hand the gap map off in the TODO BODY (workspace memories get budget-trimmed, the body always arrives) and prefer `ready` over `doing` when zero delegations started. Also (2026-10-08, todo 5394c80f, cycle dad57176 — the INERT-FIX case): a finding clause can be landed AND non-functional because its producer method has zero call sites (`addWsSubscriber`, `touchSessionById`, `clearChatBinding`), so grepping the fix's signature token is NOT enough — count call sites outside the defining file, because a guard that reads an always-empty map never fires and a fully green suite (9/67/22/12/9) will not tell you; that turns "stale, skip implement" into a tiny "wire it + test through the real consumer" brief and the todo must NOT close. Derive foreign-job overlap from `find -newermt` mtimes, not the blocker's todo text — the sibling whose todo read as front-end-only was editing my leaf's central `lib/browser/session-manager.js`. Also (2026-10-08, same leaf, cycle 4250aad5 — the SINGLE-BLOCKER variant of starvation): one foreign `running` job can hold the slot past a whole cycle (4 strikes in ~10 min, NO rotation to a new id), and `delegation_list` on the blocker's parent returns only status+uuid+harness/model with no timestamp, so its ETA is unknowable — cap at ~4 strikes then report `blocked` instead of guessing. Before writing a "wire the dead method" brief, read that method's RETURN contract: `addWsSubscriber(sessionId, subscriberId)` hands back a one-shot idempotent `release()`, so instructing the child to call `removeWsSubscriber` by hand is the wrong API and would fail review on double-release. In this harness a bounded wait only runs as a standalone `sleep N # intentional-sleep: <reason>` (both `sleep 45 && echo x` and a bare `sleep 100` are blocked). `model_pick` can render WITHOUT a `pickId`, so forward `pick_reason` (plus `manual_source` on a retry) rather than stalling or inventing an id. Also (2026-10-08, todo bb8dbad7, cycle bdd6c20d — the fix is starved but the review is NOT): the `job_in_progress` gate is exclusive to implement/fix, while review jobs use the SEPARATE review-fanout slots — so a mutating-starved cycle can still `delegation_start` two read-only reviews that COMPLETE, isolate the single genuinely-remaining defect, persist the FAIL verdict + regression-gate findings (`workflow_update` + `watcher_update record_findings`), and shrink the handoff to ONE named fix with an unconsumed idempotency key, instead of dying with zero delegations like the prior cycles on the same leaf. And to verify an enum→i18n map for completeness, do NOT `grep 'browser.error.<code>'` (the dictionaries are nested `browser: { error: { … } }`, so a flat dotted key returns a FALSE 0) and do NOT trust a green suite (it never catches a missing locale key) — import both locale modules in a throwaway `.mjs`, parse the enum set out of the producer file, and diff every member against both catalogs asserting a non-empty string.
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

## Step 1.5 — a fix can be LANDED AND INERT: audit CALL SITES, not presence (2026-10-08, todo 5394c80f, cycle dad57176)

Grepping the fix's signature token (the method, the property, the handler) proves the code
**exists**. It does not prove anything **invokes** it. On a multi-point audit this is the difference
between "stale → skip implement" and "live → delegate", and it is invisible to a green suite.

Real case. The 2026-10-05 audit listed 9 defects; 8 were already fixed in the dirty tree, and finding
#2's fix *looked* complete: `touchSessionById()` and `addWsSubscriber()` were implemented, and
`sweepIdle()` even contained `if (this.hasLiveWsSubscriber(session.id)) continue;`. But:

```bash
for s in addWsSubscriber touchSessionById clearChatBinding; do
  grep -rn "$s" --include=*.js . | grep -v node_modules | grep -v public/dist; done
```

Every hit was the **definition inside `lib/browser/session-manager.js`** — zero call sites anywhere
else (no `lib/browser/ws-handler.js`, no `agent-tools.js`, no test). So `wsSubscribers` stayed empty
forever, `hasLiveWsSubscriber()` always returned `false`, and the guard the fix added could never
fire: a panel that only reads state was still torn down after `IDLE_TIMEOUT_MS`. Same shape for
`touchSessionById` (the `ping` branch answered `pong` and did nothing, while `browserWsClient.js`
pings precisely as a keepalive) and `clearChatBinding` (`browser_open` still threw instead of
dropping a stale cross-workspace pointer — note `resolveChatBinding` self-heals only the
*missing-session* case, which is what made this look done).

Rules that fall out:

- **Verdict on a clause is three-way: absent / present-and-wired / present-but-inert.** For every
  fix symbol the finding's remedy introduced or relies on, count call sites **outside its defining
  file**. `1` (definition only) ⇒ inert ⇒ the clause is NOT stale. A guard that reads a
  producer-populated collection is the most dangerous form, because the guard itself *is* called
  and looks correct in review.
- **A fully green baseline does not refute inertness.** Here five suites were green
  (`browser-ws-handler` 9, `browser-session-manager` 67, `browser-agent-tools` 22,
  `mcp-browser-tools` 12, `browser-panel-wiring` 9) with all three guards dead — unit tests called
  the manager methods directly, never the `/ws-browser` handler that should call them. So run the
  suites for a *regression* baseline, never as evidence the fix works.
- **Scope collapses to wiring, and the todo must NOT close.** Don't re-implement the 8 done points
  (that risks regressing deliberate work and spends tokens); the brief becomes "wire A/B/C + add a
  regression test that drives the **real consumer path** (the handler / the tool), not the manager
  method" — a test that calls `manager.addWsSubscriber(...)` itself would re-create the illusion.
  Name the right test file for the consumer (`tests/browser-ws-handler.test.js` covers
  `createBrowserWsHandler`) and forbid the child from touching the already-fixed clauses.
- **Re-run this grep immediately before `delegation_start` and again before reporting** — siblings
  edit the same files, so inert code may get wired by someone else (or your anchors drift). Both
  re-checks here came back still-dead, which is what made the verified residual map worth handing
  off instead of a generic "not done".

**Related mtime corollary:** the disjointness check on a slot blocker ("is it touching my files?")
must be answered by actual write times, not by the blocker's todo text. Its todo read as a
front-end-only Browser-panel leaf, yet `find . -newermt '-20 minutes' -printf '%T@ %TH:%TM:%TS %p'
| sort -rn` showed it mid-write on `lib/browser/session-manager.js`, `lib/browser/url-policy.js`,
`app_front/features/browser/browserPanel.js` — i.e. **my leaf's central file**. That same listing
doubles as the liveness probe (files advancing ⇒ wait; silent ⇒ maybe wedged) and as the exact
"do not clobber / do not claim these hunks" list to paste into your child's brief.

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
- Persist loop state around the review: `workflow_update` (role/round/last_reviewer/
  last_model/`material_revision`/deadline, stable `idempotency_key` per event) before AND after the report.
  **Get the real revision from the host module, don't hand-roll it** —
  `node --input-type=module -e "import { readDelegationMaterialRevision } from './lib/delegation-material-revision.js'; console.log(readDelegationMaterialRevision('<abs cwd>'));"`
  → `79b8329dc13c+53134e31` (`<short HEAD>+<dirty fingerprint>`), NOT the `HEAD:<short>-dirty:<sha256>` shape
  I previously guessed. Re-snapshot immediately before each write (a foreign cycle editing the same tree changes
  it mid-loop — mine moved `40e05487 → 7598414b → 53134e31` inside one cycle), and eyeball the value: a pasted
  wrong revision is invisible in the response but silently corrupts the `same_findings` stop detection, which
  compares it against the last FAIL review.

## Step 4 — close the cycle
On review PASS + catalog passed:
1. `todo_show` → fresh `expected_updated_at`, then `todo_update({patch:{status:"done"}})` (a status
   change appends the changelog note; a stale CAS token is rejected).
2. `wmem_add({type:"finding", key:"todo-<id>-…-stale-fixed", ttl_ms:…, value:…})` so the
   next Scout scan dedupes this area instead of re-filing it (Scout drops areas covered by memory).
3. Optional `delegation_rate` — allowed here (the review ran on a different base model than the
   parent, satisfying the anti-self-rating rule); a thorough no-fabrication audit that honestly
   disclosed its shell limit earns 5.
4. `watcher_update({action:"report", outcome:"success", todo_ids:[…], cycle_id:<active
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
foreign parent's job. Instead: poll the blocker's status, and between
polls run a standalone foreground `sleep N # intentional-sleep: <why>` (a bare `sleep` chained with `&& echo`
gets blocked — split it), then **retry `delegation_start`** — it re-probes the slot atomically and starts the
job the instant it frees (here it freed after ~3 min and `9097af52` started).
Only report `outcome:"blocked"` if it stays occupied past a few bounded windows (precedent: cycle 3d020d01
blocked on exactly this foreign-slot condition; the still-`doing` todo is rescheduled by the watcher next cycle).

**A ~13 min wait is worth it — check DISJOINTNESS to decide how long to hold (2026-10-07, cycle d53ca2fe).**
The same CONFLICT ended the previous cycle (`b3530e63`, reported `failure`) and a retry of the identical
start here succeeded after ~13 min across 3 bounded windows. Before giving up, run
`todo_show({todo_id:<the blocker's todo from active_cycles>})` and compare its named files against your
scope: here the sibling was fixing a browser `extraHTTPHeaders` token leak (`lib/browser/session-manager.js`,
`lib/local-login.js`) — **zero overlap with my scout-editor files**, so the wait was pure slot contention and
the right call, not a stall to abandon. Disjoint → keep waiting and retry the same key. Overlapping → the
other cycle may be mid-edit on your files; then report `blocked` rather than risk a clobber. Still name the
foreign files in your own child's brief (`"to NIE są twoje pliki — nie dotykaj ich i nie traktuj zmian w nich
jako swojego wyniku"`) so it does not claim or revert someone else's hunks. Retry-key note confirmed: the
CONFLICT-rejected start persisted nothing, so replaying `mh-52-fix-r2-deepseek` verbatim created the job the
moment the slot freed.

**TRAP (2026-10-07, cycle 822641ed): `delegation_list` is NOT a slot probe unless you pass `chat_id`.**
`delegation_list({scope:"all"})` with no `chat_id` returns the **calling chat's** delegations — for an
orchestrator that has started nothing yet that is `(no delegations)`, which reads as "the slot is free" while
the foreign job is still `running` and holding it. I nearly re-fired `delegation_start` on that false signal.
The authoritative probes are:
- `delegation_show({delegation_id:<blocker UUID from the CONFLICT error>})` → `status` **and `slot_occupied`**;
- `delegation_list({chat_id:"<blocker parent chat from the error>", scope:"all"})` → their rows.
`completed` alone is not enough — wait for `status=completed` **AND `slot_occupied=false`** (that cycle:
`completed` at the 3rd poll, slot still occupied; free one poll later). Retry-key nuance: a CONFLICT-rejected
start creates no job, so the same key replays fine (prior precedent), but I used a **new** key
(`…-r1-retry1`) to remove any doubt that the rejected attempt had persisted a failed record — either works,
never reuse a key that already produced a job. Budget the wait: the foreign implement ran **~12 min**, so
110–170 s sleep windows × 4–5 polls is normal, not evidence of a stale slot.

Two more cheap probes, in this order, because the CONFLICT error already hands you both UUIDs:
`delegation_show({delegation_id:<blocker UUID>, scope:"all"})` (reads `slot_occupied` directly — no
`chat_show` round-trip needed) and one foreground `sleep 60` between polls. On 2026-10-07 (R6, cycle
291a8808) the foreign job `ed3b95c0` cleared inside **~60 s**, so reporting `blocked` without any poll
would have thrown away a whole cycle. See **cretli-orchestrator-failed-child-partial-landing** for that
run's full sequence (short lock poll → same-executor infra retry → completion brief).

### Contention can be a multi-sibling CHAIN — one blocker poll is not enough (2026-10-07, todo bb8dbad7, cycle 06361610)

Everything above assumes ONE foreign job that eventually frees. Under a high `maxParallel` (read it LIVE
from `workspace_watcher_show` — do not trust the `maxParallel=2` written earlier in this file; the live
policy here was **5**) with many `ready` todos, the single exclusive write slot is grabbed by a **rotating
chain of sibling orchestrators**: the instant one blocker's `slot_occupied` flips false, a *different*
parent's `delegation_start` wins it and the next CONFLICT hands you a **new blocker UUID**. Polling the
original blocker to `completed` then striking reliably LOSES the race. Observed sequence in one cycle:
`e4007282` (chat `4ec16544`, later `failed`) freed → immediately re-grabbed by `bc35b9d2` (chat `c963f36c`,
`qwen3.8-flash` implement) which then **never terminated** for the whole cycle.

- **Don't try to time the gap between strikes — it's a real race you can't win deterministically** when
  4–5 siblings wake on the same tick. The useful loop is: short `sleep … # intentional-sleep:` → retry the
  **same idempotency key** → read the CONFLICT's fresh blocker UUID → `delegation_show({delegation_id:<blocker>, scope:"all"})`
  to confirm it is a live foreign implement (`running slot_occupied=true`), not a stale slot. A CONFLICT-rejected
  start persists no job, so the same key replays clean (confirmed again here over 5 strikes).
- **Disjointness check FIRST, then a bounded budget.** `todo_show({todo_id:<blocker's todo from active_cycles>})`
  and compare its named files to your scope. bb8dbad7 was a front-end Browser-panel leaf
  (`app_front/features/browser/*`, `public/index.html`, `app.scss`, `app_front/i18n/*`, `tests/browser-panel-wiring.test.js`)
  → disjoint → pure contention, worth holding. Same files → the sibling may be mid-edit on your target;
  report `blocked` immediately rather than risk a clobber or a false "already fixed" audit next cycle.
- **A chain that never frees in ~13 min is a legitimate `blocked`, not a failure to outlast.** 5 strikes over
  ~13 min, all CONFLICT, blocker never terminal → STOP. `outcome:"blocked"` does NOT spend the todo's failure
  budget (only `failure` does); leaving the todo `doing` is correct — the watcher reschedules it.
- **CORRECTION (2026-10-08, todo 727be356, cycle 79fa1811): "blocked + reschedule" is only right for
  TRANSIENT contention. For a permanent/human-gated blocker it is an unbounded loop**, because `blocked`
  does not merely skip the counter — `lib/workspace-watcher-cycle-close.js` runs
  `else delete failures[primaryTodoId]` and clears `backoffUntil`, so `maxConsecutiveFailures` can NEVER
  engage and the watcher re-claimed the same leaf 5 times in ~40 min (every prior cycle had followed the
  advice in this file and restored `ready`). Do NOT restore `ready` when the blocker is structural; park
  the leaf on `status:'idea'` (the only MCP-reachable lever — `blockedReason` is stripped by
  `TODO_PATCH_KEYS` in `lib/mcp/builtin/todo-tools.js`) and verify with `todo_next_ready`. Full procedure:
  **cretli-break-blocked-loop**.
- **pickId nuance (already covered in the sibling skills, restated):** `model_pick`'s compact line carried **no
  pickId**, so I OMITTED `pick_id` and put full reasoning in `pick_reason` (an honest `unknown` origin beats a
  fabricated link — never pass your `idempotency_key` as `pick_id`; recover the real id from
  `data/model-pick-decisions.json` only if you actually need the auto-provenance).

**The handoff that makes a zero-delegation cycle cheap:** when you spent the whole cycle verifying but started
nothing, do NOT make the next cycle re-audit. Before reporting, write TWO durable facts:
1. a `finding` memory keyed to the todo holding the **verified-live defect list with SYMBOL anchors** (the
   audit's `file:line` numbers were stale — re-derive them) plus every **server/API fact** the implement child
   needs (which input kinds exist, which are gated, what defaults are, the rate-limit interval); and
2. a `blocker` memory recording the contention and the recovery instruction: *"fire `delegation_start` for
   implement IMMEDIATELY at cycle start (verification is already in the finding memory) and re-strike the
   instant any blocker's `slot_occupied` flips false — contention is survivable only by grabbing the slot
   fast, not by a fixed-interval wait."*

That converts a wasted cycle into a one-line pickup next time. Also do a final live re-check right before
reporting: I confirmed every cited defect was STILL present (nothing had been fixed by a sibling), so the
`finding` memory is trustworthy handoff state, not a stale snapshot.

### Poll CHEAP, fire ONCE — a big brief makes `delegation_start` a bad probe (2026-10-07, todo bb8dbad7, cycle 016c9fe5)

The advice above ("short sleep → retry the same idempotency key") assumes the start is cheap to resend. It
isn't when your implement brief is a 6–8 KB clause-by-clause payload: every strike re-sends the whole
`task_text`. Same leaf, next cycle, `maxParallel` had risen to **10** and three consecutive cycles reported
`blocked`. What actually worked / what I'd do again:

- **The loop is: cheap poll → fire the big start only when the blocker is terminal.** Poll
  `delegation_list({chat_id:"<blocker parent chat from the CONFLICT>"})` — its rows are one line each
  (`running  fd331bc8-…  qwen/qwen3.8-flash`) — or `delegation_show({delegation_id:<blocker>, scope:"all"})`
  to read `slot_occupied`. Reserve `delegation_start` for the moment the blocker flips terminal.
- **`delegation_wait` cannot poll a foreign job** — `delegation_wait({ids:[<blocker UUID>]})` returns
  `OUT_OF_SCOPE: Delegation wait is limited to jobs started by this parent chat`. Don't try to long-poll
  your way through someone else's lock; sleep + list is the only path.
- **NEVER interleave slow read-only work into the waiting window.** This is how I lost the slot for real:
  blocker `fd331bc8` ended `status=failed` and freed the slot — and I spent the next ~2 minutes measuring
  the test baseline and re-verifying anchors, so by the time I fired, `3fa75f28` (parent `8eccd2dd`) already
  held it for another >10 min. Sequence the cycle as: (a) verify tree + derive anchors + run baseline
  suites + compose the full brief, THEN (b) enter the poll loop and fire instantly. Anything you were going
  to check "while waiting" belongs before the loop.
- **A foreign `status=failed` child does not just free the slot, it mutates your target files.** Here it had
  grown `lib/browser/session-manager.js` to 2673 lines/104 KB, so my verified anchors DRIFTED mid-cycle
  (`navigate()` `:1283` → `:1629`, `page.goto` → `:1646`, per-tab `active` → `:1755`/`:2652`) — re-derive
  anchors immediately before composing, and in the brief hand the child SYMBOLS plus `~:line` with a
  "grep the symbol, lines may have moved" warning. `node --check` said the file was fine while
  `node tests/browser-session-manager.test.js` came back **52 pass / 1 fail** (`not ok 38 -
  getVisibleElements filters invisible/zero-size nodes and bounds the listing`) — a red baseline the foreign
  cycle left behind, owned by ITS leaf (`5394c80f`). Paste that exact failing case into the brief as
  "pre-existing, NOT yours: don't fix it, don't delete it, add no NEW failures", and report that it was red
  before your work.

### Tighten the FREE→start hop to ONE call: local store poll + pre-minted pick (2026-10-07, todo 63fe60ce, cycle c5fe92d4 — 5 strikes, ~50 min, 0 delegations)

Two refinements to everything above, both learned by losing the race on my *own* free windows:

- **Poll the on-disk store, not MCP, to time the shot.** One foreground `node` loop reading
  `data/delegations.json` (path discoverable via
  `grep -rn "resolveDataPath('delegations.json')" lib/`) at 3–5 s cadence, exiting the instant no
  non-terminal row has `assignment ∈ {implement, fix}`, is cheaper and ~10× tighter than
  `delegation_list`/`delegation_show` round trips:
  ```js
  const T = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
  function busy() {
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    const r = Array.isArray(d) ? d : (d.delegations || d.records || d.items || Object.values(d));
    return (r || []).filter((x) => x && !T.has(String(x.status))
      && (x.assignment === 'implement' || x.assignment === 'fix'));
  }
  ```
  The store is a bare object keyed by UUID in this build — always unwrap with that fallback chain
  (`rows.filter is not a function` is the tell). **Caveat:** rows carry `status`/`assignment`/
  `parentChatId` but **not `slot_occupied`**, so `FREE` here ≠ server-side free. Use it to time the
  one shot; the `CONFLICT` text remains the authority on who holds the slot. It also gave a clean
  read of the blocker's age (`createdAt` at 21:39 vs 21:50 → 13 min in, live not orphaned), which is
  what justified holding instead of declaring a stale slot.
- **Mint the pick BEFORE entering the wait loop.** `pick_id` TTL is 30 min. If you wait for FREE and
  *then* run `model_pick` → read `data/model-pick-decisions.json` for the pickId → `delegation_start`,
  that ~15 s hop is exactly the window a sibling wins. Observed twice in one cycle: FREE at
  22:18:39 → re-picked → rejected (blocker `c1e17d9e`, parent `5f636435`); FREE at 22:23:46 → fired the
  still-valid 22:18 pick directly → **still** rejected in <15 s (blocker `f96d5079`, parent `38902111`).
  At `maxParallel=10` a single-call hop is necessary but not sufficient — so never enter the loop with
  <15 min of pick left, and treat FREE as "fire now, no other tool call first".
- **Cap real strikes at 2–3, not 5: the brief costs double.** The `CONFLICT` error echoes your
  **entire `task_text` back into the transcript**, so a 6–8 KB clause-by-clause brief costs ~2× per
  strike (5 strikes ≈ one extra full brief of context) and buys nothing beyond the blocker's two UUIDs,
  which the store poll gives for free. After 2 failed immediate grabs, switch to the handoff below;
  ~50 min of holding the loop produced zero progress here.
- **Disjointness may be un-checkable — that means a SHORTER budget, not a longer one.** The documented
  `todo_show(<blocker's todo from active_cycles>)` was impossible: blocker parent `8eccd2dd` was not in
  `watcher_status.active_cycles` at all (not a watcher cycle). Fall back to
  `delegation_show({delegation_id:<blocker>, scope:"all"})` / `chat_show` on the parent UUID from the
  error. If you still cannot identify the foreign scope, that is **unknown overlap** → stop earlier.
- Confirmed again, cheaply: a `CONFLICT`-rejected start persists nothing, so the **same
  `idempotency_key` and same `pick_id` replay clean** across all five strikes; `ready` over `doing`
  when zero delegations started; and the handoff `finding` memory can point at the *brief itself*
  (it lives in this chat's `delegation_start` args — `chat_history`/`chat_show` on the orchestrator
  chat beats re-authoring it next cycle).

### The only lever you control is PAYLOAD LENGTH — put the brief on disk and strike with a pointer (2026-10-08, todo aa928d58, cycle 6c6ca985)

This cycle re-confirmed that tight polling does not help and found what does. 5 strikes over ~18 min,
blocker chain `6d822ff8` (parent `48894d1a`, todo `5394c80f`) → `b4a6575a` (parent `74503ea0`, todo
`63fe60ce`) → `68fdf55b` (parent `5f636435`), 0 delegations, no product file touched.

- **The "watch it flip, then fire" hop is unwinnable for an LLM parent, proved directly:**
  `delegation_list({chat_id:"48894d1a…", scope:"all"})` returned `completed 6d822ff8…` and my very next
  tool call — the start — came back `CONFLICT` with a brand-new blocker `b4a6575a`. Two adjacent turns
  are already too slow; the observation is always of a window you have missed. Stop trying to time it
  and instead shorten the thing you fire.
- **Write the full brief to a gitignored scratch file, then strike with a 3–4 line pointer.** `data/` is
  gitignored (`.gitignore:7:data/`) and `data/tmp/` already exists; confirm with
  `git check-ignore -v data/tmp/x.md` before relying on it. Path convention:
  `data/tmp/<todo8>-implement-brief.md`. The `task_text` becomes:
  *"Read `/abs/data/tmp/<todo8>-implement-brief.md` with your file tool FIRST; it is the complete brief.
  Satisfy every numbered criterion and every evidence item. Edit only `<file A>` and `<file B>`; no
  commit/push/merge. End with exactly `TASK: implement` / `VERDICT: PASS|FAIL|BLOCKED`."*
  Delegation children have file-read tools, so a pointer loses nothing — and it fixes the two costs the
  section above named: generation latency (a ~2.5k-token brief takes tens of seconds to emit, which is
  exactly the hop a sibling wins) and the `CONFLICT` echo (the error re-prints your entire `task_text`,
  so 5 full-brief strikes ≈ 2 extra briefs of context).
- **Author the file BEFORE the loop, never mid-loop.** I switched payloads after strike 2, which meant
  writing the file and then re-composing the call — the same "never interleave slow work into the
  waiting window" mistake in a new costume. Sequence: verify tree + prove the finding live + write the
  brief file + `wmem_add` the same text + mint the pick → *then* start striking.
- **Keep the brief in BOTH places.** A `data/` scratch file can be wiped by anything that cleans the
  runtime dir, and memories get budget-trimmed; the todo body (next section) is the third copy. The
  file itself must restate the dirty-tree caveat ("the tree is DIRTY — expected; edit only these two
  files") and must not be committed — say so inside it, not only in the pointer.
- **Strike budget with short payloads: 3, separated by one `sleep … # intentional-sleep:` each — then
  report.** The earlier "cap at 2–3" was about *expensive* briefs buying nothing. A short strike is
  nearly free, so 3 is the right number; beyond that you are out-waiting a rotation you cannot win (this
  cycle's 5th strike hit the *same* `68fdf55b` as the 3rd — the chain was not even turning over). Then
  `outcome:"blocked"` (never `failure`: only `failure` spends the todo's failure budget), `ready` over
  `doing` when zero delegations started, and name the scratch-file path in both the report and the memory
  so the next cycle's first action is one short call.
- **You cannot enumerate your rivals.** `5f636435` held the slot twice and appears nowhere in
  `watcher_show`'s `active_cycles` (the same foreign chat that starved cycle `c5fe92d4` the previous
  night — a *persistent* non-watcher competitor). The watcher snapshot undercounts contention, so "N
  active cycles" is never a basis for estimating when the slot frees.

### Hand off through the TODO BODY, not only memory — and consider `ready` over `doing`

Precedent above says "leave the todo `doing`, write two memories". Memories are **budget-trimmed** in the
cycle prompt (`WORKSPACE MEMORY` showed "107 older/lower-scope fact(s) omitted to stay within the memory
budget"), so a `finding` memory can silently fail to reach the next orchestrator. The todo body always
arrives with the claim. So in addition to the memories, `todo_update` a compact verification block INTO the
body: the landed/open split with live anchors, the exact pre-existing red test, the blocker UUIDs and the
wait that produced them. Keep the original audit text verbatim and append under a `---` separator marked
with cycle id + `material_revision` — the next cycle must be able to tell which generation of audit it is
reading. Status nuance: this cycle set `ready` instead of leaving `doing` (one call, `patch.status` +
`patch.body`, CAS `expected_updated_at` from `todo_show`), which makes the item immediately claimable and
gets a changelog note for free. Both have worked here — `bb8dbad7` was re-claimed by the watcher in every
case — but prefer `ready` when you started ZERO delegations (nobody is doing this work) and `doing` when
half the loop is genuinely in flight.

### A prior sibling cycle's own report OVERCLAIMS — derive landed/open from the TREE, never from its prose (2026-10-07, todo bb8dbad7, cycle 60ba922f)

When the leaf was partly worked by an EARLIER cycle that reported `success`-sounding prose (here `failure`,
but its body narrated "done, all tests green"), that narrative is a hypothesis, not a diff. Cycle 7fb104b0
(codebuddy/hy3, no MCP tools → implemented directly on disk) claimed it landed the whole fix including
"`object-fit:contain`" — but grepping the live tree showed `.browser-frame` still had ONLY
`max-width:100%; height:auto`, no `object-fit`/`max-height` at all. Trusting the report would have made me
drop that clause from the next brief and the leaf would close with the overflow bug intact. So the
landed-vs-open split you hand off MUST come from grepping each acceptance clause's **signature token in the
actual file** (the property, the symbol, the handler), plus running the suite — not from what the prior
report asserts it did. A prior report claiming a clause done is the *easiest* false-positive to inherit.
Concretely for bb8dbad7 the parent-verified split was: LANDED = wheel/drag-swipe→coalesced scroll, pointer
`tap` when `viewport.hasTouch`, mobile/desktop `resize` toggle, `clearFrame()` on tab/nav switch,
`touch-action:none`, `mobileTitle`/`desktopTitle` keys; STILL OPEN = object-fit/fit-to-window height,
`reloadTabs` must pick `tabs.find(t=>t.active===true)` not `tabs[0]` (server already returns the `active`
flag in `listTabs`), bare-host URL→`https://` normalize, one bounded ~520 ms retry after a 429 REST refresh,
`errorText(err)` must map `err.code`→`t()` i18n, and `closeSession()` confirm-before-DELETE. That six-item
open list is the whole handoff value.

**Disjointness can be read from the blocker's OWN narration, not just `todo_show`.** When the CONFLICT hands
you a foreign parent chat, `chat_show({chat:"<blocker parent UUID>", scope:"all", tail:12})` shows which leaf
it is mid-implement on and whether it is *chaining its own children* — here parent `5f636435` was on a
different leaf (`830f24a3`) and, the instant its `65ecea7a` (qwen3.8-flash) went `failed`, immediately started
`06abbf48` (deepseek-flash) on the same leaf, re-grabbing the exclusive slot. That single-parent chaining is
what starved the slot; disjoint file set → it was pure contention worth holding. I held ~9.5 min over 3
`delegation_start` strikes (keys `r1`,`r1`,`r2` — a CONFLICT-rejected start persists nothing so the same key
replays clean), all `CONFLICT/job_in_progress`, blocker never terminal in-window → reported `blocked` (NOT
`failure`; `blocked` does not spend the todo's failure budget), left the todo `doing`, and wrote ONE
combined `blocker` memory carrying both the verified landed-vs-open list and the contention/recovery
instruction. `model_pick` again returned the orchestrator's OWN base model (`qwen:qwen3.8-flash`), so a later
`delegation_rate` on that implement child would be `self_model_rating_denied` — and its compact line still
carried no `pickId`, so I omitted `pick_id` and put reasoning in `pick_reason`.

### "Blocker terminal in my poll" ≠ "the slot is free-and-mine" — the grab is a lottery, not a timing problem (2026-10-07, todo aa928d58, cycle 789581b4)

I executed the disciplined loop from this file **to the letter** — verify the tree fully, compose the whole
brief, then poll `delegation_list({chat_id:"<blocker parent chat>"})` (one-line rows) and fire the big
`delegation_start` the instant the blocker flipped terminal — and it **still** lost. Observed: blocker
`8244db43` (parent `e527ce63`, disjoint todo `bb8dbad7`) went `failed`; within that single ~75 s poll window
a *different* parent `74503ea0` (cycle `a4da4caf`, disjoint todo `63fe60ce`) had already grabbed the slot as
`f5834281`, so my fire (same unconsumed key `mh-aa928d58-789581b4-implement-r1`) hit `CONFLICT` again. 2
strikes, ~9 min, ZERO delegations. Confirms the "Tighten the FREE→start hop to ONE call" advice from the
other side: **at `maxParallel=10` with ~5–6 concurrent cycles, a blocker going `failed`/`completed` in your
poll is only the *necessary* precondition — ~5 siblings fire on the same edge, so winning is luck, not a
tighter poll.** Stop trying to out-time it; treat the grab as a lottery ticket you buy cheaply.

The corollary tactics that actually carried value this cycle:

- **Do NOT keep doing slow read-only work after the blocker flips.** I verified the finding completely
  *before* entering the poll loop (correct), so the loss was purely the race, not wasted interleaving — a
  red shared baseline left by the failed foreign child is something to name in the handoff, not something to
  chase live.
- **For a chronically-starved leaf whose finding you've ALREADY fully verified, the highest-value handoff is
  a single `context` memory carrying the ENTIRE ready-to-paste `task_text` brief verbatim + the exact
  unconsumed `idempotency_key` + the live `material_revision` + the gate-chain / local `# pass 1 / # skipped
  0` proof.** The winning next cycle then does a pure copy-paste `delegation_start` at cycle start with **no
  re-audit and no `chat_show`/`chat_history` round-trip to recover the brief.** (This refines the earlier
  "point at the brief in `chat_history`" advice — inlining it into one memory removes the lookup hop that,
  per the section above, is exactly the window a sibling wins.) A CONFLICT-rejected start persists nothing,
  so that same key replays clean for whichever parent finally wins.
- **`chat_show({chat:"<blocker parent>", scope:"all", tail})` on the winner often reveals it was ALSO
  starved by the same chain** (this run it narrated five prior `CONFLICT` strikes of its own) — that is
  strong evidence the contention is workspace-wide scheduling, not your bad luck or a bad brief, and belongs
  in the `blocked` report as the root cause + the ops ask (`maxParallel` → 1–2 / one mutating slot per leaf /
  serialize autopilot cycle starts).
- Reaffirmed: `blocked` (NOT `failure` — only `failure` spends the todo's budget) + restore `ready` when zero
  delegations started + disjointness confirmed via the blocker's todo before holding at all.

## Round shape when the finding is LIVE (2026-10-07, todo ebb50cb8, cycle 822641ed)
Steps 0–2 above conclude "already fixed". The opposite outcome — the defect is **still in the tree** — is the
ordinary path, but this run produced four brief-writing and adjudication refinements worth keeping.

**First verify the finding clause-by-clause, because parts of it may already be dead.** The todo claimed three
defects; two were already satisfied in-tree (`SENSITIVE_HEADERS` already contained the header name, and
`buildCrossOriginHeaders` already zeroed it via `isSensitiveHeaderName`). Only the context-wide
`extraHTTPHeaders` was live. Put those two in the brief as *"already satisfied before this change — verify it,
do NOT re-demand it"*, otherwise the reviewer FAILs on a phantom or the child "fixes" working code. Same device
for the finding's **optional alternative** (it suggested a one-shot/TTL token): label it `OUT OF SCOPE by
decision` in BOTH the implement and review briefs, or a cheap model will implement it and a reviewer will
grade the scope creep.

**Grep the suite for assertions that ENCODE the bug before delegating, and name them in the brief.** Here
`tests/browser-session-manager.test.js` asserted `contextOptions[0].extraHTTPHeaders['x-cretli-local-login']`
was a 48-char string — i.e. the "green" suite was locking in the vulnerability. Tell the child to INVERT that
assertion and to prove the bite (run the new tests against the unmodified code first and paste which cases
went red). It also has to keep neighbouring assertions in the same test alive, or the rewrite silently deletes
coverage. Ask the reviewer the converse question: *name a code change that keeps the suite green while
reintroducing the defect* — the claude reviewer did a real mutation analysis and that is what justified its PASS.

**Guard the child against fake-harness blind spots.** A Playwright stand-in cannot observe a context-wide header
at all, so the "foreign origin gets no token" test passes pre-fix and is a contract **lock**, not evidence. Say
so in the brief (and let the child label bites vs locks) so the review does not count it as a regression test.

**A complete implement report that is missing only the `TASK:/VERDICT:` terminator is `unspecified`, but it is
NOT a reason to end the cycle.** The literal loop rule ("PASS on implement → review") would stop here and waste
finished, green work. What I did instead: read the whole body across pages (`delegation_show` + `next_cursor`),
reproduced every claim myself (all four suites + `npx eslint` exit 0), read the actual `git diff` rather than
trusting the report, then continued to the review fanout and closed the leaf on **two independent PASS reviews**.
Record the nuance honestly in `workflow_update.report_text` (verdict unspecified + what substituted
for it). Note the delivery failure was on the child's side — see the `cretli-delegation-report-delivery` skill
(generation truncates a long report before the terminator).

**Backstop when BOTH fanout reviewers are `tests=no` and the area has no catalog id.** `delegation_show` printed
`review_verify: not recorded (required: executor cannot run the runner)` on each job — that is the visible
`verify_required` flag. Do **not** call `delegation_verify` with an invented id (again: `lib/sdk/sdk-review-verify.js`
has no `browser` row). The strong cheap substitute is the whole area family, not just the cited files:
`ls tests | grep -iE "browser|local-login"` then run every hit — 18 files / 155 tests green, which is what made
the PASS acceptable. Disclose the catalog absence in the cycle report and memory.

**`delegation_rate` can be refused for the child you most want to rate.** The implement job ran on
`qwen3.8-flash` — the same base model the orchestrator chat was running on — so rating it trips
`self_model_rating_denied`. Skip it (do not work around it) and rate the two reviewers instead (both 5 here: one
did mutation analysis, the other explicitly declared its verdict static-only and asked the parent to run the
suites — disclosing a tool limit is not a report defect).

**Attribution warning in the review brief is mandatory on a shared hot file.** `lib/browser/session-manager.js`
and `docs/ARCHITECTURE.md` also carried ANOTHER active cycle's uncommitted hunks (`removeBrowserScreenshots` +
a closeSession screenshot cleanup). The child correctly excluded them; the brief still had to name them, or the
reviewer would have judged someone else's WIP as this fix's scope creep. Cross-check which files other active
cycles are in before writing the brief — `watcher_show` lists `active_cycles` with their todo ids.

## Operational refinements (2026-10-05, Area 3 todo 61555144, cycle ba7d0015)

**The chat-id is bound to the FULL calling-chat UUID — omit `chat_id` on the state writers AND on
`delegation_start`.** The cycle snapshot shows the orchestrator chat as an 8-hex prefix
(`chat=ef93ac6a`), and `model_pick({chat_id:"ef93ac6a"})` accepted that prefix. But `workflow_update`
returned `CONFLICT: Workflow state applies only to the calling parent chat.` AND, confirmed 2026-10-07
(todo 3304322f R6, cycle 291a8808), `delegation_start({chat_id:"b2ef7314", …})` — the FIRST child start
of the cycle — returned `NOT_FOUND: Chat not found: b2ef7314`, a *different* symptom from the
workflow_update CONFLICT (it resolves the prefix against the chats table and misses, because the
snapshot prefix is not the stored full id). Dropping `chat_id` entirely let both resolve to the real
full UUID (`parent=b2ef7314-652a-46f3-…` / the calling chat) and succeed. Rule: on every
workflow/loop-state writer **and** `delegation_start`, omit `chat_id` and let it default to the
calling chat; a display prefix from the cycle snapshot is not a usable calling identity. `model_pick`
and `delegation_wait/show` (which take delegation UUIDs, not chat ids) are unaffected — **but see the
job-id bullet below: `delegation_start` does NOT hand you a full delegation UUID, and composing one from
memory silently fabricates digits.**

**A known-slow implementer (`qwen: slow_read_loop`) is worth a `loop_wakeup` heartbeat, not a long
in-turn `delegation_wait` grind.** `model_pick role=implement` can return the *same* model the
orchestrator chat runs on (here `qwen:qwen3.8-flash`), and that model stayed `status=running` for
~12 consecutive `delegation_wait({timeout_ms:25000})` polls (~5 min of turns) with no progress signal.
Rather than burn the cycle's context on busy-polls, arm ONE `loop_wakeup` (600 s, prompt carrying the
cycle identity: todo id, parent chat FULL UUID, delegation UUID, next steps) and keep a couple of
bounded in-turn polls as a cheap fast-path — if the child reaches terminal during those polls you
never needed the wake. The watcher cycle does not need to finish inside one turn; the wake resumes
poll → read report (`delegation_show`, follow `next_cursor`) → review → close. Corollary: because
`implement_pick` returned the orchestrator's own base model, a later `delegation_rate` on that child
would trip `self_model_rating_denied` (see the rate bullet above) — expect that, don't work around it.

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
2. `watcher_update({action:"record_findings", todo_id, findings_hash:<sha of the one-liner>,
   findings_text:"<file:line + the precise `recordApprovalAdvisorSkipAudit({room,permissionEvent,
   approvalAction,requestId,reason:'permission_gone'})` call to add before the silent return>"})` — persists
   the fix text (not just an opaque hash) for the next cycle AND scout dedupe;
3. `wmem_add({type:"decision", key:"todo-<id>-…-implemented-<N>-line-fix-blocked",
   value:"implement DONE + reproduced green; fanout = 1 PASS + 1 real FAIL (the one-liner); fix could not
   start (foreign write slot). NEXT cycle: start the single-line fix immediately, then a fresh review —
   do NOT redo the implement."})`;
4. leave the todo `doing` (never `done`);
5. `watcher_update({action:"report", outcome:"blocked", …})` — `blocked` keeps the failure budget
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

## Operational refinements (2026-10-07, R6 todo 3304322f, cycle 291a8808 — parent-side state hygiene)

**Never compose a delegation UUID from memory or from a wake prompt — resolve it with a prefix lookup.**
`delegation_start` prints the job id TRUNCATED: `Started delegation b457b9ad-c697-44f9-…`. Twice in one
cycle I "completed" such an id from imagination and the next call died:
`delegation_wait` → `NOT_FOUND: Delegation not found: 8d5c4d32-…` (a UUID that appeared in **no** tool
response). Worse, the invented id had already been written into durable `workflow_update.report_text` and
into a `loop_wakeup` prompt — a wake prompt is exactly how a wrong id survives the turn that invented it.
The cheap, authoritative remedy — **but only for your OWN chat's job**:

```
delegation_show({ delegation_id: "b457b9ad" })   // prefix >= 8 hex, NO scope argument
```

The response prints the **full** `delegation_id` plus `attempt_id`, `run_id`, `executor`, `child_chat` and
`review_verify`. Copy those verbatim into every subsequent `delegation_wait` / `delegation_verify` /
`delegation_rate` / `workflow_update` and into any re-armed wake.

**CORRECTION (2026-10-07, same cycle 291a8808, later in the session): prefix resolution does NOT work with
`scope:"all"`.** An earlier bullet in this file claimed `delegation_show` accepts prefixes unconditionally.
It resolved `b457b9ad` fine (own chat, no scope), but `delegation_show({delegation_id:"77171a74", scope:"all"})`
for a FOREIGN blocker returned `NOT_FOUND: Delegation not found: 77171a74`. The real rule is:
`delegation_show` accepts a delegation-id prefix **only within the calling chat**; a cross-chat lookup
(`scope:"all"`, used to inspect the foreign mutating lock) needs the **full UUID**, which the CONFLICT error
itself already hands you verbatim — copy it out of the error body, never retype it. So:
own-chat job id → bare `delegation_show` prefix; foreign blocker id → paste the full UUID from the error.
`delegation_list({limit:50})` is the other reliable resolver, but note **rows come back OLDEST-first**, so a
job you just started sits at the END and a small `limit` (6–10) silently hides it — that looked like "my start
never persisted" and nearly caused a duplicate `delegation_start`. Corollary: `workflow_update` and
`delegation_start` reject chat-id prefixes (above); if bad ids are already in durable loop state, correct them
with a **new** event under a **different** `idempotency_key` (replaying an applied key with changed params is
`CONFLICT`).

**A fix-start `workflow_update` that re-carries `last_verdict:"FAIL"` trips a SPURIOUS `stop=same_findings`.**
The server counts "a second identical FAIL with unchanged `material_revision`" to stop loops that keep
re-reviewing the same defect — but it cannot tell a real second FAIL from your own bookkeeping echo. Observed
sequence: review FAIL recorded (`verdict=FAIL`, `material=79b8329+1f95612f`) → the *fix-round* state event
repeated `last_verdict:"FAIL"` on that same material → response came back
`round=2/4 verdict=FAIL stop=same_findings`, `same_fail=2`, even though only **one** review FAIL had ever
happened and the fix was already running. Left alone, that stop reason gates the post-fix re-review.
Recovery: a new event with `clear_stop: true` and an empty `stop_reason` — note it also **resets
`last_verdict` to `unspecified`**, which is the correct semantics for "a fix is in flight". Prevention: when
opening a fix round, record only `role`/`round`/`last_implementer`/`last_model`/`material_revision` and
**omit `last_verdict`** until a new review actually returns.

**Mid-flight `delegation_verify` reads a half-edited tree — do not treat it as a verdict.** Running the
host catalog while a fix child is still writing its own files produced `review_verify=failed exit=1` with
2 failures in the leaf's central test file. Cross-check mtimes (`ls -l --time-style=+%H:%M:%S <files>`) and
watch the test COUNT: it had gone 10 → 11 with one case renamed, i.e. the child was actively editing. Re-run
after `delegation_wait` reports terminal **and** `slot_occupied=false`; the same call then returned
`review_verify=passed exit=0` (11/11, 22/22, 14/14, 18/18 + 2 OK). A failure recorded mid-edit is not
evidence — and acting on it would have spent a whole extra fix round. Related: when you widen a producer's
answer with a NEW reason token (e.g. `no_live_run_match`), check whether a test pins that vocabulary as
CLOSED (`tests/recovery-contract.test.js` asserts "transcript loss reasons are a closed vocabulary") and
require the child to register the token rather than emit an unlisted string.

**A reviewer's PASS that missed confirmed blockers is rateable and should be tagged.** Mandatory rating
cases aside, down-rate the reviewer that approved material later found to hold real blockers — here 2 stars
with `missed_bug`, because its consumer audit listed the exact lines and judged them correct (see the
existing split-fanout rate bullets). Rate the fix child `great` once you reproduced its hunks yourself. If
the fix child ran on your own base model expect `self_model_rating_denied` (it did not here: parent
`qwen3.8-flash` vs fixer `sdk/composer-2.5`).

## A bare `delegation_verify` PASS can be VACUOUS for your leaf — grep the spilled output for coverage (2026-10-07, todo 4a9133a0, cycle bcc0057e)

The earlier bullets cover the loud failure mode (`"Unknown review verify id"` when you pass an invented id).
The dangerous one is silent: `delegation_verify({delegation_id})` **without `ids`** runs the whole frozen
catalog and came back `review_verify=passed exit=0 verdict=PASS` on BOTH fanout jobs — for a leaf that only
touches `lib/browser/*`, and the catalog has **zero** browser cases (`grep browser` over the full output:
no matches). The hard `verify_required` gate was therefore satisfied while proving nothing about the change
under review.

- The result is >50 KB and gets **spilled to a file**: the tool response prints a preview plus
  `Full output saved to: …/data/qwen-home/.qwen/tmp/<hash>/tool-results/<call_id>.txt`. Grep THAT path for
  your area's keyword before you believe the pass — the preview only shows the first ~10 unrelated ids.
- Coverage check is cheap and decisive: `0 hits` ⇒ the recorded pass is vacuous, and the only real evidence
  is the area's own suites. Run the whole family, not just the two cited files
  (`ls tests | grep -iE "browser|local-login"` → every hit), and state in `workflow_update.report_text`,
  in the cycle report and in a `finding` memory that `review_verify=passed` ≠ area coverage, so the next
  cycle does not treat the flag as a green light.
- The `verify_required` gate is per-job: call `delegation_verify` once per PASS reviewer in a fanout
  (confirmed again — both jobs needed their own record).

## `traits.review_can_run_tests` is a PRIOR and can be wrong in the flattering direction — read the report, not the trait

`model_pick` flagged BOTH reviewers as `tests=no  verify=required` (claude and sdk/grok). The claude
reviewer nevertheless ran both suites and pasted real counts (`53/53`, `22/22`); grok honestly disclosed
"Testy: nie uruchomione. Narzędzie shell jest w tym harnessie niedostępne". So:
- Never discount a child's claim of having run tests because the trait said it could not — spot-check the
  numbers yourself (I re-ran both suites before and after the reviews; they matched).
- Never *accept* them either: the trait is why the parent must reproduce regardless. A disclosed "I had no
  shell" is not a report defect (rate 5 with `great` for full file:line evidence + honest limitation).

## The exclusive slot is held by MUTATING jobs only — a running foreign `review` does NOT block you (2026-10-07, todo aba9a48d, cycle acac47f0)

This is the fact that decides *when* to fire, and it cost four blind 2–5 min `sleep` windows to learn. The
per-workspace write lock covers `assignment=implement|fix` **only**. Read the blocker parent's rows with
`delegation_list({chat_id:"<blocker parent full UUID>", scope:"all", limit:10})` and classify each row by
assignment before you wait a single second — the compact rows print `harness/model`, so infer + confirm:

- A foreign parent can run its **review** (`sdk/grok-4.7`) *concurrently* with a *different* parent's
  implement. Observed: `5f636435`'s implement `06abbf48` went `completed` and its review `0edb7a15` started
  running; my next `delegation_start` was still rejected — but the CONFLICT named a **new** blocker,
  `fd331bc8` (`qwen` implement) owned by a **different** parent `da570f96`. The review was never the reason.
  ⇒ **Never wait on a running foreign `review` row.** When an implement/fix row flips terminal, the slot is
  immediately contestable — fire then, even while that same parent is mid-review.
- `qwen/qwen3.8-flash` and `deepseek/deepseek-flash` were implementing for other parents; `sdk/grok-4.7` was
  reviewing. If you cannot tell an assignment from the model alone, `chat_show({chat:<parent>, tail:6, scope:"all"})`
  narrates it ("Implement child started…", "waiting for the review fanout…").

**Budget the hold honestly: this cycle burned ~45 min and 4 same-key strikes and still landed zero
delegations**, because `maxParallel` had been raised to **10** (read it LIVE from `watcher_show` — the `2`
and even the `5` written elsewhere in this file are both stale; contention scales directly with it). At
`maxParallel` ≥ 5 with several `ready` todos, expect a sibling to win every gap you find. Practical rule:
**2–3 strikes over ≤15 min**, not 4–5 over 45 min. The prior bullets' `~9.5 min / 3 strikes` and
`~13 min / 5 strikes` precedents are both inside that band; this run's 45-minute hold produced nothing and
is the counter-example. Time your own cycle start against the chain: a sibling cycle that has just begun its
implement is ~15 min from freeing the slot, so a mid-chain arrival is bad luck, not a signal to grind.

**`sleep` gating is stricter than "no `&&`":** both `sleep 150; echo polled` and
`sleep 90; echo "…"` were REJECTED (`Blocked: sleep … followed by …`). Any chained follow-up command fails,
`;` included. The only accepted form is a **standalone** `sleep N # intentional-sleep: <reason>` with nothing
after it. Do not waste two tool calls rediscovering this.

## A "needs a dependency update / needs a new API" premise is verifiable in 60 seconds — check the installed typings FIRST

`aba9a48d` was titled "Implementacja steer i aktualizacja Cursor SDK" and its body demanded steering,
background subagents, MCP tool annotations, a custom system prompt, plus an SDK version bump. The obvious
plan is "bump `@cursor/sdk`, then implement the new APIs" — and a wrong version bump would silently break
every child in later rounds. The tree said otherwise. **Read the installed package before accepting the
framing:**

```bash
node -e "console.log(require('./node_modules/@cursor/sdk/package.json').version)"
npm view @cursor/sdk version                      # 1.0.37 latest, 1.0.32 installed
grep -rn -i -o "steer\w*\|background\w*\|readOnlyHint\|destructiveHint\|openWorldHint\|systemPrompt\w*" \
  node_modules/@cursor/sdk | sed 's/.*://' | sort | uniq -c | sort -rn | head -30
cat node_modules/@cursor/sdk/dist/cjs/run.d.ts
```

`1.0.32` **already ships** `Run.steer?(text): Promise<SteerAckOutcome>` (note the `?` — it is OPTIONAL on the
interface, so the adapter must feature-detect `typeof run.steer === "function"`, never assume),
`SteerAckOutcome = "complete_delivered" | "revert_to_followup"`, `Run.supports()/unsupportedReason()`,
`SDKToolAnnotations` on `SDKCustomTool.annotations`, `AgentOptions.systemPrompt`, and
`isBackground`/`backgroundReason` on subagent rows. So the leaf is **adapter work, not an upgrade** — and
that reframing is what made the blocked cycle worth something. Consequences to carry into the brief:
- Read the contract's OWN doc comments, they encode failure modes you cannot guess: `systemPrompt` must be
  non-empty (whitespace-only throws at create/resume), is **not persisted** (re-pass on resume), is
  **local-agents-only** (`cloud` throws), and is **server-side account-gated** (`InvalidArgument` naming
  `--system-prompt` on the first `send`) → the adapter needs a graceful no-custom-prompt retry, not a crash.
- `annotations` is "advertised verbatim when declared and omitted otherwise — **never defaulted**",
  untrusted, never enforced → the Cretli side must OMIT the key when a tool declares nothing. A child that
  "helpfully" defaults hints to `false` silently changes what the model sees.
- `grep -rn "\bsteer\b" lib/` returning nothing proved the whole feature was unstarted, so no
  stale-finding/already-landed branch applied and the implement was genuinely needed.

## Closing a leaf whose work was landed by two earlier `outcome=failure` cycles

Reaffirms the failed-sibling-resume path, with two concrete reads: `workflow_show({leaf_id})` from a NEW
orchestrator chat returns `No workflow state for this chat` — loop state (last implementer, verdict, round)
does **not** cross chats, so nothing about the prior implement is readable and you must prove landing from
the tree alone (grep the new symbols + run the suites). Both prior cycles had `failure` while their code
work was complete and green: the failures were loop-reporting, not product. Sequence that worked: prove all
finding clauses in-tree → skip the implement child AND skip any delta inventory → one fresh review fanout →
per-job verify → parent-side suite reproduction → `todo_update` done. Note also that the dirty fingerprint
drifts mid-cycle from concurrent siblings (`79b8329dc13c+c3cb9a53` → `+39c50024` between the review start
and the verdict write) — always re-snapshot immediately before each `workflow_update`.

## Starved by ONE long foreign job (no rotation at all) — 2026-10-08, same leaf 5394c80f, cycle 4250aad5

The chaining variant above shows `CONFLICT` naming a *different* blocker each strike. The opposite
shape also happens, and it is worse for the "fire the instant it frees" tactic: a **single** foreign
implement job can outlast your entire cycle. Four `delegation_start(implement)` strikes over ~10 min
all returned the identical payload — `Blocker delegation id: f5834281 … Blocker parent chat: 74503ea0`
— and `delegation_list({chat_id: <blocker parent>, limit: 5})` kept answering `running`.

Hard consequences:

- **There is no ETA.** `delegation_list` for a foreign parent returns only
  `status  uuid  harness/model` — no timestamps, no progress, no round. Do not burn calls trying to
  estimate how close it is; the honest signal is "still `running`". `delegation_wait` cannot help
  (foreign job ⇒ `OUT_OF_SCOPE`).
- **Cap the strikes.** ~4 attempts spread over ~10 min, then report `blocked`. Beyond that you are
  paying turn time for a scheduler problem (`maxParallel=10` vs one exclusive mutating slot) and the
  cycle outcome does not change.
- **A CONFLICT consumes nothing.** No job row is created and no idempotency key is spent; re-firing
  the same key is safe. Distinct `-r1..r4` keys are still nicer because the todo changelog and the
  next cycle can count the strikes.

### Read the dead method's RETURN contract before you write the wiring brief

The prior cycle's brief said "wire `addWsSubscriber` … + `removeWsSubscriber` in `ws.on('close')`".
Reading the producer (`lib/browser/session-manager.js`) showed that is the **wrong API**:

```js
addWsSubscriber(sessionId, subscriberId) {            // :2455
  …
  let released = false;
  return () => { if (released) return; released = true; this.removeWsSubscriber(id, socketId); };
}
```

It **returns a one-shot, idempotent release closure**. Correct wiring = keep that closure on the
socket and call it in `ws.on('close')`; calling `removeWsSubscriber` by hand is both wrong (it needs
`sessionId` + `subscriberId` again, which the close path may no longer have in scope) and loses the
double-release guard. A child following the old wording produces code a reviewer legitimately FAILs,
so the fix-round costs an extra model for a mistake the parent could have avoided with one read.

Generalize: for **every** inert method named in a wiring brief, capture its return type and its
tolerant-failure behavior, because those are exactly what the reviewer will assert:

- `touchSessionById(sessionId)` → `boolean`; returns `false` for an unknown **or `closing`** session
  and never throws ⇒ the `ping` branch may call it unconditionally, no `try` needed.
- `clearChatBinding(chatId, sessionId = '')` → `boolean`; drops the pointer **only if it still equals
  the passed `sessionId`** and also clears `session.chatId` ⇒ pass the session id, or a newer binding
  gets erased (the concurrency bug the reviewer would hunt).
- `hasLiveWsSubscriber` is consulted at `sweepIdle` (`:2607`), so registering the subscriber *alone*
  is the fix for the idle-sweep clause — the brief should say that explicitly so the child does not
  invent a second guard.

### Two harness mechanics that cost calls if unknown

- **Bounded waits:** `sleep 45 && echo waited` is blocked (compound command) and a bare `sleep 100` is
  blocked too. The only form that runs is a standalone sleep with a trailing marker:
  `sleep 100 # intentional-sleep: wait for mutating slot held by <blocker id>`. Max ~10 min. Without
  that comment you cannot express the strike/pace loop at all.
- **`model_pick` may not hand you a `pickId`:** the `role=implement` result rendered as a single
  summary line (`qwen qwen3.8-flash role=implement cost=1 … reason=…`) with **no** `pickId`. The cycle
  brief mandates forwarding `pick_id`, so the safe move is to pass `pick_reason` with the rendered
  reason text (and `manual_source: "manual"` on a later retry), and **never** invent or complete a pick
  id from the UUID-ish noise elsewhere. A missing link degrades to `unknown` origin; a fabricated one
  is rejected and poisons the record.

### Handoff that actually arrived

Both `wmem_add` facts from this cycle were still listed, but the next cycle's prompt carried
"130 older/lower-priority fact(s) omitted to stay within the memory budget" — re-confirming that the
**TODO BODY is the only reliable handoff**. So the residual map (verified hook points
`ws-handler.js:112/:143-144/:273-274`, `agent-tools.js browser_open ~:471-476`, the four contracts
above, the permitted-file list, the `9/67/22/12/9` green baseline) went into the body via a single
`todo_update` patching `body` + `status:"ready"` together with a fresh `expected_updated_at` from
`todo_show`. Keep the body's original audit list intact and append a dated blocker paragraph with the
concrete blocker UUIDs — the next cycle needs to know it was starvation, not a rejected fix.

## Step 5 — when the FIX is starved but the REVIEW is not (2026-10-08, todo bb8dbad7, cycle bdd6c20d)

Every earlier cycle on this leaf died with ZERO delegations because it conflated the one exclusive
**mutating** slot (implement/fix) with the whole loop. They are different slots.

`delegation_start(assignment=implement|fix)` is the only call the `CONFLICT: … reason=job_in_progress`
gate protects. `delegation_start(assignment=review)` runs on the separate **review-fanout** slots
(`CRETLI_DELEGATION_REVIEW_FANOUT`, default 2) and **completes normally while a foreign parent holds
the mutating slot**. That asymmetry turns a losing cycle into a productive one:

1. Verify (Steps 0–1.5) that the finding's listed gaps are already landed in the tree. Do **not**
   re-delegate implement on already-fixed clauses — that fights the mutating slot and risks
   regressing deliberate work.
2. Fire the review **fanout now** (`model_pick role=review, count=2, diverse`) — it is not blocked by
   contention. Both reviews completed even while 5 fix-starts were CONFLICT-rejected by three
   different rotating foreign parents (48894d1a/5394c80f, 74503ea0/63fe60ce, 5f636435) in ~2.5 min.
3. A review that runs `tests=no` cannot execute the suites — you (parent) already ran them; fold the
   numbers into the brief and into `workflow_update`/`record_findings`.
4. Adjudicate their verdicts yourself (they often agree on one residual). Here both FAILed on a single
   finding **F1**: the scroll path swallowed `rate-limited`, but the `/input` endpoint throttles fast
   swipe/wheel with a *different* code, `input-rate-limited` (the legacy-guard-checks-wrong-code shape;
   see the `cretli-legacy-guards-new-answer` skill) → red i18n status + dropped scroll delta.
5. Persist the FAIL once via `workflow_update` (round, `last_verdict=FAIL`, `findings_hash`,
   `findings_text`, `material_revision`, `fanout_verdicts`, stable idempotency key) — first FAIL on a
   clean loop shows `stop=-`; then `watcher_update action=record_findings` feeds the regression gate.
6. Ack both review jobs. Do **not** rate them yet: the rubric rates the FAIL-ing review 5/`caught_bug`
   only *after* FAIL→fix→PASS, which you have not reached.
7. Attempt the fix optimistically ~4–5 times with standalone `sleep N # intentional-sleep` gaps; if the
   slot keeps rotating, **report `blocked`** and bank the residual as ONE named fix with an
   **unconsumed idempotency key** (a rejected CONFLICT start never persists, so the same key is
   reusable next cycle) in both the TODO BODY and `wmem`.

Net effect: the next cycle fires one tiny fix child + one re-review instead of re-auditing the whole
finding — the highest value a starved cycle can produce.

### Enum → i18n completeness must be probed by import, not grep

When a fix maps an enum/closed set of codes to translation keys, a green suite does **not** prove the
map is complete, and a `grep 'browser.error.<code>'` returns a **FALSE 0** because the dictionaries are
nested (`browser: { error: { … } }`, no dotted key). Cross-check every member:

```js
// /tmp/probe.mjs  (repo package.json is "type":"module", so locale .js import as ESM)
import { readFileSync } from 'node:fs';
const ens = await import('<abs>/app_front/i18n/en.js');
const en = ens.default || Object.values(ens).find(v => v && v.browser);
const src = readFileSync('<abs>/app_front/features/browser/browserPanel.js','utf8');
const codes = [...src.match(/X = Object\.freeze\(new Set\(\[([\s\S]*?)\]\)\)/)[1]
  .matchAll(/'([^']+)'/g)].map(m => m[1]);
const err = en?.browser?.error || {};
console.log('missing/empty in en:', codes.filter(c => typeof err[c] !== 'string' || !err[c].trim()));
```

Here it reported `52 codes / 52 en / 52 pl / MISSING none` — the proof a `tests=no` reviewer (which
mis-grepped for a flat dotted key and said "0 matches, not verified") could not give itself. Read the
reviewer's numbers and re-run them; a methodology gap is not a real defect, and a real residual that
both reviewers agree on is not a false positive.

## Language

Split the two sides — they are not the same decision:
- **Child report language:** `cretli` TODO bodies here are Polish, so instruct the child to write its
  report **in Polish** (that is the text the user reads in the delegation card). Keep code, paths,
  commands and the `TASK:`/`VERDICT:` terminator verbatim English — the parser matches them literally.
- **Your own end-of-turn summary:** follow the session output-language file
  (`data/qwen-home/.qwen/output-language.md` mandates English unless the user explicitly asks for
  another language **in this conversation**). Do not extrapolate "Polish todo body ⇒ Polish reply"; a
  watcher cycle prompt written in English got an English summary, which is correct.
