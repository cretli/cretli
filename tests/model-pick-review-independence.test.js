/**
 * A diverse review fanout (count >= 2) must be able to start two independent
 * reviewers even when one harness is a measured high-infra pair: the high-infra
 * gate is relaxed only for a harness the pick does not yet represent.
 */
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import assert from 'node:assert/strict';
import { selectModelPick } from '../lib/model-role-profiles.js';

const harnesses = [
  { id: 'ha', enabled: true, ready: true, can_delegate: true },
  { id: 'hb', enabled: true, ready: true, can_delegate: true },
];
const item = (id) => ({ id, roles: ['review'], cost_tier: 2, quality_tier: 4, speed_tier: 3 });
const modelsByHarness = {
  ha: { favorites_configured: true, items: [item('model-a')] },
  hb: { favorites_configured: true, items: [item('model-b')] },
};
const history = {
  prior: { infra_fail_rate: 0.02 },
  observed: {
    'ha/model-a': { n: 20, pass_rate: 0.9, infra_fail_rate: 0.1, completion_rate: 0.95, median_min: 2, quality: 4 },
    'hb/model-b': { n: 20, pass_rate: 0.8, infra_fail_rate: 0.7, completion_rate: 0.95, median_min: 2, quality: 4 },
  },
};
const base = { role: 'review', harnesses, modelsByHarness, history };

// Without a fanout the high-infra pair stays dropped (hard gate unchanged).
const single = selectModelPick({ ...base });
assert.equal(single.picks.length, 1);
assert.equal(single.pick.harness, 'ha');
assert.equal(single.candidates.some((row) => row.harness === 'hb'), false, 'high-infra pair is dropped for a single pick');

// A diverse count=2 review admits the missing harness so two reviewers exist.
const pair = selectModelPick({ ...base, count: 2, diverse: true });
assert.deepEqual(pair.picks.map((row) => row.harness).sort(), ['ha', 'hb'], 'two independent reviewers');
assert.equal(pair.pick.harness, 'ha', 'the healthy harness stays the first pick');
assert.equal(pair.rotation.high_infra_relaxed_harnesses, 1, 'the relaxation is reported');

// A caller hard exclusion can remove the healthy leader. Remaining eligible
// review favorites must not disappear solely because their measured infra
// risk placed them outside the ordinary safe rotation pool.
const excludedLeader = selectModelPick({
  ...base,
  excludeHarness: 'ha',
});
assert.equal(excludedLeader.ok, true, 'eligible review favorite remains after hard exclusion');
assert.equal(excludedLeader.pick.harness, 'hb');
assert.equal(excludedLeader.rotation.high_infra_review_fallback, true);

// Diverse fanout fills its second slot from another eligible harness even
// when its score is outside the normal tie band.
const outOfBandPair = selectModelPick({
  role: 'review',
  count: 2,
  diverse: true,
  rotation: { band: 0.01, mode: 'balanced' },
  harnesses,
  modelsByHarness: {
    ha: { favorites_configured: true, items: [item('best')] },
    hb: { favorites_configured: true, items: [{ ...item('lower'), quality_tier: 1, cost_tier: 5 }] },
  },
});
assert.equal(outOfBandPair.picks.length, 2);
assert.deepEqual(new Set(outOfBandPair.picks.map((row) => row.harness)), new Set(['ha', 'hb']));

// Only the two-reviewer fanout is relaxed; a larger multi-pick keeps the hard gate.
const three = selectModelPick({ ...base, count: 3, diverse: true });
assert.equal(three.picks.some((row) => row.harness === 'hb'), false, "count 3 keeps the hard gate");

// Non-diverse and non-review roles are untouched.
const notDiverse = selectModelPick({ ...base, count: 2 });
assert.equal(notDiverse.candidates.some((row) => row.harness === 'hb'), false, 'no relaxation without diverse');
const implement = selectModelPick({
  ...base,
  role: 'implement',
  count: 2,
  diverse: true,
  modelsByHarness: {
    ha: { favorites_configured: true, items: [{ ...item('model-a'), roles: ['implement'] }] },
    hb: { favorites_configured: true, items: [{ ...item('model-b'), roles: ['implement'] }] },
  },
});
assert.equal(implement.picks.some((row) => row.harness === 'hb'), false, 'implement keeps the hard gate');

// A harness already represented never gets its high-infra model added.
const sameHarness = selectModelPick({
  ...base,
  count: 2,
  diverse: true,
  modelsByHarness: {
    ha: { favorites_configured: true, items: [item('model-a'), item('model-c')] },
    hb: { favorites_configured: true, items: [item('model-b')] },
  },
  history: {
    ...history,
    observed: { ...history.observed, 'ha/model-c': { n: 20, pass_rate: 0.9, infra_fail_rate: 0.9, completion_rate: 0.9, median_min: 2, quality: 4 } },
  },
});
assert.equal(sameHarness.candidates.some((row) => row.model === 'model-c'), false, 'high-infra model of a represented harness stays out');

removeIsolatedDataDir();
console.log('model-pick-review-independence: ok');
