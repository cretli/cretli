# Online backups, scheduler and retention (B6)

Status: implemented as a **safe subset**. The offline B4/B5 backup is unchanged and remains the
supported way to take a full backup today. Online copying is refused until every writer is certified.

Code: [`lib/storage/maintenance-coordinator.js`](../../lib/storage/maintenance-coordinator.js) (shared
barrier, also intended for migration), [`lib/backup/online/`](../../lib/backup/online/) (staging, scheduler,
retention, wiring), [`lib/routes/online-backup-routes.js`](../../lib/routes/online-backup-routes.js).
Contract: [storage contract](../storage-contract.md), design: [settings and backups](../settings-backup-design.md).

## Barrier protocol

External pause/certification check → external lease (control directory, shared with the offline tools) →
close every writer gate (HTTP, WS, background, subprocess, run launch, GC) → drain → flush (failed buffers stay
with the writer) → store locks in the registry's fixed order (`lockOrderRank`, then id) → journal and
fence validation → bounded staging copy → release locks, gates and lease in `finally`, **before** packaging,
manifest, encryption and verification. Packaging reads only the private stage.

- Active provider work is never killed or waited for: a gate with `deferOnActive` defers the backup
  (`MAINTENANCE_DEFERRED`, retried later, not counted as a failure). Other mutations must drain within
  `drainTimeoutMs` (`DRAIN_TIMEOUT`).
- Failed or timed-out flush, unresolved journal, changed fence/generation, a lock timeout or a file that
  changed during its copy (an unregistered writer ignoring the gates) abort the run and publish nothing.
- A unit of work touching several stores must enter all gates up front (`runAcrossGates`); a gate closed
  mid-transaction would otherwise leave it half applied.
- Budgets (`MAINTENANCE_BUDGETS`, overridable per coordinator): `maxBarrierMs` 20000, `drainTimeoutMs` 8000,
  `flushTimeoutMs` 8000, `lockTimeoutMs` 3000, `maxEventLoopLagMs` 250 (sampled with a 10 ms timer during the
  barrier), `maxStageBytes` 1 GiB (bigger datasets stay offline). Exceeding any aborts the run.
- No hard links: SQLite goes through the backup API, everything else is byte-copied. Immutable blobs are
  protected from garbage collection by the closed `gc` gate for the duration of the barrier and are copied into
  the same stage, so history, intents and attachments belong to one snapshot point.
- Disk space is checked before the barrier (`DISK_FULL`) so a full disk never pauses writers.

## Enabling online mode

`requiredCoverage(registry)` lists what must be covered by certified participants: every store, every
`writers.unknownGaps` entry (`<storeId>#unknown-gap:<n>`) and every inventory gap with
`blocksConsistentSnapshot`. `registerOnlineParticipant` (in `online-service.js`) is the only way in. **No
production writer is registered yet**, so `GET /api/online-backup/status` reports `capability.enabled: false`
with the uncovered ids, and every online run and scheduler tick is refused. Wiring each store's gate, flush and
lock is the remaining certification work (see below).

## Scheduler and retention

Opt-in, off by default (`PUT /api/online-backup/policy`). Proposed defaults once enabled: every 24 h,
keep 7 successful scheduled archives, encrypted. State lives in the control directory
(`online-backup-policy.json`, `online-backup-state.json`, `online-backup-job-lease.json`), outside every restore
path, so a restore can neither enable the scheduler nor roll its bookkeeping back.

- Target directory must be absolute and outside the data and control directories (symlinks resolved); use
  another disk where possible.
- One job at a time via a lease file; a lease whose owner process died or whose TTL (6 h) expired is taken
  over, a live or unreadable one is respected. Slot deduplication survives restarts.
- An external restore pause pauses the scheduler (`status: paused`).
- Encryption uses the operator-provided key in `CRETLI_ONLINE_BACKUP_KEY`; it is never stored. A missing key is a
  failure and nothing is written.
- Failure retry after 1 h, deferral retry after 15 min.
- Retention runs only after the new archive verified and was recorded. It deletes only archives this
  scheduler created (`origin: scheduled`) beyond the newest `keep`, never the newest, never manual or
  `protected` entries, never anything outside the target directory. Pre-restore copies live under the control
  directory and are not candidates. A failed backup, wrong key, full disk or corrupt state file deletes nothing.

## API

`GET /api/online-backup/status`, `PUT /api/online-backup/policy`, `POST /api/online-backup/run` (manual,
never pruned). Admin-equivalent only; widget and MCP-integration credentials get 403.

## Known gaps

- No production writer registers a gate/flush/lock yet; online mode is therefore disabled everywhere.
- No Settings UI or PL/EN strings yet (API only); API errors are English.
- The scheduler has no remote destinations and no per-archive listing/download endpoint.
- Barrier timings are verified with synthetic writers (tests); a measurement under real mixed load must be
  repeated when the real writers are wired.
