import assert from 'node:assert/strict';
import { shouldReuseDeepSeekHarness } from '../lib/deepseek/deepseek-harness-cache.js';

const mockHarness = { close: () => {} };

assert.equal(shouldReuseDeepSeekHarness(null, 'rev-1', false), false);
assert.equal(shouldReuseDeepSeekHarness({}, 'rev-1', false), false);
assert.equal(
  shouldReuseDeepSeekHarness({ _harness: mockHarness, _mcpRevision: 'rev-1', _reviewReadOnly: false }, 'rev-1', false),
  true,
);
assert.equal(
  shouldReuseDeepSeekHarness({ _harness: mockHarness, _mcpRevision: 'rev-1', _reviewReadOnly: false }, 'rev-2', false),
  false,
);
assert.equal(
  shouldReuseDeepSeekHarness({ _harness: mockHarness, _mcpRevision: 'rev-1', _reviewReadOnly: false }, 'rev-1', true),
  false,
);
assert.equal(
  shouldReuseDeepSeekHarness({ _harness: mockHarness, _mcpRevision: 'rev-1', _reviewReadOnly: true }, 'rev-1', true),
  true,
);

console.log('deepseek-harness-reuse.test.js OK');
