import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  flushCoalescedWrite,
  getWriteStats,
  hasPendingCoalescedWrite,
  resetWriteStats,
  writeJsonCoalesced,
} from '../lib/persist/atomic-write.js';

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-coalesced-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('coalesces to the latest value without sliding the first deadline', async (t) => {
  const file = path.join(scratch(t), 'history.json');
  resetWriteStats();
  writeJsonCoalesced(file, { value: 1 }, 'utf8', { maxDelayMs: 70 });
  await new Promise((resolve) => setTimeout(resolve, 45));
  writeJsonCoalesced(file, { value: 2 }, 'utf8', { maxDelayMs: 70 });
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { value: 2 });
  assert.equal(hasPendingCoalescedWrite(file), false);
  const row = getWriteStats().rows.find((entry) => entry.key === 'history.json');
  assert.equal(row.writes, 1);
  assert.equal(row.coalesced, 1);
});

test('explicit flush writes immediately and clears the pending timer', (t) => {
  const file = path.join(scratch(t), 'flush.json');
  writeJsonCoalesced(file, { done: true }, 'utf8', { maxDelayMs: 10000 });
  assert.equal(hasPendingCoalescedWrite(file), true);
  assert.deepEqual(flushCoalescedWrite(file), { written: 1, failed: 0 });
  assert.equal(hasPendingCoalescedWrite(file), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { done: true });
});

test('100 history mutations produce one physical write', (t) => {
  const file = path.join(scratch(t), 'cycles.json');
  resetWriteStats();
  for (let value = 1; value <= 100; value += 1) {
    writeJsonCoalesced(file, { value }, 'utf8', { maxDelayMs: 5000 });
  }
  flushCoalescedWrite(file);
  const row = getWriteStats().rows.find((entry) => entry.key === 'cycles.json');
  assert.equal(row.writes, 1);
  assert.equal(row.coalesced, 99);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { value: 100 });
});

test('failed flush schedules a retry that persists the latest value', async (t) => {
  const dir = scratch(t);
  const blocker = path.join(dir, 'blocker');
  const file = path.join(blocker, 'history.json');
  fs.writeFileSync(blocker, 'not a directory');
  writeJsonCoalesced(file, { retained: true }, 'utf8', { maxDelayMs: 10000 });
  assert.deepEqual(flushCoalescedWrite(file), { written: 0, failed: 1 });
  assert.equal(hasPendingCoalescedWrite(file), true);
  writeJsonCoalesced(file, { retained: 'latest' }, 'utf8', { maxDelayMs: 10000 });
  fs.unlinkSync(blocker);
  fs.mkdirSync(blocker);
  const deadline = Date.now() + 2500;
  while (!fs.existsSync(file) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(hasPendingCoalescedWrite(file), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { retained: 'latest' });
});

test('kill switch preserves immediate-write behaviour', (t) => {
  const file = path.join(scratch(t), 'immediate.json');
  const previous = process.env.CRETLI_COALESCED_WRITES;
  process.env.CRETLI_COALESCED_WRITES = '0';
  t.after(() => {
    if (previous === undefined) delete process.env.CRETLI_COALESCED_WRITES;
    else process.env.CRETLI_COALESCED_WRITES = previous;
  });
  assert.deepEqual(writeJsonCoalesced(file, { immediate: true }), { pending: false, immediate: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { immediate: true });
});
