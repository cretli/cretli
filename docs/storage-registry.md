# Storage registry (A1)

Status: inventory artifact for persistence leaf A1 — describes **current** writers and
paths, not migrated behavior.

Owner todo: `7a287da9-a8ce-4058-8379-3dde2e4a0504`. Consumer: backup B1
(`5cf09e77-8278-497e-bd97-91227686ac06`). Contract: [storage-contract.md](storage-contract.md).

## Machine-readable source

- **Canonical file:** [storage-registry.json](storage-registry.json) (`registryVersion: 1`).
- **Loader / validator:** `lib/storage/store-registry.js`, `lib/storage/validate-storage-registry.js`.
- **Tests:** `tests/storage-registry.test.js`.
- **Validation rules (F3):** besides required fields, the validator rejects
  path traversal (`..`) in `managedPaths` / `retainedPaths` / `bootstrapMarker.path`,
  absolute or `..` paths in `domainOwner`, non-numeric `lockOrderRank`, and a
  missing/malformed `bootstrapMarker` (`path` + `detect` required).

Each store entry includes: stable id, domain owner module, backend/schema, bootstrap
marker, managed vs retained paths, lock order rank, buffers, secret boundary, raw
validator reference, export/snapshot/flush/restore/migration adapter labels, durability
and ACK classes, and known HTTP/WS/background/subprocess/MCP writers.

## Contract field mapping

[storage-contract.md](storage-contract.md) lists what every registry entry must
specify. This is where each item lives in a `stores[]` row, so a consumer (B1) can
check completeness mechanically instead of by prose:

| Contract requires | Row representation |
| --- | --- |
| Stable store ID | `id` |
| Domain owner | `domainOwner` (repo-relative module) |
| Backend / schema version | `backend.kind` + `backend.schemaVersion` (+ `file` / `pathPattern` / `journal`) |
| Managed relative paths | `managedPaths`; retained class kept separate in `retainedPaths` |
| Bootstrap / backend markers | `bootstrapMarker.path` + `bootstrapMarker.detect` (`file-exists`, `directory-exists`, `v-field`, `v>=2`) |
| Every writer | `writers.known[]` with `channel` ∈ `http` \| `ws` \| `background` \| `subprocess` \| `mcp`, plus `writers.unknownGaps[]` and top-level `inventoryGaps[]` |
| Lock acquisition order | `lockOrderRank` + top-level `lockOrderHint`; the validator **fails** if the hint is not exactly the stores sorted by ascending rank |
| Buffered writes | `buffers.inMemoryCache` + `buffers.flushStrategy` |
| Secret-field classification | `secrets.classification` + `secrets.exportBoundary` |
| Dependencies | Store-level coupling is expressed as lock-order adjacency (`lockOrderRank`) plus the RMW critical-section table in [storage-callers.md](storage-callers.md); the TODO-level dependency graph lives in the contract. There is deliberately **no** separate `dependencies` key — a per-row list would duplicate the lock order and drift from it. |
| Strict raw-source validator | `rawValidator` |
| Logical export adapter | `adapters.export` |
| Snapshot / flush strategy | `adapters.snapshot` + `adapters.flush` |
| Restore / migration adapter | `adapters.restore` + `adapters.migration` |
| Durability / ACK contract | `durability.mode` (7 distinct modes, from `synchronous=FULL` down to `append-no-fsync-protocol`) + `ackClasses[]` |
| Cache invalidation | `buffers.inMemoryCache` — 8 of 28 stores cache in memory and invalidate on flush; the other 20 have no cache to invalidate |
| Automatic execution hooks | `writers.known[]` entries with `channel: "background"` (32 across the registry) and `channel: "subprocess"` |
| Recovery queues + retained usage journals | `store.recovery` and `store.usage-journal` rows are present even though their backends are unchanged |

Unknown writers are **not** silently absorbed into a store row: `writers.unknownGaps`
points at the matching top-level `inventoryGaps` entry, and only `inventoryGaps` carries
the machine-readable `blocksConsistentSnapshot` flag that B1/B6 must read.

## Lock order hint

Maintenance and online backup (B6) must acquire store locks in **`lockOrderHint`**
order (ascending `lockOrderRank`). Recovery and the usage journal lead the sequence;
JSON chat metadata and auxiliary stores follow. Todos, workspace memory, and watcher
rows share `workspace-watchers.lock.sqlite`.

## Snapshot capability

`inventoryGaps` lists paths whose writers are not fully registered on a store row.
Any gap with `blocksConsistentSnapshot: true` **fails** a “complete data directory”
snapshot until quiesced or registered (see DATA-08 / BACKUP-02).

## Runtime matrix (verified on harness host)

| Component | Value |
| --- | --- |
| Node (verified) | 22.23.2 |
| Bundled SQLite | 3.51.3 |
| Minimum for native backup (A1 contract) | Node ≥ 22.16 |
| `package.json` engines (A2) | ≥ 22.16 |

`store.todos` describes the **target** SQLite layout (`todos.sqlite` + `todos-backend.json`, ADR
[storage-todos-worker-decision.md](storage-todos-worker-decision.md) section 5). Production is not switched:
with no `todos-backend.json` marker the server keeps reading and writing `todos/<key>.json`, which is why
`todos/*.json` is listed under `retainedPaths`. The adapter names match the implementation:
`lib/persist/todos-backend-sqlite.js` (backend), `lib/persist/todos-backend-marker.js` (marker),
`lib/persist/todos-runtime.js` (selection), `lib/storage/todos-migration.js` and
`scripts/migrate-todos-to-sqlite.js` (migration and rollback). See
[storage-contract.md](storage-contract.md#todos-sqlite-backend-marker-migration-rollback).

Runtime app state (`store.apps-state`, `apps-state.json`) is a small JSON store written by `lib/apps/`; see `docs/apps-and-ports.md`.

The port exposure ledger (`store.port-exposures`, `port-exposures.json`) is written by `lib/port-exposure/`; see the Exposure section of `docs/apps-and-ports.md`.

Browser URL policies are stored per workspace in `browser-policy.json` by
`lib/browser/policy-store.js`. `store.browser-policy` includes this policy-only
file in registry-driven plain and encrypted backups, and restore replaces it
atomically. The encrypted `browser-storage-state.json` file (cookies and local
storage) is outside all managed paths, so plain or encrypted backup enumeration
omits it and restore leaves the destination copy untouched. Its key file
`browser-storage.key` is likewise outside the registry. This keeps encrypted
cookie payloads out of archives until they have a dedicated backup security
contract.

## Related artifacts

- Caller inventory: [storage-callers.md](storage-callers.md)
- Baseline harness: [storage-baseline.md](storage-baseline.md)
- Baseline report (small + medium): [storage-baseline-report.md](storage-baseline-report.md) + [storage-baseline-report.json](storage-baseline-report.json)
- Numerical gates: [storage-gates.md](storage-gates.md)
- Backend decision: [storage-backend-decision.md](storage-backend-decision.md)

## Follow-up: oversized JSON stores (context-send manifests, model-pick decisions)

`context-send-manifests.json` is not yet a registered store in `storage-registry.json`
and still lives as a JSON snapshot plus append-only journal
(`lib/persist/context-send-manifests-persist.js`). It has been observed at >150 MB on
a long-lived instance, which stalls the main thread on parse/rewrite.

Done (bounded retention, no schema change):

- Access profile: `lib/context/context-send-manifest.ts` writes a preview marker
  and then appends a manifest for each preview/send; `lib/routes/chat-context-routes.js`
  reads one chat's list per history request; chat deletion removes that chat's
  rows. The persist module is synchronous. A warm call checks snapshot/journal
  signatures; a cold/signature-changed call parses the snapshot and replays the
  journal. Each append writes one journal line; snapshot serialization/rewrite
  is deferred to 200 journal lines or 2 MiB. Load-time retention previously
  serialized the entire chat map twice just to detect changes; that full-map
  measurement is now replaced by row identity/count checks. No production timing
  instrumentation was available in this cycle, so parse and stringify latency
  and event-loop delay have not been measured against a real data set.
- Manifests: the per-chat count and window were already bounded since 0.5.0 (100 per
  chat, 30 days) yet the snapshot still reached 150+ MB, because every send stores the
  full `entries`/`blocks` arrays. New bounds (on write and on load): 20 per chat, 7 days;
  only the newest 3 manifests per chat keep `entries`/`blocks`/`warnings`/`selection`/
  `budget` (older rows are marked `compacted`, which the history list does not read);
  an ~8 MiB total cap evicts the oldest rows across chats first, never the newest 2 of
  a chat. Orphan preview markers older than 7 days are dropped. A shrinking load of a
  snapshot >= 1 MiB first copies it to `context-send-manifests.json.pre-prune.bak` (once).
- `store.model-pick-decisions`: open picks expire after 30 days, slotted picks after
  90 days, and at most 5000 picks are kept (oldest evicted); applied on load and on
  purge. `pruneModelPickDecisionsFile()` rewrites an existing file after writing
  `model-pick-decisions.json.pre-prune.bak`.

Remaining (not done): move context-send manifests into a storage-worker SQLite store
with per-chat access (per `storage-contract.md`) and register it here; run `VACUUM`
on `delegations.sqlite` / `recovery.sqlite` offline.

## Command receipt retention (A3a)

Pruning applies **only to `decisions.sqlite`**. Its receipts older than 7 days are pruned by the storage
worker (`lib/storage/receipts-retention.js`). The first prune removing more than 10% of the rows is
preceded by a verified copy in `data/backups/storage/`. Free pages are reused (incremental vacuum only
if the file is `auto_vacuum = INCREMENTAL`). The history, todos and chats stores keep their receipts
unchanged (history: chat-lifetime contract); attaching retention to them is a separate follow-up that
needs its own contract review. See `lib/storage/receipts.md`.

Docs roots, realpath-bound external-root consent (including `agentRead`) and managed
links live in `docs-state.json`, owned by `lib/docs/docs-state-store.js`.
`store.docs-state` is a managed JSON document with atomic rename and migration
`none`; offline backup and restore include it. Note files and the in-memory index
are outside this store. Machine-bound root paths and consent are excluded from
portable settings exports. See [docs-module.md](docs-module.md).
