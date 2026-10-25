# Settings versions and portable import/export (B2)

Status: implemented for the `portable-settings-v1` profile. Conversations (B3),
data backups and recovery (B4+) are separate. Design:
[settings and backups](../settings-backup-design.md); contract:
[storage contract](../storage-contract.md); profile:
[archive profiles](archive-profiles.md).

Code: `lib/backup/settings-classification.js` (field registry and projection),
`lib/backup/settings-backup-service.js` (snapshots, preview, apply, activation),
`lib/backup/durable-write.js`, `lib/routes/settings-backup-routes.js`, UI in
`app_front/features/settings/dataBackupSettings.js` (Settings → Data and backups).
Tests: `tests/settings-backup.test.js`.

## What a snapshot contains

A snapshot is a classified projection of `config.json` plus MCP definitions, never
a copy of the file.

| Class | Examples | Export | Import |
| --- | --- | --- | --- |
| portable | `autoTitle`, `enabledHarnesses`, `approvalBroker` (without advisor URL) | sections `general`, `harnesses`, `approval` | merged per selected section |
| definition | `*Bin` executable paths, `*BaseUrl` endpoints, advisor URL | section `connections` | staged **pending**, not applied |
| secret | any key matching api key/token/secret/password…, credential-looking values | omitted (`omissions[]`, reason `secret`) | dropped; destination secrets always preserved |
| machine | `lanHost`, workspace paths | omitted; optional `workspaces` section carries ids and labels only | needs a local path per workspace (mapping) |
| unclassified | any new key | omitted (`unclassified`) | dropped |

MCP definitions export command, args, cwd, URL and the *names* of env/header keys.
Env/header values, credential-looking args (`--token=…`) and URL credentials/query
secrets are never exported. `devicePreferences` carries only the allowlisted keys
`cretli-theme` and `cretli-lang` from the current browser, and only when the user
asks for it.

## Durability

Snapshots are published by `writeFileDurable`: write to a temp file, `fsync` the
file, atomic `rename`, `fsync` the directory. The result is read back and its
SHA-256 compared before the API answers `status: "saved"`. Any failure removes the
temp file, publishes nothing and returns `SNAPSHOT_WRITE_FAILED`.

Platform limits are reported in `durability.limitations`: where a directory cannot
be opened or fsynced (for example Windows, some network filesystems) the snapshot
is still saved but `directoryFsync` is `false` and the UI says so. Rename atomicity
and fsync honesty depend on the filesystem; Cretli reports what it did, not a
guarantee about the storage stack below it.

## Import flow

1. **Preview** (`POST /api/settings-backup/preview`): validates the document
   against the schema, re-projects every section (untrusted input: secrets, unknown
   keys and paths are dropped and listed), diffs against the current state and
   pins the SHA-256 of the raw `config.json` bytes and the MCP revision. Previews
   live in server memory for 15 minutes and are single-use.
2. **Selection / mapping**: the user picks sections; workspaces need an absolute
   local path each, otherwise they are skipped.
3. **CAS + apply** (`POST /api/settings-backup/apply`): under an in-process queue
   and an `O_EXCL` lock file the server re-reads `config.json` (raw digest) and the
   MCP revision. Any difference returns `409 PREVIEW_STALE` and consumes the
   preview; a fresh preview is required. MCP writes additionally use the store's
   own revision check.
4. **Verified previous state before the first write**: raw `config.json` (and
   `mcp.json` when MCP is selected) are copied to `settings-recovery/` with mode
   `0600` and verified by digest; a `pre-import` snapshot is also saved. If either
   fails the import aborts with `PRE_IMPORT_BACKUP_FAILED` and nothing is changed.
   The raw recovery copies can contain the destination's secrets, so they are not
   listed or downloadable through the API.

Defaults preserve existing data: only selected sections are applied, keys absent
from the file are left alone, and omitted secrets never clear destination
credentials (`mergeKeepingSecrets`, MCP secrets map passed through untouched).

## Imported definitions start disabled

- MCP: new or changed servers are written with `enabled: false`, including servers
  that already exist locally (their env/headers and secrets are kept). Unchanged
  definitions are not touched. The user enables them in Settings → MCP.
- `connections`: staged in `settings-import-pending.json`; `config.json` is not
  modified. `POST /api/settings-backup/pending/activate` with `confirm: true`
  writes the value. Activation only stores a string.
- Import, preview, export and activation never spawn a process, open a socket, probe
  an endpoint or send a push. `tests/settings-backup.test.js` replaces
  `child_process`, `net` and `fetch` with counters and asserts zero calls.

## API

Admin-equivalent only; widget and MCP-integration credentials get `403`.

`GET /api/settings-backup/capabilities`, `GET|POST /snapshots`,
`GET|DELETE /snapshots/:id`, `POST /export`, `POST /preview`, `POST /apply`,
`GET /pending`, `POST /pending/activate`.

## Not in this slice

Sidebar layout, conversations, TODOs, encrypted credentials, scheduled backups and
data recovery. A preview token is process-local; restarting the server invalidates
open previews.
