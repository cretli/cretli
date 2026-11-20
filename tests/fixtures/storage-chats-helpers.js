/** Shared helpers of the tests/storage-chats-*.test.js files: offline chats databases, fixtures, statement counting. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from '../../lib/storage/migrations.js';
import { offlineHandlers } from '../../lib/storage/chats-store.js';

/** @returns {string} a fresh temporary directory */
export function tempDir(prefix = 'cretli-chats-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Open (or create) a migrated chats database. `file` null = in memory.
 *
 * @param {string | null} [file]
 * @param {{ wal?: boolean }} [options]
 */
export function openChatsDb(file = null, options = {}) {
  const db = new DatabaseSync(file ?? ':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  if (file && options.wal) db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL');
  applyMigrations(db);
  return db;
}

/**
 * Context over a raw connection. `stats.executed` counts statement executions, `stats.prepared` distinct SQL texts.
 *
 * @param {DatabaseSync} db
 */
export function countingCtx(db) {
  const stats = { executed: 0, prepared: new Set(), sql: /** @type {string[]} */ ([]) };
  const ctx = {
    prepare(sql) {
      stats.prepared.add(sql);
      const stmt = db.prepare(sql);
      return new Proxy(stmt, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (typeof value !== 'function') return value;
          if (prop === 'run' || prop === 'get' || prop === 'all') {
            return (...args) => { stats.executed += 1; stats.sql.push(sql); return value.apply(target, args); };
          }
          return value.bind(target);
        },
      });
    },
  };
  return { ctx, stats };
}

/**
 * Run `fn` inside BEGIN IMMEDIATE ... COMMIT (ROLLBACK on a throw), like the worker does for one command.
 *
 * @template T
 * @param {DatabaseSync} db
 * @param {() => T} fn
 * @returns {T}
 */
export function inTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Handlers bound to a connection: `h.add({...})` runs in its own transaction, reads run bare. */
export function boundHandlers(db, ctx = { prepare: (sql) => db.prepare(sql) }) {
  const writes = new Set(['add', 'update', 'updateMany', 'remove', 'archive', 'markRead', 'importBatch']);
  return Object.fromEntries(Object.entries(offlineHandlers).map(([name, fn]) => [
    name,
    writes.has(name) ? (payload) => inTransaction(db, () => fn(ctx, payload)) : (payload) => fn(ctx, payload ?? {}),
  ]));
}

const pad = (n, w) => String(n).padStart(w, '0');

/**
 * Deterministic synthetic chats (no real content). Mix of workspaces, widget chats, forks and archived rows.
 *
 * @param {number} n
 * @param {{ idPrefix?: string }} [options]
 * @returns {Record<string, any>[]}
 */
export function syntheticChats(n, options = {}) {
  const prefix = options.idPrefix ?? 'c';
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const folder = `/work/ws-${i % 7}`;
    const chat = {
      id: `${prefix}${pad(i, 6)}`,
      title: `Chat ${i}`,
      cursorSessionId: i % 5 === 0 ? `cs-${prefix}${i}` : '',
      createdAt: `2026-01-01T00:${pad(Math.floor(i / 60) % 60, 2)}:${pad(i % 60, 2)}.000Z`,
      updatedAt: `2026-02-${pad((i % 28) + 1, 2)}T00:00:00.000Z`,
      agentTransport: 'sdk',
      model: 'm-1',
      sdkMode: 'agent',
    };
    if (i % 3 !== 0) chat.workspaceFolder = i % 11 === 0 ? `${folder}/` : folder;
    if (i % 4 === 0) chat.workspaceFile = `${folder}/file-${i % 5}.js`;
    if (i % 13 === 0) { chat.widgetInstallationId = `inst-${i % 3}`; chat.widgetPageSessionId = `page-${i % 2}`; }
    if (i > 10 && i % 6 === 0) chat.forkParentChatId = `${prefix}${pad(i - 6, 6)}`;
    if (i % 9 === 0) chat.archivedAt = `2026-03-0${(i % 8) + 1}T00:00:00.000Z`;
    if (i % 17 === 0) chat.todoId = `todo-${i}`;
    out.push(chat);
  }
  return out;
}

/** Bulk-load chats through the real handler in batches (one transaction). */
export function seedChats(db, chats) {
  const ctx = { prepare: (sql) => db.prepare(sql) };
  inTransaction(db, () => {
    for (let i = 0; i < chats.length; i += 200) offlineHandlers.importBatch(ctx, { chats: chats.slice(i, i + 200) });
  });
}
