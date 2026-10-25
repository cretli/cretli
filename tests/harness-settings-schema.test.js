import './helpers/default-optional-harnesses.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { listBuiltinHarnessBackends } from '../lib/agent-harness/builtin-harness-backends.ts';
import { CORE_SETTINGS_MODULES } from '../lib/agent-harness/core-settings-modules.ts';

const IDS = ['openrouter', 'mistral', 'zai', 'mimo', 'opencode', 'codebuddy', 'deepseek', 'qwen'];

// Valid example values for the secrets that are format-checked by applySettingsPatch.
const SECRET_SAMPLES = {
  openrouterApiKey: `sk-or-v1-${'a'.repeat(64)}`,
  zaiApiKey: 'z'.repeat(32),
  opencodeApiKey: 'sk-zen-0123456789abcdef0123456789abcdef',
  opencodeZaiApiKey: 'zai-key-0123456789abcdef0123456789abcdef',
};

// Valid example values for format-checked string fields.
const STRING_SAMPLES = {
  mimoBaseUrl: 'https://mimo.example.com/v1',
  opencodeMimoBaseUrl: 'https://mimo.example.com/v1',
};

const SAMPLES = {
  secret: (field) => SECRET_SAMPLES[field.name] || 'secret-value-0123456789',
  string: (field) => STRING_SAMPLES[field.name] || 'value',
  enum: (field) => field.values[0],
  int: () => 5,
  models: () => ['model-a'],
};

function backendFor(id) {
  // Core modules (the OpenRouter client key) are active without any plugin.
  const core = CORE_SETTINGS_MODULES.find((module) => module.settingsSchema?.harness === id);
  if (core) return core;
  const backend = listBuiltinHarnessBackends().find((row) => row.id === id);
  assert.ok(backend?.settings, `${id} owns a settings module`);
  return backend.settings;
}

for (const id of IDS) {
  test(`${id}: settingsSchema matches readClientSettings and applySettingsPatch`, () => {
    const settings = backendFor(id);
    const schema = settings.settingsSchema;
    assert.ok(schema, 'exports settingsSchema');
    assert.equal(schema.harness, id);

    // GET: the schema names exactly the fields the module returns.
    const declaredGet = [
      ...schema.fields.filter((field) => field.get !== false).map((field) => field.name),
      ...schema.readOnly,
    ].sort();
    assert.deepEqual(Object.keys(settings.readClientSettings({})).sort(), declaredGet);
    assert.equal(new Set(declaredGet).size, declaredGet.length, 'no duplicate GET field');

    // PATCH: every declared field and clear flag is accepted.
    for (const field of schema.fields) {
      const doc = {};
      const result = settings.applySettingsPatch({ [field.name]: SAMPLES[field.kind](field) }, doc);
      assert.equal(result.error, undefined, `${field.name} sample is valid`);
      assert.equal(result.changed, true, `${field.name} is patched`);
      if (field.clearFlag) {
        const stored = { [field.name]: 'stored-value' };
        const cleared = settings.applySettingsPatch({ [field.clearFlag]: true }, stored);
        assert.equal(cleared.changed, true, `${field.clearFlag} clears ${field.name}`);
        assert.equal(field.name in stored, false);
      }
    }
  });

  test(`${id}: UI schema only references declared fields`, () => {
    const schema = backendFor(id).settingsSchema;
    const patchable = new Set(schema.fields.map((field) => field.name));
    const clearFlags = new Set(schema.fields.map((field) => field.clearFlag).filter(Boolean));
    const readable = new Set([...schema.fields.filter((f) => f.get !== false).map((f) => f.name), ...schema.readOnly]);
    const groups = new Set(schema.ui.groups.map((group) => group.group));
    for (const secret of schema.ui.secrets) {
      assert.ok(patchable.has(secret.field), secret.field);
      assert.ok(clearFlags.has(secret.clearFlag), secret.clearFlag);
      assert.ok(groups.has(secret.group), secret.group);
    }
    for (const control of [...schema.ui.texts, ...schema.ui.selects]) {
      assert.ok(patchable.has(control.field), control.field);
      assert.ok(groups.has(control.group), control.group);
    }
    for (const select of schema.ui.selects) {
      assert.ok(select.options.some((option) => option.value === select.fallback));
    }
    const hints = [...schema.ui.groups, ...schema.ui.texts.map((text) => text.hint).filter(Boolean)];
    for (const hint of hints) {
      for (const rule of hint.rules) {
        for (const flag of rule.when) assert.ok(readable.has(flag), `${hint.id}: ${flag}`);
      }
    }
  });
}

test('the front schema list starts without mistral and registers plugin schemas lazily', async () => {
  const registry = await import('../app_front/features/settings/models/harnessSettingsSchemas.js');
  const { settingsSchema } = await import('../harnesses/mistral/mistral-settings-schema.js');
  assert.equal(registry.listHarnessSettingsSchemas().some((row) => row.harness === 'mistral'), false);
  const seen = [];
  const off = registry.onHarnessSettingsSchemaAdded((schema) => seen.push(schema.harness));
  assert.equal(registry.registerHarnessSettingsSchema(settingsSchema), true);
  assert.equal(registry.registerHarnessSettingsSchema(settingsSchema), false);
  off();
  assert.deepEqual(seen, ['mistral']);
  assert.equal(registry.listHarnessSettingsSchemas().some((row) => row.harness === 'mistral'), true);
});
