/**
 * Claude billing path: Claude Code subscription vs Anthropic API key.
 */

import { loadSettings } from '../persist/settings.js';

/** @typedef {'subscription' | 'api-key'} ClaudeAuthMode */

/**
 * @param {unknown} value
 * @returns {ClaudeAuthMode}
 */
export function normalizeClaudeAuthMode(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (raw === 'api-key' || raw === 'api' || raw === 'anthropic') return 'api-key';
  return 'subscription';
}

/**
 * @returns {ClaudeAuthMode}
 */
export function getClaudeAuthMode() {
  const configured = loadSettings().claudeAuthMode;
  const raw = typeof configured === 'string' ? configured.trim() : '';
  // No explicit setting: an env API key means API-key billing, not the plan.
  // Read process.env directly — claude-api-key.js imports this module.
  if (!raw) {
    const envKey = typeof process.env.ANTHROPIC_API_KEY === 'string'
      ? process.env.ANTHROPIC_API_KEY.trim()
      : '';
    if (envKey) return 'api-key';
  }
  return normalizeClaudeAuthMode(configured);
}
