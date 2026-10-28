# Backup and restore: recovery guide

Operator guide for the backup/restore features that exist in the code today. It does not describe
planned features; gaps are listed at the end and in [backup-acceptance-report.md](../backup-acceptance-report.md).
Design: [settings-backup-design.md](../settings-backup-design.md); contract: [storage-contract.md](../storage-contract.md).
Component references: [archive-profiles](archive-profiles.md), [settings-versions](settings-versions.md),
[conversations-export-import](conversations-export-import.md), [offline-data-recovery](offline-data-recovery.md),
[encrypted-envelope](encrypted-envelope.md), [online-backups](online-backups.md).

## 1. Choose the right tool

| Need | Tool | Server | What it covers |
| --- | --- | --- | --- |
| Move or snapshot non-secret configuration | Portable settings export/import (`/api/settings-backup/*`, Settings → Data and backups) | running | Classified settings and MCP definitions, JSON |
| Copy or archive chats | Conversations export/import (`/api/conversations-backup/*`) | running | Chats, retained history, optional attachments; imported as **new** chats |
| Disaster recovery of all managed data | Offline CLI `node scripts/cretli-offline-data.mjs` | **stopped** | Every path in `docs/storage-registry.json` |
| Same, encrypted, with optional secrets | Offline CLI with `--encrypt [--include-secrets]` | **stopped** | Single `.cretlibak` file |
| Scheduled unattended copies | Online backup (`/api/online-backup/*`) | running | **Disabled today** (see §5) |

## 2. What each profile includes and omits

| Profile | Includes | Omits (always) |
| --- | --- | --- |
| `portable-settings-v1` | Portable settings sections, MCP command/args/cwd/URL and env/header key *names*, definition-class values (staged, see §6), optional workspace ids and labels, allowlisted device preferences | Secrets, machine-local values (paths, LAN host), unclassified keys, env/header values. Each omission is listed with a reason code |
| `conversations-v1` | Selected chats, retained transcript events, attachments (optional), Markdown reading copy (optional, never importable), lineage and omission list | Native harness session ids, widget bindings, TODO/delegation ids, trimmed events, unsynchronized browser queues |
| Offline data backup (plain directory) | All registry-managed files; SQLite stores copied with the SQLite backup API; SHA-256 per entry | Managed secrets (`mcp-secrets.json`, `mcp-integration-secret.json`, `push-subscriptions.json`, `widget-installations.json`); runtime locks, `-shm`, sockets, pids |
| Offline data backup, encrypted (`profile: data`) | Same as plain, inside an authenticated envelope | Managed secrets |
| Encrypted with `--include-secrets` (`profile: data-credentials`) | Plain content plus the four managed secret files | — |

Never exported by any profile: `.env`, login/session and signing material, TLS and SSH keys, native harness homes
(`claude-home` and similar), the control directory, backup destinations, and any file outside the registry. A manifest
that names such a path is rejected during verification.

## 3. Minimum runtime

- Node.js **22.18** or newer and bundled SQLite **3.51** or newer with foreign keys and the `node:sqlite` backup API
  (`lib/storage/runtime-check.js`, `MIN_STORAGE_NODE_VERSION`). Older runtimes refuse backup and restore before touching data.
  (`offline-data-recovery.md` still says 22.16 in one place; the code constant is authoritative.)
- scrypt needs up to 128 MiB of memory at the maximum accepted cost; the default (log2N 15) uses 32 MiB.
- Free space of roughly the dataset size for the copy, plus the same again for the pre-restore copy under the control directory.

## 4. Offline CLI recovery procedure

Stop Cretli first. The CLI takes an exclusive lease in the control directory (default `<dataDir>/.cretli-control`, override with
`--control-dir`) and refuses to run when it sees a live owner, a live writer lock or a non-empty SQLite `-wal`.

```
node scripts/cretli-offline-data.mjs backup  --dest /safe/backups
node scripts/cretli-offline-data.mjs verify  --backup /safe/backups/<id>
node scripts/cretli-offline-data.mjs restore --backup /safe/backups/<id> --yes
# inspect the result, then:
node scripts/cretli-offline-data.mjs finalize      # drop retained previous files + journal
node scripts/cretli-offline-data.mjs resume        # clear the post-restore pause
```

1. **Verify before you restore.** `verify` checks the manifest format, that every path is registry-managed and safe, every
   SHA-256, and SQLite `integrity_check` + `foreign_key_check`. Restore repeats all of it before the first write.
2. **Pre-restore copy.** Restore first writes a verified copy of the *current* data to `<controlDir>/pre-restore/`
   (encrypted when the source is encrypted). A failure at this point, or while staging (including a full disk), leaves the
   destination untouched and removes the journal.
3. **Journaled replacement.** Files are staged next to their destinations and renamed one by one; the journal records
   each step. If the process dies, run `recover` (it also runs automatically at server start) and the restore rolls forward.
   Managed files absent from the backup are removed so an old backend marker is never mixed with new content; the
   destination's managed secrets are kept when the backup declares none.
4. **Generation and fence.** The restore allocates a new dataset generation and a fence above the backup's own, the local
   state and `--high-water`. The dataset is **paused** afterwards.

### Pause and resumption

While paused the server does not start delegation recovery, Watcher/Scout, mailbox/outbox, title/archive jobs. External HTTP history writes must present the current `restoreGeneration` (from `/api/settings` and
`/api/health`; the browser refreshes once on a stale value). Nothing is re-activated automatically: review the data, then
`resume`. Interrupted work is handled by ordinary boot recovery *after* `resume`. Restore does not rewrite imported
executable or URL definitions and does not reconstruct run claims.

### Rollback and reconciliation after new writes

`rollback --yes-lossy` puts the retained previous files back. Any write made after the restore (new chats, edits, usage) is
**lost**, and the CLI requires the explicit acknowledgement for that reason. Rollback advances the fence again and leaves the
dataset paused. If the restore was already finalized, restore the encrypted/plain pre-restore copy from
`<controlDir>/pre-restore/` instead. There is no merge: after a restore the choices are keep the restored state, or go back
to the previous state and re-enter what was written in between. Conversations exported before the rollback can be re-imported
as new chats (see §6).

## 5. Online backup: eligibility and active-run defer

Online copying (`POST /api/online-backup/run`, scheduler) runs a barrier that closes writer gates, drains, flushes and locks
stores in registry order, copies to a private stage, then releases everything before packaging. It is permitted only when every
store, unknown-writer gap and blocking inventory gap is covered by a **certified participant**. **No production writer is
registered yet**, so `GET /api/online-backup/status` reports `capability.enabled: false` and every run is refused. Use the
offline CLI for real backups today.

When eligible, a gate with `deferOnActive` defers the backup while provider work is active: the run is reported as
`MAINTENANCE_DEFERRED`, retried after 15 minutes and not counted as a failure; active runs are never killed. Other budgets:
barrier 20 s, drain 8 s, flush 8 s, lock 3 s, event-loop lag 250 ms, stage 1 GiB (larger datasets stay offline). Retention
deletes only scheduled archives beyond `keep`, only after the new archive verified; a failed run deletes nothing.

## 6. Settings and conversations: explicit activation

- **Imported MCP servers** are written `enabled: false` (including servers that already exist locally); enable them in
  Settings → MCP.
- **Executable paths, endpoints and the advisor URL** (`connections` section) are staged in `settings-import-pending.json`
  and applied only by `POST /api/settings-backup/pending/activate` with `confirm: true`.
- Import, preview, export and activation never spawn a process, open a socket, probe an endpoint or send a push.
- Imported **conversations** become new chats with new ids, cleared native sessions and no running work; replaying an
  import does not duplicate chats and a deleted destination chat is not resurrected.
- Settings imports save a verified `pre-import` snapshot first; a failure aborts with nothing changed.

## 7. Encryption and keys

- Envelope v1: AES-256-GCM per chunk, scrypt + HKDF key, the whole header authenticated by every record, strict record
  order, a final record with chunk count, length and SHA-256, and a trailing-byte check. Details: [encrypted-envelope.md](encrypted-envelope.md).
- Wrong key and tampering both fail with `ENVELOPE_AUTH_FAILED`; KDF cost, chunk size and file size are bounded before any
  allocation or key derivation.
- Give the passphrase with `--passphrase-file` (owner-only) or `CRETLI_BACKUP_PASSPHRASE`, never on argv. Cretli never stores
  it; **a lost passphrase means the backup is unrecoverable**. Scheduled backups use `CRETLI_ONLINE_BACKUP_KEY`.
- Plaintext staging exists only under `<controlDir>/staging` (`0700`) and is removed after each operation or swept after a
  crash. Cretli does not encrypt the disk: use host disk encryption for the control directory.

## 8. Limits and file safety

- ZIP archives (conversations): store-only, no inflation (so no zip bomb), entry-count, member-size and total-size limits,
  traversal/absolute/backslash/drive names, symlinks, nested archives, duplicates, overlaps and size lies are rejected.
- Offline backup manifests: only registry-managed, safe, relative paths; unknown or newer `format` values are
  `BACKUP_UNSUPPORTED`; a plain backup declaring secrets is `BACKUP_INVALID`.
- Permissions: the backup destination root, backup directories and the control directory are created `0700`; encrypted
  backups are `0600`. Payload files inside a *plain* backup directory are created with default (`0644`) modes and rely on the
  `0700` directory above them.

## 9. Known gaps (not implemented)

- Online backups are disabled (no certified writers); no online-barrier measurement under real load.
- No backup Settings UI for data backups/restore or PL/EN/mobile strings; online-backup API errors are English.
- No quarantine of corrupt raw source files in the data backup: a corrupt SQLite aborts the backup. Only the
  conversations export records `corrupt_source` omissions.
- No restore receipts or replay protection for data restore (only conversation import has them).
- No WebSocket/replay generation transport; pause coverage beyond delegation-runtime boot is partial.
- No legacy readers or forward migration of pre-migration archives; only the current registry layout restores.
- No remote backup destinations, no per-archive listing or download endpoint for scheduled backups.
- Pre-restore copies in the control directory are not pruned automatically.
