---
name: cretli-delegation-review
description: Act as the read-only reviewer/auditor of a Cretli delegated assignment — verify every claim in [TASK] against the repo, then send a final_report via delegation_reply with the live attempt_id/run_id and the exact TASK/VERDICT terminator.
source: auto-skill
extracted_at: '2026-09-20T20:48:46.292Z'
---

# Cretli delegated review / audit (read-only)

Trigger: the prompt opens with "You are the reviewer for a Cretli delegated assignment" and
carries `[ASSIGNMENT]` / `[TASK]` / `[COMPLETION CRITERIA]` blocks plus a `delegation` id.

## Hard rules
- `[ASSIGNMENT]` **overrides** the default role prompt (including its reply language and its
  required terminator). No edits, no commits, no `delegation_start`, no implementing — even in
  `agent` execution mode.
- Write the report in the language `[ASSIGNMENT]` demands (e.g. "Pisz po polsku"), overriding the
  project output-language file. Keep code, paths, logs and identifiers verbatim.
- Terminator placement is assignment-defined. Two shapes have been seen: `VERDICT:` as **line 1**,
  and "must end exactly with" `TASK: audit` / `VERDICT: PASS`. Re-read `[ASSIGNMENT]` before
  sending; match it literally.
- Verdict semantics: `TASK: audit` + `PASS` means *the audit is complete*, not that the product is
  defect-free. Fail/block only when the assignment is actually wrong or ambiguous.

## Step 1 — establish what you are actually reviewing
Check for a deliverable before auditing prose. Three separate stores; the prompt's own `[TASK]`
text is usually the *thinnest* version of the real artifact:
- `delegation_show(delegation_id, field="plan")` — the `plan:` value may be **empty**.
- `chat_plan_show(chat_id=<parent_chat>)` — may return "No saved plan for this chat".
- **If `[TASK]` names a Todo id (a bare UUID, "plan Todo …", `?panel=todo` link), the real
  deliverable is the TODO, not the delegation**: `todo_show(todo_id, field="body")` for the short
  brief and `todo_show(todo_id, field="plan")` for the multi-stage plan. Both were empty-ish /
  absent via the first two tools in a real audit while the TODO held the whole 6-stage plan.

If all three are empty, there is no plan to review: audit the **factual premises and the numbered
requirements** of `[TASK]` against the code, and state that deviation explicitly in the report.
Also read the `cretli-ref chat=<uuid> seq=<n>` lines in the prompt with
`chat_event({chat, seq, field:"text"})` — pointers, not body; never glob `data/`.

`todo_show field="plan"` can **truncate the tail with no `next_cursor` returned** (observed: last
acceptance criterion cut mid-word, "Agent potrafi pobrać DO…"). Don't loop on it — audit the
readable portion and record the truncation as a deviation so the parent confirms that one item.

## Step 2 — live attempt_id / run_id
`delegation_show` prints them as its second line:
`attempt_id: <uuid> run_id: <uuid>`. Copy those into the reply; they are "compared with the live
run". Older notes claiming they are absent (or that you must grep `data/delegations.json`, or that
they can safely be omitted) are stale — verify on the current output and record a deviation if you
had to fall back.

## Step 3 — allowed verification only
`node scripts/review-verify.js` (bare = the whole frozen catalog) or
`node scripts/review-verify.js <id>`. The catalog is `REVIEW_VERIFY_CATALOG` in
`lib/sdk/sdk-review-verify.js`; **adding an id requires a human audit**, and the catalog only
holds incident unit tests. So:
- Run the bare command, report per-id OK/FAIL.
- Then state which area is *not* covered by the catalog (e.g. chat sync poll / background policy /
  client-instance commands / HTTP routes) and push full-suite verification to the parent or CI.
  Do not imply that review-verify validated the change under audit.
- Cursor SDK review has native shell for read-only explorers and `review-verify`.
  Do not run arbitrary tests. Mutating shell aborts the turn.

### A catalog FAIL is usually environment, not regression — prove it before reporting it
The frozen tests read process env, so a red id can be pure shell state. Observed live:
`model-role-profiles` failed with `AssertionError: + 'codex' / - 'opencode'`
(`tests/model-role-profiles.test.js:281`) because the shell exported
`CRETLI_DELEGATION_REVIEW_ALLOW_UNCERTIFIED=1`; that makes
`readDelegationReviewAllowUncertified()` → true, so `assertReviewAdapterAllowed()` returns ok for
any uncertified harness and `omitUncertifiedReviewHarnesses()` (`lib/mcp/builtin/catalog-tools.js`)
never drops `codex`. No code was broken.
- Procedure: read the assertion, open the guard function, find the env alias it consults, then
  `printf '[%s]' "${VAR-UNSET}"` (read-only, allowed) to confirm. Report it as an env artifact with
  the mechanism, not as a defect in the change under audit.
- Do **not** "fix" the run by prefixing `env -u VAR node scripts/review-verify.js …`. The
  assignment pins the exact command form; altering it is out of scope and unprovable. Say you
  declined to.
- Worth escalating to the parent: a non-hermetic frozen test plus a flag that silently disables
  reviewer-role hardening. If `[ASSIGNMENT]` mentions an adapter failure (e.g. "po awarii
  adaptera OpenCode"), this env var is a plausible cause of the *previous* attempt's outcome —
  review picks can land on a harness that was supposed to be excluded.
- `git status` may die with `fatal: detected dubious ownership in repository at …`. Do **not**
  run `git config --global --add safe.directory …` (mutates user config). Note the limitation and
  establish "I made no edits" from your own action history instead.

## Step 4 — verification method (treat every `[TASK]` claim as a hypothesis)
For each named constant, interval, file and behavior in the prompt, find file:line evidence:
- **Values**: poll periods, windows, caps (`setInterval` sweeps + `config.js` constants). Prompts
  often quote the right number from the wrong module.
- **"Add X" traps**: the feature may already exist (batch endpoints, visibility gating, a queue
  pattern to mirror). Say so — a plan that re-adds it wastes the PR.
- **Absent guards**: re-entrancy/in-flight flags, dedupe wrappers (`apiFetchJson` vs
  `dedupeGetJson`), missing `.slice()`/cap where a sibling selector has one. These are usually the
  real cause of the reported symptom, not the cause the prompt guesses.
- **Fallback semantics that break a proposed contract**: e.g. query-length budgets (`chatIdsQuery`)
  where overflow silently degrades to "omit ids ⇒ server returns everything". Flag contract
  collisions the requirement list does not resolve.
- **Scope asymmetry between sibling routes**: compare a handler using a scoping helper
  (`listScopedChatIds`) with neighbours that only check existence; `requireAuth` admits bearer/
  widget tokens to all `/api/` paths, so per-route scoping is the enforcement point.
- **Server cost per request**, not only request count (e.g. full-file `readFileSync`+`JSON.parse`
  per history read) — the cheapest-looking win is often on the wrong side of the wire.
- **Stale docs**: dated plan/repair docs in `docs/` may describe code that already changed
  (`@deprecated` constants are the tell). Require the new plan to rebase, not restate.
- **Test convention**: check the suite's style before promising tests. Two styles coexist in
  `tests/*.test.js`: plain assertion scripts ending in `console.log('<file>.test.js OK')`
  (e.g. `harness-status.test.js`) **and** real `node:test` suites using `import test from 'node:test'`
  with `assert/strict` (e.g. `harness-plugin-loader.test.js`, `theme.test.js`, widget tests). Read the
  file first: the former runs as `node tests/x.test.js`, the latter as `node --test tests/x.test.js`.
  Note some `node:test` suites are not wired into `scripts/run-unit-tests.mjs`, so `npm test` passing
  does not mean they ran.

Grep hygiene: exclude `public/**` (built bundles embed full source maps → giant garbage hits) and
`data/`; scope to `app_front`/`lib` and `--include=*.js`.

## Step 5 — report shape that landed well
Sections: scope & deviations → tests run → **confirmed** (table: claim / status / file:line) →
**refuted** (each with the corrected mechanism) → **missing** (items the requirement list omits) →
regression risks the plan must freeze → which requirements are sound → blockers → one consolidated
artifacts line listing every file:line cited, so the parent can spot-check.

## Step 6 — send it
`delegation_reply` (load via `tool_search` — Cretli MCP tools are often not loaded at startup):
`chat_id` = executor/child chat, `delegation_id`, the live `attempt_id`/`run_id`,
`reply_kind=final_report`, `task_outcome=success|failure|blocked`, stable
`idempotency_key` (e.g. `review-<delegationId8>-audit-final-v1`), and **`message_text` only** —
`message_text` and `history_seq`+`content_hash` are mutually exclusive; sending both fails with
`VALIDATION_ERROR: Provide exactly one of history_seq+content_hash or message_text`.
A successful reply returns `status=queued` and does **not** mark the job reviewed — don't resend.

**If instead every `cretli_bridge` call fails with `MCP session is unknown or no longer active`**
(including read-only `ping_read` / `delegation_show`), that is infrastructure, not your payload:
retry the reply a bounded 2–3 times reusing the same `idempotency_key`, publish the full report in
the chat response so it isn't lost, append a delivery-blocker section naming the exact error and the
replay key, and end with `BLOCKED` — never a verdict implying the parent received it. See
**cretli-delegation-implement**, Step 6, for the same fallback on the executor side.
