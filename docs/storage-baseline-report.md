# Storage baseline report (A1) — final, all four workloads

Machine-local run of `scripts/storage-baseline-harness.mjs` with every workload
(F1 fix). Full data: [storage-baseline-report.json](storage-baseline-report.json).

## Run identity

| Field | Value |
| --- | --- |
| Run id | `2026-10-13T22-59-37-063Z` |
| Node | v22.23.2 |
| Bundled SQLite | 3.51.3 |
| Seed | `20261013` (same stream for every variant) |
| Workloads | **small, medium, growing, mixed** (`workloadsRun` complete) |
| Report hash | `355c3fa2a5cc804dc6882c8069b4e7cece5c0408b3621025f7b80f6719c860b1` |
| Durability | json-cache: rename + fsync per chat file; SQLite: WAL + `synchronous=FULL` (both SQLite variants) |
| Event-loop sampling | 1 ms resolution |

## Raw headline numbers (ms unless noted)

p50 / p95 / p99 for commit; `n` for checkpoints is samples per run.

### small (10 chats × 50 events)

| Metric | json-cache | sqlite-main | sqlite-worker |
| --- | ---: | ---: | ---: |
| commit p50 / p95 / p99 | 4.96 / 6.99 / 7.92 | 4.88 / 6.96 / 8.76 | 4.99 / 7.30 / 8.30 |
| query p95 | 0.13 | 0.10 | 0.40 |
| checkpoint p99 (n=1) | — | 4.97 | 17.81 |
| event-loop p99 / max | 8.04 / 8.15 | 8.86 / 11.72 | 1.48 / 5.71 |
| bytes written | 2 267 102 | 4 259 264 | 4 259 264 |
| CPU total (ms) | 191 | 112 | 363 |

### medium (100 chats × 200 events = 20 000 events)

| Metric | json-cache | sqlite-main | sqlite-worker |
| --- | ---: | ---: | ---: |
| commit p50 / p95 / p99 | 4.91 / 6.87 / 7.88 | 4.82 / 6.55 / 9.01 | 4.90 / 6.67 / 7.84 |
| query p95 | 0.16 | 0.13 | 0.36 |
| checkpoint p99 (n=1) | — | 5.11 | 4.99 |
| queue-age p95 / burst max | — | — | 1 / 978 |
| event-loop p99 / max | 7.98 / 103.4 | 9.07 / 84.2 | 1.85 / 2.22 |
| bytes written | 355 370 759 | 9 317 896 (2.6 %) | 9 317 896 (2.6 %) |
| startup reopen + cold read | 0 + 40.8 | 0.89 + 0.42 | 0.25 + 0.12 |
| CPU total (ms) | 6 345 | 3 001 | 6 995 |

### growing (20 chats × 50 events × 40 rounds)

| Metric | json-cache | sqlite-main | sqlite-worker |
| --- | ---: | ---: | ---: |
| commit p50 / p95 / p99 | 5.12 / 8.09 / 10.04 | 4.81 / 6.86 / 9.03 | 4.91 / 6.87 / 8.12 |
| query p95 | 0.87 | 0.14 | 0.39 |
| checkpoint p99 (n=5) | — | 4.98 | 6.12 |
| queue-age p95 / burst max | — | — | 1 / 926 |
| event-loop p99 / max | 10.39 / 19.45 | 9.09 / 30.18 | 1.84 / 6.82 |
| bytes written | 7 167 783 092 | 14 532 104 (0.2 %) | 14 532 104 (0.2 %) |
| CPU total (ms) | 40 239 | 5 932 | 13 298 |

### mixed (50 chats × 120 events × 3 rounds = 18 000 events, 40 % reads)

| Metric | json-cache | sqlite-main | sqlite-worker |
| --- | ---: | ---: | ---: |
| commit p50 / p95 / p99 | 4.92 / 6.95 / 7.95 | 4.77 / 6.47 / 7.93 | 4.88 / 6.67 / 8.07 |
| query p95 / p99 | 0.26 / 0.39 | 0.13 / 0.18 | 0.34 / 0.52 |
| checkpoint p99 (n=1) | — | 6.04 | 5.95 |
| queue-age p95 / burst max | — | — | 1 / 955 |
| event-loop p99 / max | 8.18 / 104.1 | 8.02 / 15.04 | 1.83 / 5.01 |
| bytes written | 577 012 948 | 8 805 896 (1.5 %) | 8 805 896 (1.5 %) |
| startup reopen + cold read | 0 + 4.60 | 0.34 + 0.05 | 0.23 + 0.17 |
| CPU total (ms) | 7 137 | 2 713 | 6 305 |
| RSS end (MB) | 89.2 | 97.1 | 98.0 |

## Gate evaluation vs [storage-gates.md](storage-gates.md)

Interactive and event-loop gates on **mixed**, I/O gates on **medium**.

| Gate | Budget | json-cache | sqlite-main | sqlite-worker |
| --- | --- | --- | --- | --- |
| Commit p95 / p99 (mixed) | ≤120 / ≤250 | 6.95 / 7.95 PASS | 6.47 / 7.93 PASS | 6.67 / 8.07 PASS |
| History query p95 / p99 | ≤40 / ≤90 | 0.26 / 0.39 PASS | 0.13 / 0.18 PASS | 0.34 / 0.52 PASS |
| Worker queue wait+exec p95 / p99 | ≤80 / ≤180 | — | — | ≤8.1 PASS |
| Main-thread SQLite stmt p99 | ≤15 | — | 7.93 PASS | — |
| Event-loop p99 (mixed) | ≤25 | 8.18 PASS | 8.02 PASS | 1.83 PASS |
| Event-loop max (mixed) | ≤100 | 104.1 **FAIL** | 15.04 PASS | 5.01 PASS |
| Queue age p95 / burst max | ≤200 / ≤2000 | — | — | 1 / 955 PASS |
| Bytes per 1000 events (medium) | ≤25 % of JSON | — | 2.6 % PASS | 2.6 % PASS |
| Checkpoint p99 | ≤500 | — | ≤6.04 PASS | ≤6.12 PASS |
| Startup replay (medium) | ≤2× JSON cold (81.6) | 40.8 | 1.3 PASS | 0.4 PASS |

Mixed-workload event-loop p99: sqlite-worker 1.83 ms vs sqlite-main 8.02 ms — an
improvement of **6.19 ms**, which clears the 5 ms threshold in the go/no-go
rule (also 8.86 → 1.48 ms on small, 9.07 → 1.85 ms on medium, 9.09 → 1.84 ms on
growing; consistent). CPU cost: worker uses ~2.3× sqlite-main (6.3 s vs 2.7 s
mixed; 7.0 s vs 3.0 s medium; 13.3 s vs 5.9 s growing) because the worker
thread is counted in the process-wide delta.

## Caveats

- No dedicated warmup phase; samples pool every round from a cold store (see the
  warmup clause in storage-gates.md; bias is conservative for synchronous variants).
- Checkpoint n=1 on small/medium/mixed; n=5 on growing.
- `commitLatencyMs.max` of ~104 ms occurs on every variant of medium/mixed including
  the worker (single cold fsync outlier); it is not gated.
- Synthetic single-table chat-event model, not the full multi-store lock/usage
  journal interaction.
- Memory is process-cumulative across variants (proxy only).
- Event-loop numbers of one run are single-machine; ordering stable across the
  four workloads.

## Method notes

- Deterministic seeded workloads; identical stream for all variants.
- `bytesWritten` measured on disk (file sizes), not estimated.
- Checkpoint samples separate from commit samples.
- `queueAgeMs`, `startupReplayMs`, `cpuUsageMs` included.

## Reproduce

```bash
CRETLI_BASELINE_OUT=/tmp/storage-baseline node scripts/storage-baseline-harness.mjs
# copy /tmp/storage-baseline/baseline-<ts>.json → docs/storage-baseline-report.json
```
