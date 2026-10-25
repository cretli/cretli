# Command receipts, idempotency and durable ACK (A2 S4)

Implementation: [`command-receipts.js`](command-receipts.js) on top of the storage
worker ([worker-protocol.md](worker-protocol.md)). Contract:
[storage-contract.md](../../docs/storage-contract.md) "History operations and
acknowledgements". Table: `command_receipts` in
[`schema/0001-core.js`](schema/0001-core.js) (no extra migration needed: the
primary key `(dataset_generation, command_id)` serves the lookup and the
`(dataset_generation, created_at)` index serves later retention).

## Pieces

| Where | API | Role |
| --- | --- | --- |
| both | `computeRequestDigest(name, payload)` | `sha256:<hex>` of `cretli-storage-receipt-v1 \0 name \0 canonicalJson(payload)` |
| worker | `withReceipt(handler, { maxResultBytes })` | wraps a synchronous command handler in the registry |
| worker | `RECEIPT_QUERIES` | spread into the registry's `queries`; provides `storage.receipt.lookup` |
| host | `executeCommand(host, { datasetGeneration, commandId, name, payload, priority, deadlineMs, signal })` | `{ result, replayed }` after COMMIT |
| host | `resolveUnknown(host, { datasetGeneration, commandId, name, payload })` | reconcile after `unknown_commit` |

`canonicalJson` first runs the strict wire serializer and parses it back (so
`undefined` members disappear, `-0` becomes `0`, non-JSON values are refused as on
the wire), then serializes objects with keys sorted by UTF-16 code unit at every
level. The digest does not depend on key order; it changes with any value, array
order or the command name. Golden digests in the tests pin scheme
`cretli-storage-receipt-v1`: changing the canonicalization or the scheme needs a new
`DIGEST_SCHEME` version **and** dual-read of receipts stored under the old one,
otherwise a retry across the change misses its receipt and applies twice.

Cost: canonicalization runs on the main thread in `executeCommand` /
`resolveUnknown` (strict serialize, parse, sorted serialize: three passes over a
payload of up to `maxRequestBytes`, 4 MiB by default) plus the host's own enqueue
snapshot. For multi-MiB payloads that is milliseconds of event-loop time per call;
keep receipt payloads small (references, not blobs). The worker computes its check
digest directly from the already-parsed wire payload (one pass).

## What runs inside the transaction

`executeCommand` sends `{ receipt: { v: 1, datasetGeneration, requestDigest }, payload }`
with `commandId` as the request's idempotency id. Inside the worker's
`BEGIN IMMEDIATE` transaction, `withReceipt`:

1. requires `ctx.commandId` and a valid envelope (handlers must be plain synchronous
   functions: `async`, generator and async generator functions are refused when
   `withReceipt` is called), and recomputes the digest from
   `ctx.name` + payload; a mismatch is non-retryable `io` (`receipt_digest_invalid`);
2. `SELECT`s the receipt of `(datasetGeneration, commandId)`:
   - same digest → returns the **stored** result, the handler does not run
     (`replayed: true`);
   - other digest → `conflict` with `details.conflictKind = 'receipt_digest_mismatch'`
     (`not_committed`). This is decided by comparing digests, never by catching a
     primary-key error;
3. runs the handler, serializes its result (cap `maxResultBytes`, default 256 KiB;
   above it `io` / `result_too_large`, rolled back), then `INSERT`s the receipt.

The receipt and the mutation commit together or not at all (both or neither): a
handler error, an oversized result or `SQLITE_FULL` leaves neither; a COMMIT that
fails with `unknown_commit` may have committed both, which `resolveUnknown` decides.
Two requests with the same `commandId` are serialized by the single worker
connection and the write lock (also across connections: a second host or process on
the same file waits on `BEGIN IMMEDIATE`, then sees the receipt), so the handler runs
at most once; the others replay.

### Handler context guard

Handlers are trusted in-repo code, but a handler that ends the request transaction
itself would make its mutation durable without the receipt. The context therefore
fails closed ([`handler-sql-guard.js`](handler-sql-guard.js)): `ctx.db.exec`,
`ctx.db.prepare` / `ctx.prepare` and every statement they return refuse to run while
no transaction is open (`io`, `operation: no_transaction`), and SQL containing
transaction control (`BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`, `RELEASE` anywhere
outside literals/comments/parameters, `END` at a statement start) is refused before
SQLite sees it (`io`, `operation: transaction_control`, non-retryable). `prepare`
accepts exactly one statement (node:sqlite would silently ignore the tail); `exec`
may run several, all scanned. The check is a conservative token scan, not a parser:
it refuses `INSERT OR ROLLBACK`, `ON CONFLICT ROLLBACK`, trigger bodies and bare
identifiers spelled like those keywords (quote them; triggers belong in
migrations). It cannot stop a handler that opens its own connection. A refusal
thrown inside the open transaction rolls it back (`not_committed`). If the
transaction still ended (SQLite auto-rollback swallowed by the handler, or a path
the guard does not see), the request is `unknown_commit` / `handler_transaction`
with `reconcilable: false`.

## Durable ACK

`executeCommand` resolves only when the host received the worker's success reply,
which the worker posts after COMMIT. That resolution is the durable ACK. A
`StorageError` rejection always carries `details.commitState` (`not_committed` or
`unknown`). One exception: a request aborted through its `signal` while still queued
rejects with the caller's own `signal.reason` (never dispatched, so never committed).
Anything shown before that (a provisional stream) is not an ACK. Group commit
([group-commit.md](group-commit.md), S5) runs several receipt commands in one
transaction with the same per-member receipt and ACK rules.

`executeCommand` sends its request with `requireReceipt: true`. The worker refuses
such a request to a handler that was not produced by `withReceipt` (it carries the
`RECEIPT_HANDLER_MARK` symbol) **before** `BEGIN`: `io` / `receipt_required` /
`not_committed`, non-retryable, nothing ran (F30). A reply that still is not a
receipt reply (only possible with a forged marker or a broken worker) is rejected
with `io` / `receipt_missing` / `commitState: unknown` / `reconcilable: false`: the
mutation may have committed without a receipt.

### Non-reconcilable outcomes

`details.reconcilable === false` (`handler_transaction`, `receipt_missing`) means the
receipt cannot decide the outcome: the mutation may be durable without one, so "no
receipt" does not prove `not_committed`. `resolveUnknown` refuses such a command with
`unknown_commit` / `operation: not_reconcilable` (`reconcilable: false`) instead of
answering, when the rejection is passed as `args.error` or the same host object
already reported it; `executeCommand` refuses to re-run it the same way. That memory
is process-local and bounded (4096 commands per host): callers persisting pending
work must persist `reconcilable: false` with it.

### COMMIT-time failure: the worker is recycled

When COMMIT fails after SQLite already ended the transaction (`unknown_commit`,
`operation: commit`), the frames may or may not be durable and this connection's view
can differ from what WAL recovery will find later. The worker closes the connection
**before** posting the reply (flagged `recycle: true`) and exits; the host treats it
as a worker loss and dispatches nothing to that thread. `resolveUnknown` therefore
runs on a fresh connection that re-opened the store (WAL recovery).

Its answer is authoritative only once that replacement connection has read the
receipt table; until then the caller must treat the command as unknown (no retry,
no "probably committed").

**Durability barrier (S4 review F29, bounded guarantee).** After a COMMIT-time **fsync**
failure the frames may exist only in the OS page cache, and WAL recovery on a new
connection would read them back. The requirement is deliberately **not** held in host
memory (a host or process can die before the recycle, or the recycle message can be
lost, and a fresh host would start with no memory of it). Instead **every** SQLite
worker start, with no opt-out, runs `PRAGMA wal_checkpoint(TRUNCATE)` under
`synchronous=FULL` before it reports `ready`: the WAL is fsynced, every frame is copied
into the database file, the file is fsynced and the WAL is reset. Only `busy = 0` with
every frame checkpointed counts as success. Any other outcome is a `start_failed`
(`io`, `operation: durability_barrier`, retryable): the host retries with its restart
backoff and, after `maxStartAttempts`, ends `failed`. No request — including
`resolveUnknown` and any later command — is served or acknowledged by a connection that
did not pass the barrier. Cost: one checkpoint per worker start (cheap on a clean WAL);
a long-lived reader in another process can make it `busy` and delay start.
Tests (`tests/storage-command-receipts-f29.test.js`, "F29") cover in-process success,
blocked/fail-stop behaviour, and a **real child process** that is SIGKILLed right after
the simulated COMMIT fault (no recycle ever reaches a replacement): the fresh host
checkpoints at startup, refuses ready/`resolveUnknown`/all writes while the barrier
fails, fails stopped when it never holds, and answers authoritatively once it holds.

Limits that remain: the fault is simulated (`faultInjection.commitFault`,
`durabilityBarrierFault`; COMMIT really runs or is rolled back, then `SQLITE_IOERR`
is raised, and the barrier failure is an injected error). A real disk fault, a kernel
that clears the page-cache dirty bit after reporting an fsync error, or power loss
during the barrier are not reproduced here; the child-process kill is a process crash, not a power loss, and no physical fsync/power-loss behaviour is certified. The barrier cannot recover data the
kernel already dropped; it guarantees that the replacement never *acknowledges*
state that its own successful checkpoint did not make stable.

## Retry protocol (normative)

1. Create `commandId` **before** the first dispatch and persist it with the pending
   work. Keep it, the dataset generation, the handler name and the payload unchanged
   across every retry.
2. Success → done (`replayed: true` means an earlier attempt already committed; the
   result is the stored one).
3. Rejection with `commitState: 'not_committed'`:
   - `retryable: true` (`busy`, transient `io`) → retry `executeCommand` with the
     same arguments, with backoff;
   - `retryable: false` → do not retry as-is (`conflict`, `full_disk`,
     `payload_too_large`, `result_too_large`, validation errors). A `conflict` with
     `conflictKind: 'receipt_digest_mismatch'` means the `commandId` was reused for
     a different request: a caller bug, never "already applied".
4. Rejection with `code: 'unknown_commit'` (`commitState: 'unknown'`):
   - `details.reconcilable === false` (`handler_transaction`, `receipt_missing`,
     `not_reconcilable`) → **never retry and do not trust "not committed"**: escalate
     (operator / repair of that handler); the mutation may be durable without a
     receipt;
   - otherwise the caller **MUST** call `resolveUnknown` with the same arguments
     (pass the rejection as `error`) before any retry. Never blind-retry.
   - `{ outcome: 'committed', result }` → treat as success with that result; do not
     re-run (a retry would only replay it);
   - `{ outcome: 'not_committed' }` → retry `executeCommand` with the **same**
     `commandId` and payload; it applies at most once;
   - `conflict` (`receipt_digest_mismatch`) → see step 3;
   - `resolveUnknown` itself failing (`busy`, `io`, host restarting) → retry
     `resolveUnknown`, still not the command.
5. A host in `failed` state rejects both calls; reconciliation resumes after the
   store is reopened (the receipt is durable on disk).

`resolveUnknown` runs a read-only query. Requests wait behind the host's worker
restart, and the replacement worker starts only after the lost thread exited, so
the query sees every transaction the lost worker committed.

Only one host per database file in a process may be reconciling: when `close()`
times out with a thread still alive (possibly inside a native COMMIT), that thread
is remembered per database file (`path.resolve(dbDir, filename)`; a symlinked
alias of the same file is not detected) and a new host's `start()` on the same file
rejects with retryable `busy` (`operation: previous_worker_alive`, nothing changes,
call `start()` again) until it exited. Another process on the same file is not
covered by this guard (single-writer ownership is S6).

## Retention

Trimming receipts is out of scope here (A3a). Whatever policy A3a adopts, a receipt
must outlive every possible retry of its command: the client retry window, a pending
unknown-commit reconciliation and any queue that can replay the `commandId`
(contract: receipts survive event trimming for the chat's lifetime). Dropping a
receipt early turns a safe retry into a double application.

## Out of scope

Coordinator / fencing (S6), migration runner (S7), receipt
retention (A3a), chat/history data and the recovery/delegation stores.
