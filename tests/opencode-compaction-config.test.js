/**
 * Native OpenCode compaction config: prune=true by default, auto/reserved
 * configurable, and the generated server config carries the block.
 */

import assert from 'node:assert/strict';
import {
  OPENCODE_COMPACTION_DEFAULTS,
  OPENCODE_COMPACTION_ENV,
  buildOpenCodeServerConfig,
  resolveOpenCodeCompactionConfig,
  summarizeOpenCodeSession,
} from '../lib/opencode/opencode-compaction-config.js';

// Defaults: deterministic prune stays on, automatic compaction stays on, and no
// reserved budget is written so OpenCode keeps its own computed default.
const defaults = resolveOpenCodeCompactionConfig({}, {});
assert.equal(defaults.auto, true);
assert.equal(defaults.prune, true);
assert.equal('reserved' in defaults, false, 'reserved is omitted when unconfigured');
assert.equal(defaults.auto, OPENCODE_COMPACTION_DEFAULTS.auto);
assert.equal(defaults.prune, OPENCODE_COMPACTION_DEFAULTS.prune);

// Settings are honored, including reserved.
const fromSettings = resolveOpenCodeCompactionConfig({
  opencodeCompaction: { auto: false, prune: false, reserved: 12345 },
}, {});
assert.equal(fromSettings.auto, false);
assert.equal(fromSettings.prune, false);
assert.equal(fromSettings.reserved, 12345);

// Env overrides settings; invalid env values fall through instead of throwing.
const fromEnv = resolveOpenCodeCompactionConfig(
  { opencodeCompaction: { auto: false, reserved: 1 } },
  {
    [OPENCODE_COMPACTION_ENV.auto]: 'true',
    [OPENCODE_COMPACTION_ENV.prune]: '0',
    [OPENCODE_COMPACTION_ENV.reserved]: '20000',
  },
);
assert.equal(fromEnv.auto, true);
assert.equal(fromEnv.prune, false);
assert.equal(fromEnv.reserved, 20000);

const invalidEnv = resolveOpenCodeCompactionConfig(
  { opencodeCompaction: { auto: false, reserved: 7 } },
  {
    [OPENCODE_COMPACTION_ENV.auto]: 'maybe',
    [OPENCODE_COMPACTION_ENV.reserved]: '-5',
  },
);
assert.equal(invalidEnv.auto, false);
assert.equal(invalidEnv.reserved, 7);

// Generated server config always carries compaction, and merges a provider.
const withoutProvider = buildOpenCodeServerConfig({ settings: {}, env: {} });
assert.equal(withoutProvider.compaction.prune, true);
assert.equal(withoutProvider.compaction.auto, true);
assert.equal('provider' in withoutProvider, false);

const withProvider = buildOpenCodeServerConfig({
  settings: { opencodeCompaction: { reserved: 4096 } },
  env: {},
  provider: { demo: { npm: '@ai-sdk/openai-compatible' } },
});
assert.equal(withProvider.compaction.prune, true);
assert.equal(withProvider.compaction.reserved, 4096);
assert.equal(typeof withProvider.provider, 'object');
assert.ok(withProvider.provider.demo);

// The native summarize seam calls POST /session/:id/summarize with the model.
let captured = null;
const fakeClient = {
  session: {
    summarize: async (input) => {
      captured = input;
      return true;
    },
  },
};
const result = await summarizeOpenCodeSession(fakeClient, {
  sessionID: 'sess-1',
  providerID: 'deepseek',
  modelID: 'deepseek-flash',
  directory: '/tmp/ws',
});
assert.equal(result, true);
assert.deepEqual(captured, {
  path: { id: 'sess-1' },
  body: { providerID: 'deepseek', modelID: 'deepseek-flash' },
  query: { directory: '/tmp/ws' },
});
await assert.rejects(() => summarizeOpenCodeSession(null, { sessionID: 'x' }));

console.log('opencode-compaction-config.test.js OK');
