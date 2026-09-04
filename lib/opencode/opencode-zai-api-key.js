/**
 * Z.AI API key for the OpenCode harness: env first, then data/config.json.
 * Separate from the OpenCode Zen key — do not mix the two.
 */

import { loadSettings } from '../persist/settings.js';

/** @type {readonly ['zai-coding-plan', 'zai']} */
export const OPENCODE_ZAI_PROVIDERS = Object.freeze(['zai-coding-plan', 'zai']);

/** @type {'zai-coding-plan'} */
export const OPENCODE_ZAI_PROVIDER_DEFAULT = 'zai-coding-plan';

const MIN_ZAI_API_KEY_LENGTH = 16;

/**
 * @param {unknown} value
 * @returns {'zai-coding-plan' | 'zai'}
 */
export function normalizeOpenCodeZaiProvider(value) {
  const raw = String(value || '').trim();
  if (raw === 'zai') return 'zai';
  return OPENCODE_ZAI_PROVIDER_DEFAULT;
}

/**
 * Z.AI keys are not OpenCode Zen / OpenRouter `sk-` tokens.
 *
 * @param {unknown} key
 * @returns {boolean}
 */
export function isValidOpenCodeZaiApiKeyFormat(key) {
  const raw = String(key || '').trim();
  if (!raw) return false;
  if (raw.startsWith('sk-')) return false;
  return raw.length >= MIN_ZAI_API_KEY_LENGTH;
}

/**
 * @returns {string}
 */
export function getOpenCodeZaiApiKeyFromEnv() {
  const coding = String(process.env.ZAI_CODING_API_KEY || '').trim();
  if (coding) return coding;
  return String(process.env.ZAI_API_KEY || '').trim();
}

/**
 * @returns {string}
 */
export function getOpenCodeZaiApiKeyFromSettings() {
  const settings = loadSettings();
  const key = settings.opencodeZaiApiKey;
  return typeof key === 'string' && key.trim() ? key.trim() : '';
}

/**
 * @returns {'zai-coding-plan' | 'zai'}
 */
export function getOpenCodeZaiProvider() {
  const fromEnv = String(process.env.ZAI_OPENCODE_PROVIDER || '').trim();
  if (fromEnv) return normalizeOpenCodeZaiProvider(fromEnv);
  const settings = loadSettings();
  return normalizeOpenCodeZaiProvider(settings.opencodeZaiProvider);
}

/**
 * @returns {string}
 */
export function getEffectiveOpenCodeZaiApiKey() {
  const fromEnv = getOpenCodeZaiApiKeyFromEnv();
  if (fromEnv) {
    return isValidOpenCodeZaiApiKeyFormat(fromEnv) ? fromEnv : '';
  }
  const fromSettings = getOpenCodeZaiApiKeyFromSettings();
  return isValidOpenCodeZaiApiKeyFormat(fromSettings) ? fromSettings : '';
}

/**
 * Client-safe metadata (never exposes the key).
 * @returns {{
 *   opencodeZaiApiKeyEffective: boolean,
 *   opencodeZaiApiKeyInvalidFormat: boolean,
 *   opencodeZaiApiKeyFromEnv: boolean,
 *   opencodeZaiApiKeyStoredInSettings: boolean,
 *   opencodeZaiProvider: 'zai-coding-plan' | 'zai',
 * }}
 */
export function getOpenCodeZaiApiKeyMetaForClient() {
  const envRaw = getOpenCodeZaiApiKeyFromEnv();
  const settingsRaw = getOpenCodeZaiApiKeyFromSettings();
  const hasStoredKey = !!(envRaw || settingsRaw);
  const effective = !!getEffectiveOpenCodeZaiApiKey();
  return {
    opencodeZaiApiKeyEffective: effective,
    opencodeZaiApiKeyInvalidFormat: hasStoredKey && !effective,
    opencodeZaiApiKeyFromEnv: !!envRaw,
    opencodeZaiApiKeyStoredInSettings: !!settingsRaw,
    opencodeZaiProvider: getOpenCodeZaiProvider(),
  };
}
