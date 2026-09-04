/**
 * OpenCode Zen API key resolution: env first, then data/config.json (opencodeApiKey).
 */

import { loadSettings } from '../persist/settings.js';
import { isValidOpenRouterApiKeyFormat } from '../openrouter/openrouter-api-key.js';
import { getEffectiveOpenCodeZaiApiKey } from './opencode-zai-api-key.js';

/** @type {string} */
export const OPENCODE_ZEN_API_KEY_PREFIX = 'sk-zoyv';

/**
 * @param {unknown} key
 * @returns {boolean}
 */
export function isValidOpenCodeApiKeyFormat(key) {
  const raw = String(key || '').trim();
  if (!raw.startsWith('sk-')) return false;
  if (isValidOpenRouterApiKeyFormat(raw)) return false;
  return raw.length >= 16;
}

export function getOpenCodeApiKeyFromEnv() {
  return (process.env.OPENCODE_API_KEY || '').trim();
}

export function getOpenCodeApiKeyFromSettings() {
  const settings = loadSettings();
  const key = settings.opencodeApiKey;
  return typeof key === 'string' && key.trim() ? key.trim() : '';
}

/**
 * Legacy misfiled key: user pasted OpenCode Zen key into OpenRouter settings.
 * @returns {string}
 */
function getMisfiledOpenCodeKeyFromOpenRouterSettings() {
  const settings = loadSettings();
  const candidate = typeof settings.openrouterApiKey === 'string' ? settings.openrouterApiKey.trim() : '';
  if (!candidate) return '';
  if (isValidOpenRouterApiKeyFormat(candidate)) return '';
  if (!isValidOpenCodeApiKeyFormat(candidate)) return '';
  return candidate;
}

/**
 * @returns {string}
 */
export function getEffectiveOpenCodeApiKey() {
  const fromEnv = getOpenCodeApiKeyFromEnv();
  if (fromEnv && isValidOpenCodeApiKeyFormat(fromEnv)) return fromEnv;
  const fromSettings = getOpenCodeApiKeyFromSettings();
  if (fromSettings && isValidOpenCodeApiKeyFormat(fromSettings)) return fromSettings;
  return getMisfiledOpenCodeKeyFromOpenRouterSettings();
}

/**
 * OpenCode harness is usable with a Zen key, a Z.AI key, or both.
 * @returns {boolean}
 */
export function hasOpenCodeCredentials() {
  return !!getEffectiveOpenCodeApiKey() || !!getEffectiveOpenCodeZaiApiKey();
}

/**
 * Client-safe metadata (never exposes the key).
 */
export function getOpenCodeApiKeyMetaForClient() {
  const envRaw = getOpenCodeApiKeyFromEnv();
  const settingsRaw = getOpenCodeApiKeyFromSettings();
  const misfiledRaw = getMisfiledOpenCodeKeyFromOpenRouterSettings();
  const hasStoredKey = !!(envRaw || settingsRaw || misfiledRaw);
  const effective = !!getEffectiveOpenCodeApiKey();
  return {
    opencodeApiKeyEffective: effective,
    opencodeApiKeyInvalidFormat: hasStoredKey && !effective,
    opencodeApiKeyFromEnv: !!envRaw,
    opencodeApiKeyStoredInSettings: !!settingsRaw,
    opencodeApiKeyMisfiledInOpenRouter: !!misfiledRaw && !settingsRaw && !envRaw,
    opencodeCredentialsEffective: hasOpenCodeCredentials(),
  };
}
