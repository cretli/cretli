/**
 * Codex API key: env first, then data/config.json (codexApiKey).
 */

import { loadSettings } from '../persist/settings.js';
import { getCodexAuthMode } from './codex-auth-mode.js';
import { applyCodexTermuxNetworkEnv } from './codex-termux-net.js';

/**
 * @returns {string}
 */
export function getCodexApiKeyFromEnv() {
  return (process.env.CODEX_API_KEY || '').trim();
}

/**
 * @returns {string}
 */
export function getCodexApiKeyFromSettings() {
  const settings = loadSettings();
  const key = settings.codexApiKey;
  return typeof key === 'string' && key.trim() ? key.trim() : '';
}

/**
 * @returns {string}
 */
export function getEffectiveCodexApiKey() {
  const fromEnv = getCodexApiKeyFromEnv();
  if (fromEnv) return fromEnv;
  return getCodexApiKeyFromSettings();
}

/**
 * Client-safe metadata (never exposes the key).
 * @returns {{
 *   codexApiKeyEffective: boolean,
 *   codexApiKeyFromEnv: boolean,
 *   codexApiKeyStoredInSettings: boolean,
 * }}
 */
export function getCodexApiKeyMetaForClient() {
  const fromEnv = !!getCodexApiKeyFromEnv();
  const fromSettings = !!getCodexApiKeyFromSettings();
  return {
    codexApiKeyEffective: !!getEffectiveCodexApiKey(),
    codexApiKeyFromEnv: fromEnv,
    codexApiKeyStoredInSettings: fromSettings,
  };
}

/**
 * Env overlay for the Codex CLI child process.
 * ChatGPT plan mode must not inherit CODEX_API_KEY / OPENAI_API_KEY or Codex bills Platform.
 *
 * @param {{ forceChatGpt?: boolean }} [options]
 * @returns {Record<string, string>}
 */
export function buildCodexProcessEnv(options = {}) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }
  const useChatGpt = options.forceChatGpt === true || getCodexAuthMode() === 'chatgpt';
  if (useChatGpt) {
    delete env.CODEX_API_KEY;
    delete env.OPENAI_API_KEY;
    return applyCodexTermuxNetworkEnv(env);
  }
  const apiKey = getEffectiveCodexApiKey();
  if (apiKey) env.CODEX_API_KEY = apiKey;
  return applyCodexTermuxNetworkEnv(env);
}
