# Group commit (A2 S5)

Implementation: [`group-commit.js`](group-commit.js) (main thread) on top of the
storage worker host ([worker-protocol.md](worker-protocol.md), request kind `batch`)
and command receipts ([receipts.md](receipts.md)). Gate:
[storage-gates.md](../../docs/storage-gates.md) (group commit: 256 KiB / 40 ms,
priority bypass for Stop, claims, intents, final flush, never starved > 500 ms).

## API

```js
const gc = createGroupCommitter({ host });
const { result, replayed } = await gc.submit({ datasetGeneration, commandId, name, payload, priority });
await gc.flush();   // flush now, resolves when nothing is buffered or in flight
await gc.close();   // flush, then refuse new members
```

`submit` takes the same arguments as `executeCommand` (without `signal` /
`deadlineMs`, see "Limits") and resolves with the same `{ result, replayed }`.
Only receipt-wrapped handlers (`withReceipt`) can be group members: the worker
refuses any other handler for that member (`receipt_required`, `not_committed`).

| Option | Default | Meaning |
| --- | ---: | --- |
| `maxBatchBytes` | 256 KiB | hard upper bound of one batch request text (member entries plus the 14-byte frame); also a flush trigger once the buffer fills it |
| `windowMs` | 40 ms | flush when the oldest buffered member waited this long |
| `maxBatchCount` | 256 | members per batch transaction (also a flush trigger) |
| `maxMemberBytes` | `maxBatchBytes` − 14 | one member's batch entry (`{"name","commandId","payload"}` + comma); above it `io` / `payload_too_large` (non-retryable). The default makes every member fit in a batch; a larger explicit value lets an oversized member ship **alone** |
| `maxBufferedBytes` / `maxBufferedCount` | 4 MiB / 4096 | buffered **plus in-flight** members; above it `busy` / `group_buffer` (retryable, `not_committed`) |
| `maxFlushAttempts` / `retryDelayMs` | 4 / 25 ms | dispatch attempts after retryable `not_committed` batch failures; delay doubles per attempt |
| `maxNormalWaitMs` | 200 ms | anti-starvation: a normal member that waited this long is no longer placed behind priority members (see "Limits") |
| `deadlineMs` | – | passed to the host for each batch request |
| `now`, `setTimer`, `clearTimer` | monotonic `performance.now`, unref'd `setTimeout` | test seams (injected clock); wall-clock jumps do not affect the window or the backoff |

## How a batch runs

1. `submit` validates and digests like `executeCommand`
   (`prepareReceiptCommand`), snapshots the receipt envelope with the strict wire
   serializer (later mutation of the payload has no effect) and buffers it. The
   `commandId` is the caller's, created before dispatch, and never changes across
   flush retries.
2. A flush sends ONE host request of kind `batch` with the member snapshots
   (`host.commandBatch`). The host schedules it like a command, at the priority of
   its highest member.
3. The worker runs `BEGIN IMMEDIATE`, then for each member: `SAVEPOINT`, the
   receipt-wrapped handler (digest check, receipt lookup/replay, mutation, receipt
   INSERT), `RELEASE`. Savepoints are issued by the worker on the raw connection;
   handlers still cannot issue `SAVEPOINT` (handler-sql-guard). One `COMMIT` ends
   the batch, then the worker replies `{ committed, error, members: [...] }`.
4. Each member promise settles from its own entry: success **only** when
   `committed: true` (durable ACK after COMMIT).

Two **lanes**, at most one batch in flight on each:

- the **main lane** carries any member; while it runs, new normal members buffer and
  the next main batch is formed when it settles;
- the **priority lane** carries only `stop` / `claim` / `intent` / `final` members. It
  is used when the main lane is busy: a priority member is dispatched at once as a
  priority-only batch next to the in-flight normal batch, never behind it.

So at most two batch requests are in the host at a time. The worker runs them one
after another on its single connection; the host queue orders them by priority.

## Ordering guarantees

- Normal members only travel on the main lane, in submission order inside a batch,
  and main batches run one after another, so two normal members commit in submission
  order (or the later one in a later batch) — except after a batch-level
  `unknown_commit`, see below.
- Members of the priority classes `stop`, `claim`, `intent`, `final` are placed
  **before** normal members of the same batch (the same reordering the host queue
  already applies between classes), unless the front normal member is aged
  (anti-starvation, "Limits"). All four classes are one group here, in submission
  order within a lane.
- **Priority may commit before earlier normal members.** A priority-lane batch can
  run (and commit) before a main-lane batch that was dispatched earlier, and two
  priority members on different lanes have no order between them. A caller that
  needs A before B must not mix classes for them, or must await A first.
- **After a batch-level `unknown_commit`** (worker lost, COMMIT outcome unknown,
  handler ended the transaction) the members that never ran are re-buffered and
  may commit **before** the `unknown` members ahead of them are reconciled with
  `resolveUnknown`; a reconciled member that turns out `not_committed` is then
  retried after them. Per-producer order is therefore not guaranteed across an
  unknown outcome. A3a callers that need strict per-stream order must stop
  submitting for that stream until its `unknown` members are resolved (the
  committer does not hold them back itself: it cannot know when the caller has
  reconciled).
- Several committers, or a committer next to direct `executeCommand` calls, give no
  ordering between each other. A caller that needs A before B awaits A.
- Members with the same `commandId` in one batch: the first runs, the later ones
  replay its receipt (same digest) or fail with `conflict` /
  `receipt_digest_mismatch` (other digest).

## Priority flush

A member of `stop` / `claim` / `intent` / `final` is dispatched synchronously inside
`submit` (no window, no timer): on the main lane when it is free (together with the
buffered members), otherwise on the priority lane. Only when **both** lanes are busy
does it wait, for the in-flight priority batch only (then it rides the next one).

Worst case before its own transaction starts, with both lanes considered:

1. the host-queue wait of a request at its priority: requests of a higher class
   queued ahead of it, plus the **one** request the worker is executing (a normal
   batch or a normal command cannot be overtaken mid-run). Normal traffic queued in
   the host — including the main-lane batch if it is still waiting there — does not
   count: the host's strict priority runs the priority batch first (its fair-queue
   aging lets an aged lower head pass at most once every `bypassEvery` higher
   dispatches, worker-protocol.md);
2. at most one earlier priority-lane batch (≤ `maxBatchCount` members, ≤
   `maxBatchBytes`).

So the bound is about: longest single request in the worker + one priority batch +
higher-class requests queued ahead. With short handlers that is far below the
500 ms gate; the test "commits a final member within 500 ms although normal traffic
is queued in the host…" measures it against ~750 ms of normal host backlog plus an
in-flight normal batch. Exception: during the backoff after a failed flush
(`retryDelayMs × 2^n`, at most 25 + 50 + 100 ms with the defaults) nothing is
dispatched, priority members included. A single long handler on the worker (up to
the host's `maxExecutionMs` watchdog) delays everything, priority included: keep
handlers short.

## Partial-failure semantics (decision)

**Per-member isolation through worker-level savepoints**, not whole-batch rollback.

Why: members are independent commands from different callers. Whole-batch rollback
would let one bad payload (a constraint violation, a handler bug, an oversized
result) fail unrelated commands, and their callers would have to retry work that
was fine. A member failure inside its savepoint leaves the rest of the transaction
exactly as if that member had never run, which is also what its caller would see
from `executeCommand`.

| Situation | Failing member | Other members |
| --- | --- | --- |
| Handler throws (any error, incl. constraint) with the transaction still open | rolled back to its savepoint; rejected with its own error, `not_committed`, no receipt | unaffected; committed with the batch |
| Unknown handler / not receipt-wrapped | refused before it runs (`unknown_handler` / `receipt_required`), `not_committed` | unaffected |
| Result too large for any reply (raw result JSON > the worker's `maxResultBytes`, or the receipt cap) | rolled back to its savepoint, `result_too_large` (non-retryable, permanent) | unaffected |
| Result fits alone but not in what is left of the **shared** reply budget (charged with the escaped bytes the result occupies once embedded in the reply) | rolled back to its savepoint, entry `notRun: true, deferred: "result_budget"`; re-buffered at the front, runs first in the next batch (where the first result is always accepted), no attempt counted | members before it: unaffected; members after it: not run, deferred the same way (order kept) |
| SQLite rolled the whole transaction back by itself (`SQLITE_FULL`, `IOERR`, `BUSY`, `NOMEM`, `INTERRUPT`) | rejected with the mapped code (e.g. `full_disk`), `not_committed` | members before it: same error, `not_committed` (their work was in the rolled-back transaction); members after it did not run: same error. Retryable codes are re-buffered, others rejected |
| A handler ended the transaction otherwise (outside the guard) | `unknown_commit` / `handler_transaction`, `reconcilable: false` | members before it: `unknown_commit` (reconcilable: their receipts were in the same transaction); members after it: never ran, re-buffered (`batch_aborted`) |
| `BEGIN` fails | – | whole batch `not_committed`; retryable errors re-buffered |
| A worker `SAVEPOINT` / `ROLLBACK TO` / `RELEASE` fails | that member rejected with the error, `not_committed` | transaction rolled back; others `not_committed` with that error, retryable ones re-buffered |
| A handler tries `RELEASE` / `ROLLBACK TO` of the worker savepoint through `ctx.db` | refused by the guard (`transaction_control`); if it throws, rolled back to its savepoint | unaffected (the savepoint stays intact) |
| `COMMIT` fails, transaction still open | – | rolled back, every member `not_committed` with the mapped error; retryable ones re-buffered |
| `COMMIT` fails after SQLite ended the transaction | – | every member that ran: `unknown_commit` (`operation: commit`); the worker is recycled (receipts.md) |
| Worker lost while the batch is in flight (crash, watchdog, exit), or a reply the host cannot read | – | **every** member `unknown_commit` (`worker_lost` / `response`) |
| Reply readable but malformed (member count, missing `committed`, a member entry without a revivable error / without a result, an unparsable or non-receipt result) | – | that member (or every member) `unknown_commit` (`response`), unless the batch reports `committed: false` with `not_committed`: then nothing is durable and the member is `not_committed` |
| Host refuses the batch before dispatch (`busy` queue limits, deadline, shutdown, host failed) | – | `not_committed`; retryable errors re-buffered, others rejected |

## Failure handling and retries

- **Failed flush keeps the buffer.** A batch-level failure that is `not_committed`
  and retryable puts its members back at the **front** of the buffer with the same
  snapshot and `commandId`, and the next dispatch waits for the backoff. The receipt
  makes the retry idempotent: a member that did commit in an earlier attempt can
  only replay. After `maxFlushAttempts` dispatches the member is rejected with the
  last error (still retryable, `not_committed`): the caller may retry with the same
  `commandId`.
- **`unknown_commit` is never retried here.** Each affected member rejects with
  `unknown_commit` carrying its own `commandId`; the caller runs `resolveUnknown`
  per member with the same arguments before any retry (receipts.md "Retry
  protocol"). `reconcilable: false` is kept only on the member that ended the
  transaction itself.
- A rejection that is not a `StorageError` is treated as `unknown_commit`; an
  error-shaped plain object is revived, and without `details.commitState` it is
  `unknown_commit` too.
- Settling can never leave a member hanging: if settling a batch throws, every
  member not settled yet is rejected `unknown_commit`, and the dispatch chain ends
  in a terminal catch (no unhandled rejection).

## Durability ACK

A member resolves only from a reply with `committed: true`, which the worker posts
after COMMIT returned. Nothing before that (buffering, dispatch) is an ACK; the
committer has no provisional channel. After a COMMIT-time `unknown_commit` the
outcome stays unknown until `resolveUnknown` read the receipt table on the
replacement connection (receipts.md).

## Backpressure and memory

Memory is bounded by `maxBufferedBytes` / `maxBufferedCount` (snapshots buffered or
in flight) plus one batch. Above it `submit` rejects at once with retryable `busy`
(`group_buffer`) and nothing is buffered. The host's own queue limits still apply to
the batch request (its text is at most `maxBatchBytes`, or one oversized member when
`maxMemberBytes` was raised above it).

## close()

`close({ timeoutMs = 5000 })` refuses new members (`io` / `shutdown`,
`not_committed`), flushes the whole buffer ignoring the window and the backoff, and
does not re-buffer failures (a retryable failure rejects). It resolves when nothing
is buffered or in flight, or after `timeoutMs`: then every member never dispatched
is rejected (`shutdown`, `not_committed`). A batch still in flight at the timeout
settles with its real outcome when the host settles it (closing the host turns it
into `unknown_commit`). `close()` does not close the host; concurrent calls share
one shutdown.

## Limits and known weak points

- No per-member `signal` / `deadlineMs`: a buffered member cannot be cancelled.
  The batch carries the committer's `deadlineMs`.
- Throughput is bounded by one transaction at a time (single worker connection); the
  second lane only lets priority members skip the queue, it adds no parallelism.
- Priority members wait for a pending retry backoff and, when both lanes are busy,
  for the in-flight priority batch.
- **Anti-starvation (frozen bound).** Once the front normal member has waited
  `maxNormalWaitMs` (200 ms), main-lane batches alternate normal and priority members
  starting with that normal member, so it is in the very next main batch however
  many priority members are buffered (> `maxBatchCount` included) or keep arriving.
  Bound for that member: `maxNormalWaitMs` + the in-flight main batch + its own
  batch (plus a pending backoff). The priority lane keeps serving priority members
  meanwhile, so their latency is not traded away.
- The whole batch reply shares the worker's `maxResultBytes` (4 MiB) budget, charged
  with escaped bytes; members that miss only the shared budget are deferred (never a
  permanent error). The first result of a batch is always accepted, so a reply can
  exceed `maxResultBytes` by up to the escaping of that one result (≤ about 2×
  `maxResultBytes` for a pathological result made of quotes/backslashes).
- `host.commandBatch` parses every member snapshot once on the main thread to prove
  it is exactly one JSON object (no injected members); the cost is bounded by the
  batch size.
- The SQLite auto-rollback classification follows the S3/S4 worker
  (`SQLITE_FULL` etc. end the transaction); if SQLite only aborts the statement, the
  failing member is isolated by its savepoint instead.
- Not wired into any caller yet.
