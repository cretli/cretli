/**
 * OpenAI API key resolution for the voice layer: env first, then
 * data/config.json (openaiApiKey). The key never leaves the server.
 */

import { loadSettings } from '../persist/settings.js';

export const OPENAI_API_KEY_PREFIX: string = 'sk-';

/**
 * OpenAI keys start with `sk-` (plain, `sk-proj-`, service accounts). Anything
 * else is a key pasted into the wrong field and would fail with an opaque 401.
 */
export function isValidOpenAiApiKeyFormat(key: unknown): boolean {
  const raw = String(key || '').trim();
  if (!raw.startsWith(OPENAI_API_KEY_PREFIX)) return false;
  if (raw.startsWith('sk-or-v1-')) return false;
  return raw.length >= OPENAI_API_KEY_PREFIX.length + 16;
}

export function getOpenAiApiKeyFromEnv() {
  return (process.env.OPENAI_API_KEY || '').trim();
}

export function getOpenAiApiKeyFromSettings() {
  const settings = loadSettings() as Record<string, unknown>;
  const key = settings.openaiApiKey;
  return typeof key === 'string' && key.trim() ? key.trim() : '';
}

/**
 * Valid OpenAI key or empty string.
 */
export function getEffectiveOpenAiApiKey(): string {
  const fromEnv = getOpenAiApiKeyFromEnv();
  if (fromEnv) {
    return isValidOpenAiApiKeyFormat(fromEnv) ? fromEnv : '';
  }
  const fromSettings = getOpenAiApiKeyFromSettings();
  return isValidOpenAiApiKeyFormat(fromSettings) ? fromSettings : '';
}

/**
 * Client-safe metadata (never exposes the key).
 */
export function getOpenAiApiKeyMetaForClient() {
  const envRaw = getOpenAiApiKeyFromEnv();
  const settingsRaw = getOpenAiApiKeyFromSettings();
  const hasStoredKey = !!(envRaw || settingsRaw);
  const effective = !!getEffectiveOpenAiApiKey();
  return {
    openaiApiKeyEffective: effective,
    openaiApiKeyInvalidFormat: hasStoredKey && !effective,
    openaiApiKeyFromEnv: !!envRaw,
    openaiApiKeyStoredInSettings: !!settingsRaw,
  };
}
