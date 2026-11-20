/**
 * Codex billing path: ChatGPT plan (Go/Plus/Pro) vs Platform API key.
 */

import { loadSettings } from '../persist/settings.js';

export type CodexAuthMode = 'chatgpt' | 'api-key';

export function normalizeCodexAuthMode(value: unknown): CodexAuthMode {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (raw === 'chatgpt' || raw === 'chat-gpt' || raw === 'plan') return 'chatgpt';
  return 'api-key';
}

export function getCodexAuthMode(): CodexAuthMode {
  return normalizeCodexAuthMode(loadSettings().codexAuthMode);
}
