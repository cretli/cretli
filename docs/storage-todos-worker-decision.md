# Todos storage worker decision (L3)

Date: 2026-10-28. Status: **proposed migration design; human approval pending**. Moving todos to the storage worker is required by the approved stall plan. This ADR decides how to do it; it does not change the live registry, contract, backend, or data. Implementation belongs to the separate `67a47af0` root and needs its **own human plan approval after this ADR**. Completion of L3 is neither that approval nor acceptance of the migration. The existing worker choice for chat history is documented in [storage-backend-decision.md:9-16](storage-backend-decision.md); the current todos entry is [storage-registry.json:212-241](storage-registry.json). This document is authored against `7889538da38ac41d35da2b932766ed26bd655400`. L1/L2 reports and changes are absent from that revision; historical measurements below are cited from `74d6ffed9b0dc26ea03801c5313fc1c635797455` using `git show <revision>:<path>` and are **not** claims about the current checkout.

## 1. Baseline and migration goals

Historical production write statistics in `74d6ffed:docs/stall-baseline-2026-10.md:7-20` give **2,583** `todos/*.json` writes, average **22.0 MB**, **261 s** stringify, **63 s** I/O, and `(a) maxMs = 3,963 ms`. Reproduce the source with `git show 74d6ffed9b0dc26ea03801c5313fc1c635797455:docs/stall-baseline-2026-10.md`. `maxMs` is one write's `stringifyMs + ioMs`, not loop delay ([atomic-write.js:71-75](../lib/persist/atomic-write.js)). The L1 baseline reports **68** auto stall todos, with **11/30/25** dated on October 24/25/26 and two undated (`74d6ffed:docs/stall-baseline-2026-10.md:194-210`). It does **not** provide `(b)`, a count of production stalls lasting ≥3 s specifically in the `todos-persist` cause group. The 68 is an all-cause auto-todo count, not that group count. The human operator accepted **historical (b) = N/A** for this ADR; L4 must measure a prospective count after migration. The pre-L1 **synthetic** watchdog probe produced 60 inputs labelled `stalledForMs: 3000`, 60 writes, and a 298.320/392.167 ms loop-delay p99/max; the 3000 value was test input, **not** 60 measured ≥3 s stalls (`74d6ffed:docs/stall-baseline-2026-10.md:58-92`).

The historical L2 synthetic microbenchmark used a 22,306,059-byte todo document and 1,000 unchanged saves: todo stringify time fell **41,009.8 → 0 ms**; unchanged watcher saves fell **77.3 → 0 ms**. For 20 **changed** 22,306,219-byte todo saves, p50/max fell **60.9/93.3 → 56.5/58.7 ms**, while serialization still cost **39.5 ms/write** in the L2 checkout (`74d6ffed:docs/stall-l2-persist-cpu.md:39-57`; reproduce with `git show 74d6ffed9b0dc26ea03801c5313fc1c635797455:docs/stall-l2-persist-cpu.md`). These are isolated microbenchmark figures, not historical production latency or a claim that the current base includes L2. Historical production p99/max loop lag is N/A; the accepted synthetic baseline does not replace a prospective production measurement (`74d6ffed:docs/stall-baseline-2026-10.md:171-192`).

Migration goals: changed todo writes do **zero whole-workspace JSON serializations on the main thread**; workload event-loop p99 ≤ **25 ms** and max ≤ **100 ms**; `(a)` falls to **zero writes of `todos/*.json`** after cutover, with SQLite commit latency reported separately; `(b)` is measured prospectively after migration and targeted at **0** ≥3 s incidents attributable to todos persistence in a 24 h production window. A zero target is a goal, not a claim that baseline `(b)` is zero. L4 measures production separately; the 24 h window is not a gate to starting `67a47af0` ([storage-gates.md:39-54](storage-gates.md), `74d6ffed:docs/stall-baseline-2026-10.md:181-192`).

## 2. Indexed rows and lazy fields

Use a `todos` row keyed by `(workspace_key, id)` with indexed `id`, `workspace_key`, `parent_id`, `status`, `sibling_index`, and `updated_at`; indexes include `(workspace_key, parent_id, sibling_index, id)`, `(workspace_key, status, updated_at, id)`, and `(workspace_key, updated_at, id)`. Preserve the existing document version, item order, unknown JSON fields, and tree invariants through a versioned logical export. Store `body`, `plan`, `changelog`, and `review` separately as JSON/text fetched only for detail, review, or export. Summary/list reads return indexed fields and bounded preview fields; detail reads fetch heavy fields by ID. No full document may be sent over the worker wire on routine writes or list reads. This design follows the current per-workspace document and raw tree validator contract ([storage-registry.json:213-230](storage-registry.json)) and the current `loadTodosData` document interface ([todos-persist.js:994](../lib/persist/todos-persist.js)).

## 3. Async API, cache, CAS, and acknowledgement

Current `loadTodosData`, `addTodo`, `updateTodo`, and `saveTodosData` are synchronous ([todos-persist.js:994](../lib/persist/todos-persist.js), [todos-persist.js:1195-1199](../lib/persist/todos-persist.js), [todos-persist.js:1317-1321](../lib/persist/todos-persist.js), [todos-persist.js:1572-1595](../lib/persist/todos-persist.js)). A source search at this ADR revision finds **33 `lib/` files containing `loadTodosData`** (including its definition) and **62 textual `addTodo(`/`updateTodo(` occurrences** in `lib/` (including definitions); these are search inventory counts, not unique runtime callers. The conversion owner must enumerate import aliases and indirect paths before cutover. High-risk call sites include HTTP reads/writes ([todos-routes.js:624-903](../lib/routes/todos-routes.js)), watcher claim/cycle operations ([workspace-watcher-cycle.js:1660-1671](../lib/workspace-watcher-cycle.js)), cross-workspace move ([todo-move.js:130-167](../lib/todo-move.js)), and `saveTodosData` in [delegation-takeover.js:151-165](../lib/delegation-takeover.js).

Expose Promise-based `listTodos`, `getTodo`, `addTodo`, `updateTodo`, `deleteTodo`, `moveTodo`, and a bounded transactional batch API; convert all callers and read-modify-write sections together. Keep an immutable, versioned main-thread **committed** cache for fast reads. A submitted mutation may have a private pending overlay for its own request, but no shared cache publication, watcher nudge, HTTP/MCP success, or downstream job dispatch occurs until the worker commits. Group commit may batch independent commands, each with a receipt and per-command result; it must not turn `post-commit-todo-cas` into an early acknowledgement. The worker's transaction checks `expected_updated_at` against the stored row and updates it atomically; conflict returns without mutation. The present CAS check is in [todos-persist.js:1594-1600](../lib/persist/todos-persist.js), the registered ACK class in [storage-registry.json:231-241](storage-registry.json), and the worker transaction/reply rule in [worker-protocol.md:12-30](../lib/storage/worker-protocol.md).

Crash window: uncommitted queued or pending overlays disappear; after COMMIT but before reply, outcome is unknown until receipt reconciliation. No speculative shared cache state survives or is acknowledged. On restart, rebuild the cache from committed SQLite rows; a stale version is invalidated after each successful command. This requires async propagation through route handlers, MCP handlers, watcher loops, move/takeover paths and test fixtures; a synchronous worker facade is excluded by [storage-contract.md:59-64](storage-contract.md). Keep command payloads small because receipt digest canonicalization runs on the main thread ([receipts.md:21-35](../lib/storage/receipts.md)).

## 4. Shared lock and multi-document serialization

Today `store.todos` has lock rank **50** and shares `workspace-watchers.lock.sqlite` through `withWorkspaceWatchersFileLock` ([storage-registry.json:213-223](storage-registry.json)); every todo writer acquires it ([todos-persist.js:1195-1199](../lib/persist/todos-persist.js), [todos-persist.js:1317-1321](../lib/persist/todos-persist.js), [todos-persist.js:1572-1573](../lib/persist/todos-persist.js)). The move path holds that lock while reading and writing two workspace documents ([todo-move.js:130-167](../lib/todo-move.js)). The new worker owns all todo-row transactions and rank-50 todo serialization. Move source, target, CAS, index changes and receipt must commit in **one** transaction; never preserve the old two-save partial-commit behavior. Watcher state remains rank 40; no caller may hold the watcher file lock across an `await` of the worker. Split coupled watcher/todo decisions into version-checked commands or an explicit coordinator protocol, preserving registry lock order and fencing ([storage-registry.json:184-220](storage-registry.json), [storage-contract.md:111-118](storage-contract.md)). The implementation must document and test cross-process ownership before removing the legacy shared lock.

## 5. Migration, recovery, and rollback

Use a quiesced, verified backup and a staged import, adapting the pre-cutover sequence rather than applying the history CLI to todos. Stop all writers, inventory unknown file writers, record a source manifest with per-file SHA-256 and logical item counts, then import into a new SQLite store. Verify total and per-workspace counts, IDs, parent/sibling order, unknown fields, and canonical logical hashes after export. Publish a durable backend-selection flag only after checks and clean close; leave legacy JSON intact and **read-only**. Startup must choose exactly the flagged backend, never silently create an empty store. These requirements follow [storage-pre-cutover-runbook.md:87-101](storage-pre-cutover-runbook.md), the history import's staged counts/hash checks ([storage-history-migration.md:117-145](storage-history-migration.md)), and marker/restore rules ([storage-contract.md:137-150](storage-contract.md)).

Before a new-backend ACK, a failed cutover can restore the verified previous marker and dataset under exclusive ownership. After any new-backend durable ACK, an old JSON backup alone loses writes; rollback needs a fresh logical export with receipts/fencing sidecar, validation, and an adapter that honors it, or an explicit data-loss decision. This is the runbook's rollback boundary ([storage-pre-cutover-runbook.md:278-281](storage-pre-cutover-runbook.md)). Every write gets a stable `commandId`, dataset generation, handler name and payload digest. On `unknown_commit`, call `resolveUnknown` with the **same** command and digest **before** retry; committed means return the stored result, not committed permits retry with the same ID/payload, and unreconcilable or digest mismatch fails closed ([receipts.md:155-184](../lib/storage/receipts.md), [worker-protocol.md:143-146](../lib/storage/worker-protocol.md)).

**Proposed complete replacement for the `store.todos` object only** in [storage-registry.json:212-241](storage-registry.json); this ADR does not edit that registry. Adapter names and marker are design commitments for `67a47af0`, not existing implementations:

```json
{
  "id": "store.todos",
  "domainOwner": "lib/persist/todos-persist.js",
  "backend": { "kind": "sqlite-wal-full", "schemaVersion": 1, "file": "todos.sqlite" },
  "bootstrapMarker": { "path": "todos-backend.json", "detect": "backend-field" },
  "managedPaths": ["todos.sqlite", "todos-backend.json"],
  "retainedPaths": ["todos/*.json"],
  "lockOrderRank": 50,
  "locks": ["storage worker transaction; rank-50 todo owner"],
  "buffers": { "inMemoryCache": true, "flushStrategy": "worker transaction with bounded group commit; publish committed cache only" },
  "secrets": { "classification": "user-content-in-titles", "exportBoundary": "workspace-scoped-export" },
  "rawValidator": "todo row version + tree invariants + logical export validation",
  "adapters": {
    "export": "logical-json-per-workspace",
    "snapshot": "sqlite-backup-api-or-clean-close",
    "flush": "worker-commit-and-receipt-drain",
    "restore": "verified-sqlite-and-marker-replace",
    "migration": "quiesced-todos-json-import-with-count-and-hash-verification"
  },
  "durability": { "mode": "synchronous=FULL", "wal": true },
  "ackClasses": ["post-commit-todo-cas"],
  "writers": {
    "known": [
      { "channel": "http", "module": "lib/routes/todos-routes.js" },
      { "channel": "mcp", "module": "todo MCP tools" },
      { "channel": "background", "module": "lib/workspace-watcher*.js claims" },
      { "channel": "background", "module": "lib/todo-review-backfill.js" }
    ],
    "unknownGaps": []
  }
}
```

The registry validator test (`node --test tests/storage-registry.test.js`) belongs to the implementation root after its registry change, not to this document-only leaf; registry requirements are described in [storage-registry.md:14-44](storage-registry.md).

## 6. Direct-file consumers and transition

File-dependent callers need an explicit adapter, not a path into read-only legacy JSON. [todo-review-backfill.js:492-510](../lib/todo-review-backfill.js) copies the document as its rollback point: replace that with a worker logical snapshot/restore transaction and update the recovery procedure before cutover. [workspace-watcher-control.js:195-210](../lib/workspace-watcher-control.js) uses `stat` of the todo file as a revision: replace it with a committed store revision query/notification. [backfill-todo-review.js:38](../scripts/backfill-todo-review.js) and [backfill-todo-review.js:122](../scripts/backfill-todo-review.js) instruct operators to copy JSON for rollback: update the script and instructions to use the new adapter. [measure-todo-save.js:25-72](../scripts/measure-todo-save.js) calls the sync API and [measure-todo-save.js:149-150](../scripts/measure-todo-save.js) stats the JSON path: migrate its fixture and byte measurement to the async API and SQLite/worker metrics. These are direct path dependencies; other callers through `loadTodosData` are covered by section 3. The history migration precedent requires source readers to be quiesced and hash-checked ([storage-history-migration.md:128-145](storage-history-migration.md)).

## 7. Todos workload and numerical gates

Build a repeatable **todos-specific** workload with 50 rows / ~22.3 MB legacy equivalent (L2 fixture), 1,000 no-op saves, 20 changed writes, indexed list/detail queries, CAS conflicts, watcher claims, a two-workspace move, a burst of 200 commands, and worker loss after COMMIT. Report hardware, Node/SQLite, dataset bytes, histogram resolution, per-command queue/execute/ACK latency, main-thread serialization time, WAL plus database bytes, and logical export hashes. Compare the same inputs and durability against the historical L2 fixture (not present in this checkout) and a fresh JSON baseline; do not compare L2 synthetic values to L1 production stats as though they shared a workload (`74d6ffed:docs/stall-l2-persist-cpu.md:39-57`, [storage-gates.md:15-37](storage-gates.md)).

Todo-specific gates are: changed-write API persist p95 ≤ **120 ms**, p99 ≤ **250 ms**; worker queue plus execute p95 ≤ **80 ms**, p99 ≤ **180 ms**; indexed 50-row todo list p95 ≤ **40 ms**, p99 ≤ **90 ms**; event-loop p99 ≤ **25 ms**, max ≤ **100 ms** at **1 ms** monitor resolution; steady queue age p95 ≤ **200 ms**, 200-command burst max ≤ **2,000 ms**; Stop/claim/final priority wait ≤ **500 ms**. For **1,000 changed todos** on the same 22.3 MB fixture, count SQLite database + WAL bytes actually written and require ≤ **25%** of the JSON baseline's bytes; also report bytes per changed todo, no-op bytes (target **0**), checkpoint p99 ≤ **500 ms**, and group-commit batch ≤ **256 KiB** / **40 ms**. The commit/query/byte numbers are an **adaptation for todos**, not measured todo results: the original gates target mixed chat persist, history pages and medium chat events ([storage-gates.md:29-44](storage-gates.md), [storage-gates.md:56-83](storage-gates.md)). A failing correctness/ACK/CAS, count/hash, receipt reconciliation, or numeric gate blocks cutover; L4's prospective production measurement remains a separate outcome.
