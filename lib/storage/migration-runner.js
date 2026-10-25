/**
 * Restart-safe migration runner for data steps (A2 S7; mechanism only).
 *
 * `applyMigrations()` (migrations.js) versions the schema. This runner executes
 * ordered, versioned *steps* on top of it and journals every one in
 * `storage_migration_journal`, so a crash at any point resumes from the last
 * committed chunk: a `done` step is never re-applied and no step is skipped.
 *
 * Step kinds:
 *   - `sql`     pure SQL (`sql`); journalled `done` in the SAME transaction.
 *   - `atomic`  `apply(db)`; one transaction, same journalling as `sql`.
 *   - `chunked` `run(ctx)` processes one bounded chunk and returns
 *               `{ done, cursor }`. The runner persists the cursor in the same
 *               transaction as the chunk's writes, so a chunk is applied
 *               exactly once and a crash replays at most the uncommitted chunk.
 *
 * Every step needs a `version` string that is part of its checksum (the
 * checksum also covers id, kind, `sql` and `touchesUserData`). Changing a
 * step's definition after it started is `conflict` (fail closed).
 *
 * This module is synchronous and takes a connection from `openStorageDb()`.
 * It owns its transactions (`BEGIN IMMEDIATE`), so it must run on a dedicated
 * handle (storage worker boot before the command queue is served, or a
 * maintenance connection with writers drained), never inside a worker command
 * handler that already runs in a host transaction. It has no async facade and
 * never blocks on another thread. See migration-runner.md.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { StorageError, STORAGE_ERROR_CODES } from './errors.js';
import { toStorageError } from './sqlite-errors.js';
import { assertWorkDirOutsideRestorePaths, fsyncDirectory, lstatOrNull, replaceOwnFileDurable } from './history-migration-fs.js';

export const MIGRATION_JOURNAL_TABLE = 'storage_migration_journal';
export const DEFAULT_MAX_ATTEMPTS = 3;
export const MAX_ATTEMPTS_LIMIT = 10;
export const DEFAULT_MAX_CHUNK_MS = 50;
export const MAX_CHUNK_MS_LIMIT = 1000;
export const DEFAULT_MAX_CHUNK_ITEMS = 500;
export const MAX_CHUNK_ITEMS_LIMIT = 10000;
export const DEFAULT_MAX_CHUNKS_PER_RUN = 10000;
/** Largest serialized cursor the journal accepts. */
export const MAX_CURSOR_BYTES = 65536;

const STEP_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

const JOURNAL_DDL = `
CREATE TABLE IF NOT EXISTS ${MIGRATION_JOURNAL_TABLE} (
  step_id TEXT PRIMARY KEY CHECK (length(step_id) BETWEEN 1 AND 128),
  state TEXT NOT NULL CHECK (state IN ('started', 'done', 'failed')),
  attempts INTEGER NOT NULL CHECK (attempts >= 1),
  resumes INTEGER NOT NULL DEFAULT 0 CHECK (resumes >= 0),
  chunks INTEGER NOT NULL DEFAULT 0 CHECK (chunks >= 0),
  cursor TEXT,
  checksum TEXT NOT NULL CHECK (length(checksum) = 64),
  backup_ref TEXT,
  error_code TEXT,
  started_at INTEGER NOT NULL CHECK (started_at >= 0),
  finished_at INTEGER CHECK (finished_at IS NULL OR finished_at >= 0)
) STRICT;
`;

/**
 * @typedef {{
 *   id: string,
 *   kind: 'sql' | 'atomic' | 'chunked',
 *   version: string,
 *   touchesUserData?: boolean,
 *   sql?: string,
 *   apply?: (db: import('node:sqlite').DatabaseSync) => void,
 *   run?: (ctx: ChunkContext) => { done: boolean, cursor?: unknown },
 * }} MigrationStep
 *
 * @typedef {{
 *   db: import('node:sqlite').DatabaseSync,
 *   cursor: unknown,
 *   chunkIndex: number,
 *   maxItems: number,
 *   deadlineMs: number,
 *   shouldYield: () => boolean,
 * }} ChunkContext
 *
 * @typedef {{
 *   id: string, kind: string, state: 'pending' | 'started' | 'failed',
 *   attempts: number, chunks: number, cursor: unknown, touchesUserData: boolean,
 * }} PendingStep
 */

/** Proves a target directory was published by a migration switch, so a later switch may replace it. */
export const SWITCH_OWNER_MARKER_FILE = 'MIGRATION-OWNER.json';
export const SWITCH_OWNER_MARKER_SCHEMA = 'cretli-migration-owner-v1';

/** Marks an error thrown by a fault hook: a crash, so nothing is journalled. */
class SimulatedCrash extends Error {
  /** @param {unknown} cause */
  constructor(cause) {
    super('simulated crash');
    this.cause = cause;
  }
}

/**
 * @param {string} kind
 * @param {string} message
 * @param {Record<string, unknown>} [details]
 * @param {string} [code]
 */
function migrationError(kind, message, details = {}, code = STORAGE_ERROR_CODES.CONFLICT) {
  return new StorageError(code, message, { details: { operation: 'migration_run', conflictKind: kind, ...details } });
}

/**
 * Checksum of a step definition (id, kind, version, sql, touchesUserData).
 *
 * @param {MigrationStep} step
 * @returns {string} sha256 hex
 */
export function computeStepChecksum(step) {
  const canonical = JSON.stringify([step.id, step.kind, step.version, step.sql ?? null, Boolean(step.touchesUserData)]);
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Wrap a CORE_MIGRATIONS-style entry (`version`, `name`, `sql` | `up`) as a step.
 *
 * @param {import('./migrations.js').StorageMigration} migration
 * @returns {MigrationStep}
 */
export function stepFromMigration(migration) {
  const id = `schema-${String(migration.version).padStart(4, '0')}-${migration.name}`;
  if (typeof migration.sql === 'string') return { id, kind: 'sql', version: String(migration.version), sql: migration.sql };
  return { id, kind: 'atomic', version: String(migration.version), apply: /** @type {any} */ (migration.up) };
}

/**
 * @param {ReadonlyArray<MigrationStep>} steps
 */
function assertStepList(steps) {
  if (!Array.isArray(steps)) throw new TypeError('Migration steps must be an array');
  const seen = new Set();
  for (const step of steps) {
    if (!step || typeof step.id !== 'string' || !STEP_ID_PATTERN.test(step.id)) {
      throw new TypeError(`Migration step id must match ${STEP_ID_PATTERN}`);
    }
    if (seen.has(step.id)) throw new TypeError(`Duplicate migration step id ${step.id}`);
    seen.add(step.id);
    if (typeof step.version !== 'string' || !step.version.trim()) throw new TypeError(`Migration step ${step.id} needs a version`);
    const impl = { sql: typeof step.sql === 'string', atomic: typeof step.apply === 'function', chunked: typeof step.run === 'function' };
    const expected = { sql: 'sql', atomic: 'atomic', chunked: 'chunked' }[step.kind];
    if (!expected) throw new TypeError(`Migration step ${step.id} has unknown kind`);
    const present = Object.entries(impl).filter(([, v]) => v).map(([k]) => k);
    if (present.length !== 1 || present[0] !== expected) {
      throw new TypeError(`Migration step ${step.id} (${step.kind}) must define exactly its own implementation`);
    }
  }
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {boolean}
 */
function hasJournal(db) {
  return Boolean(db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?").get(MIGRATION_JOURNAL_TABLE));
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} stepId
 * @returns {Record<string, any> | undefined}
 */
function readRow(db, stepId) {
  return /** @type {any} */ (db.prepare(`SELECT * FROM ${MIGRATION_JOURNAL_TABLE} WHERE step_id = ?`).get(stepId));
}

/**
 * Validate the journal against the step list: unknown journal steps, checksum
 * drift and out-of-order `done` rows all fail closed.
 *
 * @param {Map<string, Record<string, any>>} rows
 * @param {ReadonlyArray<MigrationStep>} steps
 */
function verifyJournal(rows, steps) {
  const known = new Set(steps.map((s) => s.id));
  for (const id of rows.keys()) {
    if (!known.has(id)) throw migrationError('migration_unknown_step', `Journal has a step this build does not know: ${id}`);
  }
  let gap = false;
  for (const step of steps) {
    const row = rows.get(step.id);
    if (row && row.checksum !== computeStepChecksum(step)) {
      throw migrationError('migration_checksum_mismatch', `Migration step ${step.id} changed after it started`, {}, STORAGE_ERROR_CODES.CONFLICT);
    }
    if (row?.state === 'done' && gap) {
      throw new StorageError(STORAGE_ERROR_CODES.CORRUPT, `Migration step ${step.id} is done but an earlier step is not`, {
        details: { operation: 'migration_run', conflictKind: 'migration_order_violation' },
      });
    }
    if (!row || row.state !== 'done') gap = true;
  }
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {ReadonlyArray<MigrationStep>} steps
 * @returns {Map<string, Record<string, any>>}
 */
function loadJournal(db, steps) {
  /** @type {Map<string, Record<string, any>>} */
  const rows = new Map();
  try {
    if (hasJournal(db)) {
      for (const row of /** @type {any[]} */ (db.prepare(`SELECT * FROM ${MIGRATION_JOURNAL_TABLE}`).all())) rows.set(row.step_id, row);
    }
  } catch (err) {
    throw toStorageError(err, 'migration_journal_read');
  }
  verifyJournal(rows, steps);
  return rows;
}

/**
 * @param {Record<string, any> | undefined} row
 * @returns {unknown}
 */
function parseCursor(row) {
  if (!row || row.cursor === null || row.cursor === undefined) return null;
  try {
    return JSON.parse(row.cursor);
  } catch (err) {
    throw new StorageError(STORAGE_ERROR_CODES.CORRUPT, 'Migration journal cursor is not valid JSON', {
      cause: err, details: { operation: 'migration_run' },
    });
  }
}

/**
 * Read-only plan: the steps a run would execute, after the same journal
 * verification a real run performs. Writes nothing (not even the journal table).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {ReadonlyArray<MigrationStep>} steps
 * @returns {PendingStep[]}
 */
export function planMigrations(db, steps) {
  assertStepList(steps);
  const rows = loadJournal(db, steps);
  return steps.filter((s) => rows.get(s.id)?.state !== 'done').map((s) => {
    const row = rows.get(s.id);
    return {
      id: s.id,
      kind: s.kind,
      state: /** @type {'pending' | 'started' | 'failed'} */ (row ? row.state : 'pending'),
      attempts: row ? Number(row.attempts) : 0,
      chunks: row ? Number(row.chunks) : 0,
      cursor: parseCursor(row),
      touchesUserData: Boolean(s.touchesUserData),
    };
  });
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} limit
 * @param {string} name
 * @returns {number}
 */
function boundedInt(value, fallback, limit, name) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || /** @type {number} */ (value) < 1 || /** @type {number} */ (value) > limit) {
    throw new TypeError(`${name} must be an integer in 1..${limit}`);
  }
  return /** @type {number} */ (value);
}

/**
 * Operator escape hatch: re-arm a `failed` step with a fresh attempt budget.
 * Refuses `done` and `started` rows. A chunked step that already committed
 * chunks keeps its cursor and chunk count (row goes back to `started`, attempts
 * 1) so it resumes instead of replaying committed chunks from the beginning;
 * pass `discardProgress: true` to forget the row entirely and start from
 * chunk 0. A failed row without progress is always forgotten.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} stepId
 * @param {{ assertWritable: () => void, discardProgress?: boolean }} options
 * @returns {boolean} true when a failed row was re-armed or cleared
 */
export function resetFailedStep(db, stepId, options) {
  if (typeof options?.assertWritable !== 'function') throw new TypeError('assertWritable callback is required');
  options.assertWritable();
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = readRow(db, stepId);
      let changed = false;
      if (row?.state === 'failed') {
        const hasProgress = Number(row.chunks) > 0 || (row.cursor !== null && row.cursor !== undefined);
        if (hasProgress && !options.discardProgress) {
          db.prepare(`UPDATE ${MIGRATION_JOURNAL_TABLE} SET state = 'started', attempts = 1, error_code = NULL, finished_at = NULL WHERE step_id = ?`).run(stepId);
        } else {
          db.prepare(`DELETE FROM ${MIGRATION_JOURNAL_TABLE} WHERE step_id = ? AND state = 'failed'`).run(stepId);
        }
        changed = true;
      }
      options.assertWritable();
      db.exec('COMMIT');
      return changed;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    }
  } catch (err) {
    throw toStorageError(err, 'migration_reset');
  }
}

/**
 * Run (or resume) the pending steps in order.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {ReadonlyArray<MigrationStep>} steps
 * @param {{
 *   assertWritable?: () => void,
 *   backupBeforeStep?: (info: { stepId: string, kind: string }) => string | void,
 *   dryRun?: boolean,
 *   maxAttempts?: number,
 *   maxChunkMs?: number,
 *   maxChunkItems?: number,
 *   maxChunksPerRun?: number,
 *   onProgress?: (event: Record<string, unknown>) => void,
 *   faultHook?: (point: string, info: Record<string, unknown>) => void,
 *   now?: () => number,
 *   monotonicNow?: () => number,
 * }} [options] `assertWritable` is required unless `dryRun`; it throws when
 *   the coordinator is not owner, is fenced or restore is paused, and is
 *   checked before each transaction and again before its COMMIT.
 *   `backupBeforeStep` is required for any pending step with `touchesUserData`.
 *   `faultHook` is a test seam: a throw simulates a crash at that point.
 * @returns {{ status: 'complete' | 'paused' | 'dry_run', applied: string[], pending: PendingStep[] }}
 *   `paused`: `maxChunksPerRun` chunks ran; call again to continue.
 * @throws {StorageError} conflict (checksum/unknown step/attempts/backup) | corrupt | mapped SQLite errors.
 */
export function runMigrations(db, steps, options = {}) {
  assertStepList(steps);
  if (options.dryRun) {
    return { status: 'dry_run', applied: [], pending: planMigrations(db, steps) };
  }
  const { assertWritable } = options;
  if (typeof assertWritable !== 'function') throw new TypeError('assertWritable callback is required');
  const maxAttempts = boundedInt(options.maxAttempts, DEFAULT_MAX_ATTEMPTS, MAX_ATTEMPTS_LIMIT, 'maxAttempts');
  const maxChunkMs = boundedInt(options.maxChunkMs, DEFAULT_MAX_CHUNK_MS, MAX_CHUNK_MS_LIMIT, 'maxChunkMs');
  const maxItems = boundedInt(options.maxChunkItems, DEFAULT_MAX_CHUNK_ITEMS, MAX_CHUNK_ITEMS_LIMIT, 'maxChunkItems');
  const maxChunks = boundedInt(options.maxChunksPerRun, DEFAULT_MAX_CHUNKS_PER_RUN, DEFAULT_MAX_CHUNKS_PER_RUN, 'maxChunksPerRun');
  const now = options.now || Date.now;
  const monotonic = options.monotonicNow || (() => performance.now());
  const stamp = () => Math.max(0, Math.trunc(now()));
  const emit = (event) => {
    try { options.onProgress?.(event); } catch { /* observers must not affect the run */ }
  };
  const fault = (point, info) => {
    if (!options.faultHook) return;
    try { options.faultHook(point, info); } catch (err) { throw new SimulatedCrash(err); }
  };

  assertWritable();
  ensureJournal(db, assertWritable);
  const pending = planMigrations(db, steps);
  const needsBackup = pending.filter((p) => p.touchesUserData);
  if (needsBackup.length > 0 && typeof options.backupBeforeStep !== 'function') {
    throw migrationError('migration_backup_required', 'A pending step touches user data and no backup callback was supplied',
      { missingFeatures: needsBackup.map((p) => p.id) });
  }
  emit({ type: 'plan', pending: pending.map((p) => p.id) });

  const applied = [];
  let chunksRun = 0;
  try {
    for (const step of steps) {
      const outcome = executeStep(step, pending.find((p) => p.id === step.id));
      if (outcome === 'skipped') continue;
      if (outcome === 'paused') {
        emit({ type: 'paused', stepId: step.id });
        return { status: 'paused', applied, pending: planMigrations(db, steps) };
      }
      applied.push(step.id);
    }
  } catch (err) {
    if (err instanceof SimulatedCrash) throw err.cause;
    throw err;
  }
  return { status: 'complete', applied, pending: [] };

  /**
   * @param {MigrationStep} step
   * @param {PendingStep | undefined} plan
   * @returns {'skipped' | 'done' | 'paused'}
   */
  function executeStep(step, plan) {
    if (!plan) return 'skipped';
    const checksum = computeStepChecksum(step);
    if (plan.state === 'failed' && plan.attempts >= maxAttempts) {
      throw migrationError('migration_attempts_exhausted', `Migration step ${step.id} failed ${plan.attempts} time(s); reset it to retry`, {
        actualRevision: plan.attempts, expectedRevision: maxAttempts,
      });
    }
    let backupRef = null;
    if (step.touchesUserData && !hasBackup(step.id)) backupRef = takeBackup(step);
    fault('before-step', { stepId: step.id });
    emit({ type: 'step-start', stepId: step.id, kind: step.kind, state: plan.state });
    try {
      const result = step.kind === 'chunked' ? runChunked(step, checksum, backupRef) : runAtomic(step, checksum, backupRef);
      if (result === 'paused') return 'paused';
      fault('step-committed', { stepId: step.id });
      emit({ type: 'step-done', stepId: step.id });
      return 'done';
    } catch (err) {
      if (err instanceof SimulatedCrash) throw err;
      // Operator-visible refusals (fenced, paused, ...) are not step failures.
      if (!(err instanceof StepFailure)) throw toStorageError(err, 'migration_step');
      const failure = toStorageError(err.cause, 'migration_step');
      recordFailure(step, checksum, backupRef, failure);
      emit({ type: 'step-failed', stepId: step.id, code: failure.code });
      throw failure;
    }
  }

  /** @param {string} stepId */
  function hasBackup(stepId) {
    return Boolean(readRow(db, stepId)?.backup_ref);
  }

  /** @param {MigrationStep} step */
  function takeBackup(step) {
    let ref;
    try {
      ref = options.backupBeforeStep?.({ stepId: step.id, kind: step.kind });
    } catch (err) {
      throw toStorageError(err, 'migration_backup');
    }
    if (ref && typeof (/** @type {any} */ (ref)).then === 'function') {
      throw new TypeError('backupBeforeStep must be synchronous');
    }
    fault('after-backup', { stepId: step.id });
    return typeof ref === 'string' && ref ? ref.slice(0, 200) : 'backup';
  }

  /**
   * Runs `fn` in one BEGIN IMMEDIATE transaction with the writable check
   * before and after it; errors from `fn` are tagged StepFailure.
   *
   * @template T
   * @param {() => T} fn
   * @returns {T}
   */
  function inTransaction(fn) {
    assertWritable();
    try {
      db.exec('BEGIN IMMEDIATE');
    } catch (err) {
      throw toStorageError(err, 'migrate_begin');
    }
    try {
      const value = fn();
      assertWritable();
      if (typeof db.isTransaction === 'boolean' && !db.isTransaction) {
        throw new StepFailure(new StorageError(STORAGE_ERROR_CODES.CONFLICT, 'Migration step ended the transaction itself', {
          details: { operation: 'migration_run', conflictKind: 'migration_step_committed' },
        }));
      }
      fault('before-commit', {});
      db.exec('COMMIT');
      return value;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* SQLite may have rolled back already */ }
      throw err;
    }
  }

  /**
   * Run user code inside a transaction; its throw becomes a StepFailure.
   *
   * @template T
   * @param {() => T} fn
   * @returns {T}
   */
  function userCode(fn) {
    let value;
    try {
      value = fn();
    } catch (err) {
      if (err instanceof SimulatedCrash) throw err;
      throw new StepFailure(err);
    }
    // Checked right after user code and before any journal write: a step that
    // ran COMMIT/ROLLBACK itself must never leave a `done` row behind.
    if (typeof db.isTransaction === 'boolean' && !db.isTransaction) {
      throw new StepFailure(new StorageError(STORAGE_ERROR_CODES.CONFLICT, 'Migration step ended the transaction itself', {
        details: { operation: 'migration_run', conflictKind: 'migration_step_committed' },
      }));
    }
    return value;
  }

  /** @type {(step: MigrationStep, checksum: string, backupRef: string | null) => 'done'} */
  function runAtomic(step, checksum, backupRef) {
    inTransaction(() => {
      const row = readRow(db, step.id);
      if (row?.state === 'done') return;
      const attempts = row ? (row.state === 'failed' ? Number(row.attempts) + 1 : Number(row.attempts)) : 1;
      userCode(() => {
        if (step.kind === 'sql') db.exec(/** @type {string} */ (step.sql));
        else /** @type {Function} */ (step.apply)(db);
      });
      upsertRow(step.id, { state: 'done', attempts, checksum, backupRef: backupRef ?? row?.backup_ref ?? null, cursor: null, finished: true });
      fault('step-before-commit', { stepId: step.id });
    });
    return 'done';
  }

  /** @type {(step: MigrationStep, checksum: string, backupRef: string | null) => 'done' | 'paused'} */
  function runChunked(step, checksum, backupRef) {
    inTransaction(() => {
      const row = readRow(db, step.id);
      if (row?.state === 'done') return;
      if (!row) upsertRow(step.id, { state: 'started', attempts: 1, checksum, backupRef, cursor: null, finished: false });
      else if (row.state === 'failed') upsertRow(step.id, { state: 'started', attempts: Number(row.attempts) + 1, checksum, backupRef: backupRef ?? row.backup_ref, cursor: row.cursor, finished: false });
      else {
        db.prepare(`UPDATE ${MIGRATION_JOURNAL_TABLE} SET resumes = resumes + 1 WHERE step_id = ?`).run(step.id);
      }
    });
    for (;;) {
      if (chunksRun >= maxChunks) return 'paused';
      chunksRun += 1;
      let chunkIndex = -1;
      const finished = inTransaction(() => {
        const row = readRow(db, step.id);
        if (!row || row.state !== 'started') {
          if (row?.state === 'done') return true;
          throw new StepFailure(new StorageError(STORAGE_ERROR_CODES.CORRUPT, 'Migration journal row vanished mid-step', {
            details: { operation: 'migration_run', conflictKind: 'migration_journal_lost' },
          }));
        }
        const previous = row.cursor ?? null;
        const startedAt = monotonic();
        const deadlineMs = startedAt + maxChunkMs;
        chunkIndex = Number(row.chunks);
        fault('chunk-run', { stepId: step.id, chunkIndex });
        const result = userCode(() => /** @type {Function} */ (step.run)({
          db, cursor: parseCursor(row), chunkIndex, maxItems, deadlineMs, shouldYield: () => monotonic() >= deadlineMs,
        }));
        if (!result || typeof result.done !== 'boolean') {
          throw new StepFailure(new TypeError(`Migration step ${step.id} must return { done, cursor }`));
        }
        const serialized = result.done ? previous : JSON.stringify(result.cursor ?? null);
        if (typeof serialized === 'string' && Buffer.byteLength(serialized) > MAX_CURSOR_BYTES) {
          throw new StepFailure(new RangeError(`Migration step ${step.id} cursor exceeds ${MAX_CURSOR_BYTES} bytes`));
        }
        if (!result.done && serialized === previous) {
          throw new StepFailure(migrationError('migration_no_progress', `Migration step ${step.id} returned an unchanged cursor`));
        }
        db.prepare(`UPDATE ${MIGRATION_JOURNAL_TABLE} SET cursor = ?, chunks = chunks + 1, state = ?, finished_at = ? WHERE step_id = ?`)
          .run(serialized ?? null, result.done ? 'done' : 'started', result.done ? stamp() : null, step.id);
        emit({ type: 'chunk', stepId: step.id, chunkIndex, done: result.done, elapsedMs: monotonic() - startedAt, overran: monotonic() > deadlineMs });
        return result.done;
      });
      fault('chunk-committed', { stepId: step.id, chunkIndex });
      if (finished) return 'done';
    }
  }

  /**
   * @param {string} stepId
   * @param {{ state: string, attempts: number, checksum: string, backupRef: string | null, cursor: string | null, finished: boolean }} v
   */
  function upsertRow(stepId, v) {
    db.prepare(`INSERT INTO ${MIGRATION_JOURNAL_TABLE}
      (step_id, state, attempts, checksum, backup_ref, cursor, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(step_id) DO UPDATE SET state = excluded.state, attempts = excluded.attempts,
        checksum = excluded.checksum, backup_ref = excluded.backup_ref, cursor = excluded.cursor,
        finished_at = excluded.finished_at, error_code = NULL`)
      .run(stepId, v.state, v.attempts, v.checksum, v.backupRef, v.cursor, stamp(), v.finished ? stamp() : null);
  }

  /**
   * Journal a failure in its own transaction (the step's was rolled back). A
   * failure to journal does not mask the original error.
   *
   * @param {MigrationStep} step
   * @param {string} checksum
   * @param {string | null} backupRef
   * @param {StorageError} failure
   */
  function recordFailure(step, checksum, backupRef, failure) {
    try {
      inTransaction(() => {
        const row = readRow(db, step.id);
        if (row?.state === 'done') return;
        if (!row) {
          upsertRow(step.id, { state: 'failed', attempts: 1, checksum, backupRef, cursor: null, finished: true });
        } else {
          const attempts = row.state === 'failed' ? Number(row.attempts) + 1 : Number(row.attempts);
          db.prepare(`UPDATE ${MIGRATION_JOURNAL_TABLE} SET state = 'failed', attempts = ?, finished_at = ? WHERE step_id = ?`)
            .run(attempts, stamp(), step.id);
        }
        db.prepare(`UPDATE ${MIGRATION_JOURNAL_TABLE} SET error_code = ? WHERE step_id = ?`).run(failure.code, step.id);
      });
    } catch {
      // The original failure is what the caller needs.
    }
  }
}

/** Tags an error thrown by step code so it is journalled as a step failure. */
class StepFailure extends Error {
  /** @param {unknown} cause */
  constructor(cause) {
    super('migration step failed', { cause });
    this.cause = cause;
  }
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {() => void} assertWritable
 */
function ensureJournal(db, assertWritable) {
  try {
    if (hasJournal(db)) return;
    assertWritable();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(JOURNAL_DDL);
      assertWritable();
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    }
  } catch (err) {
    throw toStorageError(err, 'migration_journal_init');
  }
}

/**
 * @param {string} dir
 * @returns {boolean} true when `dir` carries a valid ownership marker
 */
function hasOwnerMarker(dir) {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(dir, SWITCH_OWNER_MARKER_FILE), 'utf8'));
    return marker?.schema === SWITCH_OWNER_MARKER_SCHEMA;
  } catch {
    return false;
  }
}

/**
 * Switch phase of a directory-level migration: publish the finished `workDir` as `target`.
 *
 * - `workDir` must be a real directory outside every restore path (a restore would replace it).
 * - A missing target is simply replaced by the rename.
 * - An existing target WITHOUT the ownership marker is foreign data: refused, never touched.
 * - An existing target WITH the marker is renamed to `<target>.backup-<opId>` before the swap and
 *   moved back if the swap fails, so a failure never leaves the target missing.
 * The new target gets the marker, so the next migration may replace it in turn.
 *
 * @param {{ workDir: string, target: string, restorePaths?: string[], opId: string, now?: () => number }} options
 * @returns {{ target: string, backup: string | null }}
 * @throws {HistoryMigrationError} workdir_in_restore_path
 * @throws {StorageError} conflict: switch_target_unowned | switch_backup_exists | switch_target_invalid
 */
export function switchMigrationTarget(options) {
  if (typeof options.opId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(options.opId)) {
    throw migrationError('switch_op_id_invalid', 'opId must be a plain name');
  }
  const workDir = assertWorkDirOutsideRestorePaths(options.workDir, options.restorePaths ?? []);
  const target = path.resolve(options.target);
  if (!path.isAbsolute(target) || path.dirname(target) === target) throw migrationError('switch_target_invalid', 'Target must be an absolute non-root path');
  if (!path.relative(workDir, target).startsWith('..')) {
    throw migrationError('switch_target_invalid', 'Target must not equal or sit inside the work directory');
  }
  const existing = lstatOrNull(target);
  /** @type {string | null} */
  let backup = null;
  if (existing) {
    if (!existing.isDirectory() || !hasOwnerMarker(target)) {
      throw migrationError('switch_target_unowned', 'Existing target carries no migration ownership marker; it was left untouched');
    }
    backup = `${target}.backup-${options.opId}`;
    if (lstatOrNull(backup)) throw migrationError('switch_backup_exists', 'Backup path already exists; nothing was replaced', { backup });
  }
  const now = options.now ?? Date.now;
  replaceOwnFileDurable(path.join(workDir, SWITCH_OWNER_MARKER_FILE), `${JSON.stringify({
    schema: SWITCH_OWNER_MARKER_SCHEMA, opId: options.opId, switchedAt: new Date(now()).toISOString(),
  }, null, 2)}\n`);
  if (backup) fs.renameSync(target, backup);
  try {
    fs.renameSync(workDir, target);
  } catch (error) {
    if (backup) {
      try { fs.renameSync(backup, target); } catch { /* the backup stays beside the target for the operator */ }
    }
    throw error;
  }
  fsyncDirectory(path.dirname(target));
  return { target, backup };
}
