import assert from 'node:assert/strict';
import {
  dedupeOpenCodeModelsForChat,
  resolveOpenCodeModelForPrompt,
} from '../lib/opencode/opencode-model-resolve.js';

assert.equal(
  resolveOpenCodeModelForPrompt('opencode-go/ox-alpha-free'),
  'opencode/x-preview-f-free'
);
assert.equal(resolveOpenCodeModelForPrompt('opencode/big-pickle'), 'opencode/big-pickle');

const deduped = dedupeOpenCodeModelsForChat([
  {
    id: 'opencode-go/ox-alpha-free',
    name: 'Ox Alpha Free (Unlimited)',
    providerId: 'opencode-go',
    modelId: 'ox-alpha-free',
    contextWindowTokens: 999999,
  },
  {
    id: 'opencode/x-preview-f-free',
    name: 'Ox Alpha Free (Unlimited)',
    providerId: 'opencode',
    modelId: 'x-preview-f-free',
    contextWindowTokens: 1000000,
  },
  { id: 'opencode/big-pickle', name: 'Big Pickle', providerId: 'opencode', modelId: 'big-pickle' },
]);
assert.equal(deduped.length, 2);
const preferredOxModel = deduped.find((m) => m.id === 'opencode/x-preview-f-free');
assert.ok(preferredOxModel);
assert.equal(preferredOxModel?.contextWindowTokens, 1000000);
assert.ok(!deduped.some((m) => m.id === 'opencode-go/ox-alpha-free'));

console.log('opencode-model-resolve.test.js OK');
