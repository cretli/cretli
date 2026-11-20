/**
 * `listDelegationsForChatIds` on SQLite answers from a chat index over the parsed-row cache: shared
 * read-only rows, rebuilt only after a write, same row set as the JSON store.
 */
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDelegationRecord,
  listDelegationsForChatIds,
  updateDelegationRecord,
} from '../lib/persist/delegations-persist.js';
import { closeDelegationSqlite } from '../lib/persist/delegation-sqlite.js';
import { setDelegationStoreBackend } from '../lib/persist/delegation-store-backend.js';

test.after(() => {
  setDelegationStoreBackend('json');
  closeDelegationSqlite();
  removeIsolatedDataDir();
});

test('sqlite chat index: shared rows, rebuild on write, bounded cost', () => {
  setDelegationStoreBackend('sqlite');
  const N = 3000;
  for (let i = 0; i < N; i += 1) {
    createDelegationRecord({
      parentChatId: `p-${i % 50}`,
      childChatId: `c-${i}`,
      status: i % 7 === 0 ? 'running' : 'completed',
    });
  }
  const ids = [...Array.from({ length: 50 }, (_, i) => `p-${i}`), 'c-1', 'c-2'];
  const first = listDelegationsForChatIds(ids);
  // Every row matched once, even when both ends (p-1 and c-1) are requested.
  assert.equal(first.length, N);
  assert.equal(new Set(first.map((r) => r.id)).size, N);
  const started = performance.now();
  const second = listDelegationsForChatIds(ids);
  const warmMs = performance.now() - started;
  // Read-only snapshot: no per-call defaulting or copy, the same row objects come back.
  assert.equal(second[0], first[0]);
  assert.ok(warmMs < 50, `warm lookup took ${warmMs.toFixed(1)} ms`);
  console.log(`[delegations-for-chats] ${N} rows, warm lookup ${warmMs.toFixed(2)} ms`);

  const target = first.find((r) => r.childChatId === 'c-2');
  updateDelegationRecord(target.id, { childChatId: 'moved-child', status: 'failed' });
  const moved = listDelegationsForChatIds(['moved-child']);
  assert.deepEqual(moved.map((r) => r.id), [target.id]);
  assert.equal(moved[0].status, 'failed');
  assert.deepEqual(listDelegationsForChatIds(['c-2']), []);
  setDelegationStoreBackend('json');
});
