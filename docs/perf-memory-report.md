# Server memory report (RSS, GC pressure)

Symptom from the profile: RSS about 2.8 GB, GC about 7% of wall time (1.4 s of 21 s).

## Method

Throwaway scripts (not committed) ran against a copy of a real data directory with
`node --expose-gc`, forcing a GC before and after each load and reading
`process.memoryUsage().heapUsed`. The numbers below are parsed, retained heap, not disk size.
Structures were found by static analysis of module-level `Map`/`Set` caches in `lib/persist/`
and `lib/chat-run-service.js`.

## Long-lived structures (measured)

| Structure | Module | Data set | Disk | Retained heap | Bounded before? |
|---|---|---|---|---|---|
| Parsed usage day files (`dayFileCache`) | `lib/persist/usage-persist.js` | 41 day files | 87 MB | ~81 MB | Count only (400), so effectively no |
| Parsed chat histories (`historyCache`) | `lib/persist/chat-history-persist.js` | 8 largest of 4.8k files | 74 MB | ~101 MB | Count only (8), and eviction keeps the *largest* files |
| Parsed delegation rows (`parsedRowCache`) | `lib/persist/delegation-sqlite.js` | 4.8k rows | 65 MB JSON | ~90 MB (about 2x once the read-only snapshot's frozen rows are built) | Bounded by row count, which grows with history |
| Chats document cache | `lib/persist/chats-persist.js` | 7.6 MB file | 7.6 MB | ~9 MB | Single entry |
| Chat history revisions, pending-delegation set | `chat-history-revisions.js` | one small entry per chat | n/a | well under 1 MB | One entry per chat, tiny |

Together these retain roughly 400 MB of steady heap. They do not explain 2.8 GB RSS by
themselves: the rest is allocation churn (see below) that raises the V8 heap high-water mark
and fragmentation, plus external buffers (child-process output, sockets).

## Churn that drives GC

`loadDelegations()` and `loadChats()` copy every row on every call (sibling tasks: read-only
delegation snapshot, `peekChats`). With 4.8k delegations that is a few MB of short-lived
objects per call; the GC cost follows the call rate, not the retained size.

## Changes in this task (cap the retained size, no behavior change)

Both caches are pure read-through caches keyed by file signature, so evicting an entry only
means the next read parses the file again.

1. `usage-persist.js`: the day-file cache is now LRU (a hit refreshes recency) and capped at
   `MAX_CACHED_DAY_FILE_BYTES` (32 MB of on-disk size) in addition to the 400-entry cap.
2. `chat-history-persist.js`: the history cache is capped at
   `MAX_CACHED_CHAT_HISTORY_BYTES` (48 MB of on-disk size) in addition to the 8-entry cap. The
   newest entry is always kept, so a single oversized history is still served from cache.

## Before / after

| Cache | Before | After |
|---|---|---|
| Usage day files, reading Aug to Oct (78k events) | 41 entries, 87 MB on disk, ~81 MB heap | 7 entries, 28 MB on disk, ~29 MB heap (hard cap 32 MB) |
| Chat histories, 8 largest files | 74 MB on disk, ~101 MB heap | at most 48 MB on disk, ~65 MB heap |

The cost is a re-parse when a day file or history outside the budget is read again; both are
rare paths (usage reports over long ranges, opening an old huge chat).

Tests: `tests/usage-persist.test.js` (byte budget), `tests/chat-history-cache-limit.test.js`
(entry and byte budget, newest entry kept).

## Follow-up: usage day-file cache thrash (2026-10-25)

The 32 MB LRU cap turned out smaller than one 7-day window on a busy instance
(9 day files, ~41 MB). A window scan from old to new evicted exactly the file
the next request started with, so the cache never hit: every Usage tab request
reparsed and re-checksummed the whole window (~700 ms for 7 days, ~1.5 s for
the month KPI read), and the tab fires several such reads at once. They queued
on the event loop past the client's 10 s GET timeout and the tab showed
"Could not load usage".

- Eviction now drops the **oldest day** (by file name) instead of the least
  recently used entry, and a file older than every cached one is not cached
  when it does not fit; recent days stay hot whatever the window size.
- The budget is 64 MB (`CRETLI_USAGE_DAY_CACHE_MB` overrides it), about two
  weeks here: 7-day reads drop to ~140 ms, the month read to ~750 ms, for
  ~60 MB of heap.
- Supersede replacement lookups reuse the cached parse instead of reparsing
  the day file on every read.

Tests: `tests/usage-persist-day-cache-scan.test.js`.

## Not changed, candidates for follow-up

- `delegation-sqlite.js` `parsedRowCache` is the largest remaining structure (~90 MB, 2x with
  the frozen snapshot rows). Bounding it would trade directly against the hot `loadDelegations()` path, so it
  needs a profile of the sibling task's change first.
- Reducing per-call copying in `loadDelegations()` callers (GC churn) is likely the bigger win
  for the GC percentage than any retained-size cap.

## Delegation read path: `loadDelegationsReadonly()`

`loadDelegations()` normalizes (`withRecordDefaults`, `normalizeVerifyResult`) and shallow-copies every row
per call; its returned top-level objects are fresh and editable, but nested elements (attempts, outbox
items, ...) are still shared with the store cache, so callers must not mutate them. A per-row memo that
returned deep copies was measured and rejected: cloning cost more than re-normalizing (90 ms vs 12 ms per
load at 4.8k rows).

`loadDelegationsReadonly()` returns one shared array of deep-frozen, privately cloned rows per store state.
It is rebuilt after any in-process write or detected external rewrite. On SQLite only rows whose
`parsedRowCache` object changed are re-normalized. On the JSON store `saveItems` re-seeds the document
cache with fresh row objects, so the first snapshot after a write re-normalizes every row once (the write
itself rewrites the whole file and costs more); reads after that are free. Mutating a returned row or the
array throws `TypeError`, so a caller cannot poison what other readers see.

### Measurements (4.8k rows with attempts, outbox and 4 KB verify tails; one process)

Idle reads (no writes between calls):

| Backend | `loadDelegations()` | `loadDelegationsReadonly()` |
| --- | --- | --- |
| JSON | 20.1 ms/call | 0.029 ms/call |
| SQLite | 31.0 ms/call | 8.1 ms/call (index-key scan + row-identity check per call) |

Watcher-tick replay: 20 ticks, each 1 delegation write followed by 6 full reads (tick snapshot, model-pick
history, health, stats routes):

| Backend | `loadDelegations()` | `loadDelegationsReadonly()` | Speed-up |
| --- | --- | --- | --- |
| JSON | 290 ms/tick | 232 ms/tick | 1.3x (the write dominates: whole-file rewrite, one full re-normalization) |
| SQLite | 191 ms/tick | 43.8 ms/tick | 4.4x |

`delegationLoadStats` (`rowsNormalized`, `snapshotBuilds`, `snapshotHits`) exposes the counters. The tick
replay is a synthetic reconstruction, not a production profile.

### Caller inventory

Migrated to `loadDelegationsReadonly()` (each verified to only read rows; the existing suites for every
module pass):

| Caller | Why hot | Notes |
| --- | --- | --- |
| `workspace-watcher.js` (default loaders, tick, status) | every Watcher tick, per workspace | rows pass to snapshot/decision code, covered by the watcher suites |
| `workspace-watcher-cycle.js` (child-active checks, close, verify) | every cycle step | `createTickDelegationsMemo` still wraps injected loaders |
| `workspace-watcher-stats.js`, `delegation-health.js` | dashboards/status polling | aggregates only |
| `model-pick-history.js`, `model-pick-service.js`, `model-pick-cost-policy-layer.js`, `model-pick-explore.js` | every `model_pick` | history keeps its own 750 ms TTL cache on top |
| `delegation-runtime-boot.js` | boot recovery, wake-up condition checks, shutdown scan | `updateDelegationRecord` by id, rows not edited |
| `routes/delegations-routes.js` (`/api/delegations`, `/stats`, `/review-loop-stats`) | UI polling | `pageDelegationRows` sorts a copy |
| `delegation-workspace-guard.js`, `delegation-workflow-budget.js` | per start/budget check | filter only |
| `delegation-service.js` (`countActiveDelegationRuns`, fallback-used check) | per start | |

Not migrated: `delegation-service.js` flows that pass rows to `finishDelegation`/patch paths,
`delegation-retention.js`, `delegation-takeover.js`, `todo-review-sync-hooks.js`, `harness-diagnostics-routes.js`
and `mcp/builtin/catalog-tools.js` (cold paths or rows handed to mutating code; migrate case by case).

## Workflow document cache and pool-round memo (readMembershipMap)

`readMembershipMap` (`lib/delegation-pool-round.js`) ran for every pool round
and history record of every workflow row on every `getDelegationWorkflow` /
`loadDelegationWorkflows` call, because each call re-read and re-parsed
`delegation-workflows.json` and re-normalized all rows. A `WeakMap` memo keyed
by the raw row alone never hit across loads, so
`lib/persist/delegation-workflows-persist.js` now keeps a parsed and normalized
document cache keyed by `mtimeMs:size:ino` plus an in-process write revision
bumped on every save. The cached rows are deep-frozen (callers must copy before
editing; the returned array is fresh per call), so the pool-round memo and the
shared records cannot be poisoned in place.

Measurement (synthetic store of 300 workflow rows, each with one pool round and
one history record; 200 `getDelegationWorkflow` calls with no write):

| | JSON parses | readMembershipMap calls | total time | per call |
| --- | --- | --- | --- | --- |
| before (base commit) | 200 | 120 000 (600 per load, derived) | 189 ms | 0.95 ms |
| after | 1 | 600 (once, at cache fill) | 7 ms | 0.04 ms |

`tests/delegation-workflows-cache.test.js` asserts the single parse, the single
membership read pass, freeze behaviour, and invalidation on save and on an
external rewrite.

## Diagnosing startup RSS growth

The observed 3–4 GB startup RSS incident is not yet attributed to JavaScript
retention, native allocation, or child processes. Do not select a repair from a
single RSS value. Collect a restart-window time series first.

### Capture the restart window

1. Immediately after a restart, save the authenticated response from
   `GET /api/diagnostics/server`. In `recent`, identify the `server-start`
   record for the current `serverInstanceToken`; this is the baseline. Do not
   restart the server solely to collect this report.
2. Save another response after the first periodic `sample` (normally about 60
   seconds after `server-start`), then at approximately 2, 5, and 10 minutes.
   There are no intermediate periodic records in that first minute; the
   `server-start` record is the only built-in baseline for it.
   Alternatively, copy the matching records from
   `data/server-diagnostics-YYYY-MM-DD.jsonl`. Treat the JSONL as sensitive
   runtime data and do not commit it.
3. For every sample, compare `processMemory.rssBytes`, `heapUsedBytes`,
   `heapTotalBytes`, `externalBytes`, and `arrayBuffersBytes`; sum child memory
   using `processTree.childrenRssBytes` rather than `combinedRssBytes`.
   Compare the additional V8 fields `v8.mallocedMemory`,
   `v8.peakMallocedMemory`, `v8.totalPhysicalSize`, and `v8.externalMemory`.
   `processMemory.externalBytes` and `v8.externalMemory` are related views, not
   independent values to add together.
4. Continue sampling beyond 10 minutes when the slope has not flattened. A
   high plateau is startup allocation; a sustained positive slope is the
   evidence needed to call it a leak.

Use deltas and slopes over several samples, not exact equality: GC, allocator
page release, and short-lived child processes make individual points noisy.

| Time-series pattern | Likely class | Follow-up |
| --- | --- | --- |
| `heapUsedBytes` and `heapTotalBytes` rise with server RSS across post-GC samples; heap snapshots grow in the same dominator paths | JavaScript retention | Compare heap snapshot dominators and retaining paths; identify the owning cache or listener before changing a bound |
| Server RSS rises while JS heap stays broadly flat; `externalBytes`, `arrayBuffersBytes`, `v8.externalMemory`, `v8.mallocedMemory`, or `v8.totalPhysicalSize` rises | External/native allocation or allocator fragmentation | Attribute Buffers/native owners with sampling and compare `peakMallocedMemory`; a falling live metric with flat RSS points toward fragmentation/high-water retention |
| `processTree.childrenRssBytes` rises while `processMemory.rssBytes` stays flat | Child-process growth | Use `processTree.children` to identify the PTY, harness, MCP stdio, or webpack process; profile that process, not the server heap |
| Most growth occurs between `server-start` and the first samples, then all series flatten | Startup allocation/high-water mark | Profile the boot path and measure the steady plateau; do not label it a continuing leak |
| The same metrics keep rising after 10 minutes under stable workload | Continuing leak | Capture a longer series and two comparable heap profiles before proposing a repair |

### Heap evidence

On Linux, enable the Node inspector for the already-running server with:

```sh
kill -USR1 <pid>
```

Keep the inspector bound to loopback and obtain its WebSocket URL from the
local inspector endpoint. Through Chrome DevTools Protocol (CDP), enable
`HeapProfiler` and call `HeapProfiler.takeHeapSnapshot` at approximately 30
seconds and again at approximately 10 minutes after restart. Store both output
streams outside the repository and compare dominators and retained sizes. A
useful comparison groups retained objects by constructor, then follows the
retaining paths whose retained size grew between the two captures. A
snapshot of a 3–4 GB heap can stall the event loop for a long time and needs
roughly another heap-sized amount of available memory, so do this only in a
controlled window with enough headroom. `HeapProfiler.startSampling` (followed
by `HeapProfiler.stopSampling`) is the lighter first choice when that pause or
memory overhead is unsafe, although it reports allocation samples rather than
a complete retaining graph.

### Candidate inventory, not a diagnosis

The earlier measurements below are retained-heap estimates from a copied data
set, not live proof for this incident. Each candidate remains **unverified for
the startup RSS incident** until its retaining objects or allocation samples
appear in the paired profiles.

| Candidate | Existing file and symbol | Existing evidence | Incident status |
| --- | --- | --- | --- |
| Usage day cache | `lib/persist/usage-persist.js`: `dayFileCache`, `readDayFile()` | 41 files / 87 MB on disk retained about 81 MB before the 32 MB byte cap; the earlier after measurement was about 29 MB | Unverified |
| Chat history cache | `lib/persist/chat-history-persist.js`: `historyCache`, `loadChatHistory()` | Eight large histories, 74 MB on disk, retained about 101 MB before the 48 MB byte cap; the estimated bounded result was about 65 MB | Unverified |
| Delegation row and read-only caches | `lib/persist/delegation-sqlite.js`: `parsedRowCache`; `lib/persist/delegations-persist.js`: `withRecordDefaults()`, `readonlySnapshots`, `loadDelegationsReadonly()` | 4.8k rows / 65 MB JSON retained about 90 MB, roughly doubled while frozen snapshot rows were built | Unverified |
| Chats cache and copies | `lib/persist/chats-persist.js`: `chatsCache`, `copyChats()`, `loadChats()` | A 7.6 MB chats file retained about 9 MB; repeated `copyChats()` calls add short-lived allocation churn | Unverified |
| Usage ledger load | `lib/usage/usage-ledger.ts`: `loadUsageSummary()`; `lib/persist/usage-persist.js`: `readUsageEvents()`, `readUsageLedgerState()`, `ledgerCache` | No retained-size figure was measured separately; a missing/corrupt index can rebuild from journal files, while parsed day files and the ledger read-model are cached | Unverified |

### Recommended repair leaf

The next leaf should make one bounded change to the owner demonstrated by the
profiles, with a focused regression test for its retention or invalidation
contract and a before/after restart-window comparison. It must not combine
unrelated cache caps, allocator tuning, and child-process changes. Required
live evidence before that leaf is approved: the `server-start`, first periodic
sample (about 60 seconds), and subsequent restart-window samples through at
least 10 minutes, plus comparable heap snapshots captured at about 30 seconds
and 10 minutes (or an explicitly documented sampling-profiler substitution
when full snapshots are unsafe).
