# S2: event bus, WS push and incremental read models — stage 1

Goal of the todo: stop the polled read paths from rescanning all chats, and move the UI and the
Watcher to events. This first stage is deliberately small: **measure, fix the worst offender**.

## Measurement method

`node scripts/bench-read-models-s2.mjs --size 2000 --samples 100 [--profile full|smoke]`

- Builds an isolated data dir under `os.tmpdir()` (never `data/`) with
  `scripts/architecture-http-fixture.mjs` (2000 chats, 24 workspaces, 400 todos, 600 delegations).
- Calls the functions behind the polled routes directly, one background write (a history revision bump)
  between samples, and reports p50 / p95 / max per call plus event-loop delay p99
  (`perf_hooks.monitorEventLoopDelay`, 1 ms resolution). Single-threaded synchronous CPU is what blocks
  the loop, so per-call wall time is the stall each call imposes.
- Profiled with `node --cpu-prof` to find the self-time owner.

## Findings (HEAD, 2000 chats)

| Function (route) | p50 ms | p95 ms |
| --- | --- | --- |
| `getChatHistoryRevisions` (history-revisions) | 0.1 | 0.2 |
| `summarizeChatRunStatesAsync` (agent-states) | 1.1–1.4 | 1.4–2.2 |
| `listNotifications` (notifications) | 0.04 | 0.2 |
| **Watcher view, uncached compute** (`/api/workspace-watcher`, Watcher tick snapshot) | **19.8** | **22.7** |

history-revisions, agent-states and notifications are already index/cache backed and cheap. The
Watcher snapshot is the offender: the CPU profile showed ~85% of its time in `fs.realpathSync`, called
from `listWorkspaceChatsForSnapshot`, which canonicalized the `workspaceFolder` of **every chat** (twice per
chat) on every snapshot. The realpath cache holds 256 entries and never caches failures (deleted worktree
paths), so it did not save it. The same snapshot runs on every Watcher tick and on every
`/api/workspace-watcher` cache miss (2 s TTL), once per cycle/workspace.

## Change

- New read model `lib/workspace-chat-index.js`: chats grouped by raw `workspaceFolder`, built once per
  chats snapshot. A snapshot now canonicalizes only the distinct folders (O(workspaces), not O(chats)).
- `listWorkspaceChatsForSnapshot` (`lib/workspace-watcher.js`) uses it over `peekChatsAsync()` (read-only
  shared rows, no per-call copy of the whole list).
- **Invalidation:** the index is keyed by the identity of the rows array. Every chats write replaces that
  array in `chats-persist`, so a new/removed/moved/pinned chat can never be served stale; no writer needs to
  call anything. The canonical key is still computed per call, so symlink re-pointing keeps the existing
  30 s realpath TTL semantics.

## After (same bench)

| Function | p50 ms | p95 ms |
| --- | --- | --- |
| Watcher view, uncached compute | **1.0–1.1** | **2.1–2.2** |

~19x lower p50, ~10x lower p95 (event-loop p99 23.7 → 3.4 ms; the remaining max is first-call warm-up).
Tests: `tests/workspace-chat-index.test.js` (grouping, once-per-folder canonicalization, reuse, and
no-stale-read after add / move / pin writes through the real chats store).

## Not measured / caveats

This is a single-process micro-bench, not the 20-cycle HTTP load from the acceptance criterion. Routes
`/api/chats`, `/api/chats/:id/diag` and POST `history-batch` were not profiled in this stage.

## Next stages (recommended order)

1. HTTP load run with 20 simulated cycles (extend `scripts/architecture-mixed-load.mjs`) to get route p95s
   and find the next offender (`/api/chats`, `diag`, `history-batch`).
2. Replace the 2 s TTL in `getWorkspaceWatcherView` with event invalidation: emit from delegation writes,
   chat-run state changes and usage-limit changes (build on `chat-list-updates.js` /
   `agent-presence-bus.js`), keeping the TTL only as a safety net.
3. Push `workspace-watcher` view diffs and history revisions over the existing chat-list WS instead of UI
   polling (revision-based diffs).
4. Make the Watcher tick react to liveness / delegation-end events instead of scanning all chats per tick.
5. Maintain agent-states incrementally (per-chat dirty set) so the "all chats" read is O(changes).
