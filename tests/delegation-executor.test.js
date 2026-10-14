import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { registerMockChatRunAdapter, resetMockChatRuns } from '../lib/chat-run/mock-adapter.js';
import {
  describeUnavailableDelegationModel,
  isDelegationModelAvailable,
  resolveDelegationModel,
  resolveDelegationModelDetailed,
  describeEffortUnavailable,
  describeModelResolution,
  normalizeEffortParam,
} from '../lib/delegation-executor.js';

resetMockChatRuns();
registerMockChatRunAdapter('opencode');
registerMockChatRunAdapter('sdk');

assert.equal(isDelegationModelAvailable({ transport: 'opencode', model: '', settings: {} }), false);
assert.equal(isDelegationModelAvailable({ transport: 'opencode', model: 'opencode/test', settings: {} }), true);
assert.equal(isDelegationModelAvailable({
  transport: 'opencode',
  model: 'opencode/test',
  settings: { opencodeChatEnabledModels: ['other-model'] },
}), false);
assert.equal(isDelegationModelAvailable({
  transport: 'opencode',
  model: 'opencode/test',
  settings: { opencodeChatEnabledModels: ['opencode/test'] },
}), true);
assert.equal(isDelegationModelAvailable({
  transport: 'opencode',
  model: 'opencode/test',
  settings: { enabledHarnesses: ['sdk'] },
}), false);
assert.equal(isDelegationModelAvailable({
  transport: 'sdk',
  model: 'auto',
  settings: {},
}), true);

const grokSettings = {
  chatEnabledModels: [
    'grok-4.6::effort=high,fast=false',
    'grok-4.6::effort=high,fast=true',
    'grok-4.6::effort=medium,fast=false',
    'grok-4.6::effort=medium,fast=true',
  ],
};

assert.equal(
  resolveDelegationModel({ transport: 'sdk', model: 'grok-4.6', settings: grokSettings }),
  'grok-4.6::effort=high,fast=false',
);
assert.equal(
  resolveDelegationModel({ transport: 'sdk', model: 'grok-4.6 medium', settings: grokSettings }),
  'grok-4.6::effort=medium,fast=false',
);
assert.equal(
  resolveDelegationModel({ transport: 'sdk', model: 'grok-4.6 High', settings: grokSettings }),
  'grok-4.6::effort=high,fast=false',
);
assert.equal(
  resolveDelegationModel({
    transport: 'sdk',
    model: 'grok-4.6::effort=high',
    settings: grokSettings,
  }),
  'grok-4.6::effort=high,fast=false',
);
assert.equal(
  resolveDelegationModel({
    transport: 'sdk',
    model: 'grok-4.6::effort=high,fast=false',
    settings: grokSettings,
  }),
  'grok-4.6::effort=high,fast=false',
);
assert.equal(
  resolveDelegationModel({ transport: 'sdk', model: 'grok-4.5', settings: grokSettings }),
  '',
);
assert.equal(
  resolveDelegationModel({ transport: 'sdk', model: 'composer-2', settings: grokSettings }),
  '',
);
assert.equal(
  isDelegationModelAvailable({ transport: 'sdk', model: 'grok-4.6', settings: grokSettings }),
  true,
);
assert.equal(
  isDelegationModelAvailable({ transport: 'sdk', model: 'grok-4.5', settings: grokSettings }),
  false,
);

registerMockChatRunAdapter('codex');
const inputCodexSettings = {
  enabledHarnesses: ['codex'],
  codexChatEnabledModels: ['gpt-6-astra::effort=medium'],
};
// A requested effort that is not enabled is refused, never lowered silently.
assert.equal(
  resolveDelegationModel({
    transport: 'codex',
    model: 'gpt-6-astra::effort=high',
    settings: inputCodexSettings,
  }),
  '',
);
const actualEffort = resolveDelegationModelDetailed({
  transport: 'codex',
  model: 'gpt-6-astra::effort=high',
  settings: inputCodexSettings,
});
assert.equal(actualEffort.code, 'effort_unavailable');
assert.deepEqual(actualEffort.availableEfforts, ['medium']);
assert.match(describeEffortUnavailable(actualEffort), /available efforts: medium/);
assert.equal(
  resolveDelegationModelDetailed({
    transport: 'codex',
    model: 'gpt-6-astra::effort=extra-high',
    settings: inputCodexSettings,
  }).requestedEffort,
  'xhigh',
);
// grok-style `reasoning_effort` is normalized the same way.
const inputGrokReasoning = {
  chatEnabledModels: ['grok-4.7::reasoning_effort=low', 'grok-4.7::reasoning_effort=medium'],
};
assert.equal(
  resolveDelegationModelDetailed({
    transport: 'sdk', model: 'grok-4.7::reasoning_effort=high', settings: inputGrokReasoning,
  }).code,
  'effort_unavailable',
);
assert.equal(
  resolveDelegationModel({
    transport: 'sdk', model: 'grok-4.7::reasoning_effort=medium', settings: inputGrokReasoning,
  }),
  'grok-4.7::reasoning_effort=medium',
);
// Free-text effort tokens (max, minimal, extra-high) are recognized, never dropped silently.
const inputFreeText = {
  enabledHarnesses: ['codex'],
  codexChatEnabledModels: ['gpt-6-astra::effort=max', 'gpt-6-astra::effort=low', 'gpt-6-astra::effort=medium'],
};
assert.equal(
  resolveDelegationModel({ transport: 'codex', model: 'gpt-6-astra max', settings: inputFreeText }),
  'gpt-6-astra::effort=max',
);
assert.equal(
  resolveDelegationModel({ transport: 'codex', model: 'gpt-6-astra minimal', settings: inputFreeText }),
  'gpt-6-astra::effort=low',
);
const inputFreeTextMedium = {
  enabledHarnesses: ['codex'],
  codexChatEnabledModels: ['gpt-6-astra::effort=medium'],
};
for (const word of ['max', 'minimal']) {
  const actualFreeText = resolveDelegationModelDetailed({
    transport: 'codex', model: `gpt-6-astra ${word}`, settings: inputFreeTextMedium,
  });
  assert.equal(actualFreeText.code, 'effort_unavailable', word);
  assert.deepEqual(actualFreeText.availableEfforts, ['medium'], word);
}
const actualResolution = describeModelResolution('claude-sonnet-5-5::effort=high', 'claude-sonnet-5-5::effort=low');
assert.equal(actualResolution.model_downgraded, true);
assert.equal(describeModelResolution('a::effort=low', 'a::effort=low').model_downgraded, false);
assert.deepEqual(normalizeEffortParam([{ id: 'reasoning_effort', value: 'extra-high' }]), { level: 'xhigh', key: 'reasoning_effort' });
assert.equal(
  resolveDelegationModel({
    transport: 'codex',
    model: 'gpt-6-astra::effort=medium',
    settings: inputCodexSettings,
  }),
  'gpt-6-astra::effort=medium',
);
const actualUnavailable = describeUnavailableDelegationModel({
  transport: 'codex',
  settings: inputCodexSettings,
});
assert.match(actualUnavailable, /favorites/);
assert.match(actualUnavailable, /gpt-6-astra::effort=medium/);
assert.match(actualUnavailable, /enabled_only=true/);
assert.equal(
  resolveDelegationModel({
    transport: 'codex',
    model: 'qwen3.8-max',
    settings: inputCodexSettings,
  }),
  '',
);

registerMockChatRunAdapter('opencode');
const inputManyEnabled = Array.from({ length: 10 }, (_, i) => `opencode/model-${i}`);
const actualManyUnavailable = describeUnavailableDelegationModel({
  transport: 'opencode',
  settings: { opencodeChatEnabledModels: inputManyEnabled },
});
assert.match(actualManyUnavailable, /opencode\/model-0/);
assert.match(actualManyUnavailable, /opencode\/model-7/);
assert.equal(actualManyUnavailable.includes('opencode/model-8'), false);
assert.match(actualManyUnavailable, /\(10 total\)/);
assert.equal(
  resolveDelegationModel({
    transport: 'sdk',
    model: 'grok-4.6',
    settings: grokSettings,
  }),
  grokSettings.chatEnabledModels[0],
);

const inputEmptyFavorites = { opencodeChatEnabledModels: [] };
assert.equal(
  resolveDelegationModel({
    transport: 'opencode',
    model: 'opencode/test',
    settings: inputEmptyFavorites,
  }),
  'opencode/test',
);
const actualEmptyUnavailable = describeUnavailableDelegationModel({
  transport: 'opencode',
  settings: inputEmptyFavorites,
});
assert.match(actualEmptyUnavailable, /favorites/);
assert.doesNotMatch(actualEmptyUnavailable, /Enabled:/);
assert.match(actualEmptyUnavailable, /enabled_only=true/);

const previousEmptyPolicy = process.env.CRETLI_DELEGATION_EMPTY_FAVORITES;
process.env.CRETLI_DELEGATION_EMPTY_FAVORITES = 'deny';
assert.equal(
  resolveDelegationModel({
    transport: 'opencode',
    model: 'opencode/test',
    settings: inputEmptyFavorites,
  }),
  '',
);
assert.match(
  describeUnavailableDelegationModel({ transport: 'opencode', settings: inputEmptyFavorites }),
  /No Settings favorites/,
);
assert.match(
  describeUnavailableDelegationModel({ transport: 'opencode', settings: inputEmptyFavorites }),
  /not start-eligible/,
);
assert.match(
  describeUnavailableDelegationModel({ transport: 'opencode', settings: inputEmptyFavorites }),
  /settings files/,
);
if (previousEmptyPolicy == null) delete process.env.CRETLI_DELEGATION_EMPTY_FAVORITES;
else process.env.CRETLI_DELEGATION_EMPTY_FAVORITES = previousEmptyPolicy;

console.log('delegation-executor.test.js OK');
