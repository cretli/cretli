import assert from 'node:assert/strict';
import {
  isUsageLimitMessage,
  noteHarnessUsageLimit,
  getHarnessUsageLimit,
} from '../lib/harness-usage-limits.js';
import { selectModelPick } from '../lib/model-role-profiles.js';

assert.equal(isUsageLimitMessage('Usage limit reached for 5 hour.'), true);
assert.equal(isUsageLimitMessage('429 quota has been exhausted'), true);
assert.equal(isUsageLimitMessage('permission denied'), false);

const model = `test-usage-limit-${process.pid}`;
assert.equal(noteHarnessUsageLimit({
  harness: 'opencode',
  model,
  message: 'Usage limit reached. Your limit will reset at 2099-01-02 03:04:05',
}), true);
assert.equal(getHarnessUsageLimit({ harness: 'opencode', model })?.usage, undefined);
assert.equal(getHarnessUsageLimit({ harness: 'opencode', model })?.model, model);
assert.equal(getHarnessUsageLimit({ harness: 'opencode', model: `${model}::effort=high` })?.model, model);

const picked = selectModelPick({
  role: 'implement',
  harnesses: [{ id: 'opencode', enabled: true, ready: true, can_delegate: true }],
  modelsByHarness: {
    opencode: {
      favorites_configured: true,
      items: [{ id: model, label: 'Limited', available: false, roles: ['implement'] }],
    },
  },
});
assert.equal(picked.ok, false);
assert.equal(picked.code, 'MODEL_UNAVAILABLE');

console.log('harness-usage-limits.test.js OK');
