import assert from 'node:assert/strict';
import { getNewChatLimitResetTime, resolveNewChatUsageLimit } from '../app_front/features/chat/newChatUsageLimit.js';

const now = Date.parse('2026-01-01T10:00:00Z');
const modelLimit = { harness: 'codex', model: 'model-a', code: 'usage_limit', resetAt: '2026-01-01T11:00:00Z' };
assert.equal(resolveNewChatUsageLimit([modelLimit], 'codex', 'model-a::reasoning=high', now), modelLimit);
assert.equal(resolveNewChatUsageLimit([modelLimit], 'codex', 'model-b', now), null);
assert.equal(resolveNewChatUsageLimit([modelLimit], 'claude', 'model-a', now), null);
assert.equal(resolveNewChatUsageLimit([modelLimit], 'codex', 'model-a', now + 3600000), null);
const harnessLimit = { ...modelLimit, model: '' };
assert.equal(resolveNewChatUsageLimit([harnessLimit], 'codex', 'model-b', now), harnessLimit);
assert.equal(resolveNewChatUsageLimit([{ ...modelLimit, code: 'startup_failure' }], 'codex', 'model-a', now), null);
assert.equal(resolveNewChatUsageLimit([{ ...modelLimit, resetAt: 'invalid' }], 'codex', 'model-a', now), null);
assert.equal(resolveNewChatUsageLimit(null, 'codex', 'model-a', now), null);
assert.equal(getNewChatLimitResetTime(modelLimit, 'en'), '');
assert.equal(getNewChatLimitResetTime({ ...modelLimit, resetSource: 'ttl-fallback' }, 'en'), '');
assert.ok(getNewChatLimitResetTime({ ...modelLimit, resetSource: 'provider' }, 'en'));
assert.ok(getNewChatLimitResetTime({ ...modelLimit, resetSource: 'provider-message' }, 'pl'));
console.log('new-chat-usage-limit.test.js OK');
