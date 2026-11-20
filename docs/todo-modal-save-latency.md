# TODO save latency: measurement and diagnosis

Scope: saving a status (or any field) from the TODO edit modal, `PATCH /api/todos/:id`.
Measure-only investigation: no optimization was made. The only production change is the
opt-in `CRETLI_TODO_TIMING=1` diagnostic (see "Live measurement procedure"); with the flag
unset behavior is unchanged. Reproduce the synthetic numbers with:

```
node scripts/measure-todo-save.js 9            # table, 9 runs per scenario (+1 warm-up)
node scripts/measure-todo-save.js 9 --json --chats=3000
```

The script builds synthetic trees in a temp dir and points `CRETLI_DATA_DIR` at it
before loading `lib/`, so the real `data/` is never read or written. Layers are
replayed by calling the persist and read-model functions directly; `e2eHttp` goes
through the real Express route over loopback HTTP (request to response).

## Request path (what a single save does)

| # | Step | Where |
|---|------|-------|
| 1 | Modal -> `api.patchTodo` (`{ status }`) | `app_front/todoPanel.js:3619-3633`, `app_front/api.js:1110` |
| 2 | Review-gate check (loads watcher row, maybe todos) | `lib/routes/todos-routes.js:574`, `lib/workspace-watcher-review-gate-guard.js:105` |
| 3 | `updateTodo` under the cross-process SQLite lock | `lib/persist/todos-persist.js:1304`, `lib/persist/workspace-watchers-persist.js:3025` |
| 3a | `loadTodosData` (cache hit by file signature, else full parse + normalize + parent-status sync) | `lib/persist/todos-persist.js:846` |
| 3b | `saveTodosData`: loads the previous doc again for the watcher nudge, re-syncs parent statuses, `persist` drops the cache and writes the whole document pretty-printed | `todos-persist.js:1022`, `:994-995`, `lib/persist/atomic-write.js:18` |
| 3c | status `done` only: `handleTodoLeafMaterialOnStatusChange` -> checkpoint (git or file manifest) -> a second `updateTodo` | `todos-persist.js:1565`, `lib/todo-leaf-material.js:757,547` |
| 4 | Reload the doc after the write (cache was just dropped, so a full re-parse) | `todos-routes.js:605` |
| 5 | `jsonTodosPayload`: `loadChats()`, chat index, per-item plan-file hydration, review/integration read models, worktree summaries, batch eligibility, slimming | `todos-routes.js:206-220`, `lib/todo-source-chat.js:185,214` |
| 6 | Client: `renderList(data)` re-renders the full tree; other list refreshes follow on `cretli:todo-changed` | `app_front/todoPanel.js:1980`, `:3946` |

Commit `ccd79a64` (todo list keyed by workspace) only changes how the workspace
folder/home is resolved (`todoWorkspaceScope.js`, `todosCwd`); it adds no work per
save. The PATCH handler is unchanged by it, so it is not a plausible regression
source for save latency (not benchmarked before/after; judged from the diff).

## Measured server-side layers

Median / p95 in ms, 9 runs per scenario after one warm-up, 3000 synthetic chats
in `chats.json`, no contention (output of
`node scripts/measure-todo-save.js 9 --json --chats=3000`). Machine: WSL2, Node 22.

| Layer | small (3 items) | large body/plan (3 items, 252 KB doc) | wide (31 items) | wide+large (61 items, 271 KB doc) |
|-------|-----------------|---------------------------------------|-----------------|-----------------------------------|
| review gate | 0.03 / 0.07 | 0.04 / 0.05 | 0.03 / 0.04 | 0.03 / 0.04 |
| `updateTodo` (lock + load + save) | 0.30 / 0.40 | 0.93 / 1.13 | 0.31 / 0.34 | 0.97 / 1.14 |
| reload after write | 0.07 / 0.11 | 1.30 / 1.38 | 0.14 / 0.15 | 1.47 / 1.55 |
| `loadChats` (cache miss) | 2.06 / 3.30 | 1.99 / 2.33 | 1.80 / 1.91 | 1.92 / 2.35 |
| chat index + plan hydration | 1.58 / 3.69 | 4.26 / 4.55 | 1.31 / 2.25 | 4.42 / 5.36 |
| review/integration read models | 0.09 / 0.15 | 0.10 / 0.11 | 0.11 / 0.13 | 0.19 / 0.27 |
| batch eligibility | 0.07 / 0.13 | 0.08 / 0.09 | 0.12 / 0.18 | 0.28 / 0.31 |
| JSON serialize (response 3 KB / 67 KB / 30 KB / 122 KB) | 0.01 / 0.02 | 0.22 / 0.25 | 0.04 / 0.05 | 0.30 / 0.34 |
| **end-to-end PATCH over HTTP** | **4.12 / 6.09** | **9.82 / 10.62** | **2.92 / 4.06** | **10.47 / 11.03** |

Extra measurements:

| Case | Result |
|------|--------|
| Lock held by another process for 400 ms, then `updateTodo` | 389.3 ms p50 / 390 ms p95 (the call simply waits out the holder; synthetic, not observed in production) |
| `done` in project mode: `captureProjectLeafManifestWithMeta` on this repo (2491 tracked files) | 51 ms median of 5 (47-239 ms) |
| `done` in worktree mode: `createWorktreeLeafCheckpoint` (5+ synchronous `git` execs, `reset --hard`) | not measured here (needs a real worktree); expect tens to hundreds of ms plus repo size |

## Measured facts vs. hypotheses

### Measured facts (synthetic script, uncontended)

- For every tree shape, including 61 items / 60 children, the full PATCH is
  about 3-10 ms p50 and about 4-11 ms p95 over loopback HTTP. Persistence
  (`updateTodo`) is at most about 1 ms; the payload build (chat enrichment, read
  models, serialize) is at most about 6 ms.
- The document is one JSON file per workspace, written whole and atomically
  (`todos-persist.js:994-995`); cost is linear in size but small at these sizes.
- If a caller holds the shared lock for 400 ms, `updateTodo` takes 389 ms: the
  wait equals the hold time. This is a synthetic experiment that proves the
  *mechanism* exists; it does not show that the lock is held that long in a
  real session.

### What this does NOT establish

No live profile of the reported delay exists yet. The offline numbers rule out
the persistence code and the payload build *on synthetic trees without
`leafMaterial` manifests and without watcher activity*; they do not identify
what the user actually waits on.

### Ranked hypotheses (leading first)

1. **Lock contention (leading hypothesis).** `withWorkspaceWatchersFileLock`
   (`workspace-watchers-persist.js:3025`) takes a SQLite `BEGIN IMMEDIATE`
   (`:2938`) and, while busy, sleeps with `Atomics.wait` (`:2916`, backoff
   2 -> 50 ms) for up to `WORKSPACE_WATCHERS_LOCK_TIMEOUT_MS = 5000` (`:187`).
   The lock is global for the data dir (not per workspace) and shared by all
   todo writes, watcher ticks, review writes and delegation bookkeeping (22 call
   sites). The wait blocks the server's only JS thread, so all other requests
   freeze for the same time. Support: only the synthetic 400 ms experiment above
   and code reading. Leading because it is the only mechanism found that can
   reach hundreds of ms to seconds; unconfirmed live.
2. **Oversized list response from `leafMaterial` manifests.** The PATCH response
   embeds the full list, and each checkpointed leaf carries per-file hash
   manifests (`baseManifest`, `lastCheckpoint.manifest`; roughly 100-250 KB per
   leaf for a 2.5k-file repo, estimated from code, not measured here). With >20
   checkpointed children that is multiple MB to build, send and parse. Synthetic
   trees have no manifests, so the table does not cover it. Recommended
   follow-up optimization (leaf 2): slim `leafMaterial` in the list response
   (`slimTodoForList`, `todos-routes.js`), after measuring payload size on a real
   store.
3. **`done` checkpoint.** `done` triggers a checkpoint and a second
   `updateTodo` (`todos-persist.js:1565`); in worktree mode this runs several
   synchronous `git` processes (`lib/worktree/git-worktree.js:216-247`).
   Project-mode manifest capture measured 51 ms median on this repo (5 runs,
   47-239 ms); worktree mode was not measured. Only affects `done`, not other
   statuses.
4. **Client rendering.** `renderList` rebuilds the whole tree for every save
   (`app_front/todoPanel.js:1980`); not profiled.
5. **`loadChats()` re-parse** (`lib/persist/chats-persist.js:123`): about 2 ms
   at 3000 chats; only a very large store would matter.

Ruled out by measurement (synthetic): storage format, status recompute, request
count (a save is one PATCH; the list comes back in its response).

### Live measurement procedure (to confirm or reject hypothesis 1)

1. Start the server with `CRETLI_TODO_TIMING=1` (e.g.
   `CRETLI_TODO_TIMING=1 npm start`).
2. In the UI open a TODO with many children, edit its status in the modal and
   save; repeat with `done` and with a non-`done` status, ideally while the
   watcher or a delegation is active.
3. Read the server log. Each `PATCH /api/todos/:id` prints one line:
   `[todo-timing] PATCH /api/todos/<id> status=200 total=<ms> lockWait=<ms> lockHold=<ms> locks=<n>`.
   `lockWait` is time spent waiting to acquire the cross-process lock (summed over
   outermost acquisitions, which `done` can make more than one), `lockHold` is
   time spent inside the critical section (load + write + checkpoint), and
   `total` is request to response `finish`.
4. Interpretation: `lockWait` close to `total` confirms lock contention;
   `total` large with small `lockWait` and small `lockHold` points to payload
   build/response size (hypothesis 2, compare with the browser's network panel);
   large `lockHold` on `done` points to the checkpoint (hypothesis 3); small
   `total` with a slow UI points to the client (hypothesis 4).

The flag is read per request, adds no work when unset, and the timing code is in
`takeWatcherLockTimings` (`workspace-watchers-persist.js`) and the PATCH handler
(`todos-routes.js`).

## Target check

Proposed target: status save <= 300 ms p50 and <= 800 ms p95 server-side
(request to response) for a TODO with more than 20 children.

- **Uncontended: confirmed and very conservative.** Measured 2.9 ms p50 / 4.1 ms
  p95 (31 items) and 10.5 / 11.0 ms (61 items with 8 KB body, 32 KB plan, 100
  changelog entries). The target holds with a >10x margin.
- **Contended: the target is not met by design (if contention occurs).** p50 = hold time of the
  competing writer; the lock timeout allows up to 5000 ms, so p95 <= 800 ms is
  only true if lock holders stay shorter than ~800 ms.
- **Correction proposed:** keep 300 / 800 ms as the contended-case budget, but
  also add a tighter uncontended budget (<= 50 ms p50, <= 150 ms p95) so
  regressions in the persist/payload code are caught; the contended case is now
  observable via `CRETLI_TODO_TIMING=1` before any change to the lock.

## Limits of this measurement

- Synthetic trees, empty watcher/worktree registries, SSD-backed temp dir.
- Layer timings are sequential replays; `e2eHttp` is the authoritative total.
- No browser profile: client rendering and network transfer are not included.
- Git-based `done` checkpoint in worktree mode was not run.
- Live lock contention was not observed; use the flag-based procedure above.

## Leaf 2: narrowed write path (before / after)

Changes (no contract change; stored data and `lib/shared-types/todo-records.ts` untouched):

- `slimTodoForList` now drops `leafMaterial.baseManifest` and
  `leafMaterial.lastCheckpoint.manifest` from the list and PATCH responses
  (replaced by `baseManifestPaths` / `lastCheckpoint.manifestPaths` counts). No
  client reads them; server logic reads the stored todo. The PATCH `item` field
  is slimmed the same way.
- `persist` keeps the todos cache coherent after a write (it stores the written
  document keyed by the new file signature) instead of dropping it, so the
  `loadTodosData` calls that follow a save no longer re-parse the file.
- The PATCH route reuses the document returned by `updateTodo` when the file is
  untouched since the write (`isTodosDocCurrent`); it reloads only when the
  review-gate bookkeeping, the `done` checkpoint or a plan review sync wrote the
  file afterwards.
- CAS (`expected_updated_at` -> 409 `CONFLICT`), parent status derivation, the
  MCP `todo_update` contract and the server-owned `review` field are unchanged.
  The pretty-printed on-disk format is unchanged.

Measured with `node scripts/measure-todo-save.js 15 --chats=3000` (same machine,
p50 / p95 ms; before = previous revision of the two changed lib files). The new
`wide+manifests` scenario has 30 checkpointed children with two 2500-path
manifests each (12 MB document).

| Scenario | e2e PATCH before | e2e PATCH after | response before | response after |
|----------|------------------|-----------------|-----------------|----------------|
| small (3 items) | 3.58 / 4.58 | 3.35 / 3.87 | 3.3 KB | 3.3 KB |
| large body/plan (3 items) | 9.46 / 10.76 | 7.80 / 8.54 | 67 KB | 67 KB |
| wide (31 items) | 3.33 / 4.35 | 2.76 / 3.81 | 30 KB | 30 KB |
| wide+manifests (31 items, 12 MB doc) | 144.75 / 161.51 | 42.80 / 50.65 | 10.3 MB | 35 KB |
| wide+large (61 items) | 10.30 / 11.82 | 8.23 / 13.11 | 122 KB | 122 KB |

The reload layer after a write drops from 0.06-80 ms to 0.02-0.07 ms (cache hit).
The remaining cost on the manifest-heavy store is the 12 MB read-modify-write in
`updateTodo` itself (about 33 ms p50), which stays because the stored data format
is unchanged. All server-side p50/p95 are far inside the 300 ms / 800 ms budget
for a TODO with more than 20 children (uncontended); lock contention is unchanged
(see "Target check").
