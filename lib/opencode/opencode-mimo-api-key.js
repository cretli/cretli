/** MiMo API key resolution for the OpenCode custom provider. */
import { loadSettings } from '../persist/settings.js';

export const OPENCODE_MIMO_DEFAULT_BASE_URL = 'https://api.xiaomimimo.com/v1';
export const OPENCODE_MIMO_PROVIDER_ID = 'cretli-mimo';
export const OPENCODE_MIMO_MODEL_IDS = Object.freeze([
  'mimo-v2.6-pro',
  'mimo-v2.6-flash',
]);

/** Return an HTTPS base URL suitable for an OpenAI-compatible MiMo endpoint. */
export function normalizeOpenCodeMimoBaseUrl(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return '';
    // Xiaomi's OpenAI-compatible Base URLs end at /v1. Reject accidentally
    // concatenated URLs (for example the PAYG default followed by a plan URL).
    const pathname = url.pathname.replace(/\/+$/, '');
    if (!pathname.endsWith('/v1') || pathname.includes('://')) return '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

export function getConfiguredOpenCodeMimoBaseUrl() {
  const fromEnv = normalizeOpenCodeMimoBaseUrl(process.env.MIMO_BASE_URL);
  if (fromEnv) return fromEnv;
  const fromSettings = normalizeOpenCodeMimoBaseUrl(loadSettings().opencodeMimoBaseUrl);
  return fromSettings;
}

export function getEffectiveOpenCodeMimoBaseUrl() {
  return getConfiguredOpenCodeMimoBaseUrl() || OPENCODE_MIMO_DEFAULT_BASE_URL;
}

export function getEffectiveOpenCodeMimoApiKey() {
  const fromEnv = String(process.env.MIMO_API_KEY || '').trim();
  if (fromEnv) return fromEnv;
  const fromSettings = loadSettings().opencodeMimoApiKey;
  return typeof fromSettings === 'string' ? fromSettings.trim() : '';
}

export function getOpenCodeMimoApiKeyMetaForClient() {
  const fromEnv = String(process.env.MIMO_API_KEY || '').trim();
  const fromSettings = loadSettings().opencodeMimoApiKey;
  const stored = typeof fromSettings === 'string' && !!fromSettings.trim();
  return {
    opencodeMimoApiKeyEffective: !!(fromEnv || stored),
    opencodeMimoApiKeyFromEnv: !!fromEnv,
    opencodeMimoApiKeyStoredInSettings: stored,
    opencodeMimoBaseUrl: getConfiguredOpenCodeMimoBaseUrl(),
    opencodeMimoBaseUrlEffective: getEffectiveOpenCodeMimoBaseUrl(),
    opencodeMimoBaseUrlFromEnv: !!normalizeOpenCodeMimoBaseUrl(process.env.MIMO_BASE_URL),
    opencodeMimoBaseUrlStoredInSettings: !!normalizeOpenCodeMimoBaseUrl(loadSettings().opencodeMimoBaseUrl),
  };
}
