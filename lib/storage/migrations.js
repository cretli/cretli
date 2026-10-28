/**
 * Forward-only schema migration applier for the consolidated store (A2).
 *
 * All pending migrations and their `schema_version` rows are applied in one
 * `BEGIN IMMEDIATE` transaction on the caller's connection: either every
 * pending step commits or the schema stays exactly as it was. The write lock
 * is taken only when the lock-free read shows pending steps, and the version
 * is read again under the lock, so two connections creating the store at the
 * same time apply each step once. A database that records a version newer
 * than this build knows is refused with `conflict` (an older binary must not
 * write a newer schema). There are no down steps.
 *
 * Data migrations of real stores are out of scope here (S7 owns the resumable
 * runner); this module only versions the schema.
 */
import { StorageError, STORAGE_ERROR_CODES } from './errors.js';
import { toStorageError } from './sqlite-errors.js';
import core0001 from './schema/0001-core.js';
import fencing0002 from './schema/0002-fencing.js';
import chatHistory0003 from './schema/0003-chat-history.js';
import chatHistoryMetadata0004 from './schema/0004-chat-history-metadata.js';
import datasetBinding0005 from './schema/0005-dataset-binding.js';
import historyLargeStaging0006 from './schema/0006-history-large-staging.js';
import todos0007 from './schema/0007-todos.js';
import workspaces0001 from './schema/workspaces-0001.js';

/**
 * @typedef {{
 *   version: number,
 *   name: string,
 *   sql?: string,
 *   up?: (db: import('node:sqlite').DatabaseSync) => void,
 * }} StorageMigration
 */

/** @type {ReadonlyArray<StorageMigration>} */
export const CORE_MIGRATIONS = Object.freeze([core0001, fencing0002, chatHistory0003, chatHistoryMetadata0004, datasetBinding0005, historyLargeStaging0006, todos0007]);

/**
 * Migrations of `store.workspaces` (`workspaces.sqlite`). A separate lineage with its
 * own `schema_version` table: the workspace registry is read synchronously on the main
 * thread (settings load), which the worker-owned consolidated store cannot serve, so it
 * lives in its own small file like the delegation store. Apply with
 * `applyMigrations(db, { migrations: WORKSPACE_MIGRATIONS })`.
 *
 * @type {ReadonlyArray<StorageMigration>}
 */
export const WORKSPACE_MIGRATIONS = Object.freeze([workspaces0001]);

const SCHEMA_VERSION_DDL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  applied_at INTEGER NOT NULL CHECK (applied_at >= 0)
) STRICT;
`;

/**
 * Migrations must be numbered 1..n without gaps and carry exactly one of
 * `sql` / `up`, so the applied version always identifies the full schema.
 *
 * @param {ReadonlyArray<StorageMigration>} migrations
 */
function assertMigrationList(migrations) {
  if (!Array.isArray(migrations) || migrations.length === 0) {
    throw new TypeError('Storage migrations must be a non-empty array');
  }
  migrations.forEach((migration, index) => {
    if (migration?.version !== index + 1) {
      throw new TypeError(`Storage migration at index ${index} must have version ${index + 1}`);
    }
    if (typeof migration.name !== 'string' || !migration.name.trim()) {
      throw new TypeError(`Storage migration ${migration.version} needs a name`);
    }
    if ((typeof migration.sql === 'string') === (typeof migration.up === 'function')) {
      throw new TypeError(`Storage migration ${migration.version} needs exactly one of sql or up`);
    }
  });
}

/**
 * Highest applied schema version, or 0 for a database without the table.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {number}
 */
export function readSchemaVersion(db) {
  try {
    const table = db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'schema_version'").get();
    if (!table) return 0;
    const row = db.prepare('SELECT max(version) AS version FROM schema_version').get();
    return Number(row?.version ?? 0);
  } catch (err) {
    throw toStorageError(err, 'read_schema_version');
  }
}

/**
 * Schema version mirrored in the file header (`PRAGMA user_version`). Reading
 * it does not parse `sqlite_schema`, so it works for a store whose newer
 * schema this build cannot parse. 0 for stores created before the mirror.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {number}
 */
export function readHeaderSchemaVersion(db) {
  try {
    return Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
  } catch (err) {
    throw toStorageError(err, 'read_schema_version');
  }
}

/**
 * Read-only check of the recorded schema history against `migrations`.
 * Versions must be exactly 1..max (a gap means rows were lost: `corrupt`),
 * a version newer than this build is `conflict`, and every known version must
 * carry the name this build gave it (another lineage: `conflict`).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {ReadonlyArray<StorageMigration>} [migrations]
 * @returns {number} the applied version (0 for a store without the table)
 * @throws {StorageError} conflict | corrupt, or a mapped SQLite error.
 */
export function inspectSchemaVersions(db, migrations = CORE_MIGRATIONS) {
  assertMigrationList(migrations);
  const version = readSchemaVersion(db);
  if (version === 0) return 0;
  const latest = migrations.length;
  if (version > latest) {
    throw new StorageError(STORAGE_ERROR_CODES.CONFLICT,
      `Schema version ${version} is newer than supported version ${latest}`,
      { details: { operation: 'migrate', expectedRevision: latest, actualRevision: version } });
  }
  let rows;
  try {
    rows = db.prepare('SELECT version, name FROM schema_version ORDER BY version').all();
  } catch (err) {
    throw toStorageError(err, 'read_schema_version');
  }
  rows.forEach((row, index) => {
    if (Number(row.version) !== index + 1) {
      throw new StorageError(STORAGE_ERROR_CODES.CORRUPT, `schema_version has a gap before version ${String(row.version)}`, {
        details: { operation: 'migrate', expectedRevision: index + 1, actualRevision: Number(row.version) },
      });
    }
    if (row.name !== migrations[index].name) {
      throw new StorageError(STORAGE_ERROR_CODES.CONFLICT, `schema_version ${index + 1} name does not match this build`, {
        details: { operation: 'migrate', actualRevision: index + 1 },
      });
    }
  });
  return version;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 */
function rollbackQuietly(db) {
  try {
    db.exec('ROLLBACK');
  } catch {
    // SQLite may already have rolled back (e.g. after SQLITE_FULL); the
    // original failure is what the caller needs.
  }
}

/**
 * Apply every pending migration atomically. An up-to-date store returns
 * without taking the write lock.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ migrations?: ReadonlyArray<StorageMigration>, now?: () => number }} [options]
 * @returns {{ previousVersion: number, version: number, applied: number[] }}
 * @throws {StorageError} `conflict` for a newer-than-known schema; mapped SQLite errors otherwise.
 */
export function applyMigrations(db, options = {}) {
  const migrations = options.migrations || CORE_MIGRATIONS;
  const now = options.now || Date.now;
  const latest = migrations.length;
  const unlockedVersion = inspectSchemaVersions(db, migrations);
  if (unlockedVersion === latest) return { previousVersion: latest, version: latest, applied: [] };
  try {
    db.exec('BEGIN IMMEDIATE');
  } catch (err) {
    throw toStorageError(err, 'migrate_begin');
  }
  try {
    // Another connection may have migrated between the read above and the lock.
    db.exec(SCHEMA_VERSION_DDL);
    const previousVersion = inspectSchemaVersions(db, migrations);
    const insertVersion = db.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)');
    const applied = [];
    for (const migration of migrations.slice(previousVersion)) {
      if (typeof migration.sql === 'string') db.exec(migration.sql);
      else migration.up(db);
      insertVersion.run(migration.version, migration.name, Math.max(0, Math.trunc(now())));
      applied.push(migration.version);
    }
    // Mirror the version in the file header so a later open can read it
    // without parsing the schema (see readHeaderSchemaVersion).
    db.exec(`PRAGMA user_version = ${latest}`);
    db.exec('COMMIT');
    return { previousVersion, version: latest, applied };
  } catch (err) {
    rollbackQuietly(db);
    throw toStorageError(err, 'migrate');
  }
}
