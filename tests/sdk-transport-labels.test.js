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
assert.equal(normalizeHarnessTransport('codebuddy'), 'codebuddy');
assert.equal(normalizeHarnessTransport('deepseek'), 'deepseek');
assert.equal(normalizeHarnessTransport('codex'), 'codex');
assert.equal(normalizeHarnessTransport('qwen'), 'qwen');
assert.equal(normalizeHarnessTransport('unknown'), 'sdk');

assert.equal(resolveHarnessDisplayLabel('sdk'), 'SDK');
assert.equal(resolveHarnessDisplayLabel('openrouter'), 'OpenRouter');
assert.equal(resolveHarnessDisplayLabel('opencode'), 'OpenCode');
assert.equal(resolveHarnessDisplayLabel('codebuddy'), 'CodeBuddy');
assert.equal(resolveHarnessDisplayLabel('deepseek'), 'DeepSeek');
assert.equal(resolveHarnessDisplayLabel('codex'), 'Codex');
assert.equal(resolveHarnessDisplayLabel('qwen'), 'Qwen');

assert.equal(resolveHarnessModeLabel('sdk', 'plan'), 'Plan');
assert.equal(resolveHarnessModeLabel('sdk', 'agent'), 'Agent');
assert.equal(resolveHarnessModeLabel('openrouter', 'plan'), 'Ask');
assert.equal(resolveHarnessModeLabel('openrouter', 'agent'), 'Agent');
assert.equal(resolveHarnessModeLabel('opencode', 'plan'), 'Plan');
assert.equal(resolveHarnessModeLabel('codebuddy', 'plan'), 'Plan');
assert.equal(resolveHarnessModeLabel('codebuddy', 'agent'), 'Agent');

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
assert.equal(
  buildHarnessLaunchLabel({
    transport: 'codebuddy',
    mode: 'plan',
    sessionRef: '12345678',
  }),
  'CodeBuddy · Plan · session 12345678…'
);
assert.equal(
  buildHarnessLaunchLabel({
    transport: 'deepseek',
    mode: 'plan',
    sessionRef: '12345678',
  }),
  'DeepSeek · Plan · session 12345678…'
);
assert.equal(
  buildHarnessLaunchLabel({
    transport: 'codex',
    mode: 'agent',
    sessionRef: '12345678',
  }),
  'Codex · Agent · session 12345678…'
);
assert.equal(
  buildHarnessLaunchLabel({
    transport: 'qwen',
    mode: 'plan',
    sessionRef: '12345678',
  }),
  'Qwen · Plan · session 12345678…'
);

console.log('sdk-transport-labels.test.js OK');
