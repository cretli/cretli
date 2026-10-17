# Storage backend decision (A1)

Date: 2026-10-14. Status: **final** — baseline with all four workloads
(small, medium, growing, mixed) recorded in
[storage-baseline-report.md](storage-baseline-report.md) +
[storage-baseline-report.json](storage-baseline-report.json), evaluated against
[storage-gates.md](storage-gates.md).

## Decision summary

| Question | Outcome |
| --- | --- |
| Consolidate chat-event history into SQLite? | **GO** — **sqlite-worker** variant, FULL durability |
| Standardize registry + adapters for B1? | **Yes** — [storage-registry.json](storage-registry.json) |
| Usage journal authority | **Unchanged** — remains source of truth (DATA-11) |
| Existing SQLite domains | **Keep** — `recovery.sqlite`, `delegations.sqlite`, lock-only DBs |

## Baseline evidence (DATA-01)

`reportHash=355c3fa2a5cc804dc6882c8069b4e7cece5c0408b3621025f7b80f6719c860b1`,
run `2026-10-13T22-59-37-063Z`, Node v22.23.2, bundled SQLite 3.51.3, seed
`20261013`, `workloadsRun = small, medium, growing, mixed`. Identical durability
for all variants (JSON: rename + fsync; SQLite: WAL + `synchronous=FULL`).

Gate table (interactive/event-loop on **mixed**, I/O on **medium**):

| Gate | Budget | json-cache | sqlite-main | sqlite-worker | Verdict |
| --- | --- | ---: | ---: | ---: | --- |
| commit p95 / p99 (ms) | ≤120 / ≤250 | 6.95 / 7.95 | 6.47 / 7.93 | 6.67 / 8.07 | PASS all |
| query p95 / p99 (ms) | ≤40 / ≤90 | 0.26 / 0.39 | 0.13 / 0.18 | 0.34 / 0.52 | PASS all |
| main-thread stmt p99 (ms) | ≤15 | — | 7.93 | — | PASS |
| event-loop p99 (ms) | ≤25 | 8.18 | 8.02 | **1.83** | PASS all |
| event-loop max (ms) | ≤100 | **104.1** | 15.04 | 5.01 | json-cache FAIL |
| queue age p95 / burst max (ms) | ≤200 / ≤2000 | — | — | 1 / 955 | PASS |
| bytes vs JSON (medium) | ≤25 % | — | 2.6 % | 2.6 % | PASS |
| checkpoint p99 (ms) | ≤500 | — | 6.04 | 5.95 | PASS |
| startup replay vs 2× JSON cold | ≤81.6 ms | 40.8 | 1.3 | 0.4 | PASS |

## Variant selection

Go/no-go rule: the simplest passing variant wins unless the worker improves
event-loop p99 by ≥ 5 ms. Measured on mixed: sqlite-main **8.02 ms** vs
sqlite-worker **1.83 ms** = **6.19 ms** improvement (small 7.4, medium 7.2,
growing 7.3 ms — consistent). The main-thread variant blocks the loop for the
whole FULL fsync on every commit (p99 ≈ 8–9 ms, max up to 84 ms on medium);
the worker keeps the loop at ~1.8 ms p99 / ≤ 7 ms max.

**Selected variant for A2: sqlite-worker.**

Cost accepted: ~2.3× total CPU of sqlite-main (mixed 6.3 s vs 2.7 s; medium
7.0 s vs 3.0 s; growing 13.3 s vs 5.9 s), which is still below json-cache on
growing (40.2 s) and comparable on medium/mixed, plus RSS ≈ +1 MB on mixed.
Complexity gate: A2 must document the worker crash/restart protocol and give
every DATA-02 read-modify-write section a migration owner before callers move.
Durability must stay `synchronous=FULL`; no weakening is part of this decision.

sqlite-main remains the documented fallback if the worker protocol cannot be
made crash-safe.

## Rationale

- Design review verdict remains **FAIL** for implementation readiness
  ([persistence-backup-review-opus55.md](persistence-backup-review-opus55.md)).
- Caller inventory shows wide **synchronous RMW** on JSON stores (DATA-02).
- `inventoryGaps` block a complete snapshot until B6/quiescence (webpack lock,
  auxiliary usage JSONL).
- json-cache rewrites whole documents: 577 MB vs 8.8 MB on mixed, 7.2 GB vs
  14.5 MB on growing, and its event-loop max (104 ms) breaks the 100 ms budget.

## Valid no-go outcome

Retaining standardized per-domain stores is an **accepted** outcome. Backup/migration
(B1+) consumes the same registry and logical export adapters without a single
`cretli.sqlite` monolith.

## Next steps

1. A2 implements the **sqlite-worker** variant (history stream, group commit within
   the frozen limits) with a documented worker crash/restart protocol.
2. If the worker protocol is rejected, fall back to sqlite-main or to the
   no-go path (registry + adapters only).
3. Repeat the baseline on target hardware with a warmup phase when one is added.

## Sign-off checklist (A1 leaf)

- [x] Versioned registry artifact
- [x] Caller inventory
- [x] Runnable baseline harness + docs
- [x] Numerical gates frozen
- [x] Baseline report attached (small + medium + growing + mixed, hash cited above)
