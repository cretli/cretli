import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import test from 'node:test';
import {
  buildUsageAlertNotification,
  buildUsageAlertPushPayload,
  collectUsageAlerts,
  dispatchUsageAlerts,
  evaluateBudgetAlerts,
  evaluateLockoutAlerts,
  evaluatePlanLimitAlerts,
  readUsageAlertState,
  shouldNotifyUsageAlert,
} from '../lib/usage/usage-alerts.js';

const NOW = Date.parse('2026-06-01T12:00:00.000Z');

const FUTURE_RESET = '2026-06-01T18:00:00.000Z';
const PAST_RESET = '2026-06-01T06:00:00.000Z';

function planWindow(overrides = {}) {
  return {
    harness: 'claude',
    rateLimitType: 'session',
    resetsAt: FUTURE_RESET,
    observedAt: '2026-06-01T11:00:00.000Z',
    utilization: 90,
    expired: false,
    ...overrides,
  };
}

test('all alerts are off by default', () => {
  const alerts = collectUsageAlerts({
    windows: [planWindow()],
    lockouts: [{ harness: 'codex', model: 'gpt-5', resetAt: FUTURE_RESET }],
    dailySpendUsd: 100,
    monthlySpendUsd: 500,
    dayKey: '2026-06-01',
    monthKey: '2026-06',
    settings: {},
    now: NOW,
  });
  assert.deepEqual(alerts, []);
});

test('plan-limit alert fires at/above the threshold and not below', () => {
  assert.equal(evaluatePlanLimitAlerts([planWindow({ utilization: 79 })], { thresholdPercent: 80 }).length, 0);
  const alerts = evaluatePlanLimitAlerts([planWindow({ utilization: 80 })], { thresholdPercent: 80 });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, 'plan-limit');
  assert.equal(alerts[0].harness, 'claude');
  assert.equal(alerts[0].period, FUTURE_RESET);
});

test('plan-limit alert ignores expired windows and missing utilization', () => {
  assert.equal(evaluatePlanLimitAlerts([planWindow({ expired: true })], { thresholdPercent: 80 }).length, 0);
  assert.equal(evaluatePlanLimitAlerts([planWindow({ utilization: null })], { thresholdPercent: 80 }).length, 0);
});

test('plan-limit alert is enabled by settings and respects the configured percentage', () => {
  const alerts = collectUsageAlerts({
    windows: [planWindow({ utilization: 85 })],
    settings: { alerts: { planLimit: true, planLimitThresholdPercent: 90 } },
    now: NOW,
  });
  assert.deepEqual(alerts, []);
  const on = collectUsageAlerts({
    windows: [planWindow({ utilization: 85 })],
    settings: { alerts: { planLimit: true, planLimitThresholdPercent: 80 } },
    now: NOW,
  });
  assert.equal(on.length, 1);
});

test('lockout alert fires only for an active lockout', () => {
  const active = evaluateLockoutAlerts([{ harness: 'codex', model: 'gpt-5', resetAt: FUTURE_RESET }], { now: NOW });
  assert.equal(active.length, 1);
  assert.equal(active[0].kind, 'lockout');
  assert.equal(active[0].model, 'gpt-5');
  const reset = evaluateLockoutAlerts([{ harness: 'codex', model: 'gpt-5', resetAt: PAST_RESET }], { now: NOW });
  assert.equal(reset.length, 0);
});

test('budget alerts fire at/above the threshold and stay disabled when null', () => {
  assert.equal(evaluateBudgetAlerts({ dailySpendUsd: 4.99, dailyBudgetUsd: 5, dayKey: '2026-06-01' }).length, 0);
  const daily = evaluateBudgetAlerts({ dailySpendUsd: 5, dailyBudgetUsd: 5, dayKey: '2026-06-01' });
  assert.equal(daily.length, 1);
  assert.equal(daily[0].kind, 'budget-daily');
  assert.equal(daily[0].period, '2026-06-01');
  assert.equal(evaluateBudgetAlerts({ dailySpendUsd: 100, dailyBudgetUsd: null, dayKey: '2026-06-01' }).length, 0);
  const monthly = evaluateBudgetAlerts({ monthlySpendUsd: 200, monthlyBudgetUsd: 100, monthKey: '2026-06' });
  assert.equal(monthly.length, 1);
  assert.equal(monthly[0].kind, 'budget-monthly');
});

test('push payload and notification row are content-safe', () => {
  const alert = evaluatePlanLimitAlerts([planWindow({ utilization: 91 })], { thresholdPercent: 80 })[0];
  const payload = buildUsageAlertPushPayload(alert);
  assert.equal(payload.data.type, 'usage-alert');
  assert.equal(payload.data.url, '/?panel=settings&tab=usage');
  assert.match(payload.body, /91%/);
  const notification = buildUsageAlertNotification(alert);
  assert.equal(notification.category, 'system');
  assert.match(notification.fingerprint, /^usage-alert:plan-limit:claude:session:/);
});

test('dispatch notifies once per period and again for a new period', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cretli-usage-alerts-'));
  const settings = { alerts: { planLimit: true, planLimitThresholdPercent: 80 } };
  const signals = {
    windows: [planWindow()],
    lockouts: [],
    dailySpendUsd: 0,
    monthlySpendUsd: 0,
    dayKey: '2026-06-01',
    monthKey: '2026-06',
  };
  let pushed = 0;
  let published = 0;
  const notify = async () => { pushed += 1; };
  const publishNotification = async () => { published += 1; };

  const first = await dispatchUsageAlerts({ dataDir, now: NOW, settings, signals, notify, publishNotification });
  assert.deepEqual(first.notified, ['plan-limit']);
  assert.equal(pushed, 1);
  assert.equal(published, 1);

  const second = await dispatchUsageAlerts({ dataDir, now: NOW + 60_000, settings, signals, notify, publishNotification });
  assert.deepEqual(second.notified, []);
  assert.equal(pushed, 1);

  // A new reset window is a new crossing and notifies again.
  const nextSignals = { ...signals, windows: [planWindow({ resetsAt: '2026-06-02T06:00:00.000Z' })] };
  const third = await dispatchUsageAlerts({ dataDir, now: NOW + 120_000, settings, signals: nextSignals, notify, publishNotification });
  assert.deepEqual(third.notified, ['plan-limit']);
  assert.equal(pushed, 2);

  const state = readUsageAlertState(dataDir);
  assert.equal(shouldNotifyUsageAlert(state, { key: 'plan-limit:claude:session', period: '2026-06-02T06:00:00.000Z' }), false);
});

test('dispatch skips delivery when the alert channel is disabled', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cretli-usage-alerts-'));
  let pushed = 0;
  const result = await dispatchUsageAlerts({
    dataDir,
    now: NOW,
    settings: {},
    signals: { windows: [planWindow()], lockouts: [], dailySpendUsd: 0, monthlySpendUsd: 0 },
    notify: async () => { pushed += 1; },
    publishNotification: async () => {},
  });
  assert.equal(result.evaluated, 0);
  assert.equal(pushed, 0);
});

test('dispatch retries a crossing when every delivery channel fails', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cretli-usage-alerts-'));
  const settings = { alerts: { planLimit: true, planLimitThresholdPercent: 80 } };
  const signals = {
    windows: [planWindow()],
    lockouts: [],
    dailySpendUsd: 0,
    monthlySpendUsd: 0,
    dayKey: '2026-06-01',
    monthKey: '2026-06',
  };
  let pushed = 0;
  let published = 0;
  const notify = async () => { pushed += 1; throw new Error('push down'); };
  const publishNotification = async () => { published += 1; throw new Error('store down'); };

  const first = await dispatchUsageAlerts({ dataDir, now: NOW, settings, signals, notify, publishNotification });
  assert.deepEqual(first.notified, []);
  assert.equal(pushed, 1);
  assert.equal(published, 1);
  // A total failure must not record the period as handled.
  assert.deepEqual(readUsageAlertState(dataDir).alerts, {});

  // The next maintenance tick retries because the crossing was never marked.
  const second = await dispatchUsageAlerts({ dataDir, now: NOW + 5 * 60_000, settings, signals, notify, publishNotification });
  assert.deepEqual(second.notified, []);
  assert.equal(pushed, 2);
  assert.equal(published, 2);
  assert.deepEqual(readUsageAlertState(dataDir).alerts, {});
});

test('dispatch records the crossing once at least one channel succeeds', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cretli-usage-alerts-'));
  const settings = { alerts: { planLimit: true, planLimitThresholdPercent: 80 } };
  const signals = {
    windows: [planWindow()],
    lockouts: [],
    dailySpendUsd: 0,
    monthlySpendUsd: 0,
    dayKey: '2026-06-01',
    monthKey: '2026-06',
  };
  let pushed = 0;
  let published = 0;
  const notify = async () => { pushed += 1; };
  const publishNotification = async () => { published += 1; throw new Error('store down'); };

  const first = await dispatchUsageAlerts({ dataDir, now: NOW, settings, signals, notify, publishNotification });
  assert.deepEqual(first.notified, ['plan-limit']);
  assert.equal(pushed, 1);
  assert.equal(published, 1);

  // One accepted channel is enough: the same period is not delivered again.
  const second = await dispatchUsageAlerts({ dataDir, now: NOW + 5 * 60_000, settings, signals, notify, publishNotification });
  assert.deepEqual(second.notified, []);
  assert.equal(pushed, 1);
  assert.equal(published, 1);
});
