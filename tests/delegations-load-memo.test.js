import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolveDataPath } from '../lib/runtime-paths.js';
import {
  createDelegationRecord,
  delegationLoadStats,
  loadDelegations,
  loadDelegationsReadonly,
  updateDelegationRecord,
} from '../lib/persist/delegations-persist.js';
import { setDelegationStoreBackend } from '../lib/persist/delegation-store-backend.js';
import { loadChats, saveChats } from '../lib/persist/chats-persist.js';

for (const backend of ['json', 'sqlite']) {
  setDelegationStoreBackend(backend);
  const mk = (n) => createDelegationRecord({
    parentChatId: `p${n}-${backend}`,
    childChatId: `c${n}-${backend}`,
    workspaceFolder: `/tmp/memo${n}-${backend}`,
  });
  const rec = mk(1);
  const other = mk(2);
  const find = (id = rec.id) => loadDelegationsReadonly().find((r) => r.id === id);

  // loadDelegations() copies: edits to top-level fields/arrays never reach later loads, and building the
  // frozen snapshot must not freeze objects that loadDelegations() callers may still mutate.
  const copy = loadDelegations().find((r) => r.id === rec.id);
  copy.attempts.push({ attemptId: 'x' });
  copy.metrics.nested = { poison: true };
  copy.workspaceFolder = 'changed';
  const readonly = find();
  const mutable = loadDelegations().find((r) => r.id === rec.id);
  assert.equal(Object.isFrozen(mutable), false, backend);
  assert.equal(Object.isFrozen(mutable.metrics), false, backend);
  assert.doesNotThrow(() => { mutable.metrics.probe = 1; }, backend);
  assert.equal(readonly.attempts.length, 0, backend);
  assert.equal(readonly.metrics.nested, undefined, backend);
  assert.equal(readonly.workspaceFolder, `/tmp/memo1-${backend}`, backend);
  assert.equal(loadDelegations().find((r) => r.id === rec.id).workspaceFolder, `/tmp/memo1-${backend}`, backend);

  // The snapshot is frozen: a caller cannot poison it.
  assert.throws(() => { readonly.workspaceFolder = 'x'; }, TypeError, backend);
  assert.throws(() => { readonly.attempts.push({}); }, TypeError, backend);
  assert.throws(() => { loadDelegationsReadonly().push({}); }, TypeError, backend);

  // Cache hit: unchanged store serves the same array, normalizing nothing.
  const snapshot = loadDelegationsReadonly();
  const before = { ...delegationLoadStats };
  for (let i = 0; i < 5; i += 1) assert.equal(loadDelegationsReadonly(), snapshot, backend);
  assert.equal(delegationLoadStats.snapshotHits - before.snapshotHits, 5, backend);
  assert.equal(delegationLoadStats.snapshotBuilds, before.snapshotBuilds, backend);
  assert.equal(delegationLoadStats.rowsNormalized, before.rowsNormalized, backend);

  // Invalidation after an in-process write: new snapshot with the new value.
  updateDelegationRecord(rec.id, { reportSummary: 'after-update' });
  const afterWrite = loadDelegationsReadonly();
  assert.notEqual(afterWrite, snapshot, backend);
  assert.equal(find().reportSummary, 'after-update', backend);
  assert.equal(snapshot.find((r) => r.id === rec.id).reportSummary !== 'after-update', true, backend);

  // A write re-normalizes only what changed on sqlite (json re-seeds the whole document).
  if (backend === 'sqlite') {
    loadDelegationsReadonly();
    const b2 = delegationLoadStats.rowsNormalized;
    updateDelegationRecord(other.id, { reportSummary: 'touch-other' });
    assert.equal(find(other.id).reportSummary, 'touch-other');
    assert.equal(delegationLoadStats.rowsNormalized - b2, 1, 'only the written row is re-normalized');
  }

  // Invalidation after an external write to the store file (json only: sqlite is the file of record).
  if (backend === 'json') {
    const file = resolveDataPath('delegations.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    doc.items.find((r) => r.id === rec.id).reportSummary = 'external-write-with-longer-text';
    fs.writeFileSync(file, JSON.stringify(doc));
    assert.equal(find().reportSummary, 'external-write-with-longer-text', backend);
  }
}
setDelegationStoreBackend('json');

// Chat copies stay independent and complete.
saveChats(Array.from({ length: 3000 }, (_, i) => ({ id: String(i), title: `t${i}`, createdAt: 'x' })));
for (let i = 0; i < 50; i += 1) loadChats();
const chats = loadChats();
chats[0].title = 'changed';
chats.pop();
const again = loadChats();
assert.equal(again[0].title, 't0');
assert.equal(again.length, 3000);
assert.notEqual(again[0], loadChats()[0]);
console.log('delegations-load-memo.test.js ok');
