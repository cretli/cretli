import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nudgeWorkspaceWatcherAfterTodosMutation } from '../lib/workspace-watcher-nudge.js';

test('nudge describe callback runs only after the mutation resolved', async () => {
  const order = [];
  let release;
  const mutation = new Promise((resolve) => { release = resolve; }).then(() => { order.push('mutated'); return 'ok'; });
  const pending = nudgeWorkspaceWatcherAfterTodosMutation(mutation, () => {
    order.push('described');
    return { dataDir: '', cwd: '', previousDoc: null, nextDoc: { items: [] } };
  });
  assert.deepEqual(order, []);
  release();
  assert.equal(await pending, 'ok');
  assert.deepEqual(order, ['mutated', 'described']);
});

test('a rejected mutation publishes no nudge', async () => {
  let described = false;
  await assert.rejects(
    nudgeWorkspaceWatcherAfterTodosMutation(Promise.reject(new Error('nope')), () => { described = true; return { dataDir: '', cwd: '', previousDoc: null, nextDoc: { items: [] } }; }),
    /nope/,
  );
  assert.equal(described, false);
});
