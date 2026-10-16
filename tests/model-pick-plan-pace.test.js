import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildPlanPaceSignal,
  buildPlanPaceSnapshot,
  paceCostFactor,
  planWindowPace,
} from '../lib/model-pick-plan-window.js';
import { PLAN_WINDOW_ESTIMATE_PP } from '../lib/model-pick-plan-window-gate.js';
import {
  applyPlanWindowReservations,
  recordPlanWindowReservation,
} from '../lib/plan-window-reservations.js';
import { createDelegationRecord, getDelegationById } from '../lib/persist/delegations-persist.js';
import { buildDelegationCardModel } from '../lib/delegation-card-model.js';
import { PLAN_LIMIT_PENALTY_MAX, selectModelPick } from '../lib/model-role-profiles.js';
import { persistModelPickProposal } from '../lib/model-pick-decisions.js';
import { pickAndPersistModelForPurpose } from '../lib/model-pick-service.js';
import { getModelPickRecord } from '../lib/persist/model-pick-decisions-persist.js';
import { buildPlanPaceLine } from '../app_front/lib/delegation-plan-pace-line.js';
import { en } from '../app_front/i18n/en.js';
import { pl } from '../app_front/i18n/pl.js';

const NOW = Date.parse('2026-01-01T12:00:00Z');
const MIN = 60 * 1000;
const WEEK = 7 * 24 * 60 * MIN;
const iso = (ms) => new Date(ms).toISOString();
/** Reset time so that `pct` percent of the week has elapsed. */
const resetAt = (pct) => iso(NOW + WEEK * (1 - pct / 100));

function row(over = {}) {
  return {
    harness: 'h1', rateLimitType: 'seven_day', utilization: 60, resetsAt: resetAt(20),
    observedAt: iso(NOW - MIN), stale: false, expired: false, ...over,
  };
}
const signal = (rows, over = {}) => buildPlanPaceSignal({
  planLimits: rows, harnessId: 'h1', modelId: 'm1', now: NOW, ...over,
});

test('planWindowPace math and invalid input', () => {
  const pace = planWindowPace({ type: 'seven_day', utilization: 60, resetsAt: resetAt(20), now: NOW });
  assert.ok(Math.abs(pace.elapsedPct - 20) < 1e-9);
  assert.ok(Math.abs(pace.slackPct + 40) < 1e-9);
  const five = planWindowPace({ type: 'five_hour', utilization: 10, resetsAt: iso(NOW + 150 * MIN), now: NOW });
  assert.ok(Math.abs(five.elapsedPct - 50) < 1e-9);
  assert.equal(planWindowPace({ type: 'bogus', utilization: 1, resetsAt: resetAt(20), now: NOW }), null);
  assert.equal(planWindowPace({ type: 'seven_day_oauth_apps', utilization: 1, resetsAt: resetAt(20), now: NOW }), null);
  assert.equal(planWindowPace({ type: 'seven_day', utilization: 101, resetsAt: resetAt(20), now: NOW }), null);
  assert.equal(planWindowPace({ type: 'seven_day', utilization: -1, resetsAt: resetAt(20), now: NOW }), null);
  assert.equal(planWindowPace({ type: 'seven_day', utilization: 5, resetsAt: iso(NOW - MIN), now: NOW }), null);
  assert.equal(planWindowPace({ type: 'seven_day', utilization: 5, resetsAt: iso(NOW + 8 * 24 * 60 * MIN), now: NOW }), null);
});

test('level thresholds and boundaries', () => {
  // slack exactly -10 is not above pace; just beyond is.
  assert.equal(signal([row({ utilization: 30, resetsAt: resetAt(20) })]).level, 0, 'slack -10 is not enough');
  assert.equal(signal([row({ utilization: 30.1, resetsAt: resetAt(20) })]).level, -1);
  assert.equal(signal([row({ utilization: 29.9, resetsAt: resetAt(20) })]).level, 0);
  assert.equal(signal([row({ utilization: 21, resetsAt: resetAt(9) })]).level, 0, 'elapsed < 10% is noise');
  assert.equal(signal([row({ utilization: 21, resetsAt: resetAt(10) })]).level, -1);
  assert.equal(signal([row({ utilization: 50, resetsAt: resetAt(70) })]).level, 1);
  assert.equal(signal([row({ utilization: 55, resetsAt: resetAt(70) })]).level, 0, 'slack 15 is not enough');
  assert.equal(signal([row({ utilization: 10, resetsAt: resetAt(60) })]).level, 0, 'elapsed < 70%');
});

test('freshness, clock skew, scoping, disabled and worst window', () => {
  assert.equal(signal([row({ observedAt: iso(NOW - 21 * MIN) })]).level, 0);
  assert.equal(signal([row({ observedAt: iso(NOW - 21 * MIN) })]).windows[0].reason, 'reading_old');
  assert.equal(signal([row({ observedAt: iso(NOW + 30 * 1000) })]).level, -1, 'small skew tolerated');
  assert.equal(signal([row({ observedAt: iso(NOW + 5 * MIN) })]).level, 0, 'future reading invalid');
  assert.equal(signal([row({ stale: true })]).level, 0);
  assert.equal(signal([row({ expired: true })]).level, 0);
  assert.equal(signal([row({ scopeMismatch: true })]).level, 0);
  assert.equal(signal([row()], { config: { enabled: false } }).level, 0);
  assert.equal(signal([row({ rateLimitType: 'five_hour' })]).level, 0, '5h is out of scope');
  assert.equal(signal([row({ rateLimitType: 'seven_day_opus' })], { modelId: 'claude-sonnet-4' }).level, 0);
  assert.equal(signal([row({ rateLimitType: 'seven_day_opus' })], { modelId: 'claude-opus-4' }).level, -1);
  assert.equal(signal([row({ rateLimitType: 'gpt-x:seven_day' })], { modelId: 'gpt-y' }).level, 0);
  assert.equal(signal([row({ rateLimitType: 'gpt-x:seven_day' })], { modelId: 'gpt-x' }).level, -1);
  assert.equal(signal([row({ rateLimitType: 'gpt-x:seven_day' })], { modelId: 'gpt-x::effort=high' }).level, -1);
  // Worst window wins; an unreliable one never erases a credible -1.
  assert.equal(signal([row(), row({ rateLimitType: 'seven_day_opus', utilization: 5 })], { modelId: 'claude-opus-4' }).level, -1);
  assert.equal(signal([row({ stale: true }), row()]).level, -1);
  // Bonus needs every known window credible.
  const ahead = { utilization: 50, resetsAt: resetAt(70) };
  assert.equal(signal([row(ahead), row({ ...ahead, stale: true, rateLimitType: 'seven_day_opus' })], { modelId: 'claude-opus-4' }).level, 0);
});

test('reservations are read once and a reset changes the level', () => {
  const corrected = row({ utilization: 60, measuredUtilization: 55, utilizationEstimated: true, estimatedPp: 5 });
  const w = signal([corrected]).windows[0];
  assert.equal(w.utilization, 60);
  assert.equal(w.measuredUtilization, 55);
  assert.equal(w.estimatedPp, 5);
  assert.equal(w.slackPct, -40, 'slack uses the corrected value exactly once');
  assert.equal(signal([row({ utilization: 5, resetsAt: resetAt(1) })]).level, 0, 'fresh window after reset');
});

test('cost factor is monotonic with tier', () => {
  const f = [1, 2, 3, 4, 5].map(paceCostFactor);
  assert.deepEqual(f, [0.5, 0.5, 1, 1.5, 2]);
});

const harness = (id) => ({ id, enabled: true, ready: true, can_delegate: true });
const item = (id, tier, quality = 4) => ({ id, roles: ['implement'], cost_tier: tier, quality_tier: quality, speed_tier: 3 });
function pick(models, over = {}) {
  const harnesses = Object.keys(models);
  return selectModelPick({
    role: 'implement',
    harnesses: harnesses.map(harness),
    modelsByHarness: Object.fromEntries(harnesses.map((h) => [h, { favorites_configured: true, items: models[h] }])),
    rotation: 'balanced', explore: false, now: NOW, ...over,
  });
}
const byModel = (result, id) => result.candidates.find((c) => c.model === id);

test('penalty scales with cost tier at -1, unchanged at 0/+1, capped, not summed', () => {
  const models = { h1: [item('t1', 1), item('t3', 3), item('t5', 5)] };
  const ahead = pick(models, { history: { planLimits: [row()] } });
  const p = (id) => byModel(ahead, id).plan_limit_penalty;
  assert.ok(p('t5') > p('t3') && p('t3') > p('t1') && p('t1') > 0);
  assert.ok(p('t5') <= PLAN_LIMIT_PENALTY_MAX);
  assert.equal(byModel(ahead, 't5').plan_pace_level, -1);
  assert.equal(byModel(ahead, 't5').pace_cost_factor, 2);
  assert.match(byModel(ahead, 't5').reason, /plan_pace_level=-1/);
  const neutral = pick(models, { history: { planLimits: [row({ utilization: 20 })] } });
  assert.equal(byModel(neutral, 't5').plan_limit_penalty, 0);
  const bonus = pick(models, { history: { planLimits: [row({ utilization: 50, resetsAt: resetAt(70) })] } });
  assert.equal(byModel(bonus, 't5').plan_limit_penalty, 0);
  assert.equal(byModel(bonus, 't5').plan_pace_level, 1);
  // max(forecast, pace * cost), not a sum.
  const strong = row({
    confidence: 'high',
    forecast: { beforeReset: true, percentPerHour: 40, remainingMs: 0, exhaustsAt: iso(NOW) },
  });
  assert.equal(byModel(pick(models, { history: { planLimits: [strong] } }), 't5').plan_limit_penalty, PLAN_LIMIT_PENALTY_MAX);
  const weak = row({ confidence: 'high', forecast: { beforeReset: false, percentPerHour: 12, remainingMs: 6 * 60 * MIN } });
  const both = byModel(pick(models, { history: { planLimits: [weak] } }), 't1').plan_limit_penalty;
  const paceOnly = p('t1');
  assert.ok(both < paceOnly + 0.25 && both >= paceOnly);
});

test('bonus is void when a penalty or fresh limit hit already applies', () => {
  const models = { h1: [item('m1', 3)] };
  const hit = pick(models, {
    history: { planLimits: [row({ utilization: 50, resetsAt: resetAt(70) })] },
  });
  assert.equal(byModel(hit, 'm1').plan_pace_level, 1);
  const spare = pick(models, {
    history: { planLimits: [row({ utilization: 50, resetsAt: resetAt(70) }), row({ rateLimitType: 'five_hour', utilization: 95, resetsAt: iso(NOW + 120 * MIN) })] },
  });
  assert.equal(byModel(spare, 'm1').plan_pace_level, 0, '5h headroom 0 zeroes the bonus');
});

test('Astra-like tier 5 loses to Luna-like tier 2 when the harness is above pace', () => {
  const models = { codex: [item('astra', 5, 5), item('luna', 2, 4)] };
  const planLimits = [row({ harness: 'codex', utilization: 60 })];
  const result = pick(models, { history: { planLimits } });
  assert.equal(result.pick.model, 'luna');
  const off = pick(models, { history: { planLimits }, planWindowConfig: { enabled: false } });
  const neutral = pick(models, { history: { planLimits: [row({ harness: 'codex', utilization: 20 })] } });
  assert.equal(off.pick.model, neutral.pick.model, 'disabled mode equals the no-pace result');
  assert.equal(byModel(off, 'astra').plan_limit_penalty, 0);
  assert.ok(byModel(result, 'astra').plan_limit_penalty > byModel(result, 'luna').plan_limit_penalty);
  const rotOff = pick(models, { history: { planLimits }, rotation: 'off' });
  assert.equal(rotOff.pick.model, neutral.pick.model);
});

test('sole candidate is never rejected and pace beats id order within a band', () => {
  const sole = pick({ h1: [item('only', 5)] }, { history: { planLimits: [row()] } });
  assert.equal(sole.ok, true);
  assert.equal(sole.pick.model, 'only');
  // Equal tier: h1 above pace, h2 neutral. Penalty is in force, so h2 wins.
  const two = pick({ h1: [item('a', 3)], h2: [item('b', 3)] }, { history: { planLimits: [row()] } });
  assert.equal(two.pick.harness, 'h2');
  // Wasted reserve prefers h1-with-bonus over the id order winner h0.
  const bonus = pick({ h0: [item('a', 3)], h1: [item('b', 3)] }, {
    history: { planLimits: [row({ utilization: 50, resetsAt: resetAt(70) })] },
  });
  assert.equal(bonus.pick.harness, 'h1');
  assert.match(bonus.pick.reason, /weekly plan pace level 1/);
});

// --- F1: delegation-card pace snapshot ---

test('F1 snapshot mirrors the decision signal and is null without an eligible window', () => {
  const rows = [row({ utilization: 60, resetsAt: resetAt(20), utilizationEstimated: true, estimatedPp: 3, measuredUtilization: 57 })];
  const snap = buildPlanPaceSnapshot({ planLimits: rows, harnessId: 'h1', modelId: 'm1', now: NOW, costTier: 5 });
  const sig = buildPlanPaceSignal({ planLimits: rows, harnessId: 'h1', modelId: 'm1', now: NOW });
  assert.equal(snap.level, sig.level, 'snapshot level equals the picker signal level');
  assert.equal(snap.observedAt, iso(NOW), 'observedAt is the snapshot time');
  assert.equal(snap.costFactor, 2);
  assert.equal(snap.windows[0].readingObservedAt, rows[0].observedAt, 'measurement time, not snapshot time');
  assert.equal(snap.windows[0].slackPct, -40);
  assert.equal(snap.windows[0].measuredUtilization, 57);
  assert.equal(snap.windows[0].estimatedPp, 3);
  assert.equal(snap.windows[0].eligible, true);
  // Disabled config or no usable weekly window => no snapshot at all.
  assert.equal(buildPlanPaceSnapshot({ planLimits: rows, harnessId: 'h1', modelId: 'm1', now: NOW, config: { enabled: false } }), null);
  assert.equal(buildPlanPaceSnapshot({ planLimits: [row({ stale: true })], harnessId: 'h1', modelId: 'm1', now: NOW }), null);
  assert.equal(buildPlanPaceSnapshot({ planLimits: [row({ rateLimitType: 'five_hour' })], harnessId: 'h1', modelId: 'm1', now: NOW }), null);
  // Unusable windows stay in the record with their reason as long as one window is eligible.
  const mixed = buildPlanPaceSnapshot({
    planLimits: [row({ stale: true, rateLimitType: 'seven_day_opus' }), row()],
    harnessId: 'h1',
    modelId: 'claude-opus-4',
    now: NOW,
  });
  assert.equal(mixed.windows.length, 2);
  assert.equal(mixed.windows.find((w) => w.reason === 'stale').eligible, false);
});

test('F1 persist/card round-trip: normalized, bounded and legacy-safe', () => {
  const record = createDelegationRecord({
    parentChatId: 'parent-pace',
    executor: { transport: 'h1', model: 'm' },
    planPaceSnapshot: {
      level: 5,
      costFactor: 9,
      observedAt: iso(NOW),
      windows: [
        {
          type: 'seven_day', limitId: 'gpt', resetsAt: iso(NOW + 1000),
          utilization: 60.04, measuredUtilization: 57, estimatedPp: 3,
          elapsedPct: 20.25, slackPct: -39.79, eligible: true, reason: '',
          readingObservedAt: iso(NOW - MIN),
        },
        { type: 'bad', utilization: 'x' },
      ],
    },
  });
  const stored = getDelegationById(record.id);
  assert.equal(stored.planPaceSnapshot.level, 1, 'level clamped to the pace range');
  assert.equal(stored.planPaceSnapshot.costFactor, 2, 'cost factor clamped to 2');
  assert.equal(stored.planPaceSnapshot.windows.length, 1, 'malformed window dropped');
  const card = buildDelegationCardModel({ ...stored, status: 'running' });
  assert.equal(card.planPace.level, 1);
  assert.equal(card.planPace.windows[0].type, 'seven_day');
  assert.equal(card.planPace.windows[0].utilization, 60.04);
  assert.equal(createDelegationRecord({ parentChatId: 'p3' }).planPaceSnapshot, null);
  assert.equal(buildDelegationCardModel({ status: 'running' }).planPace, null, 'legacy record yields null');
  assert.equal(buildDelegationCardModel({ status: 'running', planPaceSnapshot: { windows: 'x' } }).planPace, null);
  assert.equal(buildDelegationCardModel({
    status: 'running',
    planPaceSnapshot: { level: 9, windows: [{ type: 'seven_day', utilization: 1 }] },
  }).planPace.level, 1, 'card level is bounded');
  assert.equal(buildDelegationCardModel({
    status: 'running',
    planPaceSnapshot: { level: -9, windows: [{ type: 'seven_day', utilization: 1 }] },
  }).planPace.level, -1);
  assert.equal(buildDelegationCardModel({
    status: 'running',
    planPaceSnapshot: { level: 0, windows: [{ type: 'seven_day', utilization: null }] },
  }).planPace, null, 'null utilization is malformed');
});

// --- F2: within-band tie-break order ---

const wide = { rotation: { band: 1, mode: 'balanced' } };
const pairModels = () => ({ h1: [item('a', 3)], h2: [item('b', 3)] });
const fiveH = (harnessId, utilization, resetsInMin = 180) => ({
  harness: harnessId, rateLimitType: 'five_hour', utilization,
  resetsAt: iso(NOW + resetsInMin * MIN), observedAt: iso(NOW - MIN), stale: false, expired: false,
});

test('F2 tie-break: sticky/chat uses beat pace', () => {
  const chat = pick(pairModels(), {
    ...wide,
    history: {
      planLimits: [
        row({ harness: 'h1', utilization: 60, resetsAt: resetAt(20) }),
        row({ harness: 'h2', utilization: 50, resetsAt: resetAt(70) }),
      ],
      chatUsage: { models: { 'h2/b': { count: 5 } } },
    },
  });
  assert.equal(chat.pick.harness, 'h1', 'zero chat uses beat the better pace');
  assert.match(chat.pick.reason, /fewer uses in this chat \(0\)/);
  const sticky = pick(pairModels(), {
    ...wide,
    history: {
      planLimits: [
        row({ harness: 'h1', utilization: 50, resetsAt: resetAt(70) }),
        row({ harness: 'h2', utilization: 60, resetsAt: resetAt(20) }),
      ],
      leafSticky: { key: 'h2/b', harness: 'h2', model: 'b' },
    },
  });
  assert.equal(sticky.pick.harness, 'h2', 'the sticky leaf executor beats pace');
  assert.match(sticky.pick.reason, /sticky leaf executor/);
});

test('F2 tie-break: review can run tests beats pace', () => {
  const review = selectModelPick({
    role: 'review',
    harnesses: [harness('deepseek'), harness('codebuddy')],
    modelsByHarness: {
      deepseek: { favorites_configured: true, items: [{ id: 'ds', roles: ['review'], cost_tier: 3, quality_tier: 4, speed_tier: 3 }] },
      codebuddy: { favorites_configured: true, items: [{ id: 'hy', roles: ['review'], cost_tier: 3, quality_tier: 4, speed_tier: 3 }] },
    },
    ...wide,
    explore: false,
    now: NOW,
    history: {
      planLimits: [
        row({ harness: 'codebuddy', utilization: 60, resetsAt: resetAt(20) }),
        row({ harness: 'deepseek', utilization: 50, resetsAt: resetAt(70) }),
      ],
    },
  });
  assert.equal(review.pick.harness, 'codebuddy', 'a test-capable reviewer beats a better pace');
  assert.match(review.pick.reason, /review can run tests/);
});

test('F2 tie-break: headroom 0, then pace, then headroom and uses', () => {
  // A spare 5h window loses to a candidate with room even though pace would prefer it.
  const headroomFirst = pick(pairModels(), {
    ...wide,
    history: {
      planLimits: [
        row({ harness: 'h1', utilization: 20, resetsAt: resetAt(20) }),
        row({ harness: 'h2', utilization: 60, resetsAt: resetAt(20) }),
        fiveH('h1', 95),
        fiveH('h2', 10),
      ],
    },
  });
  assert.equal(headroomFirst.pick.harness, 'h2', 'headroom 0 is avoided before pace is considered');
  assert.match(headroomFirst.pick.reason, /5h plan headroom level/);
  const plusBeforeZero = pick(pairModels(), {
    ...wide,
    history: {
      planLimits: [
        row({ harness: 'h1', utilization: 50, resetsAt: resetAt(70) }),
        row({ harness: 'h2', utilization: 20, resetsAt: resetAt(20) }),
      ],
    },
  });
  assert.equal(plusBeforeZero.pick.harness, 'h1', '+1 precedes 0');
  assert.match(plusBeforeZero.pick.reason, /weekly plan pace level 1/);
  const zeroBeforeMinus = pick(pairModels(), {
    ...wide,
    history: {
      planLimits: [
        row({ harness: 'h1', utilization: 20, resetsAt: resetAt(20) }),
        row({ harness: 'h2', utilization: 60, resetsAt: resetAt(20) }),
      ],
    },
  });
  assert.equal(zeroBeforeMinus.pick.harness, 'h1', '0 precedes -1');
  assert.match(zeroBeforeMinus.pick.reason, /weekly plan pace level 0/);
  const headroomAfter = pick(pairModels(), {
    ...wide,
    history: { planLimits: [fiveH('h1', 40), fiveH('h2', 10)] },
  });
  assert.equal(headroomAfter.pick.harness, 'h2', 'headroom decides when pace is neutral');
  assert.match(headroomAfter.pick.reason, /5h plan headroom level 3/);
  const usesAfter = pick(pairModels(), {
    ...wide,
    history: { planLimits: [fiveH('h1', 40), fiveH('h2', 40)], roleUsage7d: { harness: { h2: 3 } } },
  });
  assert.equal(usesAfter.pick.harness, 'h1', 'uses decide when pace and headroom are equal');
  assert.match(usesAfter.pick.reason, /harness least-used in role 7d/);
});

test('F2 lockout drops a paced pair; weekly-gate relaxation keeps the relaxed winner', () => {
  const above = row({ harness: 'h1', utilization: 60, resetsAt: resetAt(20) });
  const locked = pick(pairModels(), {
    ...wide,
    history: { planLimits: [above], lockouts: [{ harness: 'h1', model: 'a', resetAt: '2099-01-01T00:00:00.000Z' }] },
  });
  assert.equal(locked.pick.harness, 'h2', 'an active lockout drops the above-pace pair');
  const expired = pick(pairModels(), {
    ...wide,
    history: { planLimits: [above], lockouts: [{ harness: 'h1', model: 'a', resetAt: '2000-01-01T00:00:00.000Z' }] },
  });
  assert.equal(expired.pick.harness, pick(pairModels(), { ...wide, history: { planLimits: [above] } }).pick.harness,
    'an expired lockout changes nothing');
  // The weekly hard gate empties the pool on both harnesses => relaxed pick.
  const gated = [
    row({ harness: 'h1', utilization: 96, resetsAt: resetAt(50) }),
    row({ harness: 'h2', utilization: 96, resetsAt: resetAt(50) }),
  ];
  const relaxed = pick(pairModels(), { ...wide, history: { planLimits: gated } });
  assert.equal(relaxed.ok, true);
  assert.equal(relaxed.rotation.plan_window_relaxed, true);
  assert.equal(relaxed.pick.harness, pick(pairModels(), { ...wide, history: {} }).pick.harness);
  assert.equal(byModel(relaxed, 'a').plan_pace_level, -1, 'pace is still evaluated after relaxation');
});

test('F2 reservations are counted once in the pace signal', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-pace-res-'));
  try {
    const measured = [row({ utilization: 55 })];
    const key = 'd1:a1';
    const first = recordPlanWindowReservation({
      harness: 'h1', model: 'm1', role: 'implement', idempotencyKey: key, planLimits: measured, now: NOW, dataDir: dir,
    });
    assert.equal(first.recorded, 1);
    const overlay = applyPlanWindowReservations(measured, { now: NOW, dataDir: dir });
    const once = signal(overlay);
    const estimate = PLAN_WINDOW_ESTIMATE_PP.implement;
    assert.equal(once.windows[0].utilization, 55 + estimate);
    assert.equal(once.windows[0].measuredUtilization, 55);
    assert.equal(once.windows[0].slackPct, Math.round((20 - (55 + estimate)) * 10) / 10);
    // Replaying the same delegation+attempt is a no-op, so the estimate is not added twice.
    const replay = recordPlanWindowReservation({
      harness: 'h1', model: 'm1', role: 'implement', idempotencyKey: key, planLimits: measured, now: NOW, dataDir: dir,
    });
    assert.equal(replay.recorded, 0);
    assert.deepEqual(signal(applyPlanWindowReservations(measured, { now: NOW, dataDir: dir })).windows, once.windows);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F2 enabled:false end-to-end: pace is off and the pick matches baseline', () => {
  const planLimits = [row({ harness: 'h1', utilization: 60, resetsAt: resetAt(20) })];
  const on = pick(pairModels(), { history: { planLimits } });
  assert.equal(on.pick.harness, 'h2', 'pace pushes the above-pace harness out of the band');
  const off = pick(pairModels(), { history: { planLimits }, planWindowConfig: { enabled: false } });
  const baseline = pick(pairModels(), { history: {} });
  assert.equal(off.pick.harness, baseline.pick.harness);
  assert.equal(off.pick.harness, 'h1');
  for (const candidate of off.candidates) {
    assert.equal(candidate.plan_pace_level, 0);
    assert.equal(candidate.plan_limit_penalty, 0);
  }
});

// --- F3: rotation off must be byte-for-byte independent of pace ---

test('F3 rotation off picks the same model with and without a pace signal', () => {
  // h2 sorts first; a pace tie-break would move h1 ahead if the off path ever read it.
  const models = { h2: [item('b', 3)], h1: [item('a', 3)] };
  const withoutPace = pick(models, { rotation: 'off', history: {} });
  const bonus = pick(models, { rotation: 'off', history: { planLimits: [row({ harness: 'h1', utilization: 50, resetsAt: resetAt(70) })] } });
  const penalty = pick(models, { rotation: 'off', history: { planLimits: [row({ harness: 'h1', utilization: 60, resetsAt: resetAt(20) })] } });
  assert.equal(bonus.rotation.mode, 'off');
  assert.equal(bonus.pick.harness, withoutPace.pick.harness);
  assert.equal(bonus.pick.model, withoutPace.pick.model);
  assert.equal(penalty.pick.model, withoutPace.pick.model);
  // The off path returns before the pace loop, so pace never touches it.
  for (const candidate of bonus.candidates) {
    assert.equal(candidate.plan_pace_level, undefined);
    assert.equal(candidate.plan_limit_penalty, 0);
  }
});

// --- F2 gap: the weekly hard gate empties the pool and relaxation picks the paced winner ---

test('F2 weekly-gate exhaustion relaxes to the paced winner and records the snapshot', () => {
  // Both weekly windows are at/above the hard threshold (95% by default), so
  // the gate empties the pool on both harnesses and only the relaxation path
  // can pick. h1 is far above pace; h2 is nearly spent but on pace, so the
  // relaxed pick must be h2 and its pick-time snapshot must follow.
  const gated = [
    row({ harness: 'h1', utilization: 99, resetsAt: resetAt(20) }),
    row({ harness: 'h2', utilization: 96, resetsAt: resetAt(90) }),
  ];
  const relaxed = pick(pairModels(), { ...wide, history: { planLimits: gated } });
  assert.equal(relaxed.ok, true);
  assert.equal(relaxed.rotation.plan_window_relaxed, true, 'the weekly gate is relaxed, not silently bypassed');
  assert.equal(relaxed.pick.harness, 'h2', 'the paced winner takes the relaxed pool');
  assert.equal(byModel(relaxed, 'a').plan_pace_level, -1);
  assert.equal(byModel(relaxed, 'b').plan_pace_level, 0);
  // The pick-time snapshot carries the winner's level and measurement time.
  assert.equal(relaxed.planPace.level, 0);
  assert.equal(relaxed.planPace.windows[0].readingObservedAt, iso(NOW - MIN));
  // With only the h2 row the gate drops h2 and leaves h1: a non-empty pool is
  // never relaxed, so the relaxation above is genuinely what let h2 back in.
  const only = pick(pairModels(), { ...wide, history: { planLimits: [gated[1]] } });
  assert.equal(only.pick.harness, 'h1');
  assert.equal(only.rotation.plan_window_relaxed, undefined, 'a non-empty pool is never relaxed');
});

// --- N3: pace card line, pick-time snapshot, i18n parity ---

/**
 * Minimal `t` over a real dictionary (the browser i18n reads localStorage).
 *
 * @param {Record<string, unknown>} dict
 * @returns {(key: string, vars?: Record<string, string>) => string}
 */
function makeT(dict) {
  return (key, vars) => {
    const value = key.split('.').reduce(
      (acc, part) => (acc && typeof acc === 'object' ? acc[part] : undefined),
      /** @type {unknown} */ (dict),
    );
    if (typeof value !== 'string') return key;
    return vars ? value.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? '')) : value;
  };
}

test('N3 card model keeps measurement time, basis, slack, reason and costFactor', () => {
  const measuredAt = iso(NOW - MIN);
  const card = buildDelegationCardModel({
    status: 'running',
    attemptId: 'a1',
    planPaceSnapshot: {
      level: -1,
      costFactor: 1.5,
      observedAt: iso(NOW),
      windows: [
        {
          type: 'seven_day', limitId: 'gpt', resetsAt: iso(NOW + 1000),
          utilization: 60.04, measuredUtilization: 57, estimatedPp: 3,
          elapsedPct: 20.25, slackPct: -39.79, eligible: true, reason: '',
          readingObservedAt: measuredAt,
        },
        // A known window with an unusable reading must survive with its reason.
        { type: 'seven_day_opus', utilization: null, eligible: false, reason: 'stale', readingObservedAt: '' },
      ],
    },
  });
  assert.equal(card.planPace.level, -1);
  assert.equal(card.planPace.costFactor, 1.5);
  assert.equal(card.planPace.observedAt, iso(NOW));
  const [measured, neutral] = card.planPace.windows;
  assert.equal(measured.readingObservedAt, measuredAt, 'measurement time, not the snapshot time');
  assert.equal(measured.measuredUtilization, 57);
  assert.equal(measured.estimatedPp, 3);
  assert.equal(measured.slackPct, -39.79);
  assert.equal(measured.utilization, 60.04);
  assert.equal(neutral.utilization, null);
  assert.equal(neutral.reason, 'stale');
  assert.equal(neutral.eligible, false);
  assert.equal(buildDelegationCardModel({ status: 'running' }).planPace, null, 'legacy record yields null');
  assert.equal(buildDelegationCardModel({
    status: 'running',
    planPaceSnapshot: { level: 0, windows: [{ type: 'seven_day', utilization: null }] },
  }).planPace, null, 'a null utilization without a reason is still malformed');
});

test('N3 rendered pace line surfaces level, cost factor, basis, slack and reason', () => {
  const tEn = makeT(en);
  const tPl = makeT(pl);
  const measuredAt = iso(NOW - MIN);
  const line = buildPlanPaceLine({
    level: -1,
    costFactor: 2,
    observedAt: iso(NOW),
    windows: [
      {
        type: 'seven_day', utilization: 60, measuredUtilization: 57, estimatedPp: 3,
        elapsedPct: 20, slackPct: -40, eligible: true, reason: '', readingObservedAt: measuredAt,
      },
      { type: 'seven_day_opus', utilization: null, eligible: false, reason: 'stale', readingObservedAt: '' },
    ],
  }, tEn);
  assert.match(line.summary, /Weekly pace: above pace \(cost x2\)/);
  assert.match(line.summary, /seven_day 60%/);
  assert.match(line.summary, /seven_day_opus reading stale/);
  for (const needle of ['measured 57%', 'est. +3 pp', 'elapsed 20%', 'slack -40 pp', measuredAt, `snapshot ${iso(NOW)}`]) {
    assert.ok(line.detail.includes(needle), `${needle} missing from the tooltip: ${line.detail}`);
  }
  const plLine = buildPlanPaceLine({
    level: -1,
    costFactor: 2,
    observedAt: iso(NOW),
    windows: [{ type: 'seven_day', utilization: 60, measuredUtilization: 57, estimatedPp: 3, elapsedPct: 20, slackPct: -40, eligible: true, reason: '', readingObservedAt: measuredAt }],
  }, tPl);
  assert.match(plLine.summary, /Tempo tygodnia: powyżej tempa/);
  assert.equal(buildPlanPaceLine(null, tEn).summary, '');
});

test('N3 i18n pace level -1 resolves in both languages', () => {
  assert.equal(makeT(en)('chat.delegationPlanPaceLevel.-1'), 'above pace');
  assert.equal(makeT(pl)('chat.delegationPlanPaceLevel.-1'), 'powyżej tempa');
  assert.notEqual(makeT(en)('chat.delegationPlanPaceLevel.-1'), 'chat.delegationPlanPaceLevel.-1');
  assert.notEqual(makeT(pl)('chat.delegationPlanPaceLevel.-1'), 'chat.delegationPlanPaceLevel.-1');
});

test('N3 pick-time pace snapshot uses the decision level and persists on the proposal', () => {
  const models = { h1: [item('m1', 3)] };
  const bonus = pick(models, { history: { planLimits: [row({ utilization: 50, resetsAt: resetAt(70) })] } });
  assert.equal(byModel(bonus, 'm1').plan_pace_level, 1);
  assert.equal(bonus.pick.planPace.level, 1, 'the pick carries the snapshot');
  assert.equal(bonus.planPace.level, 1, 'the top-level snapshot matches the pick');
  assert.equal(bonus.planPace.costFactor, 1);
  assert.equal(bonus.planPace.observedAt, iso(NOW), 'observedAt is the decision time, not start time');
  assert.equal(bonus.planPace.windows[0].readingObservedAt, iso(NOW - MIN));
  // The 5h spare window zeroes the +1 bonus in the decision; the snapshot follows.
  const zeroed = pick(models, {
    history: { planLimits: [row({ utilization: 50, resetsAt: resetAt(70) }), fiveH('h1', 95)] },
  });
  assert.equal(byModel(zeroed, 'm1').plan_pace_level, 0);
  assert.equal(zeroed.planPace.level, 0, 'the snapshot keeps the picker +1 zeroing');
  // Above pace carries the zeroed -1 and the cost-scaled factor from the decision.
  const above = pick(models, { history: { planLimits: [row({ utilization: 60, resetsAt: resetAt(20) }), fiveH('h1', 10)] } });
  assert.equal(byModel(above, 'm1').plan_pace_level, -1);
  assert.equal(above.planPace.level, -1);
  assert.equal(above.planPace.costFactor, 1);
  assert.equal(pick(models, { history: {} }).planPace, null, 'no weekly window => no snapshot');
  // The proposal record round-trips the bounded snapshot; a pick without one stays null.
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pace-pick-')), 'model-pick-decisions.json');
  const persisted = persistModelPickProposal({ chatId: 'c', role: 'implement', pickResult: bonus, planPace: bonus.planPace, file });
  const loaded = getModelPickRecord(persisted.pickId, { file });
  assert.equal(loaded.planPace.level, 1);
  assert.equal(loaded.planPace.costFactor, 1);
  assert.equal(loaded.planPace.windows[0].readingObservedAt, iso(NOW - MIN));
  assert.equal(loaded.planPace.windows[0].slackPct, 20);
  const legacy = persistModelPickProposal({
    role: 'implement',
    pickResult: { pick: { harness: 'a', model: 'm' }, picks: [{ harness: 'a', model: 'm' }] },
    file,
  });
  assert.equal(getModelPickRecord(legacy.pickId, { file }).planPace, null, 'a pick without pace stays null');
});

test('N3 pickAndPersistModelForPurpose persists the pick-time snapshot on the proposal', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pace-svc-')), 'model-pick-decisions.json');
  const picked = pickAndPersistModelForPurpose({
    role: 'implement',
    harnesses: [harness('h1')],
    modelsByHarness: { h1: { favorites_configured: true, items: [item('m1', 3)] } },
    history: { planLimits: [row()] },
    now: NOW,
    file,
    costPolicy: false,
  });
  assert.equal(picked.planPace.level, -1, 'the pick result carries the snapshot');
  assert.equal(picked.planPace.observedAt, iso(NOW));
  const record = getModelPickRecord(picked.pickId, { file });
  assert.equal(record.planPace.level, -1, 'the proposal record carries the same snapshot');
  assert.equal(record.planPace.windows[0].readingObservedAt, iso(NOW - MIN));
});
