---
name: cretli-orchestrator-starved-cycle-parking
description: When a Cretli orchestrator cycle loses the workspace-exclusive mutating slot to chaining foreign parents and ends with ZERO delegations, make the cycle still produce the durable output — verify the finding's proposed REMEDY resolves at runtime before briefing (a suggested install command can be a no-op), park the full brief in the todo plan + workspace memory, never probe the slot with a giant task_text (`plan_revision` cannot reuse a parked todo plan), and close with `blocked` rather than `failure`.
source: auto-skill
extracted_at: '2026-10-07T22:05:17.930Z'
---

# Starved orchestrator cycle: park the work, don't burn the wait

Trigger: you are the Cretli `Workspace Watcher orchestrator for exactly ONE cycle`, `model_pick`
returned, and every `delegation_start` for `implement`/`fix` comes back
`CONFLICT … Another parent already has a mutating job in this workspace. Blocker delegation id: …`.
The workspace has **one** exclusive mutating slot shared by all parents, so at
`maxParallel >= 5` cycles serialize on it and most of them are starved.

Companion skills: `cretli-orchestrator-stale-finding` (its "Bounded wait on a FOREIGN parent's
exclusive write slot" section is the canonical polling mechanics — read it too) and
`cretli-multi-harness`. This file covers what that section does **not**: what a starved cycle
should actually deliver, one loop-mechanics trap that invalidates the "park it in the plan" idea,
and how to verify a finding's *remedy* rather than only its *bug*.

## 1. Do the read-only verification FIRST, then wait — the verification is the deliverable

A starved cycle is not a wasted cycle if you front-load everything that does not need the slot:
read the cited files, `node -e` the resolution paths, check `node_modules` versions, snapshot
`readDelegationMaterialRevision(cwd)`. In the observed run (todo `aa928d58`, "CI uruchamia
browser-live", cycle `a3ac17af`) all of the durable value came from ~10 minutes of this, while the
next ~50 minutes produced only a blocker chain. Do not start sleeping before you have facts a
future cycle cannot cheaply re-derive.

## 2. Verify the finding's PROPOSED REMEDY resolves — the suggested fix can be a no-op

Findings usually prescribe a remedy ("dodać krok `npx playwright install --with-deps chromium`
(albo `npm run test:e2e:browsers`) przed `npm test`"). Step 0 of `cretli-orchestrator-stale-finding`
checks whether the *bug* still exists. Check the *remedy* too, because a prescribed command can be
silently ineffective and then the leaf ships still-green-and-still-skipping.

Real case, 2026-10-07, todo `aa928d58`: the CI job really had no Chromium step and the live test
really did `t.skip` — so the finding was NOT stale. But `node_modules` disagreed with its fix:

```bash
node -e "for (const s of ['playwright-core','playwright']) {
  const p=require(s); console.log(s, require(s+'/package.json').version, '->', p.chromium.executablePath()); }"
# playwright-core 1.63.0 -> …/chromium-1243/chrome-linux64/chrome
# playwright      1.62.1 -> …/chromium-1234/chrome-linux64/chrome
```

`detectBrowserRuntime()` in `lib/browser/runtime-detect.js` tries
`for (const specifier of ['playwright-core', 'playwright'])` — it imports the **1.63.0** package
first and looks for `chromium-1243`, while `npm run test:e2e:browsers` runs
`./node_modules/playwright/cli.js` (= **1.62.1**) which installs `chromium-1234`. Adding the
finding's own suggested step would have kept skipping and kept CI green. Generalize to any
"install X / add flag Y / set env Z" finding:

- **Which module does the consumer actually load first?** Import/require order decides which copy
  of a duplicated dependency answers. Check the loop/`try` list in the resolver, not the manifest.
- **Do the producer and consumer of an env var share a value?** Here `PLAYWRIGHT_BROWSERS_PATH=0`
  lands browsers inside the *installing* package's `.local-browsers`; install step and test step
  must carry the identical value (or neither). `run-unit-tests.mjs` spawns with
  `env: {...process.env}`, so a step-level `env:` does reach the test.
- **Is the target environment even capable of the assertion?** GitHub runners are non-root
  (`getuid()!==0`) and have no `/usr/bin/chromium`; this dev box has no Playwright download but
  does have `/usr/bin/chromium`, so the same code is `available:true` here and `false` there.
- **Do not add a dependency to validate the fix.** This repo has no `yaml` package; YAML validity
  is checked by reading indentation, and the brief must forbid package.json edits for tooling.
- Probe injected seams: `detectBrowserRuntime({env, fileExists, importModule, platform, getuid})`
  accepts fakes, so a "fail when it skipped" guard is unit-testable without hiding the system
  binary. Ask for exactly that in the brief instead of a hack.

Everything above goes into the brief as numbered **verified facts** plus an explicit forbidden list
(no dependency-version changes, no "simplifying" back to the finding's own suggested command), with
the *why*, so a cheap implementer cannot undo it and a future contributor cannot re-break it.

## 3. Never take a "current state" measurement while a foreign mutating job is `running`

Baseline probes you run to arm the brief are contaminated data points when another parent is
editing the same subtree. Observed: `node --test tests/browser-live.test.js` failed at
`assert.ok(shadowSave, …)` with `elements.elements === []` — and `lib/browser/session-manager.js`
had mtime `23:53:39` local, i.e. the same few seconds as the run (foreign cycle mid-write). The red
was almost certainly a half-written tree, not a regression.

So when you do measure, capture attribution in the same window and label the result:

```bash
git status --short -- <area>/ && ls -l --time-style=+%H:%M:%S <area>/*.js && date +%H:%M:%S
```

Then: (a) write in the brief "traktuj to jako NIEUDOWODNIONY stan, nie fakt bazowy", (b) forbid the
child from fixing product code to force green and require it to re-run and quote line + message if
it still fails, and (c) record the observation in workspace memory as a `finding` **with the
contamination caveat**, so nobody opens a bogus defect todo from your transcript. Note this box also
runs other cycles at 2 a.m. local — always compare mtimes against `date` before believing that an
unexplained red is yours to fix.

## 4. `plan_revision` cannot reuse a parked todo plan (the trap in "save the brief for later")

The natural move when you can't get the slot is: store the brief so the next cycle starts with a
short, cheap call. `todo_update({patch:{plan:{markdown}}})` **does** persist the brief (the next
cycle reads it with `todo_show({field:'plan'})`), but it is **not** a valid delegation source:

```
delegation_start({plan_revision: 1}) →
VALIDATION_ERROR: No complete plan is saved for this chat.
```

The plan source resolves against the **calling chat's** saved plan, not the todo's. Consequences:

- Children must always be started with `task_text`. Stop burning attempts on `plan_revision`.
- Save the brief in the todo plan anyway — it is how the next cycle pastes a *complete* brief
  without re-auditing. Say explicitly in the cycle report that the plan is a parked brief, not a
  gate.
- Saving a plan flips the card to `plan: awaiting approval`. Harmless while
  `requirePlanApproval=false` (this workspace), but disclose it; a human-gated workspace would stall
  on it.

## 5. Don't probe the slot with the big payload; poll cheap, fire once

`delegation_start` does re-probe atomically (per `cretli-orchestrator-stale-finding`), and that is
right for a *short* payload. With a several-thousand-token `task_text` each strike is expensive, and
at high `maxParallel` the gaps are stolen within seconds: `fd331bc8` went `failed` and a **different**
parent (`8eccd2dd`) held `3fa75f28` by the time the next start was composed. Sequence observed in one
cycle: `65ecea7a`(failed) → `06abbf48` → `0edb7a15` → `fd331bc8`(failed) → `3fa75f28`, five CONFLICTs
across **three** parents, ~50 minutes, zero starts.

Effective pattern:

1. Poll `delegation_list({chat_id:<blocker parent uuid>, limit:4})` — `chat_id` is **required**;
   without it you get your own chat and a fake "slot looks free".
2. Sleep in a standalone `sleep N # intentional-sleep: <why>` (chaining `sleep && echo` is blocked).
   Keep windows short (2–4 min) toward the end, because gaps are seconds wide.
3. Fire the real start **only** when the list shows no `running` row. One attempt, real payload.
4. Reuse the same `idempotency_key` (a CONFLICT-rejected start persists nothing, so replay is safe);
   use a fresh key only for a genuinely different brief.

## 6. Close the starved cycle honestly — the memory write is the product

After a bounded wait with zero delegations:

1. `wmem_add({type:'finding'})` with the verified root cause **including the remedy-is-a-no-op
   proof and the injected-seam note** — that is what the next cycle must not re-derive.
2. `wmem_add({type:'blocker'})` with the blocker chain (UUIDs + parent chats + the fact that a
   sibling steals the gap in seconds) and the concrete next-cycle instruction ("read
   `todo_show field=plan`, poll `delegation_list({chat_id})`, fire `task_text` immediately;
   `plan_revision` does not work"). Prefer delete-and-re-add (`wmem_delete` by id) over appending a
   near-duplicate key when the chain grows.
3. `workflow_update` early with `role`, `round`, `last_model`, `material_revision`, `deadline_at`
   and a stable key, so a restart does not reset the round. Do **not** invent a `stop_reason` value
   for "slot busy" — the gate semantics are undocumented and a stale stop reason can block the next
   cycle's starts. Leaving `verdict=unspecified` is accurate: no review ever ran.
4. Todo status: when literally nothing landed, restoring the card to `ready` (`todo_update` with a
   fresh `expected_updated_at` from `todo_show`) keeps the queue honest and re-queues the leaf. A
   prior cycle in `cretli-orchestrator-stale-finding` left the same situation `doing`; both get
   re-claimed, so pick the state that matches reality and say it in the report — never leave a card
   `doing` to imply un-started work.
5. `watcher_update({action:'report', outcome:'blocked', …})` — **`blocked`, not `failure`**: only
   `failure` spends the todo's failure budget / feeds backoff. One long message with the blocker
   chain, the parked-brief pointer and the next-cycle recipe. Then stop: never commit, push, spawn
   another cycle, or cancel a foreign parent's job.

Sanity check the readback: `cycles`, `reports: …=blocked`, `previous_cycles`. If several siblings
report `blocked` in the same window, the bottleneck is the policy shape (one mutating slot vs
`maxParallel`), not the leaf — say that in the report instead of retrying heroically.
