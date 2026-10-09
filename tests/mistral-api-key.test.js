import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadSettings, saveSettings } from '../lib/persist/settings.js';
import {
  getEffectiveMistralApiKey,
  getMistralApiKeyFromEnv,
  getMistralApiKeyMetaForClient,
  getMistralServerUrl,
} from '../lib/mistral/mistral-api-key.js';

const ENV_KEY = 'env-mistral-key-0123456789';
const SETTINGS_KEY = 'settings-mistral-key-0123456789';

/**
 * Runs `fn` with a clean env + settings state and restores both afterwards.
 *
 * @param {{ env?: string, settings?: string }} state
 * @param {() => void} fn
 */
function withKeys(state, fn) {
  const prevEnv = process.env.MISTRAL_API_KEY;
  const prevSettings = loadSettings();
  if (state.env) process.env.MISTRAL_API_KEY = state.env;
  else delete process.env.MISTRAL_API_KEY;
  const next = { ...prevSettings };
  if (state.settings) next.mistralApiKey = state.settings;
  else delete next.mistralApiKey;
  saveSettings(next);
  try {
    fn();
  } finally {
    if (typeof prevEnv === 'string') process.env.MISTRAL_API_KEY = prevEnv;
    else delete process.env.MISTRAL_API_KEY;
    saveSettings(prevSettings);
  }
}

test('env key wins over the settings key', () => {
  withKeys({ env: ENV_KEY, settings: SETTINGS_KEY }, () => {
    assert.equal(getMistralApiKeyFromEnv(), ENV_KEY);
    assert.equal(getEffectiveMistralApiKey(), ENV_KEY);
    const meta = getMistralApiKeyMetaForClient();
    assert.equal(meta.mistralApiKeyFromEnv, true);
    assert.equal(meta.mistralApiKeyStoredInSettings, true);
    assert.equal(meta.mistralApiKeyEffective, true);
  });
});

test('settings key is used when env is empty', () => {
  withKeys({ settings: SETTINGS_KEY }, () => {
    assert.equal(getEffectiveMistralApiKey(), SETTINGS_KEY);
    const meta = getMistralApiKeyMetaForClient();
    assert.equal(meta.mistralApiKeyFromEnv, false);
    assert.equal(meta.mistralApiKeyStoredInSettings, true);
  });
});

test('client meta never leaks the key value', () => {
  withKeys({ env: ENV_KEY, settings: SETTINGS_KEY }, () => {
    const serialized = JSON.stringify(getMistralApiKeyMetaForClient());
    assert.equal(serialized.includes(ENV_KEY), false);
    assert.equal(serialized.includes(SETTINGS_KEY), false);
    for (const value of Object.values(getMistralApiKeyMetaForClient())) {
      assert.equal(typeof value, 'boolean');
    }
  });
});

test('a malformed key is flagged and not effective', () => {
  withKeys({ env: 'short' }, () => {
    assert.equal(getEffectiveMistralApiKey(), '');
    const meta = getMistralApiKeyMetaForClient();
    assert.equal(meta.mistralApiKeyEffective, false);
    assert.equal(meta.mistralApiKeyInvalidFormat, true);
  });
});

test('clearing the stored key leaves no effective key', () => {
  withKeys({ settings: SETTINGS_KEY }, () => {
    const settings = loadSettings();
    delete settings.mistralApiKey;
    saveSettings(settings);
    assert.equal(getEffectiveMistralApiKey(), '');
    const meta = getMistralApiKeyMetaForClient();
    assert.equal(meta.mistralApiKeyStoredInSettings, false);
    assert.equal(meta.mistralApiKeyInvalidFormat, false);
  });
});

test('server URL prefers env over settings', () => {
  const prev = process.env.MISTRAL_BASE_URL;
  process.env.MISTRAL_BASE_URL = 'https://proxy.example.com';
  try {
    assert.equal(getMistralServerUrl(), 'https://proxy.example.com');
  } finally {
    if (typeof prev === 'string') process.env.MISTRAL_BASE_URL = prev;
    else delete process.env.MISTRAL_BASE_URL;
  }
});
