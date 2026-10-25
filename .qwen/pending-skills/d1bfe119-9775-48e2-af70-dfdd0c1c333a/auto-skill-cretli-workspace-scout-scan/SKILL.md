---
name: cretli-workspace-scout-scan
description: Running a Cretli Workspace Scout scan — the read-only/plan-mode proposal pass over a dirty cretli tree: dedupe first, then cheap evidence runners (background unit suite to /tmp, eslint --quiet, standalone re-run to classify deterministic vs environmental red), symbol-anchored titles to survive the silent title-token dedupe, and the one-submit-per-scan rule with the fenced-JSON fallback.
source: auto-skill
extracted_at: '2026-10-05T14:15:19.501Z'
---

# Workspace Scout scan (propose, change nothing)

Trigger: the prompt opens with "You are the Workspace Scout for exactly ONE read-only scan.
Propose work; change nothing." and gives `scan_id` + `submit_token`, and states **PLAN mode**
(no file create/edit/delete, no `delegation_start`, no `todo_create`). Max 10 findings across
`bug | improvement | security | opportunity | documentation`.

Companion skills: **cretli-orchestrator-stale-finding** (the *parent* verifying a finding after
acceptance — the mirror problem to the one below), **cretli-quote-safe-probe-files** (fixtures
containing quotes/backslashes), **cretli-delegation-implement** / **cretli-delegation-review**.

## Step 0 — dedupe BEFORE you look for anything
Three calls, in parallel, and they decide what is even eligible to propose:
- `todo_list` (~80 rows here; `done` todos matter — a red test that a `done` todo already caused is
  history, not a finding).
- `watcher_scout_findings {action:"list", max:100}` → already **pending** (4-5 typical) and
  **accepted/rejected** rows. Re-proposing a pending area wastes the operator's attention.
- `workspace_memory_list {limit:100}` → areas "already explored". On this branch the explored set
  is large (`opencode-permission` quote policy, `plan-limit-history`, sidebar perf leaf-module
  pattern, `review-verify-catalog-missing-opencode-permission`), so whole subsystems are off-limits.

## Step 1 — cheap evidence runners beat code reading
Run these early; they produce concrete, falsifiable findings in minutes:

```bash
# full suite, captured OUTSIDE the repo (plan mode: never write into the workspace)
node scripts/run-unit-tests.mjs > /tmp/scan-tests.log 2>&1      # background it: ~468 files
grep -n FAILED /tmp/scan-tests.log
awk '/==> x.test.js/,/FAILED x.test.js/' /tmp/scan-tests.log    # one failure's real diff
npx eslint . --quiet                                            # hard errors only
```

- `scripts/run-unit-tests.mjs` is safe on a live instance: it `mkdtemp`s a scratch dir and passes
  `CRETLI_DATA_DIR` to every child, so `npm test` does not touch the real `data/`.
- eslint here gates CI (`.github/workflows/ci.yml` runs `npm run lint`) → every error is a live
  finding. `no-undef` in front-end code = runtime `ReferenceError`, not style.
- coverage gap in one loop (found the genuinely-untested new modules):
  `for f in $(git ls-files --others --exclude-standard lib | grep '\.js$'); do …grep -rl "$base" tests/…`

## Step 2 — classify every red before proposing it (three distinct outcomes)
A failing test is not automatically a product bug. Re-run each failure **standalone**
(`node tests/<name>.test.js`) and separate:

1. **Deterministic red** → real defect (e.g. `delegation-phase2b-e2e.test.js:383` failed 3/3;
   `sdk-chat-run-adapter.test.js:30` every time). Name the root-cause branch, not just the assert.
2. **Environment race** → report as flaky/false-red with the measurement that proves it. Here
   `chat-history-isolation.test.js:248` asserts `data/chats.json` mtime is unchanged after spawning
   a CLI, while the dev server (checked with `ps aux` + three `stat -c '%Y'` samples 3 s apart: it
   ticks every second) rewrites that file — failed in-suite and once standalone, passed on a quiet
   re-run. Always state the failure count honestly ("2 of 3 runs").
3. **Test is wrong, behaviour is right** → its own finding. `workspace-watcher-settings-ui.test.js:97`
   regex-matched the literal `renderWatcherPanel(root, res.json)`; the panel now passes merged
   `lastView`. The dirty-form-preserving `if (full)` guard was intact. A source-scan test pinned to
   an identifier spelling is a maintenance defect worth proposing separately from the feature.

Also distinguish **new vs pre-existing**: `git show HEAD:<file>` / `git diff HEAD -- <file>`. The two
`importScripts` `no-undef` errors were already at HEAD (sw.js last touched by the current tip
commit), while the duplicate i18n `archiveBusy` key existed only in the dirty tree — different
urgency framing, same lint finding.

## Step 3 — the tree moves under you: re-verify immediately before submitting
A concurrent human/agent works in this workspace (see memory
`cretli-workspace-has-concurrent-human-edits`). Mid-scan, `sidebarView.js` gained the missing
`formatSubchatSummary` import and `npx eslint <file>` went clean, and
`chat-history-isolation.test.js` flipped from FAIL to PASS. **Drop anything that got fixed while
you were typing** — proposing it duplicates an in-flight todo (that bug was literally item 2 of
`doing` todo 00df6141). Final pass: re-run eslint and each cited test, then re-check the line
numbers you quote, then submit.

## Step 4 — probing gate/eligibility functions: replicate the test's environment
First probe returned `false` for *all seven* harnesses and would have produced a wrong finding.
Both were required to get the real answer:
- the **side-effect imports** the test performs (`await import('../lib/<x>/<x>-agent-ws.js')`) —
  `hasChatRunAdapter()` is a registry populated by those imports;
- `import './tests/helpers/isolated-data-dir.js'`, which sets env aliases — it made
  `CRETLI_DELEGATION_EMPTY_FAVORITES` read `all`, and that is exactly what hid the bug (CodeBuddy's
  `resolveCodeBuddyEnabledModels([])` never returns `[]`, so it skips the `all` escape hatch that
  every other harness takes, and is start-eligible with zero user favorites even under `deny`).

Print a row per case instead of asserting, and try both policies explicitly
(`process.env.CRETLI_DELEGATION_EMPTY_FAVORITES='deny'`) so the finding states the measured value,
not an inference. Quote/backslash-sensitive fixtures go in a scratch file — see
**quote-safe-probe-files**. Never put the probe under `tests/` (`run-unit-tests.mjs` globs
`tests/*.test.js`) and never write inside the repo in plan mode — `/tmp` only.

## Step 5 — submitting (two hard traps)
- **One submit per scan.** A successful submit ends the scan window; a second call returns
  `OUT_OF_SCOPE: No active Scout scan is accepting submissions for this workspace`. So compose all
  findings, verify them (Step 3), then submit **once**.
- **`added=N` with N < your list means findings were silently dropped** — the tool never says why.
  `dedupeScoutFindings` (`lib/workspace-watcher-scout.js`) drops a proposal as `existing_todo` when
  ≥2 tokens of length ≥4 (`WORKSPACE_SCOUT_MIN_DEDUPE_TOKEN_OVERLAP = 2`,
  `WORKSPACE_SCOUT_MIN_DEDUPE_TOKEN_LEN = 4`) overlap **any todo title** in the workspace. Narrative
  titles ("Orphaned delegation is never reclaimed; the workspace write slot sticks") hit that
  against Polish todo titles full of `delegation`/`workspace`/`slot`/`settings`/`model` — 5 of my 6
  were dropped. **Anchor titles to a symbol or file:line**
  (`reconcileDelegationsOnBoot leaves a \`starting\` job unterminalised…`,
  `resolveCodeBuddyEnabledModels injects hy3/hy4-preview-f when favorites are empty…`) — better
  titles and immune to the crude matcher. Rewording for precision is legitimate; deleting a real
  finding because a keyword collided is not.
- Fallback for anything dropped after the window closed: end the turn with **exactly one** fenced
  ```json``` array of the same `{title, category, rationale, files}` objects (the prompt allows it),
  and say plainly which ids did land.

## Body of a good finding
`rationale` = measured evidence + the exact branch that is wrong + one proposed fix shape, with
`file:line` for every claim (e.g. "both terminal exits in the `row.status === 'starting'` branch
(~2194-2230) are gated on `known === true`; `probeChatRunLiveness` (lib/chat-run-service.js:276-305)
returns `state_missing` after a restart, so the row falls through to `continue` and
`isDelegationSlotOccupied` counts ACTIVE"). `files` = the paths a human opens, not everything
touched. Prefer 5-7 verified findings over 10 speculative ones; an empty list is a valid answer.
