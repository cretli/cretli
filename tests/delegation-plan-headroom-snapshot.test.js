import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDelegationRecord, getDelegationById } from '../lib/persist/delegations-persist.js';
import { saveDelegationSettings } from '../lib/persist/delegation-settings-persist.js';
import { resolvePlanWindowSettings } from '../lib/delegation-settings.js';
import { buildDelegationCardModel } from '../lib/delegation-card-model.js';
import { selectModelPick } from '../lib/model-role-profiles.js';

const NOW = Date.parse('2026-01-01T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

test('createDelegationRecord persists a normalized headroom snapshot next to a custom pick_reason', () => {
  const record = createDelegationRecord({
    parentChatId: 'parent-headroom',
    executor: { transport: 'claude', model: 'm' },
    pickReason: 'chosen by operator',
    planHeadroomSnapshot: {
      level: 9,
      hardFreePercent: 5,
      observedAt: iso(NOW),
      windows: [{ type: 'five_hour', utilization: 10, resetsAt: iso(NOW + 1000) }, { type: 'bad', utilization: 'x' }],
    },
  });
  const stored = getDelegationById(record.id);
  assert.equal(stored.pickReason, 'chosen by operator');
  assert.equal(stored.planHeadroomSnapshot.level, 3);
  assert.equal(stored.planHeadroomSnapshot.windows.length, 1);
  const card = buildDelegationCardModel({ ...stored, status: 'running' });
  assert.equal(card.planHeadroom.windows[0].type, 'five_hour');
  assert.equal(createDelegationRecord({ parentChatId: 'p2' }).planHeadroomSnapshot, null);
});

test('card model clamps a malformed headroom level to 0..3', () => {
  const mk = (level) => buildDelegationCardModel({
    status: 'running',
    planHeadroomSnapshot: { level, windows: [{ type: 'seven_day', utilization: 1, resetsAt: '' }] },
  }).planHeadroom.level;
  assert.equal(mk(42), 3);
  assert.equal(mk(-5), 0);
});

test('resolvePlanWindowSettings reads a saved workspace value', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-pw-'));
  const ws = '/tmp/ws-plan-window';
  saveDelegationSettings(ws, { plan_window_enabled: false, plan_window_hard_free_percent: 12 }, { dataDir });
  assert.deepEqual(resolvePlanWindowSettings(ws, { dataDir }), { enabled: false, hardFreePercent: 12 });
});

test('mode off: pick equals the pick without any plan-limit reading', () => {
  const harness = (id) => ({ id, enabled: true, ready: true, can_delegate: true });
  const models = (model) => ({
    favorites_configured: true,
    items: [{ id: model, roles: ['implement'], cost_tier: 2, quality_tier: 4, speed_tier: 3 }],
  });
  const week = { harness: 'h1', rateLimitType: 'seven_day', utilization: 96, resetsAt: iso(NOW + 3 * 3600000), observedAt: iso(NOW - 60000), stale: false, expired: false };
  const base = {
    role: 'implement',
    harnesses: [harness('h1'), harness('h2')],
    modelsByHarness: { h1: models('m1'), h2: models('m2') },
    rotation: 'balanced',
    explore: false,
    now: NOW,
  };
  const off = selectModelPick({ ...base, history: { planLimits: [week] }, planWindowConfig: { enabled: false } });
  // Legacy per-harness penalty stays; no hard gate and no headroom bonus/penalty.
  assert.deepEqual(off.diagnosis.rows.find((r) => r.harness === 'h1').filter_reasons, []);
  for (const c of off.candidates) assert.equal(c.plan_headroom_level, 1);
  const h1 = off.candidates.find((c) => c.harness === 'h1');
  assert.ok(h1.plan_limit_penalty > 0);
});
