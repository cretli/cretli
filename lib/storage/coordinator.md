# Storage coordinator (A2 S6)

Implementation: [`coordinator.js`](coordinator.js). Schema mirror:
[`schema/0002-fencing.js`](schema/0002-fencing.js). Wire/worker changes: `fenceEpoch`
request option and the `fence` control op ([worker-protocol.md](worker-protocol.md)).
Contract: [storage-contract.md](../../docs/storage-contract.md), gates:
[storage-gates.md](../../docs/storage-gates.md).

## Control directory

Injectable (`controlDir`, absolute), e.g. `<dataDir>/storage-control/`. It must live
**outside every restore path** (backup/restore never replaces it), otherwise a restore
could roll the lease, the high-water mark (HWM) or the pause marker back.

| File | Content |
| --- | --- |
| `owner-lease.json` | `ownerToken`, `pid`, `pidStart`, `epoch`, `acquiredAt`, `heartbeatAt`, `expiresAt` |
| `fencing-hwm.json` | `hwm` = highest epoch ever granted (never lowered) |
| `restore-pause.json` | `pausedAt`, `epoch`, `pid`, `reason` (the marker) |
| `control.lock` | short exclusive-create lock around read-modify-write; carries `pid`, `pidStart`, `at` and a unique `token` |

Every write is `tmp (wx) → fsync → rename → directory fsync`. A `.tmp` is never read;
leftovers are swept under the lock. A damaged file (bad JSON / unknown `schema`) fails
closed with `corrupt` — it is never read as "no owner" or "HWM 0". This includes
schema-valid files with garbage fields: an HWM file without a finite non-negative integer
`hwm`, or a lease with an invalid `ownerToken` / `pid` / `epoch` (>= 1) / `expiresAt` /
`pidStart`. `acquire()` reads and validates the lease, HWM and restore-pause marker
**before** its first mutation, so a damaged file leaves no owner state and no lease behind.
Failed writes map to `io`/`full_disk` and leave the previous file intact. A write error can
also surface after the rename (only the directory fsync failed): the new content may already
be visible but is not known to be durable, so it is reported as `io`. That is deliberate;
every transition is monotonic (HWM first, lease keyed by owner token), so a retry or the
next owner converges.

## Lease

`acquire()` → `{ epoch, reason: created | renewed | takeover, previousEpoch, restorePaused }`.

- epoch = `max(lease.epoch, fencing-hwm, dbHwm) + 1`; the HWM file is raised **before** the
  lease is written, so a crash in between only skips an epoch (never reuses one).
- Takeover only when the owner pid is dead (liveness probe + `/proc` start-time check
  against PID reuse, from `lib/delegation-owner-lock.js`) **or** `now >= expiresAt`.
  A live, unexpired foreign owner gives `StorageError(busy)`,
  `details: { operation: 'acquire', conflictKind: 'owner_held' }` (no pid/path/token).
- `renew()` (auto-renew timer every `ttl/3`, `unref`-ed, cleared on release/loss) fences the
  coordinator for good when the lease is no longer its own or the HWM exceeds its epoch
  (`conflict` / `fenced`, `onLost` callback). `release()` deletes only its own lease and keeps
  the HWM. Clock, pid probe, timers and fs are injectable.
- Why `recovery-owner-lease.ts` is not imported: it stores the lease in `recovery.sqlite`,
  itself a restore target, and wants a `recovery-store`. Its semantics (created / renewed /
  takeover / owner_held, generation + 1) and the PID helpers are reused instead.

The lock is held only for a synchronous critical section of a few small file operations
(bounded on the main thread, ms-scale with fsync); never across an `await`. A contended
lock gives `busy` / `control_locked` (no spinning). The lock file carries a unique token and
the holder removes it afterwards only if the token still matches (a failed content write
removes the torn file at once). A lock is broken only when its holder is provably dead
(pid + start-time) or the file is torn/unparsable **and** older than `lockStaleMs` (mtime);
a lock whose holder is alive is never broken however old it is, so a stalled holder cannot
end up in the critical section together with another process. A holder stopped forever
(e.g. `SIGSTOP`) therefore blocks the control directory until it exits.

## Fencing

Every write carries `fenceEpoch`. In the worker, inside the write transaction right after
`BEGIN IMMEDIATE` (single command or whole group-commit batch): `epoch < storage_fencing.hwm`
→ ROLLBACK, `StorageError(conflict)`, `details.conflictKind = 'fenced'`,
`commitState = 'not_committed'`; `epoch > hwm` → the mirror is raised in the same
transaction. A request without `fenceEpoch` is unchanged (no check).

`coordinator.activate(host)` (async, after `acquire()`): reads the store mark via
`control('fence')`, bumps the epoch above it when the store was ahead (control dir lost/old),
otherwise raises the control HWM to the store mark, then raises the store mark with
`control('fence', { fenceEpoch })`. Without this a zombie could still commit until the new
owner's first real write. `reconcileHwm(dbHwm)` = `max(file, db)`.

`coordinator.guardHost(host)` wraps `command` / `commandBatch`: it injects the owner epoch
(a caller-supplied `fenceEpoch` is overwritten), refuses with `fenced` / `not_owner` /
`restore_paused` **before** queueing, and tracks in-flight writes. Pass the guarded host to
`executeCommand` / `createGroupCommitter`. Reads and control ops pass through.

`activate(host)` is **required** before the first guarded write: until it completed for the
current epoch the guard refuses writes with `conflict` / `not_activated` (`assertWritable()` /
`fenceOptions()` throw the same), so a new owner cannot commit before the store mark was
raised. A missing `storage_fencing` row (`readFencingHwmFromDb`, the worker's `fence` op and
fenced writes) is `corrupt`, never mark 0.

## Restore pause

`pauseForRestore({ timeoutMs, reason })`: persist the marker, then new writes get
`busy` / `restore_paused` (retryable) and the promise resolves after the in-flight writes
settle. `timeoutMs` must be a finite positive number (`TypeError` otherwise, nothing
written). The lease token/epoch is verified under the lock for `pauseForRestore` and
`resumeAfterRestore` (as for `renew`), so a zombie owner can neither write nor delete the
marker (`conflict` / `fenced`). Entries buffered inside a group committer are **not** drained
by the pause: they are not in flight yet and are refused with `busy` / `restore_paused` when
their flush reaches the guarded host (the committer keeps and retries them). On timeout it rejects `busy` / `drain_timeout` and the pause **stays**. The marker is
read at `acquire()`, at every `renew()` / auto-renew beat (`ttl/3`) and, cached for
`pauseCheckMs` (default 250 ms), before each guarded write, so a live owner observes a marker
written by another process within that window. The marker is also read at `acquire()`, so a successor after a crash starts paused (`restorePaused: true`) until
`resumeAfterRestore()`. After a restore call `activate(host)` again: the restored store may
carry an older mark.

## Known limits

- Fencing needs the writer to pass through `guardHost` (or set `fenceEpoch`); a raw host
  call without an epoch is not fenced. Handlers are not prevented from editing
  `storage_fencing` through the guarded SQL facade (A3/S8 should whitelist it).
- Between lease expiry and the zombie's next renew/write check the zombie is only stopped
  by the store mark (after `activate`), not by the file lease.
- `pauseForRestore` drains only this process. Another process's restore tool writes the marker
  and then must wait for the owner to stop (writes already past the guard are not waited for);
  the owner notices the marker within `pauseCheckMs` on its next guarded write, or at the next
  renew beat. A damaged marker makes guarded writes fail with `corrupt`.
- The `fence` control op with an epoch is a tiny write; a worker loss during it reports
  `not_committed` as for other control ops (it is idempotent and monotonic).
- Breaking a lock left by a dead holder (re-read, then `unlink`) still has a residual window:
  if two processes judge the same dead lock stale and the second unlinks the first one's fresh
  lock between its re-read and its unlink, both can enter. It needs a crashed lock holder and
  is not covered by a test. A durable fix would use an fcntl-style lock (not in Node) or a
  per-epoch claim file. Live holders are never broken (see above).
- Follow-ups not done here (review F7-F9, F15).
- Lease timing uses wall-clock time shared between processes; clock steps are not handled.
