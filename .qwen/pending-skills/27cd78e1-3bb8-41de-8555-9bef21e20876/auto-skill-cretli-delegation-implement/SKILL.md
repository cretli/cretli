---
name: cretli-delegation-implement
description: Act as the Cretli delegated EXECUTOR for an "implement" assignment — work in Agent mode, audit already-present code to find the genuine gaps, make the edits, add regression tests, run targeted tests+lint, then send a final_report via delegation_reply with the exact TASK: implement / VERDICT terminator.
source: auto-skill
extracted_at: '2026-09-21T10:49:23.735Z'
---

# Cretli delegated implement (executor, Agent mode)

Trigger: the prompt opens with "You are the executor for a Cretli delegated task from a parent
chat" and carries `Execution mode: agent. Assignment: implement.`, an `Assignment:` line, a
`Workspace:`, `Parent chat:`, `Delegation:` id, then `[TASK]` + `[COMPLETION CRITERIA]`.

This is the **writer**, not the reviewer. It differs from the `cretli-delegation-review` skill on
purpose: you edit files, run the suite, and you MAY fix git so `git status` works.

## Hard rules (from the assignment, honor literally)
- Work in Agent mode; edit only files the assignment needs.
- **No new Cretli delegation** (`delegation_start`) and — for a `bez Cretli MCP/delegacji` line —
  do not use MCP to *do* the task (no sub-delegations, no reading `data/` or chat-history files).
  The ONE required MCP use is `delegation_reply` to deliver the final report; treat that as the
  intended exception, not a contradiction.
- **No commit / no push.** Confirm at the end with `git log -n1` (HEAD unchanged) and
  `git status --short` showing your files uncommitted.
- **Keep existing changes** — never revert/redo prior working-tree edits. Comments in **English**.
- Report in the assignment's language (here Polish), ending with the exact terminator the
  `[TASK]` demands: one line `TASK: implement` and one line `VERDICT: PASS|FAIL|BLOCKED`.

## Step 1 — audit before you implement (the big one)
A review-style `[TASK]` that lists many "fix X, fix Y" items does NOT mean none are done. In this
repo the whole feature under review was **untracked working-tree code that already addressed most
of the checklist**. Re-implementing what exists wastes effort and risks clobbering good work.
- `git status` first: if the target dir (e.g. `lib/browser/`, its `tests/browser-*`) is **`??`
  untracked**, the "current code" is brand new and largely already-fixed.
- **Read every file** in the area, then map each `[TASK]` bullet to file:line. Classify each as
  ALREADY-DONE (leave it, say so in the report) vs a GENUINE GAP (fix it). Only the gaps get code.
- Typical residual gaps to hunt for even in "hardened" code: a header/credential that still leaks
  on one branch; an `await` in a teardown path that is NOT wrapped in the existing hard-timeout
  helper; query params arriving as strings but checked with `Number.isFinite` (rejects `"5"`);
  redaction that covers query but not the `#` fragment; a capacity check that runs *before* an
  `await` so two concurrent calls both pass it.
- The checklist itself is the review (Astra's); you don't need to fetch the review elsewhere.

## Step 2 — resolve git ownership (implementer-only; reviewer must NOT do this)
`git status`/`log` can fail with `fatal: detected dubious ownership in repository at …`. As the
executor you need git, so run `git config --global --add safe.directory <repoRoot>` once. (The
read-only reviewer skill forbids this by design — different role, different trade-off.)

## Step 3 — verify third-party semantics instead of guessing
Before a security fix that depends on an API contract, read the installed types. Example: to strip
credentials on a cross-origin redirect you must know whether Playwright `route.fetch({headers})`
merges or overrides and how to remove a header — confirmed from
`node_modules/playwright-core/types/types.d.ts` that passing `headers` overrides per-key, so set
the credential keys to `''` to force-clear them (omission would leave the original in place).

## Step 4 — tests + lint (targeted, this repo's conventions)
- Runner: `npm test` → `scripts/run-unit-tests.mjs` spawns each `tests/*.test.js` isolated
  (`node --test` for files importing `node:test`). For a quick loop run a subset:
  `node --test tests/browser-session-manager.test.js tests/browser-buffers.test.js …`
- Set `export CRETLI_DATA_DIR="$(mktemp -d)"` so any persistence-touching route test uses scratch
  data. `*-live.test.js` skip gracefully when the runtime (Chromium) is absent — don't treat the
  skip as failure.
- Add regression tests that fail before / pass after, in the same file as the sibling tests,
  reusing (not breaking) shared harnesses — extend a fake's captured `calls`/recorded options
  backward-compatibly rather than editing assertions that other tests rely on.
- Lint: `npx --no-install eslint <changed files>` (offline; `eslint .` over the whole repo can
  surface unrelated pre-existing noise — scope it to your area).
- Run the full browser suite and report the exact pass counts and the diff (e.g. 85 → 91).

## Step 5 — send the final report
`delegation_reply` (load via `tool_search`; Cretli MCP tools usually aren't loaded at startup):
- `delegation_id` = the id in the prompt; `reply_kind=final_report`; `task_outcome=success|failure|blocked`.
- `chat_id` may be omitted (defaults to this executor chat). `attempt_id`/`run_id` are optional —
  omit them; if the call returns `CONFLICT` naming the executing run, retry with those ids.
- `idempotency_key`: stable, e.g. `final-report-<delegationId8>-implement-v1`.
- `message_text` only (mutually exclusive with `history_seq`+`content_hash`).
- Report body: findings/changes → tests run + results → deviations → remaining problems (state the
  MVP SSRF compromise: a hard IP-level boundary needs a separate egress proxy, so the enforced
  boundary is per-request route policy + default-deny resolver, residual risk documented in
  SECURITY.md) → blockers (none if clean) → artifacts. End with the terminator lines.
- Success returns `status=queued` and does NOT mark the job reviewed — do not resend.
