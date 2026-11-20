process.env.CRETLI_DELEGATION_STORE = 'sqlite';
await import('./helpers/isolated-data-dir.js');
import assert from 'node:assert/strict';
const { openDelegationSqlite, loadDelegationsSqliteCached, upsertDelegationSqlite } = await import('../lib/persist/delegation-sqlite.js');

const database = openDelegationSqlite();
const mk = (id, status) => ({ id, revision: 1, status, parentChatId: 'p', createdAt: `2026-01-01T00:00:0${id.length}Z`, workspaceFolder: '/tmp/ws' });
upsertDelegationSqlite(database, mk('a', 'running'));

const first = loadDelegationsSqliteCached(database);
const second = loadDelegationsSqliteCached(database);
assert.equal(first.length, 1);
// Unchanged store: same parsed rows, but each caller gets its own array.
assert.notEqual(first, second);
assert.equal(first[0], second[0]);
second.pop();
assert.equal(loadDelegationsSqliteCached(database).length, 1);

// A write invalidates the memo.
upsertDelegationSqlite(database, mk('bb', 'running'));
assert.deepEqual(loadDelegationsSqliteCached(database).map((r) => r.id), ['a', 'bb']);
upsertDelegationSqlite(database, { ...mk('a', 'completed'), revision: 2 });
assert.equal(loadDelegationsSqliteCached(database).find((r) => r.id === 'a').status, 'completed');
console.log('delegation-sqlite-list-memo ok');
