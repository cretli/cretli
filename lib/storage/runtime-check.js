/**
 * Storage runtime gate (A2, docs/storage-gates.md "Runtime compatibility matrix").
 *
 * The consolidated store and the native backup path need Node >= 22.18 and a
 * bundled SQLite >= 3.51.0 with foreign keys and the `node:sqlite` backup API.
 * An unsupported runtime is a typed `unsupported_runtime` StorageError; there is
 * deliberately no fallback that copies a live SQLite main file, because such a
 * copy can miss WAL frames and produce a torn snapshot.
 *
 * The probe only opens an in-memory database, so it never touches `data/`.
 */
import { createRequire } from 'node:module';
import { StorageError, STORAGE_ERROR_CODES } from './errors.js';

export const MIN_STORAGE_NODE_VERSION = '22.18.0';
export const MIN_STORAGE_SQLITE_VERSION = '3.51.0';

const require = createRequire(import.meta.url);

/**
 * Parse `[v]MAJOR.MINOR[.PATCH]`. The end is anchored, so trailing garbage
 * ('22.18abc', '3.51.0.junk') is rejected. A prerelease suffix introduced by
 * '-' ('22.18.0-rc.1') is accepted and compared as its release triple, because
 * the gate only needs a floor on the numeric version.
 *
 * @param {unknown} version
 * @returns {[number, number, number] | null}
 */
export function parseVersion(version) {
  if (typeof version !== 'string') return null;
  const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?(?:-[0-9A-Za-z.-]+)?$/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] || 0)];
}

/**
 * @param {[number, number, number]} a
 * @param {[number, number, number]} b
 * @returns {number} negative when a < b, 0 when equal, positive when a > b
 */
function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * @param {unknown} actual
 * @param {string} minimum
 * @returns {boolean}
 */
function isAtLeast(actual, minimum) {
  const parsed = parseVersion(actual);
  const required = parseVersion(minimum);
  return Boolean(parsed && required && compareVersions(parsed, required) >= 0);
}

/**
 * @returns {{ DatabaseSync: new (path: string) => any, backup?: unknown }}
 */
function loadNodeSqlite() {
  return require('node:sqlite');
}

/**
 * Read version and feature flags from an in-memory database.
 *
 * @param {() => { DatabaseSync: new (path: string) => any, backup?: unknown }} loadSqlite
 * @returns {{ sqliteVersion: string, foreignKeys: boolean, backupApi: boolean }}
 */
function probeSqlite(loadSqlite) {
  const sqlite = loadSqlite();
  const db = new sqlite.DatabaseSync(':memory:');
  try {
    const row = db.prepare('select sqlite_version() as version').get();
    db.exec('PRAGMA foreign_keys = ON');
    // A build with SQLITE_OMIT_FOREIGN_KEY returns no row for this pragma.
    const fkRow = db.prepare('PRAGMA foreign_keys').get();
    return {
      sqliteVersion: String(row?.version ?? ''),
      foreignKeys: Number(fkRow?.foreign_keys) === 1,
      backupApi: typeof sqlite.backup === 'function',
    };
  } finally {
    db.close();
  }
}

/**
 * @param {string} message
 * @param {Record<string, unknown>} details
 * @param {unknown} [cause]
 * @returns {StorageError}
 */
function unsupported(message, details, cause) {
  return new StorageError(STORAGE_ERROR_CODES.UNSUPPORTED_RUNTIME, message, {
    cause,
    details: {
      requiredNode: MIN_STORAGE_NODE_VERSION,
      requiredSqlite: MIN_STORAGE_SQLITE_VERSION,
      ...details,
    },
  });
}

/**
 * Verify the runtime can host the consolidated storage and native backup.
 * Values may be injected for tests; anything not injected is probed live.
 *
 * @param {{
 *   nodeVersion?: string,
 *   sqliteVersion?: string,
 *   foreignKeys?: boolean,
 *   backupApi?: boolean,
 *   loadSqlite?: () => { DatabaseSync: new (path: string) => any, backup?: unknown },
 * }} [options]
 * @returns {{ ok: true, node: string, sqlite: string, features: { foreignKeys: true, backupApi: true } }}
 * @throws {StorageError} code `unsupported_runtime`
 */
export function checkStorageRuntime(options = {}) {
  const node = options.nodeVersion ?? process.versions.node;
  if (!isAtLeast(node, MIN_STORAGE_NODE_VERSION)) {
    throw unsupported(`Node ${node} is older than ${MIN_STORAGE_NODE_VERSION}`, { actualNode: node });
  }
  let probed = null;
  const needsProbe = options.sqliteVersion === undefined
    || options.foreignKeys === undefined
    || options.backupApi === undefined;
  if (needsProbe) {
    try {
      probed = probeSqlite(options.loadSqlite || loadNodeSqlite);
    } catch (err) {
      throw unsupported('Bundled node:sqlite is unavailable', { actualNode: node }, err);
    }
  }
  const sqlite = options.sqliteVersion ?? probed?.sqliteVersion ?? '';
  const foreignKeys = options.foreignKeys ?? probed?.foreignKeys ?? false;
  const backupApi = options.backupApi ?? probed?.backupApi ?? false;
  if (!isAtLeast(sqlite, MIN_STORAGE_SQLITE_VERSION)) {
    throw unsupported(`SQLite ${sqlite || 'unknown'} is older than ${MIN_STORAGE_SQLITE_VERSION}`, {
      actualNode: node,
      actualSqlite: sqlite,
    });
  }
  const missingFeatures = [];
  if (!foreignKeys) missingFeatures.push('foreign_keys');
  if (!backupApi) missingFeatures.push('backup_api');
  if (missingFeatures.length > 0) {
    throw unsupported(`SQLite is missing required features: ${missingFeatures.join(', ')}`, {
      actualNode: node,
      actualSqlite: sqlite,
      missingFeatures,
    });
  }
  return { ok: true, node, sqlite, features: { foreignKeys: true, backupApi: true } };
}
