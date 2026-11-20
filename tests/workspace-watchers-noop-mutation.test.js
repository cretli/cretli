import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadWorkspaceWatchersDocument,
  mutateWorkspaceWatcherRow,
  upsertWorkspaceWatcher,
} from '../lib/persist/workspace-watchers-persist.js';
import { getWriteStats } from '../lib/persist/atomic-write.js';

function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-noop-'));
  return {
    dataDir,
    file: path.join(dataDir, 'workspace-watchers.json'),
    workspaceFolder: path.join(dataDir, 'workspace'),
  };
}

function watcherWrites() {
  return getWriteStats().rows.find((row) => row.key === 'workspace-watchers.json')?.writes ?? 0;
}

test('no-op row mutation preserves bytes, document CAS fields, and write count', () => {
  const ctx = fixture();
  upsertWorkspaceWatcher(ctx.workspaceFolder, { mode: 'observe' }, { dataDir: ctx.dataDir });
  const beforeDoc = loadWorkspaceWatchersDocument({ dataDir: ctx.dataDir });
  const beforeBytes = fs.readFileSync(ctx.file);
  const beforeWrites = watcherWrites();

  const result = mutateWorkspaceWatcherRow(ctx.workspaceFolder, ({ row }) => ({
    mode: row.mode,
    policy: { ...row.policy },
  }), { dataDir: ctx.dataDir });

  const afterDoc = loadWorkspaceWatchersDocument({ dataDir: ctx.dataDir });
  assert.equal(result.ok, true);
  assert.equal(result.unchanged, true);
  assert.equal(result.row.updatedAt, beforeDoc.items[ctx.workspaceFolder].updatedAt);
  assert.equal(afterDoc.revision, beforeDoc.revision);
  assert.equal(afterDoc.updatedAt, beforeDoc.updatedAt);
  assert.deepEqual(fs.readFileSync(ctx.file), beforeBytes);
  assert.equal(watcherWrites(), beforeWrites);
});

test('real row change writes once and increments revision exactly once', () => {
  const ctx = fixture();
  upsertWorkspaceWatcher(ctx.workspaceFolder, { mode: 'observe' }, { dataDir: ctx.dataDir });
  const before = loadWorkspaceWatchersDocument({ dataDir: ctx.dataDir });
  const beforeWrites = watcherWrites();

  const result = mutateWorkspaceWatcherRow(ctx.workspaceFolder, () => ({ orchestratorChatId: 'chat-1' }), {
    dataDir: ctx.dataDir,
  });

  assert.equal(result.ok, true);
  assert.equal(result.unchanged, undefined);
  assert.equal(loadWorkspaceWatchersDocument({ dataDir: ctx.dataDir }).revision, before.revision + 1);
  assert.equal(watcherWrites(), beforeWrites + 1);
});

test('createIfMissing persists a normalized row even when its patch is empty', () => {
  const ctx = fixture();
  const beforeWrites = watcherWrites();
  const result = mutateWorkspaceWatcherRow(ctx.workspaceFolder, () => ({}), { dataDir: ctx.dataDir });

  assert.equal(result.ok, true);
  assert.equal(result.unchanged, undefined);
  assert.equal(loadWorkspaceWatchersDocument({ dataDir: ctx.dataDir }).revision, 1);
  assert.equal(watcherWrites(), beforeWrites + 1);
});

test('null and false mutator results keep their existing meanings', () => {
  const ctx = fixture();
  upsertWorkspaceWatcher(ctx.workspaceFolder, { mode: 'observe' }, { dataDir: ctx.dataDir });
  const beforeWrites = watcherWrites();

  assert.deepEqual(
    mutateWorkspaceWatcherRow(ctx.workspaceFolder, () => null, { dataDir: ctx.dataDir }),
    { ok: false, reason: 'aborted' },
  );
  assert.deepEqual(
    mutateWorkspaceWatcherRow(ctx.workspaceFolder, () => false, { dataDir: ctx.dataDir }),
    { ok: false, reason: 'skipped' },
  );
  assert.equal(watcherWrites(), beforeWrites);
});

test('in-place row mutation is compared with the pre-mutator snapshot', () => {
  const ctx = fixture();
  upsertWorkspaceWatcher(ctx.workspaceFolder, { mode: 'observe' }, { dataDir: ctx.dataDir });
  const before = loadWorkspaceWatchersDocument({ dataDir: ctx.dataDir });

  const result = mutateWorkspaceWatcherRow(ctx.workspaceFolder, ({ row }) => {
    row.orchestratorChatId = 'mutated-in-place';
    return {};
  }, { dataDir: ctx.dataDir });

  assert.equal(result.ok, true);
  assert.equal(result.unchanged, undefined);
  assert.equal(result.row.orchestratorChatId, 'mutated-in-place');
  assert.equal(loadWorkspaceWatchersDocument({ dataDir: ctx.dataDir }).revision, before.revision + 1);
});

test('CAS conflicts still retry before saving the outer mutation', () => {
  const ctx = fixture();
  upsertWorkspaceWatcher(ctx.workspaceFolder, { mode: 'observe' }, { dataDir: ctx.dataDir });
  const before = loadWorkspaceWatchersDocument({ dataDir: ctx.dataDir });
  let attempts = 0;

  const result = mutateWorkspaceWatcherRow(ctx.workspaceFolder, () => {
    attempts += 1;
    if (attempts === 1) {
      upsertWorkspaceWatcher(ctx.workspaceFolder, { orchestratorChatId: 'nested' }, { dataDir: ctx.dataDir });
    }
    return { stopReason: 'outer' };
  }, { dataDir: ctx.dataDir, maxAttempts: 3 });

  assert.equal(result.ok, true);
  assert.equal(attempts, 2);
  assert.equal(result.row.orchestratorChatId, 'nested');
  assert.equal(result.row.stopReason, 'outer');
  assert.equal(loadWorkspaceWatchersDocument({ dataDir: ctx.dataDir }).revision, before.revision + 2);
});

test('nested write makes an outer no-op retry and return the fresh row', () => {
  const ctx = fixture();
  upsertWorkspaceWatcher(ctx.workspaceFolder, { mode: 'observe' }, { dataDir: ctx.dataDir });
  const before = loadWorkspaceWatchersDocument({ dataDir: ctx.dataDir });
  const beforeWrites = watcherWrites();
  let attempts = 0;

  const result = mutateWorkspaceWatcherRow(ctx.workspaceFolder, () => {
    attempts += 1;
    if (attempts === 1) {
      upsertWorkspaceWatcher(ctx.workspaceFolder, { orchestratorChatId: 'nested' }, { dataDir: ctx.dataDir });
    }
    return {};
  }, { dataDir: ctx.dataDir, maxAttempts: 3 });

  assert.equal(result.ok, true);
  assert.equal(result.unchanged, true);
  assert.equal(attempts, 2);
  assert.equal(result.row.orchestratorChatId, 'nested');
  assert.equal(loadWorkspaceWatchersDocument({ dataDir: ctx.dataDir }).revision, before.revision + 1);
  assert.equal(watcherWrites(), beforeWrites + 1, 'only the nested real change is written');
});

test('identical upsert returns the row without writing', () => {
  const ctx = fixture();
  const first = upsertWorkspaceWatcher(ctx.workspaceFolder, { mode: 'observe' }, { dataDir: ctx.dataDir });
  const before = loadWorkspaceWatchersDocument({ dataDir: ctx.dataDir });
  const beforeWrites = watcherWrites();

  const second = upsertWorkspaceWatcher(ctx.workspaceFolder, { mode: 'observe' }, { dataDir: ctx.dataDir });

  assert.deepEqual(second, first);
  assert.equal(loadWorkspaceWatchersDocument({ dataDir: ctx.dataDir }).revision, before.revision);
  assert.equal(watcherWrites(), beforeWrites);
});
