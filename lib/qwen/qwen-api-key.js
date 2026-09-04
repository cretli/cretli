/**
 * Qwen Cloud API key and OpenAI-compatible endpoint preset.
 * Console: https://home.qwencloud.com — no separate DashScope account.
 */

import { loadSettings } from '../persist/settings.js';
import { ensureQwenHomeDir } from './qwen-cli.js';

/** @typedef {'payg' | 'token-plan' | 'coding-plan' | 'custom'} QwenEndpointPreset */

export const QWEN_ENDPOINT_URLS = Object.freeze({
  payg: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  'token-plan': 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
  'coding-plan': 'https://coding-intl.dashscope.aliyuncs.com/v1',
});

/**
 * @param {unknown} value
 * @returns {QwenEndpointPreset}
 */
export function normalizeQwenEndpoint(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (raw === 'token-plan' || raw === 'coding-plan' || raw === 'custom') return raw;
  return 'payg';
}

/**
 * @returns {string}
 */
export function getQwenApiKeyFromEnv() {
  const qwen = (process.env.QWEN_API_KEY || '').trim();
  if (qwen) return qwen;
  return (process.env.DASHSCOPE_API_KEY || '').trim();
}

/**
 * @returns {string}
 */
export function getQwenApiKeyFromSettings() {
  const settings = loadSettings();
  const key = settings.qwenApiKey;
  return typeof key === 'string' && key.trim() ? key.trim() : '';
}

/**
 * @returns {string}
 */
export function getEffectiveQwenApiKey() {
  const fromEnv = getQwenApiKeyFromEnv();
  if (fromEnv) return fromEnv;
  return getQwenApiKeyFromSettings();
}

/**
 * Client-safe metadata (never exposes the key).
 * @returns {{
 *   qwenApiKeyEffective: boolean,
 *   qwenApiKeyFromEnv: boolean,
 *   qwenApiKeyStoredInSettings: boolean,
 * }}
 */
export function getQwenApiKeyMetaForClient() {
  const fromEnv = !!getQwenApiKeyFromEnv();
  const fromSettings = !!getQwenApiKeyFromSettings();
  return {
    qwenApiKeyEffective: !!getEffectiveQwenApiKey(),
    qwenApiKeyFromEnv: fromEnv,
    qwenApiKeyStoredInSettings: fromSettings,
  };
}

/**
 * @returns {QwenEndpointPreset}
 */
export function resolveQwenEndpoint() {
  const fromEnv = (process.env.QWEN_ENDPOINT || '').trim();
  if (fromEnv) return normalizeQwenEndpoint(fromEnv);
  const settings = loadSettings();
  return normalizeQwenEndpoint(settings.qwenEndpoint);
}

/**
 * @returns {string}
 */
export function getQwenBaseUrlFromEnv() {
  return (process.env.QWEN_BASE_URL || '').trim().replace(/\/+$/, '');
}

/**
 * @returns {string}
 */
export function getQwenBaseUrlFromSettings() {
  const settings = loadSettings();
  const url = settings.qwenBaseUrl;
  return typeof url === 'string' && url.trim() ? url.trim().replace(/\/+$/, '') : '';
}

/**
 * @returns {string}
 */
export function resolveQwenBaseUrl() {
  const endpoint = resolveQwenEndpoint();
  if (endpoint === 'custom') {
    const fromEnv = getQwenBaseUrlFromEnv();
    if (fromEnv) return fromEnv;
    const fromSettings = getQwenBaseUrlFromSettings();
    if (fromSettings) return fromSettings;
  }
  return QWEN_ENDPOINT_URLS[endpoint] || QWEN_ENDPOINT_URLS.payg;
}

/**
 * Env overlay for the Qwen Code CLI / SDK process.
 * @param {{ model?: string }} [options]
 * @returns {Record<string, string>}
 */
export function buildQwenProcessEnv(options = {}) {
  /** @type {Record<string, string>} */
  const env = {};
  const apiKey = getEffectiveQwenApiKey();
  if (apiKey) {
    env.OPENAI_API_KEY = apiKey;
    env.QWEN_API_KEY = apiKey;
  }
  const baseUrl = resolveQwenBaseUrl();
  if (baseUrl) env.OPENAI_BASE_URL = baseUrl;
  const model = typeof options.model === 'string' ? options.model.trim() : '';
  if (model) {
    env.OPENAI_MODEL = model;
    env.QWEN_MODEL = model;
  }
  env.HOME = ensureQwenHomeDir();
  return env;
}
