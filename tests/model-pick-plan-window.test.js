import assert from 'node:assert/strict';
import test from 'node:test';
import {
  newestReadingAgeMs,
  normalizeWindowType,
  planHeadroomLevel,
  PLAN_WINDOW_BONUS_STALE_MS,
} from '../lib/model-pick-plan-window.js';
import { requestPlanLimitsRefresh } from '../lib/model-pick-plan-refresh.js';
import { selectModelPick } from '../lib/model-role-profiles.js';

const NOW = Date.parse('2026-01-01T12:00:00Z');
const MIN = 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

/**
 * @param {object} [over]
 * @returns {object}
 */
function row(over = {}) {
  return {
    harness: 'h1', rateLimitType: 'five_hour', utilization: 20,
    resetsAt: iso(NOW + 3 * 60 * MIN), observedAt: iso(NOW - MIN),
    stale: false, expired: false, ...over,
  };
}

const level = (rows, over = {}) => planHeadroomLevel({
  planLimits: rows, harnessId: 'h1', modelId: 'm1', now: NOW, ...over,
});

test('normalizeWindowType strips the Codex bucket prefix and flags unknown suffixes', () => {
  assert.deepEqual(normalizeWindowType('five_hour'), { limitId: '', type: 'five_hour', known: true });
  assert.deepEqual(normalizeWindowType('gpt-x:seven_day'), { limitId: 'gpt-x', type: 'seven_day', known: true });
  assert.equal(normalizeWindowType('gpt-x:primary_300').known, false);
  assert.equal(normalizeWindowType('secondary_60').type, '');
});

test('newestReadingAgeMs counts every harness row, including model-scoped windows', () => {
  const rows = [
    row({ rateLimitType: 'seven_day_opus', observedAt: iso(NOW - 2 * MIN) }),
    row({ observedAt: iso(NOW - 40 * MIN) }),
  ];
  assert.equal(newestReadingAgeMs(rows, 'h1', NOW), 2 * MIN);
  const bucket = [row({ rateLimitType: 'gpt-5:seven_day', observedAt: iso(NOW - MIN) })];
  assert.equal(newestReadingAgeMs(bucket, 'h1', NOW), MIN);
  // Another harness and unknown reading times do not contribute.
  assert.equal(newestReadingAgeMs(rows, 'h2', NOW), null);
  assert.equal(newestReadingAgeMs([row({ observedAt: 'n/a' })], 'h1', NOW), null);
});

test('headroom levels quantize free percent and reset urgency', () => {
  assert.equal(level([row({ utilization: 10 })]), 3);
  assert.equal(level([row({ utilization: 30 })]), 2);
  assert.equal(level([row({ utilization: 60 })]), 1);
  assert.equal(level([row({ utilization: 85 })]), 0);
  // 50% free but resetting within the hour: use it before it expires.
  assert.equal(level([row({ utilization: 50, resetsAt: iso(NOW + 30 * MIN) })]), 3);
  assert.equal(level([row({ utilization: 70, resetsAt: iso(NOW + 30 * MIN) })]), 1);
});

test('neutral for stale, expired, scope mismatch, no reset, old or future reading, no window', () => {
  const base = { utilization: 5 };
  assert.equal(level([row({ ...base, stale: true })]), 1);
  assert.equal(level([row({ ...base, expired: true })]), 1);
  assert.equal(level([row({ ...base, scopeMismatch: true })]), 1);
  assert.equal(level([row({ ...base, resetsAt: undefined })]), 1);
  assert.equal(level([row({ ...base, resetsAt: iso(NOW - MIN) })]), 1);
  assert.equal(level([row({ ...base, observedAt: iso(NOW - PLAN_WINDOW_BONUS_STALE_MS - MIN) })]), 1);
  assert.equal(level([row({ ...base, observedAt: iso(NOW + 30 * MIN) })]), 1);
  assert.equal(level([row({ ...base, utilizationObservedAt: iso(NOW - 25 * MIN) })]), 1);
  assert.equal(level([]), 1);
  assert.equal(level([row({ ...base, rateLimitType: 'seven_day' })]), 1);
});

test('multiple buckets of the same type use the highest utilization', () => {
  assert.equal(level([row({ utilization: 10 }), row({ utilization: 90, rateLimitType: 'codex:five_hour' })]), 0);
});

test('model buckets apply only to the matching model; whole-harness bucket to all', () => {
  const rows = [row({ harness: 'h1', rateLimitType: 'm2:five_hour', utilization: 95 })];
  assert.equal(level(rows, { modelId: 'm1' }), 1);
  assert.equal(level(rows, { modelId: 'm2' }), 0);
  const codex = [row({ rateLimitType: 'codex:five_hour', utilization: 95 })];
  assert.equal(level(codex, { modelId: 'anything' }), 0);
});

test('a model bucket is matched exactly, not by substring', () => {
  const rows = [row({ rateLimitType: 'gpt-5-codex-mini:five_hour', utilization: 95 })];
  assert.equal(level(rows, { modelId: 'gpt-5' }), 1);
  assert.equal(level(rows, { modelId: 'gpt-5-codex-mini' }), 0);
  assert.equal(level(rows, { modelId: 'gpt-5-codex' }), 1);
});

test('disabled config is neutral', () => {
  assert.equal(level([row({ utilization: 5 })], { config: { enabled: false } }), 1);
});

const harness = (id) => ({ id, enabled: true, ready: true, can_delegate: true });
const modelsFor = (id, model) => ({
  favorites_configured: true,
  items: [{ id: model, roles: ['implement'], cost_tier: 2, quality_tier: 4, speed_tier: 3 }],
});

/**
 * @param {object} [over]
 */
function pick(over = {}) {
  return selectModelPick({
    role: 'implement',
    harnesses: [harness('h1'), harness('h2')],
    modelsByHarness: { h1: modelsFor('h1', 'm1'), h2: modelsFor('h2', 'm2') },
    rotation: 'balanced',
    explore: false,
    now: NOW,
    ...over,
  });
}

test('acceptance: same score and band, 5h free 80% beats 20%, in every ordering path', () => {
  const planLimits = [
    row({ harness: 'h1', utilization: 80 }),
    row({ harness: 'h2', utilization: 20 }),
  ];
  // h1 would win the id tie-break; headroom must override it.
  const result = pick({ history: { planLimits } });
  assert.equal(result.pick.harness, 'h2');
  assert.equal(result.candidates[0].plan_headroom_level, 2);
  assert.match(result.pick.reason, /5h plan headroom level 2/);
  const heuristic = pick({ history: { planLimits }, adaptive: false });
  assert.equal(heuristic.pick.harness, 'h2');
  const withExploreOff = pick({ history: { planLimits }, explore: false });
  assert.equal(withExploreOff.pick.harness, 'h2');
});

test('rotation=off, disabled config and no data ignore the bonus', () => {
  const planLimits = [row({ harness: 'h1', utilization: 80 }), row({ harness: 'h2', utilization: 20 })];
  const baseline = pick({ history: {} }).pick.harness;
  assert.equal(pick({ history: { planLimits }, planWindowConfig: { enabled: false } }).pick.harness, baseline);
  assert.equal(pick({ history: { planLimits }, rotation: 'off' }).pick.harness,
    pick({ history: {}, rotation: 'off' }).pick.harness);
});

test('bonus does not widen the band: a lower-score candidate with plenty of headroom stays out', () => {
  const planLimits = [row({ harness: 'h1', utilization: 95 }), row({ harness: 'h2', utilization: 0 })];
  const models = {
    h1: { favorites_configured: true, items: [{ id: 'm1', roles: ['implement'], cost_tier: 2, quality_tier: 5, speed_tier: 5 }] },
    h2: { favorites_configured: true, items: [{ id: 'm2', roles: ['implement'], cost_tier: 2, quality_tier: 1, speed_tier: 1 }] },
  };
  const result = pick({ modelsByHarness: models, history: { planLimits } });
  assert.equal(result.pick.harness, 'h1');
});

test('model-scoped opus window penalises only Opus when enabled; legacy penalises the harness', () => {
  // 92% stays below the hard weekly gate (95%) so only the soft penalty applies.
  const planLimits = [row({ harness: 'h1', rateLimitType: 'seven_day_opus', utilization: 92 })];
  const models = {
    h1: { favorites_configured: true, items: [
      { id: 'claude-sonnet-5', roles: ['implement'], cost_tier: 2, quality_tier: 4, speed_tier: 3 },
      { id: 'claude-opus-5', roles: ['implement'], cost_tier: 2, quality_tier: 4, speed_tier: 3 },
    ] },
  };
  const run = (cfg) => pick({ harnesses: [harness('h1')], modelsByHarness: { h1: models.h1 }, history: { planLimits }, planWindowConfig: cfg, count: 1 });
  const on = run({ enabled: true });
  const byModel = Object.fromEntries(on.candidates.map((c) => [c.model, c.plan_limit_penalty]));
  assert.equal(byModel['claude-sonnet-5'], 0);
  assert.ok(byModel['claude-opus-5'] > 0);
  const off = run({ enabled: false });
  assert.ok(off.candidates.every((c) => c.plan_limit_penalty > 0));
});

test('scoped penalty is neutral for an unrecognized window type; legacy still counts it', () => {
  // 92% stays below the hard weekly gate (95%) so only the soft penalty applies.
  const planLimits = [row({ rateLimitType: 'secondary_60', utilization: 92 })];
  const run = (cfg) => pick({
    harnesses: [harness('h1')],
    modelsByHarness: { h1: modelsFor('h1', 'claude-sonnet-5') },
    history: { planLimits },
    planWindowConfig: cfg,
  });
  assert.equal(run({ enabled: true }).candidates[0].plan_limit_penalty, 0);
  assert.ok(run({ enabled: false }).candidates[0].plan_limit_penalty > 0);
});

test('scoped penalty never counts seven_day_oauth_apps; legacy keeps the per-harness behavior', () => {
  const planLimits = [row({ rateLimitType: 'seven_day_oauth_apps', utilization: 92 })];
  const run = (cfg) => pick({
    harnesses: [harness('h1')],
    modelsByHarness: { h1: modelsFor('h1', 'claude-sonnet-5') },
    history: { planLimits },
    planWindowConfig: cfg,
  });
  assert.equal(run({ enabled: true }).candidates[0].plan_limit_penalty, 0);
  assert.ok(run({ enabled: false }).candidates[0].plan_limit_penalty > 0);
});

test('requestPlanLimitsRefresh is detached, deduplicated and only for old readings', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const refreshers = { codex: async () => { calls += 1; await gate; } };
  const fresh = [row({ harness: 'codex', observedAt: iso(NOW - MIN) })];
  assert.deepEqual(requestPlanLimitsRefresh({ planLimits: fresh, now: NOW, refreshers }), []);
  const old = [row({ harness: 'codex', observedAt: iso(NOW - 11 * MIN) })];
  assert.deepEqual(requestPlanLimitsRefresh({ planLimits: old, now: NOW, refreshers }), ['codex']);
  assert.deepEqual(requestPlanLimitsRefresh({ planLimits: old, now: NOW, refreshers }), []);
  assert.equal(calls, 1);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requestPlanLimitsRefresh({ planLimits: old, now: NOW, refreshers }), ['codex']);
  // Claude is skipped without a live query.
  release();
  assert.equal(requestPlanLimitsRefresh({ planLimits: [], now: NOW, refreshers: { codex: async () => {} } }).includes('claude'), false);
});
