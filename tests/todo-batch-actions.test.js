/**
 * Async handlers of the bulk integrate flow (start / resume / cancel / abandon /
 * clear lock) driven through injected deps, including delayed A/B workspace
 * answers: a response for workspace A that arrives after the panel switched to B
 * must not touch B's view.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createBatchActions } from '../app_front/features/todo/todoBatchActions.js';
import {
  captureBatchScope,
  createOwnedPendingGuard,
  isBatchScopeCurrent,
} from '../app_front/features/todo/todoBatchSelection.js';

/** A promise the test settles by hand, to model a slow server answer. */
function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

/** Panel double: workspace folder + generation, recorded side effects, scripted api. */
function createHarness({ api = {}, activeBatch = null, confirm = () => true } = {}) {
  const state = {
    folder: '/a',
    generation: 1,
    activeBatch,
    applied: [],
    locks: [],
    statuses: [],
    chats: [],
    confirms: [],
    refreshes: 0,
    exits: 0,
    pickers: [],
  };
  const startGuard = createOwnedPendingGuard();
  const actions = createBatchActions({
    api,
    t: (key) => key,
    setStatus: (msg, isErr) => state.statuses.push({ msg, isErr: !!isErr }),
    confirmAction: (message) => { state.confirms.push(message); return confirm(message); },
    captureScope: () => captureBatchScope(state.folder, state.generation),
    isCurrentScope: (scope) => isBatchScopeCurrent(scope, state.generation, (folder) => folder === state.folder),
    getActiveBatch: () => state.activeBatch,
    applyActiveBatch: (batch) => { state.applied.push(batch); },
    applyLock: (lock) => { state.locks.push(lock); },
    refreshList: async () => { state.refreshes += 1; },
    openChat: (chat) => state.chats.push(chat),
    showChatPanel: () => {},
    exitSelection: () => { state.exits += 1; },
    repaintActionBar: () => {},
    startGuard,
    agentById: new Map(),
    getWorkspaceContext: () => ({ workspaceFile: '' }),
    openAgentPicker: (options) => state.pickers.push(options),
    resolveHarness: () => 'sdk',
    describeFailure: (result, fallbackKey) => String(result?.error || fallbackKey),
  });
  /** Simulates a workspace switch (`resetBatchWorkspaceView`). */
  const switchTo = (folder) => {
    state.folder = folder;
    state.generation += 1;
    startGuard.reset();
  };
  return { state, actions, switchTo, startGuard };
}

const lastStatus = (state) => state.statuses[state.statuses.length - 1];

test('start: answer for A arriving after switching to B is ignored', async () => {
  const slow = deferred();
  const { state, actions, switchTo } = createHarness({
    api: { integrateTodosBatch: () => slow.promise },
  });
  const scope = captureBatchScope('/a', 1);
  const pending = actions.startBatch(['t1'], { harness: 'sdk', model: 'auto' }, scope);
  switchTo('/b');
  slow.resolve({ ok: true, batch: { id: 'bA' }, chat: { id: 'c1' }, skipped: [] });
  await pending;
  assert.deepEqual(state.applied, []);
  assert.deepEqual(state.chats, []);
  assert.equal(state.exits, 0);
  assert.equal(state.refreshes, 0);
  assert.notEqual(lastStatus(state).msg, 'todo.batchStarted');
});

test('start: current scope applies the batch, opens the chat and releases the guard', async () => {
  const { state, actions, startGuard } = createHarness({
    api: { integrateTodosBatch: async () => ({ ok: true, batch: { id: 'b1' }, chat: { id: 'c1' }, skipped: [] }) },
  });
  await actions.startBatch(['t1'], { harness: 'sdk', model: 'm' }, captureBatchScope('/a', 1));
  assert.deepEqual(state.applied, [{ id: 'b1' }]);
  assert.deepEqual(state.chats, [{ id: 'c1' }]);
  assert.equal(state.exits, 1);
  assert.equal(lastStatus(state).msg, 'todo.batchStarted');
  assert.equal(startGuard.isPending(), false);
});

test('start: a stale scope never reaches the api', async () => {
  let calls = 0;
  const { actions, switchTo } = createHarness({ api: { integrateTodosBatch: async () => { calls += 1; return { ok: true }; } } });
  const scope = captureBatchScope('/a', 1);
  switchTo('/b');
  await actions.startBatch(['t1'], { harness: 'sdk', model: 'auto' }, scope);
  assert.equal(calls, 0);
});

test('start: rejected request reports a network error only for the current workspace', async () => {
  const slow = deferred();
  const { state, actions, switchTo } = createHarness({ api: { integrateTodosBatch: () => slow.promise } });
  const pending = actions.startBatch(['t1'], { harness: 'sdk', model: 'auto' }, captureBatchScope('/a', 1));
  switchTo('/b');
  slow.promise.catch(() => {});
  slow.resolve(Promise.reject(new Error('boom')));
  await pending;
  assert.equal(state.statuses.some((row) => row.isErr), false);
});

test('start: an in-flight start from A cannot release the guard of a start in B', async () => {
  const slowA = deferred();
  const slowB = deferred();
  const answers = [slowA, slowB];
  const { actions, switchTo, startGuard } = createHarness({
    api: { integrateTodosBatch: () => answers.shift().promise },
  });
  const pendingA = actions.startBatch(['t1'], { harness: 'sdk', model: 'auto' }, captureBatchScope('/a', 1));
  switchTo('/b');
  const pendingB = actions.startBatch(['t2'], { harness: 'sdk', model: 'auto' }, captureBatchScope('/b', 2));
  slowA.resolve({ ok: true, batch: { id: 'bA' } });
  await pendingA;
  assert.equal(startGuard.isPending(), true, 'B start still owns the guard');
  slowB.resolve({ ok: true, batch: { id: 'bB' } });
  await pendingB;
  assert.equal(startGuard.isPending(), false);
});

test('picker: callback runs the start only while its scope is current', async () => {
  const calls = [];
  const { state, actions, switchTo } = createHarness({
    api: { integrateTodosBatch: async (ids, folder) => { calls.push(folder); return { ok: true, batch: { id: 'b' } }; } },
  });
  actions.openStartPicker(['t1']);
  actions.openStartPicker(['t1']);
  assert.equal(state.pickers.length, 2);
  switchTo('/b');
  await state.pickers[0].onStart({ harness: 'sdk', model: 'auto' });
  assert.deepEqual(calls, [], 'picker opened in A and confirmed in B is dropped');
});

test('resume picker: callback captured in A is ignored in B and remembers no agent', async () => {
  const calls = [];
  const batch = { id: 'b1', status: 'paused', entries: [{ todoId: 't1', state: 'queued' }] };
  const { state, actions, switchTo } = createHarness({
    activeBatch: batch,
    api: { resumeIntegrateBatch: async (...args) => { calls.push(args); return { ok: true, batch }; } },
  });
  actions.resume('retry');
  assert.equal(state.pickers.length, 1, 'unknown agent asks the picker');
  switchTo('/b');
  state.pickers[0].onStart({ harness: 'codex', model: 'x' });
  await Promise.resolve();
  assert.deepEqual(calls, []);
});

test('resume: known agent resumes directly and forwards harness / model', async () => {
  const calls = [];
  const batch = { id: 'b1', status: 'paused', entries: [{ todoId: 't1', state: 'queued' }] };
  const harness = createHarness({
    activeBatch: batch,
    api: { resumeIntegrateBatch: async (...args) => { calls.push(args); return { ok: true, batch: { id: 'b1', status: 'running' }, chat: { id: 'c9' } }; } },
  });
  await harness.actions.executeResume(batch, 'skip', { harness: 'codex', model: 'x' }, captureBatchScope('/a', 1));
  assert.equal(calls[0][0], 'b1');
  assert.equal(calls[0][1], '/a');
  assert.equal(calls[0][2].entryAction, 'skip');
  assert.equal(calls[0][2].agentTransport, 'codex');
  assert.deepEqual(harness.state.chats, [{ id: 'c9' }]);
  assert.equal(lastStatus(harness.state).msg, 'todo.batchResumed');
});

test('resume: delayed answer for A after switching to B is ignored', async () => {
  const slow = deferred();
  const batch = { id: 'b1', status: 'paused', entries: [] };
  const { state, actions, switchTo } = createHarness({ api: { resumeIntegrateBatch: () => slow.promise } });
  const pending = actions.executeResume(batch, 'retry', null, captureBatchScope('/a', 1));
  switchTo('/b');
  slow.resolve({ ok: true, batch: { id: 'b1' }, chat: { id: 'c1' } });
  await pending;
  assert.deepEqual(state.applied, []);
  assert.deepEqual(state.chats, []);
  assert.equal(state.refreshes, 0);
});

test('resume: liveness error asks for confirmation and retries with force', async () => {
  const forced = [];
  const batch = { id: 'b1', status: 'running', entries: [] };
  const { state, actions } = createHarness({
    api: {
      resumeIntegrateBatch: async (id, folder, opts) => {
        forced.push(opts.forceLiveness);
        return opts.forceLiveness ? { ok: true, batch } : { ok: false, error: 'agent_busy' };
      },
    },
  });
  await actions.executeResume(batch, 'retry', null, captureBatchScope('/a', 1));
  assert.deepEqual(forced, [false, true]);
  assert.deepEqual(state.confirms, ['todo.batchForceLivenessConfirm']);
});

test('resume: declining the force confirmation stops without a second request', async () => {
  let calls = 0;
  const batch = { id: 'b1', status: 'running', entries: [] };
  const { actions } = createHarness({
    confirm: () => false,
    api: { resumeIntegrateBatch: async () => { calls += 1; return { ok: false, error: 'liveness_unknown' }; } },
  });
  await actions.executeResume(batch, 'retry', null, captureBatchScope('/a', 1));
  assert.equal(calls, 1);
});

test('resume: nothing left to run needs no picker', () => {
  const batch = { id: 'b2', status: 'stalled', entries: [{ todoId: 't1', state: 'merged' }] };
  const calls = [];
  const { state, actions } = createHarness({
    activeBatch: batch,
    api: { resumeIntegrateBatch: async (...args) => { calls.push(args); return { ok: true, batch }; } },
  });
  actions.resume('retry');
  assert.equal(state.pickers.length, 0);
  assert.equal(calls.length, 1);
});

test('cancel: declined confirm makes no request; stale answer is dropped', async () => {
  const slow = deferred();
  const batch = { id: 'b1', status: 'running' };
  const declined = createHarness({ activeBatch: batch, confirm: () => false, api: { cancelIntegrateBatch: () => assert.fail('no request') } });
  await declined.actions.cancel();
  const { state, actions, switchTo } = createHarness({ activeBatch: batch, api: { cancelIntegrateBatch: () => slow.promise } });
  const pending = actions.cancel();
  switchTo('/b');
  slow.resolve({ ok: true, batch: { id: 'b1', status: 'cancelling' } });
  await pending;
  assert.deepEqual(state.applied, []);
  assert.notEqual(lastStatus(state).msg, 'todo.batchCancelRequested');
});

test('cancel: success applies the returned batch', async () => {
  const { state, actions } = createHarness({
    activeBatch: { id: 'b1', status: 'running' },
    api: { cancelIntegrateBatch: async () => ({ ok: true, batch: { id: 'b1', status: 'cancelling' } }) },
  });
  await actions.cancel();
  assert.deepEqual(state.applied, [{ id: 'b1', status: 'cancelling' }]);
  assert.equal(lastStatus(state).msg, 'todo.batchCancelRequested');
});

test('abandon: stale answer is dropped, failure keeps the returned batch', async () => {
  const slow = deferred();
  const batch = { id: 'b1', status: 'paused' };
  const stale = createHarness({ activeBatch: batch, api: { abandonIntegrateBatch: () => slow.promise } });
  const pending = stale.actions.abandon();
  stale.switchTo('/b');
  slow.resolve({ ok: true, batch: { id: 'b1', status: 'abandoned' } });
  await pending;
  assert.deepEqual(stale.state.applied, []);
  assert.equal(stale.state.refreshes, 0);
  const failing = createHarness({
    activeBatch: batch,
    api: { abandonIntegrateBatch: async () => ({ ok: false, error: 'not_active', batch: { id: 'b1', status: 'completed' } }) },
  });
  await failing.actions.abandon();
  assert.deepEqual(failing.state.applied, [{ id: 'b1', status: 'completed' }]);
  assert.equal(lastStatus(failing.state).isErr, true);
});

test('abandon: success refreshes the list and reports it', async () => {
  const { state, actions } = createHarness({
    activeBatch: { id: 'b1', status: 'paused' },
    api: { abandonIntegrateBatch: async () => ({ ok: true, batch: { id: 'b1', status: 'abandoned' } }) },
  });
  await actions.abandon();
  assert.equal(state.refreshes, 1);
  assert.equal(lastStatus(state).msg, 'todo.batchAbandoned');
});

test('clear lock: confirms, calls the api for the scoped folder, drops the lock and refreshes', async () => {
  const folders = [];
  const { state, actions } = createHarness({
    api: { clearIntegrationLock: async (folder) => { folders.push(folder); return { ok: true, cleared: {} }; } },
  });
  await actions.clearLock();
  assert.deepEqual(folders, ['/a']);
  assert.deepEqual(state.confirms, ['todo.lockClearConfirm']);
  assert.deepEqual(state.locks, [null]);
  assert.equal(state.refreshes, 1);
  assert.equal(lastStatus(state).msg, 'todo.lockCleared');
});

test('clear lock: declined confirm makes no request', async () => {
  const { state, actions } = createHarness({
    confirm: () => false,
    api: { clearIntegrationLock: () => assert.fail('no request') },
  });
  await actions.clearLock();
  assert.deepEqual(state.locks, []);
});

test('clear lock: failure keeps the lock; no_lock counts as cleared', async () => {
  const failing = createHarness({ api: { clearIntegrationLock: async () => ({ ok: false, error: 'batch_owned' }) } });
  await failing.actions.clearLock();
  assert.deepEqual(failing.state.locks, []);
  assert.equal(lastStatus(failing.state).isErr, true);
  const gone = createHarness({ api: { clearIntegrationLock: async () => ({ ok: false, error: 'no_lock' }) } });
  await gone.actions.clearLock();
  assert.deepEqual(gone.state.locks, [null]);
});

test('clear lock: answer for A after switching to B is ignored', async () => {
  const slow = deferred();
  const { state, actions, switchTo } = createHarness({ api: { clearIntegrationLock: () => slow.promise } });
  const pending = actions.clearLock();
  switchTo('/b');
  slow.resolve({ ok: true });
  await pending;
  assert.deepEqual(state.locks, []);
  assert.equal(state.refreshes, 0);
});
