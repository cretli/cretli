import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getPoolRoundMembershipReadCount,
  normalizeCodeReviewPoolRound,
  normalizeCodeReviewPoolHistory,
} from '../lib/delegation-pool-round.js';

test('normalizing the same raw pool round repeatedly reads the membership map once', () => {
  const raw = { key: 'k', mode: 'audit', started: ['a', 'b'], memberships: { a: 'member', b: 'Learning' } };
  const before = getPoolRoundMembershipReadCount();
  let last = null;
  for (let i = 0; i < 50; i += 1) last = normalizeCodeReviewPoolRound(raw);
  assert.equal(getPoolRoundMembershipReadCount() - before, 1);
  assert.deepEqual(last?.memberships, { a: 'member', b: 'learning' });
  // Distinct raw objects are still normalized independently.
  normalizeCodeReviewPoolRound({ ...raw });
  assert.equal(getPoolRoundMembershipReadCount() - before, 2);
});

test('history normalization reuses per-record results across passes', () => {
  const history = [1, 2, 3].map((n) => ({ key: `k${n}`, mode: 'closure', started: [`s${n}`], memberships: { [`s${n}`]: 'member' } }));
  const before = getPoolRoundMembershipReadCount();
  for (let i = 0; i < 10; i += 1) normalizeCodeReviewPoolHistory(history);
  assert.equal(getPoolRoundMembershipReadCount() - before, 3);
});
