import assert from 'node:assert/strict';
import { buildNewChatModelOptions, encodeNewChatModelChoice, decodeNewChatModelChoice } from '../app_front/features/chat/newChatModelOptions.js';

const translate = (key, values = {}) => `${key}${values.time || ''}`;
const harnesses = [
  { id: 'zai', label: 'Z.AI', ready: true, models: [{ value: 'z', label: 'Model Z' }] },
  { id: 'codex', label: 'Codex', ready: true, models: [{ value: 'model-10', label: 'Model 10' }, { value: 'model-2', label: 'Model 2' }, { value: 'blocked', label: 'A blocked model' }] },
  { id: 'claude', label: 'Claude', ready: false, error: 'Missing credentials', models: [] },
];
const lockouts = [{ harness: 'codex', model: 'blocked', resetAt: new Date(Date.now() + 3600000).toISOString(), code: 'usage_limit' }];
const rows = buildNewChatModelOptions(harnesses, lockouts, translate);
assert.deepEqual(rows.map((row) => row.group), ['Claude', 'Codex', 'Codex', 'Codex', 'Z.AI']);
assert.deepEqual(rows.filter((row) => row.group === 'Codex').map((row) => row.label), ['Model 2', 'Model 10', 'A blocked model']);
assert.equal(rows[0].disabled, true);
assert.equal(rows[0].description, 'Missing credentials');
assert.equal(rows[1].disabled, false);
assert.equal(rows[3].disabled, true);
assert.equal(rows[3].status, 'chat.newLimitedBadge');
assert.equal(rows[3].description, 'chat.newLimit');
assert.equal(rows[4].disabled, false);
assert.ok(buildNewChatModelOptions(harnesses, lockouts, translate, { limitsPending: true }).every((row) => row.disabled));
const unknown = buildNewChatModelOptions([{ id: 'codex', label: 'Codex', ready: null, checking: true, models: [] }], [], translate);
assert.equal(unknown[0].status, 'chat.newChecking');
assert.equal(unknown[0].disabled, true);
const settingsDisabled = buildNewChatModelOptions([{ id: 'codex', label: 'Codex', ready: true,
  models: [{ value: 'hidden-model', label: 'Hidden model', settingsDisabled: true }] }], [], translate);
assert.equal(settingsDisabled.length, 1, 'all models must include entries disabled in settings');
assert.equal(settingsDisabled[0].disabled, true);
assert.equal(settingsDisabled[0].description, 'chat.newModelDisabledSettings');
const pair = encodeNewChatModelChoice('codex', 'model-a::reasoning=high');
assert.deepEqual(decodeNewChatModelChoice(pair), { harness: 'codex', model: 'model-a::reasoning=high' });
for (const invalid of ['bad', '{}', '[1,2]', '["codex"]']) assert.equal(decodeNewChatModelChoice(invalid), null);
assert.equal(harnesses[0].id, 'zai', 'building the picker must not sort the source catalog');
console.log('new-chat-model-options.test.js OK');
