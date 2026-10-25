/**
 * Claude Agent SDK authentication mode.
 * Subscription auth is an explicit local opt-in so server installs do not
 * start using a machine's Claude Code login by accident.
 */

import { loadSettings } from '../persist/settings.js';

export type ClaudeAuthMode = 'subscription' | 'api-key';

export const CLAUDE_AUTH_MODE_ENV = 'CRETLI_CLAUDE_AUTH_MODE';

export function normalizeClaudeAuthMode(value: unknown): ClaudeAuthMode {
  return String(value || '').trim().toLowerCase() === 'subscription' ? 'subscription' : 'api-key';
}

export function getClaudeAuthMode(): ClaudeAuthMode {
  const envMode = String(process.env[CLAUDE_AUTH_MODE_ENV] || '').trim();
  if (envMode) return normalizeClaudeAuthMode(envMode);
  return normalizeClaudeAuthMode(loadSettings().claudeAuthMode);
}
