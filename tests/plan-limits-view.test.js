import assert from 'node:assert/strict';
import test from 'node:test';
import { renderPlanLimitsHtml } from '../app_front/features/usage/planLimitsView.js';

const t = (key, vars = {}) => `${key} ${Object.values(vars).join(' ')}`;

test('missing percentages, expired windows and lockouts do not invent a progress bar', () => {
  assert.match(renderPlanLimitsHtml({}, { t }), /usage.planEmpty/);
  const html = renderPlanLimitsHtml({ planLimits: [
    { harness: 'qwen', status: 'allowed' },
    { harness: 'sdk', utilization: 95, remainingPercent: null, expired: true },
  ], lockouts: [{ harness: 'codex', model: '<script>', resetAt: '2026-10-02T20:00:00Z' }] }, { t });
  assert.doesNotMatch(html, /<progress/);
  assert.match(html, /usage.planExpired/);
  assert.match(html, /usage.planLocked/);
  assert.doesNotMatch(html, /<script>/);
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
