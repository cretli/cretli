# Archive profiles and validation (B1)

Status: contract and validation layer only; backup runtime is B4/B6.
Owner: backup TODO B1 (`5cf09e77-8278-497e-bd97-91227686ac06`).
Registry owner: persistence TODO A1 (`7a287da9-a8ce-4058-8379-3dde2e4a0504`).
Shared base: [storage contract](../storage-contract.md),
[settings and backups](../settings-backup-design.md).

Machine-readable schemas live under `lib/backup/schemas/`. Constants and validators
live in `lib/backup/archive-contract.js` and `lib/backup/validate-archive-document.js`.

## Registry consumption (single owner)

A1 owns `lib/storage/store-registry.js`: the versioned inventory of every durable store,
its writers, lock order, validators and adapters. B1 does **not** duplicate that registry;
it defines how backup/export/import **consumes** registry entries.

Each registry entry must expose enough metadata for archive jobs to pass the snapshot
capability check defined in the storage contract. B1 adds a capability checklist (see
below) that A1 entries must satisfy before an online or offline snapshot includes a store.

Backup services resolve stores only through the registry API (proposed shape):

- `listStores()` — stable store IDs in lock order.
- `getStore(storeId)` — full entry for preview, export and restore planning.
- `checkSnapshotCapability(storeIds, mode)` — fails closed on unknown writers, unresolved
  transactions, missing flush hooks or corrupt raw validation.

Export adapters read logical or physical snapshots **after** the maintenance coordinator
(B6) or offline exclusive ownership (B4) has flushed and locked stores. Import/restore
adapters write only **managed** paths recorded on the entry; retained paths are never
replaced from an archive.

## Three archive profiles

| Profile ID | Container | Primary use | Importable |
| --- | --- | --- | --- |
| `portable-settings-v1` | Single JSON document | Named settings snapshots, machine migration of non-secret configuration | Yes (merge by section) |
| `conversations-v1` | ZIP with `manifest.json` plus category payloads (JSON and optional Markdown) | Chat export, reading copies, selective re-import as new transcripts | Yes (structured payloads only) |
| `data-backup-v1` | ZIP with `manifest.json` plus store/category blobs | Disaster recovery, full offline restore | Yes (unit restore; no selective DB merge in MVP) |

Markdown exports under `conversations-v1` are human-readable only; they are listed in
`manifest.json` with `role: "markdown"` and must never be parsed as configuration.

### Portable settings (`portable-settings-v1`)

- One UTF-8 JSON file; no ZIP wrapper required for download, but the same schema applies
  when embedded as `settings/portable.json` inside `data-backup-v1`.
- Fields are classified `portable`, `machine`, `secret`, or `transient` via the registry
  and settings projection adapters — never a raw copy of `config.json`.
- Default export **omits** secret and transient fields; `omissions[]` names each skipped
  path with a reason code (`secret`, `machine`, `unclassified`, `operator_excluded`).
- Optional `devicePreferences` block may include allowlisted browser keys when the export
  job captured them; missing browser data is reported, not invented.

### Conversations (`conversations-v1`)

- ZIP root contains `manifest.json` (see schema) and relative paths only.
- Categories typically include `chat-metadata`, `chat-history`, `attachments` (optional),
  `markdown` (optional, non-importable as config).
- Record counts and SHA-256 digests are per member file; attachment missing on disk is
  an explicit omission, not a zero-byte placeholder.
- Export retains only server-side retained history; pruned events and other devices'
  unsynchronized queues appear under `omissions[]`.

### Data backup (`data-backup-v1`)

- ZIP root `manifest.json` records:
  - `archiveContractRevision` and `manifestFormatVersion`
  - random `archiveId` (UUID v4) for repeat-import detection — not a machine fingerprint
  - `createdAt`, `cretliVersion`, `profile: "data-backup-v1"`
  - `persistence`: backend markers and schema versions **as observed at snapshot time**
  - `categories[]`: each with `categoryId`, relative `path`, `byteSize`, `sha256`, optional
    `storeId` (registry reference), `recordCounts`, `backend`, `schemaVersion`
  - `omissions[]`: skipped stores, attachments, browser-only data, encrypt-only categories
- Digests cover uncompressed member bytes. Encrypted envelopes (B5) wrap the whole archive;
  the manifest described here is the inner plaintext contract after decryption.

## Managed versus retained paths

**Managed** paths may be replaced during restore when listed on a registry entry and
included in the archive category map. Examples (relative to `CRETLI_DATA_DIR` / `data/`):

- `config.json` (via settings adapter, not blind file copy), `sidebar-layout.json`
- `chats.json`, `chat-history/`, `chat-title-history.json`
- `todos/`, `workspace-memory/`, `workspace-watchers.json`
- Delegation and recovery stores (`delegations.sqlite` or legacy JSON, `recovery.sqlite`)
- Usage ledger/index when the category is selected
- `mcp.json`, `mcp-tx.json` (definitions only; secrets omitted by default)
- Referenced `uploads/` files when the attachments category is included

**Retained** paths are never overwritten from an archive:

- Installation authentication: signing keys, `sessions.json`, password hashes
- TLS material, SSH keys, `.env` and environment-only bootstrap
- Native harness login stores and entire harness home directories
- Maintenance control directory (lease, fence, restore pause, recovery journal bootstrap)
- Backup destination directories and in-progress job staging outside the archive
- Runtime lock/lease files, PID markers, and unknown files not registered as managed

Mount points: stage and rename per filesystem; never assume the whole data root or a
mount point can be renamed atomically. The external control directory lives **outside**
all managed restore targets.

## Dependencies and ordering

Registry entries declare `dependsOn: storeId[]`. Export must snapshot dependencies in
**registry lock order** (A1 defines the total order). Restore applies categories in the
reverse dependency order after preview validates backend markers.

Cross-store snapshots use one barrier: offline exclusive ownership (B4) or the maintenance
coordinator (B6). Partial export of a store whose dependencies are omitted must list those
dependencies under `omissions[]` with reason `dependency_not_exported`.

## Secret and confidential boundaries

| Class | Export default | Restore behavior |
| --- | --- | --- |
| `secret` | Omit; name in `omissions[]` | Never clear destination credentials when absent |
| `machine` | Omit or optional machine section | Preserve destination values unless operator opts in |
| `portable` | Include | Merge/replace per section preview |
| `transient` | Omit | N/A |

Hard excludes (never in any profile): `.env`, auth cookies, session signing material,
TLS private keys, SSH keys, harness homes, raw `mcp-secrets.json` in portable settings.

Conversation text and attachments may contain sensitive content. Labels and UI copy must
state that excluding credential stores does **not** anonymize transcripts.

## Store adapters (current and future slices)

Logical adapter names are stable; backends may change when A1 migrates stores.

| Store ID (proposed) | Current backend | Export adapter | Restore adapter | Notes |
| --- | --- | --- | --- | --- |
| `settings` | JSON (`config.json`) | Classified field projection | Section merge with destination credential preservation | Not raw config dump |
| `sidebar-layout` | JSON | File snapshot | Managed replace | |
| `chats-metadata` | JSON | Logical JSON | Remap IDs on import | |
| `chat-history` | JSON documents | Strict read + digest | Quarantine on corrupt file | DATA-07 |
| `chat-title-history` | JSON | File snapshot | Managed replace | |
| `todos` | Per-workspace JSON | Tree export | Workspace key remap | |
| `workspace-memory` | JSON tree | Tree export | Workspace key remap | |
| `workspace-watchers` | JSON | Portable omits execution state | Safe defaults on restore | |
| `delegations` | JSON or SQLite | Backend-specific snapshot | Pre-migration reader if needed | |
| `recovery` | SQLite | Consistent backup API / closed DB | Restore **paused**; no auto launch | |
| `usage-ledger` | Journal + index | Optional category | Retain accounting semantics | A1 gate for migration |
| `mcp-config` | JSON + tx file | Definitions without secrets | Imported executables **disabled** | BACKUP-04 |
| `attachments` | Files under `uploads/` | Allowlisted paths only | Missing files reported | |

Future slices (accepted in contract, not required for B2 MVP): unified `cretli.sqlite`
domains, encrypted credential category (B5), device preference sync.

### Pre-migration restore

When `manifest.persistence` records an older backend marker (for example JSON chat history
on a host that normally uses SQLite):

1. Preview must resolve a **registered legacy reader** for that marker and schema version.
2. Forward migrations run only while automatic execution is **paused** (restore pause flag).
3. Unsupported backend, schema, or bootstrap override combinations **fail preview** — never
   create an empty database because a marker resembles a newer backend.
4. Rollback after new writes requires operator reconciliation, not silent re-application of
   an old archive.

### Corrupt source handling

Strict raw-source validators (registry-owned) run before export and during preview:

- Corrupt JSON, failed SQLite integrity, or unresolved MCP transactions → job failure.
- Selected corrupt store → quarantine artifact with **raw-byte SHA-256**, explicit report,
  reason `corrupt_source`; no repair via empty loader or truncated export.
- Forgiving parsers that turn corruption into `{}` or `[]` are forbidden for backup paths.

## Frozen export scope and limits (v1)

These limits are part of the contract; B4/B6 enforcement implements them.

| Limit | Value | Failure code |
| --- | --- | --- |
| Max single member uncompressed | 512 MiB | `member_size_exceeded` |
| Max total uncompressed archive | 8 GiB | `archive_size_exceeded` |
| Max manifest categories | 64 | `category_count_exceeded` |
| Max omission records | 4096 | `omission_count_exceeded` |
| Max relative path length | 512 chars | `path_invalid` |
| Allowed compression | store (ZIP) only; no nested archives | `nested_archive_forbidden` |

Export scope freeze (v1 categories for `data-backup-v1`):

- Core: settings projection, sidebar, chats metadata/history, todos, memory, watchers
- Operational: delegations, recovery (paused restore semantics)
- Optional: usage ledger, attachments, device preferences
- Excluded: retained paths, secrets, harness homes, backup destination, control dir

## Version migration

- `manifestFormatVersion` increments when manifest shape changes.
- Supported older manifest versions may be upgraded in **staging** during preview; unknown
  versions fail before any write (`unsupported_manifest_version`).
- Category payloads carry their own `schemaVersion`; plugin settings use registered schemas.
- Repeat import: same `archiveId` + different digest → fail; same digest → idempotent report.

## Registry capability checklist (writer / flush / lock / restore)

Each store entry consumed by backup must document:

1. **Writers** — every process/path that mutates the store (HTTP, WS, subprocess).
2. **Flush** — how buffered data reaches durable media before snapshot (including error retention).
3. **Lock** — acquisition order relative to other stores; no lock held across unrelated `await`.
4. **Restore** — managed paths, backend markers, legacy reader ID, forward migration ID, cache invalidation hooks.
5. **Raw validator** — strict reader used for export preview and corrupt detection.
6. **Secret classification** — field paths or patterns for portable export projection.

`validateStoreRegistryEntry()` in `lib/backup/archive-contract.js` encodes this checklist for
tests and for A1 acceptance; the live registry is populated by A1.

## Related tests

- `tests/backup-archive-contract.test.js` — schema and fixture validation
- Fixtures under `tests/fixtures/backup/`
