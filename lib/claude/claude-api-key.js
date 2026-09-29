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
  hasClaudeKeychainCredentials,
  hasClaudeSubscriptionAuth,
  resolveClaudeSubscriptionConfigDir,
} from './claude-subscription.js';

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
  return resolveDataPath('claude-home');
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
 * Subscription mode strips API-key variables so Claude Code bills the plan
 * login and preserves `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`).
 * API-key mode sets `ANTHROPIC_API_KEY` and clears the plan OAuth token so a
 * selected API key cannot silently fall back to plan billing.
 * The model is passed through `Options.model`, not an environment override.
 *
 * @param {{ platform?: string, exec?: typeof import('child_process').execFileSync }} [deps]
 * @returns {Record<string, string | undefined>}
 */
export function buildClaudeProcessEnv(deps = {}) {
  /** @type {Record<string, string | undefined>} */
  const env = { ...process.env };
  if (getClaudeAuthMode() === 'subscription') {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    const subscriptionDir = resolveClaudeSubscriptionConfigDir();
    if (subscriptionDir) {
      env.CLAUDE_CONFIG_DIR = subscriptionDir;
    } else if (hasClaudeKeychainCredentials(deps)) {
      // macOS Keychain lives in the default ~/.claude context; an isolated
      // CLAUDE_CONFIG_DIR would hide it from the CLI.
      delete env.CLAUDE_CONFIG_DIR;
    } else {
      env.CLAUDE_CONFIG_DIR = ensureClaudeHomeDir();
    }
    return env;
  }
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  const apiKey = getEffectiveClaudeApiKey();
  if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
  else delete env.ANTHROPIC_API_KEY;
  env.CLAUDE_CONFIG_DIR = ensureClaudeHomeDir();
  return env;
}

/**
 * True when the active billing path has credentials.
 * @param {{ platform?: string, exec?: typeof import('child_process').execFileSync }} [deps]
 * @returns {boolean}
 */
export function isClaudeHarnessConfigured(deps = {}) {
  if (getClaudeAuthMode() === 'subscription') {
    return hasClaudeSubscriptionAuth(deps);
  }
  return !!getEffectiveClaudeApiKey();
}
