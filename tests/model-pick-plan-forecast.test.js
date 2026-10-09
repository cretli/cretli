import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import {
  PLAN_LIMIT_PENALTY,
  PLAN_LIMIT_PENALTY_MAX,
  PLAN_LIMIT_TYPICAL_TASK_MS,
  PLAN_LIMIT_UTILIZATION,
  PLAN_LIMIT_WARN_UTILIZATION,
  selectModelPick,
} from '../lib/model-role-profiles.js';

// Focused contract for the proportional plan-limit penalty consumed by
// `selectModelPick`: it must read the forecast before utilization reaches 90%
// while keeping the no-data behavior and the hard 90% floor intact.

const harness = { id: 'a', enabled: true, ready: true, can_delegate: true };
const models = {
  a: {
    favorites_configured: true,
    items: [{ id: 'a-model', roles: ['implement'], cost_tier: 2, quality_tier: 4, speed_tier: 3 }],
  },
};
const NOW = Date.parse('2026-01-01T00:00:00Z');
const FUTURE = '2099-01-01T00:00:00Z';

/**
 * @param {object[]} planLimits
 * @returns {number}
 */
function penaltyFor(planLimits) {
  const result = selectModelPick({
    role: 'implement',
    harnesses: [harness],
    modelsByHarness: models,
    rotation: 'balanced',
    explore: false,
    now: NOW,
    history: { planLimits },
  });
  assert.equal(result.ok, true, 'a plan penalty never removes the only candidate');
  assert.equal(result.candidates[0].harness, 'a');
  return result.candidates[0].plan_limit_penalty;
}

/**
 * @param {object} [overrides]
 * @returns {object}
 */
function forecast(overrides = {}) {
  return {
    exhaustsAt: FUTURE,
    beforeReset: false,
    percentPerHour: 0,
    remainingMs: 6 * 60 * 60 * 1000,
    ...overrides,
  };
}

/**
 * @param {number[]} values
 * @param {string} label
 * @returns {void}
 */
function assertNonDecreasing(values, label) {
  for (let i = 1; i < values.length; i += 1) {
    assert.ok(values[i] >= values[i - 1] - 1e-9, `${label} must be monotonic: ${JSON.stringify(values)}`);
  }
}

// (a) A near-exhaustion forecast penalises a window below 90% utilization.
const nearExhaustion = penaltyFor([{
  harness: 'a',
  utilization: 50,
  resetsAt: FUTURE,
  confidence: 'high',
  forecast: forecast({ beforeReset: true, percentPerHour: 40, remainingMs: 0 }),
}]);
assert.ok(nearExhaustion > 0, 'a near-exhaustion forecast penalises below 90%');
assert.equal(nearExhaustion, PLAN_LIMIT_PENALTY_MAX, 'imminent exhaustion reaches the cap');

// (b) A healthy window with a real forecast is free.
assert.equal(penaltyFor([{
  harness: 'a',
  utilization: 20,
  resetsAt: FUTURE,
  confidence: 'high',
  forecast: forecast({ percentPerHour: 2 }),
}]), 0, 'a healthy window is not penalised');

// (c) No forecast / no confidence / missing utilization => no-data penalty.
assert.equal(penaltyFor([{ harness: 'a', utilization: 80, resetsAt: FUTURE }]), 0,
  'no forecast and utilization < 90 stays at 0');
assert.equal(penaltyFor([{ harness: 'a', utilization: 80, resetsAt: FUTURE, confidence: 'none', forecast: null }]), 0,
  'confidence none stays at 0');
assert.equal(penaltyFor([{
  harness: 'a',
  utilization: 50,
  resetsAt: FUTURE,
  confidence: 'none',
  forecast: forecast({ beforeReset: true, remainingMs: 0 }),
}]), 0, 'a forecast without confidence is not consumed');
assert.equal(penaltyFor([{
  harness: 'a',
  utilization: 50,
  resetsAt: FUTURE,
  forecast: forecast({ beforeReset: true, remainingMs: 0 }),
}]), 0, 'a forecast without a confidence level is not consumed');
assert.equal(penaltyFor([{
  harness: 'a',
  utilization: null,
  resetsAt: FUTURE,
  confidence: 'high',
  forecast: forecast({ beforeReset: true, remainingMs: 0 }),
}]), 0, 'missing utilization stays at 0');

// (d) Stale / expired / reset-in-the-past rows never penalise.
assert.equal(penaltyFor([{
  harness: 'a',
  utilization: 95,
  resetsAt: FUTURE,
  stale: true,
  confidence: 'high',
  forecast: forecast({ beforeReset: true, remainingMs: 0 }),
}]), 0, 'a stale row keeps the no-data penalty');
assert.equal(penaltyFor([{
  harness: 'a',
  utilization: 95,
  resetsAt: FUTURE,
  expired: true,
  confidence: 'high',
  forecast: forecast({ beforeReset: true, remainingMs: 0 }),
}]), 0, 'an expired row keeps the no-data penalty');
assert.equal(penaltyFor([{
  harness: 'a',
  utilization: 95,
  resetsAt: '2000-01-01T00:00:00Z',
  confidence: 'high',
  forecast: forecast({ beforeReset: true, remainingMs: 0 }),
}]), 0, 'a reset already in the past keeps the no-data penalty');

// (e) The historical 90% floor is preserved with and without a forecast.
assert.equal(penaltyFor([{ harness: 'a', utilization: PLAN_LIMIT_UTILIZATION, resetsAt: FUTURE }]),
  PLAN_LIMIT_PENALTY, 'utilization at the threshold keeps the floor without a forecast');
assert.equal(penaltyFor([{ harness: 'a', utilization: 100, resetsAt: FUTURE }]),
  PLAN_LIMIT_PENALTY, 'full utilization keeps at least the floor');
assert.ok(penaltyFor([{
  harness: 'a',
  utilization: 95,
  resetsAt: FUTURE,
  confidence: 'high',
  forecast: forecast({ beforeReset: true, remainingMs: 0 }),
}]) >= PLAN_LIMIT_PENALTY, 'a forecast cannot lower the 90% floor');

// The proportional utilization ramp starts exactly at the warning threshold.
assert.equal(penaltyFor([{
  harness: 'a',
  utilization: PLAN_LIMIT_WARN_UTILIZATION,
  resetsAt: FUTURE,
  confidence: 'high',
  forecast: forecast(),
}]), 0, 'the ramp starts at the warning threshold');
assert.ok(penaltyFor([{
  harness: 'a',
  utilization: PLAN_LIMIT_WARN_UTILIZATION + 10,
  resetsAt: FUTURE,
  confidence: 'high',
  forecast: forecast(),
}]) > 0, 'the ramp grows above the warning threshold');

// (f) Monotonicity: less margin / more utilization / faster growth never lowers
// the penalty. Forecast fields drive the low-utilization cases.
assertNonDecreasing(
  [0.8, 1, 12, 50, PLAN_LIMIT_WARN_UTILIZATION, 80, 89.9, 90, 95, 100]
    .map((utilization) => penaltyFor([{ harness: 'a', utilization, resetsAt: FUTURE }])),
  'utilization',
);
assertNonDecreasing(
  [PLAN_LIMIT_TYPICAL_TASK_MS * 2, PLAN_LIMIT_TYPICAL_TASK_MS, PLAN_LIMIT_TYPICAL_TASK_MS / 2, 0]
    .map((remainingMs) => penaltyFor([{
      harness: 'a',
      utilization: 50,
      resetsAt: FUTURE,
      confidence: 'high',
      forecast: forecast({ beforeReset: true, remainingMs }),
    }])),
  'remaining margin',
);
assertNonDecreasing(
  [0, 8, 15, 32, 100]
    .map((percentPerHour) => penaltyFor([{
      harness: 'a',
      utilization: 50,
      resetsAt: FUTURE,
      confidence: 'high',
      forecast: forecast({ percentPerHour }),
    }])),
  'growth rate',
);

// The strongest matching window wins and the total stays finite and bounded.
const strongestWindow = penaltyFor([
  {
    harness: 'a',
    utilization: 50,
    resetsAt: FUTURE,
    confidence: 'high',
    forecast: forecast({ percentPerHour: 2 }),
  },
  {
    harness: 'a',
    utilization: 50,
    resetsAt: FUTURE,
    confidence: 'high',
    forecast: forecast({ beforeReset: true, percentPerHour: 40, remainingMs: 0 }),
  },
]);
assert.equal(strongestWindow, PLAN_LIMIT_PENALTY_MAX, 'the strongest window drives the harness penalty');
const extreme = penaltyFor([{
  harness: 'a',
  utilization: 100,
  resetsAt: FUTURE,
  confidence: 'high',
  forecast: forecast({ beforeReset: true, percentPerHour: 1000, remainingMs: 0 }),
}]);
assert.ok(Number.isFinite(extreme) && extreme <= PLAN_LIMIT_PENALTY_MAX, 'the total penalty stays capped');

// (g) The acceptance case: A with a near-exhaustion forecast loses to a
// same-quality B with a healthy window.
const tieHarnesses = ['a', 'b'].map((id) => ({ id, enabled: true, ready: true, can_delegate: true }));
const tieModels = Object.fromEntries(['a', 'b'].map((id) => [id, {
  favorites_configured: true,
  items: [{ id: `${id}-model`, roles: ['implement'], cost_tier: 2, quality_tier: 4, speed_tier: 3 }],
}]));
const tiePick = selectModelPick({
  role: 'implement',
  harnesses: tieHarnesses,
  modelsByHarness: tieModels,
  rotation: 'balanced',
  explore: false,
  now: NOW,
  history: {
    planLimits: [
      {
        harness: 'a',
        utilization: 72,
        resetsAt: FUTURE,
        confidence: 'high',
        forecast: forecast({ beforeReset: true, percentPerHour: 40, remainingMs: 60_000 }),
      },
      {
        harness: 'b',
        utilization: 10,
        resetsAt: FUTURE,
        confidence: 'high',
        forecast: forecast({ percentPerHour: 1 }),
      },
    ],
  },
});
assert.equal(tiePick.pick.harness, 'b', 'A with a near-exhaustion forecast loses to a healthy B');
assert.ok(tiePick.candidates.find((row) => row.harness === 'a').plan_limit_penalty > 0);
assert.equal(tiePick.candidates.find((row) => row.harness === 'b').plan_limit_penalty, 0);

removeIsolatedDataDir();
console.log('model-pick-plan-forecast.test.js OK');
