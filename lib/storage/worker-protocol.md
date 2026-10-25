# Storage worker protocol (A2 S3)

Variant selected by A1 ([storage-backend-decision.md](../../docs/storage-backend-decision.md)):
SQLite in one worker thread with a bounded fair queue on the main thread.
Implementation: [`worker-host.js`](worker-host.js) (main thread),
[`sqlite-worker.js`](sqlite-worker.js) (worker thread),
[`fair-queue.js`](fair-queue.js) (scheduler), [`worker-wire.js`](worker-wire.js)
(shared name patterns and wire JSON). Gates: [storage-gates.md](../../docs/storage-gates.md).

## Invariants

- The worker owns the only read-write `node:sqlite` connection. It opens the store
  with `openStorageDb()`, so `foreign_key_check` and, unless a valid clean-shutdown marker vouches for the
  file, `integrity_check` run in the
  worker, never on the HTTP/WS event loop.
- One message = one whole transaction. The worker starts it, runs a **synchronous**
  handler, and ends it with COMMIT or ROLLBACK before replying. No transaction stays
  open between messages. An `async` handler is refused when the registry loads
  (`start_failed`); a handler that returns a thenable is refused at call time and
  rolled back.
- The main thread never sends SQL. It names a handler from a registry module whose
  absolute path is fixed at start (`handlersPath`, exporting `{ commands, queries }`).
- The host keeps **one** request in flight. The next request is dispatched only after
  the previous reply (or worker loss). A dispatch that fails on the host is rejected
  (`not_committed`) and the host immediately dispatches the next request.
- At most one worker thread exists at a time: after a loss the replacement is spawned
  only once the old thread has emitted `exit`, so a thread still inside a native COMMIT
  never runs next to its replacement.
- No synchronous facade, no blocking shared-memory wait (Atomics), no lock held across a foreign `await`.
  Every caller gets a Promise.

## Messages

Worker start data (`workerData`): `{ dir, filename, handlersPath, busyTimeoutMs,
maxResultBytes, faultInjection }`. The worker runs with `resourceLimits`
(default `maxOldGenerationSizeMb: 512`). `faultInjection` is a test seam: only when it
is `true` does the worker call the handler module's optional
`faultInjection.afterCommit(ctx, name)` after COMMIT and before the reply, and
`faultInjection.commitFault(ctx, name)`, which may return `'commit'` / `'rollback'` to
simulate a COMMIT-time I/O failure after the transaction ended.

Worker → host:

| Message | Meaning |
| --- | --- |
| `{ type: 'ready', schemaVersion, runtime, startPhases }` | Store open, checks passed, migrations applied, durability barrier done. `startPhases` = `{ registryMs, openMs, barrierMs }` timings; the host exposes them in `getMetrics().lastStart` together with `spawnToReadyMs` and `threadOverheadMs` (diagnostics only) |
| `{ type: 'start_failed', error }` | Open/handler-load failed; `error` = `StorageError.toJSON()` |
| `{ type: 'response', id, ok: true, resultJson, executeMs }` | Transaction committed (command) or read finished |
| `{ type: 'response', id, ok: false, error, executeMs }` | Failure; `error.details.commitState` is always set |
| `{ …response, recycle: true }` | COMMIT-time `unknown_commit`: the worker already closed its connection and exits; the host recycles it before dispatching anything else |
| `{ type: 'closed' }` | Database closed after `shutdown` |

Host → worker:

| Message | Meaning |
| --- | --- |
| `{ type: 'request', id, kind, name, priority, deadlineMs, commandId, requireReceipt, payloadJson }` | Run one handler (or one group-commit batch, `kind: 'batch'`) |
| `{ type: 'shutdown' }` | Close the database and exit |

- `id`: random UUID created by the host **before** the request is queued; stable for
  the request's lifetime. `commandId` is the caller's idempotency id (receipts: S4,
  `^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$`, so it survives the error-detail sanitizer),
  passed through to the handler as `ctx.commandId` and set as `details.commandId` on
  **every** StorageError of that request — host-side (invalid request, queue refusal,
  deadline, shutdown, dispatch failure, worker loss, malformed reply) and worker-side
  (`conflict`, `busy`, handler errors, worker `unknown_commit`). An aborted request
  rejects with the caller's own `signal.reason`.
- `name`: a handler name matching `^[A-Za-z][A-Za-z0-9_.:-]{0,63}$` (checked on the
  host **and** in the worker), or `ping` / `checkpoint` for `control`.
- `kind`: `command` (write, `BEGIN IMMEDIATE … COMMIT`), `query` (read transaction
  under `PRAGMA query_only`, always rolled back), `control` (`ping`, `checkpoint`
  = `wal_checkpoint(PASSIVE)`), `batch` (group commit, name `batch`, sent only by
  `host.commandBatch`: several receipt-wrapped commands in one `BEGIN IMMEDIATE`,
  each in a worker-issued savepoint, one COMMIT; payload
  `{ members: [{ name, commandId, payload }] }`, reply
  `{ committed, error, members: [...] }`; a member entry is `{ ok: true, resultJson }`,
  `{ ok: false, error }`, or `{ ok: false, notRun: true }` (plus
  `deferred: "result_budget"` when it only missed the shared reply budget and was
  rolled back to its savepoint); `host.commandBatch` refuses a member snapshot that is
  not exactly one JSON object; see [group-commit.md](group-commit.md)).
  A `batch` is a write: worker loss or an unreadable reply is `unknown_commit`.
- `requireReceipt` (command only, set by `executeCommand`): the worker refuses a
  handler without the `withReceipt` marker before BEGIN (`receipt_required`,
  `not_committed`).
- `priority` / `deadlineMs` are host scheduling data; the worker ignores them.
- `fenceEpoch` (optional non-negative integer, commands/batches/`fence` control): see
  [coordinator.md](coordinator.md). Checked inside the write transaction against
  `storage_fencing.hwm`; lower → `conflict` / `conflictKind: 'fenced'`, `not_committed`.
  Absent = no check. `control('fence')` reads the stored mark (with `fenceEpoch`: raises it).
- Payloads and results cross as JSON **text** (`payloadJson` / `resultJson`). The host
  serializes the payload **once at enqueue**: that text is the snapshot the worker
  commits (later mutation of the caller's object has no effect) and its UTF-8 length
  is the exact cost charged to the byte budget. Serialization is strict: BigInt,
  cycles, functions, symbols, `Map`, `Set` and binary values are refused
  synchronously with non-retryable `io` (`operation: payload_invalid`,
  `not_committed`) and nothing is queued. Top-level `undefined` becomes `null`.
- The worker serializes the result the same way **before** COMMIT; a result that is
  not plain JSON (`result_invalid`) or larger than `maxResultBytes` (default 4 MiB,
  `result_too_large`) rolls the transaction back (`not_committed`).
- Handler context: `{ db, prepare(sql), requestId, commandId, name }`; `prepare`
  caches statements (bounded); `name` is the handler name the request addressed
  (the receipt digest covers it). `db` is a guarded facade (`exec`, `prepare`,
  `isTransaction`, `isOpen`), not the raw connection: SQL with transaction control is
  refused (`transaction_control`), `prepare` takes one statement, and nothing runs
  while no transaction is open (`no_transaction`); see
  [receipts.md](receipts.md#handler-context-guard). Handler registries refuse
  `async`, generator and async generator functions at load.

## Errors and commit state

Errors cross `postMessage` only as `StorageError.toJSON()` and are revived with
`fromJSON()`; raw messages, paths, SQL and stacks stay in the worker. Constraint
violations keep `details.sqliteCode` / `details.constraintKind`.

Every rejected request carries `details.commitState`:

| `commitState` | Code | When |
| --- | --- | --- |
| `not_committed` | original code (`conflict`, `busy`, `io`, …) | Handler threw / returned a thenable / returned an unsendable result **while our transaction was still open** (rolled back), BEGIN failed, COMMIT failed with the transaction still open (rolled back), request invalid / expired / aborted / refused before dispatch, host-side dispatch failure, query or control lost with the worker |
| `unknown` | `unknown_commit` (not retryable) | Worker lost while a **command** was in flight (including a loss after COMMIT before the reply); COMMIT failed and SQLite had already ended the transaction (frames may be in the WAL; the worker is recycled, see below); the transaction ended inside the handler (`db.isTransaction` false after the handler, whether it returned or threw; `handler_transaction`, `reconcilable: false`); a command reply the host cannot parse; a committed reply that could not be posted |

The worker reads the commit state from SQLite (`db.isTransaction`) in every error
path rather than inferring it from where the exception came from. One exception: when
the handler throws a native SQLite error after which SQLite rolls the whole
transaction back by itself (`SQLITE_FULL`, `SQLITE_IOERR`, `SQLITE_BUSY`,
`SQLITE_NOMEM`, `SQLITE_INTERRUPT`), the ended transaction is that automatic
rollback, so the request is `not_committed` with the mapped code (e.g. `full_disk`). Execution and
reporting are separate: if posting the reply fails after COMMIT, the worker posts a
minimal `unknown_commit`; if that fails too, the thread exits and the host reports
the loss as `unknown_commit`.

Handlers no longer get the raw connection, so they cannot COMMIT, open a new
transaction or write in autocommit mode through the context. Remaining limit: the
guard is a token scan (see receipts.md) and cannot see a connection a handler opens
itself; trusted handler code must not do that.

COMMIT-time `unknown_commit` is fatal for the connection: the worker closes it before
posting the reply (`recycle: true`) and exits with code 75; the host counts a worker
loss (crash-loop breaker and backoff apply), dispatches nothing more to that thread
and starts the replacement only after its `exit`, so the next request (a
`resolveUnknown` lookup) sees the state after WAL recovery.

`unknown_commit` is never retried by the host. The caller must reconcile through
the command receipt before any retry, otherwise a mutation could apply twice:
see [receipts.md](receipts.md) for `executeCommand` / `resolveUnknown` and the
retry protocol.

## Queue and priorities

Classes, highest first: `stop`, `claim`, `intent`, `final`, `normal` (default).
The A1 gate ([storage-gates.md](../../docs/storage-gates.md), group commit) is:
**"Priority bypass: Stop, claims, intents, final flush — never starved > 500 ms"**,
together with the interactive budget "SQLite worker queue wait + execute"
p95 80 ms / p99 180 ms. The scheduler protects the priority classes first.

Algorithm (strict priority with a bounded aging bypass):

1. Every class is a FIFO; a dispatch compares at most five class heads.
2. Default pick: the head of the **highest** non-empty class (strict order).
3. A head that has waited at least `agingMs` (default 250 ms) is *aged*. Each strict
   dispatch that passes over an aged head of a **lower** class increments a counter.
   When the counter has reached `bypassEvery` = K (default 4) and an aged lower head
   exists, the oldest aged lower head (arrival order) is dispatched instead and the
   counter resets to 0. So at most one bypass is served per K strict dispatches that
   passed over aged work, and never before a lower request has aged.

Worst-case bounds, with S = the longest single transaction and one request in flight:

- A request at the head of its class waits for the in-flight transaction, **at most
  one bypass** and requests of strictly higher classes. For `stop`: `<= 2 × S` plus
  earlier `stop` requests (FIFO). Lower-class backlog of any size or age can delay a
  higher class by one bypassed transaction at most, so Stop/claim/intent/final stay
  well under the 500 ms gate as long as single transactions stay short.
- Under continuous higher-priority load an aged lower head is served within K + 1
  dispatches after it ages: the lower classes together keep at least 1/(K+1) of the
  dispatch slots. A lower request with n aged lower requests ahead of it waits at most
  `agingMs + (n + 1) × (K + 1) × S`.
- Honest limit: under **sustained priority overload** (priority requests arrive faster
  than the worker drains them) a normal request with a long backlog ahead of it can
  still wait a long time. The hard bound is `maxQueueAgeMs` (or its own `deadlineMs`):
  it then expires with retryable `busy` (`operation: deadline`), never dispatched,
  so never committed. `maxQueueDepth` refuses the excess up front.

Bounds (backpressure, never unbounded growth):

| Option | Default | On overflow |
| --- | ---: | --- |
| `maxQueueDepth` | 1024 | immediate `busy` (retryable, `not_committed`, `operation: queue_depth`) |
| `maxQueueBytes` | 16 MiB of payload JSON | immediate `busy` (`operation: queue_bytes`) while the request could fit later |
| `maxRequestBytes` | 4 MiB (never above `maxQueueBytes`) | immediate non-retryable `io` (`operation: payload_too_large`, `not_committed`), also on an empty queue: it can never fit |
| `maxResultBytes` | 4 MiB | handler result refused before COMMIT (`result_too_large`, rolled back) |
| `maxQueueAgeMs` | 5000 ms | `busy` when it expires before dispatch (`operation: deadline`) |
| per request `deadlineMs` | – | same as above, whichever is earlier |
| per request `signal` (AbortSignal) | – | validated **before** enqueue (anything else: `io`, `invalid_request`, nothing queued); removed from the queue, rejected with `signal.reason`; ignored once dispatched (the request settles with its real outcome) |
| `maxExecutionMs` | 30000 ms | worker terminated as a loss (see below) |
| `agingMs` / `bypassEvery` | 250 ms / 4 | scheduler parameters above |

## Lifecycle

1. **start**: `host.start()` spawns the worker; it loads the handler registry, opens
   the store and posts `ready` (resolves `start()`) or `start_failed`. Requests made
   before `ready` wait in the queue.
2. **ready**: requests are dispatched one at a time by key order.
3. **drain / shutdown**: `host.close({ timeoutMs })` refuses new requests
   (`io`, `operation: shutdown`), lets the queue drain until `timeoutMs`, then rejects
   whatever is still queued (`not_committed`). An idle worker gets `shutdown`, closes
   the database and exits; a worker still executing at the timeout is terminated and
   its in-flight command becomes `unknown_commit`. Concurrent `close()` calls share
   one shutdown. Closing a never-started (or failed) host rejects queued requests at
   once. A pending restart timer is cancelled. `start()` after `close()` rejects.
   If a thread has still not exited when `close()` returns (e.g. blocked in native
   code), it is registered per database file and a new host's `start()` on the same
   file in this process rejects with retryable `busy` (`previous_worker_alive`) until
   that thread exited.

## Crash / restart

Worker loss = `error` event, `messageerror` (a reply that cannot be deserialized),
unexpected `exit`, `start_failed`, or the execution watchdog firing.

1. The in-flight request (at most one) is rejected immediately:
   `command` → `unknown_commit` / `commitState: unknown`; `query` / `control` →
   retryable `io` / `not_committed` (they have no durable effect). Error messages carry
   a fixed host label only, never the raw worker error text.
2. The lost thread is terminated; the restart decision waits for its `exit`.
3. Queued requests were never sent, stay queued and keep their deadlines.
4. The worker is restarted after `min(max, initial × 2^n)` ms (default 50 ms … 2 s),
   where `n` counts consecutive losses without any reply (success or typed error) plus
   failed starts. A new worker re-opens the store (WAL recovery and integrity checks
   run again).
5. A start failure with `corrupt`, `conflict`, `unsupported_runtime`, `missing`,
   `full_disk` or any non-retryable code, or `maxStartAttempts` (5) consecutive
   failed starts, moves the host to `failed`: queued and new requests are rejected
   with that error (`not_committed`).
6. A synchronous `new Worker()` failure (e.g. `ERR_WORKER_INIT_FAILED`) is `io`
   (`operation: worker_spawn`): from `start()` it rejects `start()` and fails the
   host; during a restart it counts as a failed start with backoff.
7. Crash-loop breaker: `maxWorkerLosses` (5) losses of a ready worker within
   `workerLossWindowMs` (60 s) move the host to `failed` with non-retryable `io`
   (`operation: worker_crash_loop`).

## Metrics

`host.getMetrics()` returns counts and timings only (no payloads, names or paths):
state, restarts, start attempts, in-flight age, queue depth/bytes/depth per
class/oldest age, dispatched queue-age p50/p95/p99/max over a rolling window, worker
execute time (`executeMs`) and per-request queue wait + execute (`requestMs`, the gate
measure) as n/p50/p95/p99/max/sum, queue counters (dispatched, bypassed, rejectedBusy,
rejectedTooLarge, expired, removed) and host counters (completed, failed,
unknownCommit, workerLost, expired, aborted, rejectedBusy, rejectedInvalid,
dispatchFailed).

The literal A1 numbers (steady queue age p95 <= 200 ms, burst max <= 2000 ms) depend
on the disk's fsync latency and are measured on request (`STORAGE_GATE=1 node --test
tests/storage-worker-host.test.js`); the regular suite asserts disk-independent
properties (no rejections, queue age bounded by worker execute time plus host
overhead) and the event-loop budget.

## Out of scope here

Receipts and idempotent replay live in [receipts.md](receipts.md) (S4), group
commit in [group-commit.md](group-commit.md) (S5). Maintenance coordinator / fencing / restore pause (S6), migration runner (S7).
