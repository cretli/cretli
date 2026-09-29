/**
 * Detect a Claude Code subscription login (claude.ai OAuth).
 * The client only learns whether a login exists, never the token.
 *
 * Credentials may live in a `.credentials.json` file inside a Claude Code
 * config dir, or (on macOS) in the login Keychain. `CLAUDE_CODE_OAUTH_TOKEN`
 * from `claude setup-token` is the recommended headless path: the CLI reads it
 * from the environment, so no credentials file is needed.
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { homeBrowseDir } from '../fs-browse.js';
import { resolveDataPath } from '../runtime-paths.js';

/** Keychain generic-password service used by Claude Code on macOS. */
export const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';

/** How long a Keychain probe result is cached. */
export const CLAUDE_KEYCHAIN_CACHE_MS = 60 * 1000;

/** @type {{ value: boolean, expiresAt: number }} */
let claudeKeychainCache = { value: false, expiresAt: 0 };

/**
 * `CLAUDE_CODE_OAUTH_TOKEN` is set by `claude setup-token`. The value is a
 * secret and must never be returned to a client.
 * @returns {string}
 */
export function getClaudeOauthTokenFromEnv() {
  return (process.env.CLAUDE_CODE_OAUTH_TOKEN || '').trim();
}

/**
 * @param {string} dir
 * @returns {boolean}
 */
export function hasClaudeAiOauth(dir) {
  const file = path.join(String(dir || ''), '.credentials.json');
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
  const oauth = payload && typeof payload === 'object' ? payload.claudeAiOauth : null;
  if (!oauth || typeof oauth !== 'object') return false;
  const token = oauth.accessToken;
  return typeof token === 'string' && token.trim().length > 0;
}

/**
 * Isolated Cretli home first, then the login user's Claude Code directory.
 * @returns {string[]}
 */
export function listClaudeSubscriptionConfigCandidates() {
  const override = String(process.env.CRETLI_CLAUDE_CONFIG_DIR || '').trim();
  if (override) return [path.resolve(override)];
  const dirs = [
    resolveDataPath('claude-home'),
    path.join(homeBrowseDir(), '.claude'),
    path.join(os.homedir(), '.claude'),
  ];
  const seen = new Set();
  return dirs.filter((dir) => {
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) return false;
    seen.add(resolved);
    return true;
  });
}

/**
 * Directory whose Claude Code credentials should be used for the plan.
 * Empty when this machine has no subscription credentials file.
 * @returns {string}
 */
export function resolveClaudeSubscriptionConfigDir() {
  const hit = listClaudeSubscriptionConfigCandidates().find((dir) => hasClaudeAiOauth(dir));
  return hit || '';
}

/**
 * macOS keeps Claude Code credentials in the login Keychain, not in
 * `.credentials.json`. Detect the item without reading the secret: the
 * `security` call intentionally omits `-w`/`-g`, so only the exit status
 * (item present or not) is observed. All failures are non-fatal.
 *
 * `deps.platform`/`deps.exec` are injection points for tests; injected probes
 * bypass the cache because their result is not the real machine state.
 *
 * @param {{ platform?: string, exec?: typeof execFileSync }} [deps]
 * @returns {boolean}
 */
export function hasClaudeKeychainCredentials(deps = {}) {
  const injected = typeof deps.platform === 'string' || typeof deps.exec === 'function';
  const platform = typeof deps.platform === 'string' ? deps.platform : process.platform;
  if (platform !== 'darwin') return false;
  const now = Date.now();
  if (!injected && claudeKeychainCache.expiresAt > now) return claudeKeychainCache.value;
  const exec = typeof deps.exec === 'function' ? deps.exec : execFileSync;
  let found = false;
  try {
    exec('security', ['find-generic-password', '-s', CLAUDE_KEYCHAIN_SERVICE], {
      stdio: 'ignore',
      timeout: 2000,
    });
    found = true;
  } catch {
    found = false;
  }
  if (!injected) claudeKeychainCache = { value: found, expiresAt: now + CLAUDE_KEYCHAIN_CACHE_MS };
  return found;
}

/**
 * @returns {void}
 */
export function clearClaudeKeychainCredentialsCache() {
  claudeKeychainCache = { value: false, expiresAt: 0 };
}

/**
 * True when the plan can authenticate: an env OAuth token, a credentials file,
 * or (on macOS) a Keychain entry.
 *
 * @param {{ platform?: string, exec?: typeof execFileSync }} [deps]
 * @returns {boolean}
 */
export function hasClaudeSubscriptionAuth(deps = {}) {
  if (getClaudeOauthTokenFromEnv()) return true;
  if (resolveClaudeSubscriptionConfigDir()) return true;
  return hasClaudeKeychainCredentials(deps);
}
