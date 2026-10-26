import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeClaudeUsageLimits, getClaudePlanLimits } from '../lib/claude/claude-plan-limits.ts';
import { renderChatContextPlanLimitsHtml } from '../app_front/features/chat/chatContextPlanLimitsView.js';

const response = {
  rate_limits_available: true, subscription_type: 'max',
  rate_limits: {
    five_hour: { utilization: 42, resets_at: '2026-10-15T03:45:00Z' },
    seven_day: { utilization: 25.5, resets_at: '2026-10-21T16:36:00Z' },
    seven_day_opus: null,
    seven_day_sonnet: { utilization: 150, resets_at: null },
  },
};

test('normalizes SDK usage into the shared plan limit windows', () => {
  const result = normalizeClaudeUsageLimits(response, '2026-10-15T00:00:00Z');
  assert.equal(result.available, true);
  assert.equal(result.planType, 'max');
  assert.deepEqual(result.windows.map((entry) => entry.rateLimitType), ['five_hour', 'seven_day', 'seven_day_sonnet']);
  assert.equal(result.windows[0].utilization, 42);
  assert.equal(result.windows[2].utilization, undefined);
  assert.equal(normalizeClaudeUsageLimits({ rate_limits_available: false, rate_limits: null }), null);
});

test('a failing live query falls back to stored data without throwing', async () => {
  const query = { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => { throw new Error('x'); } };
  const result = await getClaudePlanLimits({ query });
  assert.equal(typeof result.available, 'boolean');
});

test('plan limit view titles Claude and explains missing data', () => {
  const t = (key) => key;
  assert.match(renderChatContextPlanLimitsHtml({ available: false, reason: 'no-data' }, { t, harness: 'claude' }), /contextPlanLimitsTitleClaude[\s\S]*contextPlanLimitsNoData/);
  const html = renderChatContextPlanLimitsHtml({ available: true, windows: [{ rateLimitType: 'five_hour', utilization: 42, resetsAt: '2099-01-01T00:00:00Z' }] }, { t, harness: 'claude' });
  assert.match(html, /58/);
});

test('a window without a percentage shows its status instead of a dash', () => {
  const t = (key) => (key === 'chat.contextPlanStatus_allowed' ? 'Within limit' : key);
  const html = renderChatContextPlanLimitsHtml({ available: true, windows: [{ rateLimitType: 'five_hour', status: 'allowed', resetsAt: '2099-01-01T00:00:00Z' }] }, { t, harness: 'claude' });
  assert.match(html, /Within limit/);
  assert.match(html, /contextPlanNoPercent/);
});

test('a stored reading older than an hour is flagged as stale, a fresh one is not', () => {
  const t = (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key);
  const now = Date.parse('2026-10-26T00:00:00Z');
  const window = (observedAt) => ({ rateLimitType: 'seven_day', utilization: 29, resetsAt: '2026-10-30T20:00:00Z', observedAt });
  const old = renderChatContextPlanLimitsHtml({ available: true, stored: true, windows: [window('2026-10-24T21:00:00Z')] }, { t, harness: 'claude', now });
  assert.match(old, /contextPlanStaleReading/);
  assert.match(old, /contextPlanAgeHours:\{\\&quot;n\\&quot;:27\}/);
  const fresh = renderChatContextPlanLimitsHtml({ available: true, stored: true, windows: [window('2026-10-25T23:50:00Z')] }, { t, harness: 'claude', now });
  assert.doesNotMatch(fresh, /contextPlanStaleReading/);
  const live = renderChatContextPlanLimitsHtml({ available: true, windows: [window('2026-10-24T21:00:00Z')] }, { t, harness: 'claude', now });
  assert.doesNotMatch(live, /contextPlanStaleReading/);
});

test('without a session an opt-in throwaway SDK query supplies live limits and is closed', async () => {
  const { setClaudeSdkForTests, resetClaudeSdkForTests } = await import('../lib/claude/claude-sdk.ts');
  let closed = false;
  setClaudeSdkForTests({
    query: () => ({
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => response,
      close: () => { closed = true; },
    }),
  });
  const prev = process.env.CLAUDE_AUTH_MODE;
  try {
    const result = await getClaudePlanLimits({ allowEphemeral: true });
    if (result.available && result.liveStatus === 'ok') {
      assert.equal(result.windows.find((w) => w.rateLimitType === 'seven_day').utilization, 25.5);
      assert.equal(closed, true);
    } else {
      assert.equal(result.reason, 'api-key'); // auth mode is not subscription in this environment
    }
  } finally {
    resetClaudeSdkForTests();
    if (prev === undefined) delete process.env.CLAUDE_AUTH_MODE; else process.env.CLAUDE_AUTH_MODE = prev;
  }
});
