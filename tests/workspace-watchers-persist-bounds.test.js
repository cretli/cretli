import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  WORKSPACE_WATCHER_MAX_AUTOMATIC_INTEGRATIONS,
  getWorkspaceWatcher,
  loadWorkspaceWatchers,
  loadWorkspaceWatchersDocument,
  mutateWorkspaceWatcherRow,
  upsertWorkspaceWatcher,
} from '../lib/persist/workspace-watchers-persist.js';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ww-bounds-'));
}

const DAY = 24 * 60 * 60 * 1000;

test('blockedBackoff: entries expired long before the newest window of the row are pruned on write', () => {
  const dataDir = tmp();
  const folder = '/tmp/ww-bounds-a';
  const iso = (offset) => new Date(Date.now() + offset).toISOString();
  upsertWorkspaceWatcher(folder, {}, { dataDir });
  upsertWorkspaceWatcher(folder, {
    blockedBackoff: {
      old: { count: 3, until: iso(-30 * DAY) },
      recent: { count: 2, until: iso(-60_000) },
      future: { count: 1, until: iso(3_600_000) },
      noUntil: { count: 1, until: '' },
    },
  }, { dataDir });
  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'workspace-watchers.json'), 'utf8'));
  const stored = raw.items[folder].blockedBackoff;
  assert.deepEqual(Object.keys(stored).sort(), ['future', 'noUntil', 'recent']);
  assert.equal(stored.recent.count, 2);
});

test('automaticIntegrations: only the newest entries are kept', () => {
  const dataDir = tmp();
  const folder = '/tmp/ww-bounds-b';
  const total = WORKSPACE_WATCHER_MAX_AUTOMATIC_INTEGRATIONS + 30;
  upsertWorkspaceWatcher(folder, {
    automaticIntegrations: Array.from({ length: total }, (_, i) => ({ todoId: `t${i}`, at: 'x', ok: true })),
  }, { dataDir });
  const row = getWorkspaceWatcher(folder, { dataDir });
  assert.equal(row.automaticIntegrations.length, WORKSPACE_WATCHER_MAX_AUTOMATIC_INTEGRATIONS);
  assert.equal(row.automaticIntegrations.at(-1).todoId, `t${total - 1}`);
});

test('cached reads are isolated copies at document, rows and single-row level', () => {
  const dataDir = tmp();
  const folder = '/tmp/ww-bounds-c';
  upsertWorkspaceWatcher(folder, { stopReason: 'keep' }, { dataDir });
  loadWorkspaceWatchersDocument({ dataDir }); // warm the cache
  const doc = loadWorkspaceWatchersDocument({ dataDir });
  doc.items[folder].stopReason = 'mutated';
  getWorkspaceWatcher(folder, { dataDir }).stopReason = 'mutated-too';
  loadWorkspaceWatchers({ dataDir })[0].stopReason = 'mutated-three';
  assert.equal(getWorkspaceWatcher(folder, { dataDir }).stopReason, 'keep');
  assert.equal(loadWorkspaceWatchersDocument({ dataDir }).items[folder].stopReason, 'keep');
});

test('mutator that edits the row in place does not leak into the cache and still writes', () => {
  const dataDir = tmp();
  const folder = '/tmp/ww-bounds-d';
  upsertWorkspaceWatcher(folder, { stopReason: 'a' }, { dataDir });
  getWorkspaceWatcher(folder, { dataDir });
  const res = mutateWorkspaceWatcherRow(folder, ({ row }) => {
    row.stopReason = 'b';
    return {};
  }, { dataDir });
  assert.equal(res.ok, true);
  assert.equal(getWorkspaceWatcher(folder, { dataDir }).stopReason, 'b');
});

test('CAS via the cache: external change between read and write is detected', () => {
  const dataDir = tmp();
  const folder = '/tmp/ww-bounds-e';
  const file = path.join(dataDir, 'workspace-watchers.json');
  upsertWorkspaceWatcher(folder, {}, { dataDir });
  let injected = false;
  const res = mutateWorkspaceWatcherRow(folder, () => {
    if (!injected) {
      injected = true;
      // Another process bumps the revision after this attempt read the document.
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      raw.revision += 5;
      raw.updatedAt = new Date(Date.now() + 1000).toISOString();
      fs.writeFileSync(file, JSON.stringify(raw));
    }
    return { stopReason: 'cas' };
  }, { dataDir });
  assert.equal(res.ok, true);
  assert.equal(injected, true);
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(stored.items[folder].stopReason, 'cas');
  assert.ok(stored.revision >= 6);
});

test('legacy activeCycle mirror is still written', () => {
  const dataDir = tmp();
  const folder = '/tmp/ww-bounds-f';
  upsertWorkspaceWatcher(folder, {}, { dataDir });
  const row = getWorkspaceWatcher(folder, { dataDir });
  assert.ok('activeCycle' in row);
  assert.ok(Array.isArray(row.activeCycles));
});

test('blockedBackoff: a row with only old windows is left alone (no wall-clock pruning)', () => {
  const dataDir = tmp();
  const folder = '/tmp/ww-bounds-g';
  const old = new Date(Date.now() - 90 * DAY).toISOString();
  upsertWorkspaceWatcher(folder, { blockedBackoff: { a: { count: 1, until: old } } }, { dataDir });
  assert.equal(getWorkspaceWatcher(folder, { dataDir }).blockedBackoff.a.count, 1);
});
