import { readEnvAlias } from './env-alias.js';

/**
 * GitHub token for REST API: env GITHUB_TOKEN first, then data/config.json (githubToken),
 * then optional gh CLI fallback.
 */

import { spawnSync } from 'child_process';
import { loadSettings } from './persist/settings.js';

const GH_TOKEN_CACHE_TTL_MS = 30_000;

let ghTokenCache = {
  value: '',
  expiresAtMs: 0,
};

export function getGithubTokenFromEnv() {
  return (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
}

export function getGithubTokenFromSettings() {
  const settings = loadSettings();
  const token = settings.githubToken;
  return typeof token === 'string' && token.trim() ? token.trim() : '';
}

export function isGithubGhCliFallbackEnabled() {
  const raw = readEnvAlias({ current: 'CRETLI_GH_CLI_TOKEN_FALLBACK', legacy: 'CURSOR_REMOTE_GH_CLI_TOKEN_FALLBACK' }).trim().toLowerCase();
  if (!raw) return true;
  return !['0', 'false', 'no', 'off'].includes(raw);
}

/**
 * @param {{ runner?: typeof spawnSync, nowMs?: number, forceRefresh?: boolean }} [options]
 * @returns {string}
 */
export function getGithubTokenFromGhCli(options = {}) {
  if (!isGithubGhCliFallbackEnabled()) return '';
  const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
  if (!options.forceRefresh && nowMs < ghTokenCache.expiresAtMs) return ghTokenCache.value;
  const runner = typeof options.runner === 'function' ? options.runner : spawnSync;
  const result = runner('gh', ['auth', 'token'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 1500,
  });
  if (!result || result.status !== 0) {
    ghTokenCache = { value: '', expiresAtMs: nowMs + GH_TOKEN_CACHE_TTL_MS };
    return '';
  }
  const token = String(result.stdout || '').trim().split(/\r?\n/)[0].trim();
  ghTokenCache = { value: token, expiresAtMs: nowMs + GH_TOKEN_CACHE_TTL_MS };
  return token;
}

export function getEffectiveGithubToken(options = {}) {
  const fromEnv = getGithubTokenFromEnv();
  if (fromEnv) return fromEnv;
  const fromSettings = getGithubTokenFromSettings();
  if (fromSettings) return fromSettings;
  return getGithubTokenFromGhCli(options);
}

/**
 * Metadata for UI (never exposes the token value).
 */
export function getGithubTokenMetaForClient() {
  const fromEnv = !!getGithubTokenFromEnv();
  const fromSettings = !!getGithubTokenFromSettings();
  const fromGhCli = !!getGithubTokenFromGhCli();
  const effective = fromEnv || fromSettings || fromGhCli;
  return {
    githubTokenEffective: effective,
    githubTokenFromEnv: fromEnv,
    githubTokenStoredInSettings: fromSettings,
    githubTokenFromGhCli: fromGhCli,
  };
}
