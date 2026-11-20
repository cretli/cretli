import assert from 'node:assert/strict';
import test from 'node:test';
import { Signal } from '@lit-labs/signals';
import { createTodoListState } from '../app_front/state/todoListState.js';
import { subscribe } from '../app_front/state/sharedState.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

test('collapse toggles immutably and reports the new state', () => {
  const s = createTodoListState();
  const before = s.collapsed.get();
  assert.equal(s.toggleCollapsed('a'), true);
  assert.notEqual(s.collapsed.get(), before);
  assert.deepEqual([...s.collapsed.get()], ['a']);
  assert.equal(s.toggleCollapsed('a'), false);
  assert.equal(s.collapsed.get().size, 0);
});

test('addCollapsed is a no-op for an already collapsed branch', () => {
  const s = createTodoListState();
  assert.equal(s.addCollapsed('a'), true);
  const ref = s.collapsed.get();
  assert.equal(s.addCollapsed('a'), false);
  assert.equal(s.collapsed.get(), ref);
});

test('batch selection add/remove/toggle/clear', () => {
  const s = createTodoListState();
  s.setBatchChecked('x', true);
  s.toggleBatchSelected('y');
  assert.deepEqual([...s.batchSelected.get()].sort(), ['x', 'y']);
  assert.equal(s.setBatchChecked('x', true), false);
  s.setBatchChecked('x', false);
  assert.deepEqual([...s.batchSelected.get()], ['y']);
  s.clearBatchSelected();
  assert.equal(s.batchSelected.get().size, 0);
});

test('filters: defaults, root status null, review normalisation, integration checks', () => {
  const s = createTodoListState({ integrationDefault: ['awaiting', 'unconfirmed'] });
  assert.deepEqual([...s.integration.get()].sort(), ['awaiting', 'unconfirmed']);
  assert.equal(s.rootStatus.get(), null);
  s.setRootStatus(['done']);
  assert.deepEqual([...s.rootStatus.get()], ['done']);
  s.setRootStatus(null);
  assert.equal(s.rootStatus.get(), null);
  s.setReview('stale');
  assert.equal(s.review.get(), 'stale');
  s.setReview('bogus');
  assert.equal(s.review.get(), '');
  s.setIntegrationChecked('conflict', true);
  assert.ok(s.integration.get().has('conflict'));
  s.setIntegrationChecked('conflict', false);
  assert.ok(!s.integration.get().has('conflict'));
});

test('subscribers fire once per real change, not for no-ops', async () => {
  const s = createTodoListState();
  let calls = 0;
  const off = subscribe(s.collapsed, () => { calls += 1; });
  await tick();
  s.toggleCollapsed('a');
  await tick();
  assert.equal(calls, 1);
  s.addCollapsed('a');
  await tick();
  assert.equal(calls, 1);
  off();
  assert.ok(Signal);
});

test('perf probe records steps and tolerates a missing performance API', async () => {
  const { probeSync, getPerfProbeEntries, resetPerfProbe } = await import('../app_front/lib/perfProbe.js');
  resetPerfProbe();
  assert.equal(probeSync('x', () => 7), 7);
  probeSync('x', () => {});
  assert.throws(() => probeSync('y', () => { throw new Error('boom'); }), /boom/);
  const byName = Object.fromEntries(getPerfProbeEntries().map((e) => [e.name, e]));
  assert.equal(byName.x.count, 2);
  assert.equal(byName.y.count, 1);
  const saved = globalThis.performance;
  Object.defineProperty(globalThis, 'performance', { value: undefined, configurable: true });
  try {
    assert.equal(probeSync('z', () => 1), 1);
  } finally {
    Object.defineProperty(globalThis, 'performance', { value: saved, configurable: true });
  }
  resetPerfProbe();
});

test('perf probe measures only low-frequency steps, caps them and clears on reset', async () => {
  const { probeSync, resetPerfProbe, MAX_PERF_MEASURES } = await import('../app_front/lib/perfProbe.js');
  const measured = [];
  const cleared = [];
  const saved = globalThis.performance;
  Object.defineProperty(globalThis, 'performance', {
    configurable: true,
    value: {
      now: () => Date.now(),
      measure: (name) => measured.push(name),
      clearMeasures: (name) => cleared.push(name),
    },
  });
  try {
    resetPerfProbe();
    cleared.length = 0;
    for (let i = 0; i < 300; i++) probeSync('todo.paintRow', () => {});
    probeSync('todo.state.setCollapsed', () => {});
    assert.equal(measured.length, 0);
    probeSync('todo.renderList', () => {});
    assert.deepEqual(measured, ['cretli:todo.renderList']);
    for (let i = 0; i < MAX_PERF_MEASURES + 50; i++) probeSync('todo.fetch', () => {});
    assert.equal(measured.length, MAX_PERF_MEASURES);
    resetPerfProbe();
    assert.ok(cleared.includes('cretli:todo.renderList'));
    probeSync('todo.fetch', () => {});
    assert.equal(measured.length, MAX_PERF_MEASURES + 1);
  } finally {
    Object.defineProperty(globalThis, 'performance', { value: saved, configurable: true });
    resetPerfProbe();
  }
});

test('chat switch history probes are registered for the DevTools timeline', async () => {
  const { probeSync, probeStart, probeEnd, getPerfProbeEntries, resetPerfProbe } = await import('../app_front/lib/perfProbe.js');
  resetPerfProbe();
  probeSync('chat.history.markdown', () => 1);
  probeEnd(probeStart('chat.history.fetch'));
  const names = getPerfProbeEntries().map((e) => e.name);
  assert.ok(names.includes('chat.history.markdown'));
  assert.ok(names.includes('chat.history.fetch'));
  resetPerfProbe();
});
