import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createTickDelegationsMemo } from '../lib/workspace-watcher-cycle.js';

test('tick delegations memo reads once until reset', () => {
  let reads = 0;
  const memo = createTickDelegationsMemo(() => { reads += 1; return [{ id: `d${reads}` }]; }, '');
  const a = memo.load();
  assert.equal(memo.load(), a);
  assert.equal(memo.load(), a);
  assert.equal(reads, 1);
  memo.reset();
  assert.deepEqual(memo.load(), [{ id: 'd2' }]);
  assert.equal(reads, 2);
});
