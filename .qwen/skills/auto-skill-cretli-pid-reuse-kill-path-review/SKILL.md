---
name: cretli-pid-reuse-kill-path-review
description: Review or write Cretli code that terminates other processes (webpack watch lock sweep, killExternalBuildProcesses, child-process registry, shutdown/OOM leaves) — a `kill(-pgid)` group signal must be gated on a start-time-VERIFIED owner, every PID classified independently (alive/dead/reused), descendants found via /proc ppid links never cmdline scans, and every signal try/caught so a failed kill cannot keep a lock held.
source: auto-skill
extracted_at: '2026-10-09T14:36:32.578Z'
---

# PID-reuse-safe process termination (review lens)

Trigger: a leaf whose fix kills processes — orphan sweeps, watch/build locks, shutdown wiring,
`earlyoom`/OOM leaves ("the server gets SIGTERM'd but its children keep eating RAM"). Reference
implementation as of 2026-10-09: `lib/webpack-cli-watch-lock.js` (leaf `18658d72`), reviewed PASS in
the final round. Re-verify file:line before citing — these files are new/untracked.

## The invariant that makes a kill path safe

A stored PID is a *claim*, not a fact. Linux recycles PIDs, and `kill(-pgid)` hits **every** process
in a group, including unrelated ones. So:

1. **Classify each PID independently** into `alive | dead | reused` using the Linux start time
   (`/proc/<pid>/stat` field 22). `getProcessStartTime` (`lib/delegation-owner-lock.js:103-114`)
   slices after the last `)` and takes index **19** of that split — a match on the wrapper's start
   time never vouches for the child's. See `classifyWebpackCliWatchPid`
   (`lib/webpack-cli-watch-lock.js:326-337`).
2. **`reused` ⇒ zero signals**, for that PID and for anything derived from it (the stored PGID).
   The caller only drops the stale record. Early-return, don't fall through.
3. **A group signal (`kill(-pgid)`) is allowed only while the group's owner is verified `alive`.**
   With a `dead`/`reused` owner the stored PGID is unverified and may name a foreign group — signal
   the *child PID* instead. In the reviewed code that is one guarded block
   (`lib/webpack-cli-watch-lock.js:390-398`, `if (pgid > 0 && wrapperClass === 'alive')`) preceded by
   a comment saying why the PGID is not trusted otherwise.
4. **Descendants come from `/proc` ppid links, never cmdline substring scans.**
   `listDescendantPids` (`:270`) walks `readProcessPpid`; a `pkill -f webpack.dev.js`-style scan hits
   *other checkouts and other projects*. Prove the matcher is dead code: grep for production callers
   of `isMatchingWebpackCliWatchProcess` / `readProcessCmdline` — they should be reachable only from
   tests, and a **decoy test** must exist (spawn `node decoy.mjs <configRealpath>` detached, run the
   sweep, assert it survived).
5. **Every signal is best-effort and try/caught**, and the JSDoc must say so. A throwing
   `killProcess` must not abort the remaining cleanup or the caller's lock release, or one surviving
   process keeps the watcher blocked forever. Test it by injecting a `killProcess` that throws and
   asserting (a) the lock file is gone and (b) `attempted.filter(pid => pid < 0)` is empty.

## How to audit it read-only

- Grep for **every** group-signal site, not the one the report names:
  `grep -n "killProcess(-pgid\|process.kill(-" lib app_front` — then read each guard.
- Walk the branch matrix yourself and match it to the criteria: wrapper `reused` / child `reused` /
  wrapper `dead` + child `alive` / wrapper `alive`. For the last-but-one, the assertion must be an
  exact `assert.deepEqual(signals, [[childPid,'SIGTERM']])` — an `includes`/`some` check cannot prove
  `-pgid` was absent.
- Confirm the previously-fixed neighbours did not regress: shutdown order
  (`killWebpackChildGroup` → `releaseIfOwner()` → `process.exit`, `webpack-cli-watch.mjs:100-104`),
  sweep-before-listen (`server.js:706-707` vs `server.listen(` `:715`), config/HMR files free of both
  the lock import and `process.exit` (`grep -n "webpack-cli-watch-lock\|process\.exit"
  app_front/webpack.dev.js lib/front-hmr.js` → 0 hits), and the one-shot build script
  (`package.json` `build:front` → `webpack --config … --no-watch`, watch under a separate name).
- **Revert-proof the gate analytically** (reviews cannot edit): for each criterion, name the
  assertion that flips RED if the guard clause were deleted. Removing
  `&& wrapperClass === 'alive'` must turn exactly the "dead wrapper" test and the "every signal
  fails" negative-PID assertion red; the reuse tests are unaffected (they early-return earlier) and
  the "uses the group while alive" test is the positive control against an over-restrictive gate.
  A gate no test can detect is not a gate. See **cretli-vacuous-test-review-gate**.

## Residual hazards worth reporting as non-blocking (with exposure math)

These are real but out of scope for a "gate the group signal" leaf — report them with the mechanism
*and* why exposure is small, so the parent can file a follow-up instead of burning a round:

- **`-pgid` while the group leader is `dead`**: the gate checks the wrapper, not the group, so a
  recycled PGID could name a foreign session. Exposure ≈ 0 when the wrapper exits together with its
  child (`child.on('exit') → process.exit`), leaving a millisecond window; and the group signal there
  is *intended* (it reaps leftover group members).
- **Classifier returns `alive` when verification is impossible** — empty stored `pidStart`, or
  `/proc` unreadable between the liveness probe and the start-time probe. "Verified alive" silently
  degrades to "assumed alive" and unlocks the group signal. Narrow it in the report: on Linux the
  acquirer always stamps a start time, so an empty one means a hand-edited/foreign record, and the
  sweep skips a held+matching lock before reaching the kill path at all.
- **Releasing the lock before the child's exit is observed**: the dying process becomes untracked
  (the record is gone, so the next sweep cannot find it) and a fast restart can begin a build with
  `output.clean: true` while the old compiler still writes the output dir. Note that this may be the
  *required* order (kill→release→exit) from an earlier round — say so rather than calling it a defect.
- Naming nits that hide semantics: a helper called `signalVerifiedPid` that verifies only
  `Number.isInteger(pid) && pid > 0`, and an `excludePid`/`holderIsSelf` option no caller ever passes.

## Report discipline

Leaf files are usually **untracked**, so `git diff HEAD`/`git log` prove nothing — attribute by
content and line number. Leaf acceptance criteria live in the TODO body
(`todo_show(todo_id)`), which is often broader than the `[TASK]` text; check the leaf's own
" Akceptacja"/"Testy" lists before declaring scope met. End the report with the exact terminator the
assignment pins (see **cretli-delegation-review**).
