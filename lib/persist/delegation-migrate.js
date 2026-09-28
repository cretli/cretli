/**
 * Migrate JSON delegation stores into SQLite with backup, dry-run, and rollback
 * that keeps writes made after the switch.
 *
 * Re-running after a successful switch is a no-op: JSON markers are not treated
 * as an empty source, and existing SQLite rows are not deleted. Checkpoints
 * resume after a crash between table copies or before markers. Full record
 * content is hashed, not only IDs and counts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { resolveDataPath } from '../runtime-paths.js';
import { writeJsonAtomic } from './atomic-write.js';
import {
  acquireDelegationOwnerLock,
  getHeldDelegationOwnerLock,
  releaseDelegationOwnerLock,
} from '../delegation-owner-lock.js';
import {
  DELEGATION_SQLITE_SCHEMA_VERSION,
  DELEGATIONS_JSON_SCHEMA_VERSION,
  MAILBOX_JSON_SCHEMA_VERSION,
  assertDelegationsJsonSchemaVersion,
  assertMailboxJsonSchemaVersion,
} from './delegation-schema.js';
import {
  closeDelegationSqlite,
  importDelegationsSqlite,
  importMailboxSqlite,
  loadDelegationsSqlite,
  loadMailboxSqlite,
  openDelegationSqlite,
  readSqliteSchemaVersion,
  replaceDelegationsSqlite,
  replaceMailboxSqlite,
} from './delegation-sqlite.js';

const CHECKPOINT_NAME = 'delegation-migrate.checkpoint.json';

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalize(value[key]);
    }
    return out;
  }
  return value;
}

/**
 * @param {string} filePath
 * @returns {string}
 */
function hashFile(filePath) {
  if (!fs.existsSync(filePath)) return '';
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/**
 * Full-content hash of records (canonical JSON, sorted by id).
 *
 * @param {object[]} items
 * @returns {string}
 */
export function hashDelegationItems(items) {
  const rows = (Array.isArray(items) ? items : [])
    .filter((row) => row && typeof row === 'object')
    .map((row) => canonicalize(row))
    .sort((left, right) => String(left.id || '').localeCompare(String(right.id || '')));
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

/**
 * @param {string} filePath
 * @returns {object | null}
 */
function readJsonObject(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path.basename(filePath)} is not a JSON object`);
  }
  return parsed;
}

/**
 * @param {unknown} raw
 * @returns {object[]}
 */
function asRecordItems(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter((row) => row && typeof row === 'object' && !Array.isArray(row) && String(row.id || '').trim());
}

/**
 * @param {string} filePath
 * @param {'delegations' | 'mailbox'} kind
 * @returns {{
 *   v: number,
 *   items: object[],
 *   alreadyMigrated: boolean,
 *   backupDir: string,
 *   counts: { delegations?: number, mailbox?: number },
 * }}
 */
function readMigrationSource(filePath, kind) {
  const parsed = readJsonObject(filePath);
  if (!parsed) {
    return { v: 0, items: [], alreadyMigrated: false, backupDir: '', counts: {} };
  }
  if (String(parsed.backend || '').trim() === 'sqlite') {
    return {
      v: Number(parsed.v) || 0,
      items: [],
      alreadyMigrated: true,
      backupDir: String(parsed.backupDir || '').trim(),
      counts: parsed.counts && typeof parsed.counts === 'object' ? parsed.counts : {},
    };
  }
  if (kind === 'delegations') assertDelegationsJsonSchemaVersion(parsed.v);
  else assertMailboxJsonSchemaVersion(parsed.v);
  return {
    v: Number(parsed.v) || 0,
    items: asRecordItems(parsed.items),
    alreadyMigrated: false,
    backupDir: '',
    counts: {},
  };
}

/**
 * @param {string} checkpointPath
 * @returns {object | null}
 */
function readCheckpoint(checkpointPath) {
  if (!fs.existsSync(checkpointPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * @param {object[]} loaded
 * @param {object[]} source
 */
function assertSourceContentPresent(loaded, source) {
  const map = new Map(loaded.map((row) => [String(row.id || ''), row]));
  for (const row of source) {
    const id = String(row.id || '');
    const got = map.get(id);
    if (!got) {
      throw new Error(`Migration verification failed: missing id ${id}`);
    }
    if (hashDelegationItems([got]) !== hashDelegationItems([row])) {
      throw new Error(`Migration verification failed: content mismatch for ${id}`);
    }
  }
}

/**
 * @param {{ dataDir?: string, dryRun?: boolean }} [options]
 */
export function migrateDelegationsJsonToSqlite(options = {}) {
  const dataDir = String(options.dataDir || '').trim() || resolveDataPath();
  const dryRun = options.dryRun === true;
  const delegationsPath = path.join(dataDir, 'delegations.json');
  const mailboxPath = path.join(dataDir, 'delegation-mailbox.json');
  const checkpointPath = path.join(dataDir, CHECKPOINT_NAME);
  const sqlitePath = path.join(dataDir, 'delegations.sqlite');
  const delegations = readMigrationSource(delegationsPath, 'delegations');
  const mailbox = readMigrationSource(mailboxPath, 'mailbox');
  const plan = {
    ok: true,
    dryRun,
    dataDir,
    backupDir: '',
    counts: {
      delegations: delegations.items.length,
      mailbox: mailbox.items.length,
    },
    hashes: {
      delegations: hashDelegationItems(delegations.items),
      mailbox: hashDelegationItems(mailbox.items),
      delegationsFile: hashFile(delegationsPath),
      mailboxFile: hashFile(mailboxPath),
    },
    fromVersion: delegations.v || DELEGATIONS_JSON_SCHEMA_VERSION,
    toVersion: DELEGATION_SQLITE_SCHEMA_VERSION,
  };
  if (dryRun) return plan;
  const alreadyHeld = Boolean(getHeldDelegationOwnerLock({ dataDir }));
  acquireDelegationOwnerLock({ dataDir });
  try {
    return runMigration({
      dataDir,
      plan,
      delegationsPath,
      mailboxPath,
      checkpointPath,
      sqlitePath,
    });
  } finally {
    if (!alreadyHeld) releaseDelegationOwnerLock({ dataDir });
  }
}

/**
 * @param {{
 *   dataDir: string,
 *   plan: object,
 *   delegationsPath: string,
 *   mailboxPath: string,
 *   checkpointPath: string,
 *   sqlitePath: string,
 * }} input
 */
function runMigration(input) {
  const delegations = readMigrationSource(input.delegationsPath, 'delegations');
  const mailbox = readMigrationSource(input.mailboxPath, 'mailbox');
  const checkpoint = readCheckpoint(input.checkpointPath);
  const switched = delegations.alreadyMigrated && mailbox.alreadyMigrated;
  if (switched) {
    if (!fs.existsSync(input.sqlitePath)) {
      throw new Error('Delegation JSON points at SQLite but delegations.sqlite is missing');
    }
    const database = openDelegationSqlite({ dataDir: input.dataDir });
    const loadedDelegations = loadDelegationsSqlite(database);
    const loadedMailbox = loadMailboxSqlite(database);
    return {
      ...input.plan,
      ok: true,
      switched: true,
      alreadyMigrated: true,
      backupDir: String(checkpoint?.backupDir || delegations.backupDir || ''),
      sqlitePath: input.sqlitePath,
      counts: {
        delegations: loadedDelegations.length,
        mailbox: loadedMailbox.length,
      },
      hashes: {
        delegations: hashDelegationItems(loadedDelegations),
        mailbox: hashDelegationItems(loadedMailbox),
        delegationsFile: hashFile(input.delegationsPath),
        mailboxFile: hashFile(input.mailboxPath),
      },
    };
  }
  const backupDir = ensureMigrationBackup({
    dataDir: input.dataDir,
    checkpoint,
    delegationsPath: input.delegationsPath,
    mailboxPath: input.mailboxPath,
    alreadyMigrated: delegations.alreadyMigrated && mailbox.alreadyMigrated,
  });
  writeJsonAtomic(input.checkpointPath, {
    ...input.plan,
    backupDir,
    phase: 'copied-backup',
    at: new Date().toISOString(),
  });
  const database = openDelegationSqlite({ dataDir: input.dataDir });
  copyDelegationsTable(database, delegations);
  writeJsonAtomic(input.checkpointPath, {
    ...input.plan,
    backupDir,
    phase: 'copied-delegations',
    at: new Date().toISOString(),
  });
  copyMailboxTable(database, mailbox);
  const loadedDelegations = loadDelegationsSqlite(database);
  const loadedMailbox = loadMailboxSqlite(database);
  if (!delegations.alreadyMigrated) {
    assertSourceContentPresent(loadedDelegations, delegations.items);
  }
  if (!mailbox.alreadyMigrated) {
    assertSourceContentPresent(loadedMailbox, mailbox.items);
  }
  if (readSqliteSchemaVersion(database) !== DELEGATION_SQLITE_SCHEMA_VERSION) {
    closeDelegationSqlite();
    throw new Error('SQLite schema version mismatch after migration');
  }
  writeSwitchedMarkers({
    delegationsPath: input.delegationsPath,
    mailboxPath: input.mailboxPath,
    backupDir,
    counts: {
      delegations: loadedDelegations.length,
      mailbox: loadedMailbox.length,
    },
  });
  writeJsonAtomic(input.checkpointPath, {
    ...input.plan,
    backupDir,
    phase: 'switched',
    at: new Date().toISOString(),
    sqlitePath: input.sqlitePath,
    counts: {
      delegations: loadedDelegations.length,
      mailbox: loadedMailbox.length,
    },
    hashes: {
      delegations: hashDelegationItems(loadedDelegations),
      mailbox: hashDelegationItems(loadedMailbox),
      delegationsFile: hashFile(input.delegationsPath),
      mailboxFile: hashFile(input.mailboxPath),
    },
  });
  return {
    ...input.plan,
    ok: true,
    switched: true,
    backupDir,
    sqlitePath: input.sqlitePath,
    counts: {
      delegations: loadedDelegations.length,
      mailbox: loadedMailbox.length,
    },
  };
}

/**
 * @param {{
 *   dataDir: string,
 *   checkpoint: object | null,
 *   delegationsPath: string,
 *   mailboxPath: string,
 *   alreadyMigrated: boolean,
 * }} input
 * @returns {string}
 */
function ensureMigrationBackup(input) {
  const existing = String(input.checkpoint?.backupDir || '').trim();
  if (existing && fs.existsSync(existing)) return existing;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(input.dataDir, `delegations-backup-${stamp}`);
  fs.mkdirSync(backupDir, { recursive: true });
  if (!input.alreadyMigrated) {
    if (fs.existsSync(input.delegationsPath)) {
      fs.copyFileSync(input.delegationsPath, path.join(backupDir, 'delegations.json'));
    }
    if (fs.existsSync(input.mailboxPath)) {
      fs.copyFileSync(input.mailboxPath, path.join(backupDir, 'delegation-mailbox.json'));
    }
  }
  return backupDir;
}

/**
 * @param {import('node:sqlite').DatabaseSync} database
 * @param {{ alreadyMigrated: boolean, items: object[] }} source
 */
function copyDelegationsTable(database, source) {
  if (source.alreadyMigrated) return;
  const existing = loadDelegationsSqlite(database);
  if (existing.length === 0) {
    replaceDelegationsSqlite(database, source.items);
    return;
  }
  importDelegationsSqlite(database, source.items);
}

/**
 * @param {import('node:sqlite').DatabaseSync} database
 * @param {{ alreadyMigrated: boolean, items: object[] }} source
 */
function copyMailboxTable(database, source) {
  if (source.alreadyMigrated) return;
  const existing = loadMailboxSqlite(database);
  if (existing.length === 0) {
    replaceMailboxSqlite(database, source.items);
    return;
  }
  importMailboxSqlite(database, source.items);
}

/**
 * @param {{
 *   delegationsPath: string,
 *   mailboxPath: string,
 *   backupDir: string,
 *   counts: { delegations: number, mailbox: number },
 * }} input
 */
function writeSwitchedMarkers(input) {
  const migratedAt = new Date().toISOString();
  writeJsonAtomic(input.delegationsPath, {
    v: DELEGATION_SQLITE_SCHEMA_VERSION,
    backend: 'sqlite',
    migratedAt,
    backupDir: input.backupDir,
    counts: input.counts,
  });
  writeJsonAtomic(input.mailboxPath, {
    v: DELEGATION_SQLITE_SCHEMA_VERSION,
    backend: 'sqlite',
    migratedAt,
    backupDir: input.backupDir,
    counts: input.counts,
  });
}

/**
 * Restore JSON writers from backup without deleting SQLite rows written after
 * the switch. New SQLite records are exported into the restored JSON.
 *
 * @param {{ dataDir?: string, backupDir: string }} options
 */
export function rollbackDelegationsSqliteToJson(options) {
  const dataDir = String(options.dataDir || '').trim() || resolveDataPath();
  const backupDir = String(options.backupDir || '').trim();
  if (!backupDir) throw new Error('backupDir is required');
  const alreadyHeld = Boolean(getHeldDelegationOwnerLock({ dataDir }));
  acquireDelegationOwnerLock({ dataDir });
  try {
    const backupDelegations = readMigrationSource(path.join(backupDir, 'delegations.json'), 'delegations');
    const backupMailbox = readMigrationSource(path.join(backupDir, 'delegation-mailbox.json'), 'mailbox');
    let sqliteDelegations = [];
    let sqliteMailbox = [];
    const sqlitePath = path.join(dataDir, 'delegations.sqlite');
    if (fs.existsSync(sqlitePath)) {
      const database = openDelegationSqlite({ dataDir });
      sqliteDelegations = loadDelegationsSqlite(database);
      sqliteMailbox = loadMailboxSqlite(database);
      closeDelegationSqlite();
    }
    const mergedDelegations = mergeById(backupDelegations.items, sqliteDelegations);
    const mergedMailbox = mergeById(backupMailbox.items, sqliteMailbox);
    writeJsonAtomic(path.join(dataDir, 'delegations.json'), {
      v: DELEGATIONS_JSON_SCHEMA_VERSION,
      items: mergedDelegations,
    });
    writeJsonAtomic(path.join(dataDir, 'delegation-mailbox.json'), {
      v: MAILBOX_JSON_SCHEMA_VERSION,
      items: mergedMailbox,
    });
    return {
      ok: true,
      counts: {
        delegations: mergedDelegations.length,
        mailbox: mergedMailbox.length,
      },
    };
  } finally {
    if (!alreadyHeld) releaseDelegationOwnerLock({ dataDir });
  }
}

/**
 * @param {object[]} base
 * @param {object[]} extra
 * @returns {object[]}
 */
function mergeById(base, extra) {
  const map = new Map();
  for (const row of base) {
    if (row?.id) map.set(String(row.id), row);
  }
  for (const row of extra) {
    if (!row?.id) continue;
    const id = String(row.id);
    const current = map.get(id);
    if (!current || Number(row.revision || 0) >= Number(current.revision || 0)) {
      map.set(id, row);
    }
  }
  return [...map.values()];
}
