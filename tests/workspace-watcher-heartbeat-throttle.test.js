/**
 * Lease-renewal throttle: an idle tick of the lease owner does not rewrite
 * workspace-watchers.json while more than TTL/2 remains, renews the lease after
 * that, persists real state changes immediately and never lets a second token
 * take a live lease.
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import { addTodo } from '../lib/persist/todos-persist.js';
import { getWorkspaceWatcher, upsertWorkspaceWatcher } from '../lib/persist/workspace-watchers-persist.js';
import { getWriteStats } from '../lib/persist/atomic-write.js';
import { tickWorkspaceWatcher } from '../lib/workspace-watcher.js';

const TTL = 30_000;
const dataDir = ISOLATED_DATA_DIR;
const cwd = ISOLATED_DATA_DIR;
const writes = () => getWriteStats().rows.find((r) => r.key === 'workspace-watchers.json')?.writes ?? 0;

try {
  upsertWorkspaceWatcher(cwd, { mode: 'observe' }, { dataDir });
  const t0 = Date.now();
  const tick = (offsetMs, token = 'owner') => tickWorkspaceWatcher({
    workspaceFolder: cwd, dataDir, now: t0 + offsetMs, token, ttlMs: TTL, notify: () => false, notifyDeps: {},
  });

  // First tick acquires the lease (a real change) and records the decision.
  tick(0);
  const afterFirst = writes();
  const lease0 = getWorkspaceWatcher(cwd, { dataDir }).lease;
  assert.equal(lease0.token, 'owner');

  // (i) idle ticks well inside TTL/2 persist nothing.
  for (let i = 1; i <= 10; i += 1) {
    const r = tick(i * 1000);
    assert.equal(r.wrote, false);
  }
  assert.equal(writes(), afterFirst, 'no rewrite for idle ticks inside TTL/2');
  assert.equal(getWorkspaceWatcher(cwd, { dataDir }).lease.expiresAt, lease0.expiresAt);

  // (iv) another token cannot take the live lease while throttling.
  const stolen = tick(11_000, 'intruder');
  assert.equal(stolen.action, 'lease_held');
  assert.equal(getWorkspaceWatcher(cwd, { dataDir }).lease.token, 'owner');

  // (ii) past TTL/2 the lease is renewed with a new expiry.
  const r2 = tick(16_000);
  assert.equal(r2.wrote, true);
  assert.equal(writes(), afterFirst + 1);
  assert.ok(Date.parse(getWorkspaceWatcher(cwd, { dataDir }).lease.expiresAt) > Date.parse(lease0.expiresAt));

  // (iii) a state change persists immediately.
  addTodo(dataDir, cwd, { title: 'Work', status: 'ready' });
  const before = writes();
  const r3 = tick(17_000);
  assert.equal(r3.wrote, true);
  assert.equal(writes(), before + 1);

  // (v) default TTL (90 s) with the real 20 s tick: only every 3rd tick writes the lease.
  const base = 1_000_000;
  const defTick = (offsetMs) => tickWorkspaceWatcher({
    workspaceFolder: cwd, dataDir, now: t0 + base + offsetMs, token: 'owner', notify: () => false, notifyDeps: {},
  });
  assert.equal(defTick(0).wrote, true, 'expired lease is re-acquired');
  const pattern = [20, 40, 60, 80, 100, 120].map((s) => defTick(s * 1000).wrote);
  assert.deepEqual(pattern, [false, false, true, false, false, true]);
  console.log('OK: workspace-watcher-heartbeat-throttle');
} finally {
  removeIsolatedDataDir();
}
