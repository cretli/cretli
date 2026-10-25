import assert from 'node:assert/strict';
import test from 'node:test';
import { createConfigurationState } from '../app_front/state/configurationState.js';
import { bindHarnessDomBridge } from '../app_front/state/harnessDomBridge.js';
import { listHarnessUiMeta } from '../app_front/core/harness/harnessUiRegistry.js';
import { subscribe } from '../app_front/state/sharedState.js';
import { createChatPresetsStore } from '../app_front/features/chat/chatPresets.js';
import {
  voiceSessionStatus, getVoiceSessionStatus, isVoiceSessionActive,
  setVoiceSessionStatus, setVoiceSessionUsd, getVoiceSessionUsd,
} from '../app_front/features/voice/voiceSessionState.js';

const tick = () => new Promise((resolve) => queueMicrotask(resolve));

test('unmigrated harness plugins still publish models and receive credential changes', async () => {
  const target = new EventTarget();
  const state = createConfigurationState();
  const detach = bindHarnessDomBridge(target, state);
  const offs = [];
  try {
    for (const meta of listHarnessUiMeta().filter((meta) => !meta.core)) {
      const received = [];
      offs.push(state.onModelsChanged(meta.id, (value) => received.push(value)));
      const detail = { [meta.enabledModelsSettingsKey]: ['model-a'] };
      target.dispatchEvent(new CustomEvent(meta.modelsChangedEvent, { detail }));
      assert.deepEqual(state.harnessModels(meta.id).get(), detail);
      await tick();
      assert.deepEqual(received, [detail]);
      let pluginReloads = 0;
      const eventName = `cretli-${meta.id}-key-changed`;
      target.addEventListener(eventName, () => pluginReloads++);
      target.dispatchEvent(new Event(eventName));
      assert.equal(pluginReloads, 1);
      assert.equal(state.credentialRevision(meta.id).get(), 1);
      target.dispatchEvent(new CustomEvent(meta.modelsChangedEvent));
      await tick();
      assert.deepEqual(received[1], {}, 'payload-free plugin refresh invalidates the snapshot');
    }
    detach();
    target.dispatchEvent(new Event('cretli-qwen-key-changed'));
    assert.equal(state.credentialRevision('qwen').get(), 1);
    target.dispatchEvent(new CustomEvent('cretli-qwen-models-changed', { detail: { models: [] } }));
    assert.deepEqual(state.harnessModels('qwen').get(), {});
  } finally {
    detach();
    offs.forEach((off) => off());
  }
});

test('credential revisions isolate providers, coalesce writes and support disposal', async () => {
  const state = createConfigurationState();
  let calls = 0;
  const off = state.onCredentialsChanged('codex', () => calls++);
  await tick();
  assert.equal(calls, 0);
  state.invalidateCredentials('claude');
  await tick();
  assert.equal(calls, 0);
  state.invalidateCredentials('codex');
  state.invalidateCredentials('codex');
  assert.equal(state.credentialRevision('codex').get(), 2, 'cache readers see writes immediately');
  await tick();
  assert.equal(calls, 1);
  off();
  state.invalidateCredentials('codex');
  await tick();
  assert.equal(calls, 1);
});

test('catalog and enabled models survive partial updates; refresh drops stale snapshots', async () => {
  const state = createConfigurationState();
  const received = [];
  const off = state.onModelsChanged('codex', (value) => received.push(value));
  const catalog = [{ id: 'model-a' }];
  state.publishModels('codex', { catalog, models: ['model-a'] });
  state.publishModels('codex', { codexChatEnabledModels: ['model-a'] });
  state.publishModels('claude', { claudeChatEnabledModels: [] });
  await tick();
  assert.deepEqual(received, [{ catalog, models: ['model-a'], codexChatEnabledModels: ['model-a'] }]);
  state.publishModels('codex');
  await tick();
  assert.deepEqual(received[1], {});
  state.publishModels('codex');
  await tick();
  assert.equal(received.length, 3, 'even repeated refreshes invalidate cached catalogs');
  off();
  state.publishModels('codex', { models: [] });
  await tick();
  assert.equal(received.length, 3);
});

test('harness order/enabled state and default are synchronously readable', async () => {
  const state = createConfigurationState();
  const seen = [];
  const off = subscribe(state.enabledHarnesses, (value) => seen.push(value));
  const value = { enabledHarnesses: ['sdk', 'codex'], harnessOrder: ['codex', 'sdk'] };
  state.enabledHarnesses.set(value);
  state.defaultHarness.set('codex');
  assert.equal(state.enabledHarnesses.get(), value);
  assert.equal(state.defaultHarness.get(), 'codex');
  await tick();
  assert.deepEqual(seen, [value]);
  off();
});

test('favorites notify without window, preserve storage and detach listeners', async () => {
  const previousStorage = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
  };
  try {
    const store = createChatPresetsStore('test-favorites');
    const seen = [];
    const off = store.onChange((value) => seen.push(value));
    await tick();
    assert.deepEqual(seen, [], 'loading favorites is not a user change');
    const favorite = { harness: 'codex', model: 'model-a' };
    store.toggleFavorite(favorite);
    assert.deepEqual(store.getPresets(), [favorite]);
    await tick();
    assert.deepEqual(seen, [[favorite]]);
    assert.deepEqual(JSON.parse(values.get('test-favorites')), [favorite]);
    assert.equal(store.removeFavorite({ harness: 'sdk', model: 'missing' }), false);
    await tick();
    assert.equal(seen.length, 1, 'a no-op removal does not notify');
    off();
    store.removeFavorite(favorite);
    await tick();
    assert.equal(seen.length, 1);
    assert.deepEqual(store.getPresets(), []);
  } finally {
    globalThis.localStorage = previousStorage;
  }
});

test('voice status is shared without DOM and ignores unchanged values', async () => {
  setVoiceSessionStatus('idle');
  const seen = [];
  const off = subscribe(voiceSessionStatus, (value) => seen.push(value));
  try {
    for (const status of ['connecting', 'live', 'closing', 'error', 'idle']) {
      setVoiceSessionStatus(status);
      assert.equal(getVoiceSessionStatus(), status);
      assert.equal(isVoiceSessionActive(), status === 'connecting' || status === 'live');
      await tick();
    }
    assert.deepEqual(seen, ['connecting', 'live', 'closing', 'error', 'idle']);
    setVoiceSessionStatus('idle');
    await tick();
    assert.equal(seen.length, 5);
    setVoiceSessionUsd(0.25);
    assert.equal(getVoiceSessionUsd(), 0.25);
    setVoiceSessionUsd(NaN);
    assert.equal(getVoiceSessionUsd(), 0);
  } finally {
    off();
    setVoiceSessionStatus('idle');
  }
});
