# A3a startup cost profile (follow-up to the validation report)

Scope: measure where an existing-store start spends its time and decide whether the frozen medium startup gate (`2x JSON cold load` = 15.946 ms) is reachable without weakening the unconditional F29 `wal_checkpoint(TRUNCATE)` barrier or the full `integrity_check` / `foreign_key_check`. Budgets are unchanged. The first full run (`/tmp/chat-bench-a1-first-complete.json`, provenance preserved, not rewritten) stays the source for the published gates; everything below is a **separate, measured** profile on a **freshly generated synthetic dataset** and does not replace it. It does not retroactively close the UNVERIFIED attribution of the first run (different generator/data, and its open time ~34 ms differs from the ~27 ms measured here); the original gate result stays a historical FAIL.

## Method

`scripts/storage-startup-profile.mjs` builds a synthetic `medium` store (100 chats x 200 events, ~20 MB, temp dir, no user data), then for each of 9 samples per variant copies it and runs **fresh child processes** (`scripts/storage-startup-profile-child.mjs`), so SQLite per-connection state is cold while the OS page cache stays warm (a cold-disk restart is not measured). Per sample, three modes run on separate copies:

- `componentsUnmapped` / `componentsMapped`: time each step with the same primitives `openStorageDb` uses (read-only open, header/schema peeks, `integrity_check`, `foreign_key_check`, read-write open, WAL+FULL pragmas, migrations, TRUNCATE barrier). The only difference is `PRAGMA mmap_size` on the read-only check connection: 0 vs 256 MiB. The effective value read back is stored in the artifact (`provenance.effectiveMmapSize`: 0 and 268435456). The checks always run in full; no production code is toggled, so unmapped vs mapped is a direct A/B in one run.
- `full`: times production `openStorageDb()` + `runWalTruncateBarrier()` end to end (mmap on, as shipped).
- Variants: `clean` (no WAL, as after a clean close) and `walPrecheckpointed`: a `-wal` file exists but **every frame was already checkpointed** (`wal_checkpoint(FULL)` reports log == checkpointed, stored under `walSetup`) before the process exited without close. There is no pending replay, so its barrier cost (~10.8 ms, fsync + TRUNCATE) is a **lower bound**, not an equivalent of the ~55 ms WAL-present figure from the first full run (which is a derived median on a different dataset). A pending-frames scenario was not measured.

Artifact (n=9 medians, per-sample rows and provenance incl. node v24.14.0, SQLite 3.51.2, linux-x64): `/tmp/a3a-startup-prof/medium-mmap-ab.json`. Older artifacts `medium-before.json` / `medium-after.json` are kept as they were (their `components` mode had no mmap control, so their component numbers are unmapped).

## Where the time goes (synthetic medium, n=9 medians, ms)

| Component | unmapped | mapped (256 MiB) |
| --- | ---: | ---: |
| read-only open + header/schema peeks | 0.33 | 0.34 |
| `integrity_check` | 20.76 | 17.29 |
| `foreign_key_check` | 4.80 | 3.51 |
| checks total | 25.56 | 20.80 |
| read-write open + pragmas + migrations | ~0.4 | ~0.4 |
| TRUNCATE barrier, clean | 0.04 | 0.04 |
| TRUNCATE barrier, `walPrecheckpointed` (lower bound) | 10.56 | 10.91 |
| `full` open, clean (mapped, as shipped) | n/a | 22.99 |
| `full` open + barrier, clean | n/a | 23.03 |
| `full` open + barrier, `walPrecheckpointed` | n/a | 33.57 |

On this dataset the two mandatory checks are ~90% of a clean open; migrations and opens are negligible; the barrier costs ~11 ms only when a WAL file exists.

## Change made

`openStorageDb` maps the file (`PRAGMA mmap_size`, 256 MiB cap, best-effort) on the **read-only check connection only**. Same checks, same pages, nothing skipped; the connection is closed right after the checks. Measured effect on the checks: ~25.6 ms -> ~20.8 ms (table above). Earlier full-mode runs before/after the code change (`medium-before.json` / `medium-after.json`, separate runs): clean `openStorageDb` 26.98 -> 23.20 ms, WAL-present variant 27.27 -> 23.42 ms (open + barrier 38.31 -> 34.62 ms). `cache_size` alone did not help (an unrecorded experiment, ~13% slower; not evidence).

## Verdict: gate still FAILS; this optimization is not sufficient

On this synthetic medium dataset the mapped checks alone (~20.8 ms) exceed the 15.946 ms budget even with zero barrier cost, and full clean open + barrier is ~23 ms. So **this optimization is not enough here**; that is a measurement on one synthetic shape, not a proof of a lower bound for every possible optimization. Options that were considered and not taken (arguments, not measurements):

- `quick_check`, sampling, or deferring checks past ready/ACK: weakens the integrity guarantee (out of scope per the task).
- Removing/skipping the barrier or skipping it when a WAL exists: weakens F29 durability (out of scope). Overlapping it with the read-only checks is unsafe because the checks must see the files before anything checkpoints/alters them.
- Parallel `integrity_check(table)` over several connections/threads: not implemented and not measured; its gain is only argued to be bounded because one table dominates the file, and it adds failure modes.
- Raising the budget: needs a separate design decision.

The original medium startup gate result stays a historical **FAIL** (first run: clean-close 30.629 ms, WAL-present derived 54.998 ms vs 15.946 ms); it was not re-run on the full four-workload benchmark. The variant stays **NO-GO** for production A3a acceptance (`aadeac30` not accepted). Task completion here is the measurement and a safe partial speed-up, not acceptance. The checks detect logical corruption SQLite can read, not silent media faults.

## Reproduce

```bash
node scripts/storage-startup-profile.mjs medium 9 /tmp/a3a-startup-prof/medium-mmap-ab.json
```
