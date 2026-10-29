# Todos backend cutover and rollback

Status: prepared tooling; production cutover is a separate human decision. Numerical
and correctness failures in [the benchmark](storage-todos-benchmark.md) block it.
Follow the ownership, verified-copy and per-path recovery requirements of
[the pre-cutover runbook](storage-pre-cutover-runbook.md), especially its rollback
boundaries. The migration CLI does not stop writers or constitute a supervisor.
The server does not currently call the todos runtime factory: publishing a marker
alone does not switch production wiring. A reviewed runtime integration is a
separate prerequisite; this runbook must not be used to claim a live switch.

## Preparation and verified copy

1. Record the reviewed release, Node/SQLite versions, current backend marker,
   externally retained dataset generation/fence and the latest gate report.
   Run `node scripts/benchmark-todos.js`. Inspect every FAIL; do not waive it
   by treating an unmeasured gate as zero.
2. Arrange an independent service manager/operator path outside Cretli. Pause
   clients, watcher claims, recovery launchers, queued browser commands and
   automatic outgoing work. Stop HTTP/MCP/background/CLI writers, drain commands
   and close the store. Inventory unknown writers as in the pre-cutover runbook.
   File mtime quietness alone is not proof of exclusive ownership.
3. In this quiesced window, create a verified offline snapshot with the existing
   snapshot procedure. Keep the archive and operation manifest outside all paths
   that will be replaced. Extract to a new isolated directory, verify every
   manifest checksum, counts, ownership and permissions. Preserve auth/TLS,
   external fence/control state and unrelated paths independently.
4. Rehearse migration, export verification and rollback on that extracted copy.
   The repeatable synthetic rehearsal is included in the benchmark command; it
   does not replace rehearsal of the installation's verified backup. Record both
   results and canonical hashes. Never run a live writer on the rehearsal copy.

## Quiesced import and marker

Use the reviewed migration CLI on the isolated staging copy first. The following
shell variables are operator-supplied paths, outside the examples in the repo:

```sh
node scripts/migrate-todos-to-sqlite.js --data-dir "$copy_dir" --dataset-generation "$generation"
node scripts/migrate-todos-to-sqlite.js --data-dir "$copy_dir" --dataset-generation "$generation" --apply --confirm-plan "$plan_hash"
```

The first command prints the source manifest, counts, canonical hash and plan
hash. Keep its output. The apply command recomputes that plan, imports a new
staging SQLite file, verifies workspace/item counts, IDs, tree/order/unknown
fields and canonical exported hashes, cleanly closes and publishes the store,
then publishes `todos-backend.json` selecting `sqlite`. It refuses an existing
store, changed source or incompatible marker. The original `todos/` remains
unchanged and must be retained read-only while SQLite is authoritative.

For a later approved installation cutover, repeat the final plan on the final
quiesced source, confirm it, journal each scoped publication outside replaced
paths, and re-read the marker and verified store before opening the runtime.
Keep the generation/fence consistent with external ownership. Never replace the
whole data root. On interrupted publication, keep all writers stopped; preserve
staging/store/marker evidence and recover the journal before any restart. A
marker/store mismatch must fail closed; do not create an empty replacement.

Start exactly one selected backend through the reviewed integration. Keep
watchers and clients paused. Verify list/detail, one CAS write, restart durability,
receipt reconciliation and unchanged retained source hashes before resuming
clients. Reconcile pending browser commands explicitly; restore claims as
interrupted. Resume automatic work only by explicit operator action.

## Rollback boundary and logical export

Before any new durable SQLite write, the verified previous dataset and marker
can be restored under exclusive ownership with the per-path journal. Use
`rollback-source` to check eligibility; never infer it merely from absence of a
successful HTTP response. COMMIT with a lost ACK is still a durable write.

After any durable write, the old JSON source is stale. Quiesce all writers and
cleanly close/fence the new store. Preserve both datasets and retained external
control state. Create a fresh logical export, verify it against the unchanged
SQLite store, then activate only the sidecar-aware rollback backend:

```sh
node scripts/migrate-todos-to-sqlite.js rollback-export --data-dir "$copy_dir" --out "$export_dir"
node scripts/migrate-todos-to-sqlite.js rollback-verify --data-dir "$copy_dir" --export-dir "$export_dir"
node scripts/migrate-todos-to-sqlite.js rollback-activate --data-dir "$copy_dir" --export-dir "$export_dir"
```

Export includes per-workspace JSON, manifest hashes, receipts and fencing
high-water state. Activation preserves the previous todos directory, publishes
live rollback control state and selects `legacy-rollback`. Keep the export at
its pinned path and keep SQLite/receipts read-only. Startup requires an owner
fence strictly above the recorded high-water mark; the runtime revalidates the
manifest, live hashes and receipt identity. An older plain JSON binary cannot
honor these controls. Verify a post-cutover ACK is present after activation and
restart before reopening clients. Never restore an old backup over a durable ACK.

Activation is an offline operation, not a general crash-recoverable multi-path
publisher. If interrupted before the marker, preserve the export, previous
source directory, SQLite file and rollback state; use the external publication
journal to complete or restore the consistent set before starting anything.
Do not blindly repeat activation against partially replaced paths.

## Telemetry evidence

`todos-write-stats` records every five-minute interval, including zeros, with
writes/bytes/stringifyMs/ioMs/maxMs aggregated before the general top ten.
Run on copies of the complete diagnostics files (UTC days):

```sh
node scripts/todos-stringify-daily.js --day=2026-10-28 server-diagnostics-*.jsonl
```

The daily baseline is 87,000 ms (261 s / 3 days from
`git show 74d6ffed:docs/stall-baseline-2026-10.md`), a conservative lower bound
because historical rows were truncated. PASS needs at least 99% reduction and
complete interval coverage; gaps produce INCOMPLETE. Only a recorded
`process-exit` followed by `server-start` excuses downtime. Cross-midnight
aggregate cost is allocated in proportion to duration; request adjacent-day
files too. Partial boundary days are INCOMPLETE. A daily log cap or write failure
also leaves missing coverage and cannot produce PASS. Production daily evidence
belongs to the separate post-cutover stall measurement task.
