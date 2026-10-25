import assert from 'node:assert/strict';
import test from 'node:test';
import { createTodoListModel, isNetworkLoadError, offlineRetryDelay } from '../app_front/features/todo/todoOfflineState.js';

/** Mirrors the refresh flow in todoPanel.js with an injectable fetch. */
async function refresh(model, fetchList) {
  try {
    const data = await fetchList();
    if (!data?.ok) return 'server-error';
    model.applySuccess(data.items);
    return 'ok';
  } catch (error) {
    return model.applyFailure(error);
  }
}

test('rejected fetch keeps items, sets offline; later success clears it', async () => {
  const model = createTodoListModel();
  assert.equal(await refresh(model, async () => ({ ok: true, items: [{ id: 'a' }] })), 'ok');
  assert.equal(await refresh(model, async () => { throw new TypeError('Failed to fetch'); }), 'offline');
  assert.deepEqual(model.items, [{ id: 'a' }]);
  assert.equal(model.offline, true);
  assert.equal(await refresh(model, async () => ({ ok: true, items: [{ id: 'a' }, { id: 'b' }] })), 'ok');
  assert.equal(model.offline, false);
  assert.equal(model.items.length, 2);
});

test('server errors are not treated as offline', async () => {
  const model = createTodoListModel([{ id: 'a' }]);
  assert.equal(await refresh(model, async () => ({ ok: false })), 'server-error');
  assert.equal(await refresh(model, async () => { throw new Error('HTTP 500'); }), 'error');
  assert.equal(model.offline, false);
});

test('backoff grows and is capped; network error detection', () => {
  assert.ok(offlineRetryDelay(1) > offlineRetryDelay(0));
  assert.equal(offlineRetryDelay(50), 30000);
  assert.equal(isNetworkLoadError(new Error('Failed to fetch')), true);
  assert.equal(isNetworkLoadError(null), false);
});
