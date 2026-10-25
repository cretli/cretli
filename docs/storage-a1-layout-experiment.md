# A1 bounded SQLite physical-layout experiment (page_size)

Follow-up to [storage-a3a-startup-profile.md](storage-a3a-startup-profile.md). It asks one question: does choosing a different `page_size` for a **freshly created** store make the medium start cheap enough to shortlist, **without** weakening anything? It is a screening measurement, not a production decision. The original A3a result stays **NO-GO** ([storage-gates.md](storage-gates.md), recorded exception: startupReplay only).

Nothing in `lib/storage/` changed. The experiment lives in `scripts/storage-layout-*.mjs` and `tests/storage-layout-experiment.test.js`. Page size is set by pre-creating an empty WAL file with `PRAGMA page_size` before the production worker first opens it; the production open path, migrations, `integrity_check`, `foreign_key_check` and the unconditional `wal_checkpoint(TRUNCATE)` under `synchronous=FULL` run unchanged in every variant (no `quick_check`, no `NORMAL`).

## Frozen thresholds (written before any measurement)

These are the unchanged [storage-gates.md](storage-gates.md) budgets. The runner refuses to measure unless this document contains the hash below, so they cannot be edited after seeing results.

thresholdsSha256: `48b2e9ce8a97946a829e85970fe0a3298f51d16b90aad3fe82adb02f4d684c3c`

```json
{"apiAppendWallMs":{"p95":120,"p99":250},"workerQueueWaitPlusExecuteMs":{"p95":80,"p99":180},"historyPageQueryMs":{"p95":40,"p99":90},"eventLoopDelayMs":{"p99":25,"max":100,"monitorResolutionMs":1},"queueAgeMs":{"steadyP95":200,"burstMax":2000},"bytesWrittenPct":{"maxPercentOfJsonRewriteBytes":25},"fullCheckpointStallP99Ms":500,"startup":{"maxMultipleOfRemeasuredJsonColdLoad":2,"minSamplesPerVariantCase":15}}
```

Decision rules, also frozen:

- **Startup (screening gate):** median A1 `open + barrier + coldpage` of **both** medium cases (clean-close and pending-WAL) must be <= 2x the median of the JSON cold load re-measured in the same run on the same input (n >= 15). The historical 15.946 ms is context only. E2E spawn-to-ready is reported with its ratio but, as in A1, has no budget.
- **Workload screening (one generation run per variant, concurrency 64, medium stream):** append wall p95/p99, worker request p95/p99, page-query p95/p99, event-loop p99/max at 1 ms resolution, queue age p95, bytes written as % of the JSON rewrite bytes. Not covered by this run and therefore always listed as outstanding: burst queue-age max, FULL-checkpoint stall p99 (one sample, n < 30), the small/growing/mixed workloads.
- **Correctness:** logical export identical to baseline in both cases, effective `page_size` read back by PRAGMA in every sample, `integrity_check` = ok and `foreign_key_check` = 0 rows after every sample, F29 barrier `busy = 0` with all frames checkpointed and the WAL truncated, WAL + `synchronous=FULL` + `foreign_keys=ON` effective, pending-WAL fixture proven.
- **Verdict per variant:** `NO-GO` if any measured gate/check fails; else `UNVERIFIED` if anything required is missing, non-finite, NaN or has n < 15; else `GO (screening shortlist only)`, which still requires one full run of the four frozen workloads before any separate plan.

## Method

- Dataset: the exact A1 bench generator (`createStream`, seed 20261013, medium = 100 chats x 200 events x 1 round, retention 2000; the test pins equivalence to `scripts/storage-chat-history-bench.mjs`), appended through the real worker host and group committer, so inputs, receipts, dedupe, revisions and relations are the production ones.
- Logical identity: deterministic export of **all** tables (every column, ordered, sha256 per table) plus the schema SQL, compared against baseline. Columns named `*_at` carry wall-clock stamps that differ between independent runs; they are masked to their SQLite type (listed in the JSON as `maskedColumns`). Everything else, including payload/result JSON, is compared byte for byte.
- Variants: baseline (real default page_size, untouched creation path), 8192, 16384; a candidate equal to the baseline default would be skipped (not replaced).
- Cases: **clean-close** (host closed, no WAL) and **pending-WAL**: after the clean store, the real host appends 5 more events per chat plus 20 sequential single-event commits (so the worker's own auto-checkpoint cannot leave the WAL fully backfilled); while it is still open and idle, `db` and `-wal` are copied (never `-shm`), no checkpoint runs on the copy. Proof: events visible with the WAL minus events in the main file alone (on probe copies) must be > 0, plus the frame count from the WAL header; a precheckpointed WAL has zero and would be UNVERIFIED. The pending dataset is therefore medium + 520 events.
- Samples: >= 15 per variant and case, rounds of a seeded shuffle of all variant x case units and the JSON denominator (interleaved, deterministic), each unit = three **fresh child processes** on three separate copies (`reopen` = A1 definition, `e2e` = worker host spawn-to-ready + cold page, `components`). Warm OS cache; no cold-disk claim. Module loading is before the first timestamp. Medians of components are not summed in place of totals.
- Evidence recorded: raw samples, median / p95 / n, input sha256, node / SQLite / filesystem, effective pragmas, code revision plus a sha256 of the storage sources, `page_count`, `freelist_count`, per-table/index bytes from `dbstat` when available.

## Reproduce

```bash
CRETLI_CODE_REVISION=$(git rev-parse HEAD) node scripts/storage-layout-experiment.mjs \
  --samples 15 --out /tmp/a1-layout.json --md /tmp/a1-layout.md
```

## Results

Run provenance: node v22.23.2, SQLite 3.51.3, linux-x64, filesystem ext4 (reported by `stat -f` as `ext2/ext3`), default page_size 4096, code revision `509b955e987306ac068855b43db327784ddf4806` (clean worktree + this experiment's scripts), input sha256 `85e2f0e082a94d19126fffd97ab86d6bda53eb5dce09f22d40abe22b43d0d745`, effective pragmas read back in every sample: `journal_mode=wal`, `synchronous=2` (FULL), `foreign_keys=1`, `page_size` = requested for every sample of every variant. Warm OS cache. n = 15 per variant and case.

**JSON cold load re-measured** (same stream, one file per chat, retention 2000, fresh process per sample): median / p95 / n = **9.232 / 12.148 / 15 ms**, so the screening budget is 2x = **18.464 ms**. (The historical 15.946 ms is context only; the earlier 15.946 ms denominator came from a different run.)

| Variant | Case | A1 open+barrier+coldpage (median / p95 / n) | x JSON | E2E spawn-to-ready+coldpage (median / p95 / n) | x JSON | A1 open | A1 barrier | A1 coldpage | Verdict |
| --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | --- |
| baseline | clean | 24.209 / 27.91 / 15 | 2.62 | 67.856 / 74.748 / 15 | 7.35 | 22.996 | 0.063 | 1.193 | NO-GO |
| baseline | pendingWal | 56.817 / 68.737 / 15 | 6.15 | 102.813 / 170.982 / 15 | 11.14 | 28.194 | 27.841 | 1.265 | NO-GO |
| page8192 | clean | 22.784 / 24.36 / 15 | 2.47 | 67.324 / 73.058 / 15 | 7.29 | 21.587 | 0.061 | 1.12 | NO-GO |
| page8192 | pendingWal | 45.398 / 52.721 / 15 | 4.92 | 89.434 / 113.579 / 15 | 9.69 | 23.485 | 20.133 | 1.259 | NO-GO |
| page16384 | clean | 22.692 / 24.407 / 15 | 2.46 | 68.51 / 74.552 / 15 | 7.42 | 21.576 | 0.064 | 1.082 | NO-GO |
| page16384 | pendingWal | 57.346 / 65.614 / 15 | 6.21 | 102.109 / 110.7 / 15 | 11.06 | 30.25 | 26.16 | 1.334 | NO-GO |

Components (separate fresh-process run on its own copy; median ms; the direct totals above are the measurement, these only attribute):

| Variant | Case | integrity_check | foreign_key_check | TRUNCATE barrier | components total (direct, one run) |
| --- | --- | ---: | ---: | ---: | ---: |
| baseline | clean | 16.454 | 4.266 | 0.068 | 22.472 |
| baseline | pendingWal | 18.266 | 4.855 | 28.958 | 57.442 |
| page8192 | clean | 15.362 | 3.719 | 0.066 | 20.766 |
| page8192 | pendingWal | 16.213 | 3.979 | 19.6 | 43.206 |
| page16384 | clean | 15.032 | 3.44 | 0.067 | 20.346 |
| page16384 | pendingWal | 17.653 | 4.583 | 27.542 | 57.376 |

Layout and workload screening (one generation run per variant; 20000 appends at concurrency 64):

| Variant | page_size (PRAGMA) | page_count | freelist | append p95 / p99 ms | worker req p95 / p99 ms | page query p95 / p99 ms | event-loop p99 / max ms | queue age p95 ms | bytes written (% of JSON rewrite) | FULL checkpoint ms (n=1) |
| --- | ---: | ---: | ---: | --- | --- | --- | --- | ---: | --- | ---: |
| baseline | 4096 | 5307 | 0 | 75.71 / 83.902 | 34.93 / 42.25 | 0.508 / 0.619 | 1.67 / 4.35 | 0.017 | 27180504 (3.962%) | 0.224 |
| page8192 | 8192 | 2626 | 0 | 72.723 / 75.952 | 31.91 / 35.20 | 0.507 / 0.704 | 1.63 / 3.85 | 0.012 | 31552632 (4.599%) | 0.208 |
| page16384 | 16384 | 1333 | 0 | 76.307 / 83.733 | 35.73 / 42.43 | 0.49 / 0.695 | 1.72 / 5.17 | 0.017 | 41168936 (6.001%) | 0.172 |

Pending-WAL fixtures (proof on probe copies; events = rows visible with the WAL minus rows in the main file alone):

| Variant | WAL frames | WAL bytes | main-only events | with-WAL events | pending events | proven |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| baseline | 1240 | 5108832 | 20384 | 20520 | 136 | true |
| page8192 | 1240 | 10187872 | 20500 | 20520 | 20 | true |
| page16384 | 1126 | 18475440 | 20320 | 20520 | 200 | true |

Raw per-sample values (a1Total, e2eTotal, JSON cold load, all in ms) are in [storage-a1-layout-experiment.raw.json](storage-a1-layout-experiment.raw.json).

Bytes by object (baseline, `dbstat`): `command_receipts` 7.9 MB, `chat_history_events` 7.8 MB, `chat_history_dedupe` 4.5 MB, `chat_history_events_chat_seq` 0.63 MB, `command_receipts_created_at` 0.84 MB; the two largest tables hold ~30% of the file each.

## Verdicts

| Variant | Verdict | Why |
| --- | --- | --- |
| baseline (4096) | **NO-GO** | clean 24.209 ms and pending-WAL 56.817 ms both exceed 18.464 ms (2.62x and 6.15x JSON). |
| page8192 | **NO-GO** | clean 22.784 ms (2.47x) and pending-WAL 45.398 ms (4.92x) exceed 18.464 ms. |
| page16384 | **NO-GO** | clean 22.692 ms (2.46x) and pending-WAL 57.346 ms (6.21x) exceed 18.464 ms. |

Nothing is shortlisted. The original A3a result stays **NO-GO** and the recorded startupReplay exception is unchanged.

What the numbers say, and what they do not:

- Logical identity: the export of all 13 tables plus the schema sha256 is **identical to baseline** for both page sizes, in both cases (clean and pending). `*_at` stamp columns are masked to their type, everything else is compared byte for byte.
- Correctness checks held in all 270 fresh-process runs (180 start samples plus 90 component runs; the first four checks below apply to the start samples): zero failed samples, `integrity_check` = ok and `foreign_key_check` = 0 rows after each start, F29 barrier `busy = 0` with all frames checkpointed, the WAL file truncated to 0 bytes afterwards, WAL + FULL + foreign keys effective. Per variant the existing F29 test suite is page-size agnostic; the per-sample barrier assertion above is the per-variant evidence.
- A larger page size changes the clean start by about -1.4 ms to -1.5 ms (-6%), i.e. within the sampling noise of this machine for the checks (`integrity_check` ~15-16 ms and `foreign_key_check` ~3.4-4.3 ms dominate, as in the A3a profile); it does not close the 2x JSON gap (needs <= 18.464 ms, measured 22.7-24.2 ms). Both mandatory checks scale with the data, not with the page size.
- **Pending-WAL numbers are not like-for-like across variants.** The worker's own auto-checkpoint decides how many of the committed frames are still un-backfilled when the fixture is copied: 136 / 20 / 200 pending events (1240 / 1240 / 1126 frames, 5.1 / 10.2 / 18.5 MB of WAL) for 4096 / 8192 / 16384. Each case is proven pending, but the 8192 pending start being faster (45.4 ms) than the others mostly reflects the smaller amount of un-backfilled data, not a layout benefit. The 8192 and 16384 WALs are also 2-4x larger in bytes than the 4096 one.
- Workload screening (single generation run per variant, so single-run noise applies): append p95/p99, worker request, page query, event-loop (p99 <= 1.8 ms, max <= 5.2 ms at 1 ms resolution) and queue-age thresholds were all met by every variant. Bytes written grow with the page size (3.96% / 4.60% / 6.00% of the JSON rewrite bytes), still far below the 25% limit. Not covered and therefore **outstanding** in all cases: burst queue-age max, FULL-checkpoint stall p99 (one idle sample, n < 30, UNVERIFIED), and the small / growing / mixed workloads.

## Run history (honest record)

The first full run (kept as `supersededRun1` in the raw file) used a pending-WAL fixture that was **not proven** for page8192: the worker auto-checkpoint had already backfilled the whole WAL (0 pending events), so that case was UNVERIFIED by the frozen rule. The fixture was then fixed (an epilogue of 20 sequential commits after the tail, so the frames after the last auto-checkpoint stay pending) and the **whole experiment was re-run**; the tables above are the second run. The frozen thresholds and decision rules were not touched between the two runs, and run 1 reached the same NO-GO conclusion for all variants (clean medians 24.1 / 23.0 / 23.2 ms against 18.6 ms).

## Limits

One machine, one filesystem, one run of 15 samples per variant and case; warm OS cache only (cold disk, power loss and real fsync failure are not covered); synthetic data from the A1 generator; the screening metrics come from one generation run per variant and a single host/committer, not the four-workload benchmark. This is a screening result, not a production decision, and no production code was changed.
