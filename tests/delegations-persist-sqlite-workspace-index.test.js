process.env.CRETLI_DELEGATION_STORE = 'sqlite';
await import('./helpers/isolated-data-dir.js');
import assert from 'node:assert/strict';
const { createDelegationRecord, listDelegationsForWorkspace, updateDelegationRecord } = await import('../lib/persist/delegations-persist.js');

const base = { parentChatId: 'p', childChatId: 'c', harness: 'sdk', model: 'm' };
const a = createDelegationRecord({ ...base, workspaceFolder: '/tmp/cretli-ws-a', parentChatId: 'pa' });
createDelegationRecord({ ...base, workspaceFolder: '/tmp/cretli-ws-b', parentChatId: 'pb' });

const first = listDelegationsForWorkspace('/tmp/cretli-ws-a');
assert.deepEqual(first.map((r) => r.id), [a.id]);
// Unchanged store: the same defaulted rows are served, not recomputed.
assert.equal(listDelegationsForWorkspace('/tmp/cretli-ws-a')[0], first[0]);

// A write invalidates the index and the new row shows up.
const c = createDelegationRecord({ ...base, workspaceFolder: '/tmp/cretli-ws-a', parentChatId: 'pc' });
assert.deepEqual(listDelegationsForWorkspace('/tmp/cretli-ws-a').map((r) => r.id).sort(), [a.id, c.id].sort());
assert.equal(listDelegationsForWorkspace('/tmp/cretli-ws-b').length, 1);
assert.deepEqual(listDelegationsForWorkspace('/tmp/cretli-ws-none'), []);

// An update replaces the cached row, so readers see the patched value.
updateDelegationRecord(a.id, { status: 'completed' });
assert.equal(listDelegationsForWorkspace('/tmp/cretli-ws-a').find((r) => r.id === a.id).status, 'completed');
console.log('delegations-persist-sqlite-workspace-index ok');
