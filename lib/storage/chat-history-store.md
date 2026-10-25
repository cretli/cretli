# Incremental chat history pilot (A3a)

Offline import of legacy history files and the rollback export (which preserves writes
made through this store) are documented in
[`docs/storage-history-migration.md`](../../docs/storage-history-migration.md); they are
standalone tools, not part of this facade.

Implementation: [`chat-history-store.js`](chat-history-store.js), schema
[`0003-chat-history.js`](schema/0003-chat-history.js). This is an opt-in library:
the server, routes, harnesses and existing history files still use
`lib/persist/chat-history-persist.js`. No data migration or production cutover is
included. A1 selected the existing single-worker implementation in
[storage-backend-decision.md](../../docs/storage-backend-decision.md).

The module exports the synchronous worker `commands` and `queries` registry plus
the asynchronous `createChatHistoryStore` facade. The worker owns the connection,
transaction boundaries and WAL/FULL/foreign-key configuration. The facade never
opens SQLite, blocks on a worker or keeps a lock across an external await.

## Usage

```js
import { createStorageWorkerHost } from './worker-host.js';
import { createGroupCommitter } from './group-commit.js';
import { createChatHistoryStore } from './chat-history-store.js';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

mkdirSync(temporaryOrManagedDirectory, { recursive: true });
const host = createStorageWorkerHost({
  dbDir: temporaryOrManagedDirectory,
  handlersPath: fileURLToPath(new URL('./chat-history-store.js', import.meta.url)),
});
await host.start();
const committer = createGroupCommitter({ host });
const history = createChatHistoryStore({ host, groupCommitter: committer });

const identity = {
  datasetGeneration: 'generation-1', chatId: 'chat-1', chatEpoch: 'epoch-1',
};
const pending = {
  ...identity,
  producerId: 'queue-6f55f799',
  commandId: 'history:6f55f799:append:1',
  events: [{ clientSeq: 1, rec: { kind: 'localUser', text: 'Example message' } }],
};
const { result, replayed } = await history.appendEvents(pending);
// Persist the acknowledgement before removing the pending queue member.
const page = await history.readLatest({ ...identity, limit: 80 });
await committer.close();
await host.close();
```

The caller owns host/committer lifecycle. Without `groupCommitter`, the facade uses
`executeCommand` for each write. Supplying one uses its bounded buffer, 256 KiB
batch ceiling, 40 ms window and priority/fairness rules; see
[group-commit.md](group-commit.md). The facade itself has no pending-event buffer.
For group submission, `signal` and `deadlineMs` have the limits documented by the
committer. A caller must await an earlier operation before submitting a dependent
one, especially across priority classes or an uncertain commit outcome.

## Identity and durable results

Every operation carries `datasetGeneration`, `chatId` and `chatEpoch`. Writes also
carry a caller-created `commandId`; appends carry `producerId` and each input's
`clientSeq`. Missing legacy identities produce `conflict` with
`history_reconciliation_required`. An obsolete generation/epoch is
`history_stale_epoch`; a retired, fenced or previous-epoch producer is
`history_producer_fenced`. A reconnect validates those identities without writing.
Dataset generation and command IDs use the receipt alphabet and maximum length
of 128 characters. Chat, epoch and producer IDs use the same
letters/digits/underscore/dot/colon/hyphen alphabet, with an initial letter or digit,
and allow at most 200 characters. Reset enforces the generation receipt limit too,
so it cannot create an identity that later receipt commands cannot address.

Create and persist the command identity **before dispatch**. A browser queue uses
one random, persisted producer identity for its lifetime. Two devices replaying
that same queue/producer/clientSeq represent one input; independent queues use
different producers even when their numeric counters match. `clientSeq` is an
identity, not a requested server sequence or a sorting instruction. Server `seq`
allocation follows committed worker execution order across tabs and producers.

A server run/attempt needs a distinct persisted producer, for example
`run:<runUuid>:attempt:<attemptUuid>`. Allocate stable operation IDs before sending,
for example `hist:<attemptUuid>:append:<batchOrdinal>` and
`hist:<attemptUuid>:final:<ordinal>`, with an increasing input `clientSeq` within
that producer. IDs must fit the existing receipt alphabet and 128-character limit;
long external IDs should be mapped to a persisted UUID or digest. A restart must
reload the pending identities rather than inventing a new attempt for a retry.

Every write is receipt-wrapped: `(datasetGeneration, commandId, requestDigest,
result)` commits with its delta, state revision and dedupe rows. The promise
resolves `{ result, replayed }` after COMMIT. Repeating a command with the same
digest returns the original result without another mutation, even if history has
subsequently changed. A changed digest conflicts with
`receipt_digest_mismatch`; never change content behind an existing command ID.

For a different command ID, an existing
`(datasetGeneration, chatId, producerId, clientSeq)` returns its originally assigned
`seq` and revision with `duplicate: true`. Its input digest includes the record,
explicit creation time, epoch and coalescing mode; changed content is
`history_input_digest_mismatch`. Duplicates do not increment history revision.
The command result includes the current state plus
`accepted: [{ clientSeq, seq, revision, duplicate }]`; it does not copy entire
records into the receipt. Reading history supplies their retained content.

After `unknown_commit`, preserve the payload and call:

```js
const outcome = await history.resolveUnknown({
  ...pending, operation: 'appendEvents', error,
});
```

Use the same operation, identity, command ID and payload. `committed` supplies the
receipt result; `not_committed` permits retrying the original command. Stop that
stream's later submissions until reconciliation finishes. Non-reconcilable errors
need repair; see [receipts.md](receipts.md). A failed group flush retains its
members and stable IDs within the committer's documented bounds. On exhaustion or
process death, the caller's persisted queue remains necessary.

S4 review **F29** (a new connection reading page-cache-only WAL frames after a
COMMIT-time fsync failure) has a bounded mitigation (the A3a leaf reviews and tests were run; this is software review, not hardware certification):
every SQLite worker start runs `wal_checkpoint(TRUNCATE)` and does not report ready
until it fully completed, whether or not the previous host saw the failure (the
requirement is not held in host memory, so a process restart or a lost recycle cannot
skip it). A barrier that keeps failing leaves the host failed (no further ACK). See
[receipts.md](receipts.md) for the protocol and limits: process-kill is tested with a
real child process; physical fsync failure and power loss are not reproduced or
certified.

No provisional-stream API is exported. Socket text displayed before this promise
settles is explicitly non-durable and must remain visually/protocol-distinct from
an accepted-record ACK. Persisted-history notifications, final completion and
queue deletion belong after the durable result. Do not infer durability from a
sequence reserved in memory, a buffered member or a provisional stream callback.

## Commands and limits

| Method | Payload beyond identity and commandId | Behavior |
| --- | --- | --- |
| `appendEvents` | `producerId`, `events: [{clientSeq, rec, createdAt?}]`, optional `expectedRevision`, `coalesce` | Allocates sequence and input dedupe transactionally; merges eligible tail text; trims to the configured count. |
| `trim` | Optional `keepLast` (default 2000), `expectedRevision` | Changes the retention count and removes oldest event rows without rewinding sequence or deleting receipts/dedupe. |
| `reset` | `newChatEpoch`, optional `newDatasetGeneration`, `expectedRevision` | Clears current event rows, fences existing producers and starts revision 0 / sequence 1 in a new identity pair. Retains receipts/dedupe and producer tombstones. |
| `retireProducer` | `producerId`, optional `mode: 'retired' \| 'fenced'` | Prevents new inputs from that producer, including one not yet registered. Does not delete its tombstone, receipts or dedupe. |
| `reconcileLegacyQueue` | `reviewed: true`, stable `reconciliationId`, fresh `producerId`, `events`, optional `expectedRevision`, `coalesce` | Explicitly accepts a reviewed old queue, assigns fresh client sequences, preserves old counters as metadata and returns `historicalDedupeCertain: false`. |

`expectedRevision` is CAS against the current revision; stale values fail with
`history_revision_mismatch` and leave no partial delta or receipt. Replaying an
already committed command returns its receipt before checking CAS again.

Appends accept at most 256 input events. A stored record, including coalesced
text, is limited to 256 KiB (`HISTORY_MAX_RECORD_BYTES`). The command payload limit
is 64 KiB for multi-event commands and 264 KiB (`HISTORY_MAX_SINGLE_EVENT_COMMAND_BYTES`,
record cap + 8 KiB envelope) for a **single-event** command, so a 64–256 KiB record
(for example a large tool result) stays saveable after caller conversion, exactly as
with the legacy adapter. The facade and the worker handler apply the same budget.
**Large-record policy:** a record above 256 KiB is never accepted inline: the regular
`appendEvents` still refuses it atomically (`history_command_too_large` /
`history_record_too_large`, no truncation, no silent loss). A record from 256 KiB up to
`HISTORY_MAX_LARGE_RECORD_BYTES` (3 MiB stored wire JSON, including the store-added
`clientSeq`) uses the **fragment protocol** below; above 3 MiB it is refused atomically.
A group committer feeding this store must be created with
`maxMemberBytes: HISTORY_GROUP_MAX_MEMBER_BYTES` (280 KiB-class); the oversized member
then ships alone in its own batch. Without it, a record above ~246 KiB is refused by the
committer as `payload_too_large` (non-retryable, `not_committed`). The bounds cap work
in one synchronous worker handler; they do not promise a hardware-independent
execution time. Oversized operations fail atomically with
`history_invalid_events`, `history_command_too_large` or
`history_record_too_large`. Bulk migration, archival and user-interface formatting
stay outside these interactive commands.

Coalescing uses the existing SDK text/thinking delta and cumulative-snapshot merge
helpers, preserves the retained tail's sequence and only merges the same producer
and stream kind. Each unique merged input still increments the durable revision.
The input dedupe row remains separate even when several inputs share one event
sequence. When a merge would exceed 256 KiB the input is **not** merged: it is
stored as a new event (new sequence), so streamed content is never lost or refused
for growth alone; the tail keeps its content.

The legacy retention default and maximum are 2000 retained event rows. Smaller
counts, including zero, are explicit policy changes through `trim`; there is no
implicit increase of the legacy limit. `nextSeq` remains monotonic within the
generation/epoch after trimming, including trimming everything. Dedupe, command
receipts and producer tombstones survive event retention and producer retirement.
This pilot deliberately exposes no pruning API: their disk growth is a known
cost until a separately verified retirement/deletion policy is implemented.

Reset changes transcript identity; revisions and sequence numbers are comparable
only within a `(datasetGeneration, chatEpoch)` pair. A same-generation reset still
requires a new epoch and fresh producer identity. Reusing a historical pair is
refused. A receipt replay after reset describes the earlier committed operation;
it cannot repopulate the new transcript. Dataset-wide restore generation rotation
belongs to the external coordinator/restore protocol, not this per-chat reset.

Old queues without generation/producer identity are never stamped and replayed
automatically. `reconcileLegacyQueue` requires an explicit reviewed decision and a
fresh producer. It preserves `legacyClientSeq` and `reconciliationId` on accepted
records; historical duplicate detection is explicitly uncertain. Retrying the
same reconciliation command replays its receipt. A new command cannot reuse the
registered reconciliation producer. Source quarantine/import and user consent UI
are outside this library.

`reviewed: true` is a trusted caller assertion, not an authorization token. Callers
must authenticate chat ownership and obtain the active dataset generation from a
trusted coordinator before writing or reconciling. This slice adds no endpoints
or caller authentication flow. Epoch tombstones in `chat_history_epochs` prevent
identity-pair reuse even when a reset epoch never received events or producers.

## Reads and pagination

`readRevision(identity)` returns state or `null`. `readPage` accepts exclusive
`afterSeq` / `beforeSeq` bounds and `limit` (default 1000, maximum 2000).
`readLatest` defaults to 80 rows. Pages are also **byte-bounded**: the serialized
`events` never exceed `HISTORY_READ_RESULT_BYTE_BUDGET` (4 MiB − 256 KiB, below the
worker's 4 MiB `result_too_large` limit; an optional smaller `byteBudget` is
accepted). Whole events are kept in scan order until the next one would not fit and
`hasMore` is set, so a window of large records returns a shorter page instead of a
non-retryable error. Every page contains at least one event (a record is capped far
below the budget), so keyset cursors (`beforeSeq` = first returned seq, `afterSeq` =
last returned seq) always make progress. Sizes are measured as UTF-8 bytes of the
stored JSON; the first pass reads only lengths, so a cut window is never
materialized. Results contain ascending-sequence `events`,
`headSeq`, `revision`, `trimmedThroughSeq`, retention information and `hasMore` for
the requested direction. A before-only/latest query selects the newest matching
window; `readPage` with an after bound selects the oldest matching forward window. Reads
are read-only transactions without receipts.

Keyset cursors do not shift when concurrent appends add newer rows. Separate
page requests are separate snapshots: trimming can remove older rows, and later
coalescing can change a previously read row while keeping its sequence. Poll
revision independently of `headSeq` and refresh the latest window when revision
advances without a new sequence. Include epoch/generation in every persisted
cursor; stale cursors must reconcile rather than compare sequence alone.

This library returns exact event windows. The legacy HTTP adapter's stream/turn
boundary extensions, usage summaries, exact-seq endpoint, socket notifications and
session-ID metadata remain its responsibility until callers migrate together.

## Verification and benchmark

`tests/storage-chat-history-store.test.js` uses isolated temporary databases and
real worker hosts for receipt replay/restart, producer dedupe, concurrent sequence
allocation, retention, epochs, reconciliation, CAS, coalescing and pagination. It
is registered in the audited review-verify catalog.

## Stage 2a additions (metadata, fork, delete, list, usage)

Schema v4 ([`0004-chat-history-metadata.js`](schema/0004-chat-history-metadata.js))
adds `chat_history_meta` and `chat_history_event_extra`; the contract is in
[storage-history-migration.md](../../docs/storage-history-migration.md) (C-3).

| Method | Kind | Behavior |
| --- | --- | --- |
| `appendEvents` + `cursorSessionId` | command | A non-empty value replaces the stored cursor (<= 4096 bytes, `history_invalid_cursor_session`). Any change to the chat clears the preserved `updatedAt` string and a deletion tombstone. |
| `deleteChat` | command | `{ datasetGeneration, chatId, newChatEpoch }` (no epoch needed). Tombstone: new epoch, producers fenced, events and event/document metadata removed; receipts and dedupe stay. Idempotent. |
| `copyChat` | command | `{ datasetGeneration, sourceChatId, targetChatId, targetChatEpoch, targetCursorSessionId?, upToCreatedAt? }`. Keeps `seq`/`headSeq`, strips `clientSeq`, runs as one `INSERT..SELECT` (<= 64 MiB, `history_copy_too_large`), replaces an existing target under the new epoch. Rows belong to the retired producer `fork-copy`. |
| `readSeqs` | query | Stored (possibly coalesced) records by `seq`, byte-truncated like a page. |
| `listHeads` | query | Keyset pages of `{ chatId, headSeq, updatedAt }`, <= 500; tombstones skipped. |
| `readUsage` | query | Usage summary computed in the worker. |
| any read with `anyEpoch: true` | query | Legacy-semantic read that needs no epoch; the result carries the current identity, `cursorSessionId`, `updatedAt`, `deleted`, `oldestSeq`. |

Run `node scripts/storage-chat-history-bench.mjs` manually (outside unit tests,
OS temporary directories only; `tests/storage-chat-history-bench.test.js` smoke-runs
it at `CRETLI_BENCH_SCALE=20`). It runs all four A1 workloads at their A1 shapes
(small 10x50x1, medium 100x200x1, growing 20x50x40 rounds, mixed 50x120x3 rounds;
seeded like the A1 harness, 2000-event retention, receipts and dedupe active) with 64
concurrent appends through the group committer, seeded interleaved reads, a
200-command burst and a bounded Stop/claim/intent priority probe, and prints a
gate table where every row has n, method, budget and PASS/FAIL/UNVERIFIED (too few
samples is UNVERIFIED, never PASS). Budgets are the frozen `storage-gates.md`
values. The public summary of the last run is
[`docs/storage-a3a-validation-report.md`](../../docs/storage-a3a-validation-report.md).

Startup is reported as separate numbers: `startupReplay` (frozen A1 method: a
thread that already exists closes and reopens through the production
`openStorageDb()` + `runWalTruncateBarrier()`, then reads one cold page), the same
budget with the WAL-present barrier-inclusive cost taken from real host starts, and
`endToEndStart` (full `host.start()` with per-phase timings from the worker `ready`
message, `host.getMetrics().lastStart`; diagnostic). I/O is the frozen A1 method
(db+wal+shm growth across the final FULL checkpoint vs JSON rewrite bytes); Linux
`/proc/self/io` `write_bytes` is a labelled physical-I/O diagnostic and is never
substituted. FULL checkpoint p99 is reported for an idle worker and for a
checkpoint fired while a batch is in flight, from a side connection in a bench
thread. The priority probe is a proxy (history appends with those storage
priorities); the real callers are not migrated. The JSON comparison uses the same
records and append calls, legacy pretty-printing/retention and temp-write/file-fsync/
rename/directory-fsync durability. A run is not production rollout approval or
permission to cut over callers.

## Large records (fragment protocol, schema v6)

Limits that did **not** change: regular command 64 KiB, single-event command 264 KiB,
group batch 256 KiB, worker request/result 4 MiB, `HISTORY_MAX_RECORD_BYTES` 256 KiB for
inline appends. The large cap is its own constant (`HISTORY_MAX_LARGE_RECORD_BYTES`,
3 MiB: it fits the 2,686,612-byte largest legacy record and leaves headroom under the
4 MiB worker result; `HISTORY_READ_RESULT_BYTE_BUDGET` is 3.75 MiB, so one finalized
record always fits one read result). Nothing claims support for arbitrarily large future
events.

Commands (all receipt-wrapped; codec and constants in
[`history-large-record.js`](history-large-record.js)):

| Method | Payload beyond identity and commandId | Behavior |
| --- | --- | --- |
| `stageFragment` | `producerId`, `clientSeq`, `index`, `count`, `totalBytes`, `sha256`, `data` | Stores one 32 KiB-raw fragment (strict base64, exact size per index) of the record's wire JSON under `(generation, chat, producer, clientSeq)` and the epoch it was staged in. Idempotent by content; a different fragment at the same index or a different header is `history_stage_mismatch`. Not history: no event, revision, sequence or chat row is created. |
| `appendEvents` with `events: [{clientSeq, large: {bytes, fragments, sha256}}]` | exactly one such event, no `rec` | Finalizes: checks epoch/producer/CAS like any append, reassembles the staged bytes, verifies length, SHA-256, strict UTF-8, JSON and the record contract, creates the event and the dedupe row and **deletes the staging in the same transaction** as the receipt. A duplicate `(producer, clientSeq)` is answered from the dedupe ledger without staging. A large event never coalesces. |
| `abandonStage` | `chatId`, `producerId`, `clientSeq`, optional `createdBefore` | Drops one stage (the `createdBefore` guard never removes a newer stage that reuses the key). |
| `gcSupersededStages` | `datasetGeneration` | Drops stages that can never be finalized: the chat is in another epoch/generation (reset, delete, fork replacement) or the producer is retired/fenced. A chat with no state row yet is **not** superseded. At most 256 per call (`more` says so). |
| `listStages` (query) | optional `after`, `limit` | Headers only, keyset paged. |

Refusals are `commitState: 'not_committed'`: `history_invalid_large`,
`history_stage_mismatch`, `history_large_missing`, `history_large_incomplete`,
`history_large_digest_mismatch`, `history_large_invalid`, `history_stale_epoch`,
`history_producer_fenced` and `history_stage_quota` (the only retryable one). Staging quota:
4 stages and 12 MiB per chat, 64 stages and 64 MiB overall, reserved by declared size at the
first fragment so a refusal leaves nothing behind. `reset`, `deleteChat` and a replaced `copyChat`
target delete the chat's staging in their own transaction.

Reads need no new API: a finalized record is an ordinary row, `readPage`/`readSeqs` stay
byte-budgeted (a page may hold fewer events than `limit` and reports `hasMore`; the first
event is always returned), `copyChat` keeps its 64 MiB ceiling and `readUsage` parses only
`usage`/`context_usage`/`status` events. Schema delta: migration
[`0006-history-large-staging.js`](schema/0006-history-large-staging.js) adds
`chat_history_stage` and `chat_history_stage_fragment` (forward-only; 0001-0005 untouched).
