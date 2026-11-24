import test from 'node:test';
import assert from 'node:assert/strict';
import { runInBackgroundWorker, resetBackgroundWorker } from '../lib/background-worker.js';
import { applyBackgroundPriority } from '../lib/process-priority.js';

const items = [
  { id: 'root', status: 'idea' },
  { id: 'a', status: 'ready', parent_id: 'root', parentId: 'root' },
  { id: 'b', status: 'done', parent_id: 'root', parentId: 'root' },
];

test('worker result equals in-process result', async () => {
  const viaWorker = await runInBackgroundWorker('todo-readiness', { items });
  const inProc = await runInBackgroundWorker('todo-readiness', { items }, { inProcess: true });
  assert.deepEqual(viaWorker, inProc);
  assert.equal(await runInBackgroundWorker('echo', { x: 1 }).then((r) => r.x), 1);
  await resetBackgroundWorker();
});

test('unknown task rejects instead of falling back silently', async () => {
  await assert.rejects(runInBackgroundWorker('nope', {}), /Unknown background task/);
  await resetBackgroundWorker();
});

test('worker is recreated after reset', async () => {
  await resetBackgroundWorker();
  assert.deepEqual(await runInBackgroundWorker('echo', [1]), [1]);
  await resetBackgroundWorker();
});

test('applyBackgroundPriority applies nice and never throws', () => {
  const calls = [];
  assert.equal(applyBackgroundPriority(123, { nice: 7, setPriority: (p, n) => calls.push([p, n]) }), true);
  assert.deepEqual(calls, [[123, 7]]);
  assert.equal(applyBackgroundPriority(123, { nice: 99, setPriority: (p, n) => calls.push([p, n]) }), true);
  assert.deepEqual(calls[1], [123, 19]);
  assert.equal(applyBackgroundPriority(undefined, { setPriority: () => assert.fail() }), false);
  assert.equal(applyBackgroundPriority(5, { nice: 0, setPriority: () => assert.fail() }), false);
  assert.equal(applyBackgroundPriority(5, { nice: 5, setPriority: () => { throw new Error('EPERM'); } }), false);
});
