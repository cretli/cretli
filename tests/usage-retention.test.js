import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import test from 'node:test';
import {
  USAGE_DEFAULT_RETENTION_DAYS,
} from '../lib/usage/usage-settings.js';
import {
  listUsageDayFiles,
  pruneUsageJournal,
  resolveUsageRetentionDays,
  runUsageRetention,
  summarizeUsageDataDir,
} from '../lib/usage/usage-retention.js';

const NOW = Date.parse('2026-06-01T00:00:00.000Z');
// 90 days before 2026-06-01: the cutoff day is kept, anything older is removed.
const CUTOFF_DAY = '2026-03-03';

/**
 * @param {{ retentionDays?: number, now?: number, extra?: Record<string, string> }} [options]
 * @returns {{ dataDir: string, usageDir: string }}
 */
function seedUsageDir(options = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cretli-usage-retention-'));
  const usageDir = path.join(dataDir, 'usage');
  mkdirSync(usageDir, { recursive: true });
  const dayFiles = {
    '2025-12-31.jsonl': '{}\n',
    '2026-03-02.jsonl': '{}\n',
    [`${CUTOFF_DAY}.jsonl`]: '{}\n',
    '2026-05-31.jsonl': '{}\n',
  };
  for (const [name, body] of Object.entries({ ...dayFiles, ...(options.extra || {}) })) {
    writeFileSync(path.join(usageDir, name), body, 'utf8');
  }
  return { dataDir, usageDir };
}

test('resolveUsageRetentionDays defaults to 90 and clamps', () => {
  assert.equal(resolveUsageRetentionDays(undefined), USAGE_DEFAULT_RETENTION_DAYS);
  assert.equal(resolveUsageRetentionDays({ retentionDays: 12 }), 12);
  assert.equal(resolveUsageRetentionDays({ alerts: {}, retentionDays: 30 }), 30);
  assert.equal(resolveUsageRetentionDays(0), 1);
  assert.equal(resolveUsageRetentionDays(999999), 3650);
});

test('pruneUsageJournal deletes only day files older than the cutoff', () => {
  const { dataDir, usageDir } = seedUsageDir();
  writeFileSync(path.join(usageDir, 'plan-limits.jsonl'), '{}\n', 'utf8');
  writeFileSync(path.join(usageDir, 'limits.jsonl'), '{}\n', 'utf8');

  const result = pruneUsageJournal({ dataDir, retentionDays: 90, now: NOW });
  assert.equal(result.cutoffDay, CUTOFF_DAY);
  assert.deepEqual(result.deleted.sort(), ['2025-12-31.jsonl', '2026-03-02.jsonl']);
  assert.deepEqual(result.kept.sort(), [`${CUTOFF_DAY}.jsonl`, '2026-05-31.jsonl']);
  assert.ok(result.bytesFreed > 0);
  // The cutoff day itself is retained; newer days and auxiliary stores survive.
  assert.equal(statSync(path.join(usageDir, `${CUTOFF_DAY}.jsonl`)).isFile(), true);
  assert.equal(statSync(path.join(usageDir, '2026-05-31.jsonl')).isFile(), true);
  assert.equal(statSync(path.join(usageDir, 'plan-limits.jsonl')).isFile(), true);
  assert.equal(statSync(path.join(usageDir, 'limits.jsonl')).isFile(), true);
});

test('pruneUsageJournal is a no-op when every file is inside the window', () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cretli-usage-retention-'));
  const usageDir = path.join(dataDir, 'usage');
  mkdirSync(usageDir, { recursive: true });
  writeFileSync(path.join(usageDir, '2026-05-31.jsonl'), '{}\n', 'utf8');
  const result = pruneUsageJournal({ dataDir, retentionDays: 90, now: NOW });
  assert.deepEqual(result.deleted, []);
  assert.equal(statSync(path.join(usageDir, '2026-05-31.jsonl')).isFile(), true);
});

test('summarizeUsageDataDir reports size, file counts and day range', () => {
  const { dataDir } = seedUsageDir();
  const summary = summarizeUsageDataDir({ dataDir });
  assert.equal(summary.exists, true);
  assert.equal(summary.files, 4);
  assert.equal(summary.dayFiles, 4);
  assert.ok(summary.bytes > 0);
  assert.ok(summary.journalBytes > 0);
  assert.equal(summary.oldestDay, '2025-12-31');
  assert.equal(summary.newestDay, '2026-05-31');
});

test('listUsageDayFiles ignores non-day journal stores', () => {
  const { dataDir, usageDir } = seedUsageDir();
  writeFileSync(path.join(usageDir, 'plan-limits.jsonl'), '{}\n', 'utf8');
  writeFileSync(path.join(usageDir, 'ledger-index.json'), '{}', 'utf8');
  const rows = listUsageDayFiles(dataDir);
  assert.equal(rows.length, 4);
  assert.ok(rows.every((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.day)));
});

test('runUsageRetention applies the configured window', () => {
  const { dataDir, usageDir } = seedUsageDir();
  const result = runUsageRetention({ dataDir, settings: { retentionDays: 30 }, now: NOW });
  assert.equal(result.retentionDays, 30);
  assert.deepEqual(result.journal.deleted.sort(), ['2025-12-31.jsonl', '2026-03-02.jsonl', `${CUTOFF_DAY}.jsonl`]);
  assert.equal(statSync(path.join(usageDir, '2026-05-31.jsonl')).isFile(), true);
});

test('a missing data/usage directory summarizes as empty', () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cretli-usage-retention-'));
  const summary = summarizeUsageDataDir({ dataDir });
  assert.equal(summary.exists, false);
  assert.equal(summary.bytes, 0);
  const result = pruneUsageJournal({ dataDir, retentionDays: 90, now: NOW });
  assert.deepEqual(result.deleted, []);
});
