/**
 * Codex billing path: ChatGPT plan (Go/Plus/Pro) vs Platform API key.
 */

import { loadSettings } from '../persist/settings.js';

/** @typedef {'chatgpt' | 'api-key'} CodexAuthMode */

/**
 * @param {unknown} value
 * @returns {CodexAuthMode}
 */
export function normalizeCodexAuthMode(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (raw === 'chatgpt' || raw === 'chat-gpt' || raw === 'plan') return 'chatgpt';
  return 'api-key';
}

/**
 * @returns {CodexAuthMode}
 */
export function getCodexAuthMode() {
  return normalizeCodexAuthMode(loadSettings().codexAuthMode);
}
