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

## Related artifacts

- Caller inventory: [storage-callers.md](storage-callers.md)
- Baseline harness: [storage-baseline.md](storage-baseline.md)
- Baseline report (small + medium): [storage-baseline-report.md](storage-baseline-report.md) + [storage-baseline-report.json](storage-baseline-report.json)
- Numerical gates: [storage-gates.md](storage-gates.md)
- Backend decision: [storage-backend-decision.md](storage-backend-decision.md)
