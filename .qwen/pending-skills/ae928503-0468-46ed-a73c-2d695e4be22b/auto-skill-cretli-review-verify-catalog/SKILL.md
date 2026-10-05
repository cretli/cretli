---
name: cretli-review-verify-catalog
description: Register (or audit) a suite id in Cretli's host-owned review-verify catalog (lib/sdk/sdk-review-verify.js REVIEW_VERIFY_CATALOG) — the spawn semantics that make plain-`node` executability, temp cwd and the 60s timeout load-bearing, the no-workspace-mutation audit the trust model demands, and the regression/CHANGELOG conventions.
source: auto-skill
extracted_at: '2026-10-03T21:40:15.664Z'
---

# Cretli review-verify catalog registration

Use when a review finding says "the suite isn't verifiable by a review child", or when [TASK] asks to
add an id to `REVIEW_VERIFY_CATALOG`. Review children may run **only** `node scripts/review-verify.js
<catalog-id>`; an id that is absent is not "inconvenient", it is a hard rejection before spawn, so the
suite is un-auditable by any cheap reviewer.

Companion: **cretli-delegation-implement** (executor mechanics, Step 0 ground truth, reply rules).

## The mechanics that actually decide whether an id is valid (verified in lib/sdk/sdk-review-verify.js)
- `REVIEW_VERIFY_CATALOG = Object.freeze({ '<id>': 'tests/<file>.test.js' })`. `REVIEW_VERIFY_IDS`
  and `REVIEW_VERIFY_PROMPT_HINT` are **derived** from it, and `lib/delegation-prompt.js` injects the
  hint into review children — so docs/skills never list ids by hand. Verified 2026-10-03:
  `docs/ARCHITECTURE.md`, `CLAUDE.md`, `.agents/skills/cretli-multi-harness/SKILL.md`,
  `lib/sdk/sdk-plan-guard.js`, `lib/approval/approval-advisor.js` describe the runner generically.
  **Do not "update the id list" anywhere** — grep first, then only touch `CHANGELOG.md` (convention
  below).
- `parseReviewVerifyNodeArgs` rejects any token not in the catalog, any `-flag`, any `/`-containing
  path. `isReviewVerifyInvocation` accepts `node scripts/review-verify.js <id> [<id>…]` and rejects a
  direct `node tests/x.test.js`.
- `spawnReviewVerifyFile` runs **`process.execPath [filePath]`** — plain `node <file>`, *not*
  `node --test`; with **`cwd` = a fresh temp mkdtemp workDir**; with `CRETLI_DATA_DIR` /
  `CRETLI_TEST_DATA_DIR` / `CURSOR_REMOTE_*` pointed at a fresh temp dataDir; with
  `REVIEW_VERIFY_TIMEOUT_MS = 60000` applied **per file**. It also refuses any catalog path that
  doesn't start with `tests/` or contains `..`, and a nonexistent file yields
  `Missing catalog file <path>`.
- Consequences you must check before claiming the registration works:
  1. the suite exits 0 when run as `node tests/<file>.test.js` (`node:test` files do run and set the
     exit code that way — verify, don't assume),
  2. wall time < 60 s (`start=$(date +%s%N) … ms=$(( (end-start)/1000000 ))`),
  3. it is **cwd-independent** — anything read/spawned must resolve through `import.meta.url`, never
     `process.cwd()` or a bare relative path,
  4. it does not mutate the workspace (audit below).

## The audit the trust model demands ("adding a catalog id requires a human audit that the file does not mutate the workspace")
Read the suite and its helpers; confirm:
- `import './helpers/isolated-data-dir.js'` is the **first** import. It sets all four data-dir env
  aliases to a fresh `mkdtemp(os.tmpdir())`, and `lib/runtime-paths.js` resolves
  `DATA_DIRECTORY` **once at import time**, defaulting to `<projectRoot>/data` — so import order is
  what protects the live tree.
- every persist call passes an explicit `{ dataDir }`; scratch is `mkdtemp(os.tmpdir()/…)`;
  server-side deps come from `setBuiltinMcpRuntimeDeps({ dataDir })` (the pattern behind
  `lib/mcp/builtin/memory-tools.js` reading only the injected dep);
  spawned children get the dir via **argv** and inherit the isolated env.
Then prove it empirically around a real runner call:
- `ls data > /tmp/before.txt` … run … `diff /tmp/before.txt <(ls data)` → identical;
- the store dir the suite would use (e.g. `data/workspace-memory`) still **does not exist**;
- no markers: `data/review-verify-pwned.txt`, `review-verify-cwd-pwned.txt`;
- caveat: this workspace is *live* — `find data -newermt '-20 minutes'` shows
  `data/codex-home/**`, `data/runtime-home/.opencode-data/**`, `data/chats.json` churn from the
  running app, not your test. Use the targeted checks above, not blanket mtime, and say so.

## Conventions to follow
- id = basename minus `.test.js`; entries are grouped by area and alphabetical inside a group, so a
  `workspace-memory` entry goes between `'todos-routes'` and `'workspace-watcher'`.
- `CHANGELOG.md` names new ids (existing style: "Review-verify catalog ids:
  `timeout-progress-series`, `notices`." or append `Review-verify catalog id: \`x\`.` to the feature
  bullet already in `## [Unreleased]`).
- Regression guard goes in `tests/review-verify.test.js`, which is a **plain assert script** with one
  block per audited feature (see the "Task 6" `model-pick-*` block): assert the mapping, then
  `runReviewVerify({ ids: ['<new-id>'], projectRoot, catalog: REVIEW_VERIFY_CATALOG })`, assert
  `ok === true`, `assert.match(output, /<new-id>/)` (the runner prefixes `==> <id>`), and
  `fs.rmSync(run.dataDir, …)`.

## Procedure (failing-test-first)
1. Re-read `lib/sdk/sdk-review-verify.js` + the candidate suite + `tests/review-verify.test.js`;
   `git status --porcelain` (a prior round often already added sibling ids — don't re-add them).
2. Add the guard block, run `node tests/review-verify.test.js` → must fail with
   `actual: undefined, expected: 'tests/<file>.test.js'`. Because it aborts at the **first** failing
   assertion, only the mapping assert is seen red; the `runReviewVerify` assertions are post-fix only.
   Report it that way.
3. Add the catalog line. Re-run the guard suite + both executability forms.
4. Check the consumers so you can state blast radius:
   `grep -rn "sdk-review-verify|review-verify\.js" tests/` — consumers
   (`sdk-plan-guard`, `approval-advisor`, `delegation-review-tools`, `opencode-permission`) pin their
   own fixed ids and **no test asserts the catalog length**, so adding an id is non-breaking.
   Confirm derived gating with a one-liner:
   `node -e "import('./lib/sdk/sdk-review-verify.js').then(m=>console.log(m.REVIEW_VERIFY_IDS.length, m.REVIEW_VERIFY_IDS.includes('<id>'), m.isReviewVerifyInvocation('node scripts/review-verify.js <id>'), m.isReviewVerifyInvocation('node tests/<id>.test.js'), m.REVIEW_VERIFY_PROMPT_HINT.includes('<id>')))"`
   → expect `27 true true false true`.
5. `npx eslint <changed files>` (0 errors is the load-bearing line), then name the repo baseline
   separately — see the per-file attribution recipe in **cretli-delegation-implement** Step 5.

## Hazard worth reporting to the parent
A **tracked** catalog entry pointing at an **untracked** suite (`??` in `git status`) is only
verifiable in this working tree: on a fresh HEAD checkout the runner returns `Missing catalog file`.
State plainly that the registration must land in the same commit as the suite (and note when earlier
rounds already introduced the same pattern — e.g. the `workspace-watcher-*` ids did on 2026-10-03).
