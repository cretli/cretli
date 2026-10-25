import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  getWriteStats,
  resetWriteMemory,
  resetWriteStats,
  writeJsonAtomic,
} from '../lib/persist/atomic-write.js';

const dirs = [];
function setup(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cretli-skip-compact-'));
  dirs.push(dir);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  resetWriteStats();
  resetWriteMemory();
  return path.join(dir, 'a.json');
}
const row = () => getWriteStats().rows.find((r) => r.key === 'a.json');
const SKIP = { skipIfUnchanged: true, ignoreKeys: ['updatedAt'] };

test('default behaviour is unchanged: indented and always written', (t) => {
  const file = setup(t);
  writeJsonAtomic(file, { a: 1 });
  const first = statSync(file).mtimeMs;
  utimesSync(file, new Date(first - 5000), new Date(first - 5000));
  writeJsonAtomic(file, { a: 1 });
  assert.equal(readFileSync(file, 'utf8'), JSON.stringify({ a: 1 }, null, 2));
  assert.equal(row().writes, 2);
  assert.equal(row().identicalWrites, 1, 'identical share is counted without skipping');
  assert.equal(row().skippedWrites, 0);
  assert.notEqual(statSync(file).mtimeMs, first - 5000, 'second write really hit the disk');
});

test('skipIfUnchanged: identical data (envelope ignored) writes once', (t) => {
  const file = setup(t);
  assert.equal(writeJsonAtomic(file, { updatedAt: 'a', x: 1 }, 'utf8', SKIP).skipped, false);
  assert.equal(writeJsonAtomic(file, { updatedAt: 'b', x: 1 }, 'utf8', SKIP).skipped, true);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).updatedAt, 'a');
  assert.equal(row().writes, 1);
  assert.equal(row().skippedWrites, 1);
});

test('skipIfUnchanged: one changed field is written', (t) => {
  const file = setup(t);
  writeJsonAtomic(file, { updatedAt: 'a', x: 1 }, 'utf8', SKIP);
  assert.equal(writeJsonAtomic(file, { updatedAt: 'a', x: 2 }, 'utf8', SKIP).skipped, false);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).x, 2);
});

test('skipIfUnchanged: external deletion and external edit force a rewrite', (t) => {
  const file = setup(t);
  writeJsonAtomic(file, { x: 1 }, 'utf8', SKIP);
  unlinkSync(file);
  assert.equal(writeJsonAtomic(file, { x: 1 }, 'utf8', SKIP).skipped, false);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { x: 1 });
  writeFileSync(file, '{"x":1,"external":true}');
  assert.equal(writeJsonAtomic(file, { x: 1 }, 'utf8', SKIP).skipped, false);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { x: 1 });
});

test('compact: no indentation, same data, old indented files still parse', (t) => {
  const file = setup(t);
  const data = { a: [1, { b: 2 }], c: 'x' };
  writeJsonAtomic(file, data, 'utf8', { compact: true });
  assert.equal(readFileSync(file, 'utf8'), JSON.stringify(data));
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), data);
  writeFileSync(file, JSON.stringify(data, null, 2));
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), data);
});

test('skip + compact compare the same serialization', (t) => {
  const file = setup(t);
  const opts = { ...SKIP, compact: true };
  writeJsonAtomic(file, { updatedAt: 'a', x: 1 }, 'utf8', opts);
  assert.equal(writeJsonAtomic(file, { updatedAt: 'b', x: 1 }, 'utf8', opts).skipped, true);
});
