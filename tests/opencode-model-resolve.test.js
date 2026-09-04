import assert from 'node:assert/strict';
import {
  dedupeOpenCodeModelsForChat,
  remapOpenCodeZaiModel,
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

assert.equal(remapOpenCodeZaiModel('zai/glm-5.3-flash', 'zai-coding-plan'), 'zai-coding-plan/glm-5.3-flash');
assert.equal(remapOpenCodeZaiModel('zai-coding-plan/glm-5.3-flash', 'zai'), 'zai/glm-5.3-flash');
assert.equal(remapOpenCodeZaiModel('opencode/big-pickle', 'zai-coding-plan'), 'opencode/big-pickle');

const zaiDupes = dedupeOpenCodeModelsForChat(
  [
    {
      id: 'zai/glm-5.3-flash',
      name: 'GLM-5.3-Flash',
      providerId: 'zai',
      modelId: 'glm-5.3-flash',
    },
    {
      id: 'zai-coding-plan/glm-5.3-flash',
      name: 'GLM-5.3-Flash',
      providerId: 'zai-coding-plan',
      modelId: 'glm-5.3-flash',
    },
  ],
  { preferredZaiProvider: 'zai-coding-plan' },
);
assert.equal(zaiDupes.length, 1);
assert.equal(zaiDupes[0]?.id, 'zai-coding-plan/glm-5.3-flash');

const paygDupes = dedupeOpenCodeModelsForChat(
  [
    {
      id: 'zai/glm-5.3-flash',
      name: 'GLM-5.3-Flash',
      providerId: 'zai',
      modelId: 'glm-5.3-flash',
    },
    {
      id: 'zai-coding-plan/glm-5.3-flash',
      name: 'GLM-5.3-Flash',
      providerId: 'zai-coding-plan',
      modelId: 'glm-5.3-flash',
    },
  ],
  { preferredZaiProvider: 'zai' },
);
assert.equal(paygDupes.length, 1);
assert.equal(paygDupes[0]?.id, 'zai/glm-5.3-flash');

console.log('opencode-model-resolve.test.js OK');
