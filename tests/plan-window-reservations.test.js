import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  PLAN_WINDOW_RESERVATION_MAX_ENTRIES,
  PLAN_WINDOW_RESERVATION_MAX_FILE_BYTES,
  applyPlanWindowReservations,
  clearPlanWindowReservationCache,
  recordPlanWindowReservation,
  reservationKey,
} from '../lib/plan-window-reservations.js';

const NOW = Date.parse('2026-01-01T12:00:00Z');
const MIN = 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const FILE = 'plan-window-reservations.json';
const MODULE_URL = new URL('../lib/plan-window-reservations.js', import.meta.url).href;

const week = (over = {}) => ({
  harness: 'h1', rateLimitType: 'seven_day', utilization: 80,
  resetsAt: iso(NOW + 180 * MIN), observedAt: iso(NOW - MIN), stale: false, expired: false, ...over,
});

const withDir = (fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-store-'));
  clearPlanWindowReservationCache();
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};
const record = (dir, id, over = {}) => recordPlanWindowReservation({
  harness: 'h1', model: 'm1', role: 'implement', idempotencyKey: id,
  planLimits: [week()], now: NOW, dataDir: dir, ...over,
});
const readDisk = (dir) => JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'));
const entryCount = (store) => Object.values(store).reduce((n, s) => n + Object.keys(s.entries).length, 0);

test('TTL is applied per entry and expired entries leave the disk', () => withDir((dir) => {
  assert.equal(record(dir, 'old', { now: NOW }).recorded, 1);
  assert.equal(record(dir, 'fresh', { now: NOW + 14 * MIN }).recorded, 1);
  // Slot was touched at +14 min, but the 'old' entry is past its own TTL.
  const later = NOW + 16 * MIN;
  const overlay = applyPlanWindowReservations([week()], { now: later, dataDir: dir });
  assert.equal(overlay[0].estimatedPp, 3);
  record(dir, 'third', { now: later });
  const store = readDisk(dir);
  assert.deepEqual(Object.keys(Object.values(store)[0].entries).sort(), ['fresh', 'third']);
}));

test('hard entry cap and file-size cap keep the store bounded', () => withDir((dir) => {
  for (let i = 0; i < PLAN_WINDOW_RESERVATION_MAX_ENTRIES + 25; i += 1) {
    record(dir, `d${i}:a`, { now: NOW + i });
  }
  const store = readDisk(dir);
  assert.ok(entryCount(store) <= PLAN_WINDOW_RESERVATION_MAX_ENTRIES);
  assert.ok(fs.statSync(path.join(dir, FILE)).size <= PLAN_WINDOW_RESERVATION_MAX_FILE_BYTES);
  // The newest entries win.
  assert.ok(Object.values(store)[0].entries[`d${PLAN_WINDOW_RESERVATION_MAX_ENTRIES + 24}:a`]);
}));

test('changed resetsAt and a newer measurement remove the old slot/entries on write', () => withDir((dir) => {
  record(dir, 'a');
  const oldKey = reservationKey('h1', 'seven_day', week().resetsAt);
  assert.ok(readDisk(dir)[oldKey]);
  const reset = week({ resetsAt: iso(NOW + 600 * MIN) });
  record(dir, 'b', { planLimits: [reset], now: NOW + MIN });
  const afterReset = readDisk(dir);
  assert.equal(afterReset[oldKey], undefined);
  assert.ok(afterReset[reservationKey('h1', 'seven_day', reset.resetsAt)]);
  // A measurement newer than the entry supersedes it on the next write.
  const fresher = week({ resetsAt: reset.resetsAt, observedAt: iso(NOW + 2 * MIN) });
  record(dir, 'c', { planLimits: [fresher], now: NOW + 3 * MIN });
  const ids = Object.keys(Object.values(readDisk(dir))[0].entries);
  assert.deepEqual(ids, ['c']);
}));

test('future timestamps (clock skew) are ignored on read and dropped on write', () => withDir((dir) => {
  fs.writeFileSync(path.join(dir, FILE), JSON.stringify({
    [reservationKey('h1', 'seven_day', week().resetsAt)]: {
      createdAt: iso(NOW), entries: { skew: { pp: 3, at: iso(NOW + 60 * MIN) } },
    },
  }));
  assert.equal(applyPlanWindowReservations([week()], { now: NOW, dataDir: dir })[0].utilizationEstimated, undefined);
  record(dir, 'real');
  assert.deepEqual(Object.keys(Object.values(readDisk(dir))[0].entries), ['real']);
}));

test('corrupt, oversized and missing files read as empty and recover on write', () => withDir((dir) => {
  const file = path.join(dir, FILE);
  assert.equal(applyPlanWindowReservations([week()], { now: NOW, dataDir: dir })[0].utilization, 80);
  fs.writeFileSync(file, '{not json');
  assert.equal(applyPlanWindowReservations([week()], { now: NOW, dataDir: dir })[0].utilization, 80);
  assert.equal(record(dir, 'a').recorded, 1);
  assert.equal(readDisk(dir) && entryCount(readDisk(dir)), 1);
  fs.writeFileSync(file, ' '.repeat(PLAN_WINDOW_RESERVATION_MAX_FILE_BYTES + 10));
  clearPlanWindowReservationCache();
  assert.equal(applyPlanWindowReservations([week()], { now: NOW, dataDir: dir })[0].utilization, 80);
  assert.equal(record(dir, 'b').recorded, 1);
}));

test('a stale leftover lockfile is stolen; a live lock makes the write skip, not block', () => withDir((dir) => {
  const lock = path.join(dir, `${FILE}.lock`);
  fs.writeFileSync(lock, '');
  const live = Date.now();
  const livePlan = [week({ resetsAt: iso(live + 180 * MIN), observedAt: iso(live - MIN) })];
  const started = Date.now();
  const skipped = record(dir, 'a', { now: live, planLimits: livePlan });
  assert.equal(skipped.skipped, 'lock-timeout');
  assert.ok(Date.now() - started < 2000);
  const old = new Date(Date.now() - 60 * 1000);
  fs.utimesSync(lock, old, old);
  assert.equal(record(dir, 'a', { now: live, planLimits: livePlan }).recorded, 1);
}));

test('lock file carries a token and is removed only by its owner', () => withDir((dir) => {
  const lock = path.join(dir, `${FILE}.lock`);
  // A foreign live lock is left untouched and the write is skipped at once.
  fs.writeFileSync(lock, 'other-pid:token');
  const res = record(dir, 'a');
  assert.equal(res.skipped, 'lock-timeout');
  assert.equal(fs.readFileSync(lock, 'utf8'), 'other-pid:token');
  // A stale foreign lock is stolen, then released: nothing is left behind.
  const old = new Date(Date.now() - 60 * 1000);
  fs.utimesSync(lock, old, old);
  assert.equal(record(dir, 'a').recorded, 1);
  assert.equal(fs.existsSync(lock), false);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.stale')), []);
}));

test('a lock replaced by another holder during the critical section is not removed on release', () => withDir((dir) => {
  const lock = path.join(dir, `${FILE}.lock`);
  const row = week();
  let replaced = false;
  // Read inside the critical section: simulate another holder replacing our lock.
  Object.defineProperty(row, 'harness', {
    enumerable: true,
    get() {
      if (!replaced && fs.existsSync(lock)) {
        replaced = true;
        fs.unlinkSync(lock);
        fs.writeFileSync(lock, 'thief:token');
      }
      return 'h1';
    },
  });
  const res = recordPlanWindowReservation({
    harness: 'h1', model: 'm1', role: 'implement', idempotencyKey: 'a',
    planLimits: [row], now: NOW, dataDir: dir,
  });
  assert.ok(replaced, 'the replacement ran inside the critical section');
  assert.equal(res.skipped, undefined);
  assert.equal(fs.readFileSync(lock, 'utf8'), 'thief:token');
}));

test('a held lock skips the write without sleeping', () => withDir((dir) => {
  fs.writeFileSync(path.join(dir, `${FILE}.lock`), 'other:token');
  const started = process.hrtime.bigint();
  const res = record(dir, 'a');
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(res.skipped, 'lock-timeout');
  assert.ok(elapsedMs < 100, `lock wait was ${elapsedMs}ms`);
}));

test('picker read is served from a stat-validated cache and sees external writes', () => withDir((dir) => {
  record(dir, 'a');
  const first = applyPlanWindowReservations([week()], { now: NOW, dataDir: dir });
  assert.equal(first[0].estimatedPp, 3);
  record(dir, 'b');
  const second = applyPlanWindowReservations([week()], { now: NOW, dataDir: dir });
  assert.equal(second[0].estimatedPp, 6);
}));

test('two real writer processes never lose reservations', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-proc-'));
  const script = `
    import { recordPlanWindowReservation } from ${JSON.stringify(MODULE_URL)};
    const [dir, tag, nowText] = process.argv.slice(1);
    const rows = [{ harness: 'h1', rateLimitType: 'seven_day', utilization: 10,
      resetsAt: new Date(Number(nowText) + 3 * 3600e3).toISOString(),
      observedAt: new Date(Number(nowText) - 60e3).toISOString() }];
    let recorded = 0;
    for (let i = 0; i < 25; i += 1) {
      // The store never waits on a held lock; the real caller retries a skipped write.
      for (let tries = 0; tries < 2000; tries += 1) {
        const res = recordPlanWindowReservation({ harness: 'h1', model: 'm1', role: 'review',
          idempotencyKey: tag + i, planLimits: rows, now: Number(nowText), dataDir: dir });
        if (!res.skipped) { recorded += res.recorded; break; }
        await new Promise((r) => setTimeout(r, 1));
      }
    }
    console.log(recorded);
  `;
  const run = (tag) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, dir, tag, String(NOW)], {
      cwd: path.dirname(fileURLToPath(import.meta.url)),
    });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(Number(out.trim())) : reject(new Error(`exit ${code}: ${out}`))));
  });
  try {
    const [a, b] = await Promise.all([run('A'), run('B')]);
    const store = readDisk(dir);
    const ids = Object.values(store).flatMap((slot) => Object.keys(slot.entries));
    assert.equal(a + b, 50, 'no writer was starved by the lock');
    assert.equal(new Set(ids).size, 50, 'every reservation survived');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
