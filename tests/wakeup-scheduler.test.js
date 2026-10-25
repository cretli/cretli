import test from 'node:test';
import assert from 'node:assert/strict';
import { createWakeupScheduler } from '../lib/wakeup-scheduler.js';

/** A fake second kind: no usage-limit, chat or delegation code anywhere. */
function makeHarness({ rows, execute, resolveCrash, maxPerTick = 3, decide, notify } = {}) {
  const store = { rows: rows.map((r) => ({ ...r })) };
  const calls = { execute: [], resolve: [], persistedBeforeExecute: [] };
  const notices = [];
  const kind = {
    kind: 'fake',
    getSettings: () => ({ enabled: true, maxPerTick }),
    normalize: (row) => ({ ...row }),
    selectCandidates: ({ records, now }) => records
      .filter((r) => r.state === 'armed' && r.dueAt <= now)
      .sort((a, b) => a.dueAt - b.dueAt)
      .map((record) => ({ record, dueAt: record.dueAt })),
    prepare: () => ({}),
    decide: decide || (() => ({ action: 'resume', reason: 'due' })),
    execute: async (record) => {
      const stored = store.rows.find((r) => r.id === record.id);
      calls.persistedBeforeExecute.push({ state: stored.state, attempts: stored.attempts, requestId: stored.resumeRequestId });
      calls.execute.push(record.id);
      return execute ? execute(record) : { outcome: 'resumed', reason: '' };
    },
    resolveCrash: async (record) => {
      calls.resolve.push(record.id);
      return resolveCrash ? resolveCrash(record) : { outcome: 'blocked', reason: 'start_uncertain' };
    },
  };
  const scheduler = createWakeupScheduler({
    store: {
      list: () => store.rows.map((r) => ({ ...r })),
      patch: (id, fields, _now, expectState) => {
        const row = store.rows.find((r) => r.id === id);
        if (!row || (expectState && row.state !== expectState)) return null;
        Object.assign(row, fields);
        return { ...row };
      },
    },
    notify: notify || ((n) => notices.push(n)),
  });
  scheduler.registerKind(kind);
  return { scheduler, store, calls, notices };
}

const armed = (id, dueAt, over = {}) => ({
  id, kind: 'fake', state: 'armed', dueAt, attempts: 0, pendingAttempt: 0, resumeRequestId: '', ...over,
});

test('persist-before-call: the row is resuming with a request id when execute runs', async () => {
  const h = makeHarness({ rows: [armed('a', 10)] });
  await h.scheduler.tick({ now: 100 });
  assert.deepEqual(h.calls.persistedBeforeExecute, [{ state: 'resuming', attempts: 1, requestId: 'fake:a:1' }]);
  const row = h.store.rows[0];
  assert.equal(row.state, 'resumed');
  assert.equal(row.attempts, 1);
  assert.equal(row.pendingAttempt, 0);
});

test('nothing runs before the row is due; one execute over two ticks', async () => {
  const h = makeHarness({ rows: [armed('a', 50)] });
  await h.scheduler.tick({ now: 49 });
  assert.equal(h.calls.execute.length, 0);
  await h.scheduler.tick({ now: 50 });
  await h.scheduler.tick({ now: 51 });
  assert.deepEqual(h.calls.execute, ['a']);
});

test('maxPerTick caps resumes and keeps dueAt order', async () => {
  const rows = Array.from({ length: 10 }, (_, i) => armed(`r${i}`, 100 - i));
  const h = makeHarness({ rows, maxPerTick: 3 });
  const out = await h.scheduler.tick({ now: 1000 });
  assert.equal(out.resumed, 3);
  assert.deepEqual(h.calls.execute, ['r9', 'r8', 'r7']);
});

test('defer/skip write nothing and do not count against maxPerTick', async () => {
  const decide = ({ record }) => (record.id === 'x' ? { action: 'defer', reason: 'later' } : { action: 'resume', reason: 'due' });
  const h = makeHarness({ rows: [armed('x', 1), armed('y', 2)], maxPerTick: 1, decide });
  await h.scheduler.tick({ now: 10 });
  assert.deepEqual(h.calls.execute, ['y']);
  const x = h.store.rows.find((r) => r.id === 'x');
  assert.equal(x.state, 'armed');
  assert.equal(x.attempts, 0);
});

test('terminal decisions persist the state and reason without executing', async () => {
  const h = makeHarness({
    rows: [armed('b', 1), armed('e', 2), armed('c', 3)],
    decide: ({ record }) => ({ b: { action: 'block', reason: 'gate' }, e: { action: 'expire', reason: 'late' }, c: { action: 'cancel', reason: 'moved' } })[record.id],
  });
  await h.scheduler.tick({ now: 10 });
  assert.equal(h.calls.execute.length, 0);
  assert.deepEqual(h.store.rows.map((r) => [r.state, r.reason]), [['blocked', 'gate'], ['expired', 'late'], ['cancelled', 'moved']]);
  assert.equal(h.notices.length, 3);
});

test('outcome classification: refund restores armed, blocked is terminal, ambiguous stays resuming', async () => {
  const outcomes = { a: { outcome: 'refund', reason: 'busy' }, b: { outcome: 'blocked', reason: 'start_failed' }, c: { outcome: 'ambiguous', reason: 'timeout' } };
  const h = makeHarness({ rows: [armed('a', 1), armed('b', 2), armed('c', 3)], execute: (r) => outcomes[r.id] });
  await h.scheduler.tick({ now: 10 });
  const by = Object.fromEntries(h.store.rows.map((r) => [r.id, r]));
  assert.equal(by.a.state, 'armed');
  assert.equal(by.a.attempts, 0);
  assert.equal(by.a.pendingAttempt, 0);
  assert.equal(by.b.state, 'blocked');
  assert.equal(by.b.reason, 'start_failed');
  assert.equal(by.c.state, 'resuming');
  assert.equal(by.c.pendingAttempt, 1);
});

test('a throwing execute is ambiguous, never refunded or re-sent', async () => {
  const h = makeHarness({ rows: [armed('a', 1)], execute: () => { throw new Error('socket hang up'); } });
  await h.scheduler.tick({ now: 10 });
  assert.equal(h.store.rows[0].state, 'resuming');
  await h.scheduler.tick({ now: 20 });
  assert.equal(h.calls.execute.length, 1);
  assert.deepEqual(h.calls.resolve, ['a']);
});

test('crash resolution dispatch: resumed / refund / blocked, then no re-send in the same tick', async () => {
  const resolutions = { a: { outcome: 'resumed' }, b: { outcome: 'refund', reason: 'x' }, c: { outcome: 'blocked', reason: 'start_uncertain' } };
  const resuming = (id) => armed(id, 1, { state: 'resuming', attempts: 1, pendingAttempt: 1, resumeRequestId: `fake:${id}:1` });
  const h = makeHarness({ rows: [resuming('a'), resuming('b'), resuming('c')], resolveCrash: (r) => resolutions[r.id] });
  await h.scheduler.tick({ now: 100 });
  const by = Object.fromEntries(h.store.rows.map((r) => [r.id, r]));
  assert.equal(by.a.state, 'resumed');
  assert.equal(by.a.attempts, 1);
  assert.equal(by.b.state, 'armed');
  assert.equal(by.b.attempts, 0);
  assert.equal(by.c.state, 'blocked');
  assert.equal(by.c.reason, 'start_uncertain');
  assert.equal(h.calls.execute.length, 0, 'a refunded row waits for the next tick');
  await h.scheduler.tick({ now: 200 });
  assert.deepEqual(h.calls.execute, ['b']);
});

test('a resolveCrash that throws leaves the row resuming', async () => {
  const h = makeHarness({
    rows: [armed('a', 1, { state: 'resuming', attempts: 1, pendingAttempt: 1 })],
    resolveCrash: () => { throw new Error('boom'); },
  });
  await h.scheduler.tick({ now: 10 });
  assert.equal(h.store.rows[0].state, 'resuming');
});

test('rows of an unregistered kind are untouched', async () => {
  const h = makeHarness({ rows: [armed('a', 1, { kind: 'other' })] });
  await h.scheduler.tick({ now: 10 });
  assert.equal(h.store.rows[0].state, 'armed');
  assert.equal(h.calls.execute.length, 0);
});

test('a failing notify hook never breaks the tick', async () => {
  const h = makeHarness({ rows: [armed('a', 1)], notify: () => { throw new Error('nope'); } });
  await h.scheduler.tick({ now: 5 });
  assert.equal(h.store.rows[0].state, 'resumed');
});

test('start/stop uses an unref-ed interval and stop is idempotent', () => {
  const scheduler = createWakeupScheduler({ store: { list: () => [], patch: () => null } });
  scheduler.start({ intervalMs: 3_600_000 });
  scheduler.stop();
  scheduler.stop();
});

test('F3: a row cancelled while an earlier candidate executes is not resurrected', async () => {
  let h;
  h = makeHarness({
    rows: [armed('a', 1), armed('b', 2)],
    execute: (record) => {
      if (record.id === 'a') Object.assign(h.store.rows.find((r) => r.id === 'b'), { state: 'cancelled', reason: 'user' });
      return { outcome: 'resumed', reason: '' };
    },
  });
  const result = await h.scheduler.tick({ now: 100 });
  assert.deepEqual(h.calls.execute, ['a']);
  assert.equal(result.resumed, 1);
  assert.deepEqual([h.store.rows[1].state, h.store.rows[1].attempts], ['cancelled', 0]);
});

test('F4: maxPerTick is counted per kind', async () => {
  const h = makeHarness({ rows: [armed('a', 1), armed('b', 2), { ...armed('c', 1), kind: 'other' }], maxPerTick: 1 });
  const other = [];
  h.scheduler.registerKind({
    kind: 'other',
    getSettings: () => ({ maxPerTick: 1 }),
    normalize: (row) => ({ ...row }),
    selectCandidates: ({ records }) => records.filter((r) => r.state === 'armed').map((record) => ({ record, dueAt: 1 })),
    prepare: () => ({}),
    decide: () => ({ action: 'resume', reason: '' }),
    execute: async (record) => { other.push(record.id); return { outcome: 'resumed', reason: '' }; },
    resolveCrash: async () => ({ outcome: 'blocked', reason: 'x' }),
  });
  const result = await h.scheduler.tick({ now: 100 });
  assert.deepEqual(h.calls.execute, ['a']);
  assert.deepEqual(other, ['c']);
  assert.equal(result.resumed, 2);
});

test('getStatus: lastTickAt follows the injected clock; start/stop drive running and tickMs', async () => {
  let nowMs = Date.parse('2026-03-01T10:00:00Z');
  const scheduler = createWakeupScheduler({
    store: { list: () => [], patch: () => null },
    now: () => nowMs,
  });
  scheduler.registerKind({
    kind: 'fake',
    getSettings: () => ({ enabled: true, maxPerTick: 4 }),
    normalize: (row) => row,
    selectCandidates: () => [],
  });
  assert.deepEqual(scheduler.getStatus(), {
    running: false, tickMs: 60_000, lastTickAt: null, kinds: [{ kind: 'fake', maxPerTick: 4 }],
  });
  await scheduler.tick();
  assert.equal(scheduler.getStatus().lastTickAt, '2026-03-01T10:00:00.000Z');
  nowMs += 60_000;
  await scheduler.tick();
  assert.equal(scheduler.getStatus().lastTickAt, '2026-03-01T10:01:00.000Z');
  scheduler.start({ intervalMs: 5_000 });
  try {
    assert.equal(scheduler.getStatus().running, true);
    assert.equal(scheduler.getStatus().tickMs, 5_000);
  } finally {
    scheduler.stop();
  }
  assert.equal(scheduler.getStatus().running, false);
  assert.equal(scheduler.getStatus().lastTickAt, null, 'stopped scheduler reports no last tick');
});

test('describeRow: kind hook value, null without a hook, null when the hook throws', () => {
  const scheduler = createWakeupScheduler({ store: { list: () => [], patch: () => null } });
  const base = { getSettings: () => ({}), normalize: (row) => row, selectCandidates: () => [] };
  scheduler.registerKind({ ...base, kind: 'with', describeRow: () => ({ dueAt: '2026-01-01T00:00:00.000Z' }) });
  scheduler.registerKind({ ...base, kind: 'without' });
  scheduler.registerKind({ ...base, kind: 'broken', describeRow: () => { throw new Error('boom'); } });
  assert.equal(scheduler.describeRow({ kind: 'with' }).dueAt, '2026-01-01T00:00:00.000Z');
  assert.equal(scheduler.describeRow({ kind: 'without' }).dueAt, null);
  assert.equal(scheduler.describeRow({ kind: 'broken' }).dueAt, null);
  assert.equal(scheduler.describeRow({ kind: 'unregistered' }).dueAt, null);
});

test('getStatus: maxPerTick mirrors the tick derivation and survives a throwing getSettings', () => {
  const scheduler = createWakeupScheduler({ store: { list: () => [], patch: () => null } });
  const base = { normalize: (row) => row, selectCandidates: () => [] };
  scheduler.registerKind({ ...base, kind: 'zero', getSettings: () => ({ maxPerTick: 0 }) });
  scheduler.registerKind({ ...base, kind: 'junk', getSettings: () => ({ maxPerTick: 'x' }) });
  scheduler.registerKind({ ...base, kind: 'seven', getSettings: () => ({ maxPerTick: 7 }) });
  scheduler.registerKind({ ...base, kind: 'broken', getSettings: () => { throw new Error('boom'); } });
  assert.deepEqual(scheduler.getStatus().kinds, [
    { kind: 'zero', maxPerTick: 1 }, { kind: 'junk', maxPerTick: 1 },
    { kind: 'seven', maxPerTick: 7 }, { kind: 'broken', maxPerTick: 1 },
  ]);
});
