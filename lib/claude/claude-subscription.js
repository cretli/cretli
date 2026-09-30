/**
 * Detect a local Claude Code login for the optional Claude Agent SDK path.
 * This module never performs OAuth or returns credential contents to callers.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveDataPath } from '../runtime-paths.js';

const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';
const KEYCHAIN_CACHE_MS = 60_000;
let keychainCache = { value: false, expiresAt: 0 };

/** @returns {string} */
export function getClaudeOauthTokenFromEnv() {
  return typeof process.env.CLAUDE_CODE_OAUTH_TOKEN === 'string'
    ? process.env.CLAUDE_CODE_OAUTH_TOKEN.trim()
    : '';
}

/** @param {string} dir @returns {boolean} */
export function hasClaudeAiOauth(dir) {
  try {
    const payload = JSON.parse(fs.readFileSync(path.join(dir, '.credentials.json'), 'utf8'));
    const oauth = payload?.claudeAiOauth;
    return typeof oauth?.accessToken === 'string' && oauth.accessToken.trim().length > 0;
  } catch {
    return false;
  }
}

/** @returns {string[]} */
export function listClaudeSubscriptionConfigCandidates() {
  const override = String(process.env.CRETLI_CLAUDE_CONFIG_DIR || '').trim();
  const configured = String(process.env.CLAUDE_CONFIG_DIR || '').trim();
  return [...new Set([
    override ? path.resolve(override) : '',
    resolveDataPath('claude-home'),
    configured ? path.resolve(configured) : '',
    path.join(os.homedir(), '.claude'),
  ].filter(Boolean))];
}

/** @returns {string} */
export function resolveClaudeSubscriptionConfigDir() {
  return listClaudeSubscriptionConfigCandidates().find(hasClaudeAiOauth) || '';
}

/**
 * Detect the macOS Claude Code Keychain item without reading its secret.
 * @param {{ platform?: string, exec?: typeof execFileSync }} [deps]
 * @returns {boolean}
 */
export function hasClaudeKeychainCredentials(deps = {}) {
  const injected = typeof deps.platform === 'string' || typeof deps.exec === 'function';
  if ((deps.platform || process.platform) !== 'darwin') return false;
  const now = Date.now();
  if (!injected && keychainCache.expiresAt > now) return keychainCache.value;
  let found = false;
  try {
    (deps.exec || execFileSync)('security', ['find-generic-password', '-s', CLAUDE_KEYCHAIN_SERVICE], {
      stdio: 'ignore',
      timeout: 2000,
    });
    found = true;
  } catch {
    found = false;
  }
  if (!injected) keychainCache = { value: found, expiresAt: now + KEYCHAIN_CACHE_MS };
  return found;
}

/** @returns {boolean} */
export function hasClaudeSubscriptionAuth(deps = {}) {
  return Boolean(
    getClaudeOauthTokenFromEnv()
    || resolveClaudeSubscriptionConfigDir()
    || hasClaudeKeychainCredentials(deps),
  );
}
