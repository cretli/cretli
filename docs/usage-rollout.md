# Usage telemetry and model-pick: staged rollout and rollback

Status: rollout plan for the token/measurement and model-pick work
(stages 1-9). This document defines **how to enable each stage safely and how
to roll it back**; it is not a commitment that any stage is promoted.

The guiding rule is that every stage is **additive and readable in both
directions**: a new writer may emit more fields, but a reader that predates the
change must still be able to read the stored data, and a reader that knows the
new fields must keep reading data written by an older writer.

## 1. Stages

Enable the stages in order. Each stage is independently reversible and does not
depend on a later stage's flag.

### Stage A — contract and stamps (`b390f96e`)

What ships: `schemaVersion`, `normalizationVersion`, `contractRevision`,
`provenance`, `accountingScope`, `lifecycle`, `completeness`, `identityClass`
and the remaining contract fields on every new usage event
(`lib/usage/usage-contract.js`, `lib/usage/usage-event.js`).

Enable / rollback:

- There is no runtime flag: the fields are written on every new event. Rolling
  back the *reader* is safe because the fields are additive and the legacy
  fields (`tokens`, `provider`, `model`, …) are unchanged.
- Never rewrite already-persisted events to add or remove stamps. A missing
  stamp means "legacy event", not "unknown semantics" to be guessed.

### Stage B — normalization fixes (`bbedab87`)

What ships: the resolved/raw adapter boundary (Claude resolved camelCase,
CodeBuddy raw snake_case), the first-class `cacheWrite` bucket, and the
OpenRouter cache subtraction — all under `normalizationVersion = 2`.

Enable / rollback:

- Normalization runs inside the adapters; there is no separate flag.
- `normalizationVersion` is the rollback anchor: a stored event records the
  semantics that produced it, so a later reader must dispatch on the version
  rather than assume the current rules. Rolling back the adapter code keeps the
  already-stored v2 events readable; it must not reinterpret them as v1.
- Do not delete or rewrite the old normalization path while legacy events may
  still be read.

### Stage C — recovery and read-model (`2d05fded`)

What ships: the append-only JSONL journal under `data/usage/` with versioned
envelopes, checksummed records, the rebuildable `ledger-index.json`
read-model, inter-process write locking, snapshot baselines, late-usage
correction and retention.

Enable / rollback:

- The journal is the source of truth and the index is rebuildable. If the
  read-model is suspected, call `repairUsageLedger` — it rebuilds from the
  committed journal (including `key-prune` records) and never edits the
  journal. This is the recovery path, not a rollback.
- Rolling back to a pre-journal reader: legacy raw event lines remain readable,
  so the old reader still sees the events. New envelope records are opaque to
  it; do not point an old reader at a live data dir as the primary path.
- Never delete the journal or the applied corrections. A superseded line stays
  in the journal and is only omitted at read time; keeping it is what makes a
  later rollback and a repeat correction possible.

### Stage D — roles and eligibility (`63fe60ce`)

What ships: `MODEL_ROLE_POLICY_VERSION` (`role-policy-2026-10-08`), the
`rolesDelta` overrides, review eligibility guarantees and the readable
rejection reasons.

Enable / rollback:

- Role overrides live in `data/model-role-profiles.json` under `rolesDelta`.
  Removing that key (or the whole file) falls back to the shipped
  `DEFAULT_MODEL_ROLE_PROFILES` with no migration.
- Role policy is part of the eligibility cohort. A policy-version change starts
  a new observation cohort instead of mixing old and new decisions.

### Stage E — diagnostics and UI (`19d5cdb6`)

What ships: the Usage UI (cache buckets, data completeness, executed
automatic choices, cost provenance), the diagnostics report and the CSV export
meta rows.

Enable / rollback:

- These are read-only surfaces over the read-model. Rolling them back means
  hiding the panels; the API payload keeps its additive fields, so no data is
  lost and the panels can be re-enabled without a migration.
- A UI that predates a new field must show "unknown" instead of a fabricated
  zero. `n = 0` and a `null` ratio are rendered as "no data", never as `0%`.

## 2. Exploration stays dry-run until sign-off

- `MODEL_PICK_EXPLORE_CONFIG_DEFAULTS.mode` is **`dry-run`**: the selector may
  report `would-explore` and write an assessment log, but it must never start
  an out-of-band attempt.
- `off` disables the assessment entirely (no `explore` key on the pick).
- Flipping to `real` is a deliberate operator action in
  `data/model-role-profiles.json`, taken only after a period of dry-run
  review. Real mode is additionally bounded by the per-workspace/per-harness
  daily caps, the credit budget (`everyAutoExecuted`), the per-attempt
  time/cost limits and the cooldown, and it is gated by the task guards
  (never plan/review, never fix-after-fail, never the last round).
- Rolling back from `real` to `dry-run` (or `off`) is immediate and lossless:
  open attempts are released or finished by the existing lifecycle, and any
  in-flight real attempt keeps its recorded outcome.

## 3. Shadow scoring is never auto-promoted

- `MODEL_PICK_SHADOW_CONFIG_DEFAULTS.mode` is `shadow` (observer on) with
  `promotion: false`. The observer computes the alternative ranking and
  persists the comparison, but it **must not change the primary selection**.
- Promotion is a separate, dormant flag. A window only becomes eligible when it
  satisfies the documented gates (≥ 14 days and ≥ 200 calls, a decided-cycle
  floor, an infra-fail increase ceiling, a cost-growth ceiling, a Wilson
  pass-rate floor, an agreement floor and an implement-only first rollout).
- Passing the gates never promotes by itself; a human flips `promotion` after
  reviewing the agreement report. The number of shadow logs is **not** a
  promotion trigger.
- Rollback is `mode: 'off'`; the persisted comparisons stay readable and are
  not deleted, so re-enabling the observer resumes the same window.

## 4. Backfill only after a verified dry-run on a copy

- `applyUsageCorrections` supports `dryRun`. A mutating apply is allowed only
  after a dry-run was reviewed on a **copy** of the data directory and produced
  the expected diff (same key set, no double count, no run-count change).
- Before the first mutating apply the tooling copies the journal and
  `ledger-index.json` into `data/usage/.backup-<stamp>/`. Keep that backup as
  the rollback point for the backfill.
- A backfill is idempotent and keyed by `logicalEventKey`; a repeated
  correction is a no-op. Superseded lines stay in the journal, so a backfill is
  reversible by restoring the backup and rebuilding the read-model with
  `repairUsageLedger`.
- Never backfill by rewriting the journal in place and never guess missing
  legacy data: legacy events without a source stay `legacy`/`partial`/`unknown`.

## 5. Cross-cutting rollback guarantees

After any flag rollback:

1. **All stored versions stay readable.** Every persisted record carries its
   `schemaVersion` / `normalizationVersion` / `contractRevision` (or is a
   legacy line), and readers dispatch on that version. A rollback changes the
   writer, not the stored bytes.
2. **The journal and corrections are never deleted.** Pruning removes stale day
   files and retired identity keys only, always with a tombstone, and never an
   active run.
3. **The read-model is rebuildable.** `repairUsageLedger` is the single
   recovery entry point; it ignores the on-disk index snapshot and replays the
   committed journal in global `seq` order.
4. **No silent zeros.** A rolled-back reader must still show a missing value as
   `null`/`unknown`, and a reported zero as a real measurement.
5. **No automatic promotion.** Turning the shadow or exploration features off
   must not change the primary model selection or start any job.

## 6. Verification before each promotion

Do not promote a stage on the strength of one helper test. Before enabling a
flag, run the acceptance/conformance suite and the owning stage suites and
compare against a real provider/SDK usage sample:

- `tests/usage-acceptance-usage.test.js` (scenarios 1-3),
  `tests/usage-acceptance-decisions.test.js` (scenarios 4-6),
  `tests/usage-acceptance-policy.test.js` (scenarios 7-10);
- the stage suites listed in
  [usage-acceptance-report.md](usage-acceptance-report.md);
- for a subscription plan, compare **tokens**, not a hypothetical API invoice.

A passing helper test is not a production-path fixture. The report records
which scenarios are covered by which suite and which are still open.
