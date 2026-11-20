# Persistence and backup plan review: Opus 5.5

Date: 2026-10-07. This document is the parent's synthesis of an independent,
read-only review by `claude-opus-5-5::effort=medium` through the
[cretli-multi-harness skill](../.agents/skills/cretli-multi-harness/SKILL.md).
Full original report: Cretli delegation `fee78a3d-db26-46cd-82cd-4d072ad4d9f0`.

## Reviewed artifacts and verdict

| Plan | Reviewed artifact | SHA-256 |
| --- | --- | --- |
| A: unified persistence | [persistence-design.md](persistence-design.md) | `1383afa7d454c1c2f30bc102a76116dff166ff8c207a4dda4c54ea528215244e` |
| B: settings/export/backup | [settings-backup-design.md](settings-backup-design.md) | `8f98a66b6e6d50b49ac7e0ebc764c5802686621348e78df1b4c8ebbfb098e175` |

Root TODO revisions: A `2026-10-07T18:09:14.729Z`, B
`2026-10-07T18:09:14.807Z`. Full bodies/plans were supplied to the reviewer.

Overall readiness verdict: **FAIL**. The reviewer considers the direction sound,
but requires additional design decisions before full implementation. Inventory and
baseline stages can proceed after the shared contract is clarified; this verdict
does not authorize migration or prove performance benefits.

## Blocking amendments identified by the reviewer

- **DATA-01:** Define a go/no-go gate comparing current JSON, incremental SQLite on
  the main thread, and SQLite in a worker. Permit a decision to retain standardized
  stores if measured benefit does not justify the conversion.
- **DATA-02:** Inventory synchronous callers and read-modify-write sections. A
  synchronous compatibility facade cannot wait for a worker without blocking;
  convert callers explicitly and execute each atomic operation as one command.
- **DATA-04:** Give append/coalescing commands durable batch identities, or specify
  an equivalent revision/operation protocol. Test COMMIT followed by a lost worker
  response and retry: delta text must remain byte-for-byte unchanged.
- **DATA-05:** Specify deduplication scope across browser queues/devices and its
  retention horizon. Existing per-browser `clientSeq` must not become a uniqueness
  constraint that discards another device's record; define legacy-client handling.
- **BACKUP-01:** Specify one quiescence mechanism shared by backup and migration:
  buffer flush, existing lock coordination, run/write gating and bounded duration.
  Consider stopped-server backup first. Hard-link snapshots are only a possible
  optimization for verified immutable-after-publication files on compatible storage,
  not a solution for append-in-place journals or live SQLite databases.
- **BACKUP-02:** Assign ownership of the shared store registry to A1 and consumption
  to B1. Define dependencies and restore of pre-migration archives/backend markers
  on a migrated installation; prevent two independent backup implementations.
- **BACKUP-04:** Import executable MCP/connection definitions disabled, show their
  commands/URLs, and require explicit activation. Define a restore pause flag outside
  replaced data and enumerate all automatic launch/delivery paths it controls.

## Additional decisions for the appropriate stages

- **DATA-03:** Define durability acknowledgements for server stream events and
  group-commit scheduling so history cannot starve critical commands.
- **DATA-06:** Consider separate history and chat-metadata pilot slices.
- **DATA-07:** Quarantine/report corrupt histories; hash raw sources rather than
  silently filtered records.
- **DATA-08:** Establish all external/cross-process writers and cache invalidation.
- **DATA-09:** Preserve monotonic recovery fencing across migration and reject stale
  callbacks.
- **DATA-10:** Choose the minimum supported runtime or a tested backup fallback.
- **DATA-11:** Migrate the existing usage journal only when measurements justify it;
  retain its fsync, CRC, accounting and idempotency guarantees.
- **DATA-12:** Specify durable history revisions within a generation and fresh
  dataset generations after restore; an older snapshot must not accept stale queues.
- **BACKUP-03:** Enumerate managed versus retained restore paths, including mount
  points, harness homes, authentication and the external recovery journal.
- **BACKUP-05:** Enforce dataset generations on the server, including a policy for
  clients that send no generation; client-only cache invalidation is insufficient.
- **BACKUP-06:** Specify encrypted streaming, truncation detection, plaintext staging
  lifecycle, KDF, metadata listing and pre-restore-copy encryption before stage B5.
- **BACKUP-07:** Define settings preview revisions and a durable repeat-import map,
  including deleted destinations and re-exported chats.
- **BACKUP-08:** Define fsync/directory durability for file-based settings snapshots.
- **BACKUP-09:** Run SQLite integrity and foreign-key checks on backup copies, in
  addition to file checksums; exclude runtime locks from restored ownership.
- **BACKUP-10:** Add barrier duration and event-loop impact to shared performance budgets.

## Suggested order and evidence limits

The review recommends shared A1/B1 inventory and measurements, independent B2/B3
portable features, gated A2/history pilot, offline B4, then metadata/operational
consolidation, encryption/automation, remaining justified migrations and recovery
drills. This is a proposed amendment, not a changed implementation schedule.

The reviewer read both design documents fully and relevant source sections, but
only inspected TODO children A3 and B4. It did not run benchmarks, reproduce a
two-device collision, inspect all attachment/GC paths, or test power-loss recovery.
Its shell policy prevented hashing the reviewed files.

The parent independently confirmed both hashes, Node `22.23.2`, bundled SQLite
`3.51.3`, the local `clientSeq` counter and server deduplication scope, and delta
coalescing before the per-record deduplication check. This is code evidence, not
a reproduced live multi-device incident.

Host verification passed four existing suites: `sdk-history-stream-coalesce`,
`chat-pending-remote-history`, `todo-claims`, and `delegation-contract`.
They validate existing behavior; they do not exercise the proposed migration or
remove the **FAIL** readiness verdict. No live data, settings, or product code changed.

## Plan amendments after the review

The parent amended both designs, added the [shared storage contract](storage-contract.md),
and rewrote both TODO plans and their subtasks on 2026-10-07. The hashes and FAIL above
describe the original reviewed versions. The amended versions have not received a
new independent verdict; the following is implementation responsibility and acceptance
tracking, not evidence that the planned behavior has been implemented.

| Finding | Amended decision and acceptance owner |
| --- | --- |
| DATA-01 | A1 compares JSON, main-thread SQLite and worker SQLite; numerical go/no-go, simplest passing variant or standardized stores; A3a/A6 repeat gates |
| DATA-02 | A1 caller inventory; A2/A3b/A4 convert callers and whole atomic commands together; no blocking worker facade |
| DATA-03 | A1/A2 freeze ACK classes, retained buffers and bounded fair group commit; A3a verifies durable versus provisional events |
| DATA-04 | A2/A3a command receipts commit with coalesced delta/revision; lost COMMIT response retry must not append twice |
| DATA-05 | A3a generation/chat/producer/clientSeq scope, coordinated tabs, receipts surviving trim and explicit legacy reconciliation |
| DATA-06 | Separate A3a history and A3b metadata; A3b requires accepted A3a and B4 offline recovery |
| DATA-07 | A1 registry raw validators; A3a/B1/B4 quarantine corrupt sources with raw digests and reject empty-loader repair |
| DATA-08 | A1 inventories all writers/cache invalidation; A2/A4/B6 enforce shared lease/gates and fixed lock order |
| DATA-09 | A2/A3b/A4/B4 preserve external high-water fencing; A6 rejects stale callbacks after migration/restore |
| DATA-10 | A1 runtime matrix; A2/B4 require Node >=22.16 and supported bundled SQLite before native backup |
| DATA-11 | A1/A5 retain the usage journal unless a separate measured gate justifies conversion; A6/B7 preserve totals and durability |
| DATA-12 | A3a durable revisions within generation/chat epoch; B4 fresh external generation; A6 stale replay/reset tests |
| BACKUP-01 | B4 stopped-server MVP; A2/B6 shared lease/gate/drain/flush/lock/fence/stage/release protocol; immutable-only hard links |
| BACKUP-02 | A1 owns the registry, B1 consumes; acyclic cross-tree dependencies; B4 restores original markers/readers before paused forward migration |
| BACKUP-03 | B1/B4 managed versus retained paths; external control directory and durable per-filesystem/per-path restore journal; mount-point drill |
| BACKUP-04 | B2 disables all imported executable/URL definitions; A4/B4/B6 external pause covers every automatic launch/delivery path; zero spawn/push tests |
| BACKUP-05 | A3a/B4 server rejects stale or missing generations on history HTTP/WS/replay; preserve legacy queues for explicit reconciliation |
| BACKUP-06 | B5 freezes authenticated chunk/header/final envelope and bounded KDF before implementation; tamper/truncation tests, private staging and encrypted pre-restore copies |
| BACKUP-07 | B2 digest/CAS under lock; B3 durable archive/source/options import map, deleted-target handling and re-export lineage |
| BACKUP-08 | B2 file fsync, rename and directory sync with documented platform constraints |
| BACKUP-09 | B4 staged SQLite integrity/FK checks and excluded runtime locks; B7 recovery drill |
| BACKUP-10 | A1 freezes barrier/event-loop budgets; B6 certifies all writers and measures staging under mixed load |

Persistence root: `cf4fed89-d3f5-4671-b7bc-fda919fba496` (A1–A6).
Backup root: `68f1c312-6399-4681-8dca-97090da5ab23` (B1–B7).
New history pilot A3a: `aadeac30-8fa8-4fab-a13b-4b945f0f5356`.
New metadata slice A3b: `c688a6a1-d03b-4169-8b09-af5ad9334e08`.
Both roots and all subtasks remain ideas; no human plan approval or execution was added.
