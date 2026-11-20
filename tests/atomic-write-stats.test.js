import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  getWriteStats,
  recordWriteStat,
  resetWriteStats,
  writeJsonAtomic,
  writeTextAtomic,
} from '../lib/persist/atomic-write.js';
import { resolveDataPath } from '../lib/runtime-paths.js';

function tmpDir() {
  return mkdtempSync(path.join(os.tmpdir(), 'cretli-write-stats-'));
}
const find = (key) => getWriteStats().rows.find((row) => row.key === key);

test('aggregates grow for JSON and text writes; content is unchanged', (t) => {
  const dir = tmpDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  resetWriteStats();
  const file = path.join(dir, 'a.json');
  writeJsonAtomic(file, { a: 1 });
  assert.equal(readFileSync(file, 'utf8'), JSON.stringify({ a: 1 }, null, 2));
  writeTextAtomic(path.join(dir, 'b.txt'), 'héllo');
  assert.equal(find('a.json').writes, 1);
  assert.equal(find('b.txt').writes, 1);
  assert.ok(find('a.json').bytes > 0);
});

test('keys: outside data dir keeps base name only, hashes become *', (t) => {
  const dir = tmpDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  resetWriteStats();
  writeJsonAtomic(path.join(dir, '123e4567-e89b-12d3-a456-426614174000.json'), {});
  writeJsonAtomic(path.join(dir, 'deadbeef1234.json'), {});
  const keys = getWriteStats().rows.map((row) => row.key);
  assert.deepEqual(keys, ['*.json']);
  for (const key of keys) {
    assert.ok(!key.includes(dir) && !key.includes(os.homedir()) && !path.isAbsolute(key));
  }
});

test('keys: file inside data dir becomes relative with hash segment masked', () => {
  resetWriteStats();
  recordWriteStat({ filePath: resolveDataPath('todos', 'abcdef0123456789.json'), bytes: 1 });
  assert.equal(find('todos/*.json').writes, 1);
});

test('key map is bounded at 200 entries', () => {
  resetWriteStats();
  for (let i = 0; i < 300; i += 1) recordWriteStat({ filePath: `/x/file-${i}.json`, bytes: 1 });
  const rows = getWriteStats().rows;
  assert.ok(rows.length <= 201);
  assert.ok(find('(other)').writes >= 100);
});

test('failed write rethrows and is still counted', (t) => {
  const dir = tmpDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const blocker = path.join(dir, 'file');
  writeFileSync(blocker, 'x');
  resetWriteStats();
  assert.throws(() => writeJsonAtomic(path.join(blocker, 'sub', 'a.json'), {}));
  assert.equal(find('a.json').writes, 1);
});

test('recordWriteStat accepts ledger-index.json style samples', () => {
  resetWriteStats();
  recordWriteStat({ filePath: resolveDataPath('usage', 'ledger-index.json'), bytes: 9, stringifyMs: 2, ioMs: 1 });
  const row = find('usage/ledger-index.json');
  assert.equal(row.stringifyMs, 2);
  assert.equal(row.maxMs, 3);
});

test('large stats-only writes skip the digest but skipIfUnchanged still dedupes', async () => {
  const { writeJsonAtomic, STATS_DIGEST_MAX_CHARS, resetWriteStats, getWriteStats } = await import('../lib/persist/atomic-write.js');
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-big-'));
  const big = { blob: 'x'.repeat(STATS_DIGEST_MAX_CHARS + 10) };
  resetWriteStats();
  writeJsonAtomic(path.join(dir, 'a.json'), big);
  writeJsonAtomic(path.join(dir, 'a.json'), big);
  assert.equal(getWriteStats().rows.reduce((n, r) => n + r.identicalWrites, 0), 0);
  writeJsonAtomic(path.join(dir, 'b.json'), big, 'utf8', { skipIfUnchanged: true });
  const r = writeJsonAtomic(path.join(dir, 'b.json'), big, 'utf8', { skipIfUnchanged: true });
  assert.equal(r.skipped, true);
  fs.rmSync(dir, { recursive: true, force: true });
});
