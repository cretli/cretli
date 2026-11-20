/**
 * Every lookup accessor returns the same rows (and order) from the JSON store
 * and from the SQLite indexed columns, and a v3 SQLite file is upgraded with
 * backfilled lookup columns while a newer schema is refused.
 */
import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  findDelegationByChildChatId,
  findDelegationByIdempotencyKey,
  getDelegationById,
  listActiveDelegations,
  listDelegationsForChat,
  listDelegationsForChatIds,
  listDelegationsForController,
  listDelegationsForRootChat,
  listDelegationsForTreeRoot,
  listDelegationsForWorkspace,
  loadDelegations,
} from '../lib/persist/delegations-persist.js';
import {
  findMailboxByIdempotencyKey,
  findMailboxFinalReplyForAttempt,
  findMailboxFinalReplyForDelegation,
  findMailboxReplyForDelegation,
  listMailboxForChat,
  listMailboxForDelegationAttempt,
  listQueuedMailboxForRecipient,
} from '../lib/persist/delegation-mailbox-persist.js';
import {
  closeDelegationSqlite,
  importDelegationsSqlite,
  importMailboxSqlite,
  openDelegationSqlite,
  queryDelegationsSqlite,
} from '../lib/persist/delegation-sqlite.js';
import { setDelegationStoreBackend } from '../lib/persist/delegation-store-backend.js';

const wsA = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-eq-ws-a-'));
const wsB = path.join(os.tmpdir(), 'cretli-eq-ws-missing');

test.after(() => {
  setDelegationStoreBackend('json');
  closeDelegationSqlite();
  fs.rmSync(wsA, { recursive: true, force: true });
  removeIsolatedDataDir();
});

let seq = 0;
function row(fields) {
  seq += 1;
  return {
    revision: 1,
    status: 'completed',
    createdAt: `2026-01-01T00:00:${String(seq).padStart(2, '0')}.000Z`,
    ...fields,
  };
}

// Legacy rows (no controller, no tree fields), moved controllers, nested
// trees, trailing-slash workspaces, every tick-relevance trigger, and a
// duplicated child chat whose latest row must win.
const corpus = [
  row({ id: 'd1', parentChatId: 'p1', childChatId: 'c1', workspaceFolder: wsA, status: 'running', idempotencyKey: 'k1' }),
  row({ id: 'd2', parentChatId: 'p1', controllerChatId: 'ctl', childChatId: 'c2', workspaceFolder: `${wsA}/` }),
  row({ id: 'd3', parentChatId: 'c1', childChatId: 'c3', rootChatId: 'p1', rootDelegationId: 'd1', depth: 2, workspaceFolder: wsB }),
  row({ id: 'd4', parentChatId: 'p2', childChatId: 'c4', runStoppingAt: '2026-01-01T00:00:00.000Z' }),
  row({ id: 'd5', parentChatId: 'p2', childChatId: 'c5', outbox: [{ id: 'o1', deliveredAt: '' }] }),
  row({ id: 'd6', parentChatId: 'p2', childChatId: 'c6', slotHeldBy: 'cancel_unconfirmed' }),
  row({ id: 'd7', parentChatId: 'p3', childChatId: 'c7', idempotencyKey: 'k7', outbox: [{ id: 'o2', deliveredAt: '2026-01-01T00:00:00.000Z' }] }),
  row({ id: 'd8', parentChatId: 'p3', childChatId: 'c7', status: 'failed' }),
];

/** @returns {Record<string, unknown>} */
function snapshotAccessors() {
  const ids = (rows) => rows.map((r) => r.id);
  return {
    all: ids(loadDelegations()),
    // JSON groups by input chat id; SQLite returns store order. Same set.
    chatIds: ids(listDelegationsForChatIds(['p1', 'c7', 'ctl'])).sort(),
    active: ids(listActiveDelegations()),
    workspaceA: ids(listDelegationsForWorkspace(wsA)),
    workspaceB: ids(listDelegationsForWorkspace(`${wsB}/`)),
    controllerP1: ids(listDelegationsForController('p1')),
    controllerCtl: ids(listDelegationsForController('ctl')),
    chatP1: ids(listDelegationsForChat('p1')),
    chatC1: ids(listDelegationsForChat('c1')),
    rootP1: ids(listDelegationsForRootChat('p1')),
    rootP2: ids(listDelegationsForRootChat('p2')),
    treeD1: ids(listDelegationsForTreeRoot('d1')),
    childC7: findDelegationByChildChatId('c7')?.id,
    childC1: findDelegationByChildChatId('c1')?.id,
    childNone: findDelegationByChildChatId('nope'),
    key1: findDelegationByIdempotencyKey('k1')?.id,
    keyNone: findDelegationByIdempotencyKey('nope'),
    byId: getDelegationById('d3')?.rootChatId,
  };
}

test('json and sqlite accessors return the same rows', () => {
  setDelegationStoreBackend('json');
  fs.writeFileSync(path.join(ISOLATED_DATA_DIR, 'delegations.json'), JSON.stringify({ v: 2, items: corpus }));
  const fromJson = snapshotAccessors();
  assert.deepEqual(fromJson.rootP1, ['d1', 'd2', 'd3']);
  assert.deepEqual(fromJson.active, ['d1', 'd4', 'd5', 'd6']);
  assert.equal(fromJson.childC7, 'd8');
  importDelegationsSqlite(openDelegationSqlite(), corpus);
  setDelegationStoreBackend('sqlite');
  try {
    assert.deepEqual(snapshotAccessors(), fromJson);
    // Presence flushes pass every chat id; three bind variables per id used to exceed the SQLite
    // variable limit ("too many SQL variables") once ~11k chats existed.
    const many = Array.from({ length: 40_000 }, (_, i) => `chat-${i}`).concat(['p1', 'c7', 'ctl']);
    assert.deepEqual(listDelegationsForChatIds(many).map((r) => r.id).sort(), fromJson.chatIds);
  } finally {
    setDelegationStoreBackend('json');
  }
});

const mailboxCorpus = [
  { id: 'm1', kind: 'task', status: 'delivered', fromChatId: 'p1', toChatId: 'c1', delegationId: 'd1', createdAt: '2026-01-01T00:00:01.000Z' },
  { id: 'm2', kind: 'reply', replyKind: 'progress', status: 'queued', fromChatId: 'c1', toChatId: 'p1', delegationId: 'd1', delegationAttemptId: 'a1', createdAt: '2026-01-01T00:00:02.000Z' },
  { id: 'm3', kind: 'reply', replyKind: 'final_report', status: 'queued', fromChatId: 'c1', toChatId: 'p1', delegationId: 'd1', delegationAttemptId: 'a1', idempotencyKey: 'mk', createdAt: '2026-01-01T00:00:03.000Z' },
  { id: 'm4', kind: 'reply', replyKind: 'final_report', status: 'delivered', fromChatId: 'c2', toChatId: 'p1', delegationId: 'd2', delegationAttemptId: '', createdAt: '2026-01-01T00:00:00.500Z' },
];

function snapshotMailbox() {
  const ids = (rows) => rows.map((r) => r.id);
  return {
    chatP1: ids(listMailboxForChat('p1')),
    queuedP1: ids(listQueuedMailboxForRecipient('p1')),
    key: findMailboxByIdempotencyKey('mk')?.id,
    replyD1: findMailboxReplyForDelegation('d1')?.id,
    finalA1: findMailboxFinalReplyForAttempt('d1', 'a1')?.id,
    finalD2: findMailboxFinalReplyForDelegation('d2')?.id,
    attemptA1: ids(listMailboxForDelegationAttempt('d1', 'a1')),
  };
}

test('json and sqlite mailbox lookups return the same rows', () => {
  setDelegationStoreBackend('json');
  fs.writeFileSync(path.join(ISOLATED_DATA_DIR, 'delegation-mailbox.json'), JSON.stringify({ v: 1, items: mailboxCorpus }));
  const fromJson = snapshotMailbox();
  assert.deepEqual(fromJson.queuedP1, ['m2', 'm3']);
  assert.equal(fromJson.finalA1, 'm3');
  // m4 is out of creation order on purpose: JSON lists file order, SQLite
  // creation order, so the multi-row chat listing is compared as a set.
  importMailboxSqlite(openDelegationSqlite(), mailboxCorpus);
  setDelegationStoreBackend('sqlite');
  try {
    const fromSqlite = snapshotMailbox();
    assert.deepEqual({ ...fromSqlite, chatP1: [...fromSqlite.chatP1].sort() }, { ...fromJson, chatP1: [...fromJson.chatP1].sort() });
  } finally {
    setDelegationStoreBackend('json');
  }
});

test('indexed json accessors hand out copies', () => {
  setDelegationStoreBackend('json');
  const first = listDelegationsForChat('p1')[0];
  first.status = 'tampered';
  assert.equal(listDelegationsForChat('p1')[0].status, 'running');
  findDelegationByIdempotencyKey('k1').status = 'tampered';
  assert.equal(findDelegationByIdempotencyKey('k1').status, 'running');
});

test('a v3 sqlite file gains backfilled lookup columns; a newer one is refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-eq-upgrade-'));
  try {
    const file = path.join(dir, 'delegations.sqlite');
    const legacy = new DatabaseSync(file);
    legacy.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE delegations (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, status TEXT NOT NULL,
        parent_chat_id TEXT NOT NULL, controller_chat_id TEXT NOT NULL DEFAULT '', child_chat_id TEXT NOT NULL DEFAULT '',
        workspace_folder TEXT NOT NULL DEFAULT '', idempotency_key TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
        archived_at TEXT NOT NULL DEFAULT '', json TEXT NOT NULL);
      INSERT INTO meta(key, value) VALUES('schemaVersion', '3');
      PRAGMA user_version = 3;
    `);
    const insert = legacy.prepare('INSERT INTO delegations(id, revision, status, parent_chat_id, created_at, json) VALUES(?, 1, ?, ?, ?, ?)');
    for (const r of [corpus[0], corpus[2], corpus[3]]) insert.run(r.id, r.status, r.parentChatId, r.createdAt, JSON.stringify(r));
    legacy.close();
    closeDelegationSqlite();
    const database = openDelegationSqlite({ dataDir: dir });
    assert.equal(Number(database.prepare('PRAGMA user_version').get().user_version), 4);
    const ids = (where, params) => queryDelegationsSqlite(database, where, params).map((r) => r.id);
    assert.deepEqual(ids('root_chat_id = ?', ['p1']), ['d1', 'd3']);
    assert.deepEqual(ids('root_delegation_id = ?', ['d1']), ['d1', 'd3']);
    assert.deepEqual(ids('tick_relevant = 1', []), ['d1', 'd4']);
    closeDelegationSqlite();
    const newer = new DatabaseSync(file);
    newer.exec("UPDATE meta SET value = '99' WHERE key = 'schemaVersion'; PRAGMA user_version = 99;");
    newer.close();
    assert.throws(() => openDelegationSqlite({ dataDir: dir }), /newer than this build/);
  } finally {
    closeDelegationSqlite();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sqlite parsed-row cache follows writes and revision changes', async () => {
  const { updateDelegationRecord } = await import('../lib/persist/delegations-persist.js');
  setDelegationStoreBackend('sqlite');
  try {
    assert.equal(listDelegationsForChat('p3').find((r) => r.id === 'd8').status, 'failed');
    updateDelegationRecord('d8', { status: 'interrupted' });
    assert.equal(listDelegationsForChat('p3').find((r) => r.id === 'd8').status, 'interrupted');
    // Another connection bumps the revision: the next read re-parses the row.
    const other = new DatabaseSync(path.join(ISOLATED_DATA_DIR, 'delegations.sqlite'));
    const stored = JSON.parse(other.prepare('SELECT json FROM delegations WHERE id = ?').get('d8').json);
    other.prepare('UPDATE delegations SET revision = ?, json = ? WHERE id = ?')
      .run(stored.revision + 1, JSON.stringify({ ...stored, revision: stored.revision + 1, status: 'cancelled' }), 'd8');
    other.close();
    assert.equal(loadDelegations().find((r) => r.id === 'd8').status, 'cancelled');
    listDelegationsForChat('p3')[0].status = 'tampered';
    assert.notEqual(listDelegationsForChat('p3')[0].status, 'tampered');
  } finally {
    setDelegationStoreBackend('json');
  }
});

test('sqlite workspace lookup follows symlinks and folders created after the write', async () => {
  const { updateDelegationRecordsBatch } = await import('../lib/persist/delegations-persist.js');
  const link = path.join(os.tmpdir(), `cretli-eq-link-${process.pid}`);
  const late = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-eq-late-'));
  fs.rmSync(late, { recursive: true, force: true });
  fs.rmSync(link, { force: true });
  fs.symlinkSync(wsA, link);
  try {
    const extra = [
      row({ id: 'w-link', parentChatId: 'pw', childChatId: 'cw1', workspaceFolder: link }),
      row({ id: 'w-late', parentChatId: 'pw', childChatId: 'cw2', workspaceFolder: late }),
    ];
    setDelegationStoreBackend('sqlite');
    importDelegationsSqlite(openDelegationSqlite(), extra);
    // The folder appears only after the row was written.
    fs.mkdirSync(late);
    const ids = (folder) => listDelegationsForWorkspace(folder).map((r) => r.id);
    assert.ok(ids(wsA).includes('w-link'), 'symlinked folder matches its target');
    assert.deepEqual(ids(late), ['w-late']);
    // A batch is one transaction and every patched row reads back.
    assert.equal(updateDelegationRecordsBatch([
      { id: 'w-link', patch: { sourceText: 'batched' } },
      { id: 'w-late', patch: { sourceText: 'batched' } },
      { id: 'missing', patch: { sourceText: 'x' } },
    ]), 2);
    assert.deepEqual(listDelegationsForChat('pw').map((r) => r.sourceText), ['batched', 'batched']);
  } finally {
    setDelegationStoreBackend('json');
    fs.rmSync(link, { force: true });
    fs.rmSync(late, { recursive: true, force: true });
  }
});
