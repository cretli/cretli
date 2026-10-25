import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  clearPlanWindowReservationCache,
  recordPlanWindowReservation,
} from '../lib/plan-window-reservations.js';
import { budgetMs } from './helpers/time-budget.js';

const NOW = Date.parse('2026-01-01T12:00:00Z');
const MIN = 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const FILE = 'plan-window-reservations.json';

const week = (over = {}) => ({
  harness: 'h1', rateLimitType: 'seven_day', utilization: 10,
  resetsAt: iso(NOW + 180 * MIN), observedAt: iso(NOW - MIN), ...over,
});

/** @param {number[]} sorted @param {number} p */
const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

const withDir = (fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-io-'));
  clearPlanWindowReservationCache();
  try {
    return fn(dir);
  } finally {
    clearPlanWindowReservationCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

test('100 synchronous writes stay well inside the blocking budget', () => withDir((dir) => {
  const durations = [];
  for (let i = 0; i < 100; i += 1) {
    const started = process.hrtime.bigint();
    const result = recordPlanWindowReservation({
      harness: 'h1', model: 'm1', role: 'implement', idempotencyKey: `io:${i}`,
      planLimits: [week()], now: NOW + i, dataDir: dir,
    });
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
    durations.push(elapsed);
    assert.equal(result.skipped, undefined, `write ${i} was skipped: ${result.skipped}`);
  }
  durations.sort((a, b) => a - b);
  const total = durations.reduce((sum, value) => sum + value, 0);
  const stats = {
    n: durations.length,
    min: percentile(durations, 0),
    median: percentile(durations, 0.5),
    p95: percentile(durations, 0.95),
    max: durations[durations.length - 1],
    total,
  };
  // Reported so a real slowdown is visible in CI logs, not only in the bound.
  console.log('[plan-window-reservations io]', JSON.stringify(stats));
  assert.ok(stats.max < 100, `slowest synchronous write ${stats.max.toFixed(2)}ms`);
  assert.ok(stats.p95 < 50, `p95 synchronous write ${stats.p95.toFixed(2)}ms`);
}));

test('a held lock returns lock-timeout without blocking the event loop', () => withDir((dir) => {
  fs.writeFileSync(path.join(dir, `${FILE}.lock`), 'other:token');
  const started = process.hrtime.bigint();
  const result = recordPlanWindowReservation({
    harness: 'h1', model: 'm1', role: 'implement', idempotencyKey: 'held:a',
    planLimits: [week()], now: NOW, dataDir: dir,
  });
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
  console.log('[plan-window-reservations held-lock]', JSON.stringify({ elapsed }));
  assert.equal(result.skipped, 'lock-timeout');
  assert.ok(elapsed < budgetMs(50), `held-lock call took ${elapsed.toFixed(2)}ms`);
}));
