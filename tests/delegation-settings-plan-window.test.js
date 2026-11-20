import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getDelegationSettingDef } from '../lib/delegation-settings-schema.js';
import {
  buildPlanHeadroomSnapshot,
  resolvePlanWindowConfig,
  PLAN_WINDOW_HARD_FREE_PERCENT_DEFAULT,
} from '../lib/model-pick-plan-window.js';
import { planWindowExhaustedReason } from '../lib/model-pick-plan-window-gate.js';

test('plan-window settings defaults and validation range', () => {
  const enabled = getDelegationSettingDef('plan_window_enabled');
  const free = getDelegationSettingDef('plan_window_hard_free_percent');
  assert.equal(enabled.default, true);
  assert.equal(free.default, PLAN_WINDOW_HARD_FREE_PERCENT_DEFAULT);
  assert.equal(free.default, 5);
  for (const bad of [0, 21, 'x', 5.5, '']) assert.equal(free.parse(bad).ok, false, String(bad));
  for (const good of [1, 5, 20, '12']) assert.equal(free.parse(good).ok, true, String(good));
  assert.equal(enabled.parse('maybe').ok, false);
});

test('resolvePlanWindowConfig clamps hardFreePercent and defaults it', () => {
  assert.equal(resolvePlanWindowConfig().hardFreePercent, 5);
  assert.equal(resolvePlanWindowConfig({ hardFreePercent: 99 }).hardFreePercent, 20);
  assert.equal(resolvePlanWindowConfig({ hardFreePercent: 0 }).hardFreePercent, 1);
  assert.equal(resolvePlanWindowConfig({ enabled: false }).enabled, false);
});

test('hard threshold follows hardFreePercent; disabled gives no exclusion', () => {
  const now = Date.parse('2026-10-01T00:00:00.000Z');
  const planLimits = [{
    harness: 'claude', rateLimitType: 'seven_day', utilization: 88,
    resetsAt: new Date(now + 3 * 24 * 3600 * 1000).toISOString(),
    utilizationObservedAt: new Date(now - 60000).toISOString(),
  }];
  const base = { harness: 'claude', modelId: 'claude-sonnet-5-5', planLimits, now };
  assert.equal(planWindowExhaustedReason({ ...base, config: {} }), null);
  assert.ok(planWindowExhaustedReason({ ...base, config: { hardFreePercent: 15 } }));
  assert.equal(planWindowExhaustedReason({ ...base, config: { enabled: false, hardFreePercent: 15 } }), null);
});

test('buildPlanHeadroomSnapshot lists windows and is null when disabled', () => {
  const now = Date.parse('2026-10-01T00:00:00.000Z');
  const planLimits = [{
    harness: 'claude', rateLimitType: 'five_hour', utilization: 10,
    resetsAt: new Date(now + 3600000).toISOString(),
    utilizationObservedAt: new Date(now - 1000).toISOString(),
  }];
  const input = { planLimits, harnessId: 'claude', modelId: 'claude-sonnet-5-5', now };
  const snap = buildPlanHeadroomSnapshot(input);
  assert.equal(snap.windows[0].type, 'five_hour');
  assert.equal(snap.level, 3);
  assert.equal(buildPlanHeadroomSnapshot({ ...input, config: { enabled: false } }), null);
  assert.equal(buildPlanHeadroomSnapshot({ ...input, planLimits: [] }), null);
});
