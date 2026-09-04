/**
 * ChatGPT / Codex plan session stored under isolated CODEX_HOME (auth.json).
 * Never returns token values to callers that feed HTTP responses.
 */

import fs from 'fs';
import path from 'path';
import { resolveCodexHomeDir } from './codex-home.js';

const CHATGPT_AUTH_MODES = new Set(['chatgpt', 'chat-gpt', 'chatgpt_oauth', 'oauth']);

/**
 * @param {string} [homeDir]
 * @returns {string}
 */
export function resolveCodexAuthJsonPath(homeDir = resolveCodexHomeDir()) {
  return path.join(homeDir, 'auth.json');
}

/**
 * @param {unknown} raw
 * @returns {boolean}
 */
export function isCodexChatGptAuthPayload(raw) {
  if (!raw || typeof raw !== 'object') return false;
  /** @type {Record<string, unknown>} */
  const data = raw;
  const mode = typeof data.auth_mode === 'string' ? data.auth_mode.trim().toLowerCase() : '';
  if (mode && CHATGPT_AUTH_MODES.has(mode)) return true;
  const tokens = data.tokens && typeof data.tokens === 'object' ? data.tokens : null;
  if (!tokens) return false;
  const access = typeof tokens.access_token === 'string' && tokens.access_token.trim();
  const refresh = typeof tokens.refresh_token === 'string' && tokens.refresh_token.trim();
  return !!(access || refresh);
}

/**
 * @param {string} [homeDir]
 * @returns {boolean}
 */
export function hasCodexChatGptAuth(homeDir = resolveCodexHomeDir()) {
  const file = resolveCodexAuthJsonPath(homeDir);
  if (!fs.existsSync(file)) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isCodexChatGptAuthPayload(parsed);
  } catch {
    return false;
  }
}

/**
 * Client-safe ChatGPT login flags (no tokens).
 *
 * @param {string} [homeDir]
 * @returns {{
 *   codexChatGptAuthEffective: boolean,
 * }}
 */
export function getCodexChatGptAuthMetaForClient(homeDir = resolveCodexHomeDir()) {
  return {
    codexChatGptAuthEffective: hasCodexChatGptAuth(homeDir),
  };
}
