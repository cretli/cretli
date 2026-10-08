/**
 * Durable recovery registry (leaf R2): intent-before-launch store, attempts and
 * the compare-and-swap lifecycle transition used by every later recovery leaf.
 *
 * Backend decision (documented in docs/recovery-store.md): SQLite through the
 * built-in `node:sqlite` `DatabaseSync`, `journal_mode=WAL`, `busy_timeout`,
 * `foreign_keys=ON` and — uniquely for the recovery registry — `synchronous=FULL`
 * so a committed *intent* survives a process or OS crash, not merely a crash of
 * the JS process. A JSON+fsync store was rejected because it cannot offer an
 * atomic multi-row CAS or real inter-process contention.
 *
 * Scope boundary: this module is persistence only. It does not touch the
 * runtime (`chat-run-service.js`, `delegation-service.js`,
 * `workspace-watcher*.js`, routes) and it does not implement recovery policy.
 * It never stores prompt content or secrets: rows carry metadata (ids, states,
 * owner/workspace, model, timing) only.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resolveDataPath } from '../runtime-paths.js';
import {
  RECOVERY_SCHEMA_VERSION,
  RUN_ACTIVE_STATES,
  canTransitionRunLifecycle,
  normalizeRunAgentOutcome,
  normalizeRunAgentVerdict,
  normalizeRunInfraOutcome,
  normalizeRunInterruptReason,
  normalizeRunLifecycleState,
  ownerOfRunFamily,
} from './recovery-contract.js';
import { isRecoveryId } from './recovery-ids.js';

/**
 * Persisted schema version of the recovery SQLite file.
 *
 * - v1: runs / attempts / requests (leaf R2).
 * - v2: adds the singleton `recovery_owner_lease` row (leaf R3).
 * - v3: adds `recovery_queue`, `recovery_cancels` and `recovery_waiting`
 *   (leaf R4: durable approved-prompt queue, durable Stop/cancel and durable
 *   waiting for a question/approval). The migration is additive and idempotent
 *   (`CREATE TABLE IF NOT EXISTS`), so a v1/v2 file is upgraded in place and a
 *   file above this version still fails closed.
 */
export const RECOVERY_STORE_SCHEMA_VERSION = 3;

/** Default `busy_timeout` for the recovery store. */
export const RECOVERY_STORE_DEFAULT_BUSY_TIMEOUT_MS = 8000;

/** Synchronous modes accepted from callers. */
const ALLOWED_SYNCHRONOUS = Object.freeze(['OFF', 'NORMAL', 'FULL', 'EXTRA']);

const DDL = `
CREATE TABLE IF NOT EXISTS recovery_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS recovery_runs (
  logical_run_id TEXT PRIMARY KEY,
  family TEXT NOT NULL,
  owner TEXT NOT NULL,
  state TEXT NOT NULL,
  workspace_folder TEXT NOT NULL DEFAULT '',
  chat_id TEXT NOT NULL DEFAULT '',
  generation INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  request_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  json TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_recovery_runs_request
  ON recovery_runs(request_id) WHERE request_id != '';
CREATE INDEX IF NOT EXISTS idx_recovery_runs_family_state
  ON recovery_runs(family, state);
CREATE INDEX IF NOT EXISTS idx_recovery_runs_workspace
  ON recovery_runs(workspace_folder);
CREATE TABLE IF NOT EXISTS recovery_attempts (
  attempt_id TEXT PRIMARY KEY,
  logical_run_id TEXT NOT NULL,
  request_id TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  json TEXT NOT NULL,
  FOREIGN KEY (logical_run_id) REFERENCES recovery_runs(logical_run_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_recovery_attempts_request
  ON recovery_attempts(request_id) WHERE request_id != '';
CREATE INDEX IF NOT EXISTS idx_recovery_attempts_run
  ON recovery_attempts(logical_run_id);
CREATE TABLE IF NOT EXISTS recovery_requests (
  request_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  logical_run_id TEXT NOT NULL DEFAULT '',
  attempt_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (kind, request_id),
  FOREIGN KEY (logical_run_id) REFERENCES recovery_runs(logical_run_id)
);
CREATE INDEX IF NOT EXISTS idx_recovery_requests_run
  ON recovery_requests(logical_run_id);
CREATE TABLE IF NOT EXISTS recovery_owner_lease (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  owner_id TEXT NOT NULL,
  owner_token TEXT NOT NULL,
  pid INTEGER NOT NULL DEFAULT 0,
  pid_start TEXT NOT NULL DEFAULT '',
  generation INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  json TEXT NOT NULL
);
-- v3 (leaf R4): durable approved-prompt queue. Unlike the metadata-only base
-- tables this one DOES persist the approved prompt payload/reference, because
-- the queue must survive a crash *before* the caller acks the user.
CREATE TABLE IF NOT EXISTS recovery_queue (
  queue_id TEXT PRIMARY KEY,
  logical_run_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL DEFAULT '',
  request_id TEXT NOT NULL DEFAULT '',
  family TEXT NOT NULL,
  owner TEXT NOT NULL,
  state TEXT NOT NULL,
  workspace_folder TEXT NOT NULL DEFAULT '',
  chat_id TEXT NOT NULL DEFAULT '',
  harness TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '',
  payload_ref TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  json TEXT NOT NULL,
  FOREIGN KEY (logical_run_id) REFERENCES recovery_runs(logical_run_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_recovery_queue_request
  ON recovery_queue(request_id) WHERE request_id != '';
CREATE INDEX IF NOT EXISTS idx_recovery_queue_state_family
  ON recovery_queue(state, family);
CREATE INDEX IF NOT EXISTS idx_recovery_queue_state_workspace
  ON recovery_queue(state, workspace_folder);
CREATE INDEX IF NOT EXISTS idx_recovery_queue_run
  ON recovery_queue(logical_run_id);
-- v3 (leaf R4): one durable Stop/cancel per logical run. The run row itself is
-- also moved to lifecycle cancelled; this table is the indexed, idempotent
-- cancel ledger keyed by the recovery_requests kind run_cancel.
CREATE TABLE IF NOT EXISTS recovery_cancels (
  logical_run_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  json TEXT NOT NULL,
  FOREIGN KEY (logical_run_id) REFERENCES recovery_runs(logical_run_id)
);
CREATE INDEX IF NOT EXISTS idx_recovery_cancels_created
  ON recovery_cancels(created_at);
-- v3 (leaf R4): durable pending question/approval. A run enters waiting only
-- through this row; state is pending until an explicit human answer resolves
-- it. There is deliberately no automatic answer path.
CREATE TABLE IF NOT EXISTS recovery_waiting (
  logical_run_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  prompt_ref TEXT NOT NULL DEFAULT '',
  answer TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  json TEXT NOT NULL,
  FOREIGN KEY (logical_run_id) REFERENCES recovery_runs(logical_run_id)
);
CREATE INDEX IF NOT EXISTS idx_recovery_waiting_state
  ON recovery_waiting(state);
CREATE INDEX IF NOT EXISTS idx_recovery_waiting_kind_state
  ON recovery_waiting(kind, state);
`;

/** @type {object | null} */
let defaultStore = null;

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return String(value ?? '').trim();
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Store-level failure. `.code` is a stable machine code and `.details` carries
 * structured context (never prompt content).
 */
export class RecoveryStoreError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, details?: object }} [options]
   */
  constructor(message, { code = 'recovery_store_error', details = {} } = {}) {
    super(String(message));
    this.name = 'RecoveryStoreError';
    this.code = String(code);
    this.details = details && typeof details === 'object' ? details : {};
  }
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
export function isRecoveryStoreError(err) {
  return err instanceof RecoveryStoreError;
}

/**
 * @param {string} code
 * @param {string} message
 * @param {object} [details]
 * @returns {RecoveryStoreError}
 */
function storeError(code, message, details = {}) {
  return new RecoveryStoreError(message, { code, details });
}

// ---------------------------------------------------------------------------
// Paths and schema version
// ---------------------------------------------------------------------------

/**
 * @param {{ dataDir?: string }} [options]
 * @returns {string} `<dataDir>/recovery.sqlite`, defaulting to `resolveDataPath()`
 */
export function resolveRecoveryStorePath(options = {}) {
  const dir = text(options?.dataDir) || resolveDataPath();
  return path.join(dir, 'recovery.sqlite');
}

/**
 * Highest version declared by either `PRAGMA user_version` or `recovery_meta`.
 *
 * A *missing* `recovery_meta` table on a fresh file reads as 0, but a failure of
 * `PRAGMA user_version` is **not** swallowed: on a corrupt/unreadable file that
 * pragma throws, and the caller must fail closed instead of treating the file as
 * a brand-new empty store.
 *
 * @param {DatabaseSync} database
 * @returns {number}
 */
function readStoreSchemaVersion(database) {
  const row = database.prepare('PRAGMA user_version').get();
  const userVersion = Math.max(0, Math.floor(Number(row?.user_version) || 0));
  let metaVersion = 0;
  try {
    const meta = database.prepare('SELECT value FROM recovery_meta WHERE key = ?').get('schemaVersion');
    metaVersion = Math.max(0, Math.floor(Number(meta?.value) || 0));
  } catch {
    metaVersion = 0;
  }
  return Math.max(userVersion, metaVersion);
}

/**
 * Read the version without running DDL, so a too-new file is rejected before
 * anything is written.
 *
 * Fail-closed: 0 is returned only for a missing file or a zero-byte file. An
 * existing, non-empty file that cannot be read as SQLite (garbage bytes, wrong
 * format, permission problem) throws `RecoveryStoreError('store_open_failed')`
 * rather than being mistaken for a fresh store — overwriting it would destroy
 * data.
 *
 * @param {string} filePath
 * @returns {number}
 */
function probeSchemaVersion(filePath) {
  try {
    if (!fs.existsSync(filePath)) return 0;
    if (fs.statSync(filePath).size <= 0) return 0;
  } catch (err) {
    throw storeError('store_open_failed', `Failed to inspect recovery store: ${err?.message || err}`, {
      filePath,
      reason: 'stat_failed',
      cause: String(err?.message || err),
    });
  }
  /** @type {DatabaseSync | null} */
  let probe = null;
  try {
    probe = new DatabaseSync(filePath, {
      readOnly: true,
      timeout: RECOVERY_STORE_DEFAULT_BUSY_TIMEOUT_MS,
    });
    return readStoreSchemaVersion(probe);
  } catch (err) {
    if (isRecoveryStoreError(err)) throw err;
    throw storeError('store_open_failed', `Recovery store file is not readable: ${err?.message || err}`, {
      filePath,
      reason: 'unreadable_store',
      cause: String(err?.message || err),
    });
  } finally {
    try {
      probe?.close();
    } catch {
      // probe close is best-effort
    }
  }
}

// ---------------------------------------------------------------------------
// Open / migrate / close
// ---------------------------------------------------------------------------

/**
 * @param {unknown} store
 * @returns {DatabaseSync}
 */
function requireDb(store) {
  if (!store || typeof store !== 'object' || !store.db || store.closed === true) {
    throw storeError('store_not_open', 'Recovery store is not open');
  }
  return store.db;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeSynchronous(value) {
  const mode = text(value).toUpperCase() || 'FULL';
  if (!ALLOWED_SYNCHRONOUS.includes(mode)) {
    throw storeError('store_open_failed', `Unsupported synchronous mode: ${mode}`, {
      reason: 'invalid_synchronous',
      synchronous: mode,
    });
  }
  return mode;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function normalizeBusyTimeout(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return RECOVERY_STORE_DEFAULT_BUSY_TIMEOUT_MS;
  return Math.floor(parsed);
}

/**
 * Apply the schema forward. Idempotent: safe to call on an already-migrated
 * store. A file newer than this build fails closed with `schema_too_new`.
 *
 * @param {object} [store]
 * @returns {number} the resulting schema version
 */
export function migrateRecoveryStore(store = defaultStore) {
  const db = requireDb(store);
  const current = readStoreSchemaVersion(db);
  if (current > RECOVERY_STORE_SCHEMA_VERSION) {
    throw storeError(
      'schema_too_new',
      `Recovery store schema ${current} is newer than this build (max ${RECOVERY_STORE_SCHEMA_VERSION}).`,
      { version: current, supported: RECOVERY_STORE_SCHEMA_VERSION }
    );
  }
  db.exec(DDL);
  db.prepare(`
    INSERT INTO recovery_meta(key, value) VALUES('schemaVersion', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(String(RECOVERY_STORE_SCHEMA_VERSION));
  db.exec(`PRAGMA user_version = ${RECOVERY_STORE_SCHEMA_VERSION}`);
  if (store && typeof store === 'object') store.schemaVersion = RECOVERY_STORE_SCHEMA_VERSION;
  return RECOVERY_STORE_SCHEMA_VERSION;
}

/**
 * Open (creating when needed) and migrate the recovery store.
 *
 * @param {{
 *   dataDir?: string,
 *   filePath?: string,
 *   synchronous?: string,
 *   busyTimeoutMs?: number,
 * }} [options]
 * @returns {object} store handle (also installed as the process default)
 */
export function openRecoveryStore(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const targetPath = text(opts.filePath) || resolveRecoveryStorePath({ dataDir: opts.dataDir });
  const synchronous = normalizeSynchronous(opts.synchronous);
  const busyTimeoutMs = normalizeBusyTimeout(opts.busyTimeoutMs);

  const existingVersion = probeSchemaVersion(targetPath);
  if (existingVersion > RECOVERY_STORE_SCHEMA_VERSION) {
    throw storeError(
      'schema_too_new',
      `Recovery store schema ${existingVersion} is newer than this build (max ${RECOVERY_STORE_SCHEMA_VERSION}).`,
      { version: existingVersion, supported: RECOVERY_STORE_SCHEMA_VERSION, filePath: targetPath }
    );
  }

  /** @type {DatabaseSync | null} */
  let db = null;
  try {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    db = new DatabaseSync(targetPath, { timeout: busyTimeoutMs });
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(`PRAGMA synchronous = ${synchronous};`);
  } catch (err) {
    try {
      db?.close();
    } catch {
      // best-effort cleanup
    }
    if (isRecoveryStoreError(err)) throw err;
    throw storeError('store_open_failed', `Failed to open recovery store: ${err?.message || err}`, {
      filePath: targetPath,
      cause: String(err?.message || err),
    });
  }

  const store = {
    db,
    filePath: targetPath,
    schemaVersion: existingVersion,
    synchronous,
    busyTimeoutMs,
    closed: false,
  };
  try {
    migrateRecoveryStore(store);
  } catch (err) {
    try {
      db.close();
    } catch {
      // best-effort cleanup
    }
    if (isRecoveryStoreError(err)) throw err;
    throw storeError('store_open_failed', `Failed to migrate recovery store: ${err?.message || err}`, {
      filePath: targetPath,
      cause: String(err?.message || err),
    });
  }
  defaultStore = store;
  return store;
}

/**
 * Close a store. Safe and idempotent; closing the current default clears it.
 *
 * @param {object} [store]
 * @returns {boolean} whether a database was actually closed
 */
export function closeRecoveryStore(store = defaultStore) {
  const target = store || defaultStore;
  if (!target) return false;
  if (target === defaultStore) defaultStore = null;
  if (target.closed === true) return false;
  target.closed = true;
  try {
    target.db.close();
  } catch {
    // Double close / already closed in tests is not an error.
  }
  return true;
}

/**
 * Escape hatch for tests and the crash harness that need a raw transaction.
 *
 * @param {object} [store]
 * @returns {DatabaseSync}
 */
export function getRecoveryStoreDatabase(store = defaultStore) {
  return requireDb(store);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * @param {unknown} value
 * @returns {string} an ISO timestamp; `now` may be a number (ms) or a date string
 */
function normalizeNow(value) {
  if (value === undefined || value === null || value === '') return new Date().toISOString();
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  const parsed = new Date(String(value));
  if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  return new Date().toISOString();
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function normalizeGeneration(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function normalizeLimit(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(1000, Math.floor(parsed));
}

/**
 * @param {DatabaseSync} db
 * @param {() => T} work
 * @returns {T}
 * @template T
 */
function withRecoveryTransaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Rollback may fail when the transaction never started.
    }
    throw err;
  }
}

/**
 * @param {DatabaseSync} db
 * @param {string} logicalRunId
 * @returns {object | null}
 */
function readRun(db, logicalRunId) {
  if (!logicalRunId) return null;
  const row = db.prepare('SELECT json FROM recovery_runs WHERE logical_run_id = ?').get(logicalRunId);
  return row ? JSON.parse(String(row.json)) : null;
}

/**
 * @param {DatabaseSync} db
 * @param {string} attemptId
 * @returns {object | null}
 */
function readAttempt(db, attemptId) {
  if (!attemptId) return null;
  const row = db.prepare('SELECT json FROM recovery_attempts WHERE attempt_id = ?').get(attemptId);
  return row ? JSON.parse(String(row.json)) : null;
}

/**
 * Persist a run row. Throws when the CAS update matched no row.
 *
 * @param {DatabaseSync} db
 * @param {object} run
 */
function writeRun(db, run) {
  const info = db.prepare(`
    UPDATE recovery_runs SET
      family = ?, owner = ?, state = ?, workspace_folder = ?, chat_id = ?,
      generation = ?, revision = ?, request_id = ?, created_at = ?, updated_at = ?, json = ?
    WHERE logical_run_id = ?
  `).run(
    text(run.family),
    text(run.owner),
    text(run.state),
    text(run.workspaceFolder),
    text(run.chatId),
    normalizeGeneration(run.generation),
    Math.floor(Number(run.revision) || 1),
    text(run.requestId),
    text(run.createdAt),
    text(run.updatedAt),
    JSON.stringify(run),
    text(run.logicalRunId)
  );
  if (Number(info?.changes) !== 1) {
    throw storeError('transition_failed', 'Recovery run row was not updated');
  }
}

/**
 * @param {DatabaseSync} db
 * @param {object} run
 */
function insertRun(db, run) {
  db.prepare(`
    INSERT INTO recovery_runs(
      logical_run_id, family, owner, state, workspace_folder, chat_id,
      generation, revision, request_id, created_at, updated_at, json
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    text(run.logicalRunId),
    text(run.family),
    text(run.owner),
    text(run.state),
    text(run.workspaceFolder),
    text(run.chatId),
    normalizeGeneration(run.generation),
    Math.floor(Number(run.revision) || 1),
    text(run.requestId),
    text(run.createdAt),
    text(run.updatedAt),
    JSON.stringify(run)
  );
}

/**
 * @param {DatabaseSync} db
 * @param {object} attempt
 */
function insertAttempt(db, attempt) {
  db.prepare(`
    INSERT INTO recovery_attempts(
      attempt_id, logical_run_id, request_id, state, revision, created_at, updated_at, json
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    text(attempt.attemptId),
    text(attempt.logicalRunId),
    text(attempt.requestId),
    text(attempt.state),
    Math.floor(Number(attempt.revision) || 1),
    text(attempt.createdAt),
    text(attempt.updatedAt),
    JSON.stringify(attempt)
  );
}

/**
 * @param {DatabaseSync} db
 * @param {string} kind
 * @param {string} requestId
 * @param {string} logicalRunId
 * @param {string} attemptId
 * @param {string} at
 * @param {object} json
 */
function insertRequest(db, kind, requestId, logicalRunId, attemptId, at, json) {
  db.prepare(`
    INSERT INTO recovery_requests(request_id, kind, logical_run_id, attempt_id, created_at, json)
    VALUES(?, ?, ?, ?, ?, ?)
  `).run(
    text(requestId),
    text(kind),
    text(logicalRunId),
    text(attemptId),
    text(at),
    JSON.stringify(json)
  );
}

// ---------------------------------------------------------------------------
// writeRunIntent
// ---------------------------------------------------------------------------

/**
 * Validate and normalize a `writeRunIntent` payload. Throws
 * `RecoveryStoreError('invalid_intent')` for a malformed payload.
 *
 * @param {object} input
 * @returns {object}
 */
function buildRunIntent(input) {
  const src = input && typeof input === 'object' ? input : {};
  const invalid = [];
  const logicalRunId = text(src.logicalRunId);
  const attemptId = text(src.attemptId);
  const requestId = text(src.requestId);
  const family = text(src.family).toLowerCase();
  const owner = text(src.owner);
  const ownerEntry = ownerOfRunFamily(family);

  if (!isRecoveryId(logicalRunId, 'logical_run')) invalid.push('logicalRunId');
  if (!isRecoveryId(attemptId, 'attempt')) invalid.push('attemptId');
  if (!isRecoveryId(requestId, 'request')) invalid.push('requestId');
  if (!ownerEntry) invalid.push('family');
  else if (!owner || ownerEntry.owner !== owner) invalid.push('owner');

  if (invalid.length > 0) {
    throw storeError('invalid_intent', `Invalid run intent: ${invalid.join(', ')}`, {
      fields: invalid,
    });
  }

  return {
    logicalRunId,
    attemptId,
    requestId,
    family,
    owner,
    generation: normalizeGeneration(src.generation),
    workspaceFolder: text(src.workspaceFolder),
    chatId: text(src.chatId),
    sessionId: text(src.sessionId),
    harness: text(src.harness),
    model: text(src.model),
    instanceToken: text(src.instanceToken),
    now: normalizeNow(src.now),
  };
}

/**
 * **Critical intent write: call this BEFORE launching the run.** In one
 * `BEGIN IMMEDIATE` transaction it creates the logical run in state `starting`
 * and its first attempt. Idempotent by `requestId`: a repeat returns the
 * existing record with `created:false` and never creates a second run.
 *
 * Any persistence failure (I/O, constraint, closed database) throws
 * `RecoveryStoreError` with `code === 'intent_write_failed'`. That is the
 * "block the launch" signal: a caller that cannot persist the intent must not
 * start the executor, otherwise a crash would leave an untracked run (see
 * docs/recovery-store.md).
 *
 * Required: `logicalRunId`, `attemptId`, `family`, `owner`, `requestId`.
 * Optional: `workspaceFolder`, `chatId`, `sessionId`, `harness`, `model`,
 * `instanceToken`, `generation`, `now`.
 *
 * @param {object} input
 * @param {object} [store]
 * @returns {{ created: boolean, run: object, attempt: object }}
 */
export function writeRunIntent(input, store = defaultStore) {
  const intent = buildRunIntent(input);
  const run = {
    schemaVersion: RECOVERY_SCHEMA_VERSION,
    logicalRunId: intent.logicalRunId,
    attemptId: intent.attemptId,
    requestId: intent.requestId,
    family: intent.family,
    owner: intent.owner,
    state: 'starting',
    revision: 1,
    generation: intent.generation,
    workspaceFolder: intent.workspaceFolder,
    chatId: intent.chatId,
    sessionId: intent.sessionId,
    harness: intent.harness,
    model: intent.model,
    instanceToken: intent.instanceToken,
    reason: '',
    infraOutcome: 'none',
    agentOutcome: 'unspecified',
    agentVerdict: 'unspecified',
    createdAt: intent.now,
    updatedAt: intent.now,
  };
  const attempt = {
    schemaVersion: RECOVERY_SCHEMA_VERSION,
    attemptId: intent.attemptId,
    logicalRunId: intent.logicalRunId,
    requestId: intent.requestId,
    family: intent.family,
    owner: intent.owner,
    state: 'starting',
    revision: 1,
    generation: intent.generation,
    cause: 'initial',
    harness: intent.harness,
    model: intent.model,
    sessionId: intent.sessionId,
    instanceToken: intent.instanceToken,
    createdAt: intent.now,
    updatedAt: intent.now,
  };

  try {
    const db = requireDb(store);
    return withRecoveryTransaction(db, () => {
      const existing = db.prepare(
        'SELECT logical_run_id, attempt_id FROM recovery_requests WHERE kind = ? AND request_id = ?'
      ).get('run_intent', intent.requestId);
      if (existing) {
        const existingLogicalRunId = text(existing.logical_run_id);
        const existingAttemptId = text(existing.attempt_id);
        // Same requestId is idempotent only for the *same* run identity. Reusing
        // it for another logical run/attempt is a hard conflict, never a silent
        // `created:false` that would point the caller at the wrong run.
        if (existingLogicalRunId !== intent.logicalRunId || existingAttemptId !== intent.attemptId) {
          throw storeError(
            'request_conflict',
            'requestId already belongs to a different run intent',
            {
              requestId: intent.requestId,
              expectedLogicalRunId: intent.logicalRunId,
              expectedAttemptId: intent.attemptId,
              existingLogicalRunId,
              existingAttemptId,
            }
          );
        }
        return {
          created: false,
          run: readRun(db, existingLogicalRunId),
          attempt: readAttempt(db, existingAttemptId),
        };
      }
      insertRun(db, run);
      insertAttempt(db, attempt);
      insertRequest(db, 'run_intent', intent.requestId, intent.logicalRunId, intent.attemptId, intent.now, {
        kind: 'run_intent',
        logicalRunId: intent.logicalRunId,
        attemptId: intent.attemptId,
      });
      return { created: true, run, attempt };
    });
  } catch (err) {
    if (
      isRecoveryStoreError(err) &&
      (err.code === 'invalid_intent' || err.code === 'request_conflict')
    ) {
      throw err;
    }
    throw storeError(
      'intent_write_failed',
      `Failed to persist run intent: ${err?.message || err}`,
      { logicalRunId: intent.logicalRunId, attemptId: intent.attemptId, cause: String(err?.code || err?.message || err) }
    );
  }
}

// ---------------------------------------------------------------------------
// registerAttempt
// ---------------------------------------------------------------------------

/**
 * Register an additional attempt (recovery `new_attempt`) for an existing
 * logical run. Idempotent by `requestId` when supplied.
 *
 * Required: `logicalRunId`, `attemptId`. Optional: `requestId`, `cause`,
 * `generation`, `harness`, `model`, `sessionId`, `instanceToken`, `now`.
 *
 * @param {object} input
 * @param {object} [store]
 * @returns {{ created: boolean, attempt: object }}
 */
export function registerAttempt(input, store = defaultStore) {
  const src = input && typeof input === 'object' ? input : {};
  const logicalRunId = text(src.logicalRunId);
  const attemptId = text(src.attemptId);
  const requestId = text(src.requestId);

  try {
    if (!isRecoveryId(logicalRunId, 'logical_run')) {
      throw storeError('attempt_write_failed', 'Invalid attempt write: logicalRunId', { fields: ['logicalRunId'] });
    }
    if (!isRecoveryId(attemptId, 'attempt')) {
      throw storeError('attempt_write_failed', 'Invalid attempt write: attemptId', { fields: ['attemptId'] });
    }
    if (requestId && !isRecoveryId(requestId, 'request')) {
      throw storeError('attempt_write_failed', 'Invalid attempt write: requestId', { fields: ['requestId'] });
    }
    const db = requireDb(store);
    return withRecoveryTransaction(db, () => {
      if (requestId) {
        const existing = db.prepare(
          'SELECT logical_run_id, attempt_id FROM recovery_requests WHERE kind = ? AND request_id = ?'
        ).get('attempt', requestId);
        if (existing) {
          const existingLogicalRunId = text(existing.logical_run_id);
          const existingAttemptId = text(existing.attempt_id);
          // Idempotent only for the exact same attempt identity; any other run
          // or attempt under the same requestId is a hard conflict.
          if (existingLogicalRunId !== logicalRunId || existingAttemptId !== attemptId) {
            throw storeError(
              'request_conflict',
              'requestId already belongs to a different attempt',
              {
                requestId,
                expectedLogicalRunId: logicalRunId,
                expectedAttemptId: attemptId,
                existingLogicalRunId,
                existingAttemptId,
              }
            );
          }
          return { created: false, attempt: readAttempt(db, existingAttemptId) };
        }
      }
      const run = readRun(db, logicalRunId);
      if (!run) {
        throw storeError('attempt_write_failed', 'Logical run not found for attempt', {
          cause: 'run_not_found',
          logicalRunId,
        });
      }
      const duplicate = db.prepare('SELECT attempt_id FROM recovery_attempts WHERE attempt_id = ?').get(attemptId);
      if (duplicate) {
        throw storeError('attempt_write_failed', 'Attempt id already exists', {
          cause: 'duplicate_attempt',
          attemptId,
        });
      }
      const at = normalizeNow(src.now);
      const attempt = {
        schemaVersion: RECOVERY_SCHEMA_VERSION,
        attemptId,
        logicalRunId,
        requestId,
        family: run.family,
        owner: run.owner,
        state: 'starting',
        revision: 1,
        generation:
          src.generation === undefined || src.generation === null || src.generation === ''
            ? normalizeGeneration(run.generation)
            : normalizeGeneration(src.generation),
        cause: text(src.cause) || 'new_attempt',
        harness: text(src.harness) || text(run.harness),
        model: text(src.model) || text(run.model),
        sessionId: text(src.sessionId) || text(run.sessionId),
        instanceToken: text(src.instanceToken) || text(run.instanceToken),
        createdAt: at,
        updatedAt: at,
      };
      insertAttempt(db, attempt);
      if (requestId) {
        insertRequest(db, 'attempt', requestId, logicalRunId, attemptId, at, { attemptId, logicalRunId });
      }
      return { created: true, attempt };
    });
  } catch (err) {
    if (
      isRecoveryStoreError(err) &&
      (err.code === 'attempt_write_failed' || err.code === 'request_conflict')
    ) {
      throw err;
    }
    throw storeError(
      'attempt_write_failed',
      `Failed to persist attempt: ${err?.message || err}`,
      { logicalRunId, attemptId, cause: String(err?.code || err?.message || err) }
    );
  }
}

// ---------------------------------------------------------------------------
// transitionRun (CAS)
// ---------------------------------------------------------------------------

/**
 * @param {string} reason
 * @param {object|null} run
 * @param {object} [details]
 * @returns {{ ok: false, applied: false, conflict: true, reason: string, run: object|null }}
 */
function transitionConflict(reason, run, details) {
  const result = { ok: false, applied: false, conflict: true, reason, run: run || null };
  if (details) result.details = details;
  return result;
}

/**
 * Compare-and-swap lifecycle transition.
 *
 * In one `BEGIN IMMEDIATE` transaction it re-reads the run, checks
 * `expectedRevision` and the optional predicates (`expectedState`,
 * `expectedOwner`, `expectedGeneration`), validates the edge against
 * `canTransitionRunLifecycle`, then writes the new state with `revision + 1`.
 *
 * A logical conflict does NOT throw: it returns
 * `{ ok:false, applied:false, conflict:true, reason, run }` with `reason` in
 * `'not_found' | 'revision_conflict' | 'owner_mismatch' | 'generation_mismatch'
 * | 'state_mismatch' | 'illegal_transition'`. Only a store/IO failure throws
 * `RecoveryStoreError('transition_failed')`.
 *
 * The owner/generation predicates are the foundation for R3 fencing; this leaf
 * provides the fields and checks but no recovery policy.
 *
 * @param {{
 *   logicalRunId: string,
 *   expectedRevision: number,
 *   to: string,
 *   expectedState?: string,
 *   expectedOwner?: string,
 *   expectedGeneration?: number,
 *   reason?: string,
 *   infraOutcome?: string,
 *   agentOutcome?: string,
 *   agentVerdict?: string,
 *   now?: number|string,
 *   patch?: object,
 * }} input
 * @param {object} [store]
 * @returns {{ ok: boolean, applied: boolean, conflict: boolean, reason: string, run: object|null }}
 */
export function transitionRun(input, store = defaultStore) {
  const src = input && typeof input === 'object' ? input : {};
  const logicalRunId = text(src.logicalRunId);
  if (!isRecoveryId(logicalRunId, 'logical_run')) {
    throw storeError('transition_failed', 'Invalid transition: logicalRunId', {
      cause: 'invalid_logical_run_id',
    });
  }
  const revisionNumber = Number(src.expectedRevision);
  if (!Number.isFinite(revisionNumber) || revisionNumber < 1) {
    throw storeError('transition_failed', 'Invalid transition: expectedRevision', {
      cause: 'invalid_expected_revision',
    });
  }
  const expectedRevision = Math.floor(revisionNumber);

  const expectedState =
    src.expectedState === undefined || src.expectedState === null || src.expectedState === ''
      ? null
      : normalizeRunLifecycleState(src.expectedState);
  const expectedOwner =
    src.expectedOwner === undefined || src.expectedOwner === null ? null : text(src.expectedOwner);
  let expectedGeneration = null;
  if (src.expectedGeneration !== undefined && src.expectedGeneration !== null && src.expectedGeneration !== '') {
    const parsed = Number(src.expectedGeneration);
    if (!Number.isFinite(parsed)) {
      throw storeError('transition_failed', 'Invalid transition: expectedGeneration', {
        cause: 'invalid_expected_generation',
      });
    }
    expectedGeneration = Math.floor(parsed);
  }
  const to = normalizeRunLifecycleState(src.to);

  try {
    const db = requireDb(store);
    return withRecoveryTransaction(db, () => {
      const run = readRun(db, logicalRunId);
      if (!run) return transitionConflict('not_found', null, { logicalRunId });
      if (Number(run.revision) !== expectedRevision) {
        return transitionConflict('revision_conflict', run, {
          expectedRevision,
          actualRevision: Number(run.revision),
        });
      }
      if (expectedOwner !== null && text(run.owner) !== expectedOwner) {
        return transitionConflict('owner_mismatch', run, {
          expectedOwner,
          actualOwner: text(run.owner),
        });
      }
      if (expectedGeneration !== null && Number(run.generation) !== expectedGeneration) {
        return transitionConflict('generation_mismatch', run, {
          expectedGeneration,
          actualGeneration: Number(run.generation),
        });
      }
      if (expectedState !== null && text(run.state) !== expectedState) {
        return transitionConflict('state_mismatch', run, {
          expectedState,
          actualState: text(run.state),
        });
      }
      if (!to || !canTransitionRunLifecycle(run.state, to)) {
        return transitionConflict('illegal_transition', run, { from: text(run.state), to: to || text(src.to) });
      }

      const at = normalizeNow(src.now);
      /** @type {object} */
      const next = { ...run, state: to, revision: expectedRevision + 1, updatedAt: at };
      if (src.reason !== undefined && src.reason !== null && text(src.reason) !== '') {
        next.reason = normalizeRunInterruptReason(src.reason);
      }
      if (src.infraOutcome !== undefined) next.infraOutcome = normalizeRunInfraOutcome(src.infraOutcome);
      if (src.agentOutcome !== undefined) next.agentOutcome = normalizeRunAgentOutcome(src.agentOutcome);
      if (src.agentVerdict !== undefined) next.agentVerdict = normalizeRunAgentVerdict(src.agentVerdict);
      if (src.patch && typeof src.patch === 'object') Object.assign(next, src.patch);
      // Protected invariants: callers may attach metadata via `patch`, but the
      // CAS identity/lifecycle fields can never be rewritten by it. `patch` must
      // not be able to move the run to another identity, family/owner, state,
      // revision, generation or creation time.
      next.schemaVersion = run.schemaVersion;
      next.logicalRunId = run.logicalRunId;
      next.attemptId = run.attemptId;
      next.requestId = run.requestId;
      next.family = run.family;
      next.owner = run.owner;
      next.state = to;
      next.revision = expectedRevision + 1;
      next.generation = run.generation;
      next.createdAt = run.createdAt;
      next.updatedAt = at;

      writeRun(db, next);
      return { ok: true, applied: true, conflict: false, reason: 'applied', run: next };
    });
  } catch (err) {
    if (isRecoveryStoreError(err) && err.code === 'transition_failed') throw err;
    throw storeError(
      'transition_failed',
      `Failed to transition run: ${err?.message || err}`,
      { logicalRunId, cause: String(err?.code || err?.message || err) }
    );
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * @param {string} logicalRunId
 * @param {object} [store]
 * @returns {object | null}
 */
export function getRun(logicalRunId, store = defaultStore) {
  const db = requireDb(store);
  return readRun(db, text(logicalRunId));
}

/**
 * @param {string} attemptId
 * @param {object} [store]
 * @returns {object | null}
 */
export function getAttempt(attemptId, store = defaultStore) {
  const db = requireDb(store);
  return readAttempt(db, text(attemptId));
}

/**
 * Durable read of the run a caller only knows by its `requestId` (leaf R6: the
 * adapter probe after a process restart, when no in-memory room is left).
 *
 * Indexed point read on `idx_recovery_runs_request`. Store-level only: it
 * returns the persisted row or null and decides nothing about liveness,
 * acceptance or recovery.
 *
 * @param {string} requestId
 * @param {object} [store]
 * @returns {object | null}
 */
export function getRunByRequestId(requestId, store = defaultStore) {
  const id = text(requestId);
  if (!id) return null;
  const db = requireDb(store);
  const row = db.prepare('SELECT json FROM recovery_runs WHERE request_id = ?').get(id);
  return row ? JSON.parse(String(row.json)) : null;
}

/**
 * Resolve what a `recovery_requests` ledger row points at, without loading the
 * run. `kind` is the ledger kind used on write (`run_intent`, `attempt`,
 * `run_cancel`, `queued_prompt`, `waiting`).
 *
 * @param {string} kind
 * @param {string} requestId
 * @param {object} [store]
 * @returns {{ logicalRunId: string, attemptId: string } | null}
 */
export function resolveRunRefByRequest(kind, requestId, store = defaultStore) {
  const ledgerKind = text(kind);
  const id = text(requestId);
  if (!ledgerKind || !id) return null;
  const db = requireDb(store);
  const row = db.prepare(
    'SELECT logical_run_id, attempt_id FROM recovery_requests WHERE kind = ? AND request_id = ?'
  ).get(ledgerKind, id);
  if (!row) return null;
  return { logicalRunId: text(row.logical_run_id), attemptId: text(row.attempt_id) };
}

/**
 * @param {string} logicalRunId
 * @param {object} [store]
 * @returns {object[]}
 */
export function listAttempts(logicalRunId, store = defaultStore) {
  const db = requireDb(store);
  const id = text(logicalRunId);
  if (!id) return [];
  return db.prepare(
    'SELECT json FROM recovery_attempts WHERE logical_run_id = ? ORDER BY created_at ASC, rowid ASC'
  ).all(id).map((row) => JSON.parse(String(row.json)));
}

/**
 * @param {{ family?: string, state?: string, workspaceFolder?: string, limit?: number }} [options]
 * @param {object} [store]
 * @returns {object[]}
 */
export function listRuns(options = {}, store = defaultStore) {
  const opts = options && typeof options === 'object' ? options : {};
  const db = requireDb(store);
  const where = [];
  const params = [];
  if (opts.family !== undefined && opts.family !== null && opts.family !== '') {
    const family = text(opts.family).toLowerCase();
    if (!ownerOfRunFamily(family)) return [];
    where.push('family = ?');
    params.push(family);
  }
  if (opts.state !== undefined && opts.state !== null && opts.state !== '') {
    const state = normalizeRunLifecycleState(opts.state);
    if (!state) return [];
    where.push('state = ?');
    params.push(state);
  }
  if (opts.workspaceFolder !== undefined && opts.workspaceFolder !== null) {
    where.push('workspace_folder = ?');
    params.push(text(opts.workspaceFolder));
  }
  const limit = normalizeLimit(opts.limit, 100);
  const sql = `SELECT json FROM recovery_runs ${
    where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  } ORDER BY created_at ASC, rowid ASC LIMIT ?`;
  params.push(limit);
  return db.prepare(sql).all(...params).map((row) => JSON.parse(String(row.json)));
}

/**
 * Runs currently in `RUN_ACTIVE_STATES` (`starting`, `running`, `waiting`).
 *
 * @param {{ limit?: number }} [options]
 * @param {object} [store]
 * @returns {object[]}
 */
export function listOpenRuns(options = {}, store = defaultStore) {
  const opts = options && typeof options === 'object' ? options : {};
  const db = requireDb(store);
  const limit = normalizeLimit(opts.limit, 1000);
  const placeholders = RUN_ACTIVE_STATES.map(() => '?').join(', ');
  return db.prepare(
    `SELECT json FROM recovery_runs WHERE state IN (${placeholders}) ORDER BY created_at ASC, rowid ASC LIMIT ?`
  ).all(...RUN_ACTIVE_STATES, limit).map((row) => JSON.parse(String(row.json)));
}
