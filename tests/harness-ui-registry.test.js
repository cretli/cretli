import assert from 'node:assert/strict';
import { CORE_AGENT_TRANSPORTS, VALID_TRANSPORTS } from '../lib/agent-transport.js';
import {
  getHarnessUiMeta,
  listFirstRunHarnessMeta,
  listHarnessUiIds,
  listHarnessUiMeta,
  normalizeHarnessUiId,
  resolveHarnessUiMeta,
} from '../app_front/core/harness/harnessUiRegistry.js';

// Every transport of the server has a front-end entry, and nothing else does.
assert.deepEqual([...listHarnessUiIds()].sort(), [...VALID_TRANSPORTS].sort());
for (const id of VALID_TRANSPORTS) {
  const meta = getHarnessUiMeta(id);
  assert.ok(meta, `missing entry for ${id}`);
  assert.equal(meta.id, id);
  assert.equal(meta.core, CORE_AGENT_TRANSPORTS.includes(id), `core flag of ${id}`);
  for (const field of ['label', 'barLabel', 'launchLabel', 'settingsLabelKey', 'settingsTab', 'firstRunKeyField',
    'firstRunHintKey', 'modelsChangedEvent', 'enabledModelsSettingsKey', 'newChatErrorKey', 'catalogShape']) {
    assert.equal(typeof meta[field], 'string', `${id}.${field}`);
    assert.ok(meta[field], `${id}.${field} is empty`);
  }
  assert.equal(typeof meta.normalizeEnabledModels, 'function');
  assert.equal(meta.settingsTab, `harness-${id}`);
}
assert.equal(new Set(listHarnessUiMeta().map((m) => m.modelsChangedEvent)).size, VALID_TRANSPORTS.length);

// Labels, events and settings keys match the values the UI used before the registry.
const expectedLabels = {
  sdk: ['SDK', 'Cursor SDK', '@cursor/sdk'],
  openrouter: ['OpenRouter', 'OpenRouter', 'OpenRouter'],
  opencode: ['OpenCode', 'OpenCode', 'OpenCode'],
  codebuddy: ['CodeBuddy', 'CodeBuddy', 'CodeBuddy'],
  deepseek: ['DeepSeek', 'DeepSeek', 'DeepSeek'],
  mistral: ['Mistral', 'Mistral', 'Mistral'],
  zai: ['Z.AI SDK', 'Z.AI SDK', 'Z.AI SDK'],
  mimo: ['MiMo', 'MiMo', 'MiMo'],
  qwen: ['Qwen', 'Qwen', 'Qwen'],
  codex: ['Codex', 'Codex', 'Codex'],
  claude: ['Claude', 'Claude', 'Claude'],
};
for (const [id, [label, barLabel, launchLabel]] of Object.entries(expectedLabels)) {
  const meta = getHarnessUiMeta(id);
  assert.deepEqual([meta.label, meta.barLabel, meta.launchLabel], [label, barLabel, launchLabel], id);
}
assert.equal(getHarnessUiMeta('sdk').modelsChangedEvent, 'cretli-chat-models-changed');
assert.equal(getHarnessUiMeta('sdk').enabledModelsSettingsKey, 'chatEnabledModels');
assert.equal(getHarnessUiMeta('qwen').modelsChangedEvent, 'cretli-qwen-models-changed');
assert.equal(getHarnessUiMeta('qwen').enabledModelsSettingsKey, 'qwenChatEnabledModels');
assert.equal(getHarnessUiMeta('zai').statusMissingKey, 'settings.harnessStatusZaiMissing');
assert.equal(getHarnessUiMeta('openrouter').statusMissingKey, null);
assert.equal(getHarnessUiMeta('opencode').statusMissingKey, null);
assert.equal(getHarnessUiMeta('zai').contextTransportLabelKey, null);
assert.equal(getHarnessUiMeta('mimo').contextTransportLabelKey, null);
assert.equal(getHarnessUiMeta('codex').contextTransportLabelKey, 'chat.contextDetailsTransportCodex');
assert.equal(getHarnessUiMeta('mimo').modeBarNormalized, false);
assert.equal(getHarnessUiMeta('deepseek').normalizeEnabledModels !== getHarnessUiMeta('qwen').normalizeEnabledModels, true);

// Picker order and first-run order are preserved.
assert.deepEqual(listHarnessUiIds(), [
  'sdk', 'openrouter', 'opencode', 'codebuddy', 'deepseek', 'mistral', 'zai', 'mimo', 'qwen', 'codex', 'claude',
]);
assert.deepEqual(listFirstRunHarnessMeta().map((m) => m.id), [
  'openrouter', 'opencode', 'sdk', 'codebuddy', 'deepseek', 'mistral', 'zai', 'mimo', 'qwen', 'claude', 'codex',
]);

// Behaviour data that used to be inline branches.
assert.deepEqual(getHarnessUiMeta('zai').firstRunPayload, { zaiProvider: 'zai-coding-plan' });
assert.deepEqual(getHarnessUiMeta('opencode').firstRunKeyKinds.kinds.map((k) => [k.value, k.keyField, k.provider]), [
  ['zai-coding-plan', 'opencodeZaiApiKey', 'zai-coding-plan'],
  ['zai', 'opencodeZaiApiKey', 'zai'],
  ['zen', 'opencodeApiKey', null],
]);
assert.equal(getHarnessUiMeta('opencode').scopedCatalogReload, true);
assert.equal(getHarnessUiMeta('opencode').catalogConfirmedReadiness, true);
assert.equal(getHarnessUiMeta('codex').modelsChangedCarriesCatalog, true);
assert.deepEqual(
  listHarnessUiMeta().filter((m) => m.refreshStatusOnModelsChanged).map((m) => m.id),
  ['zai', 'mimo'],
);

// Lookups.
assert.equal(normalizeHarnessUiId(' Qwen ', 'sdk'), 'qwen');
assert.equal(normalizeHarnessUiId('nope', 'openrouter'), 'openrouter');
assert.equal(normalizeHarnessUiId(null, 'sdk'), 'sdk');
assert.equal(getHarnessUiMeta('nope'), null);
assert.equal(resolveHarnessUiMeta('nope').id, 'sdk');

console.log('harness-ui-registry.test.js: ok');
