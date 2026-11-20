# Chats SQLite schema: field profile and leaf-A measurements

Date: 2026-11-01. Leaf A of [storage-chats-metadata-decision.md](storage-chats-metadata-decision.md)
(sections 3, 4, 10-A, 12). Everything here is a number or a field **name**; no chat content, title,
path or id was copied from the profiled file.

## 1. How the profile was made

`scripts/profile-chat-fields.mjs --input <copy of chats.json>` reads a copy that lives outside the
active data directory (the script refuses a path inside it, symlinks included), splits every record
with the same `splitChat` the store uses, and imports the whole copy into an isolated temporary SQLite
file to compare the maintained counters with a reference `GROUP BY`. The copy had 11,482 chats and
11.2 MB.

## 2. Record sizes

| Measure | p50 | p95 | max |
| --- | ---: | ---: | ---: |
| whole record (JSON bytes) | 758 | 1,171 | 2,630 |
| `light_json` of the row | 115 | 175 | 255 |
| `chat_details` (extra + key order) | 417 | 917 | 2,331 |

Only `summaries` (2 records) is above 1 KiB at p95, so it is the only field the 1 KiB rule moves out of
`light_json`; it lives in `chat_details`. The measured maximum record (2,630 bytes) fits one 4 KiB page
without overflow, so no field needed a special exit.

## 3. Field to storage assignment

Presence is out of 11,482 chats.

| Storage | Fields (present) |
| --- | --- |
| key | `id` (11,482) |
| column | `title`, `cursorSessionId`, `createdAt`, `agentTransport`, `updatedAt` (11,482 each); `workspaceFolder` (11,411); `archivedAt` (10,973); `todoId` (8,337); `forkParentChatId` (6,111); `workspaceFile` (5,768); `widgetInstallationId`, `widgetPageSessionId` (72) |
| `light_json` | `sdkMode` (11,482); `titleSource` (11,477); `sdkUiMode` (11,473); `model` (11,059); `forkKind` (6,046); `lastFinishedAt` (999); `lastSeenAt` (520); `titleRev` (485); `watcherPinned` (287); `workspaceId` (109); `widgetPinnedUrl` (58); `isTemporary` (5) |
| `chat_details.extra_json` | `executionFolder` (7,386); `delegationParentChatId`, `delegationId` (5,936); `claudeSessionId` (4,294); `delegationDepth`, `delegationRootChatId`, `delegationRootDelegationId` (4,211); `delegationSessionIdentity`, `delegationSessionGeneration` (2,515); `codexThreadId` (1,916); `pickPurpose` (1,804); `sdkAgentId` (1,119); `deepseekSessionId` (328); `opencodeSessionId` (273); `qwenSessionId` (252); `codebuddySessionId` (246); `delegationAssignment` (126); `autoContextCompressionThreshold` (26); `delegationGrant` (11); `summaries` (2); every unknown field |

Columns that the plan keeps conditional on the profile:

- `status`: **not created**. No record carries such a field.
- `pinned`: **not created**. `watcherPinned` exists (287 records) but no list handler of this leaf filters
  on it, so it stays in `light_json` and costs no index.

Non-conforming field names: 0. All 11,482 records have the same single-segment key vocabulary.

## 4. Topology

| Measure | Value |
| --- | ---: |
| max `forkParentChatId` depth | 5 |
| fork roots | 5,374 |
| subtree rows per root (p50 / p95 / max) | 1 / 5 / 117 |
| widget partitions (installation, page session) | 6 |
| rows per widget partition (p50 / p95 / max) | 1 / 42 / 42 |
| distinct counter buckets (file, folder, archived) | 1,948 |
| legacy `file\nfolder` key collisions between buckets | 0 |

Consequences for the limits in the plan: the tree bound (depth 64, 3,200 ancestors) and the 10,000-row
subtree bound are far above the measured maxima (5 and 117); the 5,001-row widget scan bound is far above
the largest partition (42).

## 5. Counter parity on the copy

After importing all 11,482 chats into an isolated database: the `chat_scope_counts` table equals the
reference `GROUP BY` (0 mismatches over 1,948 buckets); total, archived and root counts equal the
reference `COUNT`s; the sum of `archivedCountsByWorkspace` equals the number of archived rows.

## 6. Query plans and statement counts

`tests/storage-chats-plans.test.js` pins, for global/folder/file/folder+file/widget x live/archived/all
and for `tree`, the exact list indexes a page uses (`INDEXED BY` plus `EXPLAIN QUERY PLAN`: only
`SEARCH ... USING INDEX`, never `SCAN chats` without an index or a temp b-tree), and that `counts` and
`archivedCountsByWorkspace` read `chat_scope_counts` only. Statement counts (executions and distinct
prepared texts) are identical at N = 1,000 and N = 50,000 for every read and write handler, and do not
change with the number of changed rows (archive of 1 vs 169 roots, import of 1 vs 200, remove of a leaf vs a
subtree). A single-chat change is 3 handler statements (joined read, `UPDATE chats`, meta), 4 when the
details change, plus 3 set-based statements when a counter bucket moves; the receipt wrapper adds its own
lookup and insert.

## 7. Bytes written per change (database + WAL)

Method (`tests/storage-chats-write-bytes.test.js`): a child process under an `LD_PRELOAD` shim that logs the
completed byte count of every `write`/`pwrite`/`pwrite64`/`writev`/`pwritev` call on the database and `-wal`
files (short writes and repeated overwrites of one offset are counted; a self-check pins 2,037 bytes for a
known sequence). One writer, page size 4096, autocheckpoint off, seed and a finished
`wal_checkpoint(TRUNCATE)` outside the window; the window is one full transaction plus a forced
`wal_checkpoint(FULL)` (busy = 0, every frame moved), so the whole checkpoint cost is attributed to the one
change. The `-shm` file is memory-mapped, not written by syscalls, and is outside DB + WAL bytes. 20 distinct
old rows per kind; `last_activity_at` moved to the head of the list.

Total bytes (db + WAL):

| Kind (list indexes the row is in) | N | median | p95 | max |
| --- | ---: | ---: | ---: | ---: |
| no workspace (1) | 1,000 | 32,896 | 57,544 | 73,976 |
| no workspace (1) | 50,000 | 32,896 | 32,896 | 57,544 |
| folder (2) | 1,000 | 49,328 | 82,192 | 90,408 |
| folder (2) | 50,000 | 49,328 | 73,976 | 73,976 |
| folder + file (3) | 1,000 | 57,544 | 82,192 | 90,408 |
| folder + file (3) | 50,000 | 90,408 | 131,488 | 156,136 |
| widget + folder + file (4) | 1,000 | 106,840 | 131,488 | 139,704 |
| widget + folder + file (4) | 50,000 | 82,192 | 123,272 | 131,488 |

Single operations (one widget + folder + file chat unless noted): title change 16,464; archive 90,408;
move to a new folder (new bucket) 49,328; remove the last chat of a bucket 57,544; add 73,976.

**The 64 KiB gate is not met for rows in two or more list indexes at p95.** The arithmetic is the cause:
every list index costs two dirty pages for a `last_activity_at` change (old and new position), the row and
the meta row cost two more, and every dirty page is written twice (a WAL frame of 4,120 bytes and the
checkpoint write of 4,096). A folder + file row therefore needs at least 8 pages = 65.8 KB before any leaf
balancing, a widget row at least 10 pages = 82 KB. Only rows in one list index (and title changes, which
touch no list index) stay under the limit at p95. In WAL-only terms (checkpoint amortised, which the ADR
names as a possible amendment) the same rows write 33 KB (3 indexes) and 41 KB (4 indexes) of WAL.

Owner decisions of 2026-11-02 (ADR 2.2) settle the gate: it counts the WAL bytes of the change plus its
amortized share of a forced checkpoint, with no index or page-size change. The amortized p95 limit is 96 KiB
(98,304 B) for the widget, folderFile, archive and add scopes; global, folder, title, newBucket, zeroBucket and
single-index chats stay at 64 KiB. `tests/storage-chats-write-bytes.test.js` asserts these limits as hard
checks and prints raw DB + WAL, amortized p95 and the applied limit per scope.
