# Architecture program — pinned baseline and frozen budgets (stage 1)

Status: baseline for TODO `103827ff-c99a-4752-9fc1-ed3ebd382f40`. Pinned to the material
below; **a changed material requires a new baseline** (a different commit, dirty
fingerprint, seed, Node/SQLite version or hardware class). Nothing here changes runtime
behavior. Related: [architecture-system-map.md](architecture-system-map.md),
[architecture-target-adr.md](architecture-target-adr.md),
[architecture-vertical-dag.md](architecture-vertical-dag.md), numerical storage gates in
[storage-gates.md](storage-gates.md) (stricter gates win where they apply).

## 1. Pinned material

| Item | Value |
| --- | --- |
| Commit (leaf diff base, "Cretli snapshot") | `065f3d54a1c330b43cc8b0ba74a55e851970a932` |
| Parent of snapshot | `576b0167bfdf8fa72bd13dd19d4a59133785e534` (`next/2026-09-28`) |
| Dirty content inside the snapshot | `git diff 576b016 065f3d5` = `lib/mcp/mcp-vendor-map.js`, `lib/routes/delegations-routes.js`, `tests/delegation-route-chat-index.test.js`; fingerprint `sha256(git diff 576b016 065f3d5)` = `cb1556f30f2d19aab365e1d67dc4eefd96d9d07e80be7baf1f0b0ea78a9f41de` |
| Source working tree at audit time | worktree clean at the snapshot commit; this leaf then added only the files listed in the root plan manifest (docs/ + 2 scripts) |
| Node | v24.14.0 (repository gate: ≥ 22.16.0; the prior A1 report used v22.23.2 — **not the same runtime**, so A1 and these numbers are not directly comparable) |
| Bundled SQLite | 3.51.2 (A1 gate ≥ 3.51.0) |
| Hardware | Intel Core i7-14700KF, 28 logical CPUs, 24 GB RAM, WSL2 kernel 6.6.114.1 |
| Front bundle | not built and not measured in this leaf (no browser run) |
| Mobile profile | **not measured** — see §6 |
| Fixture seeds | storage harness `20261013`; chat-list bench `20261017` |

## 2. State of the request-local chat index fix

- What: `lib/routes/delegations-routes.js` `findParent()` builds one `Map` per request
  (`WeakMap` keyed by `req`) instead of calling `loadChats().find(...)` per row.
- Where it lives: it is **uncommitted in the main checkout** (branch `next/2026-09-28`,
  HEAD `576b016`, `git diff` fingerprint `712738f0c7a34a29209bf1db4f68a210280471af7e496cdbe86a310a9aeb42ce`
  for the two modified files) and is **included in the snapshot commit `065f3d5`** that
  is this program's material. The accompanying test file
  `tests/delegation-route-chat-index.test.js` (sha256 `0c61a88fffdb6a77a558a856dfa5beef7bd0b7418ab2da4a212ed7fd7c5aab5d`) is untracked there.
- Unrelated change in the same dirty set: `lib/mcp/mcp-vendor-map.js` pre-approves MCP
  tools of the managed `cretli_bridge` server for Codex. It is **not** part of the
  chat-index fix and must be integrated/reviewed separately.
- Tests: `node --test tests/delegation-route-chat-index.test.js` → 2/2 pass in the main
  checkout and in the audit worktree (together with `sidebar-render-metrics`,
  `ui-freeze-trace`, `ui-freeze-counters`, `storage-registry`: 10/10 pass).
- Integration: **not integrated, not committed**. No commit was made by this leaf (no
  separate user order). Owner of integration: the user's explicit commit decision;
  verification of coverage and removal of the pattern: vertical V0/V1 in the DAG.
  Scope: only the delegation routes — the other ≈134 `loadChats(` occurrences elsewhere
  (`chats-routes.js` 36, `delegation-service.js` 16, `todos-routes.js` 7 …) still copy
  the full list per call.

## 3. Reproduction commands

```bash
# Static inventory (deterministic; hashes are in the root plan manifest)
node scripts/architecture-sync-io-inventory.mjs --out docs/architecture-sync-io-inventory.json

# Chat-list read path on 500 / 5000 / 20000 fictional chats (isolated temp dir, ~5 s)
node scripts/architecture-chat-list-bench.mjs --sizes 500,5000,20000 --seed 20261017 \
  --out docs/architecture-chat-list-bench.json

# Storage backends (isolated temp dir, 1 ms event-loop sampling). ~11 min on WSL2 because of fsync.
CRETLI_BASELINE_WORKLOADS=small,medium,mixed CRETLI_BASELINE_SEED=20261013 \
  CRETLI_BASELINE_OUT=/tmp/storage-baseline node scripts/storage-baseline-harness.mjs

# Client synthetic freeze counters (no browser) and focused tests
node scripts/measure-ui-freeze-baseline.mjs
node --test tests/delegation-route-chat-index.test.js tests/sidebar-render-metrics.test.js \
  tests/ui-freeze-trace.test.js tests/ui-freeze-counters.test.js tests/storage-registry.test.js
```

Timings are machine- and run-specific: `docs/architecture-chat-list-bench.json` stored
in the repo is one run of the command above on the hardware in §1; a re-run reproduces
shape and order of magnitude, not identical digits. The storage harness JSON is stored
as [architecture-baseline-storage-harness.json](architecture-baseline-storage-harness.json)
(paths redacted; the harness `reportHash` covers the workloads block only:
`39534a9b6cb2cb8db825c5eec737ca16bdb918937efcb1e4c3412885f97a3f60`).

## 4. Measured results

### 4.1 Chat-list read path (current code, milliseconds, n / P50 / P95 / P99 / max)

`loadWarm`: `loadChats()` with a warm signature cache. `loadCold`: file signature
changed → `JSON.parse` + copy. `scopeLegacy`: one request making 50 scope lookups as
`loadChats().find(…)` (pre-fix pattern). `scopeIndexed`: same request with one
request-local `Map` (current delegation-route pattern). Source:
[architecture-chat-list-bench.json](architecture-chat-list-bench.json).

Values below are copied verbatim from the JSON (single pinned run, seed 20261017).
Rows with n = 30 (`loadCold`, `scopeLegacy`) are **exploratory**: their P95/P99/max come
from 30 samples (P99 ≈ max), below the plan's n ≥ 1000 rule for P99, so they are not
budget evidence. Rows with n = 1000 satisfy the sample rule for this micro-benchmark only.

| Chats | Metric | n | P50 | P95 | P99 | max |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 500 | `loadWarm` | 1000 | 0.011 | 0.029 | 0.085 | 0.407 |
| 500 | `loadCold` | 30 (exploratory) | 0.238 | 0.395 | 0.473 | 0.473 |
| 500 | `scopeLegacy` | 30 (exploratory) | 0.696 | 0.947 | 1.113 | 1.113 |
| 500 | `scopeIndexed` | 1000 | 0.028 | 0.054 | 0.15 | 0.305 |
| 5000 | `loadWarm` | 1000 | 0.096 | 0.217 | 0.307 | 0.802 |
| 5000 | `loadCold` | 30 (exploratory) | 3.142 | 3.851 | 4.015 | 4.015 |
| 5000 | `scopeLegacy` | 30 (exploratory) | 6.172 | 9.152 | 9.985 | 9.985 |
| 5000 | `scopeIndexed` | 1000 | 0.334 | 0.452 | 1.076 | 1.34 |
| 20000 | `loadWarm` | 1000 | 0.461 | 0.844 | 2.047 | 2.645 |
| 20000 | `loadCold` | 30 (exploratory) | 13.017 | 16.423 | 21.471 | 21.471 |
| 20000 | `scopeLegacy` | 30 (exploratory) | 29.248 | 30.855 | 31.259 | 31.259 |
| 20000 | `scopeIndexed` | 1000 | 1.764 | 3.508 | 4.05 | 6.094 |

File sizes: 113 705 B (500), 1 141 955 B (5000), 4 596 425 B (20000). Cost of the
legacy pattern is linear in lookups × chats (50 lookups per request here).

**Honest reading.** The earlier orientational diagnosis (single settings attempt
12.85 s → 279 ms; API list/runtime 254–270 ms; event-loop P99 ≈ 183 ms) was **not
reproduced and is unverified** by this micro-benchmark: the fixture's chat objects are small and a request
does 50 lookups, whereas the field case had thousands of delegation/mailbox rows per
request and real chat objects. The benchmark confirms the mechanism and the scaling
law (cost ≈ lookups × `copyChats(N)`, e.g. 5 000 lookups at 20 000 chats ≈ 100× the
50-lookup figure ≈ seconds) but **the 12.85 s / 279 ms numbers remain unverified
orientation**, to be re-measured in the HTTP E2E fixture of stage 3/8.

### 4.2 Storage backends (A1 harness, this run; 1 ms event-loop sampling)

Run id `2026-10-17T17-33-43-800Z`, Node 24.14.0, SQLite 3.51.2, seed 20261013. These
choose between **backends for history** (storage project's decision) and are included
to pin the machine; they are not application end-to-end results. Rows with n = 500
(`small`) are **exploratory** for P99/max (n < 1000); the other workloads have n ≥ 1000.

| Workload | Variant | commit P95 / P99 / max ms | n | event-loop P99 / max ms | bytes written |
| --- | --- | --- | ---: | --- | ---: |
| small | json-cache | 7.72 / 8.85 / 12.85 | 500 (P99 exploratory) | 8.95 / 13.0 | 2.3 MB |
| small | sqlite-main | 7.91 / 8.55 / 21.73 | 500 (P99 exploratory) | 8.65 / 21.9 | 4.3 MB |
| small | sqlite-worker | 8.07 / 8.64 / 9.88 | 500 (P99 exploratory) | 1.74 / 3.77 | 4.3 MB |
| medium | json-cache | 7.85 / 8.44 / 107.9 | 20 000 | 8.79 / 108.0 | 355.4 MB |
| medium | sqlite-main | 7.03 / 7.97 / 17.89 | 20 000 | 8.12 / 18.0 | 9.3 MB |
| medium | sqlite-worker | 7.46 / 8.19 / 17.30 | 20 000 | 1.82 / 5.90 | 9.3 MB |
| mixed | json-cache | 7.94 / 8.79 / 14.74 | 18 000 | 9.06 / 15.8 | 577.0 MB |
| mixed | sqlite-main | 6.99 / 7.92 / 34.70 | 18 000 | 8.07 / 34.8 | 8.8 MB |
| mixed | sqlite-worker | 7.28 / 8.03 / 19.07 | 18 000 | 1.82 / 3.91 | 8.8 MB |

Reading against [storage-gates.md](storage-gates.md): event-loop P99 ≤ 25 ms / max ≤
100 ms holds for every SQLite variant, and the **medium json-cache max event-loop
delay 108 ms exceeds the 100 ms gate**. The worker variant has the smallest event-loop
impact (P99 1.7–1.8 ms), consistent with the recorded A1 decision (sqlite-worker GO).
Write amplification: SQLite writes ≈ 2.6 % (medium) and 1.5 % (mixed) of the JSON
bytes (gate ≤ 25 %). Group-commit/queue-burst gates are for A3a and were not
re-evaluated. The previous A1 report ran on Node 22.23.2; absolute numbers differ.

### 4.3 Sync I/O and blocking primitives

[architecture-sync-io-inventory.json](architecture-sync-io-inventory.json): 794 files
scanned, 807 sync fs call sites (189 files; candidate sites, not measured blocking), 27 sync child processes (17 files), 7
`Atomics.wait` sites, 73 `DatabaseSync` references, 135 textual occurrences of `loadChats(` (static regex; includes the definition, so not 135 distinct call sites).
Per-site owner assignment is in [architecture-system-map.md](architecture-system-map.md) §5.
These are **counts of potential** blocking sites, not measured stalls: no per-site
event-loop attribution exists yet (stage 6 profiling).

### 4.4 Client synthetic counters

`node scripts/measure-ui-freeze-baseline.mjs` (no browser; local boot-cache build and
cold-start parse): at 300 chats build median 0.16 ms, at 1000/1500 chats ≈ 1.0 ms,
cold-start parse of 300 chats 0.17 ms median. The sidebar rebuild/presence table in
`app_front/features/sidebar/sidebarRenderMetrics.js` is a **manual** scenario (desktop
and mobile-edge, 3–5 chats connected, Watcher in `observe`, ~60 s idle); it was **not
executed** in this leaf.

## 5. Frozen budgets (targets, not results)

Copied from the human-approved program plan (v6); the stricter storage gate applies where noted. The API payload and DOM rows are frozen by human decision (see the freeze record below).

| Scenario | Desktop | Mobile | Source |
| --- | --- | --- | --- |
| Shell with usable cached view, P95 | ≤ 500 ms | ≤ 1000 ms | plan |
| Local interaction, P95 | ≤ 100 ms | ≤ 200 ms | plan |
| Chat switch to first useful content | ≤ 200 ms | ≤ 400 ms | plan |
| Sidebar open | ≤ 150 ms | ≤ 300 ms | plan |
| Sidebar search input → result | ≤ 100 ms | ≤ 200 ms | plan |
| Scroll | ≥ 95 % frames in device budget; no UI task > 100 ms (report > 50 ms) | | plan |
| Local read API (first page, settings) | P95 ≤ 100 ms, P99 ≤ 250 ms | | plan |
| Command ACK | after durable commit; P95 ≤ 120 ms, P99 ≤ 250 ms | | storage-gates |
| Event-loop, whole app mixed E2E | P99 < 100 ms, max < 500 ms | | plan |
| Event-loop, storage-gated work | P99 ≤ 25 ms, max ≤ 100 ms, 1 ms resolution | | storage-gates |
| Persist queue age | steady P95 ≤ 200 ms; burst max ≤ 2000 ms | | storage-gates |
| API payload, list/history first page | **frozen by human decision, 2026-10-17:** ≤ 100 rows and ≤ 128 KiB uncompressed JSON per page; any non-export API response ≤ 1 MiB | | human decision (change only by human decision) |
| DOM, whole app | **frozen by human decision, 2026-10-17:** ≤ 5 000 nodes with sidebar open; ≤ 300 rendered list rows including overscan; exceptions only for focus, drag and active row | | human decision (change only by human decision) |
| Statistics | ≥ 50 repetitions after warm-up; P99 from ≥ 1000 samples; report n/P50/P95/P99/max; mixed run ≥ 10 min; memory/listener/timer/subprocess check after 20 cycles | | plan |

**Freeze record (2026-10-17, frozen by human decision).** The API payload limits above (page ≤ 100 rows
and ≤ 128 KiB, ordinary response ≤ 1 MiB) and the DOM limits (≤ 5 000 nodes, ≤ 300 rendered rows) are
frozen exactly as written. They change only by a new human decision; V9 measurements may report against
them but do not amend them. The text below is the original rationale and is kept for context.

Rationale for the two caps: the 20 000-chat fixture file is 4.6 MB, i.e. ≈ 230 B
per chat record, so 100 list rows are ≈ 23 KB before DTO trimming — 128 KiB leaves
headroom for history pages with larger records; the 1 MiB ceiling is an upper bound
for ordinary responses, not a measured figure. The DOM figures are proposals derived
from the ≤ 100 ms task budget, **not measured**: no browser run exists in stage 1.
They are frozen as targets only after V9 measures a real desktop/mobile page; until
then V2/V4/V7 must treat them as a gated step before implementation (freeze or
amend them in the vertical's first deliverable, with human sign-off if changed).

Every queue, cache and buffer must document count/bytes/age limits and overflow
behavior before its vertical starts (stage 6 owns the remaining inventory). Results
must not be improved by deleting data, retention or disabling durability/features.

## 6. Not measured in this leaf (explicit gaps)

1. (owner: S3 builds the fixture, S8 accepts; vertical V9) HTTP/E2E latency at 500/5000/20000 chats with ≥ 20 workspaces, deep subtrees,
   thousands of live rows in one group and a large archive — **no such fixture exists
   in the repository**; only the chat-list micro-benchmark above. Building it is a
   stage 3/8 deliverable (V9 in the DAG).
2. (owner: S5 and S8; V4/V7/V9) Real desktop/mobile browser runs (cold/warm/offline/reconnect, stream-to-paint,
   terminal-to-paint, scroll frames) and the emulated mobile profile.
3. (owner: S8, fixtures S3; V9) Mixed 10-minute load with 3–5 streams + Watcher + status bursts, event-loop under
   load, and the 20-cycle memory/listener/timer/subprocess check.
4. (owner: S3 growth fixtures; S6/S8 Files/Terminal/Browser; V8/V9) TODO/Watcher/delegation/usage growth fixtures, Settings and Files/Terminal/Browser
   overhead (Cretli overhead must be separated from provider/model/external time).
5. (owner: S2, first task; `scripts/` tool) Dependency-cycle report (no tool in the repo).
6. `sidebarRenderMetrics` manual scenario and the mobile (emulated) profile (owner: S5 measures, S8 accepts; V4/V9).

Until these exist, no vertical may claim a performance win; the DAG makes each
vertical's first task "extend the baseline for your scenario".
