/**
 * Codex API key: env first, then data/config.json (codexApiKey).
 */

import { loadSettings } from '../persist/settings.js';
import { getCodexAuthMode } from './codex-auth-mode.ts';
import { applyCodexTermuxNetworkEnv } from './codex-termux-net.ts';
import { buildAgentChildEnv } from '../agent-env.js';

export function getCodexApiKeyFromEnv(): string {
  return (process.env.CODEX_API_KEY || '').trim();
}

export function getCodexApiKeyFromSettings(): string {
  const settings = loadSettings();
  const key = settings.codexApiKey;
  return typeof key === 'string' && key.trim() ? key.trim() : '';
}

export function getEffectiveCodexApiKey(): string {
  const fromEnv = getCodexApiKeyFromEnv();
  if (fromEnv) return fromEnv;
  return getCodexApiKeyFromSettings();
}

/**
 * Client-safe metadata (never exposes the key).
 */
export function getCodexApiKeyMetaForClient(): { codexApiKeyEffective: boolean, codexApiKeyFromEnv: boolean, codexApiKeyStoredInSettings: boolean } {
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
 */
export function buildCodexProcessEnv(options: { forceChatGpt?: boolean } = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(buildAgentChildEnv('codex'))) {
    if (typeof value === 'string') env[key] = value;
  }
  // A Cretli server can itself run inside a Codex turn. Do not let a nested
  // Codex CLI inherit the parent's session/thread identity and attach to it.
  delete env.CODEX_SESSION_ID;
  delete env.CODEX_THREAD_ID;
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
