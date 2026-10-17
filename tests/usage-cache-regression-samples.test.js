import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { evaluateSamplesCacheRegression } from '../lib/usage/cache-regression-samples.js';

const MIN = 60 * 1000;
const T0 = Date.parse('2026-01-01T00:00:00Z');
const sample = (n, overrides = {}) => ({
  chatId: 'c1', observedAt: new Date(T0 + n * MIN).toISOString(), inputTokens: 10000, cacheReadTokens: 9000,
  contextEpoch: 0, prefixFingerprint: 'p1', ...overrides,
});

// A warm turn that lost its cache is a regression.
const regressed = evaluateSamplesCacheRegression([sample(0), sample(1), sample(2, { cacheReadTokens: 0 })], { ttlMs: 5 * MIN });
assert.equal(regressed.status, 'regression');
assert.equal(regressed.signals[0].id, 'cache_hit_ratio_drop');

// Healthy, cold-start and unmeasured streams never report a false regression.
assert.equal(evaluateSamplesCacheRegression([sample(0), sample(1), sample(2)]).status, 'ok');
assert.equal(evaluateSamplesCacheRegression([sample(0), sample(1, { contextEpoch: 1, cacheReadTokens: 0 })]).status, 'cold_start');
assert.equal(evaluateSamplesCacheRegression([sample(0), sample(1, { cacheReadTokens: 0 })], { ttlMs: MIN / 2 }).status, 'cold_start');
const unmeasured = [sample(0, { cacheReadTokens: null }), sample(1, { cacheReadTokens: null })];
assert.equal(evaluateSamplesCacheRegression(unmeasured).status, 'insufficient_data');
assert.equal(evaluateSamplesCacheRegression([]).status, 'insufficient_data');

// Cache reads reported separately from input are normalized (ratio stays <= 1, no false drop).
const separate = (n) => sample(n, { inputTokens: 1000, cacheReadTokens: 9000 });
const normalized = evaluateSamplesCacheRegression([separate(0), separate(1), separate(2)]);
assert.equal(normalized.status, 'ok');

console.log('usage-cache-regression-samples.test.js OK');
