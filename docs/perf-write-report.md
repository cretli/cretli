# Synchronous write cost report

Goal: find out whether frequent synchronous JSON writes (`writeJsonAtomic`,
`writeTextAtomic`, the usage `ledger-index.json` writer) explain event-loop
stalls and slow `GET /api/chats` / `GET /api/chats/agent-states`.

## How to read the data

The server counts every atomic write in memory (`getWriteStats()` in
`lib/persist/atomic-write.js`) and flushes the aggregates every 5 minutes as a
`write-stats` entry in the daily server diagnostics file
(`server-diagnostics-YYYY-MM-DD.jsonl` in the data directory), also visible via
`GET /api/diagnostics/server`. Each row has `key` (normalized path; hash
segments become `*`), `writes`, `bytes`, `stringifyMs`, `ioMs`, `maxMs`,
`writesPerMin`. Let the server run 30-60 minutes under normal load, then
aggregate the entries per key.

| File key | Size | Writes/min | ms per write |
| --- | --- | --- | --- |
|  |  |  |  |

## CPU profile of the chat list routes

Run `node --cpu-prof --cpu-prof-dir=<dir> server.js`, exercise
`GET /api/chats` and `GET /api/chats/agent-states` for a few minutes, stop the
server, and open the `.cpuprofile` in DevTools. If writes do not explain the
stalls, open a separate todo for the chat list builder.

## Candidate follow-ups (only after data)

- Debounced, coalesced writes of hot files with durability on shutdown.
- Moving heavy serialization to a worker.
- Append-only journals instead of rewriting whole files.

## Coalesced history writes

`workspace-watcher-cycles.json` is written at most five seconds after the first
pending change. Calls during that fixed window replace the pending in-memory
value and increment the in-memory `getWriteStats()` row's `coalesced` counter. Graceful shutdown and
all JavaScript `process.exit()` paths synchronously flush pending values. A
SIGKILL, OOM kill, power loss, or native crash can lose at most that five-second
history window. Set `CRETLI_COALESCED_WRITES=0` to restore immediate writes.

This policy is deliberately limited to reproducible history:

| Store | Writers and readers | Concurrency contract | Decision |
| --- | --- | --- | --- |
| `workspace-watcher-cycles.json` | Workspace-watcher modules in the main server; reads use the same persistence module | One writing process; the shared watcher lock serializes its in-process read-modify-write with watcher-row work | Coalesced; an authoritative per-path memory document serves reads until flush |
| `model-pick-decisions.json` | Model-pick policy and diagnostics routes | File lock protects read-modify-write across possible processes | Excluded; remains immediate |
| `context-send-manifests.json` | Chat context manifest and route code | Existing in-memory cache plus snapshot/journal persistence | Excluded; it already has a purpose-built persistence strategy |
| `workspace-watchers.json`, todos, leases, and other authoritative state | Main server and delegated/worker paths depending on store | Locks, CAS fields, or multiple writers | Excluded; remains immediate |

For a manual coalescing measurement, reset write stats, issue 100 cycle metric
mutations within five seconds, call `flushWorkspaceWatcherCycleMetrics`, and
inspect the `workspace-watcher-cycles.json` row: it should report one physical
write and 99 coalesced calls. Use a temporary `dataDir`, never the live data
directory.

## Instrumentation overhead

`node tests/atomic-write-bench.manual.js` (median of 15 writes of ~10 MB):
counters on vs off differed by ~0.08% (14.70 ms vs 14.69 ms).

See also [perf-scout-pass.md](perf-scout-pass.md) for the Scout pass phase timings.
