import test from 'node:test';
import assert from 'node:assert/strict';
import { createRollingWindowCache } from '../lib/usage-window-cache.js';

test('rolling window cache reuses a read inside the TTL and refreshes after it', () => {
  let clock = 1_000_000;
  const ranges = [];
  const cache = createRollingWindowCache({
    read: (range) => {
      ranges.push(range);
      return ranges.length;
    },
    windowMs: 60_000,
    ttlMs: 20_000,
    now: () => clock,
  });
  assert.equal(cache.get(), 1);
  clock += 19_000;
  assert.equal(cache.get(), 1, 'served from cache inside the TTL');
  assert.equal(ranges.length, 1);
  clock += 2_000;
  assert.equal(cache.get(), 2, 'refreshed after the TTL');
  assert.equal(new Date(ranges[1].to).getTime() - new Date(ranges[1].from).getTime(), 60_000);
  assert.equal(new Date(ranges[1].to).getTime(), clock);
  cache.clear();
  assert.equal(cache.get(), 3, 'clear forces a read');
});
