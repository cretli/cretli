import assert from 'node:assert/strict';
import {
  buildHarnessLaunchLabel,
  normalizeHarnessTransport,
  resolveHarnessDisplayLabel,
  resolveHarnessModeLabel,
} from '../app_front/features/chat/sdk-transport-labels.js';

assert.equal(normalizeHarnessTransport('sdk'), 'sdk');
assert.equal(normalizeHarnessTransport('openrouter'), 'openrouter');
assert.equal(normalizeHarnessTransport('opencode'), 'opencode');
assert.equal(normalizeHarnessTransport('unknown'), 'sdk');

assert.equal(resolveHarnessDisplayLabel('sdk'), 'SDK');
assert.equal(resolveHarnessDisplayLabel('openrouter'), 'OpenRouter');
assert.equal(resolveHarnessDisplayLabel('opencode'), 'OpenCode');

assert.equal(resolveHarnessModeLabel('sdk', 'plan'), 'Plan');
assert.equal(resolveHarnessModeLabel('sdk', 'agent'), 'Agent');
assert.equal(resolveHarnessModeLabel('openrouter', 'plan'), 'Ask');
assert.equal(resolveHarnessModeLabel('openrouter', 'agent'), 'Agent');
assert.equal(resolveHarnessModeLabel('opencode', 'plan'), 'Plan');

assert.equal(
  buildHarnessLaunchLabel({
    transport: 'sdk',
    mode: 'plan',
    sessionRef: '12345678',
  }),
  '@cursor/sdk · Plan · session 12345678…'
);
assert.equal(
  buildHarnessLaunchLabel({
    transport: 'openrouter',
    mode: 'plan',
    sessionRef: '12345678',
  }),
  'OpenRouter · Ask · session 12345678…'
);
assert.equal(
  buildHarnessLaunchLabel({
    transport: 'opencode',
    mode: 'agent',
    sessionRef: '12345678',
  }),
  'OpenCode · Agent · session 12345678…'
);

console.log('sdk-transport-labels.test.js OK');
