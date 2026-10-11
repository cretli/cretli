/**
 * Integration of audited overrides with the picker and the named start gate.
 *
 * The picker must remove an excluded harness/model from the whole candidate
 * pool, must promote a `prefer` pair only when it survived the shared hard
 * gates, and must refuse a conflicting explicit override before ranking. The
 * named start gate must re-read the overrides (TTL included) and merge their
 * excludes into the one shared validator.
 */

import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import { pickModelForPurpose } from '../lib/model-pick-service.js';
import { buildModelPickHistory } from '../lib/model-pick-history.js';
import {
  buildNamedDelegationStartHardGateInput,
  evaluateDelegationStartHardGates,
} from '../lib/delegation-model-gates.js';
import { normalizeModelPickOverride } from '../lib/model-pick-overrides.js';

test.after(() => {
  removeIsolatedDataDir();
});

const harnesses = [
  { id: 'a', enabled: true, ready: true, can_delegate: true },
  { id: 'b', enabled: true, ready: true, can_delegate: true },
];
const modelsByHarness = {
  a: {
    favorites_configured: true,
    items: [
      { id: 'm-a', roles: ['implement'], cost_tier: 1, quality_tier: 3, speed_tier: 3 },
      { id: 'm-a2', roles: ['implement'], cost_tier: 1, quality_tier: 3, speed_tier: 3 },
    ],
  },
  b: { favorites_configured: true, items: [{ id: 'm-b', roles: ['implement'], cost_tier: 1, quality_tier: 3, speed_tier: 3 }] },
};
const planOnlyModels = {
  a: { favorites_configured: true, items: [{ id: 'm-a', roles: ['implement'], cost_tier: 1, quality_tier: 3, speed_tier: 3 }] },
  b: { favorites_configured: true, items: [{ id: 'm-b', roles: ['plan'], cost_tier: 1, quality_tier: 3, speed_tier: 3 }] },
};

/**
 * @param {object} [overrides]
 * @param {number} [ttlMs]
 * @param {string} [id]
 * @returns {object}
 */
function record(overrides = {}, ttlMs = 60 * 60 * 1000, id = 'ov-1') {
  const now = Date.now();
  return normalizeModelPickOverride({
    action: 'exclude',
    targetHarness: 'codex',
    reason: 'integration test override',
    expiresAt: new Date(now + ttlMs).toISOString(),
    ...overrides,
  }, { now, createdBy: 'operator', source: 'test', generateId: () => id });
}

/**
 * @param {object} [extra]
 * @returns {object}
 */
function pickInput(extra = {}) {
  const now = Date.now();
  return {
    role: 'implement',
    harnesses,
    modelsByHarness,
    rotation: { mode: 'off' },
    explore: false,
    now,
    history: buildModelPickHistory({ role: 'implement', harnesses, delegations: [], now, lockouts: [], planLimits: [] }),
    noHistory: true,
    ...extra,
  };
}

test('a pair exclude removes only that harness/model from the picker pool', () => {
  const base = pickModelForPurpose(pickInput());
  assert.equal(base.ok, true);
  const blockedHarness = 'a';
  const blockedModel = 'm-a';
  const overrides = [record({
    action: 'exclude',
    targetHarness: blockedHarness,
    targetModel: blockedModel,
  }, undefined, 'pair-ex')];
  const picked = pickModelForPurpose(pickInput({ overrideRows: overrides }));
  assert.equal(picked.ok, true);
  assert.notEqual(picked.pick.harness === blockedHarness && picked.pick.model === blockedModel, true);
  const stillHasA = picked.candidates.some((row) => row.harness === 'a');
  assert.equal(stillHasA, true, 'other models on the excluded harness stay eligible');
});

test('an exclude override removes the pair from the picker pool', () => {
  const base = pickModelForPurpose(pickInput());
  assert.equal(base.ok, true);
  const excludedHarness = base.pick.harness;
  const overrides = [record({ action: 'exclude', targetHarness: excludedHarness }, undefined, 'ex-1')];
  const excluded = pickModelForPurpose(pickInput({ overrideRows: overrides }));
  assert.equal(excluded.ok, true);
  assert.notEqual(excluded.pick.harness, excludedHarness);
  assert.equal(excluded.overrides.active.includes('ex-1'), true);
});

test('a prefer override promotes a pair that survived the gates', () => {
  const preferred = 'b';
  const overrides = [record({ action: 'prefer', targetHarness: preferred, targetModel: 'm-b' }, undefined, 'pref-1')];
  const picked = pickModelForPurpose(pickInput({ overrideRows: overrides }));
  assert.equal(picked.ok, true);
  assert.equal(picked.pick.harness, preferred);
  assert.equal(picked.overrides.preferred_applied, true);
});

test('a prefer override cannot grant a role the model does not claim', () => {
  const overrides = [record({ action: 'prefer', targetHarness: 'b', targetModel: 'm-b' }, undefined, 'pref-2')];
  const picked = pickModelForPurpose(pickInput({ modelsByHarness: planOnlyModels, overrideRows: overrides }));
  assert.equal(picked.ok, true);
  assert.equal(picked.pick.harness, 'a');
  assert.notEqual(picked.overrides.preferred_applied, true);
});

test('a conflicting explicit override refuses the picker before ranking', () => {
  const overrides = [
    record({ action: 'explicit-orchestrator', targetHarness: 'a', targetModel: 'm-a' }, undefined, 'exp-1'),
    record({ action: 'explicit-orchestrator', targetHarness: 'b', targetModel: 'm-b' }, undefined, 'exp-2'),
  ];
  const picked = pickModelForPurpose(pickInput({ overrideRows: overrides }));
  assert.equal(picked.ok, false);
  assert.equal(picked.code, 'override_conflict');
});

test('the named start gate merges override excludes and reports the TTL window', () => {
  const overrides = [record({ action: 'exclude', targetHarness: 'codex' }, undefined, 'start-ex')];
  const gateInput = buildNamedDelegationStartHardGateInput({
    role: 'implement',
    harness: 'codex',
    model: 'gpt-5',
    overrideRows: overrides,
    harnessRow: { enabled: true, ready: true, can_delegate: true },
  });
  assert.ok(gateInput.excludeHarnesses.includes('codex'));
  assert.deepEqual(gateInput.overrideSummary.active, ['start-ex']);

  const verdict = evaluateDelegationStartHardGates({
    role: 'implement',
    harness: 'codex',
    model: 'gpt-5',
    harnessRow: { enabled: true, ready: true, can_delegate: true },
    excludeHarnesses: gateInput.excludeHarnesses,
    favoritesConfigured: true,
    favoriteModels: ['gpt-5'],
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'harness_excluded');
});

test('an override that already expired is not merged at start', () => {
  const overrides = [record({ action: 'exclude', targetHarness: 'codex' }, 120 * 1000, 'old-ex')];
  const gateInput = buildNamedDelegationStartHardGateInput({
    role: 'implement',
    harness: 'codex',
    model: 'gpt-5',
    overrideRows: overrides,
    harnessRow: { enabled: true, ready: true, can_delegate: true },
    now: Date.now() + 300 * 1000,
  });
  assert.ok(!gateInput.excludeHarnesses.includes('codex'));
  assert.deepEqual(gateInput.overrideSummary.active, []);
});
