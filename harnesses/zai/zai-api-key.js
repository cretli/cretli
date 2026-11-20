import { loadSettings } from '../../lib/persist/settings.js';

const PROVIDERS = new Set(['zai-coding-plan', 'zai']);

function isValidZaiSdkApiKey(key) {
  return !!key && key.length >= 16 && !key.startsWith('sk-');
}

export function normalizeZaiSdkProvider(value) {
  const provider = String(value || '').trim().toLowerCase();
  return PROVIDERS.has(provider) ? provider : 'zai-coding-plan';
}

export function getZaiSdkProvider() {
  return normalizeZaiSdkProvider(process.env.ZAI_SDK_PROVIDER || loadSettings().zaiProvider);
}

export function getEffectiveZaiSdkApiKey() {
  const envKey = String(process.env.ZAI_SDK_API_KEY || '').trim();
  const settingsKey = String(loadSettings().zaiApiKey || '').trim();
  const key = envKey || settingsKey;
  return isValidZaiSdkApiKey(key) ? key : '';
}

export function getZaiSdkApiKeyMetaForClient() {
  const settingsKey = String(loadSettings().zaiApiKey || '').trim();
  const envKey = String(process.env.ZAI_SDK_API_KEY || '').trim();
  return {
    zaiApiKeyEffective: !!getEffectiveZaiSdkApiKey(),
    zaiApiKeyInvalidFormat: !!(settingsKey || envKey) && !getEffectiveZaiSdkApiKey(),
    zaiApiKeyFromEnv: !!envKey,
    zaiApiKeyStoredInSettings: !!settingsKey,
    zaiProvider: getZaiSdkProvider(),
  };
}
