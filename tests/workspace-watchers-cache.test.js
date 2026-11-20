import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadWorkspaceWatchersDocument,
  invalidateWorkspaceWatchersCache,
  mutateWorkspaceWatchersDocument,
} from '../lib/persist/workspace-watchers-persist.js';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ww-cache-'));
}

test('watchers document cache: hit returns an isolated copy', () => {
  const dataDir = tmp();
  const a = loadWorkspaceWatchersDocument({ dataDir });
  a.items.junk = { x: 1 };
  const b = loadWorkspaceWatchersDocument({ dataDir });
  assert.equal(b.items.junk, undefined);
  fs.writeFileSync(path.join(dataDir, 'workspace-watchers.json'), JSON.stringify({ v: 2, revision: 3, updatedAt: 'x', items: {} }));
  const c = loadWorkspaceWatchersDocument({ dataDir });
  assert.equal(c.revision, 3);
  const d = loadWorkspaceWatchersDocument({ dataDir });
  d.revision = 99;
  assert.equal(loadWorkspaceWatchersDocument({ dataDir }).revision, 3);
});

test('watchers document cache: in-process write invalidates, external change detected', () => {
  const dataDir = tmp();
  const file = path.join(dataDir, 'workspace-watchers.json');
  fs.writeFileSync(file, JSON.stringify({ v: 2, revision: 1, updatedAt: 'a', items: {} }));
  assert.equal(loadWorkspaceWatchersDocument({ dataDir }).revision, 1);
  const res = mutateWorkspaceWatchersDocument((doc) => ({ items: doc.items }), { dataDir });
  assert.equal(res.ok, true);
  const after = loadWorkspaceWatchersDocument({ dataDir });
  assert.equal(after.revision, JSON.parse(fs.readFileSync(file, 'utf8')).revision);
  fs.writeFileSync(file, JSON.stringify({ v: 2, revision: 50, updatedAt: 'b', items: {} }));
  assert.equal(loadWorkspaceWatchersDocument({ dataDir }).revision, 50);
  invalidateWorkspaceWatchersCache({ dataDir });
  assert.equal(loadWorkspaceWatchersDocument({ dataDir }).revision, 50);
});
