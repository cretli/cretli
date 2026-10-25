/**
 * Consolidated store database lifecycle (A2, docs/persistence-design.md
 * "Responsiveness and durability", docs/storage-gates.md runtime matrix).
 *
 * `openStorageDb()` opens exactly one `node:sqlite` connection per call and
 * returns a handle that owns it; there is no module-level singleton, so the
 * future worker (S3) or a test decides how many handles exist.
 *
 * Open order matters for "never damage data we cannot read":
 *   1. runtime gate (Node/SQLite floor, foreign keys, backup API);
 *   2. for an existing non-empty file, a separate READ-ONLY connection runs
 *      the checks: header application_id and schema version peek (a foreign
 *      or newer store is `conflict`, decided before anything that needs to
 *      parse the schema), `schema_version` history, then `integrity_check` +
 *      `foreign_key_check`. A read-only connection never checkpoints a WAL on
 *      close, so a store that fails these checks keeps the bytes of its main
 *      file AND its `-wal` (SQLite may still rebuild the `-shm` index, which
 *      holds no data). Exception: a hot rollback journal (crash in DELETE mode)
 *      cannot be replayed read-only; then the checks run on the read-write
 *      connection after SQLite's standard journal rollback, still before WAL;
 *   3. read-write connection + busy_timeout + foreign_keys;
 *   4. journal_mode=WAL, synchronous=FULL, each verified by reading it back
 *      (switching to WAL rewrites the header, hence after the checks);
 *   5. forward-only migrations (write lock only when steps are pending), then
 *      `foreign_key_check` only if a migration actually ran.
 *
 * Cost: `integrity_check` is O(database size) and synchronous (30-90 s on a
 * multi-GB store), so it is conditional. It runs when ANY of these holds:
 * no valid clean-shutdown marker (`<db>.clean`: first open, crash, kill, a
 * close after an I/O, full-disk, corrupt or unknown-commit failure, an
 * `abandon`ed connection, a size/mtime mismatch, a malformed marker, leftover
 * non-empty `-wal` / `-journal`); the marker's `lastFullCheckAt` is older than
 * 7 days; `fullCheck: true`; or env `CRETLI_STORAGE_FULL_CHECK=1`. Otherwise it
 * is skipped. The marker is consumed (deleted) by every open of an existing
 * file and rewritten only by a close that was neither abandoned nor marked
 * dirty. The cheap identity checks and `foreign_key_check` always run. Open
 * from the storage worker thread, never from the main event loop.
 *
 * The read-only check and the read-write open are two connections, so a
 * process that rewrites the file between them is not detected; all writers
 * are expected to be cooperating Cretli handles.
 *
 * The database file must be a plain file directly inside the given directory;
 * SQLite only adds its `-wal` / `-shm` siblings there.
 */
import { createRequire } from 'node:module';
import nodeFs from 'node:fs';
import path from 'node:path';
import { StorageError, STORAGE_ERROR_CODES } from './errors.js';
import { checkStorageRuntime } from './runtime-check.js';
import { SQLITE_PRIMARY_CODES, sqlitePrimaryCode, toStorageError } from './sqlite-errors.js';
import { applyMigrations, CORE_MIGRATIONS, inspectSchemaVersions, readHeaderSchemaVersion } from './migrations.js';
import { STORAGE_APPLICATION_ID } from './schema/0001-core.js';

export const DEFAULT_STORAGE_DB_FILENAME = 'cretli-store.sqlite';

/** Suffix of the clean-shutdown marker written next to the database file. */
export const CLEAN_MARKER_SUFFIX = '.clean';

/** Force a full integrity_check when the last one is older than this. */
export const FULL_CHECK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Consume the clean-shutdown marker: always delete it (so a crash after this
 * point is seen as unclean) and report whether it vouched for the current file.
 *
 * @param {StorageFs} fs
 * @param {string} filePath
 * @returns {{ clean: boolean, lastFullCheckAt: number, reason: string }} `reason` names why a marker did not vouch
 *   (diagnostics only)
 */
function consumeCleanMarker(fs, filePath) {
  /** @param {string} reason */
  const unclean = (reason) => ({ clean: false, lastFullCheckAt: 0, reason });
  const markerPath = `${filePath}${CLEAN_MARKER_SUFFIX}`;
  let raw;
  try {
    raw = fs.readFileSync(markerPath, 'utf8');
  } catch {
    return unclean('marker_missing');
  }
  try {
    fs.unlinkSync(markerPath);
  } catch {
    return unclean('marker_undeletable'); // cannot guarantee the marker is gone: treat as unclean
  }
  try {
    const marker = JSON.parse(raw);
    const st = fs.statSync(filePath);
    if (marker?.size !== st.size || marker?.mtimeMs !== st.mtimeMs) return unclean('size_mtime_mismatch');
    if (!Number.isFinite(marker.lastFullCheckAt)) return unclean('marker_malformed');
    for (const suffix of ['-wal', '-journal']) {
      try {
        if (fs.statSync(`${filePath}${suffix}`).size > 0) return unclean(suffix === '-wal' ? 'wal_present' : 'journal_present');
      } catch {
        // absent is the clean case
      }
    }
    return { clean: true, lastFullCheckAt: marker.lastFullCheckAt, reason: 'ok' };
  } catch {
    return unclean('marker_malformed');
  }
}

/** Best effort: failure to write the marker only costs a full check next open. */
function writeCleanMarker(fs, filePath, lastFullCheckAt) {
  try {
    const st = fs.statSync(filePath);
    fs.writeFileSync(`${filePath}${CLEAN_MARKER_SUFFIX}`, JSON.stringify({ size: st.size, mtimeMs: st.mtimeMs, lastFullCheckAt }));
  } catch {
    // ignored
  }
}

/** Default and maximum time a statement waits on a lock before `busy`. */
export const STORAGE_BUSY_TIMEOUT_MS = 5000;
export const MAX_STORAGE_BUSY_TIMEOUT_MS = 30000;

/**
 * Memory-map window for the read-only startup check connection only. The
 * O(size) `integrity_check` / `foreign_key_check` read every page once; mapping
 * the file avoids a pread copy per page (measured ~15-18% faster checks on a
 * 20 MB store, scripts/storage-startup-profile.mjs). Nothing is skipped: the
 * same checks run over the same pages. The connection is closed right after the
 * checks and never writes.
 */
const READONLY_CHECK_MMAP_BYTES = 256 * 1024 * 1024;

/** SQLite `PRAGMA synchronous` value for FULL. */
const SYNCHRONOUS_FULL = 2;

/** Plain file name: no separators, no leading dot, no traversal. */
const DB_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const require = createRequire(import.meta.url);

/**
 * @typedef {{
 *   statSync: typeof nodeFs.statSync,
 *   lstatSync: typeof nodeFs.lstatSync,
 *   realpathSync: typeof nodeFs.realpathSync,
 *   readFileSync?: typeof nodeFs.readFileSync,
 *   writeFileSync?: typeof nodeFs.writeFileSync,
 *   unlinkSync?: typeof nodeFs.unlinkSync,
 * }} StorageFs
 */

/**
 * @typedef {{
 *   readonly db: import('node:sqlite').DatabaseSync,
 *   readonly filename: string,
 *   readonly filePath: string,
 *   readonly schemaVersion: number,
 *   readonly runtime: { node: string, sqlite: string },
 *   isClosed: () => boolean,
 *   close: (options?: { clean?: boolean }) => void,
 *   markDirty: () => void,
 * }} StorageDbHandle
 */

/**
 * @returns {{ DatabaseSync: typeof import('node:sqlite').DatabaseSync }}
 */
function loadNodeSqlite() {
  return require('node:sqlite');
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function resolveBusyTimeout(value) {
  if (value === undefined) return STORAGE_BUSY_TIMEOUT_MS;
  if (!Number.isInteger(value) || /** @type {number} */ (value) < 0 || /** @type {number} */ (value) > MAX_STORAGE_BUSY_TIMEOUT_MS) {
    throw new TypeError(`busyTimeoutMs must be an integer in 0..${MAX_STORAGE_BUSY_TIMEOUT_MS}`);
  }
  return /** @type {number} */ (value);
}

/**
 * Resolve the database path inside an existing directory and refuse anything
 * that could make SQLite write elsewhere (symlinked or non-regular file).
 *
 * @param {StorageFs} fs
 * @param {unknown} dir
 * @param {unknown} filename
 * @returns {{ filePath: string, hasData: boolean }} hasData: a non-empty file exists
 */
function resolveDbPath(fs, dir, filename) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) {
    throw new TypeError('Storage dir must be an absolute path');
  }
  if (typeof filename !== 'string' || !DB_FILENAME_PATTERN.test(filename)) {
    throw new TypeError('Storage filename must be a plain file name');
  }
  let realDir;
  try {
    if (!fs.statSync(dir).isDirectory()) {
      throw new StorageError(STORAGE_ERROR_CODES.MISSING, 'Storage dir is not a directory', { details: { operation: 'open' } });
    }
    realDir = fs.realpathSync(dir);
  } catch (err) {
    throw toStorageError(err, 'open_dir');
  }
  const filePath = path.join(realDir, filename);
  let stat = null;
  try {
    stat = fs.lstatSync(filePath);
  } catch (err) {
    if (/** @type {any} */ (err)?.code !== 'ENOENT') throw toStorageError(err, 'open_file');
  }
  if (stat && !stat.isFile()) {
    throw new StorageError(STORAGE_ERROR_CODES.IO, 'Storage database path is not a regular file', {
      retryable: false,
      details: { operation: 'open' },
    });
  }
  return { filePath, hasData: Boolean(stat && stat.size > 0) };
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} sql
 * @returns {Record<string, unknown> | undefined}
 */
function getRow(db, sql) {
  return /** @type {Record<string, unknown> | undefined} */ (db.prepare(sql).get());
}

const PRAGMA_RETRY_DELAY_MS = 25;
const JOURNAL_MODE_RETRIES = 40;

/**
 * Set one pragma and read it back; a value that did not take effect (e.g. WAL
 * on a filesystem without shared memory) fails the open.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} name
 * @param {string} setSql
 * @param {string} column
 * @param {(value: unknown) => boolean} isApplied
 * @param {number} [retries] extra attempts after a retryable (busy) failure
 */
function enforcePragma(db, name, setSql, column, isApplied, retries = 0) {
  let actual;
  for (let attempt = 0; ; attempt += 1) {
    try {
      db.exec(setSql);
      actual = getRow(db, `PRAGMA ${name}`)?.[column];
      break;
    } catch (err) {
      const mapped = toStorageError(err, `pragma_${name}`);
      if (mapped.code !== STORAGE_ERROR_CODES.BUSY || attempt >= retries) throw mapped;
      // SQLite skips the busy handler when two first-time openers race on the
      // WAL switch (deadlock avoidance), so back off briefly and try again.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, PRAGMA_RETRY_DELAY_MS);
    }
  }
  if (!isApplied(actual)) {
    throw new StorageError(STORAGE_ERROR_CODES.IO, `PRAGMA ${name} did not take effect (got ${String(actual)})`, {
      retryable: false,
      details: { operation: `pragma_${name}` },
    });
  }
}

/**
 * Run a read-only pragma check and map its native failure: NOTADB/CORRUPT
 * become `corrupt`; lock contention and read errors keep their own code so a
 * transient failure is not reported as damaged data.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} sql
 * @param {string} operation
 * @returns {Array<Record<string, unknown>>}
 */
function readPragmaRows(db, sql, operation) {
  try {
    return /** @type {Array<Record<string, unknown>>} */ (db.prepare(sql).all());
  } catch (err) {
    throw toStorageError(err, operation);
  }
}

/**
 * `foreign_key_check` (read-only); any reported row is `corrupt`.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} phase
 */
function verifyForeignKeys(db, phase) {
  const rows = readPragmaRows(db, 'PRAGMA foreign_key_check', `${phase}_foreign_key_check`);
  if (rows.length > 0) {
    throw new StorageError(STORAGE_ERROR_CODES.CORRUPT, `foreign_key_check failed (${rows.length} row(s))`, {
      details: { operation: `${phase}_foreign_key_check` },
    });
  }
}

/**
 * Identity and consistency checks of an existing store; none of them writes.
 * Cheap header reads come first so a foreign or newer store is `conflict`
 * before the O(size) `integrity_check`, which may not even parse its schema.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {ReadonlyArray<import('./migrations.js').StorageMigration>} migrations
 */
function verifyExistingStore(db, migrations, skipIntegrity = false, timings = null) {
  const t0 = performance.now();
  const applicationId = Number(readPragmaRows(db, 'PRAGMA application_id', 'open_application_id')[0]?.application_id ?? 0);
  if (applicationId !== 0 && applicationId !== STORAGE_APPLICATION_ID) {
    throw new StorageError(STORAGE_ERROR_CODES.CONFLICT, 'Database file belongs to another application', {
      details: { operation: 'open_application_id' },
    });
  }
  const headerVersion = readHeaderSchemaVersion(db);
  if (headerVersion > migrations.length) {
    throw new StorageError(STORAGE_ERROR_CODES.CONFLICT,
      `Schema version ${headerVersion} is newer than supported version ${migrations.length}`,
      { details: { operation: 'migrate', expectedRevision: migrations.length, actualRevision: headerVersion } });
  }
  inspectSchemaVersions(db, migrations);
  const t1 = performance.now();
  if (timings) timings.schemaMs = (timings.schemaMs || 0) + (t1 - t0);
  if (!skipIntegrity) {
    const integrityRows = readPragmaRows(db, 'PRAGMA integrity_check', 'open_integrity_check');
    if (integrityRows.length !== 1 || integrityRows[0]?.integrity_check !== 'ok') {
      throw new StorageError(STORAGE_ERROR_CODES.CORRUPT, `integrity_check failed (${integrityRows.length} finding(s))`, {
        details: { operation: 'open_integrity_check' },
      });
    }
  }
  const t2 = performance.now();
  if (timings && !skipIntegrity) timings.integrityMs = t2 - t1;
  // foreign_key_check scans every child row, so it is O(size) like integrity_check. Foreign keys are enforced
  // on every connection, so a store that closed cleanly and was fully checked recently cannot hold a violation.
  if (!skipIntegrity) verifyForeignKeys(db, 'open');
  if (timings) timings.fkMs = (timings.fkMs || 0) + (performance.now() - t2);
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 */
function closeQuietly(db) {
  try {
    db.close();
  } catch {
    // Keep the original failure; the connection is unusable either way.
  }
}

/**
 * Check an existing store on a dedicated read-only connection (see the module
 * comment). Returns false when the file needs write access just to be read
 * (hot rollback journal), so the caller runs the checks read-write instead.
 *
 * @param {typeof import('node:sqlite').DatabaseSync} DatabaseSync
 * @param {string} filePath
 * @param {number} busyTimeoutMs
 * @param {ReadonlyArray<import('./migrations.js').StorageMigration>} migrations
 * @param {boolean} skipIntegrity skip the O(size) integrity_check and foreign_key_check (clean, recently fully checked store)
 * @param {Record<string, number> | null} [timings] receives per-step durations in ms
 * @returns {boolean} true when the checks passed read-only
 */
function verifyExistingReadOnly(DatabaseSync, filePath, busyTimeoutMs, migrations, skipIntegrity, timings = null) {
  let db;
  const openStarted = performance.now();
  try {
    db = new DatabaseSync(filePath, { readOnly: true, timeout: busyTimeoutMs });
  } catch (err) {
    throw toStorageError(err, 'open_readonly');
  }
  if (timings) timings.openRoMs = performance.now() - openStarted;
  try {
    try {
      db.exec(`PRAGMA mmap_size = ${READONLY_CHECK_MMAP_BYTES}`);
    } catch {
      // Best effort speed-up only; the checks below are identical without it.
    }
    verifyExistingStore(db, migrations, skipIntegrity, timings);
    return true;
  } catch (err) {
    const cause = err instanceof StorageError && err.cause !== undefined ? err.cause : err;
    if (sqlitePrimaryCode(cause) === SQLITE_PRIMARY_CODES.READONLY) return false;
    throw toStorageError(err, 'open');
  } finally {
    closeQuietly(db);
  }
}

/**
 * Open the consolidated store in `dir`, creating it when absent unless
 * `create: false`.
 *
 * @param {{
 *   dir: string,
 *   filename?: string,
 *   create?: boolean,
 *   fs?: StorageFs,
 *   loadSqlite?: () => { DatabaseSync: typeof import('node:sqlite').DatabaseSync },
 *   checkRuntime?: () => { node: string, sqlite: string },
 *   busyTimeoutMs?: number,
 *   migrations?: ReadonlyArray<import('./migrations.js').StorageMigration>,
 *   now?: () => number,
 *   fullCheck?: boolean,
 *   onDiag?: (diag: Record<string, unknown>) => void,
 * }} options `onDiag` receives one object after a successful open: clean-marker result and per-step timings.
 *   `fullCheck` forces integrity_check even when a valid clean marker
 *   exists (see the module comment for the other triggers). `create` (default true): false turns a missing or zero-length
 *   file into `missing` instead of creating an empty store (a file removed
 *   between that check and the open is still created). `migrations`, `fs`,
 *   `loadSqlite`, `checkRuntime` and `now` are test-only seams; production
 *   callers always use CORE_MIGRATIONS.
 * @returns {StorageDbHandle}
 * @throws {StorageError} unsupported_runtime | missing | corrupt | conflict | busy | io | full_disk
 */
export function openStorageDb(options) {
  const { dir, filename = DEFAULT_STORAGE_DB_FILENAME, create = true } = options || {};
  const runtime = (options?.checkRuntime || checkStorageRuntime)();
  const busyTimeoutMs = resolveBusyTimeout(options?.busyTimeoutMs);
  const { filePath, hasData } = resolveDbPath(options?.fs || nodeFs, dir, filename);
  if (!hasData && create === false) {
    throw new StorageError(STORAGE_ERROR_CODES.MISSING, 'Storage database file is missing or empty', {
      details: { operation: 'open' },
    });
  }
  const migrations = options?.migrations || CORE_MIGRATIONS;
  const { DatabaseSync } = (options?.loadSqlite || loadNodeSqlite)();
  // The marker is consumed on every open of an existing file, whatever the outcome.
  const markerFs = { ...nodeFs, ...(options?.fs || {}) };
  const nowMs = (options?.now || Date.now)();
  const openStartedAt = performance.now();
  const marker = hasData ? consumeCleanMarker(markerFs, filePath) : { clean: false, lastFullCheckAt: 0, reason: 'new_file' };
  const timings = /** @type {Record<string, number>} */ ({});
  const skipIntegrity = marker.clean && options?.fullCheck !== true && process.env.CRETLI_STORAGE_FULL_CHECK !== '1'
    && nowMs - marker.lastFullCheckAt < FULL_CHECK_MAX_AGE_MS && marker.lastFullCheckAt <= nowMs;
  // A new file has nothing to check; otherwise the stamp only moves when a full check ran now.
  const lastFullCheckAt = skipIntegrity ? marker.lastFullCheckAt : nowMs;
  const verified = hasData ? verifyExistingReadOnly(DatabaseSync, filePath, busyTimeoutMs, migrations, skipIntegrity, timings) : false;
  let db;
  const rwStarted = performance.now();
  try {
    db = new DatabaseSync(filePath, { timeout: busyTimeoutMs });
  } catch (err) {
    throw toStorageError(err, 'open');
  }
  timings.openRwMs = performance.now() - rwStarted;
  let schemaVersion;
  try {
    enforcePragma(db, 'busy_timeout', `PRAGMA busy_timeout = ${busyTimeoutMs}`, 'timeout', (v) => Number(v) === busyTimeoutMs);
    enforcePragma(db, 'foreign_keys', 'PRAGMA foreign_keys = ON', 'foreign_keys', (v) => Number(v) === 1);
    // Hot rollback journal fallback: SQLite replays it on this first read.
    if (hasData && !verified) verifyExistingStore(db, migrations, skipIntegrity, timings);
    const walStarted = performance.now();
    enforcePragma(db, 'journal_mode', 'PRAGMA journal_mode = WAL', 'journal_mode', (v) => String(v).toLowerCase() === 'wal', JOURNAL_MODE_RETRIES);
    enforcePragma(db, 'synchronous', 'PRAGMA synchronous = FULL', 'synchronous', (v) => Number(v) === SYNCHRONOUS_FULL);
    timings.walMs = performance.now() - walStarted;
    const migrateStarted = performance.now();
    const result = applyMigrations(db, { migrations, now: options?.now });
    timings.migrateMs = performance.now() - migrateStarted;
    if (result.applied.length > 0) verifyForeignKeys(db, 'post_migration');
    schemaVersion = result.version;
  } catch (err) {
    closeQuietly(db);
    throw toStorageError(err, 'open');
  }
  try {
    options?.onDiag?.({
      hasData,
      marker: marker.clean ? 'clean' : 'unclean',
      reason: marker.reason,
      // Age of the last full check; null when no marker vouched for the file.
      lastFullCheckAgeMs: marker.clean ? Math.max(0, nowMs - marker.lastFullCheckAt) : null,
      fullCheckRan: hasData && !skipIntegrity,
      timings: { ...timings, totalMs: performance.now() - openStartedAt },
    });
  } catch {
    // Diagnostics must never fail an open.
  }
  return createHandle(db, { filename, filePath, schemaVersion, runtime, fs: markerFs, lastFullCheckAt });
}

/**
 * Durability barrier shared by every fresh storage connection (worker start,
 * benchmark reopen): `wal_checkpoint(TRUNCATE)` under synchronous=FULL fsyncs
 * the WAL, copies every frame into the database file, fsyncs it and resets the
 * WAL. Only a fully completed checkpoint (busy = 0, every frame checkpointed)
 * counts; anything else throws a plain Error and the caller decides how to
 * report it.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {{ busy: number, log: number, checkpointed: number }}
 */
export function runWalTruncateBarrier(db) {
  const row = /** @type {Record<string, unknown>} */ (db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get());
  const result = { busy: Number(row.busy), log: Number(row.log), checkpointed: Number(row.checkpointed) };
  if (result.busy !== 0 || result.checkpointed !== result.log) {
    throw new Error('wal_checkpoint(TRUNCATE) did not complete');
  }
  return result;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ filename: string, filePath: string, schemaVersion: number, runtime: { node: string, sqlite: string }, fs: StorageFs, lastFullCheckAt: number }} meta
 * @returns {StorageDbHandle}
 */
function createHandle(db, meta) {
  let closed = false;
  let dirty = false;
  return Object.freeze({
    get db() {
      if (closed) {
        throw new StorageError(STORAGE_ERROR_CODES.IO, 'Storage database handle is closed', {
          retryable: false,
          details: { operation: 'use' },
        });
      }
      return db;
    },
    filename: meta.filename,
    filePath: meta.filePath,
    schemaVersion: meta.schemaVersion,
    runtime: Object.freeze({ node: meta.runtime.node, sqlite: meta.runtime.sqlite }),
    isClosed: () => closed,
    /** Taint the connection: a later close() will not write the clean marker. */
    markDirty() {
      dirty = true;
    },
    /**
     * @param {{ clean?: boolean }} [closeOptions] `clean: false` (abandoned
     *   connection) never writes the clean marker, like a dirty handle.
     */
    close(closeOptions) {
      if (closed) return;
      closed = true;
      try {
        db.close();
      } catch (err) {
        throw toStorageError(err, 'close');
      }
      if (!dirty && closeOptions?.clean !== false) writeCleanMarker(meta.fs, meta.filePath, meta.lastFullCheckAt);
    },
  });
}

/** Default bound on how long startup waits for a foreign reader to release the WAL. */
export const DEFAULT_CHECKPOINT_WAIT_MS = 15000;
/** Explicit error detail code for a checkpoint that stayed blocked by a reader. */
export const CHECKPOINT_BLOCKED_BY_READER = 'CHECKPOINT_BLOCKED_BY_READER';

/**
 * True when a barrier failure means "a reader holds the WAL" (busy/locked),
 * as opposed to an I/O failure of the checkpoint itself.
 *
 * @param {unknown} err
 */
function isReaderBlock(err) {
  const e = /** @type {any} */ (err);
  const primary = Number(e?.errcode) % 256;
  return primary === SQLITE_PRIMARY_CODES.BUSY || primary === SQLITE_PRIMARY_CODES.LOCKED || /database (is|table) (locked|busy)|SQLITE_(BUSY|LOCKED)/i.test(String(e?.message ?? ''));
}

/**
 * {@link runWalTruncateBarrier} that tolerates a long reader in another
 * process: a busy checkpoint is retried with backoff until `maxWaitMs` has
 * elapsed (worst case about `maxWaitMs` + the connection's busy_timeout, since
 * each attempt may itself block that long)
 * (this wait is independent of the host's start-attempt budget). Without
 * readers the first attempt completes, so the F29 guarantee is unchanged. If
 * the reader outlives the wait this fails closed with a non-retryable
 * StorageError (`details.operation === CHECKPOINT_BLOCKED_BY_READER`, the only whitelisted detail slot), so a single
 * reader never burns `maxStartAttempts`. Non-busy failures are rethrown as-is.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ maxWaitMs?: number, sleep?: (ms: number) => void, now?: () => number }} [options]
 * @returns {{ busy: number, log: number, checkpointed: number }}
 */
export function runWalTruncateBarrierBounded(db, options = {}) {
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_CHECKPOINT_WAIT_MS;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));
  const deadline = now() + maxWaitMs;
  let delay = 25;
  for (;;) {
    try {
      const row = /** @type {Record<string, unknown>} */ (db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get());
      const result = { busy: Number(row.busy), log: Number(row.log), checkpointed: Number(row.checkpointed) };
      if (result.busy === 0 && result.checkpointed === result.log) return result;
      // busy=1 means a reader/writer blocked the checkpoint; retry below.
    } catch (err) {
      if (!isReaderBlock(err)) throw err;
    }
    if (now() >= deadline) {
      throw new StorageError(STORAGE_ERROR_CODES.BUSY, 'wal_checkpoint(TRUNCATE) blocked by a reader', {
        retryable: false,
        details: { operation: CHECKPOINT_BLOCKED_BY_READER },
      });
    }
    sleep(Math.min(delay, Math.max(1, deadline - now())));
    delay = Math.min(delay * 2, 500);
  }
}
