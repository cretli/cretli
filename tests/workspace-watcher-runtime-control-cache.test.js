import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tempDir } from './helpers/temp-git-repo.js';
import {
  areWorkspaceWatcherStartsEnabled,
  getWorkspaceWatcherRuntimeControl,
  setWorkspaceWatcherStartsEnabled,
} from '../lib/workspace-watcher-runtime-control.js';

test('runtime control cache follows set, external rewrite and damage', (t) => {
  const dataDir = tempDir('cretli-rt-control-');
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const file = path.join(dataDir, 'workspace-watcher-runtime.json');

  assert.equal(areWorkspaceWatcherStartsEnabled({ dataDir }), true);
  assert.equal(areWorkspaceWatcherStartsEnabled({ dataDir }), true);

  setWorkspaceWatcherStartsEnabled({ dataDir, startsEnabled: false });
  assert.equal(areWorkspaceWatcherStartsEnabled({ dataDir }), false);
  setWorkspaceWatcherStartsEnabled({ dataDir, startsEnabled: true });
  assert.equal(areWorkspaceWatcherStartsEnabled({ dataDir }), true);

  // Callers cannot mutate the cached record.
  getWorkspaceWatcherRuntimeControl({ dataDir }).startsEnabled = false;
  assert.equal(getWorkspaceWatcherRuntimeControl({ dataDir }).startsEnabled, true);

  fs.writeFileSync(file, JSON.stringify({ startsEnabled: false, updatedAt: 'x-externally' }));
  const external = getWorkspaceWatcherRuntimeControl({ dataDir });
  assert.equal(external.startsEnabled, false);
  assert.equal(external.updatedAt, 'x-externally');

  fs.writeFileSync(file, '{not json at all');
  const damaged = getWorkspaceWatcherRuntimeControl({ dataDir });
  assert.equal(damaged.startsEnabled, false);
  assert.equal(damaged.controlError, true);
  assert.equal(areWorkspaceWatcherStartsEnabled({ dataDir }), false);

  setWorkspaceWatcherStartsEnabled({ dataDir, startsEnabled: true });
  assert.equal(getWorkspaceWatcherRuntimeControl({ dataDir }).controlError, false);
  assert.equal(areWorkspaceWatcherStartsEnabled({ dataDir }), true);
});
