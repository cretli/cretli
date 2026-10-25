import assert from 'node:assert/strict';
import test from 'node:test';
import { configurationState } from '../app_front/state/index.js';
import { bindHarnessDomBridge } from '../app_front/state/harnessDomBridge.js';
import { initHarnessSettingsScreens } from '../app_front/features/settings/harnessSettingsRenderer.js';
import { registerHarnessSettingsSchema } from '../app_front/features/settings/models/harnessSettingsSchemas.js';
import { settingsSchema as qwenSchema } from '../harnesses/qwen/qwen-settings-schema.js';
import { initProviderKeySettings } from '../app_front/features/settings/models/lanProviderKeySettings.js';
import { invalidateStartupGetCache } from '../app_front/core/api/index.js';
import { isOpenAiKeyConfigured } from '../app_front/features/voice/openAiKeyStatus.js';
import { isGeminiKeyConfigured } from '../app_front/features/voice/geminiKeyStatus.js';
import { isAzureSpeechConfigured } from '../app_front/features/voice/azureSpeechStatus.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('generic settings save/clear refresh both plugin listeners and configuration subscribers', async () => {
  const previousFetch = globalThis.fetch;
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const target = new EventTarget();
  target.location = { search: '', pathname: '/' };
  globalThis.window = target;
  const controls = new Map();
  for (const suffix of ['input', 'save-btn', 'clear-btn']) {
    controls.set(`qwen-api-key-${suffix}`, {
      value: 'example-value', handlers: {},
      addEventListener(type, handler) { this.handlers[type] = handler; },
    });
  }
  globalThis.document = { getElementById: (id) => controls.get(id) || null };
  let failWrite = false;
  globalThis.fetch = async () => Response.json({ ok: !failWrite });
  const detach = bindHarnessDomBridge(target, configurationState);
  let pluginReloads = 0;
  let notifications = 0;
  target.addEventListener('cretli-qwen-key-changed', () => pluginReloads++);
  const off = configurationState.onCredentialsChanged('qwen', () => notifications++);
  try {
    registerHarnessSettingsSchema(qwenSchema);
    initHarnessSettingsScreens();
    const revision = configurationState.credentialRevision('qwen').get();
    for (const action of ['save', 'clear']) {
      controls.get(`qwen-api-key-${action}-btn`).handlers.click();
      await tick();
    }
    assert.equal(pluginReloads, 2);
    assert.equal(notifications, 2);
    assert.equal(configurationState.credentialRevision('qwen').get(), revision + 2);
    failWrite = true;
    controls.get('qwen-api-key-input').value = 'another-example-value';
    controls.get('qwen-api-key-save-btn').handlers.click();
    await tick();
    assert.equal(pluginReloads, 2);
    assert.equal(notifications, 2);
  } finally {
    detach();
    off();
    globalThis.fetch = previousFetch;
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
    invalidateStartupGetCache();
  }
});

for (const { provider, prefix, fields, read, effective } of [
  { provider: 'openai', prefix: 'openai-api-key', fields: ['openai-api-key-input'], read: isOpenAiKeyConfigured, effective: 'openaiApiKeyEffective' },
  { provider: 'gemini', prefix: 'gemini-api-key', fields: ['gemini-api-key-input'], read: isGeminiKeyConfigured, effective: 'geminiApiKeyEffective' },
  { provider: 'azure', prefix: 'azure-speech', fields: ['azure-speech-key-input', 'azure-speech-region-input'], read: isAzureSpeechConfigured, effective: 'azureSpeechEffective' },
]) {
  test(`${provider}: save/clear notify, failed writes keep state, cache invalidates immediately`, async () => {
    const previousFetch = globalThis.fetch;
    const previousDocument = globalThis.document;
    let configured = false;
    let failWrite = false;
    let reads = 0;
    const controls = new Map();
    for (const id of [...fields, `${prefix}-save-btn`, `${prefix}-clear-btn`]) {
      controls.set(id, {
        value: 'example-value',
        handlers: {},
        addEventListener(type, handler) { this.handlers[type] = handler; },
      });
    }
    globalThis.document = { getElementById: (id) => controls.get(id) || null };
    globalThis.fetch = async (_url, init = {}) => {
      if (init.method === 'PATCH') {
        if (failWrite) return Response.json({ ok: false, error: 'rejected' });
        const payload = JSON.parse(init.body);
        configured = !Object.keys(payload).some((key) => key.startsWith('clear'));
      } else reads++;
      return Response.json({ ok: true, [effective]: configured });
    };
    invalidateStartupGetCache();
    configurationState.invalidateCredentials(provider);
    let notifications = 0;
    const off = configurationState.onCredentialsChanged(provider, () => notifications++);
    try {
      initProviderKeySettings();
      assert.equal(await read(), false);
      assert.equal(await read(), false);
      assert.equal(reads, 1, 'repeated availability checks share the promise');
      const revision = configurationState.credentialRevision(provider).get();
      controls.get(`${prefix}-save-btn`).handlers.click();
      await tick();
      assert.equal(configurationState.credentialRevision(provider).get(), revision + 1);
      assert.equal(notifications, 1);
      assert.equal(await read(), true);
      controls.get(`${prefix}-clear-btn`).handlers.click();
      await tick();
      assert.equal(await read(), false);
      assert.equal(notifications, 2);
      failWrite = true;
      controls.get(fields[0]).value = 'another-example-value';
      controls.get(`${prefix}-save-btn`).handlers.click();
      await tick();
      assert.equal(notifications, 2, 'failed saves do not publish a configuration change');
      // Check the critical same-stack path, before asynchronous subscribers flush.
      configured = true;
      invalidateStartupGetCache();
      configurationState.invalidateCredentials(provider);
      const nextRead = read();
      assert.equal(await nextRead, true);
    } finally {
      off();
      globalThis.fetch = previousFetch;
      globalThis.document = previousDocument;
      invalidateStartupGetCache();
    }
  });
}
