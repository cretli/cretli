import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyWorkspaceWatcherPatch,
  getWorkspaceWatcherView,
  invalidateWorkspaceWatcherViewCache,
} from '../lib/workspace-watcher-control.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-view-cache-'));
const workspaceFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-view-ws-'));
try {
  const a = await getWorkspaceWatcherView({ dataDir, workspaceFolder });
  const b = await getWorkspaceWatcherView({ dataDir, workspaceFolder });
  assert.deepEqual(Object.keys(a), Object.keys(b));
  assert.notEqual(a, b, 'reads return isolated copies');
  assert.equal(a.watcher.mode, b.watcher.mode);

  // Mutating a returned view must not poison the cache.
  a.watcher.mode = 'tampered';
  assert.notEqual((await getWorkspaceWatcherView({ dataDir, workspaceFolder })).watcher.mode, 'tampered');

  // A watcher row change invalidates immediately (no TTL wait).
  applyWorkspaceWatcherPatch({ dataDir, workspaceFolder, patch: { mode: 'observe' } });
  assert.equal((await getWorkspaceWatcherView({ dataDir, workspaceFolder })).watcher.mode, 'observe');
  applyWorkspaceWatcherPatch({ dataDir, workspaceFolder, patch: { mode: 'off' } });
  assert.equal((await getWorkspaceWatcherView({ dataDir, workspaceFolder })).watcher.mode, 'off');

  // Warm reads are far cheaper than a recompute.
  invalidateWorkspaceWatcherViewCache();
  await getWorkspaceWatcherView({ dataDir, workspaceFolder });
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 20; i += 1) await getWorkspaceWatcherView({ dataDir, workspaceFolder });
  assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 / 20 < 100);
  console.log('workspace-watcher-view-cache ok');
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(workspaceFolder, { recursive: true, force: true });
}
