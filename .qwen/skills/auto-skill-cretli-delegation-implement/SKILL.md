---
name: cretli-delegation-implement
description: Execute a Cretli delegated "implement" assignment that fixes a review finding — verify the finding's cited root-cause branch and gate order before applying the task's snippet, prove it with a failing regression test, substitute repo-native runners when the task's test command is stale, and report BLOCKED when the cretli_bridge session is dead. Also covers a bundled multi-finding round, front-end dashboard/UI fixes (dirty-form-preserving live refresh with a fetch generation guard, ticker cleanup in init-once panels, positioning-vs-duration separation, todo-deduped throughput aggregation, persist-through-lifecycle display fields, CSS token-mismatch source-scan tests), a Settings policy-editor form leaf (map controls to the server-normalized policy, preserve already-landed caps/fields, UI-only toggle to avoid a policy-shape change, optimistic isolated-subregion repaint that never wipes the form, catalog-driven multi-select that keeps absent ids, three-layer clamp, form-only reset-to-defaults), and Workspace Watcher snapshot-liveness/decision-log fixes (work-trace-gated unknown liveness in snapshotWorkspaceWatcher, the persist normalizeDecision whitelist that strips extra decision fields so "Why?" only surfaces via the pinned-chat notice + describeWorkspaceWatcherDecision, e2e state_missing probe injection that still lets the cycle start, observeDeps disabling delegation liveness). Also covers an "add a new append-only store / feature" variant (not just fix-a-finding): a leaf module that breaks an import cycle, dual-source writes gated by producer to avoid double-logging, threading a new field into the history row but NOT the shared snapshot, an additive health metric kept safe by existing Array.isArray assertions, and the timezone-fragile exact-ISO test trap. Also covers a chat-archive / idle-liveness sweep variant (a bidirectional ESM import cycle added by boot wiring, verified safe via hoisted `export function` + a both-order import smoke test; `updateChat({archived:true})` cascading the transitive `forkParentChatId` subtree in the store so a parent is gated on every descendant; `isChatRunConfirmedIdle` returning `known:false` after a restart so boot-registered sweeps are a deliberate no-op; isolating a side-effect's cause by denying the sibling code path via config instead of a neuter; and treating an allowed "call wiring only" file as permission, not obligation). Also covers an "expose the skipped-branch reason in the audit + stamp the decision on the UI card" round (a sibling audit writer that must NOT inherit the original mode guard, the redactText trap where the header NAME survives while only its value is masked, splitting a durable badge from a transient countdown highlight, refusing a redundant payload field the brief asks for, lint/test attribution when a file you are allowed to edit contains someone else's broken WIP, and why `app_front/lib/sdk-rich-view.js` can only be verified by eslint + `node --check`).
extracted_at: '2026-09-29T21:13:52.207Z'
---

# Cretli delegated implement (executor, edit allowed)

Trigger: the prompt opens with "You are the executor for a Cretli delegated task", gives
`Execution mode: agent` + `Assignment: implement`, a `Delegation:` UUID, a `[TASK]` with a
review finding to fix, `[COMPLETION CRITERIA]`, and a terminator such as
"End exactly `TASK: implement` and `VERDICT: PASS|FAIL|BLOCKED`".

Companion skills: **cretli-delegation-review** (the read-only reviewer side) and
**cretli-review-verify-catalog** (when the finding is "this suite isn't verifiable by a review
child"). The review skill's reply mechanics in "Step 6 — send it" apply here too; only the
dead-session fallback is documented below.

## Hard rules that bit me
- `[TASK]` scope lines like "Keep change to loader and loader tests only", "preserve … byte-for-byte",
  "No runtime integration, package edits, … commit or push" are binding. When a real improvement
  needs a forbidden file (e.g. a `package.json` test script), do **not** do it — report it as a
  follow-up in the report.
- Never create another Cretli delegation from an executor chat.
- If blocked or materially ambiguous: ask the user and stop. If `ask_user_question` comes back
  `[Operation Cancelled] / Input closed`, do not loop — restate the final state once, with the
  terminator lines, and stop.
- The terminator is required in the *chat* response too, not only in the MCP reply.
- "**keep todo status doing**" means literally that: do not call `todo_update`. Verify it read-only
  with `todo_show({ todo_id })` (never changes status) and quote the observed
  `status: doing` + `updated` timestamp in the report so the parent can see you didn't move it.
- Report language: the criteria say "write the final report in the user's language", which can
  conflict with a session `output-language.md` mandate. Resolve it by artifact: the delegated
  `final_report` follows the language of the *user-authored* material it answers (Cretli TODO bodies
  are Polish → Polish report), while code/CHANGELOG/docs stay in the repo's English. State the choice
  if it could surprise the parent.

## Step 0 — re-establish ground truth before editing (the snapshot can be stale, and the round may already be partly done)
A delegated FIX round can be **re-run after a prior attempt was interrupted**, and the prompt's
git-snapshot block is captured at chat start — it drifts. In 2026-10-01 the snapshot showed
`lib/model-role-profiles.js` at 863 lines (old single-pass filter, generic `MODEL_UNAVAILABLE`), but
on disk it was 1024 lines already carrying the consumer half of this very fix (soft/hard exclude split,
`collect()` retry, `unavailableModelError`, `history_exclude_relaxed`, candidate reordering). My first
`edit` failed with "File … has not been read in this session" because my in-context copy was outdated.
So **before the first edit**: re-read the in-scope files with `read_file`, and run
`git status --porcelain` + `git diff --stat` to see what a prior run already landed. Cite the line
numbers you verified *now*, never the review's prompt-quoted ones (they drift).
- **Producer vs consumer halves.** `model_pick` logic is split: the pure ranker/consumer
  (`lib/model-role-profiles.js`, `selectModelPick` + `normalizePickHistory`/`normalizeFreshLimitHits`)
  and the *producer* of the injected history (`lib/model-pick-history.js` — the only module that
  emits `pickIndex`, `freshLimitHits`, `excludeModels`, `next_review_passed`, `chatUsage`). A partial
  round often updates consumer + tests + SKILL.md but leaves the producer emitting the OLD shapes
  (`pickIndex: chatRoleRows.length`, `freshLimitHits: number`, `lastOf(assignment)`, latest-review-not-
  first-review, no cache). **Run the tests FIRST**: they encode the intended contract, so a consumer
  helper that reads a shape the producer doesn't emit yet = the producer is the missing half; the
  suites stay red until you complete it. Match your producer output to what `normalize*` expects.
- A brand-new module that the snapshot lists as `??` (untracked, e.g. `model-pick-history.js`) is a
  WIP artifact of the same round — finish/align it rather than treating it as off-limits.
- **The helper the [TASK] tells you to "reuse" may exist only in the dirty working tree.** OpenCode
  FP round (2026-10-04): the task cited `readCommandPositionText()` "(defined above in the same file,
  ~186-189)" and it was real at line 186 — but `git show HEAD:lib/opencode/opencode-permission.js`
  had no such function; a prior round of the same feature had added it and wired it into
  `classifyOpenCodePermissionRisk` *only*, leaving the sibling consumer (`isOpenCodePermissionWithinWorkspace`'s
  relative scan) on the raw `command`. So the finding was genuinely still open even though its
  premise ("the helper already exists") looked unverifiable against HEAD. Read `git diff <file>` in
  full BEFORE editing: it tells you which half of the round landed and which call-site was missed.
  Consequence for the report: `git diff --stat` totals mix their hunks with yours, so delimit your
  own hunks by explicit line ranges ("mine: lib 214-217, 270-271, 276-286; test 6, 515-561") instead
  of implying the whole diff is yours.

## Step 1 — treat the finding as a hypothesis, not an instruction
Read the target file and its test file fully, plus the contract/module the finding's helper lives in.
Confirm the exploit path from the code (which line actually consumes the untrusted value), and check
what else consumes the function (`grep_search` for the exported names) to prove "no runtime
integration" before claiming the blast radius is small. Prompt-quoted line numbers drift; cite the
lines you verified.
- **The cited root-cause branch may not be the one that fires, and the provided snippet may be a
  silent no-op.** Approval-advisor round (2026-10-02): [TASK] blamed the `categories.length > 0 →
  unsafe_category` gate in `resolveApprovalAdvisorPlan` (the name it quoted, `canConsultApprovalAdvisor`,
  didn't even exist). But the *earlier* `action.risk !== 'low' → not_low_risk` gate rejects the same
  actions first, and the upstream classifier (`classifyOpenCodePermissionRisk`) gives mutation-only
  commands `risk: 'medium'`, so `unsafe_category` was unreachable from that flow — applying only the
  category relaxation would have changed nothing user-visible. Follow the task's stated *intent*
  ("mutation-only, risk=medium must be advisor-eligible"), verify **gate order** in the real code, and
  widen minimally *inside the same function* (there: a `mutationOnlyMedium` exception on both gates).
  Report the corrected root cause and the snippet deviation explicitly — "the finding named the wrong
  line" is a finding of its own.
- The path may be **already mitigated indirectly** by an accidental coupling elsewhere, and the
  assignment still stands. BE7 example: the legacy `/ws-agent?resume=` guard enumerated builtin
  transports, but local plugin ids were *also* caught because `normalizeAgentTransport(unknown)`
  falls back to `'sdk'`, making `isSdkChat` true. The requested explicit
  `rawHarnessTransportKind(chat.agentTransport) === 'local'` check is decoupling/hardening, not a
  behavior change. Say so plainly in the report (pre-fix observable behavior identical, only the
  close *reason* text differs) — do not overclaim that you plugged a live leak.

## Step 2 — write the regression test FIRST and prove it bites
This is the single most valuable move in a fix-a-review-finding assignment:
1. Add the new tests, then run the suite **against the unfixed code**.
2. Record exactly which new tests fail and which pre-existing tests stayed green
   (e.g. `28 tests: 24 pass / 4 fail` → "the 4 security tests fail pre-fix").
3. Only then implement the fix, and re-run to green.

Report the pre-fix failure count explicitly — it proves the finding was real *and* that the test is a
genuine guard rather than a post-hoc lock. Expect one or two new tests to pass pre-fix (behavior
locks, e.g. "path-normalization tolerance"); label those as locks instead of hiding them.

A pre-fix failure must be for the **right reason**. In 2026-09-30 an integration test asserting "the
forced load issued 2 HTTP fetches" failed pre-fix with `0 !== 2` — a timing artifact: the code under
test (`harnessHealthCache.load`) schedules `fetchHealth` inside a `Promise.resolve().then(...)`
microtask, so nothing had hit the fetch stub yet; the failure proved nothing about the race. Flush
(`await new Promise(res => setImmediate(res))`) before asserting network side-effects. Then, since
the corrected test is only seen against fixed code, prove the bite with a **fix-disabled
experiment**: with the final test code in place, temporarily neuter the fixed branch
(e.g. `if (false && query.fresh) return apiFetchJson(...)`), re-run to see the true failure
signature (`1 !== 2` — dedupe reused one GET), restore exactly, and grep for the neutered needle to
confirm no residue (`grep 'false &&' → exit 1`) before the final green run. Report the experiment
honestly instead of claiming the misleading pre-fix count proved the finding.

For findings in browser API layers (`app_front/api.js`), prefer a **behavioural** test over source
scans: the module imports cleanly under Node when you stub `globalThis.fetch` (pattern:
`tests/chat-api-archive.test.js`; return deferred promises resolved with
`{ status: 200, json: async () => payload }` — 200 sidesteps the CSRF-retry path in
`cretliApiFetch`). Counting stub fetches proves URL-keyed `dedupeGetJson` reuse races for real
(`tests/harness-health-ui-api.test.js`); keep source-scan contract assertions as secondary locks.
Note the async split: a direct `getHarnessHealth()` call reaches `fetch` synchronously (async
functions with no pre-await run to the call), while controller-scheduled loads need the flush above.

When the fix only *decouples* from an accidental mitigation (Step 1, last bullet), no behavior test
can fail pre-fix. Then write a **source-scan/ordering regression test** in the repo's established
style instead: Cretli's ws-router guard tests (`local-harness-runtime`, `builtin-harness-providers`)
`readFileSync` the router source, locate the branch with `indexOf`, slice up to the consuming call
(e.g. `handlePtyConnection(`), and assert the guard needle's index plus `ws.close(4000` / `return;`
ordering inside that slice. Use a needle that is *unique to your branch* — the legacy branch variable
is `chat`, the SDK branch is `routedChat`; `routedChat.agentTransport` never matches a
`chat.agentTransport` needle (capital C). This fails pre-fix and passes post-fix.

Where the assignment names an existing test file as "acceptable only if clean/unmodified": check
`git ls-files --error-unmatch <file>`. An **untracked** (`??`) file has no HEAD baseline, so it is
not clean — do not append to someone's WIP artifact; create a new narrowly scoped
`tests/<name>.test.js` instead (Step 5: the runner auto-globs it, so no package edits are needed).

**Observing a fire-and-forget helper whose guard you are fixing (deps-injection seam).** When the
finding is a *substring-vs-type* bug in a caller that invokes a shared best-effort helper — e.g.
`local-harness-runtime.js` `watchRunFinishedForSideEffects` calling `notifyAgentFinished` on any
frame containing `'sdkRunFinished'`/`'sdkPromptStarted'` without checking `payload.type` — the fix is:
keep `data.includes(...)` as a cheap prefilter to avoid `JSON.parse` on every frame, but gate the
side effects on the parsed `payload.type` (`=== 'sdkRunFinished'` → notify + auto-title; `===
'sdkPromptStarted'` → reset the dedupe flag), matching how `room-kernel` guards before notifying and
how `noteRoomRunFinishedForAutoTitle` already returns false on wrong type.
- The real helper can't be observed through its own defaults in tests: `notifyAgentFinished` early-
  returns *before* setting `room._agentFinishedPushNotified` / broadcasting because `web-push` is
  installed (`isPushAvailable()` true) but `hasPushSubscriptions()` reads an empty
  `push-subscriptions.json` in the scratch `CRETLI_DATA_DIR` → false. `node:test`'s `mock.module`
  won't repoint a binding the importer already captured (the caller is statically imported at the top
  of the suite), so it is NOT the right tool here.
- Instead add the repo's own convention: a module-global seam defaulting to `null`
  (`let depsForTest = null; export function __setXForTest(d){ depsForTest = d && typeof d==='object' ? d : null; }`)
  forwarded as the helper's *second* `deps` arg (`notifyAgentFinished(input, depsForTest || {})`).
  Inert in production, mirrors `__setChatTitleServiceForTest` and the existing `createChatTitleDispatcher(deps)`
  / `notifyAgentFinished(input, deps)` injection style. Inject `isPushAvailable/hasPushSubscriptions:
  ()=>true` + a `broadcastPush` that records into an array → the REAL helper still runs its flag/dedupe
  logic faithfully, so you can assert both "wrong-type frame pushes nothing" and "one real finish +
  one fake + one duplicate = exactly 1 broadcast; a real `sdkPromptStarted` re-arms to 2".
- This seam is a production-file edit *beyond* the literal guard — justify it as "necessary to prove
  the guard" and list it under deviations, keeping it additive/null-defaulted. Prove the bite with the
  standard fix-disabled experiment: neuter to the old `includes` branches (sentinel comment), the two
  new tests fail with the exact defect signature (`broadcasts.length` 2≠1 and 3≠2), restore, grep the
  sentinel → exit 1, re-run green.

- **An existing test may codify the very bug you are fixing.** Approval-advisor round: the block
  "A medium-risk mutation is also ineligible" asserted exactly the buggy contract, so implementing
  the task's intent *must* flip it. Invert it in the same change and list it under deviations —
  keeping it would leave the suite red post-fix or lock in the old behavior; silently deleting it
  would hide a contract change.
- **Plain assert scripts abort at the FIRST failing assertion** (no test() isolation). The pre-fix
  run therefore only shows one bite (`AssertionError … false !== true` + stack line) and never
  executes your later new blocks — say exactly that in the report ("first new assertion failed
  pre-fix; subsequent blocks are post-fix green or locks"), don't imply the whole set ran red.

Also verify each new assertion's *semantics* before running, or you'll "fix" a test that was wrong:
a directory holding a plugin is still a perfectly valid root for `resolveHarnessPluginRoot`, so
asserting `root_invalid` for it is wrong. Similarly `assert.equal(x.length, 1)` beats
`assert.deepEqual(x.length, 1)`.

## Step 2b — classify every new assertion BEFORE the fix with a scratch probe (2026-10-04, OpenCode quoted-path FP)
A plain assert script aborts at the first failing assertion, so a single pre-fix run tells you only
about assertion #1 and leaves you guessing which of the other new cases were real bites vs which
were behavior locks. Fix that with a throwaway probe instead of guessing:
1. Write `/tmp/<scratch>/precheck.mjs` that imports the **real** module by absolute path and, for
   each case, prints one JSON row of every observable that matters
   (`{command, within, decision, reply, reason, risk, categories}`) — no asserts, so nothing aborts.
   **Never put it under `tests/`**: `scripts/run-unit-tests.mjs` globs `tests/*.test.js`, so a
   scratch file there gets auto-wired into `npm test`. `rm -rf` it at the end and don't mention it
   as an artifact.
2. Run it against the UNFIXED code, then again after the fix. That diff is the evidence table for
   the report, and it catches the case where the fix also flips something you did not assert.
3. Report each new assertion as *bite* or *lock* explicitly. Here: `grep -r 'foo' '../i18n'`
   within false→true (the bite; pre-fix failure was `false !== true` at the suite's line 518), while
   `cat ../etc/shadow`, `cat /etc/passwd` and `bash -c 'cat ../etc/shadow'` were already
   `within:false` pre-fix ⇒ locks, honest label, not hidden.
4. The probe is also how you capture the **accepted trade-off** the task told you to document:
   `cat '../etc/shadow'` went false→true (quoted relative path no longer flagged). Asserting it
   would have contradicted the brief; instead record the row in the report and in a code comment.

**When you reuse a normalization helper for a different scan, re-derive the tokenizer by hand — do
not trust the helper's docstring.** `readCommandPositionText()` was written for *command-position*
regexes; feeding it to the relative-path token scan only keeps nested-shell detection intact because
of a specific interaction: for `bash -c '…'` it maps quotes to `;`, and while `;` is NOT in
`relativeTokenPattern`'s boundary class `(?:^|[\s"'`=(])`, it IS excluded from the capture class
`[^\s"'`;|&<>()]*`, so the inner `../etc/shadow` is still captured at the next space. Had `;` been a
legal capture char, the token would have glued to `;cat` and detection would have silently died.
Verify by tracing the transformed string's indices, then confirm with the probe. Same round: keep the
absolute-path scan on the RAW command (`cat '/etc/passwd'` must stay outside) and leave a comment at
that call-site saying why, or a later "consistency" edit will break it.

## Step 3 — hardening a loader that trusts caller-supplied paths
Recipe that satisfied a MEDIUM "catalog can point a victim id at another plugin directory" finding
(`lib/agent-harness/harness-plugin-loader.js`):
- **Re-resolve the root at load** with the same `resolveHarnessPluginRoot` discovery uses; on failure
  emit one catalog-level row with `field: 'root'` and propagate the resolver's own code
  (`root_invalid` / `root_missing` / `root_unreadable` / `root_symlink`). This also clears the
  "no root validation on load" LOW finding, and removes spurious `entry_escape` rejections when the
  caller passed a root that differs from its realpath.
- **Derive the directory from the validated `dir` name only**: a safe direct-child regex
  (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`) plus explicit `path.basename(x) === x`, NUL, and empty checks;
  then `lstat` (exists, not a symlink, is a directory) → `realpath` → containment against the
  canonical root. New codes joined the module's existing vocabulary: `dir_unsafe`,
  `plugin_not_directory`, plus reused `plugin_symlink` / `plugin_unreadable` / `plugin_escape`.
- **Downgrade `dirPath` to an assertion, never an input**: if a non-empty `dirPath` resolves to
  something other than the derived canonical directory, refuse the plugin (`dir_mismatch`,
  `field: 'dirPath'`) before any fs access or import. Compare through `path.resolve` so
  normalization-only differences (trailing separator) still pass — and add a tolerance test so nobody
  later makes the check stricter. **Ignore `entryPath` entirely** and re-resolve the entry.
- **Do not echo untrusted values into error messages** (log injection); reference the trusted `dir`
  instead.
- **Share one implementation between discovery and load** (extract `resolvePluginDirectory` and let
  `readPluginDirectory` use it) so the two paths cannot drift. Keep discovery's observable codes and
  messages identical — a name from `readdir` is always a safe segment, so the new `dir_unsafe` branch
  is unreachable there.
- **Name the residual gap you deliberately did not close** and why. Here: forging *both* `dir` and
  `dirPath` still imports the decoy entry, because load revalidates the catalog manifest instead of
  re-reading `<root>/<dir>/harness-plugin.json` from disk. Closing it changes load semantics to
  "re-discover per plugin" and breaks an existing test's expected code — so escalate it as a reviewer
  decision rather than doing it silently under a scoped assignment.

## Step 3b — BE7 recipe: explicit guard in the legacy `/ws-agent?resume=` branch
- Place the check inside the existing `if (isAgent && resumeId && !agentRunName)` block, right after
  `const chat = getChatByCursorSessionId(resumeId);`, before the builtin-transport close and the
  single `handlePtyConnection(` call site. `rawHarnessTransportKind` was already imported by the
  dirty WIP hunk — no import edits.
- Reuse close code 4000 (the existing unsupported-resume status). WebSocket close *reasons* must be
  ≤123 bytes. `pty-ws-handler.js` appends `--resume <resumeId>` verbatim, so the reason must be a
  static string with no fs paths. Before inventing a distinct reason, grep `app_front` for special
  handling of the close code/text (BE7 finding: the front has none — reconnect delays don't key on
  4000 — so a distinct static reason was safe).
- The `!agentRunName` bypass predates the builtin guard and covers both: `resume=<chatSid>&agentRun=x`
  still reaches `handlePtyConnection`. Changing it would alter builtin resume behavior, which scoped
  assignments preserve — record it as a residual gap for the reviewer, don't silently widen scope.
- Prove it with the Step 2 source-scan test; keep the builtin-list assertions as a lock.

## Step 4 — proving scope when the files are untracked
`git diff` shows nothing for `??` files, so verify "I only touched N files" three ways:
- `git status --short` compared against the snapshot in the prompt — the dirty set must be identical
  (the pre-existing modified/deleted files are someone else's work-in-progress; never revert them).
- `ls -la --time-style=+%Y-%m-%dT%H:%M` on the sibling untracked files: the ones you wrote have a
  later mtime than the ones you preserved.
- `date -u` to interpret those mtimes against local time.
`find lib tests -mmin -60` is weak corroboration only — it also matches other work from the same
session, so rely on the mtime comparison for the byte-for-byte claim.

## Step 5 — targeted verification, with a recorded baseline
- `node --test tests/<suite>.test.js` for each affected suite, and quote the summary lines
  (`# tests / # pass / # fail`) verbatim.
- **The [TASK] may name a runner that does not exist.** Approval-advisor round (2026-10-02): the
  instructed command was `node --experimental-vm-modules node_modules/.bin/jest tests/...` — jest is
  not installed in this repo (`npm test` = `scripts/run-unit-tests.mjs`). Run the named suite with
  the repo-native form anyway (`node tests/<file>` for plain assert scripts, `node --test` for
  node:test files), pass it, and report the command substitution as a deviation — do not mark BLOCKED
  over a stale doc command, and do not silently skip the suite.
- Capturing results: `tail -1` of piped output can show an `ExperimentalWarning` line instead of the
  verdict, and `echo exit=$?` after a pipe reports the pipe's last stage, not node's. Use
  `"$out" 2>&1; e=$?` into a file or `${PIPESTATUS[0]}`, and grep for ` OK$` / `^# (tests|pass|fail)`.
- Lint the changed files only (`npx eslint <paths>`), **then** run repo-wide `npx eslint .` once to
  capture the pre-existing baseline (drifts with others' WIP: `12 problems (0 errors, 12 warnings)`
  on 2026-09-30, `13/13` on 2026-10-02 — always report the count you actually saw, 0 errors is the
  load-bearing part). Report both so "clean" is not overclaimed.
- **Cover the blast radius by enumerating importers instead of running the whole glob.** Before
  deciding which adjacent suites matter, `grep -rln "<changed-module>.js" lib tests scripts app_front`.
  That list IS the regression surface. OpenCode round (2026-10-04): the changed function
  `isOpenCodePermissionWithinWorkspace()` had exactly one runtime consumer
  (`resolveOpenCodeApprovalAction()`, same file, ~line 378) and the grep surfaced 8 suites importing
  the module — approval-broker, approval-advisor, opencode-plan-mode, plan-approval-reply,
  opencode-event-normalizer, plan-mode-enforcement, delegation-review-lock,
  delegation-adapter-incomplete. Ran all 8 (all PASS) and skipped full `npm test`, saying so in the
  report with the reason — that is stronger than one arbitrary smoke suite and defensible as scope.
  (e.g. `npm run test:harness-status` still shows the module graph loads.)
- Discover the sibling runner script names from `package.json` rather than guessing:
  `node -e "const p=require('./package.json');for(const [k,v] of Object.entries(p.scripts))if(/approval|permission|opencode/.test(k))console.log(k,'=',v)"`.
  Per-suite scripts exist (`test:opencode-permission` = `node tests/opencode-permission.test.js`), so
  a task-named `npm run test:<x>` is usually REAL — run it as written; only substitute when missing.
- A plain assert script reports no counts at all: it prints exactly `<file>.test.js OK` on exit 0.
  When the report asks for "liczba testów/status", say that explicitly and give the honest proxy
  (`grep -c "assert\." <file>` → e.g. 98 assertion call sites) rather than inventing a `# tests N`
  line that the runner never emits.
- Check how the runner discovers suites — read `scripts/run-unit-tests.mjs`, don't grep it for the
  suite name. Verified semantics: it **globs every `tests/*.test.js`** (sorted), spawns each in its
  own process, uses `node --test <file>` iff the source matches `from ['"]node:test['"]`, and sets
  `CRETLI_DATA_DIR` to a scratch mkdtemp. So any new `tests/<name>.test.js` is auto-wired into
  `npm test` — no package edits needed. (An older note here claimed the harness-plugin suites were
  not covered; that was wrong — they live in `tests/` and are globbed.) Files outside the
  `tests/*.test.js` glob (e.g. `tests/live/`, `tests/helpers/`) still need their own wiring.
- Two test styles coexist in `tests/`: `node:test` suites (harness-plugin, theme, widget) and plain
  assertion scripts ending in `console.log('<file>.test.js OK')` (harness-status). Read the file
  before choosing a runner form. `scripts/run-unit-tests.mjs` has **no id/filter argument** (it only
  globs), so run adjacent suites yourself with the right form per file:
  `if grep -qE "from ['\"]node:test['\"]" tests/$f.test.js; then node --test …; else node …; fi`.
- **Attribute lint output before claiming "clean".** `npx eslint .` prints only totals; to prove the
  errors are not yours, get per-file counts:
  `npx eslint . -f json 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{for(const f of JSON.parse(s).filter(x=>x.errorCount||x.warningCount))console.log(f.filePath.replace(process.cwd()+'/',''),'E'+f.errorCount,'W'+f.warningCount)})"`
  (2026-10-03 baseline: `20 problems (2 errors, 18 warnings)`, both errors in `public/sw.js` — a file
  clean vs HEAD, i.e. pre-existing). `npx eslint CHANGELOG.md` emits a harmless
  "File ignored because no matching configuration was supplied" warning.
- **Prove a red sibling suite is pre-existing WITHOUT stashing other people's WIP** (never
  `git stash` on a dirty shared branch — you would revert someone's unfinished half). Three
  non-destructive facts are enough: `git status --porcelain <test> <its-module>` empty ⇒ neither was
  touched this round; the failing assertion's needle is absent from the committed product file
  (`git show HEAD:lib/sdk/sdk-plan-guard.js | grep -c 'Review assignment'` → `0`) while the committed
  test expects it (`git show HEAD:tests/sdk-plan-guard.test.js | grep -c …` → `1`) ⇒ red at HEAD, not
  caused by your edit. `grep -rn '<needle>' lib/` on the working tree shows whether anything emits it
  at all. Report it under "remaining problems" and do not fix it inside a scoped assignment.

## Step 6 — when the bridge session is dead, report BLOCKED honestly
Happy path confirmed three times (BE7; 2026-10-02 with a fresh `delegation_show` right before sending —
it printed the live `attempt_id`/`run_id` and I still omitted both; and 2026-10-04 OpenCode FP round,
where I called nothing beforehand and `delegation_reply` still queued cleanly): `delegation_reply` with
`delegation_id` + `reply_kind=final_report` + `task_outcome=success` + stable `idempotency_key` and
NO `attempt_id`/`run_id` returns `Queued reply <uuid> status=queued to=<parent>` without CONFLICT —
omit them unless the error names the executing run.
- **Fixes that widen a gate may leave a sibling bias in place — report it, don't "fix" it.** The
  approval-advisor eligibility now lets mutation-only commands reach the external model, but the
  module's `ADVISOR_SYSTEM_PROMPT` still tells the model to approve only read-only actions — so the
  model itself may keep answering `ask_user`. Rewriting prompts is a product decision outside an
  eligibility scope; name it under "remaining problems".
Never pass `chat_id` unless you are certain it is *this* executor chat's UUID — the prompt gives the
*parent* chat and the delegation id, and neither works: `chat_id = <delegation_id>` returned
`CONFLICT: delegation_reply chat_id must be this chat. You cannot reply as another executor.`
(2026-09-30). Simply omit `chat_id` and retry with the same `idempotency_key`; it queued cleanly.
Symptom of the failure case: every `cretli_bridge` call returns `MCP session is unknown or no longer active` — including
read-only `ping_read` and `delegation_show`, not just `delegation_reply`.
- The session can die **mid-run**: the same `delegation_show`/reply tools that worked while you paged
  the [TASK] reports can start returning that error only at final-reply time (2026-10-01). So don't
  trust early-success as proof the channel is alive — confirm with one **fresh** read-only
  `delegation_show` call right before concluding, and note it may have succeeded earlier.
- Diagnose with one read-only call before concluding: a payload/validation error is yours
  (see the review skill's `message_text` vs `history_seq` rule); a *session* error on a read-only tool
  is infrastructure, and retrying variants won't help.
- Retry the reply a bounded number of times (2–3, one short wait between) reusing the **same stable
  `idempotency_key`** so a late-successful first send cannot duplicate.
- Do **not** mark `VERDICT: PASS` as if the report landed, and do not fabricate delivery. Put the
  *complete* report in the chat response so nothing is lost, append a "Delivery blocker" section with
  the exact error string, the attempts made, and the idempotency key to replay with, then end with
  `VERDICT: BLOCKED` — even when the code work itself is finished and green. State plainly which half
  is done, so the parent can re-send or relay without redoing work.

## Step 7 — a multi-finding round (2026-10-04, Scout Agent: 7 findings in one [TASK])
A single implement delegation can bundle several independent review findings. Triage before coding:
- **Some findings are ALREADY landed in the same dirty WIP** (a prior interrupted attempt). Do NOT
  re-implement — verify and preserve. Here Finding 5 ("`workspace-watcher-scout` reported as
  registered but host rejects it as unknown") and Finding 7 (smuggled/duplicate id sanitization) were
  already done: `git show HEAD:lib/sdk/sdk-review-verify.js | grep -c workspace-watcher-scout` → `0`
  but the working tree carries it, and `node scripts/review-verify.js workspace-watcher-scout` runs
  green. Confirm end-to-end, cite the existing test, list it as "landed, verified, preserved."
- Fix findings in dependency order (persist/store shape → producers → consumers → tests) and run the
  full dedicated + adjacent suites once at the end.

**Threading one field through every transport layer.** A "record X" finding (persist the review
finding *text*, not just its hash) is dropped SEPARATELY at each hop — the fix touches ALL of them:
MCP `inputSchema` property (a value not in the schema is stripped before the handler ever sees it) →
the builtin tool handler's `client.<method>({ ... })` call args → BOTH client impls
(`mcp-inprocess-client.js` AND `remote-api-client.js`, which build different bodies for the same
action) → the REST route's `req.body` parse → the control fn → and finally the **persist normalizer**
(`normalizeWorkspaceWatcherPolicy` / `normalizeFindings`) which silently drops unknown keys. Grep the
alias set across all layers (`grep -rn 'record_findings|findings_hash|findingsText|byTodo'`) and confirm
each one passes the field; the store often already supports it while every *transport* drops it.
- **New policy keys:** add to BOTH `defaultWorkspaceWatcherPolicy()` AND `normalizeWorkspaceWatcherPolicy`
  (else a `getWorkspaceWatcher` read-back has them stripped). Before changing the policy SHAPE, check
  for a whole-object baseline: `grep deepEqual tests/ | grep -i policy` — `workspace-watcher.test.js`
  asserts `deepEqual(row.policy, defaultWorkspaceWatcherPolicy())`, so default↔normalize MUST stay
  symmetric. Preserve a raw value (e.g. a shell-string command) verbatim in the normalizer so a
  downstream safety check can detect misconfiguration rather than silently coercing it.

**New-export test red via namespace import (important!).** A plain `import { newFn } from '../lib/x.js'`
of a symbol the module does NOT export yet raises a link-time `SyntaxError` that takes down the ENTIRE
suite, so you get zero useful pre-fix signal. Instead add `import * as scout from '../lib/x.js'` and
call `scout.newFn(...)` / read `scout.SOME_CONST` in the new cases: pre-fix `scout.newFn` is
`undefined` → a per-case `ReferenceError/TypeError` that the repo's `runCase(name, fn)` harness CATCHES
→ clean per-test red (7 fail / 26 pass), and post-fix the export resolves and it's green. This lets you
run a genuine pre-fix red pass for brand-new functions instead of relying only on the fix-disabled
experiment. For findings in code paths that have NO new export (the record_findings schema/handler and
the in-process `scan_id` auto-inject), still prove the bite with fix-disabled neuters
(`findingsText: undefined /* NEUTER_A */`, `if (false && !scanId) … /* NEUTER_B */`), then grep the
UNIQUE sentinel, not generic `false &&` — the repo already contains `requirePlanApproval !== false &&`
so a bare `grep 'false &&'` matches unrelated pre-existing lines.

**Race-free scoped cleanup in the write lock.** For "clear the active token / scan on every failure,
race-free," never blind-clear the shared row: `clearActiveScoutScanIfScanId(folder, scanId)` reads
`activeScoutScan.scanId` INSIDE `mutateWorkspaceWatcherRow`'s CAS mutator and clears only when it still
matches your `scanId` (return `null` to no-op otherwise), so an older failed op can't wipe a successor
that already replaced it. Couple this with an `accepted` flag: on runner throw BEFORE acceptance roll
back the schedule stamp AND clear your own scan; on a throw AFTER the runner returned `started:true`,
KEEP both (a live worker still owns those credentials and consumed the slot). Orphan side effects (the
chat `addChat` created before `startChatRun` threw) get best-effort delete wrapped in try/catch, and
only on the not-accepted path — never remove a resource whose operation succeeded.

**"Bounded probe vs. why-not" findings.** When a finding says "implement X safely OR give concrete
evidence it's not possible and robustly consume available signals," and running it inline would block
a shared heartbeat worker or write the live workspace, the accepted resolution is an OPT-OUT-BY-DEFAULT
guard: `policy.<flag>===true` gate + argv-only (reject a shell string, `Array.isArray && every string`)
+ `execFileSync(..., { timeout: <the previously-unused const>, maxBuffer, stdio:['ignore','pipe','pipe'],
env:{PATH,HOME} })` so it can neither hang nor leak secrets, wired into the existing injectable seam.
This both consumes the dead constant (the finding's tell) and never runs uncontrolled.

## Step 7b — front-end dashboard / UI finding bundle (2026-10-04, Workspace Watcher Monitoring Dashboard)
A second kind of round: several findings in the *Settings dashboard* (pure renderers `watcherDashboard.js`
/ `watcherTimeline.js` unit-tested in Node with injected `now`; the DOM wiring lives only in
`workspaceWatcherSettings.js`). No jsdom in the suite, so DOM/SCSS findings are proven by **source-scan**
tests (read the `.js`/`.scss` with `readFileSync`, `assert.match`/`doesNotMatch` on unique needles) while
aggregation/render findings get behavioural tests. Non-obvious things that bit:
- **Live websocket refresh must NOT rebuild the editable form.** The `cretli:workspace-watcher-changed`
  listener called the full `refresh…()` which did `root.innerHTML=…` → wiped unsaved policy edits. Fix:
  give the refresh an options object and branch on `full`: live events pass `{ full:false }` and repaint
  ONLY the `#watcher-dashboard` subroot (`paintWatcherDashboard`), leaving the form + status card. Keep
  the *default* `full=true` for init / save / manual action / tab-show (`refreshSettingsTabPanels` calls
  `callLoadedPanel('watcherSettings','refresh…')` with no arg). `renderWatcherPanel` (form) gated behind
  `if (full) { … }`. The dashboard container element persists across paints (only its `innerHTML`
  changes), so its click/change listeners never duplicate and the guard is what prevents a full-form wipe.
- **Race-guard EVERY await boundary, not just the top.** Add `let refreshSeq=0`; `const seq=++refreshSeq`
  at entry; after each `await` (`getWatcher`, and inside `loadWatcherStats(seq)`/`loadTodoTitles(seq)`
  BEFORE assigning the module cache) do `if (seq !== refreshSeq) return;` — a stale overlapping fetch must
  not overwrite newer state. The helper-internal check is the easy one to forget.
- **Force a full render until the form has rendered once.** A live `{full:false}` event can race the very
  first `full=true` load and bump `refreshSeq`, so the initial render is dropped by the guard and the
  dashboard-only path finds no `#watcher-dashboard` → form never mounts. Gate `full` on
  `options.full !== false || root.dataset.rendered !== 'true'`, and set `root.dataset.rendered='true'`
  right after `renderWatcherPanel`. Then any pre-first-render refresh upgrades to full.
- **Ticker cleanup in an init-once / hidden-not-destroyed panel.** Settings panels are `initPanelOnce`'d
  and merely `section.hidden=true` when their tab is inactive — there is NO unmount hook, so a
  `setInterval` started in `bind…` would spin forever. Self-clean inside the per-second tick: bail +
  `clearInterval` when `!container.isConnected || container.offsetParent === null` (a hidden subtree reports
  null offsetParent), and add a `visibilitychange` listener that stops the timer when `document.hidden`.
  Restart piggybacks on the next tab-show full refresh (which re-enters `bind…` and re-arms because the
  timer var was nulled).
- **Positioning fallback vs duration are SEPARATE concerns.** `normalizeCycleEntry` in the stats store layer
  correctly set `durationMs=null` for a legacy cycle lacking `startedAt`, but the *timeline* renderer
  re-derives its own bar from raw `startedAt`/`at` and computed `startMs`-fallback-then-`end-start` =
  **0ms**. The duplicate derivation reintroduced the bug the store had already fixed. Fix: keep the close
  instant only for `startMs` (where the bar sits) but gate `durationMs` on a *real* parsed start
  (`realStartMs!=null && endMs>=realStartMs ? … : null`). Lesson: when two layers normalize the same
  record, assert the contract in BOTH, not just the producer.
- **Throughput semantics change = flip the test that codified the old contract.** Finding "count TODOs
  completed by autopilot, not closed cycles": daily/weekly `total` now counts **distinct** `todoIds` from
  `outcome==='success'` cycles (deduped, credited to the earliest success close), and `failure`/`blocked`
  are informational only (excluded from `total`). Cycle-level KPIs (`outcomes`, `successRate`,
  `avgDurationMs`) legitimately stay cycle-based. The existing "computes … daily/weekly buckets" test
  asserted `today.total===2`/`thisWeek.total===3` (cycle counts) and HAD to be inverted to the new values —
  list that under deviations, don't silently leave it locking the old behavior.
- **Sourcing a display field (harness): persist-through-lifecycle beats runtime store lookup when the
  store read isn't dataDir-aware.** `loadChats()` takes no `dataDir`, so reading the orchestrator chat's
  transport at stats time is non-deterministic under the injected clock/dir. Instead thread `harness`
  producer→consumer: stamp it on the live slot at finalize (`replaceWorkspaceWatcherCycle(…,
  { …cycle, harness: String(orchestrator.harness||'') })`) → `normalizeActiveCycle` preserves it →
  `buildWorkspaceWatcherCycleClosePatch` copies `cycle.harness` into the entry → `normalizeCycleChats`
  preserves → stats `normalizeCycleEntry` + `normalizeTimelineBar` carry → detail renders
  `t('…Harness')`. Before adding the key to a normalizer's output, grep for a whole-object baseline
  (`grep -rnE 'deepEqual\([^)]*(activeCycles|cycleChats)' tests/`) — here only id-arrays were compared, so
  the extra key is safe.
- **CSS token-mismatch findings: verify the REAL token, not the fallback literal.** The success tone used
  `var(--cr-accent, #2e7d32)` — the fallback is green, so it LOOKS intentional, but `--cr-accent` resolves
  to blue (#0F8DCB) at runtime; success must use `var(--cr-success, …)`. Fix the selector(s) that mean
  success (timeline `data-outcome-tone='success'`, throughput `[data-success]`). Prove it with a
  neuter-back-to-old-token source-scan experiment (the `.scss` is untracked, no `git show HEAD:` baseline):
  `perl` revert one rule, run the scan test → fail, restore, `grep` a unique sentinel → exit 1.

## Step 7c — Settings *policy-editor* form leaf (2026-10-04, "watcher policy editor without editing JSON")
A different UI shape than 7b: not pure renderers but a **two-way editor form** whose controls map to a
server-normalized policy object (`normalizeWorkspaceWatcherPolicy`) that persists through a partial PATCH
(`mergePolicy` shallow-merges top-level keys and deep-merges `quietHours`/`orchestrator`). Non-obvious moves:
- **The named "critical backend change" may already be landed in the same WIP.** Here the cap
  `maxParallel: Math.min(WORKSPACE_WATCHER_MAX_PARALLEL(5), Math.max(1, normalizeCount(...)))` and the whole
  Scout field set were already in `default`+`normalize` (from this branch's prior round). Don't re-implement —
  verify, and add a **source-scan lock** in the new test asserting the clamp lives in the normalizer, not only
  the HTML `max` (the brief's exact fear). Cite the pre-existing case (`workspace-watcher.test.js` "caps
  maxParallel at 5 (99 -> 5)").
- **A "default X" in the brief can contradict the shipped+tested default — do NOT silently change a persisted
  VALUE to match the brief.** The brief said "cooldown default 30s" but two tests hard-code `60_000`
  (`workspace-watcher-routes.test.js` read-back, `workspace-watcher.test.js` expected object). `grep -rn
  'cooldownMs|<that-literal>' tests/` first; if pinned, keep the server default, make the UI mirror the SHIPPED
  value in Reset-to-defaults (so reset+refetch never jumps), and list the brief-divergence under deviations as a
  parent decision. Changing it is a scope/value risk, not a UI task.
- **Never add a persisted field just to back a UI toggle — derive state from the consumer's existing semantics.**
  Quiet-hours "enabled" was done purely in the UI by sending `{start:'',end:''}` when off, because the guardrail
  (`parseWorkspaceWatcherQuietHours`) already treats empty/invalid (and `start===end`) as "no window", and wrap
  across midnight (`start>end`) is already handled. Adding `quietHours.enabled` would change the persisted policy
  SHAPE and break `assert.deepEqual(row.policy, defaultWorkspaceWatcherPolicy())` unless mirrored in BOTH default
  and normalize. Read the consuming function before inventing a field.
- **Optimistic save + live refresh must repaint an ISOLATED subregion, never `root.innerHTML`.** Extract the
  status card into `renderWatcherStatusCardHtml(data)` wrapped in `<div id="watcher-status-card">` + a
  `paintWatcherStatusCard(root)` that sets only that node's innerHTML. On Save: snapshot `const prevView=lastView`,
  mutate `lastView.watcher` (mode+policy) and `paintWatcherStatusCard(root)` BEFORE the awaited PATCH; on a
  non-ok/throw restore `lastView=prevView` and repaint; on success do the authoritative full refresh. Also call
  `paintWatcherStatusCard(root)` from the dashboard paint so the `{full:false}` live path updates the card without
  touching the form. (Extends 7b's live-refresh rule to a deliberate optimistic pattern.)
- **Catalog-driven checkbox multi-select must preserve already-selected ids the catalog no longer lists.** Build
  options from `GET /api/harness-catalog/harnesses` (`{items:[{id,label,enabled,ready}]`) fetched in the FULL path
  (`Promise.all([viewApi, full?catalogApi:resolve(null)])`, guarded by the seq generation), then append any
  saved id absent from the catalog so a save can never silently drop it. Empty allowed set = "any harness" on the
  server, so "no boxes checked" is meaningful, not an error.
- **Clamp a bounded number in THREE layers so they can't drift:** HTML `min/max`, client `validateWatcherForm`
  (`!Number.isInteger || <1 || >5`), and the server `Math.min/max`. The brief explicitly wants the cap in the
  normalizer, not only the input `max`.
- **Slider that trades a derived unit (ms→min): grow its `max` to fit an unusually large saved value** so
  saving-without-touching never silently lowers it (`Math.max(DEFAULT_MAX, ceil(saved/step)*step)`), live-update
  a readout span on `input`, and accept that fractional server-legal values (0.5h) aren't representable on a
  1–24 integer slider — note it as a deviation.
- **"Reset to defaults" is form-only — do NOT auto-PATCH it.** A stray click must not flip a live autopilot
  workspace or wipe allowed harnesses; repopulate controls from a client mirror of `defaultWorkspaceWatcherPolicy`
  and let the operator press Save.
- **Preserve the pinned field IDs from the existing `*-settings-ui.test.js` contract while rewriting the markup**
  (it `readFileSync`s the panel and `source.includes('id="watcher-cooldown"')`-style asserts a fixed id list).
  Read that test first; keep every id it names (changing a `<select>`→radio or number→range is fine, the id isn't).
- **`i18n-dictionaries.test.js` is strict:** en↔pl flattened key sets must be identical, no empty values, the
  `{placeholder}` sets must match per key, and en.js must contain NO Polish diacritics (`/[ąęćńóśźżł]/i`). Add the
  mirrored block in one shot; unit words like `s`/`min`/`h` are safe ASCII for both.

## Step 3d — Workspace Watcher snapshot liveness + decision-log (2026-10-04, "don't block a cycle on closed chats")
Scope was explicitly "only `snapshotWorkspaceWatcher` + the decision save in `lib/workspace-watcher.js` + docs",
forbidding edits to `probeChatRunLiveness` and to the `unknownAgentCount > 0` branch of `decideWorkspaceWatcherAction`.
Reusable, non-obvious findings:
- **A cold chat is "unknown" only if the snapshot has a positive work trace for it.** Build `inFlightChatIds` from
  data `snapshotWorkspaceWatcher` already reads: `claimedByChatId` on todos with status ≠ `done`, and the
  `parentChatId`/`childChatId` of delegations where `isDelegationSlotOccupied(row, now) || isActiveDelegationStatus(row.status)`
  (covers an unconfirmed `runStoppingAt`). Drop `excludeChatIds`/`excludeDelegationParentChatIds`/`excludedCycleChildChatIds`
  from it. Then when `live.known !== true`: `chat_missing` → skip entirely; `state_missing`/`adapter_missing` with no
  trace → idle (skip), with trace → unknown; `adapter_error`/`probe_failed`/`run_mismatch`/any-other reason → unknown
  regardless of trace. `lookupChatRunRequest` never joins (needs a requestId the snapshot lacks). Classify the reason
  at the CONSUMER — do not touch the real `probeChatRunLiveness` (delegations/reconcile still treat `known:false` as
  "no proof the run ended").
- **The persisted decision log silently strips unknown fields, so "add a field to the stored decision so Why? shows
  X" survives only in the pinned-chat notice, NOT the structured log.** `normalizeDecision` in
  `lib/persist/workspace-watchers-persist.js` rebuilds each entry from a fixed whitelist (at/kind/reason/readyTodoCount/
  activeAgentCount/shouldNotify/nextTodoId), so after a reload `row.decisions.at(-1).<newKey>` is `undefined` even
  though you wrote it into `patch.decisions`. When that normalizer is OUT OF SCOPE: assert against the in-memory
  `tick.decision.<key>` / `tick.snapshot.<key>`, and verify the durable surface through `describeWorkspaceWatcherDecision(decision)`
  (which `appendWorkspaceWatcherNotice` feeds into the pinned chat at tick time). Report "widen `normalizeDecision` to
  preserve the key" as a follow-up instead of editing the forbidden file. Before trusting a new decision field,
  `grep -n 'nextTodoId\|activeAgentCount' lib/persist/workspace-watchers-persist.js`. My first test asserted the
  persisted entry and failed exactly here — that was the course-correction, not a wrong product fix.
- **Confirm no whole-object baseline before adding a field.** Existing tests read decisions only by `.kind`/
  `.nextTodoId`/`.length` (grep `decisions.at(-1)`), so extra keys are safe — but check nothing `deepEqual`s a stored entry.
- **e2e: force `state_missing` for historical chats without breaking the cycle start.** Add real chats via
  `addChat(sessionId, title, cwd, cwd, 'mock', { id })` (so `listWorkspaceChatIds`, which reads `loadChats()` filtered
  by normalized folder, returns them), then inject
  `probeChatRunLiveness: (input) => coldIds.has(String(input.chatId||'')) ? { known:false, busy:false, reason:'state_missing' } : realProbe(input)`
  — import the REAL probe and delegate to it for every other chat, so the cycle's own orchestrator chat still reads
  busy through the mock adapter and `runWorkspaceWatcherAutopilot` yields exactly `started===1` / `getMockChatRunStartCount()===1`.
  This is the acceptance assertion the fix unblocks the tick (pre-fix: `wait_active`/`unknown_liveness`, `started===0`).
- **The `observeDeps()` test helper disables delegation liveness** — it sets `isActiveDelegationStatus: () => false`
  and omits `listWorkspaceChatIds`/`probeChatRunLiveness`/`isDelegationSlotOccupied`. For trace/unknown snapshot tests,
  pass a FULL deps object and leave `isDelegationSlotOccupied`/`isActiveDelegationStatus` to the real module (so a
  recent `runStoppingAt` on a terminal `completed` row correctly reads as occupied).
- The catalog runner the task suggested works as-is: `node scripts/review-verify.js workspace-watcher` (exit 0, prints
  one `OK:` per case + "workspace watcher tests passed"). Note `# pass 1` from `node --test` is the collapse artifact
  (see Step 5) — grep the per-case `OK:` lines and `FAIL:` to know the real outcome.
- Verify with the repo's runner substitution: `workspace-watcher*.test.js` use a custom `runCase` harness (plain
  assert scripts) so run `node tests/<file>.js` (→ "… tests passed", exit 0), not only `node --test` (which
  collapses them to "# tests 1"). Author the NEW UI test as `node:test` source-scan (no jsdom). eslint attribution
  for this repo: the 2 baseline errors live in `public/sw.js` (`no-undef importScripts`), clean vs HEAD.

## Step 7e — "add a new append-only store / feature" variant (2026-10-05, plan-limit history)
Not every implement assignment is fix-a-review-finding. Some add a brand-new capability wired into
existing producers. The reusable mechanics, all of which applied to "Historia odczytów limitu planu"
(a JSONL history of every plan rate-limit reading, alongside the existing last-snapshot upsert):
- **The new read/write module must be a LEAF to break the import cycle.** When the task says both
  `harness-health.js` and `harness-usage-limits.js` import the new history store, put write+read in a
  fresh module that imports only leaf deps (`runtime-paths.js`, `node:fs`, `node:path`) — never import
  either consumer back. Making history a leaf is the safe construction (the task asked for it explicitly).
- **Two producers feed one file — gate to avoid a double row for the SAME observation.** Source (a) is
  the structured snapshot (`noteHarnessPlanLimit`), source (b) is a text rejection
  (`noteHarnessUsageLimit`). But a rejected `rate_limit_event` in `room-kernel` fires BOTH
  `noteHarnessPlanLimit({...planLimit})` AND `noteHarnessUsageLimit({ source:'rate-limit-event' })` for
  the SAME signal — so append history only in the `error-text` branch and skip the `rate-limit-event`
  branch (it is already logged via a). Reason about which producer is the *same* observation, not just
  which functions you touched.
- **Append the history row BEFORE the snapshot's out-of-order early-return**, so an accepted-but-stale
  reading still lands in history (history = every sampling; the snapshot keeps only the latest). The
  validity gate to reuse verbatim is `if (!status && !rateLimitType && utilization===undefined &&
  !resetsAt) return null` — a reading with NONE of the four signals writes no row (don't add a stricter
  or looser gate in the history module, mirror the existing one).
- **Thread a new field (`model`) into the history row but NOT into the snapshot object.** The task said
  "pass model where known (room-kernel knows `room.modelId || room.model`)" AND "preserve snapshot /
  health-card semantics, keep existing assertions green." The snapshot object is keyed
  (`harness:rateLimitType`) and consumed by `readHarnessPlanLimits`, which spreads the row into its
  output — adding `model` there risks perturbing assertions. So: accept `input.model`, write it into the
  history row only, and pass it at the call-site (`noteHarnessPlanLimit({ ...planLimit, model:
  room?.modelId || room?.model || '', dataDir })`). New OPTIONAL return keys
  (`buildHarnessHealth.planLimitHistory = { count, lastAt }`) are safe when the route test only asserts
  `Array.isArray(health.planLimits)` / `Array.isArray(health.daily)` — a sibling key can't break those,
  but it does mean the builder now reads a second file, so keep its range filter (`from/to` over
  `observedAt`) consistent with how `limitHistory` filters over `ts`.
- **JSONL store: mirror the sibling's discipline but drop dedupe.** Reuse the sibling's retention shape
  (cap rows + age, trim every N appends or past a byte size; atomic rewrite via `.<pid>.<ts>.tmp` +
  `renameSync`; skip corrupt lines in the reader). A HISTORY of samplings must NOT dedupe consecutive
  readings — the required test is literally "40% → 70% → rejected = 3 rows per harness, two harnesses
  isolated in one shared file, filtered per harness by the reader." A reader with `from/to/limit` sorts
  ascending by `observedAt` and `slice(-limit)` keeps the newest N.
- **The timezone-fragile exact-ISO test trap (this bit me and forced a course-correction).** For a
  text-rejection row whose `resetsAt` came from a provider string, do NOT assert a hard-coded
  `'2026-12-31T00:00:00.000Z'`. `readResetAt` parses a date WITHOUT a `Z` as **local time**, so on a
  UTC+1 box it stored `2026-12-30T23:00:00.000Z` and my NEW test failed (`+ '2026-12-30T23:00:00.000Z' /
  - '2026-12-31T00:00:00.000Z'`) — a test-authoring bug, not a product defect. Fix: assert shape +
  property, `assert.match(r.resetsAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)` and
  `assert.ok(Date.parse(r.resetsAt) > Date.now())`, and only pin an exact instant when YOU fed the
  value with an explicit `...Z` (e.g. the structured-row `observedAt` you passed in). The task said
  "resetsAt gdy da się wyparsować" → presence, not a fixed instant.
- **Prove "didn't disturb the existing snapshot/card" with a contrast test, not only a green re-run.**
  Strongest case: one dataDir, two structured reads (40 then 70, same resetsAt window) → assert
  `readHarnessPlanLimits` length===1 & utilization===70 (upsert) WHILE `readHarnessPlanLimitHistory`
  utilization deep-equals `[40,70]` (both kept) and `health.planLimitHistory.count===2` with
  `health.planLimits.length===1`. Also prove the reject case end-to-end:
  `noteHarnessPlanLimit({harness, dataDir})` (no signals) returns null AND the reader returns `[]`;
  a non-limit message (`'network timeout'`) through `noteHarnessUsageLimit` returns false and adds no row.
- **Verify blast radius by running the consumer suites**, not just the mandated two: the task named
  `tests/usage-harness-health.test.js` + `tests/harness-usage-limits.test.js`, but the import edge and
  the room-kernel call-site change also needed `tests/room-kernel.test.js` + the `usage-*.test.js` set
  green to prove no cycle/regression. eslint on the new leaf + the changed `lib` files must be clean
  (exit 0), and confirm no stray `data/usage/plan-limits.jsonl` got written into the repo by tests
  (every writer in tests must thread `dataDir`).

