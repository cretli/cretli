/**
 * Detect a local Claude Code login for the optional Claude Agent SDK path.
 * This module never performs OAuth or returns credential contents to callers.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { resolveDataPath } from '../runtime-paths.js';

export interface ClaudeKeychainDeps {
  platform?: string;
  exec?: typeof execFileSync;
}

const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';
const KEYCHAIN_CACHE_MS = 60_000;
let keychainCache: { value: boolean; expiresAt: number } = { value: false, expiresAt: 0 };

export function getClaudeOauthTokenFromEnv(): string {
  return typeof process.env.CLAUDE_CODE_OAUTH_TOKEN === 'string'
    ? process.env.CLAUDE_CODE_OAUTH_TOKEN.trim()
    : '';
}

export function hasClaudeAiOauth(dir: string): boolean {
  try {
    const payload = JSON.parse(fs.readFileSync(path.join(dir, '.credentials.json'), 'utf8'));
    const oauth = payload?.claudeAiOauth;
    return typeof oauth?.accessToken === 'string' && oauth.accessToken.trim().length > 0;
  } catch {
    return false;
  }
}

export function listClaudeSubscriptionConfigCandidates(): string[] {
  const override = String(process.env.CRETLI_CLAUDE_CONFIG_DIR || '').trim();
  const configured = String(process.env.CLAUDE_CONFIG_DIR || '').trim();
  return [...new Set([
    override ? path.resolve(override) : '',
    resolveDataPath('claude-home'),
    configured ? path.resolve(configured) : '',
    path.join(os.homedir(), '.claude'),
  ].filter(Boolean))];
}

export function resolveClaudeSubscriptionConfigDir(): string {
  return listClaudeSubscriptionConfigCandidates().find(hasClaudeAiOauth) || '';
}

/**
 * Detect the macOS Claude Code Keychain item without reading its secret.
 */
export function hasClaudeKeychainCredentials(deps: ClaudeKeychainDeps = {}): boolean {
  const injected = typeof deps.platform === 'string' || typeof deps.exec === 'function';
  if ((deps.platform || process.platform) !== 'darwin') return false;
  if (injected) {
    // Injected deps (tests) keep the synchronous, uncached path.
    try {
      (deps.exec || execFileSync)('security', ['find-generic-password', '-s', CLAUDE_KEYCHAIN_SERVICE], {
        stdio: 'ignore',
        timeout: 2000,
      });
      return true;
    } catch {
      return false;
    }
  }
  // Never block the event loop on `security`: answer from the cache and refresh
  // it in the background. The first call after boot reports "not found" until
  // the probe finishes (primed at module load below).
  refreshKeychainCache();
  return keychainCache.value;
}

let keychainProbeInFlight = false;

function refreshKeychainCache(): void {
  if (keychainProbeInFlight || keychainCache.expiresAt > Date.now()) return;
  keychainProbeInFlight = true;
  try {
    execFile('security', ['find-generic-password', '-s', CLAUDE_KEYCHAIN_SERVICE], { timeout: 2000 }, (err) => {
      keychainProbeInFlight = false;
      keychainCache = { value: !err, expiresAt: Date.now() + KEYCHAIN_CACHE_MS };
    });
  } catch {
    keychainProbeInFlight = false;
    keychainCache = { value: false, expiresAt: Date.now() + KEYCHAIN_CACHE_MS };
  }
}

if (process.platform === 'darwin') refreshKeychainCache();

export function hasClaudeSubscriptionAuth(deps: ClaudeKeychainDeps = {}): boolean {
  return Boolean(
    getClaudeOauthTokenFromEnv()
    || resolveClaudeSubscriptionConfigDir()
    || hasClaudeKeychainCredentials(deps),
  );
}
