/**
 * Anthropic API key for the Claude Agent SDK harness.
 * `ANTHROPIC_API_KEY` wins over the key stored in Settings.
 * Console: https://console.anthropic.com — API keys page.
 */

import type { execFileSync } from 'node:child_process';
import { loadSettings } from '../persist/settings.js';
import { ensureWritableDir } from '../ensure-writable-dir.js';
import { resolveDataPath } from '../runtime-paths.js';
import { getClaudeAuthMode } from './claude-auth-mode.ts';
import { applyClaudeCacheEnv } from './claude-cache-settings.ts';
import {
  getClaudeOauthTokenFromEnv,
  hasClaudeSubscriptionAuth,
  resolveClaudeSubscriptionConfigDir,
} from './claude-subscription.ts';
import { buildAgentChildEnv } from '../agent-env.js';

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

export interface ClaudeEnvDeps {
  platform?: string;
  exec?: typeof execFileSync;
  env?: Record<string, string | undefined>;
}

function isEnabledFlag(value: unknown): boolean {
  if (value === true || value === 1) return true;
  const raw = String(value ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

export function isClaudeThirdPartyProviderConfigured(env: Record<string, string | undefined> = process.env): boolean {
  const source = env && typeof env === 'object' ? env : {};
  return CLAUDE_THIRD_PARTY_PROVIDER_ENV_VARS.some((key) => isEnabledFlag(source[key]));
}

export function getClaudeApiKeyFromEnv(): string {
  return (process.env.ANTHROPIC_API_KEY || '').trim();
}

export function getClaudeApiKeyFromSettings(): string {
  const settings = loadSettings();
  const key = settings.claudeApiKey;
  return typeof key === 'string' && key.trim() ? key.trim() : '';
}

export function getEffectiveClaudeApiKey(): string {
  const fromEnv = getClaudeApiKeyFromEnv();
  if (fromEnv) return fromEnv;
  return getClaudeApiKeyFromSettings();
}

/**
 * Client-safe metadata (never exposes the key).
 */
export function getClaudeApiKeyMetaForClient(): {
  claudeApiKeyEffective: boolean;
  claudeApiKeyFromEnv: boolean;
  claudeApiKeyStoredInSettings: boolean;
} {
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
 */
export function resolveClaudeHomeDir(): string {
  // Keep SDK settings/transcripts separate from any Claude Code CLI login
  // already present in the legacy claude-home directory.
  return resolveDataPath('claude-api-home');
}

export function ensureClaudeHomeDir(): string {
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
 */
export function buildClaudeProcessEnv(deps: ClaudeEnvDeps = {}): Record<string, string | undefined> {
  void deps;
  const env: Record<string, string | undefined> = buildAgentChildEnv('claude');
  // Opt-in, default-off native caching/compaction overrides. Applied before the
  // auth branches so both API-key and subscription paths see them.
  applyClaudeCacheEnv(env);
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
 */
export function isClaudeHarnessConfigured(deps: ClaudeEnvDeps = {}): boolean {
  const env = deps.env && typeof deps.env === 'object' ? deps.env : process.env;
  if (getClaudeAuthMode() === 'subscription') return hasClaudeSubscriptionAuth();
  if (isClaudeThirdPartyProviderConfigured(env)) return true;
  return !!getEffectiveClaudeApiKey();
}
