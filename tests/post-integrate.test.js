import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPostIntegrator, decidePostIntegration } from '../lib/integration/post-integrate.js';
import { getWorkspaceWatcherRuntimeControl } from '../lib/workspace-watcher-runtime-control.js';
import {
  blockNewStarts,
  releasePostIntegrateBlockIfOwned,
  unblockNewStarts,
} from '../lib/workspace-watcher-runtime.js';
import { setWorkspaceWatcherStartsEnabled } from '../lib/workspace-watcher-runtime-control.js';
import { normalizeWorkspaceWatcherPolicy } from '../lib/persist/workspace-watchers-persist.js';

const on = { autoRestart: true };

test('policy off: nothing to do', () => {
  const d = decidePostIntegration({ policy: {}, changedPaths: ['lib/a.js', 'app_front/b.js'], activeCycles: 0 });
  assert.deepEqual(d, { rebuildFront: false, restart: false, wait: false, timeout: false, reason: 'auto_restart_disabled' });
});

test('front only rebuilds, no restart', () => {
  const d = decidePostIntegration({ policy: on, changedPaths: ['app_front/x.js'], activeCycles: 3 });
  assert.equal(d.rebuildFront, true);
  assert.equal(d.restart, false);
  assert.equal(d.wait, false);
});

test('lib change: waits while cycles active, restarts when idle, times out at limit', () => {
  const base = { policy: on, changedPaths: ['lib/x.js'], limitMs: 1000 };
  assert.equal(decidePostIntegration({ ...base, activeCycles: 2, elapsedMs: 10 }).wait, true);
  assert.equal(decidePostIntegration({ ...base, activeCycles: 0, elapsedMs: 10 }).restart, true);
  const t = decidePostIntegration({ ...base, activeCycles: 2, elapsedMs: 1000 });
  assert.equal(t.timeout, true);
  assert.equal(t.restart, false);
});

test('docs-only change does nothing', () => {
  const d = decidePostIntegration({ policy: on, changedPaths: ['docs/a.md'], activeCycles: 0 });
  assert.equal(d.rebuildFront || d.restart || d.wait, false);
});

function harness(policy, counts, execImpl) {
  const calls = [];
  let t = 0;
  const integ = createPostIntegrator({
    getPolicy: () => policy,
    exec: async (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      return execImpl ? execImpl(cmd) : { ok: true };
    },
    runtime: {
      block: () => calls.push('block'),
      unblock: () => calls.push('unblock'),
      activeCycles: () => (typeof counts === 'function' ? counts() : { count: counts.length ? counts.shift() : 0 }),
    },
    now: () => t,
    sleep: async (ms) => { t += ms; },
    limitMs: 20000,
    pollMs: 5000,
  });
  return { integ, calls };
}

test('batching: several integrations yield one build and one restart', async () => {
  const { integ, calls } = harness(on, [2, 1, 0]);
  integ.record(['lib/a.js']);
  integ.record(['app_front/b.js', 'lib/c.js']);
  const r = await integ.flush();
  assert.deepEqual(calls, ['npm run build:front', 'block', 'bash scripts/task-restart-server.sh']);
  assert.equal(r.restarted, true);
  assert.equal(r.rebuilt, true);
});

test('timeout: no restart, unblocked, reason reported', async () => {
  const { integ, calls } = harness(on, new Array(50).fill(1));
  integ.record(['lib/a.js']);
  const r = await integ.flush();
  assert.equal(r.restarted, false);
  assert.equal(r.reason, 'restart_wait_timeout');
  assert.deepEqual(calls, ['block', 'unblock']);
});

test('policy off is side-effect free', async () => {
  const { integ, calls } = harness({ autoRestart: false }, []);
  assert.equal(integ.record(['lib/a.js']), false);
  await integ.flush();
  assert.deepEqual(calls, []);
});

test('block/unblock helper toggles the durable gate; policy default is off', () => {
  assert.deepEqual(blockNewStarts(), { owned: true });
  assert.equal(getWorkspaceWatcherRuntimeControl().startsEnabled, false);
  unblockNewStarts();
  assert.equal(getWorkspaceWatcherRuntimeControl().startsEnabled, true);
  assert.equal(normalizeWorkspaceWatcherPolicy({}).autoRestart, false);
  assert.equal(normalizeWorkspaceWatcherPolicy({ autoRestart: true }).autoRestart, true);
});

test('restart exec returns ok:false: restart_failed and unblocked', async () => {
  const { integ, calls } = harness(on, [0], async () => ({ ok: false }));
  integ.record(['lib/a.js']);
  const r = await integ.flush();
  assert.equal(r.restarted, false);
  assert.equal(r.reason, 'restart_failed');
  assert.equal(calls.at(-1), 'unblock');
});

test('restart exec throws: unblocked and error propagates', async () => {
  const { integ, calls } = harness(on, [0], async () => { throw new Error('boom'); });
  integ.record(['lib/a.js']);
  await assert.rejects(integ.flush(), /boom/);
  assert.equal(calls.at(-1), 'unblock');
});

test('unavailable count is treated as active: waits then times out', async () => {
  const { integ, calls } = harness(on, () => ({ count: 0, unavailable: true }));
  integ.record(['lib/a.js']);
  const r = await integ.flush();
  assert.equal(r.reason, 'restart_wait_timeout');
  assert.equal(r.restarted, false);
  assert.deepEqual(calls, ['block', 'unblock']);
});

test('operator block is preserved; release only when owned', () => {
  setWorkspaceWatcherStartsEnabled({ startsEnabled: false });
  assert.deepEqual(blockNewStarts(), { owned: false });
  assert.deepEqual(releasePostIntegrateBlockIfOwned(), { released: false });
  assert.equal(getWorkspaceWatcherRuntimeControl().startsEnabled, false);
  setWorkspaceWatcherStartsEnabled({ startsEnabled: true });
  assert.deepEqual(blockNewStarts(), { owned: true });
  // Simulates boot after the restart script killed the owning process.
  assert.deepEqual(releasePostIntegrateBlockIfOwned(), { released: true });
  assert.equal(getWorkspaceWatcherRuntimeControl().startsEnabled, true);
  assert.deepEqual(releasePostIntegrateBlockIfOwned(), { released: false });
});

test('F2: paths recorded during a flush get their own follow-up pass', async () => {
  const calls = [];
  let integ;
  const first = { once: true };
  integ = createPostIntegrator({
    getPolicy: () => on,
    exec: async (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      if (first.once) { first.once = false; integ.record(['app_front/late.js']); }
      return { ok: true };
    },
    runtime: { block: () => {}, unblock: () => {}, activeCycles: () => ({ count: 0 }) },
    now: () => 0, sleep: async () => {},
  });
  integ.record(['app_front/a.js']);
  await integ.flush();
  assert.deepEqual(calls, ['npm run build:front', 'npm run build:front']);
  assert.deepEqual(integ.pendingPaths(), []);
});

test('F1: boot never releases an operator block that replaced ours', async () => {
  assert.deepEqual(blockNewStarts(), { owned: true });
  // Operator re-blocks within the same millisecond: identical updatedAt.
  const RealDate = Date;
  const frozen = new RealDate(getWorkspaceWatcherRuntimeControl().updatedAt).getTime();
  globalThis.Date = class extends RealDate {
    constructor(...a) { super(...(a.length ? a : [frozen])); }
    static now() { return frozen; }
  };
  try { setWorkspaceWatcherStartsEnabled({ startsEnabled: false }); } finally { globalThis.Date = RealDate; }
  assert.deepEqual(releasePostIntegrateBlockIfOwned(), { released: false });
  assert.equal(getWorkspaceWatcherRuntimeControl().startsEnabled, false);
  assert.deepEqual(releasePostIntegrateBlockIfOwned(), { released: false });
  setWorkspaceWatcherStartsEnabled({ startsEnabled: true });
});

test('F3: marker write failure reopens our gate and rethrows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-f3-'));
  try {
    // A directory at the marker path makes the atomic marker write fail.
    fs.mkdirSync(path.join(dir, 'workspace-watcher-runtime-owner.json'));
    assert.throws(() => blockNewStarts({ dataDir: dir }));
    assert.equal(getWorkspaceWatcherRuntimeControl({ dataDir: dir }).startsEnabled, true);
    assert.deepEqual(releasePostIntegrateBlockIfOwned({ dataDir: dir }), { released: false });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F3: throwing block() means no restart, no stuck gate, error surfaced', async () => {
  const calls = [];
  const integ = createPostIntegrator({
    getPolicy: () => on,
    exec: async (cmd) => { calls.push(cmd); return { ok: true }; },
    runtime: {
      block: () => { calls.push('block'); throw new Error('marker boom'); },
      unblock: () => calls.push('unblock'),
      activeCycles: () => ({ count: 0 }),
    },
    now: () => 0, sleep: async () => {},
  });
  integ.record(['lib/a.js']);
  const r = await integ.flush();
  assert.equal(r.restarted, false);
  assert.equal(r.reason, 'block_failed');
  assert.equal(r.blockError, 'marker boom');
  assert.deepEqual(calls, ['block', 'unblock']);
});
