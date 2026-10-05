import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import {
  createDelegationRecord,
  listActiveDelegations,
  listDelegationsForChatIds,
  listDelegationsForWorkspace,
  loadDelegations,
} from '../lib/persist/delegations-persist.js';

const file = path.join(ISOLATED_DATA_DIR, 'delegations.json');
const originalRead = fs.readFileSync;
let delegationReads = 0;
fs.readFileSync = function readFileSyncCounting(target, ...args) {
  if (String(target).endsWith(`${path.sep}delegations.json`)) delegationReads += 1;
  return originalRead.call(this, target, ...args);
};

try {
  fs.mkdirSync(ISOLATED_DATA_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    v: 2,
    items: [
      { id: 'd1', status: 'running', parentChatId: 'parent-a', childChatId: 'child-a', workspaceFolder: '/tmp/cretli-ws-a' },
      { id: 'd2', status: 'running', parentChatId: 'parent-b', childChatId: 'child-b', workspaceFolder: '/tmp/cretli-ws-b' },
      { id: 'd3', status: 'completed', parentChatId: 'parent-c', childChatId: 'child-c', workspaceFolder: '/tmp/cretli-ws-a' },
      { id: 'd4', status: 'completed', parentChatId: 'parent-d', childChatId: 'child-d', workspaceFolder: '/tmp/cretli-ws-a', runStoppingAt: '2020-01-01T00:00:00.000Z' },
      { id: 'd5', status: 'completed', parentChatId: 'parent-e', childChatId: 'child-e', workspaceFolder: '/tmp/cretli-ws-a', outbox: [{ deliveredAt: '' }] },
    ],
  }));
  delegationReads = 0;
  const first = loadDelegations();
  const second = loadDelegations();
  assert.equal(first.length, 5);
  assert.equal(second[0].id, 'd1');
  assert.equal(second[0].status, 'running');
  assert.equal(delegationReads, 1);
  const forChat = listDelegationsForChatIds(['child-a']);
  assert.deepEqual(forChat.map((row) => row.id), ['d1']);
  const forWorkspace = listDelegationsForWorkspace('/tmp/cretli-ws-b/');
  assert.deepEqual(forWorkspace.map((row) => row.id), ['d2']);
  assert.equal(delegationReads, 1);
  assert.deepEqual(listActiveDelegations().map((row) => row.id), ['d1', 'd2', 'd4', 'd5']);
  assert.equal(delegationReads, 1);
  first[0].status = 'completed';
  assert.equal(loadDelegations()[0].status, 'running');
  assert.equal(delegationReads, 1);
  createDelegationRecord({
    parentChatId: 'parent',
    childChatId: 'child',
    workspaceFolder: '/tmp/cretli-cache-test',
  });
  delegationReads = 0;
  const after = loadDelegations();
  assert.equal(after.length, 6);
  assert.equal(delegationReads, 1);
  console.log('delegations-persist-cache.test.js ok');
} finally {
  fs.readFileSync = originalRead;
}
