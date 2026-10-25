# Delegation store — architecture decision (2026-09-18)

Cretli remains a **single-host** application. Phase II does not introduce a
shared multi-region database.

## Decision

- **Default:** JSON files (`delegations.json`, `delegation-mailbox.json`) with
  a process owner lock. Compatible with existing deployments. Second writer is
  refused.
- **Transactional backend:** SQLite via Node 22 `node:sqlite` (WAL,
  `busy_timeout`, one transaction for status + outbox + attempts). Selected
  with `CRETLI_DELEGATION_STORE=sqlite` or after an explicit migration.
- **Not chosen:** Redis or a network SQL server. They would change the
  self-hosted single-process model without a measured multi-host need.

## Migration

`migrateDelegationsJsonToSqlite()` copies a backup, writes SQLite, verifies
full record content (canonical JSON hash, not only IDs and counts), then
leaves a JSON marker (`v: 4`, `backend: sqlite`) so older builds refuse to
rewrite the file. Re-running after a successful switch is a no-op and does
not delete existing SQLite rows. Checkpoints resume after a crash between
table copies or before markers. Migration and rollback take the exclusive
writer lock. Future SQLite schema versions are refused before any write.

Rollback merges the backup with any SQLite rows written after the switch. It
does not blindly restore the pre-migration snapshot.

Production rollout of SQLite is **not** part of this change. Operators keep
JSON until they migrate an isolated copy and switch the env flag.

## Reads and writes

Both backends answer the lookup accessors (`listDelegationsForChat`,
`…ForController`, `…ForRootChat`, `…ForTreeRoot`, `…ForWorkspace`,
`listActiveDelegations`, `findDelegationByChildChatId`,
`findDelegationByIdempotencyKey`) without parsing every row:

- **JSON:** one parse per file version, then in-memory indexes. A write
  re-seeds the cache with the rows it just wrote, so the next read does not
  re-parse. Every write still re-serializes the whole file.
- **SQLite (schema 4):** indexed lookup columns `root_chat_id`,
  `root_delegation_id` and `tick_relevant`, derived from the row by
  `lib/persist/delegation-index-fields.js`. Opening a schema 3 file adds and
  backfills them in one transaction; a newer schema is refused. Parsed rows
  are cached in-process by `(id, revision)` and dropped on every upsert. The
  workspace key resolves symlinks, so it is never stored: the reader computes
  it for each distinct `workspace_folder` (a handful) and fetches those folders
  by index, the same rule the JSON index applies per row. `tick_relevant` is a
  prefilter and the rule is re-checked on read. Mailbox lookups narrow by
  `to_chat_id`, `from_chat_id`, `delegation_id` and `idempotency_key`.

`tests/delegation-store-equivalence.test.js` asserts that both backends return
the same rows.

Stored rows are kept small: a delivered outbox item keeps only `attemptId`
and `eventId` of its snapshot (delivery never replays it; the reply lives in
the mailbox row), and `verifyResult.results[].outputTail` is kept only for
failing checks.

## Retention and compaction

`applyDelegationRetention` (run at boot) archives finished, fully delivered
jobs and trims old delivered mailbox bodies; the rules and guards are in
`docs/todo-review-contract.md` §11.1. To compact a store on demand:

```bash
node scripts/compact-delegation-store.js            # dry run, writes nothing
node scripts/compact-delegation-store.js --apply    # server stopped
```

`--apply` refuses to run while the server holds the owner lock, copies the
store to `data/backups/delegation-compact-<stamp>/` first and prints the sizes
before and after. Restoring that copy with the server stopped is the rollback.

## M12

A parallel executor pool stays an optional product decision. It is not
implemented here. Default `CRETLI_DELEGATION_REVIEW_FANOUT` is two concurrent
reviews (`=1` opts out). That is not the executor pool. Mutating jobs from two parents in the same
workspace are refused (`workspace_busy`). Optional
`CRETLI_DELEGATION_GLOBAL_LIMIT` caps occupied slots. Parent-loop rounds live
in `delegation-workflows.json` and are not a sequencer.
