---
name: cretli-skip-gated-e2e-in-ci
description: When a finding says "CI silently skips the only real e2e/live test" (capability-gated `t.skip`), audit the whole availability predicate before writing or executing the fix — find the single failing gate, make the CI install provision the EXACT path AND browser-revision the consumer resolves at test time (same package CLI, verify with install --dry-run), prove skip→fail by simulating a clean runner in a mount namespace, and make the guard CI-only so local dev still skips gracefully.
source: auto-skill
extracted_at: '2026-10-07T22:26:06.110Z'
---

# Fixing a capability-gated skip that makes CI go green without running the e2e

Trigger: a Scout finding / todo of the shape *"<workflow file> runs the test suite without
installing X; `<some>.test.js` does `t.skip` when X is missing; this is the only test that proves
<feature>, so uncommitted work can break on green."* These findings read plausible but their
**stated fix ("just install X") is usually incomplete or wrong**, because the skip is guarded by a
multi-gate predicate you have not read yet.

Scope: this is the *analysis* procedure for both sides of the loop. The parent uses it to write the
brief; the **implement child must re-verify the brief's own recommendations with it** — on
2026-10-08 the brief (copying this skill's §3 recommendation verbatim) shipped an install command
that would have kept CI green-with-skip (§3b), and only the executor-side measurement caught it. The
loop mechanics (model_pick → delegation_start → review → ack/rate) live in `cretli-multi-harness`;
finding-is-stale and foreign-mutating-slot starvation handling live in
`cretli-orchestrator-stale-finding` (read that one before fighting a workspace lock — a brief is an
*expensive slot probe*).

## 1. Confirm the test is *collected*, separately from whether it *runs*

"Skipped in CI" and "never runs in CI" are different bugs with different fixes. Read the runner
script the workflow invokes, not the workflow's `npm test` line:

- `scripts/run-unit-tests.mjs` spawns **every** `tests/*.test.js` in an isolated process (choosing
  `--test` by grepping the source for `from 'node:test'`). So `tests/browser-live.test.js` *is*
  collected by `npm test`; it self-skips.
- Also check whether another job in the same workflow even reaches that suite — here
  `test:without-cursor-sdk` is an explicit `&&`-chain that omits it, so only the main `test` job
  matters. Say so in the brief and forbid touching the other job.
- Line numbers in the finding drift (`ci.yml:18-25` had gained ripgrep/lint steps). Quote current
  step names, not finding line numbers.

## 2. Read the detector's gates **in order** — then identify the *single* failing one

The gate is usually a `detect*Runtime()` in a lib module, not the test. Enumerate every early-return
before you conclude what to install. In `lib/browser/runtime-detect.js`, in evaluation order:

1. platform exclusion (Termux/Android → `unsupported-platform`);
2. module import (`playwright-core` → `playwright`) — if it is a real dependency, `npm ci` already
   satisfies it, so "install playwright" is a non-fix;
3. **a config/contract gate**: `if (!networkBoundary.configured) return unavailable` — this runs
   *before* any binary check. `resolveBrowserNetworkBoundary()` defaults to
   `mvp-defense-in-depth`, and `configured: mode === 'mvp-defense-in-depth' || Boolean(proxyServer)`
   → **true by default**. Unreachable trap: had the CI env set
   `CRETLI_BROWSER_NETWORK_BOUNDARY=proxy` without a proxy server, installing Chromium would still
   skip forever;
4. `chromium.executablePath()` + `fileExists()`, then `resolveSystemChromiumPath()` fallback
   (`CRETLI_BROWSER_EXECUTABLE_PATH`, then `/usr/bin/chromium`, `/usr/bin/chromium-browser`,
   `/usr/bin/google-chrome`, `/usr/bin/google-chrome-stable`, `/opt/google/chrome/chrome`);
5. root/sandbox only *warns* (needs `CRETLI_BROWSER_ALLOW_NO_SANDBOX=1`, which the test itself sets
   when `getuid() === 0`) — it is not a skip gate.

Only gate 4 fails in CI ⇒ the fix really is "install the binary", but you can only claim that after
ruling out gate 3. A brief written from the finding's prose would have shipped a fix that keeps
skipping.

## 3. The asset-path consistency trap (the actual landmine in this finding)

Where the browser is *installed* and where the detector *looks* are two different resolutions:

- `npm run test:e2e:browsers` = `PLAYWRIGHT_BROWSERS_PATH=0 … playwright install chromium` →
  the binary lands **under `node_modules`**, not `~/.cache/ms-playwright`.
- `playwright-core.chromium.executablePath()` resolves against `PLAYWRIGHT_BROWSERS_PATH` **at test
  time**. So if you install with `=0` but run `npm test` without it, the default lookup misses the
  local install → **the test still skips and CI is still green**.

Therefore the brief must demand: pick ONE mode and hold it across the install step *and* the test
step. Default recommendation: install at the DEFAULT cache path (no `PLAYWRIGHT_BROWSERS_PATH`
override), because then `npm test` needs no env at all. Frame `=0` as "allowed only if you also
export it on the `Run tests` step". But see §3b before naming WHICH CLI performs the install —
"which package's installer" is a third axis of this trap.

### 3b. The REVISION trap: the installer CLI and the consumer package can differ (measured 2026-10-08)

Consistency of the base *directory* is not enough — the installed browser **revision** is pinned per
package *version*, and in Cretli they fork in two:

- the code imports `playwright-core` (runtime dependency, was 1.63.0) →
  `chromium.executablePath()` resolves `<cache>/chromium-1243/chrome-linux64/chrome`;
- the `playwright` CLI in `node_modules` comes from `@playwright/test` (devDep ^1.62.1, was 1.62.1)
  → `npx playwright install chromium` downloads `chromium-1234`.

So the previously "safe default" command `npx playwright install --with-deps chromium` — the exact
command this skill and the parent's brief recommended — would have installed a revision the detector
never looks for: same directory, wrong folder name, **green CI with a silent skip, one level deeper
than the `=0` trap**. The rule that generalises:

> Provision with the CLI of the **same package whose `executablePath()` the code calls**. Here:
> `npx playwright-core install --with-deps chromium` (the playwright-core CLI supports `install`,
> `--with-deps` and `--dry-run`; `playwright-core` is a real dependency so `npm ci` gives the runner
> the bin — no new packages, no `@playwright/test` wiring).

And prove the match cheaply before writing the step — no 170 MB download needed:

```bash
env -u PLAYWRIGHT_BROWSERS_PATH node -e \
  "import('playwright-core').then(m=>console.log(m.chromium.executablePath()))"
env -u PLAYWRIGHT_BROWSERS_PATH node node_modules/playwright-core/cli.js install --dry-run chromium \
  | grep -A1 'Chrome for Testing'
```

The `Install location` of the dry-run must equal the parent directory of the resolved
`executablePath()` — same base **and** same `chromium-<rev>`. (Both print under `$HOME`; on a GH
runner that becomes `/home/runner/.cache/ms-playwright` on both sides — what matters is identical
env for both lookups. Beware: agent sandboxes often redirect `HOME`, and can also pre-set
`PLAYWRIGHT_BROWSERS_PATH` to an empty dir — always `env -u` it when measuring.)

Generalise: whenever a fix adds an *install/provision* step to CI, check that the consuming code's
path resolution honours the same env **and the same pinned asset version** the installer produced.
GitHub's `env:` maps differ per step — workflow-level vs step-level vs job-level are not the same
thing.

## 4. Prove both directions locally before delegating (cheap, high-signal)

Run it yourself as parent — it is read-only and it makes the brief factual instead of speculative:

```bash
node --test tests/browser-live.test.js     # want: "# pass 1", "# skipped 0"
```

A local PASS proves (a) the test really asserts the feature (not a hollow e2e) and (b) the gap is
CI-only, so the finding is live, not stale. Note the runtime: `duration_ms` for the test itself
here was ~1.2 s inside a ~13 s process, i.e. these tests are cheap enough to keep in the main suite.
Caveat refined 2026-10-08: on a box with `/usr/bin/chromium` the PASS came via the *system fallback*
(gate 4 second half), so it does **not** by itself prove the default-path install is what `npm test`
resolves — pair it with the §3b dry-run equality to make that claim honestly.

Forcing **absence** to see the skip/fail is the other direction. `PLAYWRIGHT_BROWSERS_PATH=/tmp/empty`
alone is not enough — `resolveSystemChromiumPath()` still finds a system Chromium on a dev box.
This used to be called "irreproducible locally; argue from the code path". There is now a proven
technique to really reproduce a clean runner **without touching the host** (works as root; the
Cretli agent is root):

```bash
NODE_BIN="$(command -v node)" && mkdir -p /tmp/pw-empty
CRETLI_REQUIRE_BROWSER_LIVE=1 PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-empty \
  unshare -m bash -c "mount -t tmpfs tmpfs /usr/bin && exec '$NODE_BIN' --test tests/browser-live.test.js"
```

Gotchas that make this work:
- `bash`, `unshare` and `mount` are exec'd *before* the tmpfs covers `/usr/bin`; afterwards only the
  already-loaded processes run, and `exec "$NODE_BIN"` must point OUTSIDE `/usr/bin` (check
  `command -v node` first — nvm/npx-cache paths are fine; plain `/usr/bin/node` would not be).
- On Ubuntu `/bin` is a symlink to `/usr/bin`, so nothing from `/bin` may be needed after the mount —
  fine here because `node --test` spawns its children via `process.execPath`.
- Cover/hide EVERY entry of the fallback list (`/usr/bin/*` via the tmpfs; `/opt/google/chrome/chrome`
  only if present — check with `ls`, mount a tmpfs over `/opt/google/chrome` too if needed).

Run it in three directions and show all three in the brief/report — measured exit codes:
A) with `CRETLI_REQUIRE_BROWSER_LIVE=1` + simulated absence → must FAIL: `not ok`, `# fail 1`,
   `# skipped 0`, exit 1, message contains the `runtime.reason` ("Chromium is not installed at …");
B) same namespace, WITHOUT the opt-in → must SKIP gracefully: `# skipped 1`, exit 0 (proves the
   local-dev contract of §5 is kept);
C) opt-in set + Chromium genuinely reachable (normal env) → must PASS: `# pass 1` — proves the
   guard is inert when the runtime is available, i.e. it can never red-fail a healthy CI.

Still require honesty: state which fallback candidates were actually hidden on the measuring box.

## 5. Make the fix durable — a CI-only guard that converts skip → fail

Installing the binary fixes *today*; nothing stops a future edit from dropping the step and going
green again (the finding's "optionally fail when live reports skip" clause — do not skip it, it is
the part that prevents recurrence). Pattern:

- in the test, replace the unconditional `t.skip(...)` with: fail when an explicit opt-in is set,
  otherwise keep the graceful skip —
  `if (process.env.CRETLI_REQUIRE_BROWSER_LIVE === '1') assert.fail(...) else t.skip(...)`.
- set that env **only** in the CI job (`env:` on the `Run tests` step or the job).
- Rationale to put in the brief: local/dev `npm test` without the binary must still *skip*, not
  break the whole suite. A guard that always fails is a regression for every contributor, and the
  `run-unit-tests.mjs` runner treats a non-zero exit as a failed *file*, so one hard-failing optional
  e2e would fail the entire local suite.

## 6. Scope-lock the rest of the brief

- Do **not** widen a "one skipped node:test file" finding into wiring the whole `@playwright/test`
  spec runner (`test:e2e:*`) into CI — different harness, different cost, different flakiness.
- Do not let the implementer move the install to a separate job unless it keeps the *same* job that
  runs the test (installing in job A and asserting in job B does not share `~/.cache`).
- Comments in English (repo rule `.cursor/rules/cretli-comments-english.mdc`).
- Enumerate every finding clause as its own numbered acceptance item, including the cautionary
  "note" line (see the orchestrator-brief-paraphrasing lesson) — here the `PLAYWRIGHT_BROWSERS_PATH=0`
  note was the single most important clause and reads like a footnote.
- Require a *shown* diff for both files plus the two runs, and forbid PASS when the only-run-when-
  present proof (step 4 first command) is missing.

## 7. Reusable check-list for any "CI skips the only real test" finding

1. Is the file collected by CI's command? (read the runner script)
2. What is the exact skip predicate? Read the detector; list every early-return in order.
3. Which single gate fails on a clean runner? Did you rule out a config/policy gate that would make
   the obvious install a no-op?
4. Does the provision step's path/asset env match what the consumer resolves at test time?
5. Prove it runs today locally (`# skipped 0`); state honestly if absence is unreproducible because
   of a system fallback.
6. Add the opt-in skip→fail guard, CI-only, keeping the local graceful skip.
7. Scope-lock: one test file, one job, no new e2e harness, English comments, no commit/push.
