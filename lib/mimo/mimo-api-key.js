/**
 * MiMo API key and base URL resolution for the Xiaomi MiMo harness.
 * The API is OpenAI-compatible; these settings are independent from the
 * OpenCode custom provider (which shares only the MIMO_* env names).
 */
import { loadSettings } from '../persist/settings.js';
import { normalizeOpenCodeMimoBaseUrl } from '../opencode/opencode-mimo-api-key.js';

export const MIMO_DEFAULT_BASE_URL = 'https://api.xiaomimimo.com/v1';

/** @param {unknown} value @returns {string} */
export function normalizeMimoBaseUrl(value) {
  return normalizeOpenCodeMimoBaseUrl(value);
}

/** @returns {string} */
export function getConfiguredMimoBaseUrl() {
  const fromEnv = normalizeMimoBaseUrl(process.env.MIMO_BASE_URL);
  if (fromEnv) return fromEnv;
  const fromSettings = normalizeMimoBaseUrl(loadSettings().mimoBaseUrl);
  return fromSettings;
}

/** @returns {string} */
export function getEffectiveMimoBaseUrl() {
  return getConfiguredMimoBaseUrl() || MIMO_DEFAULT_BASE_URL;
}

/** @returns {string} */
export function getEffectiveMimoApiKey() {
  const fromEnv = String(process.env.MIMO_API_KEY || '').trim();
  if (fromEnv) return fromEnv;
  const fromSettings = loadSettings().mimoApiKey;
  return typeof fromSettings === 'string' ? fromSettings.trim() : '';
}

/** @returns {Record<string, unknown>} */
export function getMimoApiKeyMetaForClient() {
  const fromEnv = String(process.env.MIMO_API_KEY || '').trim();
  const fromSettings = loadSettings().mimoApiKey;
  const stored = typeof fromSettings === 'string' && !!fromSettings.trim();
  return {
    mimoApiKeyEffective: !!(fromEnv || stored),
    mimoApiKeyFromEnv: !!fromEnv,
    mimoApiKeyStoredInSettings: stored,
    mimoBaseUrl: getConfiguredMimoBaseUrl(),
    mimoBaseUrlEffective: getEffectiveMimoBaseUrl(),
    mimoBaseUrlFromEnv: !!normalizeMimoBaseUrl(process.env.MIMO_BASE_URL),
    mimoBaseUrlStoredInSettings: !!normalizeMimoBaseUrl(loadSettings().mimoBaseUrl),
  };
}
