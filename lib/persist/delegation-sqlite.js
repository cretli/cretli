/**
 * Transactional SQLite backend for delegations (Node.js node:sqlite).
 * Target: one host, WAL, busy timeout. Not a multi-region store.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resolveDataPath } from '../runtime-paths.js';
import {
  DELEGATION_SQLITE_SCHEMA_VERSION,
  assertSqliteSchemaVersion,
} from './delegation-schema.js';

const SQLITE_BUSY_TIMEOUT_MS = 8000;

const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS delegations (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  parent_chat_id TEXT NOT NULL,
  child_chat_id TEXT NOT NULL DEFAULT '',
  workspace_folder TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  archived_at TEXT NOT NULL DEFAULT '',
  json TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_delegations_idempotency
  ON delegations(idempotency_key) WHERE idempotency_key != '';
CREATE INDEX IF NOT EXISTS idx_delegations_parent_status
  ON delegations(parent_chat_id, status);
CREATE INDEX IF NOT EXISTS idx_delegations_created
  ON delegations(created_at);
CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY,
  delegation_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts_delegation ON attempts(delegation_id);
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  delegation_id TEXT NOT NULL,
  delivered_at TEXT NOT NULL DEFAULT '',
  next_attempt_at TEXT NOT NULL DEFAULT '',
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_delegation ON outbox(delegation_id, next_attempt_at);
CREATE TABLE IF NOT EXISTS mailbox (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  to_chat_id TEXT NOT NULL,
  from_chat_id TEXT NOT NULL DEFAULT '',
  delegation_id TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  json TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mailbox_idempotency
  ON mailbox(idempotency_key) WHERE idempotency_key != '';
CREATE INDEX IF NOT EXISTS idx_mailbox_to_status ON mailbox(to_chat_id, status);
CREATE TABLE IF NOT EXISTS idempotency_tombstones (
  key TEXT PRIMARY KEY,
  delegation_id TEXT NOT NULL,
  until_at TEXT NOT NULL
);
`;

/** @type {DatabaseSync | null} */
let db = null;
let dbPath = '';

/**
 * @param {{ dataDir?: string }} [options]
 * @returns {string}
 */
export function getDelegationSqlitePath(options = {}) {
  const dir = String(options.dataDir || '').trim() || resolveDataPath();
  return path.join(dir, 'delegations.sqlite');
}

/**
 * @param {string} filePath
 * @returns {DatabaseSync}
 */
function openSqliteDatabase(filePath) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < SQLITE_BUSY_TIMEOUT_MS) {
    try {
      return new DatabaseSync(filePath, { timeout: SQLITE_BUSY_TIMEOUT_MS });
    } catch (err) {
      lastError = err;
      const busy = err?.errcode === 5 || /database is locked/i.test(String(err?.message || ''));
      if (!busy) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  throw lastError || new Error('SQLite database is locked');
}

/**
 * @param {DatabaseSync} database
 * @returns {number}
 */
function readUserVersion(database) {
  try {
    const row = database.prepare('PRAGMA user_version').get();
    return Number(row?.user_version) || 0;
  } catch {
    return 0;
  }
}

/**
 * Read the schema version without creating tables or changing journal mode.
 *
 * @param {string} filePath
 * @returns {number}
 */
function probeSqliteSchemaVersion(filePath) {
  if (!fs.existsSync(filePath)) return 0;
  try {
    if (fs.statSync(filePath).size <= 0) return 0;
  } catch {
    return 0;
  }
  const probe = new DatabaseSync(filePath, {
    readOnly: true,
    timeout: SQLITE_BUSY_TIMEOUT_MS,
  });
  try {
    const userVersion = readUserVersion(probe);
    if (userVersion > 0) return userVersion;
    try {
      return readSqliteSchemaVersion(probe);
    } catch {
      return 0;
    }
  } finally {
    probe.close();
  }
}

/**
 * @param {DatabaseSync} database
 * @param {number} version
 */
function writeSqliteSchemaVersion(database, version) {
  const normalized = Math.floor(Number(version) || 0);
  database.prepare(`
    INSERT INTO meta(key, value) VALUES(?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `).run('schemaVersion', String(normalized));
  database.exec(`PRAGMA user_version = ${normalized}`);
}

/**
 * @param {{ dataDir?: string }} [options]
 * @returns {DatabaseSync}
 */
export function openDelegationSqlite(options = {}) {
  const filePath = getDelegationSqlitePath(options);
  if (db && dbPath === filePath) return db;
  closeDelegationSqlite();
  const existingVersion = probeSqliteSchemaVersion(filePath);
  if (existingVersion > 0) {
    assertSqliteSchemaVersion(existingVersion);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  db = openSqliteDatabase(filePath);
  dbPath = filePath;
  db.exec(`PRAGMA journal_mode = WAL;`);
  db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`);
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(DDL);
  const version = db.prepare('SELECT value FROM meta WHERE key = ?').get('schemaVersion');
  if (!version) {
    writeSqliteSchemaVersion(db, DELEGATION_SQLITE_SCHEMA_VERSION);
  }
  return db;
}

export function closeDelegationSqlite() {
  if (!db) return;
  try {
    db.close();
  } catch {
    // Ignore double-close in tests.
  }
  db = null;
  dbPath = '';
}

/**
 * @param {DatabaseSync} database
 * @param {() => T} work
 * @returns {T}
 * @template T
 */
export function withDelegationSqliteTransaction(database, work) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    database.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // Rollback may fail if the transaction never started.
    }
    throw err;
  }
}

/**
 * @param {object} row
 */
function nextAttemptAt(row) {
  const items = Array.isArray(row?.outbox) ? row.outbox : [];
  const pending = items
    .filter((item) => !String(item.deliveredAt || '').trim())
    .map((item) => String(item.nextAttemptAt || ''))
    .filter(Boolean)
    .sort();
  return pending[0] || '';
}

/**
 * @param {DatabaseSync} database
 * @param {object} row
 */
export function upsertDelegationSqlite(database, row) {
  if (!row?.id) return;
  database.prepare(`
    INSERT INTO delegations(id, revision, status, parent_chat_id, child_chat_id, workspace_folder, idempotency_key, created_at, archived_at, json)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      revision=excluded.revision,
      status=excluded.status,
      parent_chat_id=excluded.parent_chat_id,
      child_chat_id=excluded.child_chat_id,
      workspace_folder=excluded.workspace_folder,
      idempotency_key=excluded.idempotency_key,
      created_at=excluded.created_at,
      archived_at=excluded.archived_at,
      json=excluded.json
  `).run(
    row.id,
    Number(row.revision) || 1,
    String(row.status || ''),
    String(row.parentChatId || ''),
    String(row.childChatId || ''),
    String(row.workspaceFolder || ''),
    String(row.idempotencyKey || ''),
    String(row.createdAt || ''),
    String(row.archivedAt || ''),
    JSON.stringify(row),
  );
  database.prepare('DELETE FROM attempts WHERE delegation_id = ?').run(row.id);
  database.prepare('DELETE FROM outbox WHERE delegation_id = ?').run(row.id);
  const attempts = Array.isArray(row.attempts) ? row.attempts : [];
  const insertAttempt = database.prepare('INSERT INTO attempts(id, delegation_id, created_at, json) VALUES(?, ?, ?, ?)');
  for (const attempt of attempts) {
    const id = String(attempt.attemptId || attempt.id || '').trim();
    if (!id) continue;
    insertAttempt.run(id, row.id, String(attempt.startedAt || attempt.createdAt || row.createdAt || ''), JSON.stringify(attempt));
  }
  const insertOutbox = database.prepare(
    'INSERT INTO outbox(id, delegation_id, delivered_at, next_attempt_at, json) VALUES(?, ?, ?, ?, ?)',
  );
  for (const item of Array.isArray(row.outbox) ? row.outbox : []) {
    const id = String(item.id || '').trim();
    if (!id) continue;
    insertOutbox.run(
      id,
      row.id,
      String(item.deliveredAt || ''),
      String(item.nextAttemptAt || nextAttemptAt({ outbox: [item] })),
      JSON.stringify(item),
    );
  }
  const tombstone = String(row.tombstoneUntil || '').trim();
  const key = String(row.idempotencyKey || '').trim();
  if (key && tombstone) {
    database.prepare(`
      INSERT INTO idempotency_tombstones(key, delegation_id, until_at) VALUES(?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET delegation_id=excluded.delegation_id, until_at=excluded.until_at
    `).run(key, row.id, tombstone);
  }
}

/**
 * @param {DatabaseSync} database
 * @param {object} row
 */
export function upsertMailboxSqlite(database, row) {
  if (!row?.id) return;
  database.prepare(`
    INSERT INTO mailbox(id, status, to_chat_id, from_chat_id, delegation_id, idempotency_key, created_at, json)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status=excluded.status,
      to_chat_id=excluded.to_chat_id,
      from_chat_id=excluded.from_chat_id,
      delegation_id=excluded.delegation_id,
      idempotency_key=excluded.idempotency_key,
      created_at=excluded.created_at,
      json=excluded.json
  `).run(
    row.id,
    String(row.status || ''),
    String(row.toChatId || ''),
    String(row.fromChatId || ''),
    String(row.delegationId || ''),
    String(row.idempotencyKey || ''),
    String(row.createdAt || ''),
    JSON.stringify(row),
  );
}

/**
 * @param {DatabaseSync} database
 * @param {string} id
 * @returns {object | null}
 */
export function getDelegationSqliteById(database, id) {
  const normalized = String(id || '').trim();
  if (!normalized) return null;
  const row = database.prepare('SELECT json FROM delegations WHERE id = ?').get(normalized);
  return row ? JSON.parse(String(row.json)) : null;
}

/**
 * @param {DatabaseSync} database
 * @param {string} id
 * @returns {object | null}
 */
export function getMailboxSqliteById(database, id) {
  const normalized = String(id || '').trim();
  if (!normalized) return null;
  const row = database.prepare('SELECT json FROM mailbox WHERE id = ?').get(normalized);
  return row ? JSON.parse(String(row.json)) : null;
}

/**
 * @param {DatabaseSync} database
 * @returns {object[]}
 */
export function loadDelegationsSqlite(database) {
  return database.prepare('SELECT json FROM delegations ORDER BY created_at ASC').all()
    .map((row) => JSON.parse(String(row.json)));
}

/**
 * @param {DatabaseSync} database
 * @returns {object[]}
 */
export function loadMailboxSqlite(database) {
  return database.prepare('SELECT json FROM mailbox ORDER BY created_at ASC').all()
    .map((row) => JSON.parse(String(row.json)));
}

/**
 * @param {DatabaseSync} database
 * @param {object[]} items
 */
export function replaceDelegationsSqlite(database, items) {
  withDelegationSqliteTransaction(database, () => {
    database.exec('DELETE FROM outbox');
    database.exec('DELETE FROM attempts');
    database.exec('DELETE FROM delegations');
    for (const row of items) upsertDelegationSqlite(database, row);
  });
}

/**
 * @param {DatabaseSync} database
 * @param {object[]} items
 */
export function replaceMailboxSqlite(database, items) {
  withDelegationSqliteTransaction(database, () => {
    database.exec('DELETE FROM mailbox');
    for (const row of items) upsertMailboxSqlite(database, row);
  });
}

/**
 * Upsert without deleting existing rows. Used to resume a migration.
 *
 * @param {DatabaseSync} database
 * @param {object[]} items
 */
export function importDelegationsSqlite(database, items) {
  withDelegationSqliteTransaction(database, () => {
    for (const row of items) upsertDelegationSqlite(database, row);
  });
}

/**
 * @param {DatabaseSync} database
 * @param {object[]} items
 */
export function importMailboxSqlite(database, items) {
  withDelegationSqliteTransaction(database, () => {
    for (const row of items) upsertMailboxSqlite(database, row);
  });
}

/**
 * @param {DatabaseSync} database
 * @returns {number}
 */
export function readSqliteSchemaVersion(database) {
  const row = database.prepare('SELECT value FROM meta WHERE key = ?').get('schemaVersion');
  return Number(row?.value) || 0;
}
