import assert from 'node:assert/strict';
import { effortBarCount, formatModelDisplay, prettifyModelId } from '../app_front/features/chat/modelDisplay.js';
import { getHarnessBadge } from '../app_front/core/harness/harnessBadge.js';

// Raw catalog ids become readable names.
assert.equal(prettifyModelId('claude-opus-5-5'), 'Opus 5.5');
assert.equal(prettifyModelId('claude-sonnet-4-5-20250929'), 'Sonnet 4.5');
assert.equal(prettifyModelId('gpt-5.6-sol'), 'GPT-5.6 Sol');
assert.equal(prettifyModelId('gpt-5-codex'), 'GPT-5 Codex');
assert.equal(prettifyModelId('deepseek-v4-pro'), 'DeepSeek V4 Pro');
assert.equal(prettifyModelId('anthropic/claude-haiku-5-5'), 'Haiku 5.5');
assert.equal(prettifyModelId('qwen3-coder-plus'), 'Qwen3 Coder Plus');
assert.equal(prettifyModelId('auto'), 'Auto');

// Effort is split off the stored value and never leaks into the name.
assert.deepEqual(
  formatModelDisplay('claude-opus-5-5::effort=medium'),
  { name: 'Opus 5.5', effort: 'medium', id: 'claude-opus-5-5' },
);
assert.deepEqual(
  formatModelDisplay('gpt-5.6-luna::effort=extra-high,verbosity=low'),
  { name: 'GPT-5.6 Luna', effort: 'xhigh', id: 'gpt-5.6-luna' },
);

// A distinct catalog label wins; the effort variant suffix is stripped.
assert.equal(formatModelDisplay('claude-opus-5-5::effort=high', 'Opus 5.5 — HIGH').name, 'Opus 5.5');
assert.equal(formatModelDisplay('grok-5', 'Grok 5 Fast').name, 'Grok 5 Fast');
assert.deepEqual(
  formatModelDisplay('gpt-6-astra::effort=xhigh', 'GPT-6 Astra — Extra High'),
  { name: 'GPT-6 Astra', effort: 'xhigh', id: 'gpt-6-astra' },
);
assert.equal(formatModelDisplay('gpt-6-astra::effort=ultra', 'GPT-6 Astra — Ultra').effort, 'ultra');
assert.equal(effortBarCount('ultra'), 4);
// The harness badge names the vendor, so a `Claude` prefix is dropped.
assert.equal(formatModelDisplay('claude-opus-5-5', 'Claude Opus 5.5').name, 'Opus 5.5');
// A hyphenated label without params is a real name, not a variant suffix.
assert.equal(formatModelDisplay('model-x', 'Model X - Preview').name, 'Model X - Preview');
// A label that only echoes the id is not a display name.
assert.equal(formatModelDisplay('claude-opus-5-5::effort=low', 'claude-opus-5-5::effort=low').name, 'Opus 5.5');
assert.equal(formatModelDisplay('glm-5', 'glm-5').name, 'GLM 5');

assert.equal(effortBarCount('low'), 1);
assert.equal(effortBarCount('medium'), 2);
assert.equal(effortBarCount('high'), 3);
assert.equal(effortBarCount('max'), 4);
assert.equal(effortBarCount(''), 0);

assert.deepEqual(getHarnessBadge('claude'), { text: 'Cl', tone: 'warn' });
assert.deepEqual(getHarnessBadge('acme-agent', 'Acme Agent'), { text: 'Ac', tone: 'neutral' });

console.log('chat-model-display tests passed');
