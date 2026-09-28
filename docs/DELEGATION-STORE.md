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
leaves a JSON marker (`v: 3`, `backend: sqlite`) so older builds refuse to
rewrite the file. Re-running after a successful switch is a no-op and does
not delete existing SQLite rows. Checkpoints resume after a crash between
table copies or before markers. Migration and rollback take the exclusive
writer lock. Future SQLite schema versions are refused before any write.

Rollback merges the backup with any SQLite rows written after the switch. It
does not blindly restore the pre-migration snapshot.

Production rollout of SQLite is **not** part of this change. Operators keep
JSON until they migrate an isolated copy and switch the env flag.

## M12

A parallel executor pool stays an optional product decision. It is not
implemented here. Default `CRETLI_DELEGATION_REVIEW_FANOUT` is two concurrent
reviews (`=1` opts out). That is not the executor pool. Mutating jobs from two parents in the same
workspace are refused (`workspace_busy`). Optional
`CRETLI_DELEGATION_GLOBAL_LIMIT` caps occupied slots. Parent-loop rounds live
in `delegation-workflows.json` and are not a sequencer.
