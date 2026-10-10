import assert from 'node:assert/strict';
import test from 'node:test';
import {
  USAGE_DEFAULT_RETENTION_DAYS,
  USAGE_DEFAULT_PLAN_LIMIT_THRESHOLD_PERCENT,
  applyUsageSettingsPatch,
  getUsageSettings,
  normalizeUsageSettings,
} from '../lib/usage/usage-settings.js';

test('usage settings default: 90-day retention and every alert off', () => {
  const settings = normalizeUsageSettings(undefined);
  assert.equal(settings.retentionDays, USAGE_DEFAULT_RETENTION_DAYS);
  assert.equal(settings.retentionDays, 90);
  assert.equal(settings.alerts.planLimit, false);
  assert.equal(settings.alerts.lockout, false);
  assert.equal(settings.alerts.budget, false);
  assert.equal(settings.alerts.planLimitThresholdPercent, USAGE_DEFAULT_PLAN_LIMIT_THRESHOLD_PERCENT);
  assert.equal(settings.alerts.dailyBudgetUsd, null);
  assert.equal(settings.alerts.monthlyBudgetUsd, null);
});

test('getUsageSettings reads the config.usage slice', () => {
  const settings = getUsageSettings({
    usage: { retentionDays: 30, alerts: { planLimit: true, planLimitThresholdPercent: 95 } },
  });
  assert.equal(settings.retentionDays, 30);
  assert.equal(settings.alerts.planLimit, true);
  assert.equal(settings.alerts.lockout, false);
  assert.equal(settings.alerts.planLimitThresholdPercent, 95);
});

test('normalizeUsageSettings clamps out-of-range values and rejects bad budgets', () => {
  const settings = normalizeUsageSettings({
    retentionDays: 99999,
    alerts: {
      planLimitThresholdPercent: 0,
      dailyBudgetUsd: -5,
      monthlyBudgetUsd: 'abc',
    },
  });
  assert.equal(settings.retentionDays, 3650);
  assert.equal(settings.alerts.planLimitThresholdPercent, 1);
  assert.equal(settings.alerts.dailyBudgetUsd, null);
  assert.equal(settings.alerts.monthlyBudgetUsd, null);
});

test('applyUsageSettingsPatch is partial and keeps omitted alerts', () => {
  const base = normalizeUsageSettings({
    retentionDays: 45,
    alerts: { planLimit: true, lockout: true, budget: true, dailyBudgetUsd: 3 },
  });
  const patched = applyUsageSettingsPatch(base, { alerts: { planLimitThresholdPercent: 70 } });
  assert.equal(patched.retentionDays, 45);
  assert.equal(patched.alerts.planLimit, true);
  assert.equal(patched.alerts.lockout, true);
  assert.equal(patched.alerts.budget, true);
  assert.equal(patched.alerts.dailyBudgetUsd, 3);
  assert.equal(patched.alerts.planLimitThresholdPercent, 70);
});

test('applyUsageSettingsPatch can disable a budget with null', () => {
  const base = normalizeUsageSettings({ alerts: { budget: true, monthlyBudgetUsd: 100 } });
  const patched = applyUsageSettingsPatch(base, { alerts: { monthlyBudgetUsd: null } });
  assert.equal(patched.alerts.monthlyBudgetUsd, null);
  assert.equal(patched.alerts.budget, true);
});

test('applyUsageSettingsPatch keeps the stored budget for invalid patch values', () => {
  const base = normalizeUsageSettings({ alerts: { budget: true, dailyBudgetUsd: 3, monthlyBudgetUsd: 100 } });
  const patched = applyUsageSettingsPatch(base, {
    alerts: { dailyBudgetUsd: 'abc', monthlyBudgetUsd: -5 },
  });
  assert.equal(patched.alerts.dailyBudgetUsd, 3);
  assert.equal(patched.alerts.monthlyBudgetUsd, 100);

  // Empty and omitted values follow the same retention rule as the other fields.
  const empty = applyUsageSettingsPatch(base, { alerts: { dailyBudgetUsd: '', monthlyBudgetUsd: undefined } });
  assert.equal(empty.alerts.dailyBudgetUsd, 3);
  assert.equal(empty.alerts.monthlyBudgetUsd, 100);
});

test('applyUsageSettingsPatch never flips alerts on for a bad patch', () => {
  const base = normalizeUsageSettings({ alerts: { planLimit: false } });
  const patched = applyUsageSettingsPatch(base, { alerts: { planLimit: 'yes' } });
  assert.equal(patched.alerts.planLimit, false);
});

test('applyUsageSettingsPatch ignores null retention/threshold instead of clamping to 1', () => {
  const base = normalizeUsageSettings({ retentionDays: 60, alerts: { planLimitThresholdPercent: 70 } });
  const patched = applyUsageSettingsPatch(base, {
    retentionDays: null,
    alerts: { planLimitThresholdPercent: null },
  });
  assert.equal(patched.retentionDays, 60);
  assert.equal(patched.alerts.planLimitThresholdPercent, 70);
});
