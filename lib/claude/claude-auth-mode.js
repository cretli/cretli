/**
 * Claude Agent SDK authentication mode.
 * Subscription auth is an explicit local opt-in so server installs do not
 * start using a machine's Claude Code login by accident.
 */

import { loadSettings } from '../persist/settings.js';

/** @typedef {'subscription' | 'api-key'} ClaudeAuthMode */

export const CLAUDE_AUTH_MODE_ENV = 'CRETLI_CLAUDE_AUTH_MODE';

/**
 * @param {unknown} value
 * @returns {ClaudeAuthMode}
 */
export function normalizeClaudeAuthMode(value) {
  return String(value || '').trim().toLowerCase() === 'subscription' ? 'subscription' : 'api-key';
}

/**
 * @returns {ClaudeAuthMode}
 */
export function getClaudeAuthMode() {
  const envMode = String(process.env[CLAUDE_AUTH_MODE_ENV] || '').trim();
  if (envMode) return normalizeClaudeAuthMode(envMode);
  return normalizeClaudeAuthMode(loadSettings().claudeAuthMode);
}
