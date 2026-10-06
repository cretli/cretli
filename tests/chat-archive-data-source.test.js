import assert from 'node:assert/strict';
import {
  buildWorkspaceSearchChatPool,
  chatRowFromMetadataRecord,
  mergeArchiveCatalogRows,
  selectArchiveRowsMissingFromRuntime,
} from '../app_front/features/chat/chatArchiveDataSource.js';
import { hydrateArchiveRowsIntoRuntime } from '../app_front/features/chat/chatArchiveDataSource.js';
import { createSliceSession } from '../app_front/lib/schedulerYield.js';
import { projectMetadataRecordsToRows } from '../app_front/features/chat/chatArchiveDataSource.js';

const instantYieldDeps = {
  now: () => 0,
  setTimeoutFn: (fn) => {
    fn();
    return 1;
  },
  clearTimeoutFn: () => {},
};

{
  const row = chatRowFromMetadataRecord({
    id: 'a1',
    title: 'Archived',
    archivedAt: '2026-01-01T00:00:00.000Z',
    sessionId: 'sess',
    archivedFlag: 1,
    workspaceKey: '/ws\n/app',
  });
  assert.equal(row.id, 'a1');
  assert.equal(row.sessionId, undefined);
  assert.equal(row.archivedFlag, undefined);
}

{
  const merged = mergeArchiveCatalogRows(
    [{ id: 'ram', title: 'RAM', archivedAt: '2026-01-02', workspaceFile: '/ws', workspaceFolder: '/app' }],
    [{ id: 'ram', title: 'Stale IDB', archivedAt: '2026-01-01', workspaceFile: '/ws', workspaceFolder: '/app', sessionId: 's' }],
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].title, 'RAM');
}

{
  const pool = buildWorkspaceSearchChatPool(
    [{ id: 'live-1', title: 'Live' }],
    [{ id: 'arch-1', title: 'Hidden archive', archivedAt: '2026-01-01' }],
  );
  assert.equal(pool.length, 2);
  assert.ok(pool.some((chat) => chat.id === 'arch-1'));
}

{
  const missing = selectArchiveRowsMissingFromRuntime(
    [{ id: 'a' }, { id: 'b' }],
    new Set(['a']),
  );
  assert.deepEqual(missing.map((row) => row.id), ['b']);
}

{
  const applied = [];
  let guardFresh = true;
  const result = await hydrateArchiveRowsIntoRuntime(
    [{ id: 'z1' }, { id: 'z2' }],
    (row) => applied.push(row.id),
    {
      isRunActive: () => true,
      guard: {
        isSessionFresh: () => guardFresh,
        isListFresh: () => true,
      },
      deps: {
        now: () => 0,
        setTimeoutFn: (fn) => { fn(); return 1; },
        clearTimeoutFn: () => {},
      },
      budgetMs: 0,
    },
  );
  assert.equal(applied.length, 2);
  assert.equal(result.cancelled, false);
  guardFresh = false;
  const cancelled = await hydrateArchiveRowsIntoRuntime(
    [{ id: 'z3' }],
    (row) => applied.push(row.id),
    {
      guard: { isSessionFresh: () => false, isListFresh: () => true },
      deps: {
        now: () => 0,
        setTimeoutFn: (fn) => { fn(); return 1; },
        clearTimeoutFn: () => {},
      },
      budgetMs: 0,
    },
  );
  assert.equal(cancelled.cancelled, true);
  void createSliceSession();
}

{
  const records = [];
  for (let index = 0; index < 40; index += 1) {
    records.push({
      id: `arch-${index}`,
      title: `Archived ${index}`,
      archivedAt: '2026-01-01T00:00:00.000Z',
      archivedFlag: 1,
    });
  }
  let fresh = true;
  const projected = await projectMetadataRecordsToRows(records, {
    deps: instantYieldDeps,
    budgetMs: 0,
    isApplyFresh: () => fresh,
  });
  assert.equal(projected.cancelled, false);
  assert.equal(projected.rows.length, 40);
  fresh = false;
  const stale = await projectMetadataRecordsToRows(records, {
    deps: instantYieldDeps,
    budgetMs: 0,
    isApplyFresh: () => fresh,
  });
  assert.equal(stale.cancelled, true);
  assert.equal(stale.rows.length, 0, 'stale epoch/scope must not keep partial IDB rows');
}

console.log('chat-archive-data-source.test.js OK');
