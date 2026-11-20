import assert from 'node:assert/strict';
import test from 'node:test';
import { renderPlanLimitsView as _renderPlanLimitsView } from '../app_front/features/usage/planLimitsView.js';
import { templateToString as _str } from './helpers/lit-template-string.js';
const renderPlanLimitsHtml = (...args) => _str(_renderPlanLimitsView(...args));

const t = (key, vars = {}) => `${key} ${Object.values(vars).join(' ')}`;

test('missing percentages, expired windows and lockouts do not invent a progress bar', () => {
  assert.match(renderPlanLimitsHtml({}, { t }), /usage.planEmpty/);
  const html = renderPlanLimitsHtml({ planLimits: [
    { harness: 'qwen', status: 'allowed' },
    { harness: 'sdk', utilization: 95, remainingPercent: null, expired: true },
  ], lockouts: [{ harness: 'codex', model: '<script>', resetAt: '2026-10-02T20:00:00Z' }] }, { t });
  assert.doesNotMatch(html, /<progress/);
  assert.match(html, /usage.planExpired/);
  assert.match(html, /usage.planLockedUnconfirmed/);
  assert.doesNotMatch(html, /<script>/);
});

test('window labels, source, scope mismatch and confirmed lockout reset', () => {
  const row = {
    harness: 'claude',
    rateLimitType: 'five_hour',
    status: 'allowed_warning',
    utilization: 55,
    remainingPercent: 45,
    resetsAt: '2026-10-02T20:00:00Z',
    resetInMs: 3600000,
    observedAt: '2026-10-02T19:00:00Z',
    utilizationObservedAt: '2026-10-02T18:30:00Z',
    source: 'claude-sdk-rate-limit-event',
  };
  const html = renderPlanLimitsHtml({ planLimits: [row] }, { t, lang: 'en' });
  assert.match(html, /harnessHealth\.windowFiveHour/);
  assert.match(html, /harnessHealth\.windowWarning/);
  assert.match(html, /usage\.planSourceSdkRateLimit/);
  assert.match(html, /usage\.planUtilizationObserved/);
  const unknownWindow = renderPlanLimitsHtml({ planLimits: [{
    harness: 'claude', rateLimitType: 'custom_meter', status: 'allowed', observedAt: '2026-10-02T19:00:00Z',
  }] }, { t, lang: 'en' });
  assert.match(unknownWindow, /usage\.planWindowUnknown custom_meter/);
  const scope = renderPlanLimitsHtml({ planLimits: [{
    harness: 'claude', scopeMismatch: true, stale: true, observedAt: '2026-10-02T19:00:00Z',
  }] }, { t, lang: 'en' });
  assert.match(scope, /usage\.planScopeMismatch/);
  const lock = renderPlanLimitsHtml({ lockouts: [{
    harness: 'claude', model: 'opus', resetAt: '2026-10-02T20:00:00Z', resetSource: 'provider', rateLimitType: 'five_hour',
  }] }, { t, lang: 'en' });
  assert.match(lock, /usage\.planLocked/);
  assert.doesNotMatch(lock, /usage\.planLockedUnconfirmed/);
});

test('measured percentage and forecast are separate and stale data has no forecast text', () => {
  const row = { harness: 'claude', utilization: 82.5, remainingPercent: 17.5,
    resetsAt: '2026-10-02T20:00:00Z', resetInMs: 3600000,
    observedAt: '2026-10-02T19:00:00Z',
    forecast: { beforeReset: true, exhaustsAt: '2026-10-02T19:30:00Z' } };
  const html = renderPlanLimitsHtml({ planLimits: [row] }, { t });
  assert.match(html, /value="82.5"/);
  assert.match(html, /usage.planRemaining 17.5%/);
  assert.match(html, /usage.planForecast/);
  assert.match(html, /usage.planReset .*60/);
  const stale = renderPlanLimitsHtml({ planLimits: [{ ...row, stale: true }] }, { t });
  assert.match(stale, /harnessHealth.planLimitStaleShort/);
  assert.doesNotMatch(stale, /usage.planForecast/);
});

test('utilization percent is visible in HTML when measured and absent when unknown', () => {
  const measured = renderPlanLimitsHtml({ planLimits: [{
    harness: 'claude', utilization: 82.5, remainingPercent: 17.5,
    resetsAt: '2026-10-02T20:00:00Z', resetInMs: 3600000,
    observedAt: '2026-10-02T19:00:00Z',
  }] }, { t, lang: 'en' });
  assert.match(measured, /usage\.planUtilization 82\.5%/);
  assert.match(measured, /value="82\.5"/);
  const unknown = renderPlanLimitsHtml({ planLimits: [
    { harness: 'qwen', status: 'allowed', observedAt: '2026-10-02T19:00:00Z' },
    { harness: 'sdk', expired: true, observedAt: '2026-10-02T19:00:00Z' },
  ] }, { t, lang: 'en' });
  assert.doesNotMatch(unknown, /usage\.planUtilization/);
  assert.doesNotMatch(unknown, /<progress[^>]*value="/);
});
