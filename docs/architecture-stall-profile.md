# Stall profile per blocking site (stage 6, V6 + V8)

Deliverable of stage 6 (leaf `ef0304e6`) **before any code change**. Source of the candidate list:
[architecture-baseline.md](architecture-baseline.md) §4.3 / [architecture-sync-io-inventory.json](architecture-sync-io-inventory.json)
(counts of *potential* blocking sites — not measured stalls). This document measures the sites that can be driven
without external services and records everything else as **not measured** with a reason.
Machine-readable result: [architecture-stall-profile.json](architecture-stall-profile.json).

## How it was measured

- Script: `scripts/architecture-stall-profile.mjs` (deterministic fixture seed `20261017`, profile `full`).
  Everything runs in a **child process whose `CRETLI_DATA_DIR` is a fresh directory under `os.tmpdir()`**; the child refuses to start when the
  data directory is inside the repository `data/` (covered by `tests/architecture-stall-profile.test.js`). The repository `data/` is never read or written.
- Per site: `callMs` = wall time of each synchronous call (this *is* the stall the call imposes on the event loop) and `eventLoopMs` =
  `perf_hooks.monitorEventLoopDelay` at **1 ms** resolution over the whole site window (the resolution required by
  [storage-gates.md](storage-gates.md)). Between calls the loop is yielded (`setImmediate`) so the sampler observes each stall.
- Idle floor at 1 ms sampling on this machine: P50 1.091 / P99 1.27 / max 1.58 ms (read event-loop numbers against it).
- P99 is labelled **stable only from n >= 1000**; rows marked `*` (n < 1000) are **exploratory** and their verdict is `(exploratory)`.
- Thresholds ([storage-gates.md](storage-gates.md) "Event loop"): event-loop **P99 <= 25 ms, max <= 100 ms** (1 ms sampling). A site `exceeds`
  when its call P99 > 25 ms, call max > 100 ms or window event-loop max > 100 ms.
- Environment: Node v24.14.0, linux (WSL2), commit `5970c63e41b7` (+ uncommitted work), single run of ~38.3 s.

Reproduction:

```bash
node scripts/architecture-stall-profile.mjs --profile full --out docs/architecture-stall-profile.json   # ~40 s
node scripts/architecture-stall-profile.mjs --profile smoke --out /tmp/stall-smoke.json                  # ~3 s
node --test tests/architecture-stall-profile.test.js
```

Fixture (shared with the HTTP baseline): 5000 chats, 24 workspaces, 30000 history events,
400 todos, 600 delegations; plus 3 000 mailbox rows for the tick, a 3 000-file git repository with 20 dirty files,
and Files trees of 1 000 / 5 000 / 20 000 entries.

## Results (measured sites)

`callMs` columns in ms. `requestPath`: `yes` = reachable from an HTTP/WS request or a per-run path, `no` = background/explicit action,
`contention-only` = runs only when a *second process* holds a lock, `startup` = boot/ownership probe.
**The `V5-*` rows are the PRE-FIX baseline** measured with the old whole-mailbox tick reader (`loadMailboxMessages()`). The tick now calls
`listMailboxByStatus(['queued', 'dispatching'])`; the numbers below are kept as the before/after reference and are **not** current-tick measurements —
a fresh profiler run is needed for post-fix numbers (finding 6).

| Site | Owner | Request path | n | P50 | P95 | P99 | max | Event loop P99 / max | Verdict |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `AW-child-process-registry-uncontended` | stage-6 | yes | 1000 | 0.277 | 0.389 | 0.519 | 0.757 | 1.39 / 1.538 | within |
| `AW-child-process-registry-contended` | stage-6 | contention-only | 20 | 51.36 | 52.645 | 53.017 * | 53.017 | 53.117 / 53.608 | exceeds (exploratory) |
| `AW-opencode-port-registry-uncontended` | stage-6 | no | 1000 | 0.259 | 0.379 | 0.6 | 1.143 | 1.383 / 1.663 | within |
| `AW-opencode-port-registry-contended` | stage-6 | contention-only | 20 | 51.126 | 52.468 | 52.84 * | 52.84 | 52.462 / 53.936 | exceeds (exploratory) |
| `AW-usage-ledger-uncontended` | stage-6 | yes | 1000 | 7.415 | 11.952 | 13.848 | 16.22 | 13.894 / 16.269 | within |
| `AW-owner-lock-socket-probe` | R3 | startup | 20 | 80.44 | 80.671 | 80.688 * | 80.688 | 80.937 / 80.937 | exceeds (exploratory) |
| `SC-git-cli-status` | stage-6 | yes | 200 | 3.446 | 10.184 | 10.811 * | 11.004 | 10.854 / 11.043 | within (exploratory) |
| `SC-git-cli-is-repo` | stage-6 | yes | 200 | 1.479 | 2.262 | 3.738 * | 4.298 | 3.785 / 4.395 | within (exploratory) |
| `SC-worktree-run-git-status` | stage-6 | yes | 200 | 3.216 | 3.887 | 4.165 * | 4.563 | 4.188 / 4.616 | within (exploratory) |
| `SC-worktree-dirty-paths` | stage-6 | no | 200 | 3.046 | 3.637 | 3.899 * | 4.061 | 3.957 / 4.09 | within (exploratory) |
| `SC-material-revision` | stage-6 | yes | 200 | 4.732 | 5.516 | 6.073 * | 13.442 | 6.099 / 13.468 | within (exploratory) |
| `SC-metrics-git-snapshot` | stage-6 | yes | 200 | 7.428 | 10.421 | 11.747 * | 12.961 | 11.796 / 13.009 | within (exploratory) |
| `FS-chats-load-copy` | A3b | yes | 1000 | 0.446 | 0.487 | 0.554 | 0.829 | 1.421 / 1.829 | within |
| `FS-chats-update-one` | A3b | yes | 300 | 7.748 | 10.285 | 11.262 * | 14.224 | 11.297 / 14.262 | within (exploratory) |
| `FS-write-json-atomic-large` | other | yes | 200 | 3.618 | 4.274 | 6.043 * | 6.796 | 6.062 / 6.828 | within (exploratory) |
| `FS-todos-add` | A4 | yes | 300 | 1.291 | 1.691 | 2.013 * | 4.892 | 5.415 / 6.59 | within (exploratory) |
| `FS-todos-load` | A4 | yes | 300 | 0.022 | 0.03 | 0.044 * | 0.075 | 1.06 / 1.06 | within (exploratory) |
| `FS-delegation-create-sqlite` | A2 | yes | 300 | 0.09 | 0.261 | 10.56 * | 15.593 | 16.564 / 16.564 | within (exploratory) |
| `V5-tick-load-mailbox` | A4 | no | 300 | 3.972 | 4.427 | 4.812 * | 5.49 | 4.94 / 6.382 | within (exploratory) |
| `V5-tick-full` | R15 | no | 100 | 12.262 | 13.921 | 18.935 * | 19.053 | 19.087 / 19.677 | within (exploratory) |
| `V8-files-list-1000-entries` | stage-6 | yes | 200 | 1.575 | 1.742 | 2.767 * | 2.907 | 2.781 / 3.234 | within (exploratory) |
| `V8-files-list-5000-entries` | stage-6 | yes | 200 | 8.754 | 9.956 | 11.174 * | 11.747 | 11.215 / 11.788 | within (exploratory) |
| `V8-files-list-20000-entries` | stage-6 | yes | 200 | 38.962 | 45.079 | 47.281 * | 47.795 | 47.743 / 48.267 | exceeds (exploratory) |
| `V8-files-read-1mib` | stage-6 | yes | 500 | 0.397 | 0.494 | 2.359 * | 2.562 | 2.935 / 3.353 | within (exploratory) |
| `V8-pty-ws-input-message` | stage-6 | yes | 5000 | 0 | 0 | 0.001 | 0.032 | 1.029 / 1.029 | within |
| `V8-pty-output-broadcast` | stage-6 | yes | 5000 | 0.006 | 0.007 | 0.011 | 0.064 | 2.138 / 2.138 | within |
| `V8-browser-session-lifecycle` | stage-6 | yes | 300 | 0.021 | 0.071 | 0.158 * | 0.196 | 1.019 / 1.019 | within (exploratory) |
| `V8-browser-describe-elements-200` | stage-6 | yes | 300 | 0.004 | 0.009 | 0.029 * | 0.074 | 0.001 / 0 | within (exploratory) |

\* exploratory (n < 1000).

## Reading

1. **Only one measured, stage-6-owned site exceeded the thresholds on a request path: the Files directory listing with 20 000 entries**
   (`lib/routes/files-routes.js` -> `lib/files-list.js`). Before the fix it measured P50 84 / P99 90 / max 96 ms with an event-loop max of
   101.8 ms (> 100 ms gate); n = 200, so exploratory (see `referenceMeasurements` in the JSON). A microbenchmark of the same listing
   split the cost into `readdirSync` 6 ms + `statSync` x 20 000 30 ms + **sort 56 ms**, because `String#localeCompare(b, undefined, options)` builds a
   collator on every comparison. Stage 6 replaced it with one shared `Intl.Collator` (identical ordering, proven by
   `tests/files-list-order.test.js`). After the fix: P50 39 / P99 47 / max 48 ms, event-loop max 48 ms — **below the 100 ms max gate but still above the
   25 ms P99 budget at 20 000 entries in a single directory** (exploratory). 5 000 entries: 9 / 11 ms (within). The remaining cost is `readdirSync` +
   `statSync` per entry; removing it needs an async/chunked listing (not implemented, see "Remaining").
2. **Atomics.wait sites**: the *uncontended* paths of the stage-6 registries never reach `Atomics.wait` and cost 0.3–0.6 ms (child-process registry, run on every
   PTY/agent spawn) and 7–14 ms (usage ledger commit: journal append + index persist, the real cost is synchronous fs, not the lock). The *contended* paths
   block the thread for the holder's critical section rounded up to the 25 ms poll step (~51 ms for a 40 ms hold) — but they can only occur with a
   **second process** touching the same registry (second server instance, CLI), because a single-threaded process cannot contend with itself. They stay
   `exceeds (exploratory)` as a documented property of the design; removing the sync wait needs an async lock, a larger change than the measured
   benefit justifies (not on the single-instance request path).
3. **R3 finding (read-only, reported to the recovery owner, not changed):** `lib/delegation-owner-lock.js` `isLockSocketLive` blocks the thread for its full
   80 ms `Atomics.wait` while waiting for a `net` `connect` callback that can never run on the blocked thread. Probed against a socket that **is
   listening in another process** it returned *not live* on every call (`observed.reportedLive`
   = 0 of 23 calls). So the
   "socket liveness wins" rule in `isStoredOwnerLive` cannot hold and each call costs a guaranteed 80 ms stall. It runs at ownership acquisition (startup), not
   per request. Owner: recovery R3 — requires a recovery decision, **not changed here**.
4. **Git helpers** (sync `execFileSync`/`spawnSync`): 1.5–7 ms P50, P99 4–12 ms on a 3 000-file repository with 20 dirty files — within the thresholds
   (exploratory). They scale with repository size (status walks the tree); the per-request multiplier is the number of `git` calls
   (`git-routes.js` issues 3–4 `spawnSync` per request, `captureGitSnapshot` 3). No stage-6 change is justified by this profile; huge repositories remain an open
   scaling risk, **not measured here**.
5. **Hot sync fs** (chats/todos/delegation writers): `updateChat` at 5 000 chats P50 7.7 / P99 11 ms (rewrites the whole `chats.json`), todo add 1.3 ms,
   main-thread SQLite delegation create P50 0.09 ms with P99 10.6 / max 15.6 ms (WAL checkpoint/fsync tail). All within thresholds today; **ownership is storage**
   (A3b/A4/A2) so they are not touched.
6. **V5 runtime tick** (`tickDelegationRuntime`, every 5 s; R15 scheduler policy untouched). The V5 numbers in the table are the **PRE-FIX baseline**: with
   600 delegations, 3 000 mailbox rows and 5 000 chats the whole tick cost P50 12 / max 19.7 ms (exploratory) — within. That tick called
   `loadMailboxMessages()`, which reads the **whole mailbox (all statuses)** every tick (~4 ms at 3 000 rows; linear extrapolation ~40 ms at 30 000 rows
   would exceed the 25 ms P99 — an extrapolation, **not measured**). The tick now calls `listMailboxByStatus(['queued', 'dispatching'])`. On the JSON backend the
   status predicate still scans every cached row, and a cold read (cache miss or changed file) still parses the whole file, but the filter runs before the rows
   are copied, so the tick stops **cloning** non-matching (delivered) rows — the predicate scan itself remains O(cached rows). On SQLite the selection is served
   by the `(status, created_at)` index, so there the read no longer scales with delivered history. **Post-fix numbers are not measured — a fresh profiler run
   is required**; the committed JSON still carries the pre-fix row (the profiler script now re-measures `V5-tick-load-mailbox` with the new reader and adds
   `V5-tick-load-mailbox-baseline` for the old whole-mailbox reader).
   The remaining V5 read is `listQueuedRecipientIds`, which calls `loadChats()` (full copy of N chats + a Set) every tick even when no mail is queued.
   `listActiveDelegations()` is already limited to tick-relevant rows (`tick_relevant` column on SQLite, active index on JSON).
   **Do the stage-1 request-local chat index and the `loadChats` copies still matter for the tick?** The request-local index removes the *per-request lookups x copy*
   multiplier; the tick performs a **single** `loadChats()` per interval, so the index would not help it. The copy itself is linear (0.45 ms P50 at 5 000 chats,
   `FS-chats-load-copy`), i.e. ~0.01 % duty at a 5 s interval — it matters only as a minor O(N) cost that can be avoided by skipping `loadChats()` when the mailbox
   has no queued row (an A4/R15-coordinated tick change; recorded as blocked, not implemented).
7. **V8 Files / Terminal / Browser (Cretli overhead only):** PTY ws `input` frame handling 0.000 ms (n = 5 000, stub pty), PTY output
   broadcast 0.006 ms per 4 KiB chunk with a 64 KiB ring buffer and per-client backpressure skip; Browser session create/list/close bookkeeping with a fake
   driver 0.02 ms P50 / 0.2 ms max; `describePageElementsBatch` of 200 synthetic nodes 0.004 ms (a Node-side proxy only: the real scan runs inside the page);
   Files read of a 1 MiB file 0.4 ms P50 / 2.7 max; Files list see item 1. All within the thresholds. **Not measured** (external, excluded from Cretli overhead): Chromium
   launch/navigation/screenshot, real shell/PTY spawn and output latency.

## Not measured

| Id | Owner | Site | Reason |
| --- | --- | --- | --- |
| `AW-delegation-sqlite-busy-retry` | A2 | lib/persist/delegation-sqlite.js:118 (busy retry, 50 ms Atomics.wait) | Storage-owned (A2 4fb174ca removes it with the sqlite-worker). Runs only when another process holds the SQLite database busy during open/migrate; by construction one 50 ms block per retry. Not driven here to avoid touching a storage-owned file path. |
| `AW-workspace-watchers-lock-backoff` | A4 | lib/persist/workspace-watchers-persist.js:2916 (lock backoff, caller ms) | Storage-owned (A4 6e483edd). Private sleep helper reached only under cross-process lock contention; not exported, not driven. |
| `AW-model-pick-decisions-lock-backoff` | A4 | lib/persist/model-pick-decisions-persist.js:51 (lock backoff, caller ms) | Storage-owned (A4/A5). Private sleep helper reached only under cross-process lock contention; not exported, not driven. |
| `SC-tool-executor` | stage-6 | lib/agent-harness/tool-executor.ts:320,333 spawnSync fallback | Runs the model-requested shell command; duration is the external operation itself, not Cretli overhead. |
| `SC-chats-routes-agent-cli` | stage-6 | lib/routes/chats-routes.js:1274 spawnSync(agent CLI create-chat) | Requires the external agent CLI; time is dominated by the external binary. |
| `SC-fork-title` | stage-6 | lib/fork-title.js:127,174 spawnSync(agent CLI) | Requires the external agent CLI. |
| `SC-codex-logout` | other | lib/codex/codex-device-login.js:182 spawnSync(codex logout) | Requires the external codex CLI; manual user action. |
| `SC-zai-probe` | other | harnesses/zai/zai-sdk-runtime.js:26 spawnSync(python -c import zai) | Requires python + zai package; cached capability probe. |
| `SC-sdk-history-isolation-probe` | other | lib/sdk/sdk-history-isolation-probe.ts:492 spawnSync(node fork CLI) | Requires the cursor SDK fork CLI; probe, not a request path. |
| `SC-self-update` | other | lib/self-update.js:269 spawnSync(git) | Manual self-update action against the real checkout; not driven against the repository. |
| `SC-shutdown-origin` | stage-6 | lib/shutdown-origin.js:47 execFileSync(ps) | Runs once during shutdown (bounded by PS_TIMEOUT_MS); not a steady-state path. |
| `SC-secret-scan` | other | lib/secret-scan.js:74 execFileSync(git) | Run on explicit commit/scan actions. |
| `SC-todo-integration-proof` | stage-6 | lib/todo-integration-proof.js:63,116 execFileSync(git) | Integration-proof confirm action only; two git calls per explicit user/orchestrator action. |
| `SC-patch-scope` | stage-6 | lib/worktree/patch-scope.ts:127 execFileSync(git apply --numstat) | Smart-merge patch analysis; per integration action. |
| `SC-workspace-scout-git` | stage-6 | lib/workspace-scout-git.js:34 / lib/workspace-watcher-scout.js:315 execFileSync | Scout scans run on the Watcher schedule, not per request. |
| `SC-worktree-snapshot-commit` | stage-6 | lib/worktree/git-worktree.ts:184-239 createDirtyTreeSnapshot / createWorktreeLeafCheckpoint (execFileSync commit-tree) | Mutating (writes git objects); per todo start / leaf PASS, off the request path of normal reads. Not driven to avoid mutation helpers in the profile. |
| `V8-browser-chromium-launch-navigate` | stage-6 | Chromium launch / navigation / screenshot capture | External operation (browser process); by definition excluded from Cretli overhead. |
| `V8-terminal-real-shell` | stage-6 | Real PTY spawn + shell output latency | node-pty spawn of a real shell is an external process; excluded. PTY spawn registration cost is covered by AW-child-process-registry-uncontended. |

Additional gaps: the real browser panel/WS paint path, a 10-minute mixed run with 3–5 streams + Watcher (stage 8), memory/listener/timer/subprocess check after
20 cycles (stage 8), and git helpers on very large repositories.

## Ownership summary (who may change what)

| Site group | Owner | Stage 6 action |
| --- | --- | --- |
| `delegation-sqlite.js` busy retry, main-thread delegation SQLite | A2 `4fb174ca` (ready, integration unconfirmed) | none; consume the sqlite-worker when it lands |
| `workspace-watchers-persist.js`, `model-pick-decisions-persist.js` lock backoff; todos/mailbox readers | A4 `6e483edd` / A5 | none |
| `delegation-owner-lock.js` socket probe | recovery R3 (read-only) | finding reported above; no change |
| tick scheduler / resume policy | recovery R15 `c3665531` (ready), R16 `92ddf55f`, R17 `bfddf491` | none |
| `chats.json` writer | storage A3b | none |
| `child-process-registry.js`, `opencode-port-registry.js` locks, git helpers, Files/PTY/Browser | stage 6 | measured; no change (within thresholds, contention-only) |
| `files-list.js` ordering | stage 6 | **changed** (shared collator) |

## Bounds and lifecycle observed while profiling (no change made)

| Item | Bound / owner |
| --- | --- |
| PTY catch-up buffer | `PTY_BUFFER_MAX` 64 KiB (`TASK_RUN_BUFFER_MAX` 16 KiB); `queuePtyOutput` slices to the cap; per-client send skipped above `WS_BACKPRESSURE_THRESHOLD_BYTES` (warning rate-limited to 5 s) |
| PTY ws handler | `ws.on('close')` clears the resize debounce timer and removes the client; the last client of a non-agent terminal kills the pty; spawned ptys are registered through `trackChildProcess` |
| Child-process / OpenCode port registry lock | exclusive directory, stale after 10 s, waiter gives up after 3 s (25 ms poll) |
| Delegation runtime tick | one `setInterval` (unref'd) guarded by `tickInFlight` and a worker generation; `stopDelegationRuntimeWorker` clears it; store work is serialized through `enqueueDelegationStoreWork` |

## `writeJsonAtomic` hot files (write-stats scenario)

Measured with the per-file rows of `getWriteStats()` (`lib/persist/atomic-write.js`), driven by a deterministic mixed workload. No new
mechanism: callers adopt the existing `writeJsonCoalesced` / `skipIfUnchanged`.

Reproduction (same seed -> same traffic; run it twice for noise, JSON goes to `--out`):

```bash
node scripts/architecture-stall-profile.mjs --scenario write-stats --profile full --seed 20261017 --out /tmp/write-stats.json   # ~10 s
```

Workload (300 iterations, isolated `CRETLI_DATA_DIR`, 5 000-chat fixture): per iteration `updateChat` (a rename every third call), `addTodo`,
`upsertDelegationWorkflow`, `appendChildExitEvent`; every third iteration a mailbox message create + update (the mailbox is SQLite-backed on the
default store, so it writes no JSON and is absent from the table). Only files that the scenario touches can appear: **the scenario yields five
rows, not ten**. Cost = `stringifyMs + ioMs` (ms, whole run).

### Before (two baseline runs) and noise

| File | writes | identicalWrites | stringifyMs run1 / run2 | ioMs run1 / run2 | cost run1 / run2 | noise \|run1 − run2\| |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `chats.json` | 300 | 0 | 0 / 0 | 647.92 / 620.47 | 647.92 / 620.47 | 27.45 |
| `todos/*.json` | 300 | 0 | 116.42 / 115.81 | 87.94 / 86.74 | 204.36 / 202.56 | 1.80 |
| `delegation-workflows.json` | 300 | 0 | 7.10 / 7.03 | 19.60 / 20.34 | 26.70 / 27.37 | 0.67 |
| `child-exit-events.json` | 300 | 0 | 9.65 / 9.58 | 15.92 / 15.34 | 25.57 / 24.92 | 0.65 |
| `chat-title-history.json` | 200 | 0 | 5.18 / 5.92 | 10.18 / 10.84 | 15.36 / 16.77 | 1.41 |

### Classification

| File | Class | Decision |
| --- | --- | --- |
| `chats.json` | (a) durable before return | Primary chat store, read back by other code paths and processes right after every write; every `updateChat` also advances `updatedAt`, so there are no identical writes. Not touched. |
| `todos/*.json` | (a) | CAS-guarded todo document; no identical writes. Not touched. |
| `delegation-workflows.json` | (a) | Loop state must survive a restart (rounds are restored from it); each row carries a fresh `updatedAt`. Not touched. |
| `child-exit-events.json` | (a) | Crash/OOM evidence appended at child exit, close to a possible process death. Not touched. |
| `chat-title-history.json` | (b) may be delayed | Advisory audit trail next to `chats.json`; one rename writes it twice (entry, then the history `seq`). **Changed:** `writeJsonCoalesced` (`maxDelayMs` 2 s) with read-through of the pending document, flushed by `flushCoalescedWrites()` on SIGINT/SIGTERM and `process.on('exit')` in `server.js`. |

Considered and rejected for (c): `sidebar-layout.json` (every write carries a fresh `updatedAt` that the API returns to the client, so
`ignoreKeys: ['updatedAt']` would make the response disagree with the disk) and `memory-monitor-state.json` (every run stamps `updatedAt`/`lastSeenAt`;
its values are never identical in real use). No file qualified for `skipIfUnchanged`.

### After (two runs)

| File | writes (run1 / run2) | coalesced | cost run1 / run2 (before: 15.36 / 16.77) | Δ vs. baseline | Beyond noise (1.41)? |
| --- | ---: | ---: | ---: | ---: | --- |
| `chat-title-history.json` | 2 / 2 (was 200) | 198 | 0.14 / 0.13 | −15.2 ms (−99 %) | yes |

The other four rows are unchanged within noise (e.g. `todos/*.json` 211.52 / 200.10, `chats.json` 669.41 / 600.92 — the `chats.json` spread of ~70 ms
between two runs of identical code is the largest noise in this scenario and is dominated by fs cache state; `chats.json` is the largest remaining cost
and is a storage-owned (a) writer). Format on disk is unchanged (`{ v: 1, chats }`, 2-space indent). Tests: `tests/chat-title-history-coalesced.test.js`
(fewer physical writes, byte-equivalent content to `CRETLI_COALESCED_WRITES=0`, read-through, flush on shutdown).
Caveat: a backup taken inside the 2 s window can miss the newest title-history entry; a hard kill (SIGKILL) inside the window loses up to 2 s of it.

## Worktree registry read cache (event-loop stalls, persist leaf)

`readWorktreeRegistry` (`lib/persist/worktree-registry-persist.js`) now caches the parsed + normalized document per registry path, keyed by the file
signature `ino:size:mtimeMs:ctimeMs`. The cache is dropped on every write through the module and whenever the signature changes (external edit);
corrupt JSON is never cached and still throws `REGISTRY_CONFLICT`. Every caller gets a private `structuredClone`, so mutating callers (which hold the lock)
cannot corrupt the cache. File format unchanged.

Site `FS-worktree-registry-read` (300 records, file unchanged between calls, profile `full`, seed `20261017`, n = 1000, ms per call). Two baseline runs
on the code before the change, one run after:

| Run | P50 | P95 | P99 | max |
| --- | ---: | ---: | ---: | ---: |
| baseline 1 | 0.967 | 1.094 | 1.172 | 1.466 |
| baseline 2 | 0.969 | 1.061 | 1.145 | 1.456 |
| noise (\|run1 − run2\|) | 0.002 | 0.033 | 0.027 | 0.010 |
| after | 0.527 | 0.576 | 0.666 | 0.782 |

Criterion: P50 after (0.527) <= min(baseline P50) − noise (0.965) and P95 not worse beyond noise → **confirmed** (single machine, one "after" run). The remaining
cost is the `statSync` plus the deep copy. `FS-worktree-normalize-records` (0.42 ms P50 for 300 records) is the normalization work a cache hit now skips; it is
unchanged by design (`worktree-record.ts` was not modified). Deterministic evidence of skipped work: `tests/worktree-registry.test.js` asserts one parse for
two reads of an unchanged file.

## Leaf 9f36e26e: delegation/chat copy and parse paths (before / after)

Sites `CP-*` were added to `scripts/architecture-stall-profile.mjs` first; two baseline runs (profile `full`, seed `20261017`),
then one run after the change. Times are per-call ms (P50 / P95 / max). Noise = |P50 base1 - P50 base2|.

| Site | Base 1 | Base 2 | Noise | After | Result |
| --- | --- | --- | ---: | --- | --- |
| `CP-chats-remove-copy` (`removeChat`, 5000 chats) | 9.511 / 11.042 / 11.622 | 8.534 / 9.98 / 10.307 | 0.977 | 7.633 / 8.888 / 9.207 | **unconfirmed**: P95 better, but P50 after (7.633) is not <= min(base P50) - noise (7.557). Work drop is deterministic (list copies per call 1 -> 0, `tests/chats-persist-remove-no-copy.test.js`). |
| `CP-delegations-load-defaults` (`loadDelegations`, 600 rows) | 1.811 / 2.974 / 5.602 | 1.618 / 1.889 / 5.652 | 0.193 | 1.552 / 1.92 / 5.761 | not changed (about 3 us per row; callers that may mutate rows were not audited) |
| `CP-verdict-parse` (`parseDelegationVerdict`, distinct text) | 0.024 / 0.033 / 0.1 | 0.024 / 0.034 / 0.084 | 0 | 0.024 / 0.034 / 0.094 | not changed: 0.024 ms is not dominant, so no memo was added |
| `CP-verdict-parse-repeat` (same text) | 0.023 / 0.025 / 0.125 | 0.023 / 0.024 / 0.065 | 0 | 0.023 / 0.024 / 0.095 | not changed (as above) |
| `CP-findings-parse` (`parseReviewFindings`) | 0.01 / 0.013 / 0.124 | 0.01 / 0.012 / 0.121 | 0 | 0.01 / 0.012 / 0.095 | not changed: 0.01 ms per report |

`structuredClone` in `saveItems` already clones only the rows handed back to the caller; `updateChat` already copies a single row.
The whole-file write dominates `removeChat` wall time, so the copy removal is small against it.

## Leaf 3aed8cff: remaining stall sources and final report (event-loop stalls root)

Sites `ST-*` were added to `scripts/architecture-stall-profile.mjs` first (block "C3"). Two baseline runs and one run after the change, profile
`full`, seed `20261017`, one machine. Times are per-call ms (P50 / P95 / max). Noise = |P50 base1 − P50 base2|. Criterion: P50 after ≤ min(base P50) − noise
and P95 not worse beyond noise.

| Site | Base 1 | Base 2 | Noise | After | Result |
| --- | --- | --- | ---: | --- | --- |
| `ST-child-process-entry` (`createChildProcessEntry`) | 0.008 / 0.009 / 0.309 | 0.008 / 0.009 / 0.182 | 0 | 0.005 / 0.005 / 0.054 | **confirmed** (one of the two `/proc/<pid>/stat` reads removed; the other is the child's own start time) |
| `ST-workspace-settings-view` (`readWorkspaceSettingsView`, 40 workspaces) | 0.064 / 0.096 / 0.235 | 0.065 / 0.079 / 0.247 | 0.001 | 0.065 / 0.078 / 0.274 | not changed: 65 µs, the `structuredClone` protects a shared cached view and callers were not audited for mutation |
| `ST-todos-load-cached` (`loadTodosData`, unchanged file) | 0.011 / 0.020 / 0.179 | 0.011 / 0.013 / 0.196 | 0 | 0.011 / 0.013 / 0.062 | not changed: warm path never reaches `parseDocument` |
| `ST-todos-load-cold` (`loadTodosData`, 400 todos, cache miss incl. `parseDocument`) | 0.398 / 0.478 / 0.878 | 0.401 / 0.502 / 0.765 | 0.003 | 0.401 / 0.485 / 0.797 | not changed: 0.4 ms for a cache miss; `JSON.parse` dominates and cannot be skipped without changing the on-disk contract |
| `ST-oom-marker-read` (`writeOomMarker`, 400 marker rows) | 0.213 / 0.273 / 0.324 | 0.213 / 0.273 / 0.489 | 0 | 0.212 / 0.275 / 0.329 | not changed: 0.21 ms, runs only on a termination event, and the caller needs the dominating row synchronously |
| `ST-watcher-normalize-row` (`normalizeWorkspaceWatcherRow`) | 0.005 / 0.006 / 0.241 | 0.005 / 0.006 / 0.169 | 0 | 0.005 / 0.006 / 0.212 | not changed: 5 µs, the realpath is already cached in `normalizeDelegationWorkspaceKey` |
| `ST-lockout-resolve-folder` (`resolveLogicalWorkspaceFolder`) | 0.013 / 0.015 / 0.196 | 0.013 / 0.020 / 0.209 | 0 | 0.013 / 0.019 / 0.112 | not changed: 13 µs with an empty registry |

Change: `lib/child-process-registry.js` `resolveServerStartedAt()` caches this process's start time (constant for the process lifetime; an empty read is
not cached). Work evidence (not time): `tests/child-process-registry.test.js` asserts one reader call for 21 resolutions and identical `serverStartedAt` across entries.
Format on disk is unchanged. `normalizeWorkspaceFolder` has several unrelated definitions (`startup-lockout-workspace.js`, `todo-review-sync-hooks.js`,
`workspace-watchers-persist.js`); they were not merged and no repeated in-loop call was confirmed by measurement.

### Root-wide before / after (same profile, seed and machine)

| Path | Leaf | Before P50 / P95 / max | After P50 / P95 / max | Verdict |
| --- | --- | --- | --- | --- |
| `chat-title-history.json` writes (write-stats, cost ms/run) | 4506007a | 15.36 / 16.77 (200 writes) | 0.14 (2 writes) | confirmed (see section above); final run: 0.14 |
| `chats.json`, `todos/*.json`, `delegation-workflows.json`, `child-exit-events.json` | 4506007a | 647.92 / 204.36 / 26.70 / 25.57 | 575.51 / 191.85 / 26.40 / 24.16 (final run, within noise) | untouched by design (durable-before-return), no regression beyond noise |
| `FS-worktree-registry-read` | a28ba559 | 0.967 / 1.094 / 1.466 | 0.536 / 0.605 / 0.842 (final run) | confirmed, final run holds the gain |
| `FS-worktree-normalize-records` | a28ba559 | n/a (work skipped on cache hit) | 0.422 / 0.486 / 0.841 | unchanged by design |
| `CP-chats-remove-copy` | 9f36e26e | 9.511 / 11.042 / 11.622 (base 1) | 8.025 / 9.263 / 9.553 | unconfirmed for time (P50 gain < noise), work drop proven by test; no regression |
| `CP-delegations-load-defaults` | 9f36e26e | 1.811 / 2.974 / 5.602 | 1.476 / 1.714 / 5.447 | not changed (run-to-run drift only), no regression |
| `CP-verdict-parse`, `-repeat`, `CP-findings-parse` | 9f36e26e | 0.024 / 0.023 / 0.010 | 0.024 / 0.022 / 0.010 | not changed, no regression |
| `ST-child-process-entry` | 3aed8cff | 0.008 / 0.009 / 0.309 | 0.005 / 0.005 / 0.054 | confirmed |

Final write-stats run: `chats.json` 575.51, `todos/*.json` 191.85, `delegation-workflows.json` 26.40, `child-exit-events.json` 24.16, `chat-title-history.json` 0.14
(cost ms, 300 iterations). `updateChat` per call P50 5.381 ms.

### Watchdog source todos: covered / uncovered

Not closed; the list is for the operator. "Covered" means a measured, confirmed time drop on the path the code names.

| Code | Path | Status |
| --- | --- | --- |
| c829d229, b08ec393, 7bec9d92, d9c68284, 3559f8ed, b2cbc93b, e6f0c597 | `writeJsonAtomic` (7 reports, file per report not recorded in the root body) | **partially covered**: only `chat-title-history.json` was changed (−99 % cost). `chats.json`, `todos/*.json`, `delegation-workflows.json`, `child-exit-events.json` are durable-before-return writers and were deliberately not touched → uncovered if the report names one of them; operator decision |
| be626738 | `readWorktreeRegistry` | covered (leaf a28ba559, P50 0.967 → 0.536) |
| d3f0dc74 | `normalizeWorktreeRecord` | covered (leaf a28ba559, skipped on an unchanged registry file) |
| 01238557 | `createChildProcessEntry` | covered (this leaf, 0.008 → 0.005 ms) — a micro-gain, the call was never a large stall |
| d837b16a | `parseDocument` (todos) | uncovered: measured 0.4 ms cold, warm path does not parse |
| e7053ff7 | `readWorkspaceSettingsView` | uncovered: measured 65 µs, not confirmed as a stall |
| 9780985a | oom-diagnostics read | uncovered: measured 0.21 ms on a rare path, caller needs a synchronous result |
| 3d268bea | `normalizeWorkspaceFolder` | uncovered: 5–13 µs per call, no repeated in-loop call confirmed |
| bad7102c | delegation-sqlite | uncovered (no leaf, no measurement pointed at it) |
| a1a4617d | watcher-recovery text | uncovered (no leaf, no measurement pointed at it) |

Caveat: the profile measures per-call synchronous time on one machine with a synthetic fixture; the real stalls in the watchdog reports (hundreds of ms) were
not reproduced by any of the `ST-*` sites, so these codes remain candidates for operator review rather than confirmed fixes.

## Leaf d0205ec8: production-scale measurement and classification of the six watchdog codes

The `ST-*` sites of leaf 3aed8cff used small fixtures (400 todos, 40 workspaces, 400 marker rows) and measured 5 µs to 0.4 ms, while the watchdog reports
hundreds of ms. This leaf adds `ST-*-prod` sites (block "C4" of `scripts/architecture-stall-profile.mjs`) with synthetic, seeded fixtures of production shape,
to explain the gap. **No production code was changed.** Profile `full`, seed `20261017`, one machine (Linux/WSL2), two runs; times are per-call ms,
`P50 / P95 / max` of run 1, then run 2 (n = 15 for the heavy sites, 30 to 150 for the cheaper ones, so P95 and max are exploratory).
Setup is timed apart (`observed.setupMs`) and the measured part has no `utimes` call: the cache miss is forced by an untimed prep step.

| Code | Site (fixture) | Run 1 P50 / P95 / max | Run 2 P50 / P95 / max | Class | Owner | Justification |
| --- | --- | --- | --- | --- | --- | --- |
| d837b16a `parseDocument` | `ST-todos-load-cold-prod`: `loadTodosData` after a cache miss. 1500 todos, **27 217 908 bytes** (leafMaterial 49 %, 500 idempotency entries); `ST-todos-parse-prod`: read + `JSON.parse` only | cold 216.1 / 329.3 / 329.3; parse 148.1 / 230.9 / 230.9; normalization (cold − parse, derived) 68.0 | cold 211.3 / 293.9 / 293.9; parse 150.0 / 250.0 / 250.0 | storage-owned | A2 | About 70 % of the cold load is `JSON.parse` of one 27 MB document and the rest is row normalization, so only a different storage layout (for example leafMaterial outside the document) shortens it. Warm path is unchanged (about 11 µs). Event-loop max over the window 330 ms. |
| e7053ff7 `readWorkspaceSettingsView` | `ST-workspace-settings-view-prod-warm` and `-rebuild`: 400 workspaces with route keys and sidebar config (view JSON 153 430 bytes, SQLite) | warm 1.503 / 1.643 / 1.805; after data_version change 4.925 / 5.793 / 6.982 | warm 1.516 / 1.765 / 2.154; rebuild 5.232 / 5.812 / 17.747 | negligible | A2 | Single digits of ms even at 400 workspaces; the `structuredClone` of the cached view dominates the warm call. Does not reproduce hundreds of ms. |
| 3d268bea `normalizeWorkspaceFolder` | `ST-normalize-folder-prod-warm` (one call, cache hit); `-sweep` (400 distinct folders per sample); `ST-watchers-load-cold-prod` (watchers file of **1 541 245 bytes**, 400 rows x 8 pending findings) | single call 0.001 / 0.001 / 0.043; sweep of 400 folders 0.981 / 1.133 / 1.175; cold file load 73.6 / 102.2 / 102.2 | single 0.001 / 0.001 / 0.043; sweep 0.984 / 1.083 / 1.114; load 74.2 / 118.0 / 118.0 | negligible (the call); the cold load is storage-owned | A2 | One call is 1 µs warm. It is not a repeated per-row realpath: one cold load makes **400** `realpathSync.native` calls (one per row) and so does every sweep, because the 256-entry realpath cache of `normalizeDelegationWorkspaceKey` cannot hold 400 folders and evicts FIFO. That is about 2.4 µs per call on a local filesystem, so about 1 ms of the 74 ms load; the rest is JSON parse and normalization of the 1.5 MB document. A slow filesystem (network or drvfs mount) would multiply the 400 calls; that was not measured. |
| 9780985a oom-diagnostics read | `ST-oom-read-markers-prod-400/-4000/-8000` (`readOomMarkers`, evidence-carrying rows of about 350 bytes); `ST-oom-write-marker-prod-cap` (`writeOomMarker`, two files of 6031 rows, 2 093 788 bytes each) | read 400 rows 0.297 / 0.346 / 0.411; 4000 rows 2.76 / 2.818 / 2.823; 8000 rows 5.944 / 8.232 / 11.778; write at cap 8.673 / 11.536 / 12.094 | read 0.294 / 0.4 / 0.423; 2.853 / 2.956 / 3.041; 6.106 / 8.466 / 10.646; write 9.156 / 11.467 / 11.605 | negligible | other (rare path) | Cost grows linearly with rows (about 0.7 µs per row) and is bounded by the 2 MiB file cap (`capFile` rotates on the next write; the 8000-row file, 2 779 000 bytes, is above the cap and is a stress row). The worst legal case, a write scanning both files at the cap, is about 9 ms and runs only on a termination event. |
| a1a4617d watcher-recovery (`text` helper, caller `classifyWorkspaceDoingTodos`) | `ST-recovery-classify-prod-<n>-cycles<m>`: n doing todos x n delegations; 10 active cycles (the real cap) and 200 (stress) | 250 todos 2.201 / 2.842 / 2.982; 1000 todos 31.434 / 31.941 / 32.215; 1000 todos, 200 cycles 33.175 / 34.315 / 44.289 | 250: 2.301 / 2.71 / 2.729; 1000: 30.91 / 32.845 / 33.055; 1000, 200 cycles 32.011 / 35.723 / 36.358 | fixable here | other | The only quadratic one: every doing todo filters all delegations (and scans the cycles), so 4x the input costs about 14x. At about 1000 doing todos it exceeds the 25 ms event-loop P99 budget by itself. A Map index by leaf id and controller chat id would make it linear; not done here (no production changes). |
| bad7102c delegation-sqlite busy-retry | not measured | not measured | not measured | storage-owned | A2/A4 | The busy loop in the module-private `openSqliteDatabase` runs only while another connection holds the database lock, and then blocks the main thread in `Atomics.wait` slices of 50 ms for up to `SQLITE_BUSY_TIMEOUT_MS` (8 s) by construction. An isolated reproducer would need an export from `lib/` or a copy of the loop, so option (b) was chosen: the bound comes from the code, not from a measurement. This row does not count as a measurement. |

Fixture sizes (bytes, asserted in the script): todos 27 217 908 (profile `full` asserts at least 20 MiB; profile `smoke` asserts at least 1 MiB and labels itself
`smoke: reduced fixture … not production scale` in `observed.profileLabel`); watchers 1 541 245; oom 138 800 / 1 388 000 / 2 779 000 (read), 2 x 2 093 788 (write);
workspace settings view JSON 153 430; recovery has no file (1000 todos + 1000 delegations in memory).
Run-to-run noise (|P50 run 1 − P50 run 2|): todos cold 4.8, todos parse 1.8, settings rebuild 0.31, watchers load 0.64, oom write 0.48, recovery 1000 x 10 cycles 0.52.

**Answer to the gap question:** for the todo document (d837b16a) the gap is data scale (a 27 MB single JSON document costs about 210 ms per cache miss, versus 0.4 ms at 400 small items),
for recovery (a1a4617d) it is data scale combined with an O(n x m) loop (about 31 ms at 1000), and for the other four codes (e7053ff7, 3d268bea, 9780985a, bad7102c) the hundreds of ms
reported by the watchdog were **not reproduced** at plausible scale on this machine (single digits of ms; bad7102c not measured), so their cause is something this fixture does not contain
(slow filesystem, lock contention, GC pause coinciding with a large allocation); that is stated as unverified, not as a finding.
