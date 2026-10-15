import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  PLAN_WINDOW_RESERVATION_QUEUE_MAX,
  clearPlanWindowReservationCache,
  clearPlanWindowReservationQueue,
  flushPlanWindowReservations,
  queuePlanWindowReservation,
} from '../lib/plan-window-reservations.js';

const NOW = Date.parse('2026-01-01T12:00:00Z');
const MIN = 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const FILE = 'plan-window-reservations.json';

const week = (over = {}) => ({
  harness: 'h1', rateLimitType: 'seven_day', utilization: 40,
  resetsAt: iso(NOW + 180 * MIN), observedAt: iso(NOW - MIN), ...over,
});

const withDir = (fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-queue-'));
  clearPlanWindowReservationCache();
  clearPlanWindowReservationQueue();
  try {
    return fn(dir);
  } finally {
    clearPlanWindowReservationQueue();
    clearPlanWindowReservationCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

const payload = (dir, key, over = {}) => ({
  harness: 'h1', model: 'm1', role: 'implement', idempotencyKey: key,
  planLimits: [week()], now: NOW, dataDir: dir, ...over,
});

const readEntryIds = (dir) => {
  try {
    const store = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'));
    return Object.values(store).flatMap((slot) => Object.keys(slot.entries));
  } catch {
    return [];
  }
};

test('a queued reservation is written once and leaves the queue', () => withDir((dir) => {
  assert.equal(queuePlanWindowReservation(payload(dir, 'd1:a1')), true);
  const result = flushPlanWindowReservations();
  assert.deepEqual(result, { flushed: 1, remaining: 0 });
  assert.deepEqual(readEntryIds(dir), ['d1:a1']);
  // A second flush has nothing left.
  assert.deepEqual(flushPlanWindowReservations(), { flushed: 0, remaining: 0 });
}));

test('queueing the same idempotency key twice keeps a single entry', () => withDir((dir) => {
  assert.equal(queuePlanWindowReservation(payload(dir, 'dup:a')), true);
  assert.equal(queuePlanWindowReservation(payload(dir, 'dup:a', { model: 'other-model' })), true);
  const result = flushPlanWindowReservations();
  assert.deepEqual(result, { flushed: 1, remaining: 0 });
  assert.deepEqual(readEntryIds(dir), ['dup:a']);
}));

test('a stuck lock keeps the entry queued until it is released', () => withDir((dir) => {
  fs.writeFileSync(path.join(dir, `${FILE}.lock`), 'other:token');
  queuePlanWindowReservation(payload(dir, 'held:a'));
  assert.deepEqual(flushPlanWindowReservations(), { flushed: 0, remaining: 1 });
  assert.deepEqual(readEntryIds(dir), []);
  fs.rmSync(path.join(dir, `${FILE}.lock`), { force: true });
  assert.deepEqual(flushPlanWindowReservations(), { flushed: 1, remaining: 0 });
  assert.deepEqual(readEntryIds(dir), ['held:a']);
}));

test('one failing payload does not stop the rest of the queue', () => withDir((dir) => {
  const throwingLimits = new Proxy([], {
    get(target, prop) {
      if (prop === Symbol.iterator) throw new Error('boom');
      return Reflect.get(target, prop);
    },
  });
  queuePlanWindowReservation(payload(dir, 'bad:a', { planLimits: throwingLimits }));
  queuePlanWindowReservation(payload(dir, 'good:a'));
  const result = flushPlanWindowReservations();
  assert.equal(result.flushed, 1);
  assert.equal(result.remaining, 1);
  assert.deepEqual(readEntryIds(dir), ['good:a']);
}));

test('the queue is bounded and drops the oldest entries', () => withDir((dir) => {
  const total = PLAN_WINDOW_RESERVATION_QUEUE_MAX + 5;
  for (let i = 0; i < total; i += 1) {
    queuePlanWindowReservation(payload(dir, `k${i}`, { now: NOW + i }));
  }
  const result = flushPlanWindowReservations();
  assert.equal(result.flushed, PLAN_WINDOW_RESERVATION_QUEUE_MAX);
  assert.equal(result.remaining, 0);
  const ids = readEntryIds(dir);
  assert.equal(ids.length, PLAN_WINDOW_RESERVATION_QUEUE_MAX);
  assert.ok(!ids.includes('k0'), 'the oldest entry was dropped');
  assert.ok(!ids.includes(`k${total - PLAN_WINDOW_RESERVATION_QUEUE_MAX - 1}`));
  assert.ok(ids.includes(`k${total - 1}`), 'the newest entry survived');
}));

test('clearPlanWindowReservationQueue empties the queue', () => withDir((dir) => {
  queuePlanWindowReservation(payload(dir, 'a'));
  queuePlanWindowReservation(payload(dir, 'b'));
  clearPlanWindowReservationQueue();
  assert.deepEqual(flushPlanWindowReservations(), { flushed: 0, remaining: 0 });
}));
