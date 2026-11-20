import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { planWindowExhaustedReason, PLAN_WINDOW_ESTIMATE_PP } from '../lib/model-pick-plan-window-gate.js';
import { evaluateModelPickHardGates } from '../lib/model-pick-hard-gates.js';
import {
  applyPlanWindowReservations,
  recordPlanWindowReservation,
} from '../lib/plan-window-reservations.js';
import { selectModelPick } from '../lib/model-role-profiles.js';

const NOW = Date.parse('2026-01-01T12:00:00Z');
const MIN = 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

const week = (over = {}) => ({
  harness: 'h1', rateLimitType: 'seven_day', utilization: 96,
  resetsAt: iso(NOW + 180 * MIN), observedAt: iso(NOW - MIN),
  stale: false, expired: false, ...over,
});
const gate = (rows, over = {}) => planWindowExhaustedReason({
  harness: 'h1', modelId: 'm1', planLimits: rows, now: NOW, ...over,
});

test('seven_day with 4% free, reset in 3h, fresh => exhausted', () => {
  assert.equal(gate([week()])?.type, 'seven_day');
});

test('stale, no resetsAt, expired, scope mismatch, disabled => not exhausted', () => {
  assert.equal(gate([week({ stale: true })]), null);
  assert.equal(gate([week({ resetsAt: undefined })]), null);
  assert.equal(gate([week({ resetsAt: iso(NOW - MIN) })]), null);
  assert.equal(gate([week({ expired: true })]), null);
  assert.equal(gate([week({ scopeMismatch: true })]), null);
  assert.equal(gate([week()], { config: { enabled: false } }), null);
});

test('threshold boundaries: 95% fires, 94.9% not; reset 60 min not, 61 min fires', () => {
  assert.ok(gate([week({ utilization: 95 })]));
  assert.equal(gate([week({ utilization: 94.9 })]), null);
  assert.equal(gate([week({ resetsAt: iso(NOW + 60 * MIN) })]), null);
  assert.ok(gate([week({ resetsAt: iso(NOW + 61 * MIN) })]));
});

test('five_hour and seven_day_oauth_apps never gate; model windows only for their family', () => {
  assert.equal(gate([week({ rateLimitType: 'five_hour' })]), null);
  assert.equal(gate([week({ rateLimitType: 'seven_day_oauth_apps' })]), null);
  const opus = [week({ rateLimitType: 'seven_day_opus', utilization: 97 })];
  assert.ok(gate(opus, { modelId: 'claude-opus-5-5' }));
  assert.equal(gate(opus, { modelId: 'claude-sonnet-5-5' }), null);
});

test('hard-gate validator: opt-in, refuses with plan_window_exhausted, lockout order kept', () => {
  const base = { role: 'implement', harness: 'h1', model: 'm1', now: NOW, checkReviewAdapter: false };
  assert.equal(evaluateModelPickHardGates(base).ok, true);
  const refused = evaluateModelPickHardGates({ ...base, planWindowLimits: [week()] });
  assert.equal(refused.code, 'plan_window_exhausted');
  const locked = evaluateModelPickHardGates({
    ...base,
    planWindowLimits: [week()],
    lockouts: [{ harness: 'h1', model: '', resetAt: iso(NOW + 30 * MIN), code: 'x' }],
  });
  assert.notEqual(locked.code, 'plan_window_exhausted');
});

const harness = (id) => ({ id, enabled: true, ready: true, can_delegate: true });
const models = (model) => ({
  favorites_configured: true,
  items: [{ id: model, roles: ['implement'], cost_tier: 2, quality_tier: 4, speed_tier: 3 }],
});
const pick = (over = {}) => selectModelPick({
  role: 'implement',
  harnesses: [harness('h1'), harness('h2')],
  modelsByHarness: { h1: models('m1'), h2: models('m2') },
  rotation: 'balanced',
  explore: false,
  now: NOW,
  ...over,
});

test('picker excludes the exhausted harness and shows plan-window-exhausted in diagnosis', () => {
  const result = pick({ history: { planLimits: [week()] } });
  assert.equal(result.pick.harness, 'h2');
  const diagnosed = result.diagnosis.rows.find((r) => r.harness === 'h1');
  assert.deepEqual(diagnosed.filter_reasons, ['plan-window-exhausted']);
  assert.equal(result.rotation.plan_window_relaxed, undefined);
});

test('a stale plan-limit row does not gate the candidate', () => {
  const stale = pick({ history: { planLimits: [week({ stale: true })] } });
  assert.equal(stale.diagnosis.rows.find((r) => r.harness === 'h1').filter_reasons.length, 0);
});

test('empty pool => relaxed, pick like today, diagnostic note', () => {
  const planLimits = [week(), week({ harness: 'h2' })];
  const result = pick({ history: { planLimits } });
  assert.equal(result.ok, true);
  assert.equal(result.rotation.plan_window_relaxed, true);
  assert.ok(result.diagnosis.rows.every((r) => r.filter_reasons.length === 0));
  assert.ok(result.diagnosis.rows.every((r) => r.plan_window_note === 'plan-window-relaxed'));
  const without = pick({ history: {} });
  assert.equal(result.pick.harness, without.pick.harness);
});

test('unrelated empty pool stays MODEL_UNAVAILABLE', () => {
  const result = pick({ history: { planLimits: [week()] }, excludeHarnesses: ['h2'] });
  // Only h1 is left and it is gate-emptied => relaxed pick, not an error.
  assert.equal(result.ok, true);
  const none = pick({ history: { planLimits: [week()] }, excludeHarnesses: ['h1', 'h2'] });
  assert.equal(none.ok, false);
  assert.equal(none.code, 'MODEL_UNAVAILABLE');
});

test('disabled config: gate and penalties identical to legacy', () => {
  const result = pick({ history: { planLimits: [week()] }, planWindowConfig: { enabled: false } });
  assert.equal(result.diagnosis.rows.find((r) => r.harness === 'h1').filter_reasons.length, 0);
});

test('count/diverse picks never include the gated harness', () => {
  const result = pick({ history: { planLimits: [week()] }, count: 2, diverse: true });
  assert.ok(result.picks.every((p) => p.harness === 'h2'));
});

test('reservations: parallel + retry idempotent, TTL, newer measurement and reset clear', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-res-'));
  try {
    const measured = [week({ rateLimitType: 'five_hour', utilization: 50 }), week({ utilization: 80 })];
    const record = (id, role = 'implement', now = NOW) => recordPlanWindowReservation({
      harness: 'h1', model: 'm1', role, idempotencyKey: id, planLimits: measured, now, dataDir: dir,
    });
    assert.equal(record('d1:a1').recorded, 2);
    assert.equal(record('d1:a1').recorded, 0);
    assert.equal(record('d2:a1', 'review').recorded, 2);
    assert.equal(record('d1:a2').recorded, 2);
    const overlay = applyPlanWindowReservations(measured, { now: NOW, dataDir: dir });
    const expected = 2 * PLAN_WINDOW_ESTIMATE_PP.implement + PLAN_WINDOW_ESTIMATE_PP.review;
    assert.equal(overlay[0].utilization, 50 + expected);
    assert.equal(overlay[0].measuredUtilization, 50);
    assert.equal(overlay[0].utilizationEstimated, true);
    // Newer measurement supersedes.
    const fresher = measured.map((r) => ({ ...r, observedAt: iso(NOW + MIN) }));
    assert.equal(applyPlanWindowReservations(fresher, { now: NOW + 2 * MIN, dataDir: dir })[0].utilization, 50);
    // Changed resetsAt is a different window.
    const reset = measured.map((r) => ({ ...r, resetsAt: iso(NOW + 400 * MIN) }));
    assert.equal(applyPlanWindowReservations(reset, { now: NOW, dataDir: dir })[0].utilization, 50);
    // TTL.
    assert.equal(applyPlanWindowReservations(measured, { now: NOW + 16 * MIN, dataDir: dir })[0].utilization, 50);
    // Reservation pushes a window over the hard threshold.
    const near = [week({ utilization: 93 })];
    recordPlanWindowReservation({
      harness: 'h1', model: 'm1', role: 'implement', idempotencyKey: 'x', planLimits: near, now: NOW, dataDir: dir,
    });
    recordPlanWindowReservation({
      harness: 'h1', model: 'm1', role: 'implement', idempotencyKey: 'y', planLimits: near, now: NOW, dataDir: dir,
    });
    const corrected = applyPlanWindowReservations(near, { now: NOW, dataDir: dir });
    assert.ok(gate(corrected));
    assert.equal(gate(near), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reservations: opus model window charged only for matching model', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-res-'));
  try {
    const rows = [week({ rateLimitType: 'seven_day_opus', utilization: 10 })];
    const r = recordPlanWindowReservation({
      harness: 'h1', model: 'claude-sonnet-5-5', role: 'plan', idempotencyKey: 's', planLimits: rows, now: NOW, dataDir: dir,
    });
    assert.equal(r.recorded, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reading older than 20 min but not stale => gate fires; stale flag => it does not', () => {
  assert.equal(gate([week({ observedAt: iso(NOW - 3 * 60 * MIN) })])?.type, 'seven_day');
  assert.equal(gate([week({ observedAt: iso(NOW - 3 * 60 * MIN), stale: true })]), null);
});

test('boundaries: 94.99 vs 95 pct and 60 vs 60.01 min to reset', () => {
  assert.equal(gate([week({ utilization: 94.99 })]), null);
  assert.ok(gate([week({ utilization: 95 })]));
  assert.equal(gate([week({ resetsAt: iso(NOW + 60 * MIN) })]), null);
  assert.ok(gate([week({ resetsAt: iso(NOW + 60 * MIN + 600) })]));
});

test('unknown reading time never gates; unparseable percent never gates', () => {
  const noTime = week();
  delete noTime.observedAt;
  assert.equal(gate([noTime]), null);
  assert.equal(gate([week({ observedAt: 'not-a-date' })]), null);
  assert.equal(gate([week({ utilization: 'n/a' })]), null);
});

test('codex model bucket gates only the model it names', () => {
  const rows = [week({ harness: 'codex', rateLimitType: 'gpt-5-codex-mini:seven_day', utilization: 97 })];
  const forCodex = (modelId) => planWindowExhaustedReason({ harness: 'codex', modelId, planLimits: rows, now: NOW });
  assert.ok(forCodex('gpt-5-codex-mini'));
  assert.equal(forCodex('gpt-5-codex'), null);
  const whole = [week({ harness: 'codex', rateLimitType: 'codex:seven_day', utilization: 97 })];
  assert.ok(planWindowExhaustedReason({ harness: 'codex', modelId: 'gpt-5-codex', planLimits: whole, now: NOW }));
});

test('gate reports its basis: measured vs reservation-corrected', () => {
  assert.equal(gate([week()]).basis, 'measured');
  const corrected = gate([week({ utilization: 96, measuredUtilization: 93, utilizationEstimated: true, estimatedPp: 3 })]);
  assert.equal(corrected.basis, 'estimated');
  assert.equal(corrected.measuredUtilization, 93);
  assert.equal(corrected.estimatedPp, 3);
});

test('diagnosis marks an exclusion that rests on an estimate (basis, measured, estimated pp)', () => {
  const estimated = week({ utilization: 96, measuredUtilization: 93, utilizationEstimated: true, estimatedPp: 3 });
  const result = pick({ history: { planLimits: [estimated] } });
  const row = result.diagnosis.rows.find((r) => r.harness === 'h1');
  assert.deepEqual(row.filter_reasons, ['plan-window-exhausted']);
  assert.equal(row.plan_window_note, 'plan-window-estimated');
  assert.equal(row.plan_window.basis, 'estimated');
  assert.equal(row.plan_window.measured_utilization, 93);
  assert.equal(row.plan_window.estimated_pp, 3);
  const measured = pick({ history: { planLimits: [week()] } }).diagnosis.rows.find((r) => r.harness === 'h1');
  assert.equal(measured.plan_window_note, undefined);
  assert.equal(measured.plan_window.basis, 'measured');
});

test('role mismatch keeps its reason and is not re-admitted by the plan-window relaxation', () => {
  const base = { role: 'implement', harness: 'h1', model: 'm1', now: NOW, checkReviewAdapter: false };
  const refused = evaluateModelPickHardGates({ ...base, modelRoles: ['plan'], planWindowLimits: [week()] });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'role_membership');
  const result = selectModelPick({
    role: 'implement',
    harnesses: [harness('h1')],
    modelsByHarness: { h1: { favorites_configured: true, items: [{ id: 'm1', roles: ['plan'], cost_tier: 2, quality_tier: 4, speed_tier: 3 }] } },
    rotation: 'balanced',
    explore: false,
    now: NOW,
    history: { planLimits: [week()] },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'MODEL_UNAVAILABLE');
  assert.notEqual(result.rotation?.plan_window_relaxed, true);
});

test('relax order: history soft-exclude returns first, the plan-window gate stays', () => {
  // Soft excludes (last reviewer) only apply to the review role.
  const reviewModels = (model) => ({
    favorites_configured: true,
    items: [{ id: model, roles: ['review'], cost_tier: 2, quality_tier: 4, speed_tier: 3 }],
  });
  const result = selectModelPick({
    role: 'review',
    harnesses: [harness('h1'), harness('h2')],
    modelsByHarness: { h1: reviewModels('m1'), h2: reviewModels('m2') },
    rotation: 'balanced',
    explore: false,
    now: NOW,
    history: { planLimits: [week()], softExcludeModels: ['m2'], excludeModels: ['m2'] },
  });
  assert.equal(result.ok, true);
  assert.equal(result.pick.harness, 'h2');
  assert.equal(result.rotation.history_exclude_relaxed, true);
  assert.notEqual(result.rotation.plan_window_relaxed, true);
  assert.deepEqual(result.diagnosis.rows.find((r) => r.harness === 'h1').filter_reasons, ['plan-window-exhausted']);
});

test('preferModels with a gate-cut member: degraded pool, no relaxation', () => {
  const result = pick({
    history: { planLimits: [week()] },
    preferModels: [{ harness: 'h1', model: 'm1' }, { harness: 'h2', model: 'm2' }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.pick.harness, 'h2');
  assert.equal(result.rotation.pool.degraded, true);
  assert.notEqual(result.rotation.plan_window_relaxed, true);
});

test('history reads plan limits and reservations from the same custom dataDir', async () => {
  const { buildModelPickHistory } = await import('../lib/model-pick-history.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-hist-'));
  try {
    const now = Date.now();
    const row = week({
      harness: 'h1', utilization: 40, resetsAt: iso(now + 180 * MIN), observedAt: iso(now - 5 * MIN),
    });
    fs.writeFileSync(path.join(dir, 'harness-plan-limits.json'), JSON.stringify([row]));
    const rec = recordPlanWindowReservation({
      harness: 'h1', model: 'm1', role: 'implement', idempotencyKey: 'k', planLimits: [row], now, dataDir: dir,
    });
    assert.equal(rec.recorded, 1);
    const history = buildModelPickHistory({ role: 'implement', delegations: [], dataDir: dir, now });
    const found = history.planLimits.find((r) => r.harness === 'h1' && r.rateLimitType === 'seven_day');
    assert.ok(found, 'measured row came from the custom dataDir');
    assert.equal(found.utilizationEstimated, true, 'reservation overlay came from the same dataDir');
    assert.equal(found.measuredUtilization, 40);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
