---
name: cretli-orchestrator-failed-child-partial-landing
description: As the Cretli orchestrator/parent, when an implement child dies with status=failed and only a thinking-dump, inventory what it actually LANDED on disk before re-delegating — machine-derive the landed/missing split (exports, i18n keys, tests), attribute red suites caused by a CONCURRENT cycle on the same dirty tree, and send a "verify, keep, complete, do NOT rewrite" brief carrying the landed inventory plus the parent's own verified baseline. Also (2026-10-07 todo 5394c80f): a landed fix can turn a PRE-EXISTING test red by requiring a capability the test FAKE lacks (`locator.evaluateAll` → manager throws `elements-unavailable`) — repair the fake and forbid a production fallback added just to appease a stale fake; hand over dead-but-in-scope scaffolding an even earlier crashed cycle left (an unreferenced `DialogBuffer` + `MAX_DIALOG_ENTRIES`) as "reuse, do not create a second"; prove "zero tests were added" against the crashed child's OWN reported baseline tallies; and remember a producer-side fix can land while its consumer enums stay stale (the `dialog` input kind wired into the manager but absent from both `browser_input` schema surfaces). Also (2026-10-07 todo aba9a48d): never store foreign-slot contention in `workflow_update stop_reason` — it gates your OWN re-delegation until `clear_stop`; a freed mutating slot is re-grabbed within minutes; and how to end a starved cycle blocked with the landing + resume brief preserved. Also (2026-10-08 todo 2b76d321) §0: a LIVE-but-spinning implement child (status still `running`, head_seq barely advancing, `chat_show` tool tally all `read_file`/`grep_search` with ZERO `write_file` after ~20 min) is the OPPOSITE trigger from §1's crash — judge by tool COMPOSITION not head_seq alone, cancel it, verify the tree stayed clean (nothing landed), then re-delegate to a capable NON-flash implementer (`sdk/composer-2.5`) with a "START WRITING EARLY, do not exhaustively re-read the picker" directive and a freshly-minted `pick_id` (the old one expires mid-race); after your OWN cancel a rotating fleet of watcher parents snatches the freed window in seconds just like a foreign blocker, so grab optimistically once and report blocked early. On a ZERO-landing self-cancel restore the todo to `ready` (honest resting state) — §7's "stay `doing`" only applies when the child actually wrote files. Also (2026-10-08 todo 7514f021 §8): a self-set leaf `deadline_at` + sandbox↔server clock skew (shell `date -u` ran ~1h44m behind the authoritative server clock) silently CANCELS the in-flight child (`status=cancelled verdict=unspecified`, looks like an infra death) and then blocks every re-start — first `CONFLICT: Workflow deadline has passed … wait until slot_occupied is false`, then `CONFLICT: Workflow is stopped (deadline). Clear stop_reason to continue.` Recover with ONE `workflow_update {leaf_id, deadline_at:<safely-future per the SERVER clock>, clear_stop:true}` (extending `deadline_at` alone does NOT clear the stop), then fire a NARROW completion brief: a deadline-cut child usually LANDED ~90% (here good RED regression-gate tests + one sub-fix, e.g. a package.json dep, already on disk but its own new test left red), so inventory via fresh mtimes + running the suites + `grep -A20 "not ok"` (when `delegation_show` is itself unavailable), and name the single failing test by file:line + exact input/expected as "make this green, the test is right, don't rewrite it" rather than re-sending the full fix.
source: auto-skill
extracted_at: '2026-10-08T07:38:16.795Z'
---

# An infra-failed implement child can still have done the work

Trigger: you are the parent of a `cretli-multi-harness` loop (Workspace Watcher cycle or manual
plan→implement→review→fix). `delegation_wait` returns
`status=failed … task_outcome=unspecified verdict=unspecified`, and `delegation_show` shows an empty
or thinking-dump report ("Zaczynam od rozpoznania stanu repo…", "Najpierw test warstwy store…") with
**no `TASK:`/`VERDICT:` terminator**. The instinct is "it failed, start over from scratch". That is
wrong often enough to cost a whole round.

Companions: **cretli-multi-harness** (loop contract, infra-retry rules),
**cretli-orchestrator-stale-finding** (foreign-slot bounded wait, `blocked` vs `failure`,
`delegation_list` is not a slot probe), **cretli-legacy-guards-new-answer** (auditing consumers of a
producer your leaf made richer), **cretli-delegation-report-delivery** (terminator mechanics).

## 0. A LIVE-but-spinning implement child is the opposite trigger from §1's crash — cancel and re-pick non-flash

§1 is about a child that already reached `status=failed` with a thinking-dump. The harder call is a
child that is still `status=running slot_occupied=true` but has produced **no product file for ~20 min**
— the `qwen: slow_read_loop` failure mode *while alive*. `cretli-orchestrator-resume-foreign-round` §5
says "do NOT cancel a stalled child, watch `head_seq`", and for a REVIEWER that later emits a full
verdict + test output that is right. The discriminator that flips the decision for an **implement**
child is the **tool-call COMPOSITION**, not `head_seq` speed alone:

- Poll `chat_show({chat:<child-uuid>, tail:4})` a few times. It returns a running tally like
  `read_file:completed×27, grep_search:completed×18, run_shell_command:completed×3` with **no
  `write_file`/`edit` line at all**. A child that only reads and never writes, with `head_seq`
  crawling (~1 event/min: I watched 162→165 over 3 min), is looping, not converging. Contrast §5's
  frozen-`head_seq`-then-PASS reviewer: there the head_seq was *stuck* and the child was about to
  deliver a verdict; here it *advances* but every event is another read/grep and the deliverable stays
  empty.
- **Act, don't keep waiting.** At ~20 min of zero writes the flash model was never going to converge on
  a 2,100-line-picker leaf. `delegation_cancel({delegation_id})`, then `delegation_wait` YOUR OWN
  cancelled job until it returns `status=cancelled slot_occupied=false` (you can wait on your own
  child — you cannot wait on a foreign blocker). Because it wrote nothing, **verify before you trust
  the clean tree**: `find lib tests -name '*.js' -newermt <cycle-start> | grep -i <area-keyword>` →
  none, and your own scratch files (a temp `.mjs` used to read the pick store) are removed. On
  2026-10-08 (todo 2b76d321, leaf 6 controlled model exploration) the cancelled `qwen3.8-flash` left
  ZERO product files, so nothing needed reverting.
- **Re-pick a capable NON-flash implementer** and forward a **freshly-minted `pick_id`**. The
  `model_pick` proposal you cached before the first start has a ~30 min TTL and expires during a
  20-min spin, so re-run `model_pick` (`exclude_harnesses=[qwen,codebuddy,deepseek,opencode]` to drop
  the read-loop-prone flash ids and the quota/balance-limited ones) and recover the new `pickId` from
  `data/model-pick-decisions.json` → `picks[<uuid>].id` (see §6 and resume-foreign-round §3 for the
  compact-rendering trap). Use a NEW `idempotency_key` (`…-r2`) so the attempts stay distinguishable.
- **Put the fix for the loop into the brief.** The retry that worked added a leading directive:
  *"This brief ALREADY contains the discovery you need — the exact files, functions and constants to
  touch. Skim only what you must to confirm signatures, then START WRITING code early and iterate; do
  not exhaustively re-read the 2,138-line picker."* A parent-side brief that names landing symbols up
  front is what lets a stronger model skip the read-loop the flash model drowned in.
- **A self-freed slot is snatched by a rotating fleet just like a foreign blocker.** The instant my
  cancelled job's `slot_occupied` went false, `delegation_start` for the retry hit `CONFLICT … Blocker
  18f9ec85 (parent f9c11cf6, deepseek)`; when THAT completed and I fired again, a *different* parent
  `10ff5b61 (8659af2b, sdk)` had taken it seconds earlier. Autopilot `maxParallel=10` against ONE
  mutating slot means the free window is sub-second and several parents poll it; a poll-then-fire loop
  with `sleep` between reads loses every time. The only win is an **optimistic `delegation_start` the
  same turn a probe shows the slot free** (I won my FIRST grab this way, the instant `98c34943` flipped
  `completed`); grab optimistically once more after a self-cancel, and if a fresh parent beats you,
  STOP and report blocked (§7) rather than grinding the fleet.

## 1. Inventory the landing before deciding anything (the filesystem outlives the crashed run)

The child edits files *as it goes*; a crash at 90% leaves 90% of a working implementation. Measure it
before you write a single word of the retry brief:

- `git status --porcelain` + `git diff --stat HEAD -- <the leaf's files>`, then **grep for each
  named artifact of each brief clause** — the exported symbol, the capability key, the flag. On R6
  (2026-10-07, todo 3304322f, cycle 291a8808) clause 1a asked for `getRunByRequestId`; grep showed it
  at `recovery-store.js:1147`, plus `resolveRunRefByRequest`, `describeRecoveryAdapterContract`, and a
  full `createDurableRequestLookup` with `transcriptLost` + `canLookupRequest: true`. Clauses
  1a–1c, 1d, 2, 3, 4, 5 had landed; only clause 7 (tests) and real *verification* were missing.
- Check the test dimension separately — that is usually the half that dies: `grep -c 'test(' <file>`,
  and whether a new test file exists but was never executed. On R6 the crashed child had **written
  10 tests and never run one**.
- Confirm the partial state is inert, not poisoned:
  `node --check` on each touched file, `npx eslint` on them, then run the **existing** affected suites.
  If they are green, the tree is safe to build on and you have your baseline; if red, the retry brief
  must start with "fix what the crash broke".
- **When a red suite is a `readFileSync` + `assert.match(source, /…/)` guard, the crashed child did not
  necessarily break behaviour — it moved the code out of the file the guard watches.** This is the most
  dangerous partial landing, because the "obvious" repair is to delete the assertion. On 2026-10-07
  (todo 2ea9fb56, cycle 6b45e98b) the child extracted the pull path into a new module and the panel
  stopped containing `payload.nextSince`, so test 8 of `tests/browser-panel-wiring.test.js` went red —
  and that assertion is the lock another leaf (the network-cursor fix) put on a bug it had already paid
  for. In the completion brief: name the failing test **by number and by the exact regex it asserts**,
  state which earlier leaf owns it, forbid weakening/removing it ("fix it in the code, not by deleting
  the assertion"), and require the retry to keep the guard's file untouched. Then require the new
  behavior test to assert the *produced value* (cursor advanced, `'' !== 'agent'`), not the presence of
  the string — a source-regex guard stays green while the behavior it proxies is broken.
- mtime tells you what *this* child wrote vs what other cycles left (a dirty shared branch lies to
  `git diff`): `ls -lt lib/<area>` showed `recovery-store.js`/`recovery-contract.js` bumped together,
  while `recovery-queue.js` (a different leaf) was older.
- **A UI leaf's signature half-failure is a missing i18n set, and no test catches it** — `t('…')`
  falls back to printing the key, so the page still renders. Derive the gap by machine, don't eyeball
  it (2026-10-07, todo 075f151f cycle 98861a6c: r1 wrote two complete view modules and died before
  touching `en.js`/`pl.js` — 57 static keys + 4 dynamic dicts absent, `grep -c` returned 0 in both):
  import the live dictionaries plus the module sources and diff them in one Node pass, covering the
  `` `settings.prefix_${value}` `` construction as its own dictionary per real value set:
  ```bash
  node --input-type=module -e "
  import { en } from './app_front/i18n/en.js'; import { pl } from './app_front/i18n/pl.js';
  import fs from 'node:fs';
  const src = fs.readFileSync('app_front/features/watcher/<view>.js','utf8');
  console.log('missing:', [...new Set([...src.matchAll(/settings\.([A-Za-z0-9_]+)/g)].map(m=>m[1]))]
    .filter(k => en.settings[k] === undefined).join(', '));
  for (const p of [...new Set([...src.matchAll(/(settings\.[A-Za-z0-9_]+)_\\\$\{/g)].map(m=>m[1]))])
    console.log(p, 'have in en:', Object.keys(en.settings).filter(k=>k.startsWith(p)).length,
      '| in pl:', Object.keys(pl.settings).filter(k=>k.startsWith(p)).length);
  console.log('parity en-only:', Object.keys(en.settings).filter(k=>pl.settings[k]===undefined).length);
  "
  ```
  Paste that exact key list into the completion brief — "add every string to BOTH files" is not an
  actionable instruction for a cheap model, a named list is.
- Prove "landed" means "loadable", not "present": import the modules in Node and dump their exports
  (`node --input-type=module -e "import('<path>').then(m=>console.log(Object.keys(m)))"`). That also
  hands you the leaf's own contract (`*_ACTIONS`, `*_PAGE_SIZE`, the `view.*` fields it consumes) for
  the retry brief instead of guessing it.

**Parent boundary:** all of the above is read/execute-only and is your job (you must reproduce child
claims anyway). **Writing the missing code is not.** The parent must not implement — "audit + finish
the tests" is still a child delegation. The one exception worth allowing is dead-code the crashed child
itself left behind (an unused import/local flagged by your eslint run): two-line removal is cheaper
than a fix round, and you re-run lint + the suites right after.

## 1b. A shared dirty tree goes red from a CONCURRENT cycle — attribute it, never fix it

On a Workspace Watcher branch several cycles edit the same working tree. Between your baseline run and
your retry, unrelated suites can flip red because *another* parent's child is mid-edit. Prove ownership
before you call it yours:

- `find <dirs> -mmin -60 -type f` + `ls -la --time-style=full-iso` on the failing area, and compare the
  mtimes against your own job's terminal moment — files still being written *after* your child died are
  not your child's work (`scoutHistoryView.js` 18:26 vs a `status=failed` job already terminal).
- grep the new failure signature for a symbol/gate you never asked for: the retries here failed with
  `+ 'scope_error' - 'orchestrator_unavailable'`, and `scope_error` existed only in
  `lib/workspace-scout-git.js` + `tests/workspace-scout-git-scope.test.js` (both untracked, foreign).
- Then **re-check later instead of acting**: those 4 foreign-red suites were fully green 40 minutes on,
  with zero intervention from me. Re-delegating a "fix" for them would have had my child revert or
  collide with a live foreign writer.
- Push the attribution into both briefs: name the foreign files/suites, state they are not the leaf's
  to fix, and forbid the child from editing the directory the foreign cycle holds (here: hard
  "do not touch `lib/`", which also kept my child off the file its own crashed sibling had edited).
  Record in `workflow_update.report_text`/the cycle report that you attributed them, and expect a
  reviewer to re-verify the claim.

## 2. A CONFLICT-rejected start is not an infra failure — do not spend the retry on it

The one-per-role infra retry is for the *failed run*, not for slot contention. On R6 the first
`delegation_start` for the retry was rejected `CONFLICT: Another parent already has a mutating job`
(blocker `ed3b95c0`, parent chat `1718567f`). `delegation_show({delegation_id:<blocker>, scope:"all"})`
showed it genuinely `running slot_occupied=true` — a live foreign implement, not a stale slot — so
honor the gate: one `sleep 60`, re-poll, and it cleared in ~60s with a PASS on an unrelated sidebar
job. Retry the same pick immediately. (Details + the `delegation_list`-without-`chat_id` trap are in
**cretli-orchestrator-stale-finding**.)

Reusing the same executor/model as the crashed attempt is allowed here when the alternatives are all
blocked (opencode/claude under a usage limit, deepseek balance) — say exactly that in `pick_reason`
so the deviation is auditable rather than looking like you ignored "never reuse after infra fail".

**A provider `400` at handshake is a broken per-MODEL catalog row, not a harness outage and not a
consumed infra round.** Same run, two minutes later: `model_pick` returned
`codebuddy / hy3-preview`, and `delegation_start` died in seconds — `status=failed`, error
`400 model [hy3-preview] service info not found`, **empty report, zero tokens spent, zero files
written**. Read the shape before you spend the one retry of the role on it: a run that never executed
hasn't consumed a round, so the honest move is `exclude_harness`/`exclude_model` for that row and pick
again — not `BLOCKED`, and not silently writing the code yourself. Two corollaries this run proved:
- The **harness was fine**: the same cycle later delegated a review to `codebuddy / hy3`, which ran every
  suite and `scripts/review-verify.js` successfully. So exclude the model id, not the harness, unless you
  have harness-level evidence (`adapter not ready`, provider outage, quota row for the transport).
- `model_pick` **will happily hand you an unusable favorite** — "Settings favorite" does not mean
  "the provider still serves this id". Never treat a pick as proof of availability; `delegation_start`
  is the only probe, so keep the retry budget for what actually starts.
Record the dead row in Workspace Memory (with the working sibling id) so the next cycle's pick doesn't
burn its retry rediscovering it.

**`workflow_update stop_reason` is a loop gate, not telemetry — never park foreign contention in it.**
On 2026-10-07 (todo aba9a48d, cycle 64a37d76) I wrote `stop_reason=job_in_progress` "to make the state
honest" while losing the third start to slot contention — and every subsequent `delegation_start` then
died with `CONFLICT: Workflow is stopped (job_in_progress). Clear stop_reason to continue.` even after
the slot was genuinely free; the fix was a separate `workflow_update {leaf_id, clear_stop: true}` event.
A self-inflicted lockout in the middle of a starvation race costs the window you were saving. Record the
blocker in `report_text` and Workspace Memory instead; put `stop_reason` only where the loop must truly
STOP (same_findings, round caps, deadline).

**A freed slot is re-grabbed in minutes — fire the retry the moment your probe shows the blocker
terminal.** Blocker `f96d5079` flipped to terminal with `slot_occupied=false`; by the time the next
`delegation_start` went out ~2 min later, a fresh foreign parent `8244db43` had taken it (autopilot
maxParallel=10 against ONE mutating slot is a sieve, not a queue). The CONFLICT payload hands you the
blocker id — poll `delegation_show({delegation_id})` cheaply, and when it shows terminal, start
IMMEDIATELY; don't confirm liveness with another probe first. Bounded waits between probes use
`sleep N # intentional-sleep: <why>` — harnesses may reject a standalone `sleep` without that trailing
comment. Size the wait by the blocker's job type (its `executor` line tells you): foreign
qwen3.8-flash implements ran ~15–25 min each and two of them tonight also died mid-run with the same
generic `Qwen run failed` — an infra-death cycle's wall time is the child runtime plus up to another
child's slot-hold.

## 3. Write a COMPLETION brief, not a duplicate brief

Paste a per-file **landed inventory** and instruct: *"verify, keep, complete — do NOT rewrite from
scratch; NEVER revert or stash anything you did not write."* Cheaper models reliably "tidy" a file they
did not write, so make preservation an explicit rule. Include:

- **What the parent already verified, so it isn't redone** — R6's brief stated `node --check`/eslint
  clean and `store 22/22, contract 14/14, lifecycle 18/18, crash 3/3, chat-run-accept OK`, and told
  the child not to re-run them as its own evidence.
- **All original clauses re-listed as an AUDIT checklist** (numbered), not as build instructions —
  paraphrasing clauses into a narrative drops them (see the orchestrator-brief-paraphrasing rule).
- **The missing clause named alone as work** (here: clause 7 tests), with the concrete list of cases.
- The scope boundary again, since a completion round is where scope creep sneaks in.

Also require report discipline up front: *"produce the final report ONCE with the two terminator lines
at the very end; do not stream a thinking dump"* — a thinking dump is exactly what made the first
attempt unreadable.

## 4. A completion round's real payoff is the defect the crash left behind

Keep "AUDIT against these acceptance rules and FIX real defects" in the brief; it is not filler. The
R6 completion child found a genuine bug the first attempt's code had introduced-by-reachability: the
`startChatRun` replay guard `found?.accepted === true && found.runId` collapsed "proven accepted,
empty `adapterRunId`" into "not accepted", so a same-`requestId` retry **re-sent the prompt**. It
relaxed the consumer to key on the proof alone and reported the pre-fix failure signature
(`expected '' actual 'run-live-1'`) plus an honest label that its second new test was pre-fix-green
(a contract **lock**, not evidence). That is the pattern in
**cretli-legacy-guards-new-answer** — read it before writing either brief.

## 5. Parent follow-through on a partial-landing round

- **Reproduce the child's numbers yourself** (`node tests/kernel-chat-run-adapter.test.js` → 10/10) and
  read the actual diff of the fix hunk — never accept "25 suites green" as the gate.
- **Run the consumer audit yourself even though a reviewer will too.** The parent's grep for
  `lookupChatRunRequest` found `delegation-mailbox.js:460`/`:613`, `workspace-watcher.js:1491`,
  `workspace-watcher-cycle.js:780` — the implement child had missed all of them. Put those sites in
  the review brief as *"judge these yourself, and enumerate consumers by grep rather than trusting
  this list"*: on R6 the reviewer **downgraded** my mailbox hypothesis to non-blocking with evidence
  (`deliveryRequestId` is preserved and `startChatRun` now replays on proof alone, so no duplicate
  prompt; wrong status/ineffective retry only) and caught two blockers I had missed. Do not present
  your own hypothesis as a verdict.
- **When your leaf makes an always-empty field non-null, audit the consumer's KEY NAMES, not just its
  guards.** Here `usage` on the scan history went from permanently `null` to a real
  `{ tokens, usd, eventCount }`, and the shipped renderer read `usage.tokens / usd ?? costUsd /
  eventCount ?? events`. A producer that writes `{ costUsd }` while the renderer reads `usd` (or vice
  versa) renders "no data" forever with every test still green — the failure is silent in exactly the
  direction the acceptance rule cares about ("brak usage nie wygląda jak koszt zero"). Read the
  producer's return literal and the consumer's reads side by side before you call the wiring done.
- **`delegation_verify`'s catalog is dynamic, so your own brand-new test files are verifiable in the
  same cycle** — `describeReviewVerifyCatalog()` reported `curatedCount: 61, generatedCount: 604,
  auditDirs: ["tests"]`, and `node scripts/review-verify.js <new-test-id>` ran the three test files
  this leaf had just added (exit 0). Don't assume a missing curated id means no host backstop exists;
  and when a reviewer pick comes back `tests=no / verify=required`, that CLI run is your gate, plus
  `node --test` on the leaf's suites.
- **Distinguish live from latent before calling anything blocking**: trace whether any production
  writer exists for the shape in question. R6's durable rows had **zero non-test producers**
  (`beginRunLaunch`/`recordExecutorAck`/`writeRunIntent` uncalled outside `lib/recovery/**`), so the
  mailbox conjunct was a *latent* same-class defect to record in Workspace Memory for R8/R10/R12 —
  not a blocker for this leaf.

## 6. Never transcribe a UUID from memory or from a wake prompt

In this run I invented a delegation id (`8d5c4d32…`) that was **not** in any tool response, propagated
it into durable `workflow_update` state and into a `loop_wakeup` prompt, and the next turn's
`delegation_wait` died with `NOT_FOUND`. Same class of mistake as typing a chat-id prefix into
`workflow_update`/`delegation_start`.

- **`pick_id` is the same trap and it is easy to hit.** `cretli-multi-harness` says to forward the
  `pickId` from `model_pick`, but the `model_pick` MCP result can arrive as one compact text line
  ("sdk composer-2.5 role=implement cost=2 …") with **no pickId in it at all**. In this run I passed
  my own `idempotency_key` string as `pick_id` on two starts to satisfy the requirement. Don't: the
  server validates the link, records a fabricated one as `unknown`/`rejected`, and the job then looks
  auto-picked in the audit trail while being nothing of the sort. If no pickId is visible, OMIT
  `pick_id` and put the full reasoning in `pick_reason` — an honest `unknown` origin beats a invented
  link, and an omitted field is a known state while a fabricated one is a lie in durable state.
- Job ids come from `delegation_list` output (full UUIDs) or the actual
  `Started delegation <uuid>` line — copy them verbatim, every time.
- If bad ids are already in durable loop state, fix them with a **new** `workflow_update` event under
  a **different** `idempotency_key` (replaying an applied key with changed params is `CONFLICT`).
  Replaying a key only ever works for byte-identical params.
- Do not paste unverified ids into scheduled wake prompts; a wake prompt is how a wrong id survives
  the turn that invented it.

## 7. Closing a starved cycle cleanly: blocked, with the landing and the brief intact

When the single mutating slot stays foreign-held through your whole patience budget (aba9a48d: six
`delegation_start` CONFLICTs over ~45 min, blocker ids rotating `fd331bc8 → f96d5079 → 8244db43`),
stop holding the cycle open. The partial landing does NOT need to be rolled back — on the dirty
multi-leaf branch, uncommitted leaf files are the normal resting state and the next cycle builds on
them. Close in this order:

1. `wmem_add` ×2 before anything else: a `finding` with the FULL landed inventory (files, exported
   symbols + signatures, what is wired vs dangling, tree health checks) as the exact resume point, and
   a `blocker` with the cycle id, blocker delegation ids, the executor(s) to exclude for the child,
   and the verbatim continuation outline. The next cycle then starts YOUR prepared brief without
   re-deriving anything — this is what turns a blocked cycle into cheap progress.
2. `workflow_update`: persist role/round + the failed child's state in `report_text`; keep `stop`
   clear for the contention case (see §2) so the NEXT parent doesn't inherit your lockout.
3. Leave the todo at `doing` if this cycle claimed it — **partial work exists** and no review ran;
   never `done`, never silently revert to `ready`. **The exception is a §0 zero-landing self-cancel**:
   if your child wrote nothing (cancelled live read-loop, tree verified clean) there is no uncommitted
   leaf work to protect, so restore the todo to `ready` with a fresh `expected_updated_at` from
   `todo_show` — that is the honest resting state and lets the next cycle cleanly re-claim and fire the
   saved brief. "Stay `doing`" is about preserving landed files, not about masking a starved attempt.
4. `watcher_update action=report outcome=blocked` — a slot you could not acquire is not a `failure`;
   failures move the consecutive-failure backoff and penalize the wrong thing.
5. Housekeeping gotchas: `delegation_ack` YOUR failed child (reviewed), but do NOT ack or rate the
   foreign blocker jobs — they have other parents. A failed child that ran on YOUR OWN base model
   cannot be rated (`self_model_rating_denied`), and infra failures are optional ratings anyway. A
   CONFLICT-rejected start never created a job, so reusing its `idempotency_key` on the retry is safe;
   still prefer incrementing it (`-a2`, `-a3`) so attempts remain distinguishable in the audit trail.

## 8. Your OWN `deadline_at` + sandbox↔server clock skew silently CANCELS the in-flight child

The cancellation that is easiest to misdiagnose as an infra/adapter failure is one **you** caused with
a leaf `deadline_at` you set from a clock that is not the server's clock.

- **The sandbox shell clock can run far behind the server.** Measured 2026-10-08 (todo 7514f021,
  cycle dd5dceeb): `date -u` in the orchestrator's shell reported `07:2xZ` while the authoritative
  signals — file mtimes from a child that had just finished, and the watcher's own `last_tick` — were
  ~`09:1xZ`. Skew ≈ **1 h 44 m**. Your shell `date` is NOT the server clock; treat the server as
  authoritative and calibrate against `watcher_show`/`last_tick` or `ls -l --time-style=+%H:%M:%S` on a
  file you know the child just wrote. (`ls` prints LOCAL Warsaw time here, which is +2, not the server
  UTC either — don't conflate the two; anchor on `watcher_show` timestamps.)
- Consequence: you set `deadline_at: <your-now>+~60min` and it looks safely future on your clock, but
  the server clock had already passed it. The **in-flight implement/fix child gets cancelled by the
  deadline** — `delegation_wait` shows `status=cancelled … verdict=unspecified`, which reads like a
  mysterious infra death. Then every `delegation_start` fails twice, in order:
  1. `CONFLICT: Workflow deadline has passed. Cancel was requested; wait until slot_occupied is false.`
  2. once the slot is free: `CONFLICT: Workflow is stopped (deadline). Clear stop_reason to continue.`
- **Recovery (a deadline stop is a real loop STOP, unlike §2's foreign-contention case):** a single
  `workflow_update {leaf_id, deadline_at: <safely-future per the SERVER clock>, clear_stop: true}`
  (own fresh `idempotency_key`) — extending `deadline_at` alone does NOT clear the stop, you must pass
  `clear_stop:true`. Only then re-fire optimistically (slot was free). Size the new deadline against
  the SERVER clock, and generously: a greenfield security module's fix+review rounds can each run
  10–30 min, so don't set a deadline you will blow and then have to un-cancel mid-round.
- **A deadline-cancelled child usually LANDED partial work** (it edits as it goes, then gets cut at
  ~90%). Here `delegation_show` was ALSO unavailable that turn, so inventory the landing WITHOUT the
  report: `ls -l --time-style` for fresh mtimes in the fix window, run the suites yourself, and grep
  for each fix marker. That round had written **good RED tests that encode the regression gate** and
  even finished one sub-fix (`source-map-js` landed in `package.json`) but died before making the
  implementation pass its own new test (`browser-debugger.test.js:151` red — a numeric CDP
  `{name:'pin', value:{…description:'9999'}}` scope still leaked). Then `node tests/<x>.test.js |
  grep -A20 "not ok"` pinpoints the exact single failing test.
- **Send a NARROW completion brief, not the full original fix.** Reference the one failing test by file
  + line + its exact input/expected, state the parent-confirmed root cause (redaction depth / matcher
  axis — see cretli-vacuous-test-review-gate §0), list what already landed as "do NOT rewrite/keep",
  and re-list the green regression suites to not-regress. A cheap model that reads "make X green, the
  test is right, don't touch it" converges in minutes vs a full re-fix that re-races the slot and risks
  reverting landed work.
