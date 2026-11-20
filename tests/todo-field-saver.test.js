import test from 'node:test';
import assert from 'node:assert/strict';
import { createTodoFieldSaver } from '../app_front/features/todo/todoFieldSaver.js';

/** Builds a saver over an in-memory item with a controllable PATCH. */
function harness(initial = 'ready') {
  const state = { status: initial };
  const calls = [];
  const events = [];
  const pending = [];
  const saver = createTodoFieldSaver({
    patch: (id, payload) => new Promise((resolve, reject) => {
      calls.push({ id, payload });
      pending.push({ resolve, reject });
    }),
    read: (_id, field) => state[field],
    applyOptimistic: (_id, field, value) => { state[field] = value; events.push(`opt:${value}`); },
    rollback: (_id, field, previous, error) => { state[field] = previous; events.push(`rollback:${previous}:${error.kind}`); },
    onSaved: (_id, field, data) => { state[field] = data.value; events.push(`saved:${data.value}`); },
  });
  return { state, calls, events, pending, saver };
}

test('status change applies optimistically before the PATCH resolves and sends exactly one request', async () => {
  const h = harness();
  const p = h.saver.save('a', 'status', 'doing');
  assert.equal(h.state.status, 'doing');
  assert.equal(h.calls.length, 1);
  h.pending[0].resolve({ ok: true, value: 'doing' });
  assert.equal(await p, true);
  assert.equal(h.calls.length, 1);
});

test('identical in-flight saves are de-duplicated into one request', async () => {
  const h = harness();
  const p1 = h.saver.save('a', 'status', 'doing');
  const p2 = h.saver.save('a', 'status', 'doing');
  assert.equal(h.calls.length, 1);
  h.pending[0].resolve({ ok: true, value: 'doing' });
  assert.deepEqual(await Promise.all([p1, p2]), [true, true]);
  assert.equal(h.calls.length, 1);
});

test('saving the value already shown sends nothing', async () => {
  const h = harness('done');
  assert.equal(await h.saver.save('a', 'status', 'done'), true);
  assert.equal(h.calls.length, 0);
});

test('a different value during an in-flight save is coalesced and sent afterwards', async () => {
  const h = harness();
  const p1 = h.saver.save('a', 'status', 'doing');
  void h.saver.save('a', 'status', 'idea');
  const p3 = h.saver.save('a', 'status', 'done');
  assert.equal(h.calls.length, 1);
  h.pending[0].resolve({ ok: true, value: 'doing' });
  await p1;
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[1].payload, { status: 'done' });
  h.pending[1].resolve({ ok: true, value: 'done' });
  assert.equal(await p3, true);
  assert.equal(h.state.status, 'done');
});

test('server rejection (CONFLICT) rolls back to the previous value', async () => {
  const h = harness('ready');
  const p = h.saver.save('a', 'status', 'doing');
  assert.equal(h.state.status, 'doing');
  h.pending[0].resolve({ ok: false, error: 'CONFLICT' });
  assert.equal(await p, false);
  assert.equal(h.state.status, 'ready');
  assert.deepEqual(h.events, ['opt:doing', 'rollback:ready:server']);
  assert.equal(h.saver.isSaving('a', 'status'), false);
});

test('a thrown request rolls back as a network error and allows a retry', async () => {
  const h = harness('ready');
  const p = h.saver.save('a', 'status', 'doing');
  h.pending[0].reject(new Error('offline'));
  assert.equal(await p, false);
  assert.equal(h.state.status, 'ready');
  assert.equal(h.events.at(-1), 'rollback:ready:network');
  void h.saver.save('a', 'status', 'doing');
  assert.equal(h.calls.length, 2);
});

test('a queued save after a failed request rolls back to the last saved value, not the optimistic one', async () => {
  const h = harness('ready');
  const p1 = h.saver.save('a', 'status', 'doing');
  const p2 = h.saver.save('a', 'status', 'done');
  h.pending[0].resolve({ ok: false, error: 'CONFLICT' });
  await p1;
  assert.equal(h.calls.length, 2);
  h.pending[1].resolve({ ok: false, error: 'CONFLICT' });
  assert.equal(await p2, false);
  assert.equal(h.state.status, 'ready');
});

test('different fields and todos save independently', async () => {
  const h = harness();
  void h.saver.save('a', 'status', 'doing');
  void h.saver.save('a', 'title', 'New');
  assert.equal(h.calls.length, 2);
});
