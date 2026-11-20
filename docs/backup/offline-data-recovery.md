# Offline data backup and restore (B4 MVP)

CLI: `node scripts/cretli-offline-data.mjs <command>` — **the server must be stopped.**
Code: `lib/backup/offline/`. Contract: [storage-contract.md](../storage-contract.md),
design: [settings-backup-design.md](../settings-backup-design.md). Tests: `tests/offline-data-recovery.test.js`.

| Command | Effect |
| --- | --- |
| `backup --dest DIR` | Verified backup directory (`files/<rel>` + `manifest.json` written last). |
| `backup --dest DIR --encrypt [--include-secrets]` | Encrypted single-file backup `<id>.cretlibak` ([envelope v1](encrypted-envelope.md)); managed secrets only with `--include-secrets`. |
| `list --dest DIR` | Encrypted backups: id, date, profile, size, status (no passphrase needed). |
| `verify --backup DIR\|FILE` | Manifest format, safe registry-managed paths, SHA-256, SQLite checks (a `.cretlibak` also authenticates and decrypts). |
| `restore --backup DIR\|FILE --yes` | Verified pre-restore copy (encrypted for a `.cretlibak`), then journaled managed-path replacement. |
| `recover` | Roll an interrupted restore forward (also runs at server startup, before any store opens). |
| `rollback --yes-lossy` | Put the retained previous files back; loses writes made after the restore. |
| `finalize` / `resume` | Drop retained previous files + journal / clear the post-restore pause flag. |

Encrypted commands read the passphrase from `--passphrase-file PATH` (owner-only) or `CRETLI_BACKUP_PASSPHRASE`; `recover` needs it only to rebuild a lost decrypted stage. Options: `--data-dir`, `--control-dir`, `--high-water N` (external fence high-water).

## Guarantees

- **Ownership:** exclusive lease in the control directory; a live, foreign-host or unreadable lease is refused.
  Active or unknown writers (live `delegation-owner.lock`/front-end watcher pid, unreadable owner,
  `usage/.ledger.lock`, non-empty SQLite `-wal` or a `-shm`) are refused.
- **Plaintext staging:** encrypted operations stage plaintext only in an owner-only `staging/` area of the control directory;
  it is removed after each operation and swept after a crash (see [encrypted-envelope.md](encrypted-envelope.md)). The control directory
  can hold a plaintext stage of an unfinished encrypted restore; protect it with host disk encryption.
- **Managed secrets:** `mcp-secrets.json`, `mcp-integration-secret.json`, `push-subscriptions.json` and `widget-installations.json` are no
  longer written to plain backups (omission recorded); only an encrypted backup may carry them, and a restore of a backup that declares none
  keeps the destination's copies. Backups created before B5 (no `credentials` field) still restore as before.
- **Scope:** only `managedPaths` of `docs/storage-registry.json` are archived or replaced. Runtime locks
  (`*.lock`, `*.lock.sqlite`, `-shm`, sockets, pids) are excluded. Auth, TLS, harness homes, the backup
  destination, the control directory and unrelated files are never touched; a manifest naming them is rejected.
- **SQLite:** copied with the `node:sqlite` backup API from a cleanly closed database (never a bare copy of
  the main file); the staged copy and every restore stage must pass `integrity_check` + `foreign_key_check`.
  Requires Node >= 22.16 and bundled SQLite >= 3.51 (`checkStorageRuntime`).
- **Restore:** staging and rename happen next to each destination file (never the data root or a mount
  point). Journal in the control directory records `pending → prepared → displaced → replaced → verified`
  per path; recovery decides from disk state, so a crash after any step rolls forward. A failure while
  staging (e.g. full disk) aborts before any destination is touched. Managed files absent from the backup
  (including stale SQLite `-wal`) are removed, so an old backend marker is never mixed with new content.
- **Generation and pause:** the control directory (outside the payload) holds a fresh dataset generation and a
  fence above the source archive, the local state and `--high-water`. After restore the dataset stays paused until `resume`.
  `checkDatasetGeneration()` rejects missing/stale generations.

## Known gaps

- The server binds the control directory once at startup. While paused, delegation/recovery, Watcher/Scout,
  mailbox/outbox, title/archive jobs, schedulers and other automatic delegation-runtime boot work do not start;
  External HTTP history writes require the current
  `restoreGeneration` after a restore, exposed by `/api/settings` and `/api/health`; the browser stores that value
  when settings are loaded, sends it with history/delete requests, and performs one settings refresh + retry for a
  stale tab. Internal history writers are not subject to this HTTP admission check, and legacy callers remain
  accepted before the first restore.
- WebSocket and replay generation transport is not yet implemented. Pause coverage beyond delegation-runtime boot
  (including independent push/MCP paths) remains partial. Restore completion does not
  rewrite imported executable/URL definitions or reconstruct claims from arbitrary payload data. The runtime stays
  paused until an operator reviews the dataset and runs `resume`; interrupted work is handled by normal boot
  recovery after that review.
- Registered legacy readers and paused forward migration of pre-migration archives; only the current registry
  layout is restorable (unsupported formats fail before replacement).
- Online backups and scheduling (B6). Plain backups are directories; encrypted ones are single files (B5, [envelope v1](encrypted-envelope.md)).
- Cross-filesystem recovery copies and the pre-restore copy live under the control directory
  (`pre-restore/`), which is not pruned automatically.
