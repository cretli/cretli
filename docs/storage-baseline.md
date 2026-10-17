# Storage baseline harness (A1)

Compares three backends on isolated synthetic data (never the live `data/` tree):

| Variant | Models |
| --- | --- |
| `json-cache` | Current chat-history pattern — load full JSON, append, rewrite file |
| `sqlite-main` | Incremental insert on main thread, WAL + `synchronous=FULL` |
| `sqlite-worker` | Same SQL in a dedicated worker thread |

Workloads: **small**, **medium**, **growing**, **mixed** (see script for dimensions).

## Run

```bash
# From repository root (uses a temp work dir; safe for dev machines)
node scripts/storage-baseline-harness.mjs

# Subset of workloads / fixed seed / fixed output directory
CRETLI_BASELINE_WORKLOADS=small,medium,growing,mixed node scripts/storage-baseline-harness.mjs
CRETLI_BASELINE_SEED=20261013 CRETLI_BASELINE_OUT=/path/to/reports \
  node scripts/storage-baseline-harness.mjs
```

Or:

```bash
npm run storage:baseline
```

## Measurement contract (fair comparison)

The harness follows fixed rules so numbers are comparable across variants and
runs (review finding F2):

- **Deterministic workloads.** A seeded PRNG (mulberry32, `CRETLI_BASELINE_SEED`,
  default `20261013`) generates chat ids, payload sizes and the read pattern.
  Every variant sees the *same* workload stream; two runs with the same seed
  produce identical byte counts and sample counts.
- **Honest `bytesWritten`.** JSON variant: sum of `statSync` sizes of every
  rewritten chat file. SQLite variants: on-disk delta of `bench.sqlite` +
  `-wal` + `-shm` measured just after schema creation and just after the final
  FULL checkpoint (`bytesWrittenMethod` field says which was used). Payload
  lengths are never used as a proxy.
- **Checkpoint separation.** The final `PRAGMA wal_checkpoint(FULL)` is timed
  into `checkpointLatencyMs` and is never mixed into `commitLatencyMs`.
- **Queue-age proxy** (`queueAgeMs`, worker variant only): wall-clock time
  between the parent enqueueing a task (`enqueuedAt`) and the worker thread
  starting it. Reported as p50/p95/p99/max.
- **Startup / replay** (`startupReplayMs`): SQLite variants close and reopen
  the database (`reopenMs`) and run one cold page query (`coldReadMs`); the
  JSON variant cold-reads every chat document (`coldReadMs`).
- **CPU** (`cpuUsageMs`): **one** `process.cpuUsage()` delta over the variant
  window. On Linux that counter is **process-wide even when read from a worker
  thread**, so the worker variant's number already contains its worker thread's
  CPU and there is no honest per-thread split to report. `workerWindowTotalMs` is
  the same counter read from the worker over its own lifetime — a cross-check
  that the two agree, **never** an additive component. (An earlier revision
  reported `workerThread` + `totalMs.combinedMs` by summing a per-window delta
  with a cumulative-since-process-start absolute; that double-counted and inflated
  the worker variant to ~32× on mixed instead of ~3×.)
- **Durability:** SQLite variants use WAL + `synchronous=FULL`. `json-cache`
  uses rename + `fsync` per chat file by default (`CRETLI_BASELINE_JSON_FSYNC=0`
  disables fsync for legacy comparison only). The `durability` field states the
  protocol actually used, because a bare `FULL` does not prove parity.
- **Event loop:** the harness `await`s `setImmediate` between operations so
  `monitorEventLoopDelay` can sample during synchronous variants. The monitor
  resolution is `CRETLI_BASELINE_ELD_RESOLUTION_MS` (default **1 ms**) and is
  recorded per variant as `eventLoopDelayMs.monitorResolutionMs`. A healthy loop
  reports a mean near that resolution, so the value must stay well below the
  gates.md p99 budget — at the previous 20 ms resolution every variant "failed"
  the 25 ms budget on the sampling interval alone.
- **Checkpoints:** when `appendRounds > 1`, FULL checkpoints run every
  `CRETLI_BASELINE_CHECKPOINT_EVERY` rounds (default 10) plus a final checkpoint.
- **Queue burst** (`queueBurstAgeMs`, worker only): after the measured workload and
  its final FULL checkpoint, `CRETLI_BASELINE_BURST_N` inserts (default 200) are
  queued concurrently. Each in-flight call captures its own `seq`, and a reply that
  never arrives fails the run after `CRETLI_BASELINE_BURST_TIMEOUT_MS` (default
  120 s) instead of hanging. Because the burst runs after the final checkpoint, its
  rows land in the worker WAL and are included in that variant's `bytesWritten`.
- **Memory:** `rssAtStartMb`, `rssMb` (end), `rssDeltaMb` and `heapUsedMb`. All
  variants of a run share **one** process, so a variant's `rssAtStartMb` equals the
  previous variant's `rssMb`; read `rssDeltaMb` as a process-level proxy, not an
  isolated per-variant footprint.

## Output

- JSON report: `$CRETLI_BASELINE_OUT/baseline-<timestamp>.json`
  (default: `$TMPDIR/storage-baseline/` unless `CRETLI_DATA_DIR` is set — then
  `<data>/storage-baseline/`).
- Fields per variant × workload: commit/query/checkpoint percentiles,
  queue-age percentiles (worker), event-loop delay (+ monitor resolution),
  bytes written (on disk) + method, startup/replay, one process-wide CPU delta,
  RSS/heap proxy, durability mode.
- Top-level: `nodeVersion`, `bundledSqlite`, `seed`, `workloadsRun`,
  `reportHash` (sha256 over the workloads block).

## Interpret results

1. Compare metrics to [storage-gates.md](storage-gates.md).
2. Record pass/fail in [storage-backend-decision.md](storage-backend-decision.md).
3. Re-run on the same machine class before changing the frozen gates.
4. Re-run with the same `CRETLI_BASELINE_SEED` when comparing two harness
   versions; a seed change invalidates cross-run byte comparisons.

## Limits

- Does not simulate multi-store locks, usage journal fsync, or backup barrier.
- Does not replace integration tests for recovery/delegation SQLite.
- SIGKILL tests are out of scope (not power-loss simulation).
- CPU and RSS are **process-level**: all variants share one process and run in
  sequence, so neither is an isolated per-variant footprint. CPU is reported as a
  single process-wide delta per variant window; a per-thread split is not obtainable
  from `process.cpuUsage()`.
- No dedicated warmup phase: each variant is measured from a cold, freshly created
  store and samples are pooled over all `appendRounds`. Cold-start bias inflates the
  synchronous variants, so a variant that passes here also passes warm — the
  direction is conservative, not flattering.
