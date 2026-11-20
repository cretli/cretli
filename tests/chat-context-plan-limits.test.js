import assert from 'node:assert/strict';
import test from 'node:test';
import { renderChatContextPlanLimitsHtml } from '../app_front/features/chat/chatContextPlanLimitsView.js';
const t = (key, values = {}) => `${key} ${Object.values(values).join(' ')}`;
const options = { t, lang: 'en', now: Date.parse('2026-10-14T12:00:00Z') };

test('renders five-hour and weekly remaining percentages with renewal times', () => {
  const html = renderChatContextPlanLimitsHtml({ available: true, windows: [
    { rateLimitType: 'five_hour', utilization: 10, resetsAt: '2026-10-14T16:00:00Z' },
    { rateLimitType: 'seven_day', utilization: 17, resetsAt: '2026-10-21T12:00:00Z' },
  ] }, options);
  assert.match(html, /windowFiveHour/);
  assert.match(html, /windowSevenDay/);
  assert.match(html, /90%/);
  assert.match(html, /83%/);
  assert.match(html, /contextPlanRenews/);
  assert.equal((html.match(/role="progressbar"/g) || []).length, 2);
});

test('handles API-key mode, login, errors and loading without fabricated quotas', () => {
  assert.match(renderChatContextPlanLimitsHtml(null, options), /usage.loading/);
  assert.match(renderChatContextPlanLimitsHtml({ reason: 'api-key' }, options), /contextPlanLimitsApiKey/);
  assert.match(renderChatContextPlanLimitsHtml({ reason: 'login-required' }, options), /contextPlanLimitsLogin/);
  assert.match(renderChatContextPlanLimitsHtml({ reason: 'read-failed' }, options), /planCodexReadFailed/);
});

test('expired and missing readings do not show a remaining percentage; zero is valid', () => {
  const html = renderChatContextPlanLimitsHtml({ available: true, windows: [
    { rateLimitType: 'five_hour', utilization: 10, resetsAt: '2026-10-14T10:00:00Z' },
    { rateLimitType: 'seven_day', utilization: null },
    { rateLimitType: '<script>', utilization: 100 },
  ] }, options);
  assert.match(html, /contextPlanResetPending/);
  assert.doesNotMatch(html, /90%/);
  assert.match(html, /remaining 0%|contextPlanRemaining 0%/);
  assert.doesNotMatch(html, /<script>/);
});

test('shows pace under the bar: ahead of an even burn rate, with hourly ticks', () => {
  // 2h of 5h elapsed (40%), 10% used -> 30 pts of slack.
  const html = renderChatContextPlanLimitsHtml({ available: true, windows: [
    { rateLimitType: 'five_hour', utilization: 10, resetsAt: '2026-10-14T15:00:00Z' },
  ] }, options);
  assert.match(html, /data-pace="ahead"/);
  assert.match(html, /contextPlanPace_ahead 30/);
  assert.equal((html.match(/<i /g) || []).length, 4);
});
