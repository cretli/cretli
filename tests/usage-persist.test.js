import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import test from 'node:test';
import {
  appendUsageEvent,
  getDayFileCacheStats,
  MAX_CACHED_DAY_FILE_BYTES,
  readUsageEvents,
  resetUsageLedgerCache,
  usageDayPath,
} from '../lib/persist/usage-persist.js';

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

test('day-file cache stays inside its byte budget and re-reads evicted files', () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cretli-usage-persist-'));
  resetUsageLedgerCache();
  const days = ['2026-08-20', '2026-08-21', '2026-08-22', '2026-08-23'];
  const pad = 'x'.repeat(Math.floor(MAX_CACHED_DAY_FILE_BYTES / 3));
  for (const day of days) {
    appendUsageEvent({ at: `${day}T10:00:00.000Z`, model: day }, { dataDir });
    // Bulk up the file externally so each day is ~1/3 of the budget.
    writeFileSync(usageDayPath(dataDir, day), `${JSON.stringify({ at: `${day}T10:00:00.000Z`, model: day, pad })}\n`, 'utf8');
  }
  const events = readUsageEvents({ from: days[0], to: days[3], dataDir });
  assert.deepEqual(events.map((event) => event.model), days);
  const stats = getDayFileCacheStats();
  assert.ok(stats.bytes <= MAX_CACHED_DAY_FILE_BYTES, `cached ${stats.bytes} bytes`);
  assert.ok(stats.entries < days.length, 'oldest day file was evicted');
  // Evicted files are simply parsed again: same result.
  const again = readUsageEvents({ from: days[0], to: days[3], dataDir });
  assert.deepEqual(again.map((event) => event.model), days);
  assert.ok(getDayFileCacheStats().bytes <= MAX_CACHED_DAY_FILE_BYTES);
});

test('day-file cache hit skips reparse and checksum work', () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cretli-usage-persist-'));
  appendUsageEvent({ at: '2026-08-28T10:00:00.000Z', model: 'a' }, { dataDir });
  const query = { from: '2026-08-28', to: '2026-08-28', dataDir };
  readUsageEvents(query);
  const before = getDayFileCacheStats();
  readUsageEvents(query);
  readUsageEvents(query);
  const after = getDayFileCacheStats();
  assert.equal(after.parses, before.parses, 'unchanged file is not parsed again');
  assert.ok(after.hits >= before.hits + 2);
});

test('day-file cache reparses only the changed file', () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cretli-usage-persist-'));
  appendUsageEvent({ at: '2026-08-28T10:00:00.000Z', model: 'a' }, { dataDir });
  appendUsageEvent({ at: '2026-08-29T10:00:00.000Z', model: 'b' }, { dataDir });
  const query = { from: '2026-08-28', to: '2026-08-29', dataDir };
  readUsageEvents(query);
  const before = getDayFileCacheStats();
  appendUsageEvent({ at: '2026-08-29T11:00:00.000Z', model: 'c' }, { dataDir });
  const events = readUsageEvents(query);
  assert.equal(events.length, 3);
  assert.equal(getDayFileCacheStats().parses, before.parses + 1);
});

test('mutating returned events does not corrupt the cache', () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cretli-usage-persist-'));
  appendUsageEvent({ at: '2026-08-28T10:00:00.000Z', model: 'a' }, { dataDir });
  const query = { from: '2026-08-28', to: '2026-08-28', dataDir };
  const first = readUsageEvents(query);
  first[0].model = 'mutated';
  first.push({ model: 'extra' });
  const second = readUsageEvents(query);
  assert.equal(second.length, 1);
  assert.equal(second[0].model, 'a');
});
