/**
 * Anthropic API key for the Claude Agent SDK harness.
 * `ANTHROPIC_API_KEY` wins over the key stored in Settings.
 * Console: https://console.anthropic.com — API keys page.
 */

import { loadSettings } from '../persist/settings.js';
import { ensureWritableDir } from '../ensure-writable-dir.js';
import { resolveDataPath } from '../runtime-paths.js';
import { getClaudeAuthMode } from './claude-auth-mode.js';
import {
  getClaudeOauthTokenFromEnv,
  hasClaudeSubscriptionAuth,
  resolveClaudeSubscriptionConfigDir,
} from './claude-subscription.js';

/**
 * Third-party Claude Code providers that authenticate with their own cloud
 * credentials instead of an Anthropic API key. When any is enabled the harness
 * is configured even with no `ANTHROPIC_API_KEY`.
 */
export const CLAUDE_THIRD_PARTY_PROVIDER_ENV_VARS = Object.freeze([
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
]);

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isEnabledFlag(value) {
  if (value === true || value === 1) return true;
  const raw = String(value ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function isClaudeThirdPartyProviderConfigured(env = process.env) {
  const source = env && typeof env === 'object' ? env : {};
  return CLAUDE_THIRD_PARTY_PROVIDER_ENV_VARS.some((key) => isEnabledFlag(source[key]));
}

/**
 * @returns {string}
 */
export function getClaudeApiKeyFromEnv() {
  return (process.env.ANTHROPIC_API_KEY || '').trim();
}

/**
 * @returns {string}
 */
export function getClaudeApiKeyFromSettings() {
  const settings = loadSettings();
  const key = settings.claudeApiKey;
  return typeof key === 'string' && key.trim() ? key.trim() : '';
}

/**
 * @returns {string}
 */
export function getEffectiveClaudeApiKey() {
  const fromEnv = getClaudeApiKeyFromEnv();
  if (fromEnv) return fromEnv;
  return getClaudeApiKeyFromSettings();
}

/**
 * Client-safe metadata (never exposes the key).
 * @returns {{
 *   claudeApiKeyEffective: boolean,
 *   claudeApiKeyFromEnv: boolean,
 *   claudeApiKeyStoredInSettings: boolean,
 * }}
 */
export function getClaudeApiKeyMetaForClient() {
  const fromEnv = !!getClaudeApiKeyFromEnv();
  const fromSettings = !!getClaudeApiKeyFromSettings();
  return {
    claudeApiKeyEffective: !!getEffectiveClaudeApiKey(),
    claudeApiKeyFromEnv: fromEnv,
    claudeApiKeyStoredInSettings: fromSettings,
  };
}

/**
 * Isolated HOME for Claude Code settings, credentials, and session transcripts.
 * @returns {string}
 */
export function resolveClaudeHomeDir() {
  // Keep SDK settings/transcripts separate from any Claude Code CLI login
  // already present in the legacy claude-home directory.
  return resolveDataPath('claude-api-home');
}

/**
 * @returns {string}
 */
export function ensureClaudeHomeDir() {
  return ensureWritableDir(resolveClaudeHomeDir());
}

/**
 * Environment for the Claude Code subprocess.
 *
 * `Options.env` REPLACES the subprocess environment, so inherit `process.env`.
 * API/provider mode uses user-owned provider credentials and an isolated
 * config dir. Subscription mode is separately opt-in and uses the existing
 * local Claude Code login without copying its credential file.
 * The model is passed through `Options.model`, not an environment override.
 *
 * @param {{ platform?: string, exec?: typeof import('child_process').execFileSync }} [deps]
 * @returns {Record<string, string | undefined>}
 */
export function buildClaudeProcessEnv(deps = {}) {
  void deps;
  /** @type {Record<string, string | undefined>} */
  const env = { ...process.env };
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_BASE_URL;
  if (getClaudeAuthMode() === 'subscription') {
    delete env.ANTHROPIC_API_KEY;
    for (const key of CLAUDE_THIRD_PARTY_PROVIDER_ENV_VARS) delete env[key];
    const subscriptionDir = resolveClaudeSubscriptionConfigDir();
    if (subscriptionDir) env.CLAUDE_CONFIG_DIR = subscriptionDir;
    const token = getClaudeOauthTokenFromEnv();
    if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
    return env;
  }
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  if (isClaudeThirdPartyProviderConfigured(env)) {
    delete env.ANTHROPIC_API_KEY;
  } else {
    const apiKey = getEffectiveClaudeApiKey();
    if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
    else delete env.ANTHROPIC_API_KEY;
  }
  env.CLAUDE_CONFIG_DIR = ensureClaudeHomeDir();
  return env;
}

/**
 * True when the active billing path has credentials.
 * Also accepts supported third-party provider switches (Bedrock/Vertex/
 * Foundry), whose credentials remain owned by the configured user/provider.
 *
 * @param {{ platform?: string, exec?: typeof import('child_process').execFileSync, env?: Record<string, string | undefined> }} [deps]
 * @returns {boolean}
 */
export function isClaudeHarnessConfigured(deps = {}) {
  const env = deps.env && typeof deps.env === 'object' ? deps.env : process.env;
  if (getClaudeAuthMode() === 'subscription') return hasClaudeSubscriptionAuth();
  if (isClaudeThirdPartyProviderConfigured(env)) return true;
  return !!getEffectiveClaudeApiKey();
}
