import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import test from 'node:test';
import { appendUsageEvent, readUsageEvents, usageDayPath } from '../lib/persist/usage-persist.js';

test('day-file cache invalidates on append', () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cretli-usage-persist-'));
  appendUsageEvent({ at: '2026-08-28T10:00:00.000Z', model: 'a' }, { dataDir });
  const first = readUsageEvents({ from: '2026-08-28', to: '2026-08-28', dataDir });
  assert.equal(first.length, 1);
  const cached = readUsageEvents({ from: '2026-08-28', to: '2026-08-28', dataDir });
  assert.equal(cached.length, 1);
  appendUsageEvent({ at: '2026-08-28T11:00:00.000Z', model: 'b' }, { dataDir });
  const afterAppend = readUsageEvents({ from: '2026-08-28', to: '2026-08-28', dataDir });
  assert.equal(afterAppend.length, 2);
});

test('day-file cache notices external rewrites by size/mtime', () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cretli-usage-persist-'));
  appendUsageEvent({ at: '2026-08-28T10:00:00.000Z', model: 'a' }, { dataDir });
  assert.equal(readUsageEvents({ from: '2026-08-28', to: '2026-08-28', dataDir }).length, 1);
  const file = usageDayPath(dataDir, '2026-08-28');
  writeFileSync(
    file,
    `${JSON.stringify({ at: '2026-08-28T10:00:00.000Z', model: 'a' })}\n${JSON.stringify({ at: '2026-08-28T12:00:00.000Z', model: 'c' })}\n`,
    'utf8'
  );
  const refreshed = readUsageEvents({ from: '2026-08-28', to: '2026-08-28', dataDir });
  assert.equal(refreshed.length, 2);
});

test('reads events across multiple day files', () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cretli-usage-persist-'));
  appendUsageEvent({ at: '2026-08-28T10:00:00.000Z', model: 'a' }, { dataDir });
  appendUsageEvent({ at: '2026-08-29T10:00:00.000Z', model: 'b' }, { dataDir });
  const events = readUsageEvents({ from: '2026-08-28', to: '2026-08-29', dataDir });
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => event.model), ['a', 'b']);
});
