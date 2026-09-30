---
name: cretli-delegation-implement
description: Execute a Cretli delegated "implement" assignment that fixes a review finding — prove the finding with a failing regression test before fixing it, verify scope for untracked files, and report BLOCKED when the cretli_bridge session is dead.
source: auto-skill
extracted_at: '2026-09-29T21:13:52.207Z'
---

# Cretli delegated implement (executor, edit allowed)

Trigger: the prompt opens with "You are the executor for a Cretli delegated task", gives
`Execution mode: agent` + `Assignment: implement`, a `Delegation:` UUID, a `[TASK]` with a
review finding to fix, `[COMPLETION CRITERIA]`, and a terminator such as
"End exactly `TASK: implement` and `VERDICT: PASS|FAIL|BLOCKED`".

Companion skill: **cretli-delegation-review** (the read-only reviewer side). Its reply mechanics
in "Step 6 — send it" apply here too; only the dead-session fallback is documented below.

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

## Step 1 — treat the finding as a hypothesis, not an instruction
Read the target file and its test file fully, plus the contract/module the finding's helper lives in.
Confirm the exploit path from the code (which line actually consumes the untrusted value), and check
what else consumes the function (`grep_search` for the exported names) to prove "no runtime
integration" before claiming the blast radius is small. Prompt-quoted line numbers drift; cite the
lines you verified.
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

Also verify each new assertion's *semantics* before running, or you'll "fix" a test that was wrong:
a directory holding a plugin is still a perfectly valid root for `resolveHarnessPluginRoot`, so
asserting `root_invalid` for it is wrong. Similarly `assert.equal(x.length, 1)` beats
`assert.deepEqual(x.length, 1)`.

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
- Lint the changed files only (`npx eslint <paths>`), **then** run repo-wide `npx eslint .` once to
  capture the pre-existing baseline (observed: `12 problems (0 errors, 12 warnings)`, all in unrelated
  delegation/mcp tests). Report both so "clean" is not overclaimed.
- Run one adjacent smoke suite (e.g. `npm run test:harness-status`) to show the module graph is fine.
- Check how the runner discovers suites — read `scripts/run-unit-tests.mjs`, don't grep it for the
  suite name. Verified semantics: it **globs every `tests/*.test.js`** (sorted), spawns each in its
  own process, uses `node --test <file>` iff the source matches `from ['"]node:test['"]`, and sets
  `CRETLI_DATA_DIR` to a scratch mkdtemp. So any new `tests/<name>.test.js` is auto-wired into
  `npm test` — no package edits needed. (An older note here claimed the harness-plugin suites were
  not covered; that was wrong — they live in `tests/` and are globbed.) Files outside the
  `tests/*.test.js` glob (e.g. `tests/live/`, `tests/helpers/`) still need their own wiring.
- Two test styles coexist in `tests/`: `node:test` suites (harness-plugin, theme, widget) and plain
  assertion scripts ending in `console.log('<file>.test.js OK')` (harness-status). Read the file
  before choosing a runner form.

## Step 6 — when the bridge session is dead, report BLOCKED honestly
Happy path confirmed (BE7): `delegation_reply` with `delegation_id` + `reply_kind=final_report` +
`task_outcome=success` + stable `idempotency_key` and NO `attempt_id`/`run_id` returns
`Queued reply <uuid> status=queued to=<parent>` without CONFLICT — omit them unless the error names
the executing run.
Never pass `chat_id` unless you are certain it is *this* executor chat's UUID — the prompt gives the
*parent* chat and the delegation id, and neither works: `chat_id = <delegation_id>` returned
`CONFLICT: delegation_reply chat_id must be this chat. You cannot reply as another executor.`
(2026-09-30). Simply omit `chat_id` and retry with the same `idempotency_key`; it queued cleanly.
Symptom of the failure case: every `cretli_bridge` call returns `MCP session is unknown or no longer active` — including
read-only `ping_read` and `delegation_show`, not just `delegation_reply`.
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
