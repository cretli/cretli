# Server health metrics and stall watchdog

## In-process metrics (no inspector)

`lib/server-health/server-metrics.js` samples every 10 s and keeps rolling **1 / 5 / 15 min** windows:

| Field | Source |
| --- | --- |
| `eventLoopDelayMs.p50/p99/max` | `perf_hooks.monitorEventLoopDelay` (p50 = median of per-interval medians, p99 = worst interval p99) |
| `elu` | `performance.eventLoopUtilization()` averaged over the window |
| `gc.count`, `gc.totalMs`, `gc.busyRatio` | `PerformanceObserver` on `gc` entries |
| `allocRateBytesPerSec` | Approximation: positive heapUsed growth between samples (reclaimed memory is not visible) |
| `heapUsedBytes.last/max` | `process.memoryUsage().heapUsed` |

Where to read it:

- MCP `operator_server_status` → `metrics`.
- `host_resources.serverMetrics` (Watcher view, MCP `operator_watcher_*` payloads, `/api/health` → `load.hostResources`).
- `GET /api/diagnostics/server` → `serverMetrics` (login session; the Settings diagnostics page can render this payload).

## Stall watchdog

Unchanged trigger (heartbeat / probe → CPU profile in a worker). Reporting changed:

- **Inclusive grouping.** A profile is grouped by *cause*, not by self-time leaf: the hot code is the deepest `lib/` frame of each sample, the cause is the nearest `lib/` caller in a different file (for example `archiveFamilyMembers` calling `updateChat` in `chats-persist.js`). Leaves such as `copyChatOnWrite` or `serializedRow` under the same caller collapse into one signature. `summary.causes` carries the inclusive times; the todo body lists them first.
- **Dedupe.** The signature is the dominant cause. A repeated cause is appended to the open todo (`stall-occurrences: N` plus a changelog note) instead of opening a new one, also after a restart.
- **Daily cap.** `maxNewTodosPerDay` (default 3, UTC day, in memory) limits new todos. Beyond it the outcome is `capped`, nothing is recorded as seen, and the cause may open a todo on a later day. `getState().capped` counts them.

Benchmark: see [perf-bench.md](perf-bench.md).
