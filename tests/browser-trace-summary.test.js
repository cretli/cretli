import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { summarizeTrace, readTraceEvents } from '../lib/browser/trace-summary.js';

const marker = { name: 'cretli-trace-test', pid: 1, tid: 2, ts: 1000, ph: 'R' };
const event = (name, ts, dur, extra = {}) => ({ name, ts, dur, pid: 1, tid: 2, ph: 'X', ...extra });
async function summary(events, options = {}, bare = false) {
  const dir = await mkdtemp(path.join(tmpdir(), 'trace-summary-'));
  try {
    const file = path.join(dir, 'trace.json');
    await writeFile(file, JSON.stringify(bare ? events : { traceEvents: events }));
    return await summarizeTrace(file, 'test', options);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
function fixture(paired = false) {
  const events = [marker,
    event('RunTask', 1000, 60000), event('FunctionCall', 2000, 20000),
    event('UpdateLayoutTree', 3000, 3000), event('Layout', 7000, 2000),
    event('EventDispatch', 10000, 1000, { args: { data: { type: 'slotchange', privateBody: 'PRIVATE_PAGE_BODY' } } }),
    event('Paint', 24000, 1000), event('RunTask', 30000, 1000),
    event('RunTask', 65000, 10000), event('Layout', 66000, 2000),
    event('RunTask', 80000, 1000000, { pid: 9 }), event('RunTask', 80000, 1000000, { tid: 9 }),
    { name: 'Profile', pid: 1, tid: 2, id: 'p', ts: 1000, ph: 'P' },
    { name: 'ProfileChunk', pid: 1, tid: 999, id: 'p', ts: 1000, args: { data: { cpuProfile: { nodes: [{ id: 1, callFrame: { functionName: 'work', url: 'https://example.com/app.js?token=TOP_SECRET', lineNumber: 7 } }], samples: [1, 1] }, timeDeltas: [1000, 2000] } } },
  ];
  if (!paired) return events;
  return events.flatMap((e) => e.ph === 'X' ? [{ ...e, ph: 'B', dur: undefined }, { name: e.name, pid: e.pid, tid: e.tid, ts: e.ts + e.dur, ph: 'E' }] : [e]).sort((a, b) => a.ts - b.ts);
}
for (const paired of [false, true]) test(`all metrics, selected marker thread, nested own time (${paired ? 'B/E' : 'X'})`, async () => {
  const r = await summary(fixture(paired), { conditions: { hidden: true }, warnings: ['hidden'] }, paired);
  assert.equal(r.durationMs, 74);
  assert.equal(r.busyMs, 70);
  assert.equal(r.busyShare, 70 / 74);
  assert.equal(r.tasks, 2); assert.equal(r.longTasks, 1); assert.equal(r.longestTaskMs, 60);
  assert.equal(r.incompleteTasks, 0);
  assert.deepEqual(r.categories, { scriptingMs: 15, renderingMs: 7, paintingMs: 1 });
  assert.deepEqual(r.updateLayoutTree, { count: 1, totalMs: 3 });
  assert.deepEqual(r.layout, { count: 2, totalMs: 4 });
  assert.deepEqual(r.slotchange, { count: 1, totalMs: 1 });
  assert.equal(r.topFunctions[0].selfTimeMs, 3); assert.equal(r.topFunctions[0].line, 7);
  assert.equal(r.conditions.hidden, true); assert.deepEqual(r.warnings, ['hidden']);
  assert.ok(!JSON.stringify(r).includes('PRIVATE_PAGE_BODY'));
  assert.ok(!JSON.stringify(r).includes('TOP_SECRET'));
});
test('marker can follow tasks in file order; incomplete tasks are not busy', async () => {
  const a = await summary(fixture());
  const b = await summary([...fixture().slice(1), marker]);
  assert.deepEqual(a, b);
  const r = await summary([marker, { name: 'RunTask', pid: 1, tid: 2, ts: 1000, ph: 'B' }]);
  assert.equal(r.busyMs, 0); assert.equal(r.incompleteTasks, 1);
  assert.deepEqual(r.topFunctions, []); assert.ok(r.warnings.includes('no-profile-samples'));
});
test('unsupported reasons distinguish absent marker and absent tasks', async () => {
  await assert.rejects(summary([]), { code: 'trace-unsupported', reason: 'no-marker' });
  await assert.rejects(summary([marker]), { code: 'trace-unsupported', reason: 'no-run-task' });
});
test('tokenizer handles tiny chunks, escaping, Unicode and both forms', async () => {
  const original = { name: 'a"}\\[ą😀', args: { array: [1, { value: ']' }] } };
  for (const input of [JSON.stringify([original]), JSON.stringify({ traceEvents: [original] })]) {
    async function* chunks() { for (const c of input) yield c; }
    const found = []; for await (const e of readTraceEvents(chunks())) found.push(e);
    assert.deepEqual(found, [original]);
  }
  await assert.rejects(async () => { for await (const e of readTraceEvents(['[{'])) void e; }, { code: 'trace-invalid' });
});
test('million events use streaming aggregation with one live parsed event', async () => {
  const stats = { maxLiveEvents: 0 };
  const dir = await mkdtemp(path.join(tmpdir(), 'trace-million-'));
  const file = path.join(dir, 'trace.json');
  try {
    const out = await open(file, 'w');
    try {
      await out.writeFile('{"traceEvents":[' + JSON.stringify({ ...marker, ts: 0 }));
      for (let batch = 0; batch < 1000; batch++) {
        let chunk = '';
        for (let i = 0; i < 1000; i++) chunk += ',' + JSON.stringify(event('RunTask', (batch * 1000 + i) * 10, 1));
        await out.writeFile(chunk);
      }
      await out.writeFile(']}');
    } finally { await out.close(); }
    const r = await summarizeTrace(file, 'test', { stats });
    assert.equal(r.tasks, 1000000);
    assert.ok(Math.abs(r.busyMs - 1000) < 0.001);
    assert.equal(stats.maxLiveEvents, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('CPU samples are clipped to the marker window and merged by function location', async () => {
  const profile = { name: 'Profile', pid: 1, tid: 2, id: 'cpu', ts: 0, args: { data: { startTime: 0 } } };
  const callFrame = { functionName: 'sameFunction', url: 'https://example.com/script.js', lineNumber: 3 };
  const chunk = { name: 'ProfileChunk', pid: 1, tid: 888, id: 'cpu', ts: 0, args: { data: { cpuProfile: { nodes: [{ id: 1, callFrame }, { id: 2, callFrame }], samples: [1, 2, 1] }, timeDeltas: [500, 1500, 5000] } } };
  const r = await summary([profile, marker, event('RunTask', 1000, 3000), chunk]);
  assert.equal(r.topFunctions.length, 1); assert.equal(r.topFunctions[0].selfTimeMs, 3);
  assert.deepEqual((await summary(fixture(), { topFunctions: 0 })).topFunctions, []);
  await assert.rejects(summary(fixture(), { topFunctions: 101 }), { code: 'invalid-top-functions' });
});
