# Storage cutover: backup and rollback runbook

Status (2026-10-19): **cutover prepared, not executed.** Production history still uses the
legacy backend and **no migration has been performed**. The stage-2b callers are converted
and the offline import / rollback-export tooling is tested on synthetic data only
([storage-history-migration.md](storage-history-migration.md)). The one installation-specific
safety backup that exists is **stale** (it predates the current history and the converted
callers); a fresh backup must be taken and verified immediately before the cutover. This
document does not authorize anything by itself: the user authorized the migration, a backup
and the downtime on 2026-10-19, and "Stage 3: prepared cutover" below is the reviewable
operation that has not been applied.

## Release gates

Before converting callers, require reviewed byte-bounded history reads, an explicit
large-record policy, measured A1 gates, and resolution of COMMIT I/O recovery F29.
Keep failed or unmeasured gates visible. Passing simulated fault tests does not
certify physical disk failure behavior.

Current gate state: all four A1 workloads have been run. In the first complete run every
other primary gate passed and only startup replay failed (medium 30.629 ms clean-close /
54.998 ms WAL-present derived vs a 15.946 ms budget). That FAIL stays recorded; a narrow,
explicit exception for that single gate was approved on 2026-10-19 so the migration
stages may continue ([storage-gates.md](storage-gates.md#recorded-exception-startupreplay-only-2026-10-19)).
It is not a PASS and waives nothing else. F29 is mitigated by an unconditional
`wal_checkpoint(TRUNCATE)` under `synchronous=FULL` at every worker start before READY
(no opt-out) together with the full `integrity_check`/`foreign_key_check`; physical disk
faults are not certified.

Record the exact application commit, runtime/SQLite versions, active backend and
schema markers, registry version, backup identifier and checksums in a private
operation manifest. Preserve local code changes separately; do not reset a dirty
checkout to obtain a rollback target.

## Consistent backup before migration

1. Schedule a maintenance window. Stop automatic launches and all application
   writers, including other instances, harness children, MCP processes and jobs.
   The current server shutdown interrupts its running agents; a backup operation
   must be driven by an operator or an independent supervisor outside that process.
2. Drain retained buffers and resolve journals before shutdown. Verify graceful
   termination and exclusive store ownership. Unknown writers or failed flushes
   stop the operation. The proposed online coordinator is not a substitute for
   these checks until every production writer participates in it.
3. Derive the scope from the deployed storage registry and actual backend markers.
   Include legacy history, chat metadata, TODOs, delegations, recovery state,
   retained usage journals and referenced attachments as one application dataset.
   Keep authentication/TLS, provider homes and external fencing/control state in
   their separately classified retention domains. Document exclusions explicitly.
   Keep the backup destination outside the source tree.
4. Stage a private, owner-only copy while writers remain stopped. Use SQLite's
   backup API or cleanly closed databases; never copy only the main file of a live
   WAL database. Preserve all required files until their database consistency has
   been verified. Do not silently skip unreadable paths or corrupt source records.
5. Validate strict raw JSON, SQLite integrity/foreign keys, record counts, sequence
   bounds and cross-store references in staging. Build a manifest with relative
   paths, sizes and checksums from that same staged copy. Record any unsupported
   validator as a failed verification, rather than claiming a complete backup.
6. Package according to the content/credential encryption policy, verify archive
   checksums, extract into an isolated private directory and repeat validation.
   Publish atomically only after verification. Retain the source and staged copy
   on failure. Restart the unchanged backend only after the offline copy finishes.

See [the backup contract](settings-backup-design.md#export-and-restore-correctness)
and [the registry](storage-registry.md). The backup CLI/adapters in that contract
are proposed components. The one-time operator tool below is a separate, narrower
safety snapshot of one installation; it is not that product export/restore.

## Backup status (confirmed 2026-10-19)

**This backup is STALE** (it predates the current history and the converted callers). It is kept as evidence of the tool, not as the cutover backup: window 1 of "Stage 3" takes the fresh one, and `prepare`/`verify` refuse a backup older than the time given with `--backup-not-before`.

An actual one-time safety backup of one installation was taken with the tool below and
published: manifest of 6755 files including 4 SQLite databases, archive of 519822480
bytes, SHA-256 `c9fc8bcefdaf8db0794707761d7f620467407b41d5c1e54f02314920f0ec75b8`.
An isolated extraction was re-verified: file hashes, strict JSON/JSONL, and SQLite
`integrity_check`/`foreign_key_check` all passed. The operation recorded its code
checkpoint and an approved source fix; its private location, path and operation record
are intentionally not part of this repository.

Limits of that evidence: it is a backup **of that installation**, not a product
backup/restore tool, and it does not contain, and cannot restore, writes made after the
cutover. It is not a rollback path for a new backend that accepted durable writes - use
the rollback export of the next section for that. Do not run the backup again or read the
archive as part of this work.

## Offline history import and rollback export (stage 1, not run on real data)

[storage-history-migration.md](storage-history-migration.md) documents the format study,
the mapping, the refusal codes and the contract for the future production adapter.
`scripts/storage-history-migrate.mjs` plans by default; `--apply` writes only a new
staging/export directory and never the source. Preconditions for any real run: all
writers stopped (the tool detects, it does not lock), a verified backup of the legacy
directory, an output path outside the source and the data directory, the plan hash you
reviewed, and `verify-import` against the same source afterwards. The rollback export
needs a cleanly closed store and is followed by `verify-rollback --store-dir` immediately
before any publication. The export does **not** make a plain old binary safe: it carries
the receipts, dedupe ledger, producers, epochs and the fencing mark in `rollback-control/`
and requires a sidecar-aware legacy adapter and the listed control actions (fence the new
store, keep the restore-pause marker, advance the dataset generation, quarantine browser
queues). That adapter is not written.

## One-time offline safety snapshot (`scripts/cretli-offline-snapshot.mjs`)

Linux only; Node stdlib + native `node:sqlite` + system `tar`. It was tested against
synthetic projects and processes; one real run on one installation is recorded under
"Backup status" above (its operation record is private and not part of this repository).

**Privacy.** The archive is PRIVATE and UNENCRYPTED. It contains conversation history
and may contain configuration secrets. It is not a portable or credential-free export.
Keep it owner-only on local storage; never upload or share it automatically.

**Default is plan/preflight.** It sends no signals and reads no file contents or process
environment (only metadata, `/proc` identity and fd links):

```bash
node scripts/cretli-offline-snapshot.mjs --project-root /srv/cretli --data-root /srv/cretli/data \
  --output-root /var/backups/cretli-private --pid <server-pid>
```

The report lists refusals (blocking) and warnings, a short identity fingerprint, file and
byte counts, and required vs free space. Resolve every refusal first.

**Apply prerequisites (needs a separate user decision):** the user must approve stopping
ALL Cretli sessions (a SIGTERM interrupts running agents) and archiving the history.
Run the helper as the same unprivileged service user as the server; `--allow-root-service`
exists only for a server that itself runs as root. Use `--detach` so the helper outlives
the stop of its own parent (a helper started from inside Cretli refuses to run
non-detached). `--detach` is a hard reparent barrier, not just a new process group:
Cretli kills a process tree by walking parent links PID by PID, so a detached PGID does
not protect the helper while its launcher is still its parent. The helper therefore
waits (bounded, `--barrier-timeout-ms`, default 15 s) until none of its ancestors is the
server, i.e. the launcher has exited, before it captures anything or sends a signal, and
checks again right before SIGTERM. If it cannot get out of the server's tree it records
`DETACH_BARRIER_FAILED` (no signal sent, server untouched) and exits. Apply flags: `--apply --detach --confirm-stop-all-sessions
--confirm-archive-history --confirm-identity <fingerprint from plan>`; choose
`--restart-mode self` (helper restarts the instance) or `supervisor` (an external
supervisor respawns it; the helper only observes and never spawns). A parent that looks
like a supervisor makes `self` mode refuse, to avoid duplicate instances.

**Guards.** PID start time, real cwd (must equal the project root), `server.js` entry
under the project, node executable and service UID are checked at plan time and again
immediately before SIGTERM. The target server only ever receives SIGTERM, never SIGKILL.
(The helper's own bounded worker children, which copy and validate, are the only processes it
SIGKILLs, on `--worker-timeout-ms`.) SIGTERM starts an irreversible
shutdown (running agents are interrupted), so a stop timeout is NOT "untouched": the
helper keeps watching the same PID for `--late-exit-monitor-ms` (default 120 s). If it
exits late, the service is restarted once (never a duplicate). If it is still alive at the
limit the result is `restart.outcome: stop-incomplete` /
`STOP_INCOMPLETE_MANUAL_RECOVERY`: the helper neither kills nor restarts it, and the
operator must inspect and recover the service manually (a process that exits after the
limit stays down). The tool refuses a second server process for the same
project and any process outside the server's own tree holding a writable fd below the
data root (before the stop and again after it; an unreadable fd table of a same-user
process fails closed at every check). Every descendant of the server is recorded (PID +
start time) before SIGTERM and must be gone (`--descendant-wait-ms`, default 5 s) before
the copy; a surviving child, even without a writable fd, refuses with
`KNOWN_DESCENDANT_SURVIVED` and the server is restarted. A long-lived descendant (for
example a detached agent or harness child that does not exit on its own) can therefore
block the snapshot; the tool never kills it, so stop it through its owner and plan again. Symlinks, unsupported file types, orphan
SQLite sidecars, unreadable files and sources that change during the copy refuse
publication.

**What is copied.** The data root, except these exact top-level names (never prefixes or
globs, so user-state names that merely start the same way stay in scope): native provider
homes and stores `runtime-home`, `sdk-agent-store`, `agent-transcripts`, `claude-home`,
`claude-api-home`, `codex-home`, `codebuddy-home`, `qwen-home`, `dsh-home`, `opencode-home`,
`cursor-home`, `cursor-share`, `native-homes`; the managed interpreter environment
`zai-sdk-venv`; scratch `tmp` and `scout-test-snapshots`; the watcher runtime lock
`webpack-cli-watch-lock.json`; the diagnostic `client-debug.log` / `client-debug-prev.log`; npm caches (`npm-cache`, `.npm`, `.npm-cache`, `.cache`,
`node_modules`); auth/session/TLS/push-key files
(`auth.json`, `sessions.json`, `key.pem`, `cert.pem`, `vapid-keys.json`,
`push-subscriptions.json`), runtime `*.lock`/`*-shm`/`*.sock`/`*.pid` entries, and the
project `.env` (never read). Excluded directories are never walked. Not excluded: `widget-installations.json`
and similar configuration files may hold configuration secrets, so treat the whole
archive as secret (this is not a credential-free export). These domains keep
their own retention and are not covered by this archive. Extra top-level names can be
excluded with `--exclude-name`.

**Procedure.** Stop, source inventory, bounded worker child copies files and backs up
each SQLite database through the native backup API from a private scratch copy of
database + WAL (the source is never opened read-write), source recheck, **restart**,
then a second bounded child validates the staged copy (strict JSON/JSONL, SQLite
`integrity_check` and `foreign_key_check`; staged databases are switched to a single
self-contained rollback-journal file), writes a manifest from the final staged bytes,
builds `tar.gz`, audits members, extracts into an isolated directory and re-verifies
checksums and content. Artifacts are published atomically (archive renamed last).

**Output.** `<output-root>/cretli-snapshot-<id>/` (0700) holds the archive, `.sha256`,
manifest, `status.json` (phases, restart outcome) and `ops.log` (codes only), all 0600.
On failure no archive is published; staging stays under `work/` for private diagnosis.
Logs, status and manifest carry no conversation text, configuration values, environment
or full argv; errors are stable codes with a relative path/line at most.

**Restart.** The original executable, argv, cwd and environment are read from `/proc`
into memory only in apply mode, used for one restart in a `finally` (also after a copy
or validation failure, and after an orphaned-writer refusal), and never persisted. A
generic restart counts as successful only if the process stays alive for `--restart-verify-ms`
with the same cwd and entry; no health endpoint is probed. With the launch profile (below)
the restart runs the verified launcher and success additionally needs the same PID to become
the profile's node exe with title `cretli` and an owned listener answering loopback health. If a matching server already
runs (supervisor respawn) nothing is spawned. Original stdout/stderr are re-attached
only when they were regular files, otherwise discarded.

**Launch profile (`--launch-profile cretli-npm-start-v1`, opt-in).** `server.js` sets
`process.title = 'cretli'`, so `/proc/<pid>/cmdline` no longer shows the entry and the
generic entry guard reports `PID_ENTRY_MISMATCH` (with `argvOpaque: true`). The original
argv cannot be recovered and the tool does not pretend to. The profile instead binds the
PID to: hashed project code (`server.js`, `scripts/start-server-node22.sh`,
`lib/register-boot-env.js`, `package.json`), the exact `npm start` script string, an
explicit `--node-exe` (compared by realpath with `/proc/<pid>/exe`), cwd, uid, start time,
comm/title `cretli`, opaque argv (an entry in argv makes the profile refuse), a TCP
listener owned by that PID, and a credential-free `GET /api/health` on loopback. Code files
must be owned by the helper uid (or the declared data owner) and not group/world writable.
All of this is folded into a `launchProfile.digest` shown by the plan; apply needs it as a
separate `--confirm-profile-digest` in addition to `--confirm-identity` (the fingerprint also
covers it), and the digest is recomputed immediately before SIGTERM (`PROFILE_CHANGED_BEFORE_STOP`).
The profile never replaces the cwd, exe, uid, second-server or writer guards. Restart runs
`bash <project>/scripts/start-server-node22.sh` in the project root with the captured initial
environment (RAM only, after an approved apply); the launcher re-derives `--import
./lib/register-boot-env.js` and `--env-file` itself, and bind/TLS/autostart settings are not
touched. Before the stop it checks that `PATH` resolves `node` to the profile's node exe
(`PROFILE_RESTART_RECIPE_INVALID` otherwise). A restarted server is a fresh tree: the original
`npm start` / `sh` parents are not recreated and stdout/stderr go to the original log only when
it was a regular file. Without the flag, an opaque argv fails closed.

**Data owner.** When the service uid differs from the data owner, the plan reports it from
`stat` metadata only (`dataRoot.ownerRelation`: `same-uid`, `declared-other-uid`,
`undeclared-other-uid`). Nothing is chmod'ed or chown'ed. A data root owned by another uid is
accepted only with `--data-owner-uid <uid>` naming exactly that uid (`DATA_OWNER_MISMATCH`
otherwise); it then must not be group/world writable (`DATA_ROOT_PERMS`), every entry must be
owned by the helper uid or the declared owner (`SOURCE_UNEXPECTED_OWNER`), and no entry may be
world-writable (or group-writable under a foreign owner; `SOURCE_WRITABLE_BY_OTHERS`). The data
root's uid/gid/mode/inode and the declared owner are part of the fingerprint, so a change between
plan and apply is refused. The helper uid must equal the server uid (a root server needs
`--allow-root-service`); there is no privilege escalation.

**Inherited descriptors of wrappers.** `npm start` and `sh` ancestors may hold the server's
inherited stdout/stderr. Such an ancestor is accepted only when every writable fd it holds below
the data root is an `O_APPEND` regular `*.log`/`*.out`/`*.err` file that is the very same
file (device + inode) as the server's own fd 1/2, and its start time matches the recorded one.
Anything else is `UNKNOWN_WRITER` with a class (`ancestor-canonical-data`, `ancestor-sqlite`,
`ancestor-foreign-log`, `ancestor-not-append`, `unrelated`), never a path. Other-uid processes
and unreadable fd tables are unchanged (fail closed / warning). Findings are aggregated:
refusals carry code, count and at most three sanitized top-level exemplar names.

**Helper loss after SIGTERM.** The restart envelope (argv, environment, cwd) lives only
in the helper's memory; no environment snapshot is ever written to disk. The `finally`
restart protects against worker faults (copy/validation crash, bad data), not against
losing the helper itself: if the helper is crashed, OOM-killed or SIGKILLed after SIGTERM
the service stays down and the envelope is gone. Operator procedure: when `status.json`
still says `running` but the helper PID (`ops.log`/launcher report) is dead, start the
service manually through the original deployment or service manager, then inspect
`ops.log`; no archive is published in that case.

**Known limitations.** Supervisor detection is a parent-name heuristic; unknown
wrappers, containers or service managers are not guessed, so use `--restart-mode
supervisor` there. The environment captured from `/proc/<pid>/environ` is the initial
one, not later `setenv` changes. Writer detection sees open fds only (no mmaps) and
cannot inspect other users' processes (reported as a warning). The helper itself needs
Node >= 22.16 (`node:sqlite` `backup()`); older runtimes refuse with `NODE_RUNTIME_TOO_OLD`. The PID guard has a small
check-to-signal race window. Memory is bounded by the worker heap cap and JSON size
limits, but the inventory is held in memory (`--max-files`). The archive is not
encrypted and there is no restore command.

**Rollback / restore.** Nothing is changed in production data by this tool; the source
is only read. To roll back later, use the per-path procedure of the section below for
this installation only: stop all writers, extract the archive into an isolated
directory, verify the manifest checksums, and replace individual verified paths using a
recoverable per-path journal. Preserve retained auth, TLS, provider homes, fence/control
state and any newer writes (see the table below). Full product restore guarantees are
out of scope.

## Rollback boundaries

| State | Recovery action |
| --- | --- |
| Library changes only; no production cutover | Return to the recorded application release through normal deployment. No data restore is needed. |
| Staging migration failed; legacy remains authoritative | Keep writers paused, discard only the identified staging output after preserving diagnostics, verify legacy markers and restart the legacy release. |
| Cutover published; no new durable writes | Under exclusive ownership, restore the verified previous dataset and backend markers with a recoverable per-path journal. |
| New backend accepted durable writes | Stop writers, fence the new store and preserve both datasets. Export every post-cutover durable write with `rollback` (strict legacy documents plus the `rollback-control/` receipts and fence data), verify the store is unchanged, and use a sidecar-aware legacy adapter; or obtain an explicit decision about data loss. An old backup alone cannot preserve these writes, and a plain old binary cannot honour the fencing data. |

Never dual-write opportunistically or point an older binary at an incompatible
schema. Never replace an entire data directory or overwrite external fence state,
auth/TLS, native homes, unrelated files or the backup itself. Stage changes on each
target filesystem; journal publication outside all replaced paths. Finish or
recover the journal before opening stores.

After a dataset restore, advance the externally retained dataset generation/fence,
invalidate server caches and client revisions, and quarantine pending browser
queues for explicit reconciliation. Restore claims as interrupted and keep
watchers, recovery launchers, mailbox/outbox execution, title jobs, push delivery
and MCP auto-start paused. Verify zero automatic process starts and outgoing push
before reopening clients. Resume automatic work only after explicit operator action.

## Stage 3: prepared cutover (status 2026-10-19: prepared, NOT executed)

Authorization and waivers on record (2026-10-19, user decision): the history migration, a fresh
backup and the downtime window; a narrow exception for the A1 startup-replay gate only
([storage-gates.md](storage-gates.md#recorded-exception-startupreplay-only-2026-10-19)); the
handler-latency, startup and full four-workload benchmark re-runs are deferred until AFTER the
live cutover (the raw FAILs stay recorded and unchanged; long performance work is tracked in the
Cretli TODO for deferred perf, not here). None of these is a PASS and none waives a data-safety
control below. Physical-disk failure is not certified.

**F11 guard (required precondition, implemented).** `openChatHistoryRuntime` used to open READY
(and accept new ACKs) even when `recoverPending()` reported unresolved commands. It now throws
`history_recovery_unresolved` after the normal cleanup (worker host and committer closed, the
caller releases the coordinator lease), keeps the pending entries untouched and returns no
adapter. A healthy recovery replays them as before; the read-only rollback runtime is unchanged.

**Two downtime windows, honestly.** (1) The existing snapshot tool takes the fresh backup
(stop, copy, restart, then validate and extract in isolation). (2) The cutover itself runs in a
second quiesced window. Legacy writes between the two windows stay in the legacy directory, which
is read once more in window 2 under the final quiesced state and is never modified.

**Tools** (no new release framework):

| Piece | Role |
| --- | --- |
| `scripts/cretli-offline-snapshot.mjs` | Window 1 unchanged. Window 2: `--stopped-hook SPEC.json --confirm-hook-sha256 SHA` runs a pinned script (spec hash and script hash verified before any signal and again before the run) instead of copying, with the tool's identity/profile/writer/reparent-barrier/SIGTERM-only guards, a minimal hook environment, `--detach`, and the normal restart in `finally`. After a FAILING hook the service is restarted only on a durable hook proof (see "Hook proof and stopped-unsafe"). |
| `scripts/storage-history-cutover.mjs` | `prepare`, `preview`, `verify`, `hook-spec` and the hook modes `cutover`, `recover`, `rollback-precutover`, plus `post-check` and `rehearse-rollback`. Output is JSON with codes and counts only; every path of the real installation lives only in the private operation directory. |
| `lib/storage/cutover-code.js` | Per-path code candidates (three-way over worktree base / worktree / main, `git merge-file` on temp files, never `git merge`), atomic apply with a rollback checkpoint and journal, exact revert. |
| `lib/storage/cutover-history.js` | Backup evidence, clean-slate checks, strict quiesced source plan, staging import, verify, store publication, marker selection through the coordinator lease, pre-ACK rollback, recovery, post-check and rollback rehearsal. |

**Sequence** (generic paths; the real ones live in the private operation manifest):

1. *Window 1 - fresh backup.* Plan, then apply the snapshot tool as documented above
   (`--apply --detach --launch-profile ...`). Keep its operation directory: `status.json` must say
   `published` with a verified restart.
2. *Prepare (read-only for main, data and the service).*
   `node scripts/storage-history-cutover.mjs prepare --code-root <reviewed worktree> --main-root <main checkout> --data-root <data> --ops-dir <new private dir> --backup-op-dir <snapshot operation dir> --backup-not-before <ISO time of window 1 start> --min-chats <preflight floor> --protect <user-dirty path> ...`
   Run it from the reviewed worktree (the manifest pins the digest of the tool and the storage
   libraries it runs from). The ops directory is created 0700 outside the code, main and data
   trees; candidate files, `code/manifest.json` and `code/preview.txt` are written there.
3. *Review.* `preview` lists the per-path decision (`copy`, `merge`, `delete`, `already-applied`,
   `protected-skip`, `conflict`) and never contents. A `conflict` blocks the apply; resolve it in
   the worktree and prepare again. Protected user files are hashed and must stay byte-identical.
4. *Verify before the stop.* `verify --ops-dir ... --confirm-manifest-hash H` re-checks the
   manifest hash, tool digest, clean slate (no marker/witness/store/pending footprint), backup
   record and archive checksum and age, main HEAD, every scoped main path and protected file
   (CAS), candidate hashes and free space. Anything that moved means: prepare again.
5. *Hook spec and plan.* `hook-spec --mode cutover --out SPEC.json` prints the spec hash; run the
   snapshot tool's plan to obtain the identity fingerprint (and launch-profile digest).
6. *Window 2.* The snapshot tool, detached, stops the verified server (SIGTERM only) and checks
   every writer; then the hook runs `cutover`: verify material again -> strict source plan on the
   quiesced directory (refusals, warnings, a chat count below the floor, or unexpected protected
   entries stop it) -> staging import into a new directory in the ops dir -> `verify-import`
   against the source and the dataset binding -> the plan hash again (source byte-identical)
   -> code apply with checkpoint -> store directory published by one rename (hash re-checked)
   -> `sqlite` selected through a live coordinator lease (witness first, then marker) and the
   lease released -> marker read back and the plan hash a last time. Progress is persisted in
   `cutover-status.json` and `cutover-result.json`; the snapshot tool's `status.json` carries the
   hook outcome and the restart result. The restart then starts exactly one backend on the new
   code; the launch profile verifies the same PID answers loopback health.
7. *Failure before the marker:* the hook moves the store and any control files into
   `<ops>/aborted/` (nothing is deleted), reverts the code from the checkpoint and exits non-zero;
   the hook writes a `safe-legacy` proof and the snapshot tool restarts the OLD code on the legacy backend. A failure before any write
   (`failed-before-writes`) undoes nothing, so an earlier committed cutover is never touched.
   If the hook itself dies (timeout SIGKILL, crash, abort that could not revert code), no proof exists:
   the helper does NOT restart anything and ends in `stopped-unsafe` (see below). Run `recover` in a new
   quiesced window (same hook mechanism): with no marker it aborts what is left; with a marker it
   changes nothing and exits 3.
8. *After the restart.* `post-check --out evidence-1.json` (read-only SQLite connection): marker
   `sqlite` for the generation, store binding, `quick_check`/foreign keys, imported event count
   never above the import (retention trims, resets and deletes legally lower it), no quarantined pending, new-write count. Then drive a real write through the UI/API
   (authentication is the operator's, not the tool's), run `post-check --previous evidence-1.json`,
   restart the service once more and run it again: every earlier new write must still be present
   and no count may shrink. `rehearse-rollback --scratch-dir <new>` exports a SQLite-backup copy
   through plan -> apply -> verify; it reports whether post-cutover writes were part of the
   rehearsal, so run it after the first real ACK.
9. *Rollback.* Before any durable write (`rollback-precutover` in a quiesced window): allowed only
   while the store holds exactly the imported dataset (no receipts, no dedupe rows, no non-import
   events, same counts) and nothing is pending; it moves the store and control files aside,
   restores the code from the checkpoint and proves the legacy default is back. After the first
   ACK it refuses (`rollback_post_cutover_ack_exists`); the old backup is **never** restored over
   a new ACK. The only path then is the read-only rollback export described above (sidecar-aware
   legacy adapter still to be written) or an explicit decision about data loss.

**Preserved by construction.** The legacy directory including the protected ignore files
(plan hash before/after), authentication/TLS material, native provider homes and every other
data-root entry (the cutover creates only `storage/`, `storage-control/` and, later, the pending
directory); the user's uncommitted files in main (protected paths are hashed and never written;
the apply refuses if one changed). Nothing commits, pushes, merges, resets or stashes.

**Tests (synthetic only).** `tests/storage-history-cutover.test.js` (three-way classes, atomic
apply and revert, CAS refusals, full CLI sequence with a real runtime serving new writes, a fork
and a restart, post-check, rollback rehearsal, pre-ACK rollback, every fault before the marker,
recover), `tests/offline-snapshot-hook.test.js` (hook pinning, stop-before-hook, minimal
environment, stopped-unsafe after a failing hook without proof, restart with proof, stale/foreign proof refused, SIGKILL timeout, `--detach`), and the F11 case in
`tests/storage-history-adapter-runtime.test.js`.

**Hook proof and stopped-unsafe.** The helper gives the hook `CRETLI_HOOK_PROOF_PATH`, a fresh per-attempt
`CRETLI_HOOK_ATTEMPT` nonce and `CRETLI_HOOK_OP_ID` (any proof file from an earlier run is removed first). The
cutover CLI writes a durable `cretli-hook-proof-v1` file bound to them: `safe-legacy` after a clean abort (store and
control files moved aside, every code path reverted, zero refused) or a failure before any write or a
successful pre-ACK rollback; `safe-new` only after a committed cutover whose every post-marker validation (marker
readback, final source hash) passed. A failure after the marker (`failed-after-marker`, e.g. `cutover_source_changed` or
`cutover_marker_verify_failed`) writes NO proof: the helper does not auto-start and ends `stopped-unsafe`. Read
`cutover-status.json` and `hook.out` outside Cretli, decide fix-forward or the pre-ACK rollback; never restore an old
backup over data written after the ACK. After a failing hook the helper restarts only when the proof exists, is owned by the user, not
group/world-writable, and matches the nonce and operation id. Otherwise `status.json` ends `stopped-unsafe`
(`restart.outcome = not-attempted-unsafe`, `recovery.recover` lists the steps) and nothing is spawned, even if the
guarded PID is gone. Manual recovery, outside Cretli, with the service stopped:
1. Read `hook.out` in the snapshot operation directory and `cutover-status.json` in the cutover ops dir.
2. `node scripts/storage-history-cutover.mjs recover --ops-dir OPS --confirm-manifest-hash H` (marker absent:
   reverts code, moves the new store aside, exit 0; marker present: changes nothing, exit 3; refused code paths:
   exit 3). Repeat the hook window with `--mode recover` if you want the helper to restart on its proof.
3. Marker present and new code complete: fix forward and start the service. Only if the ACK-free precondition holds,
   `rollback-precutover` (it refuses on receipts, dedupe rows, pending files or drift). Never restore an old
   backup over post-cutover writes.
4. Start the service with its usual launcher once code and data agree.
`recover` and `rollback-precutover` pin the tool digest like `cutover` and `verify`.

**Post-check durability.** Evidence carries up to 200 recent receipt anchors (command id, request digest, result
hash, created-at) and per-chat epoch/head/trim watermark for the listed new events. `--previous` fails with
`earlier_receipt_missing` (any receipt from the earlier evidence is gone from the store, however old; receipts have no GC),
`receipt_changed`, `earlier_write_missing` (not trimmed, same epoch, chat still exists) or `chat_head_regressed`.
Retention trims and chat reset/delete are legal; a missing receipt never is (looked up by primary key, so the
200-anchor window does not excuse it).

**Not certified / residual risk.** A crash of the helper after SIGTERM still loses the in-memory
restart envelope (see "Helper loss after SIGTERM"); a crash between the witness and the marker
leaves the service refusing to start (fail closed) until `recover` runs; the fresh backup does not
contain writes made after it was taken (they are in the untouched legacy directory until the
cutover); `npm` dependencies are not installed by the hook (the scoped diff must not change them);
the front-end bundle is rebuilt by the normal watcher, not by this operation; physical-disk fault
behavior is unproven.

## Evidence required to proceed

A cutover report must link the reviewed code and test results, A1 measurements,
verified archive manifest, isolated restore rehearsal and rollback checkpoint.
Without these artifacts, leave the migration unstarted and the relevant TODOs open.

## Missing prerequisites (status 2026-10-19)

Done: stage-2b caller conversion and the F11 startup guard; offline import and rollback-export
tooling and the prepared cutover operation above, all tested on synthetic data; all four A1
workloads measured; the startup-replay exception record. Still missing before the live apply:

- A fresh, verified window-1 backup, then `prepare`/`verify` with the real paths (the prior
  backup is stale), a reviewed preview, and the explicit apply decision for the cutover window.
- An independent supervisor path is the snapshot tool's detached helper with its reparent
  barrier; a real run with the launch profile on the real installation has not been repeated since
  the hook was added (the hook mode is tested on synthetic projects only).
- A sidecar-aware legacy adapter and a publication procedure for the rollback export (the
  read-only runtime serves a verified export; nothing writable returns to legacy).
- A product restore tool (the snapshot is a one-time operator tool for one installation).
- Gate follow-ups: physical-fault rehearsal of COMMIT I/O recovery; the startup gate stays FAIL
  under its recorded exception; the deferred post-live benchmark re-runs.
