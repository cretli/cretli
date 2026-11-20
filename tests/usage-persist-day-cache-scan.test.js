import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import test from 'node:test';

// The budget is read at import time, so set a small one before loading the module.
process.env.CRETLI_USAGE_DAY_CACHE_MB = '1';
const {
  appendUsageEvent,
  getDayFileCacheStats,
  MAX_CACHED_DAY_FILE_BYTES,
  readUsageEvents,
  resetUsageLedgerCache,
  usageDayPath,
} = await import('../lib/persist/usage-persist.js');

test('a window larger than the cache budget still hits the newest days on reread', () => {
  assert.equal(MAX_CACHED_DAY_FILE_BYTES, 1024 * 1024);
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cretli-usage-scan-'));
  resetUsageLedgerCache();
  const days = ['2026-08-20', '2026-08-21', '2026-08-22', '2026-08-23', '2026-08-24'];
  const pad = 'x'.repeat(Math.floor(MAX_CACHED_DAY_FILE_BYTES / 3));
  for (const day of days) {
    appendUsageEvent({ at: `${day}T10:00:00.000Z`, model: day }, { dataDir });
    writeFileSync(usageDayPath(dataDir, day), `${JSON.stringify({ at: `${day}T10:00:00.000Z`, model: day, pad })}\n`, 'utf8');
  }
  const first = readUsageEvents({ from: days[0], to: days[4], dataDir });
  assert.deepEqual(first.map((event) => event.model), days);
  const afterFirst = getDayFileCacheStats();
  assert.ok(afterFirst.bytes <= MAX_CACHED_DAY_FILE_BYTES);

  // LRU eviction would thrash here (zero hits); oldest-day eviction keeps the
  // newest days, so a reread of the recent part of the window hits the cache.
  const recent = readUsageEvents({ from: days[3], to: days[4], dataDir });
  assert.deepEqual(recent.map((event) => event.model), days.slice(3));
  const afterRecent = getDayFileCacheStats();
  assert.equal(afterRecent.parses, afterFirst.parses, 'recent days were served from the cache');
  assert.equal(afterRecent.hits - afterFirst.hits, 2);
});
