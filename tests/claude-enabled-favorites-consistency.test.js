// Regression: model_list(enabled_only), the start gate (todo_start /
// delegation_start) and the CONFLICT "Enabled" list must share one favorites
// list and one alias canonicalization (sonnet <-> claude-sonnet-5-5), even when
// the catalog snapshot only knows Haiku.
import './helpers/isolated-data-dir.js';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { listHarnessModels } from '../lib/harness-catalog.js';
import { saveSettings } from '../lib/persist/settings.js';
import {
  buildNamedDelegationStartHardGateInput,
  evaluateDelegationStartHardGates,
} from '../lib/delegation-model-gates.js';
import {
  resolveDelegationModel,
  describeUnavailableDelegationModel,
  listEnabledDelegationModels,
} from '../lib/delegation-executor.js';
import { canonicalizeClaudeModelId } from '../lib/claude/claude-models.ts';
import { writeHarnessModelsSnapshot } from '../lib/harness-models-snapshot.js';
import { registerMockChatRunAdapter, resetMockChatRuns } from '../lib/chat-run/mock-adapter.ts';

resetMockChatRuns();
registerMockChatRunAdapter('claude');

// Alias canonicalization is derived from the catalog, not hardcoded.
assert.equal(canonicalizeClaudeModelId('sonnet'), 'claude-sonnet-5-5');
assert.equal(canonicalizeClaudeModelId('claude-sonnet-5-5'), 'claude-sonnet-5-5');

// Snapshot with only Haiku variants (the reported symptom).
writeHarnessModelsSnapshot({
  updatedAt: new Date().toISOString(),
  harnesses: {
    claude: {
      source: 'live',
      stale: false,
      entries: [
        { value: 'claude-haiku-5-5::effort=low', label: 'Haiku low', modelId: 'claude-haiku-5-5',
          params: [{ id: 'effort', value: 'low' }] },
      ],
    },
  },
});
saveSettings({
  enabledHarnesses: undefined,
  claudeChatEnabledModels: ['claude-haiku-5-5::effort=low', 'sonnet::effort=low'],
});

const listed = listHarnessModels({ harness: 'claude', enabledOnly: true }).items.map((r) => r.id);
assert.ok(listed.includes('sonnet::effort=low'), 'model_list lists the alias favorite');
assert.ok(listed.includes('claude-haiku-5-5::effort=low'));

function assertStartAccepts(requested) {
  const resolved = resolveDelegationModel({ transport: 'claude', model: requested });
  assert.equal(resolved, 'sonnet::effort=low', `${requested} resolves to the favorite`);
  const gate = evaluateDelegationStartHardGates({
    ...buildNamedDelegationStartHardGateInput({ harness: 'claude', model: resolved, role: 'review' }),
    allowPremium: true,
  });
  assert.notEqual(gate.code, 'model_not_favorite', `${requested} passes the favorites gate`);
  assert.ok(
    !/favorite/i.test(String(gate.error || gate.message || '')),
    `${requested} not refused for favorites: ${JSON.stringify(gate)}`,
  );
}
assertStartAccepts('sonnet::effort=low');
assertStartAccepts('claude-sonnet-5-5::effort=low');
assertStartAccepts('claude-sonnet-5-5');

// A different model stays rejected and the message lists only valid ids.
assert.equal(resolveDelegationModel({ transport: 'claude', model: 'claude-opus-5-5' }), '');
const message = describeUnavailableDelegationModel({ transport: 'claude' });
const printed = listEnabledDelegationModels({ transport: 'claude' });
assert.ok(printed.length >= 2);
for (const id of printed) {
  assert.ok(message.includes(id), `message prints ${id}`);
  assert.equal(resolveDelegationModel({ transport: 'claude', model: id }), id);
}
removeIsolatedDataDir();
console.log('ok');
