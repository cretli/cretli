import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { planHeadroomSnapshotFor } from '../lib/delegation-service.js';
import {
  clearPlanWindowReservationCache,
  clearPlanWindowReservationQueue,
  flushPlanWindowReservations,
  queuePlanWindowReservation,
  recordPlanWindowReservation,
} from '../lib/plan-window-reservations.js';

const MIN = 60 * 1000;
const RES = 'plan-window-reservations.json';
const row = (now) => ({
  harness: 'h1', rateLimitType: 'seven_day', utilization: 40,
  resetsAt: new Date(now + 180 * MIN).toISOString(),
  observedAt: new Date(now - MIN).toISOString(),
  utilizationObservedAt: new Date(now - MIN).toISOString(),
});
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pw-iso-'));
const payload = (dir, key, now) => ({
  harness: 'h1', model: 'm1', role: 'implement', idempotencyKey: key,
  planLimits: [row(now)], now, dataDir: dir,
});

test('snapshot reads limits and reservations from the given dataDir only', () => {
  const now = Date.now();
  const dirA = tmp();
  const dirB = tmp();
  clearPlanWindowReservationCache();
  try {
    for (const d of [dirA, dirB]) fs.writeFileSync(path.join(d, 'harness-plan-limits.json'), JSON.stringify([row(now)]));
    assert.equal(recordPlanWindowReservation(payload(dirA, 'd1:a1', now)).recorded, 1);
    const withRes = JSON.stringify(planHeadroomSnapshotFor('h1', 'm1', '', dirA));
    const without = JSON.stringify(planHeadroomSnapshotFor('h1', 'm1', '', dirB));
    assert.notEqual(withRes, without, 'reservation in dirA must be visible only for dirA');
    assert.ok(!fs.existsSync(path.join(ISOLATED_DATA_DIR, RES)), 'nothing written to the default data dir');
  } finally {
    clearPlanWindowReservationCache();
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  }
});

test('retry queue is isolated per dataDir: an entry never lands in another store', () => {
  const now = Date.now();
  const dirA = tmp();
  const dirB = tmp();
  clearPlanWindowReservationQueue();
  clearPlanWindowReservationCache();
  try {
    queuePlanWindowReservation(payload(dirA, 'd1:a1', now));
    assert.deepEqual(flushPlanWindowReservations({ dataDir: dirB, now }), { flushed: 0, remaining: 0 });
    assert.ok(!fs.existsSync(path.join(dirB, RES)));
    assert.deepEqual(flushPlanWindowReservations({ dataDir: dirA, now }), { flushed: 1, remaining: 0 });
    assert.ok(fs.existsSync(path.join(dirA, RES)));
    assert.ok(!fs.existsSync(path.join(dirB, RES)));
    assert.ok(!fs.existsSync(path.join(ISOLATED_DATA_DIR, RES)));
  } finally {
    clearPlanWindowReservationQueue();
    clearPlanWindowReservationCache();
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  }
});
