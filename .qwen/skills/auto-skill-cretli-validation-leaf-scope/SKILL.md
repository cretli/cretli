---
name: cretli-validation-leaf-scope
description: As the Cretli parent/orchestrator, scope and brief a leaf that only VALIDATES an already-implemented contract (e.g. "Walidacja adaptera MVP — osobny liść na harness i wersję SDK") — do NOT flip a self-referential enable-gate (validation:'pending' / requiresCrashValidation) the leaf's own code comments invite you to flip when the live crash/rollout belongs to a later dependency leaf and existing tests pin the current value; deliver an ADDITIVE per-subject × per-exact-SDK-version × per-scenario matrix instead; pin resolved versions from node_modules/package-lock (never the caret range), mark 'unpinned' rather than fabricate; and override the watcher's pre-picked executor when workspace memory documents a role-specific failure mode for it.
source: auto-skill
extracted_at: '2026-10-08T06:42:48.328Z'
---

# Scoping a "validation" leaf in the multi-harness loop (parent side)

Trigger: you are the parent (Workspace Watcher cycle or manual plan→implement→review) on a leaf whose
title/body says **Walidacja / validation / coverage** of something an earlier leaf already *built*
(e.g. R7 "Walidacja adaptera MVP (osobny liść na harness i wersję SDK)" under root R-series 53efd61e,
after R5–R6 landed the recovery contract + runtime adapter). The plan restates acceptance as
"Testy dla każdego włączanego adaptera z dokładną wersją SDK: kontekst, żywy wykonawca, waiting,
cancel i missing transcript."

Companions: **cretli-multi-harness** (loop contract), **cretli-vacuous-test-review-gate** (the
green-suite-hides-absent-features cousin + model_pick/pickId mechanics),
**cretli-delegation-implement** (child side), the `mutating-slot-starvation-cant-be-outwaited` memory.

## 0. The trap: a validation leaf is NOT a feature-enable leaf

The subject code often carries a **self-referential gate** whose comment points right at this leaf:

```js
requiresCrashValidation: true,
validation: 'pending',          // "Recovery stays disabled until the per-SDK-version crash test (R7)
                                 //  flips `validation`."
```

It reads like R7 must flip `validation` → `'validated'`. **Do not.** Before writing the brief, check
two things that turn this into a hard "don't touch it":

1. **A later dependency leaf owns the real enable.** Here the live SIGKILL crash tests are R19 and the
   off/manual/automatic policy is R14. A headless watcher cycle cannot truly crash-verify N external
   executors deterministically, so flipping the gate here is *premature feature enable* + *test
   theater* (exactly the false-green this family of skills exists to catch).
2. **Existing tests pin the current value.** `tests/recovery-contract.test.js` asserts
   `entry.validation === 'pending'` and `view.validation === 'pending'` in two places. Flipping the
   gate breaks them; silently editing those asserts to match hides a contract change.

So the correct, safe deliverable is **ADDITIVE**: a new deterministic test + a validation matrix as
evidence, leaving the enable-gate and `requiresCrashValidation:true` untouched, and explicitly
instructing the child *not* to edit the pinning test. Put this under **TWARDE OGRANICZENIA / HARD
CONSTRAINTS** in the brief and tell the child to keep those two asserts green.

## 1. Enumerate every acceptance DIMENSION as its own per-subject assertion

The plan lists the harnesses and the scenarios as comma clauses. Quote them verbatim (paraphrase drops
clauses) and require **one named assertion block per (subject × dimension)**, never one merged
"happy" test. For the adapter leaf the matrix is:

- subjects = the 6 MVP harnesses (sdk, claude, codex, qwen, deepseek, opencode) **+** the deferred
  set (codebuddy, openrouter) **+** an unknown id → must be explicit `unsupported` on every dimension,
  never a silent `false`.
- dimensions = the 5 named clauses: **kontekst / context**, **żywy wykonawca / live-executor reattach**,
  **waiting**, **cancel**, **brak transcriptu / missing transcript**.
- the "osobny liść na harness i wersję SDK" clause = a **per-harness exact SDK version** row.

Drive them through the surfaces the earlier leaf already exposes, don't re-derive a second table:
`describeRecoveryAdapterContract`, `resolveRecoveryAdapter`, `resolveRecoveryDecision({reason,adapter,
liveness})`, `resolveEffectiveRecoveryCapabilities`, `resolveObservedTranscriptLoss`,
`createDurableRequestLookup({transport, rooms, recoveryStore})` (injection-friendly with a fake rooms
`Map` + a `recoveryStore` stub → deterministic, no global `registerKernelChatRunAdapter` side effects).
Per-harness expected outcomes must be *derived*, not hardcoded: only `opencode` (reattach) yields
`decision:'reattach'`, `automatic:true`, `transcriptLost:false`; the other 5 → `resume_session`-class,
`automatic:false`, `transcriptLossReason:'fresh_turn_in_saved_session'`; room gone → `room_missing`;
reattach adapter with a mismatched live run id → `no_live_run_match`; `cancelled` terminal &
non-recoverable, `canCancel:true`.

## 2. "dokładna wersja SDK" = the RESOLVED version, not the range

`package.json` optionalDependencies give a caret range (`@cursor/sdk ^1.0.37`,
`@openai/codex-sdk ^0.160.0`, `@qwen-code/sdk ^0.1.8`, `@deepseek-ai/dsh 0.1.2-alpha.5`,
`@opencode-ai/sdk ^1.18.26`). Assert the **exact resolved** version — read
`node_modules/<pkg>/package.json`.version (or parse `package-lock.json`). For a harness whose SDK is
installed by a bootstrap script (claude via `scripts/install-optional-claude-sdk.js`), pin from that
script/`node_modules`; if not deterministically knowable offline, mark it `'unpinned'` explicitly and
**never fabricate a version** to make the matrix look complete.

## 3. Headless-cycle constraints to bake into the brief

- Deterministic + offline: no network, no live model calls, no server start. A watcher cycle must not
  spawn real executor processes just to "validate".
- New file `tests/<name>.test.js` importing `node:test` is auto-discovered by
  `scripts/run-unit-tests.mjs` (it globs `tests/*.test.js` in isolated processes) — no package.json
  script edit needed, and the child must not add one.
- English comments (project rule); report in the user's language (Polish) with the `TASK:`/`VERDICT:`
  terminator.
- Require the child to run and paste: the new test + the pinning `recovery-contract` test + adjacent
  suites (`recovery-lifecycle`, `recovery-store`) + `npx eslint <new test>`. No PASS on a red suite.

## 4. Override the watcher's PRE-PICKED executor on documented failure modes

The cycle prompt hands you an `orchestrator executor: <harness>:<model> (implement_pick)` and
`model_pick(role=implement)` keeps returning the same flaky default. Workspace memory is authoritative
evidence to override it **for the specific role**:

- `qwen/qwen3.8-flash` → `slow_read_loop` (28 reads / 0 writes; implement jobs stall, never write the
  file) — disqualify it for *implement/fix* on a leaf whose whole deliverable is "write a substantial
  new test file". `exclude_model=qwen3.8-flash`.
- `deepseek/*` → recent "Insufficient Balance" 402 = a hard infra mid-write failure; exclude to avoid
  losing the round.
- `opencode/<...>-flash` → observed 0% implement pass_rate / 40% infra_fail — skip.
- Prefer a proven writer even at a higher cost tier for a bounded, high-value artifact (here
  `sdk/composer-2.5::fast=true`), and record the whole rationale in `pick_reason` (origin stays
  auditable). The compact bridge line returns no `pickId` → omit `pick_id`; never fabricate one.
  Plural excludes work as expected:
  `model_pick({role:"implement", exclude_models:["qwen3.8-flash","deepseek-flash"], exclude_harnesses:["codebuddy"]})`.
- Because the override rejects the watcher's pre-picked `implement_pick`, mark the start with
  `manual_source: "manual"` (origin=manual on the job card) alongside `pick_reason`.

This is the *inverse* of premium-model restraint: you're not chasing cost, you're steering around a
*reliability* failure mode the memory documents. State the reason.

## 5. If the mutating slot is starved (likely in autopilot)

`delegation_start(implement)` returns `CONFLICT/job_in_progress` with a `Blocker delegation id` owned by
a foreign parent. With `maxParallel=10` and several live cycles, the single workspace mutating slot is
snatched on free and cannot be out-waited (see memory). Do **3 optimistic grabs across ~60–90 s**, each
with a **fresh key per attempt** (`…-r1/-r2/-r3` — replaying one key just returns the same CONFLICT
record, it is not a new attempt). Check `delegation_list({chat_id: <blocker parent>})` once: if the
blocker is a **freshly `running`** job on a slow premium model (e.g. claude-opus implement), it will not
free inside the grab window — the remaining grabs are protocol confirmation, not a real chance; do NOT
extend the window past ~90s (every other cycle polls the same slot and wins the free moment). If still
blocked, close cleanly and preserve the work for the next cycle:

1. `wmem_add(type=blocker)` with a full **READY BRIEF**: the exact deliverable, the dimension matrix,
   the "don't flip `validation:'pending'` / don't edit the pinning test" constraints, the version
   mapping, the chosen executor, and the reminder for the next parent to mint its **own**
   `idempotency_key` (`mh-implement-<leaf>-<own-cycle>-r1`) because keys are parent-bound. Name the
   concrete artifact path (e.g. `tests/recovery-adapter-mvp.test.js`) and the exact source modules in
   the brief so the next parent can fire it verbatim.
2. Restore the leaf to `ready` with `todo_update` (zero product change, don't leave a stuck `doing`).
3. `watcher_report(outcome=blocked, cycle_id, report_id, todo_ids, message)` and stop — do not start
   another cycle.

### Recurring cycle: reading the preserved READY BRIEF in full

On a 2nd+ starvation recurrence, an earlier parent already stored the brief — reuse it instead of
re-deriving. **`wmem_list` previews truncate values to ~240 chars**, so the full brief is not readable
from the listing. Recover it from the chat that stored it:

1. `chat_history({ chat: "<prev orchestrator chat>", include_tool_payloads: true })` → locate the
   `wmem_add` event seq (the `continue: chat_event(...)` hint gives chat+seq+field).
2. `chat_event({ chat, seq, field: "args", offset, length: 4000 })` → page UTF-16 slices until
   `next_offset: none`; that is the complete brief.
3. Diff your prepared brief clause-by-clause against it (the verbatim-quotation rule) — fix filename
   and module-list drift — then fire it under your own keys. The new blocker wmem fact should cite the
   brief's key so the chain stays navigable.

## Reportability

A validation leaf that ends "blocked with a preserved brief" is a *correct* outcome, not a failure —
the next cycle fires the moment a slot frees. The anti-patterns to avoid are: (a) flipping the
enable-gate to force a "done", (b) merging the scenario matrix into one vague test, (c) fabricating an
SDK version, (d) burning the whole cycle budget polling a slot that another cycle will grab anyway.
