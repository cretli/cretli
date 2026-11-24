import test from 'node:test';
import assert from 'node:assert/strict';
import { statusBadge, runBadge, canRun, comparisonRows, crossDeviceRows, groupRunsByScript, scriptChoices } from '../app_front/features/devices/deviceViewModel.js';

test('probe statuses map to badges; unknown stays neutral', () => {
  assert.deepEqual(statusBadge('reachable'), { key: 'devices.status.reachable', tone: 'success' });
  assert.equal(statusBadge('asleep').key, 'devices.status.asleep');
  assert.equal(statusBadge('chrome-down').key, 'devices.status.chromeDown');
  assert.equal(statusBadge('adb-missing').tone, 'error');
  assert.deepEqual(statusBadge('weird'), { key: 'devices.status.unknown', tone: '' });
  assert.equal(runBadge('awaiting-consent').key, 'devices.run.awaitingConsent');
  assert.equal(runBadge('failed').tone, 'error');
  assert.equal(canRun('reachable'), true);
  assert.equal(canRun('asleep'), false);
});

test('comparison rows keep missing values distinct from zero', () => {
  const rows = comparisonRows({ deltas: {
    zeta: { before: 0, after: 0, delta: 0 },
    alpha: { before: 10, after: null, delta: null },
    beta: { before: 4, after: 6, delta: 2 },
  } });
  assert.deepEqual(rows.map((r) => r.metric), ['alpha', 'beta', 'zeta']);
  assert.deepEqual(rows[0], { metric: 'alpha', before: 10, after: null, delta: null, missing: true });
  assert.deepEqual(rows[1], { metric: 'beta', before: 4, after: 6, delta: 2, missing: false });
  assert.deepEqual(rows[2], { metric: 'zeta', before: 0, after: 0, delta: 0, missing: false });
  assert.deepEqual(comparisonRows(null), []);
});

test('cross-device rows never turn a failed run into a zero baseline', () => {
  const x = crossDeviceRows([
    { id: 'a', deviceName: 'my-phone', status: 'success', metrics: { load: 0, fps: 60 } },
    { id: 'b', deviceName: 'your-pc', status: 'failed', metrics: { load: 5 } },
    { id: 'c', deviceName: 'tablet', status: 'success', metrics: { fps: 30 } },
  ]);
  assert.deepEqual(x.columns.map((c) => c.name), ['my-phone', 'your-pc', 'tablet']);
  assert.deepEqual(x.rows, [
    { metric: 'fps', values: [60, null, 30] },
    { metric: 'load', values: [0, null, null] },
  ]);
});

test('runs group by script and script choices keep folders and runnable files only', () => {
  const groups = groupRunsByScript([{ scriptPath: '/a.mjs', id: 1 }, { scriptPath: '/b.mjs', id: 2 }, { scriptPath: '/a.mjs', id: 3 }]);
  assert.deepEqual(groups.map((g) => [g.scriptPath, g.runs.length]), [['/a.mjs', 2], ['/b.mjs', 1]]);
  const names = scriptChoices([{ name: 'src', isDir: true }, { name: 'a.mjs' }, { name: 'b.txt' }, { name: 'c.cjs' }]).map((e) => e.name);
  assert.deepEqual(names, ['src', 'a.mjs', 'c.cjs']);
});

import { latestPerDevice } from '../app_front/features/devices/deviceViewModel.js';
import { startRunsOnTargets } from '../app_front/features/devices/deviceRunActions.js';

test('latestPerDevice keeps the newest successful run whatever the input order', () => {
  const runs = [
    { id: 'new', deviceId: 'a', startedAt: '2026-01-03T00:00:00Z' },
    { id: 'old', deviceId: 'a', startedAt: '2026-01-01T00:00:00Z' },
    { id: 'b1', deviceId: 'b', startedAt: '2026-01-02T00:00:00Z' },
  ];
  assert.deepEqual(latestPerDevice(runs).map((r) => r.id).sort(), ['b1', 'new']);
  assert.deepEqual(latestPerDevice([...runs].reverse()).map((r) => r.id).sort(), ['b1', 'new']);
});

test('a workspace switch during a multi-device start cancels the remaining starts', async () => {
  let epoch = 1;
  const calls = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const api = { async startRun(id, input) { calls.push([id, input.scriptPath]); if (id === 'd1') await gate; } };
  const pending = startRunsOnTargets({ api, targets: [{ id: 'd1', name: 'my-phone' }, { id: 'd2', name: 'your-pc' }], scriptPath: 'perf.mjs', getEpoch: () => epoch, epoch: 1 });
  epoch = 2; // workspace switched while the first start is still in flight
  release();
  const out = await pending;
  assert.equal(out.aborted, true);
  assert.deepEqual(calls, [['d1', 'perf.mjs']]);
  const same = await startRunsOnTargets({ api: { startRun: async () => { throw Object.assign(new Error('x'), { code: 'boom' }); } }, targets: [{ id: 'd3', name: 'n' }], scriptPath: 's.mjs', getEpoch: () => 5, epoch: 5 });
  assert.deepEqual(same, { aborted: false, started: [], errors: [{ device: 'n', code: 'boom' }] });
});
