# Storage numerical gates (A1)

Frozen **before** backend variant selection and A2 implementation. Measure against
[storage-baseline.md](storage-baseline.md) reports on the same hardware class.
Durability default for all SQLite variants: `journal_mode=WAL`, `synchronous=FULL`.

## Runtime compatibility matrix

| Gate | Requirement |
| --- | --- |
| Node | ≥ **22.16.0** for consolidation + native SQLite backup path |
| Bundled SQLite | ≥ **3.51.0** with FK + backup API (verified **3.51.3** on Node 22.23.2) |
| Unsupported runtime | Typed feature error — **no** live main-file SQLite copy fallback |

## Interactive latency (HTTP/WS critical commands)

Measured on the **mixed** workload. Applies to claim/stop/delegation ack paths once
migrated; the baseline proxy is chat append + paginated read.

**Warmup clause (as recorded).** The harness has no dedicated warmup phase: every
variant is measured from a cold, freshly created store and samples are pooled over
all `appendRounds` (mixed = 3). The budgets below are **unchanged** by this. The
bias direction is conservative — a cold start penalises the synchronous variants
(cold page cache, first-touch fsync), so a variant that passes cold also passes once
warm; the converse is not guaranteed. A future warmup phase must discard its samples
and re-take the SQLite byte baseline afterwards, or `bytesWritten` becomes
incomparable.

| Metric | Budget (p95) | Budget (p99) |
| --- | ---: | ---: |
| API handler wall time (server-side persist only) | **120 ms** | **250 ms** |
| SQLite worker queue wait + execute | **80 ms** | **180 ms** |
| History page query (50 events, indexed) | **40 ms** | **90 ms** |

p95/p99 are gated; `commitLatencyMs.max` is reported but **not** gated here — the
single-run worst case is governed by the event-loop max budget below, which is where
a main-thread stall actually shows up.

## Event loop

| Metric | Budget |
| --- | ---: |
| Event loop delay p99 (mixed workload) | **25 ms** |
| Event loop delay max (single run) | **100 ms** |
| Main-thread SQLite sync call (single statement, p99) | **15 ms** if main-thread variant wins |

`monitorEventLoopDelay` reports a healthy loop at approximately its sampling
resolution, so the resolution is part of the measurement, not a detail: it must stay
well below the 25 ms p99 budget or every variant fails on the sampling interval rather
than on a real stall. The harness samples at **1 ms**
(`CRETLI_BASELINE_ELD_RESOLUTION_MS`) and records it as
`eventLoopDelayMs.monitorResolutionMs`; read p99/max against that floor. A run
recorded at a coarser resolution is **not** comparable and must not be used for
go/no-go.

## Queue age (worker variant only)

| Metric | Report field | Budget |
| --- | --- | ---: |
| Persist queue age p95 (steady state) | `queueAgeMs.p95` | **200 ms** |
| Persist queue age max under burst | `queueBurstAgeMs.max` | **2000 ms** |

The burst probe queues `CRETLI_BASELINE_BURST_N` (default 200) inserts concurrently
*after* the measured workload, so `queueBurstAgeMs.p95` is expected to exceed the
steady-state p95 budget; only its **max** is gated.

## I/O and write amplification

Compared to **json-cache** baseline on **medium** workload:

| Metric | Budget |
| --- | --- |
| Bytes written per 1000 chat events | SQLite variants ≤ **25%** of JSON variant |
| WAL checkpoint stall (FULL) p99 | **500 ms** |
| Startup replay (medium dataset) | ≤ **2×** JSON cold load time |

## Group commit (history stream — A3a implementation)

| Parameter | Limit |
| --- | ---: |
| Max batch bytes | **256 KiB** |
| Max batch wall time | **40 ms** |
| Priority bypass | Stop, claims, intents, final flush — never starved > **500 ms** |

## Maintenance barrier (BACKUP-10 / B6)

| Metric | Budget |
| --- | ---: |
| Max snapshot barrier (flush + lock + stage) p99 | **30 s** |
| Event loop delay during barrier | same as event loop table |
| Unknown writer present | **Fail** snapshot (no complete archive) |

## Complexity / maintenance (go/no-go qualitative gate)

| Criterion | Threshold |
| --- | --- |
| New moving parts | Worker variant requires documented crash/restart protocol |
| Caller conversion | No variant passes unless DATA-02 RMW sections have a migration owner |
| Usage journal | Stays authoritative unless separate gate proves fsync-equivalent benefit |

## Go / no-go rule (DATA-01)

Adopt variant **V** only if:

1. Correctness + FULL durability preserved (no weakened `synchronous`).
2. All **interactive** and **event-loop** budgets pass on **mixed** workload.
3. **I/O** budget passes on **medium** workload.
4. **V** is the **simplest** passing variant (prefer main-thread SQLite over worker if
   worker adds no event-loop benefit ≥ **5 ms** p99 improvement).

If **no** variant passes: **no-go** to consolidation — retain standardized stores +
registry adapters; B1 proceeds on the same registry (storage-contract).

## Evidence required in baseline report

Per variant × workload, from `scripts/storage-baseline-harness.mjs`:

- `commitLatencyMs` / `queryLatencyMs` p50/p95/p99/max with sample count `n`
- `checkpointLatencyMs` — reported separately and never merged into commit samples
- `eventLoopDelayMs` — `monitorResolutionMs`, mean, p99, max
- `queueAgeMs` (steady state) and `queueBurstAgeMs` (burst), worker variant only
- `bytesWritten` **plus** `bytesWrittenMethod` — measured on disk (JSON: summed
  `statSync` sizes of every rewritten file; SQLite: file-size delta of
  `bench.sqlite` + `-wal` + `-shm` across the final FULL checkpoint). A
  payload-length estimate is not acceptable evidence.
- `cpuUsageMs.mainThread`, `cpuUsageMs.workerThread` and `cpuUsageMs.totalMs.combinedMs`
  — the worker variant's real cost is main **plus** worker thread
- `memory.rssAtStartMb` / `rssMb` / `rssDeltaMb` and `heapUsedMb`
- `startupReplayMs.reopenMs` / `coldReadMs`
- `durability` string — must state the actual protocol used (e.g. `FULL (rename +
  fsync per chat file)` vs `FULL (WAL + synchronous=FULL)`); a bare `FULL` is not
  evidence of parity
- Top level: `nodeVersion`, `bundledSqlite`, `seed`, `workloadsRun`, `reportHash`

`workloadsRun` must contain all four workloads (`small`, `medium`, `growing`,
`mixed`) before a final go/no-go: the interactive and event-loop budgets are defined
on **mixed**, the I/O budget on **medium**.
