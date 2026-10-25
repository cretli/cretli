# Migration runner (A2 S7)

`lib/storage/migration-runner.js` is the **mechanism** for restart-safe data
migrations. It migrates no real stores; callers register steps. Schema versioning stays
in `migrations.js` (`applyMigrations`); `stepFromMigration()` wraps a `CORE_MIGRATIONS`
entry as a step when one list is wanted.

## Where it runs

Synchronously on a connection from `openStorageDb()`, in the storage worker at boot
before the command queue is served, or on a maintenance connection with writers
drained. It owns its `BEGIN IMMEDIATE` transactions, so it must **not** be called from
a worker command handler (the host already holds a transaction there). There is no
async facade, no blocking cross-thread wait, and no lock held across a foreign `await`. Bulk work
belongs in the worker, never the interactive event loop.

## Steps

| kind | implementation | transaction shape |
| --- | --- | --- |
| `sql` | `sql` string | one transaction; journal `done` in the same transaction |
| `atomic` | `apply(db)` | same as `sql` |
| `chunked` | `run(ctx)` → `{ done, cursor }` | one transaction per chunk; cursor persisted in the chunk's transaction |

`ctx` = `{ db, cursor, chunkIndex, maxItems, deadlineMs, shouldYield() }`. A chunk
must stop by `maxItems` / `shouldYield()`; the runner cannot interrupt synchronous code,
it only reports `overran` in the progress event. A chunk returning an unchanged cursor
without `done` fails (`migration_no_progress`); a step that commits/rolls back itself
fails (`migration_step_committed`). Cursors are JSON, at most 64 KiB.

Every step has `id` (`[a-z0-9._-]`), a `version` string and optional
`touchesUserData`. The **checksum** is sha256 over id, kind, version, `sql` and
`touchesUserData` (function bodies are *not* hashed: bump `version` when `apply`/`run`
logic changes).

## Journal `storage_migration_journal`

Created by the runner (`IF NOT EXISTS`, not a schema migration): `step_id`, `state`
(`started|done|failed`), `attempts`, `resumes`, `chunks`, `cursor`, `checksum`,
`backup_ref`, `error_code`, `started_at`, `finished_at`.

## Guarantees

- Crash at any point: the open transaction rolls back; the next `runMigrations` reads
  the journal (the cursor lives in the journal, not in memory) and continues at the last
  committed chunk. A `done` step is never run again; steps run strictly in list order.
- Journal vs step list is verified before anything runs (and by `dryRun`):
  checksum drift on any journalled step → `conflict` (`migration_checksum_mismatch`),
  a journalled step the build does not know → `conflict` (`migration_unknown_step`),
  a `done` row after a not-done row → `corrupt` (`migration_order_violation`).
- `assertWritable()` (required unless `dryRun`; typically the coordinator's guard) is
  called before each transaction and again right before its COMMIT (step transactions,
  journal creation and `resetFailedStep`), so losing ownership,
  being fenced or a restore pause rolls the step back; its error is propagated unchanged
  and is **not** journalled as a step failure.
- `touchesUserData` steps need `backupBeforeStep({ stepId, kind })` (sync; may return a
  reference string). Missing → `conflict` (`migration_backup_required`) before any step
  runs. The callback runs before a step is first started and is not repeated on resume
  (the reference is stored in `backup_ref`).
- Step failure: the step's transaction rolls back (earlier chunks stay), the row becomes
  `failed` with `attempts` incremented and `error_code` set, and the error is rethrown.
  A retry re-enters the step (chunked: from its cursor). At `maxAttempts` (default 3,
  max 10) further runs refuse with `migration_attempts_exhausted` until
  `resetFailedStep()`.
- A step that ends the transaction itself (`COMMIT`/`ROLLBACK`) is detected right after
  its code returns, before any journal write: it is journalled `failed`
  (`migration_step_committed`), never `done`.
- `resetFailedStep(db, id, { assertWritable, discardProgress? })` re-arms a `failed` step
  with a fresh attempt budget (attempts 1). A chunked step with committed chunks keeps its
  cursor and chunk count (state back to `started`) and resumes where it stopped;
  `discardProgress: true` deletes the row so it replays from chunk 0 (the step must then be
  idempotent). A failed row without progress is deleted.
- `maxChunksPerRun` (default and max 10000) bounds one call: `status: 'paused'`, call again.
- `dryRun: true` returns `{ status: 'dry_run', pending }` and writes nothing.
- `onProgress` events: `plan`, `step-start`, `chunk`, `step-done`, `step-failed`,
  `paused`; observer exceptions are ignored.
- `faultHook(point, info)` is a test seam; a throw simulates a crash (rollback, nothing
  journalled). Points: `after-backup`, `before-step`, `chunk-run`, `before-commit`,
  `step-before-commit`, `chunk-committed`, `step-committed`.

## Limits

- Crash-resume counts in `resumes`, not `attempts`, so a crash loop is not bounded.
- Concurrent runners on two connections serialize on `BEGIN IMMEDIATE` and re-read the
  row under the lock, but only one owner is intended (coordinator).
- The runner enforces no wall-clock limit on a chunk, only the cooperative
  `deadlineMs` / `shouldYield()`.
