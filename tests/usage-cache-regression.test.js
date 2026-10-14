import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import {
  CACHE_COLD_START_CAUSE as CAUSE,
  CACHE_REGRESSION_SIGNAL as SIGNAL,
  CACHE_REGRESSION_STATUS as STATUS,
  detectCacheRegression,
} from '../lib/usage/cache-regression.js';

const MIN = 60 * 1000;
const TTL = 5 * MIN;
const obs = (at, overrides = {}) => ({
  at,
  cacheRead: 9000,
  inputTokens: 10000,
  costUsd: 0.02,
  latencyMs: 4000,
  prefixFingerprint: 'p1',
  generation: 0,
  ...overrides,
});

// Cold start is never a regression: first turn, even with a zero hit ratio.
assert.deepEqual(
  [detectCacheRegression([obs(0, { cacheRead: 0 })], { ttlMs: TTL })].map((r) => [r.status, r.coldStartCause]),
  [[STATUS.COLD_START, CAUSE.FIRST_TURN]],
);

// Expected cold causes: changed prefix, new generation, idle gap past the TTL.
assert.equal(
  detectCacheRegression([obs(0), obs(MIN, { cacheRead: 0, prefixFingerprint: 'p2' })], { ttlMs: TTL }).coldStartCause,
  CAUSE.PREFIX_CHANGED,
);
assert.equal(
  detectCacheRegression([obs(0), obs(MIN, { cacheRead: 0, generation: 1 })], { ttlMs: TTL }).coldStartCause,
  CAUSE.GENERATION_CHANGED,
);
const expired = detectCacheRegression([obs(0), obs(TTL + MIN, { cacheRead: 0 })], { ttlMs: TTL });
assert.equal(expired.status, STATUS.COLD_START);
assert.equal(expired.coldStartCause, CAUSE.TTL_EXPIRED);

// Unknown TTL: the gap alone is not enough to excuse a miss, so it is a regression.
const unknownTtl = detectCacheRegression([obs(0), obs(10 * MIN), obs(20 * MIN, { cacheRead: 0 })], { ttlMs: null });
assert.equal(unknownTtl.status, STATUS.REGRESSION);

// Warm turns with a hit drop / cost / latency increase are regressions.
const warm = [obs(0), obs(MIN), obs(2 * MIN)];
assert.equal(detectCacheRegression(warm, { ttlMs: TTL }).status, STATUS.OK);
const dropped = detectCacheRegression([...warm, obs(3 * MIN, { cacheRead: 500, costUsd: 0.09, latencyMs: 12000 })], { ttlMs: TTL });
assert.equal(dropped.status, STATUS.REGRESSION);
assert.deepEqual(
  dropped.signals.map((s) => s.id).sort(),
  [SIGNAL.COST_INCREASE, SIGNAL.HIT_RATIO_DROP, SIGNAL.LATENCY_INCREASE].sort(),
);
assert.ok(dropped.baselineTurns >= 2);

// Missing metrics are not zero: no signal and no false regression.
const sparse = detectCacheRegression([
  { at: 0, prefixFingerprint: 'p1', generation: 0 },
  { at: MIN, prefixFingerprint: 'p1', generation: 0 },
], { ttlMs: TTL });
assert.equal(sparse.status, STATUS.INSUFFICIENT_DATA);
assert.deepEqual(sparse.signals, []);
assert.equal(detectCacheRegression([], {}).status, STATUS.INSUFFICIENT_DATA);

console.log('usage-cache-regression.test.js OK');
