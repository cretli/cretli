import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeUsageLimitResumeSettings,
  readUsageLimitResumeSettings,
  USAGE_LIMIT_RESUME_DEFAULTS,
} from '../lib/usage-limit-resume-settings.js';

test('missing or malformed block is the disabled defaults', () => {
  assert.deepEqual(normalizeUsageLimitResumeSettings(undefined), USAGE_LIMIT_RESUME_DEFAULTS);
  assert.deepEqual(normalizeUsageLimitResumeSettings('x'), USAGE_LIMIT_RESUME_DEFAULTS);
  assert.equal(USAGE_LIMIT_RESUME_DEFAULTS.enabled, false);
  assert.equal(readUsageLimitResumeSettings({}).enabled, false);
});

test('numbers are clamped to their bounds', () => {
  const s = normalizeUsageLimitResumeSettings({
    marginMs: -5, jitterMs: 9e9, maxChain: 99, maxPerTick: 0, catchUpMs: 'abc',
  });
  assert.equal(s.marginMs, 0);
  assert.equal(s.jitterMs, 600000);
  assert.equal(s.maxChain, 5);
  assert.equal(s.maxPerTick, 1);
  assert.equal(s.catchUpMs, 900000);
});

test('explicit values and booleans are kept; non-booleans fall back', () => {
  const s = normalizeUsageLimitResumeSettings({ enabled: true, allowPremium: 'yes', resumeDelegations: false, marginMs: 5000 });
  assert.equal(s.enabled, true);
  assert.equal(s.allowPremium, false);
  assert.equal(s.resumeDelegations, false);
  assert.equal(s.marginMs, 5000);
  assert.equal(readUsageLimitResumeSettings({ usageLimitResume: { enabled: true } }).enabled, true);
});
