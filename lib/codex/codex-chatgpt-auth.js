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

const OPENAI_AUTH_CLAIM = 'https://api.openai.com/auth';

/**
 * Decode a JWT payload without verifying the signature.
 *
 * @param {unknown} token
 * @returns {Record<string, unknown> | null}
 */
export function decodeJwtPayload(token) {
  if (typeof token !== 'string' || !token.trim()) return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4;
    if (pad) b64 += '='.repeat(4 - pad);
    const parsed = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return /** @type {Record<string, unknown>} */ (parsed);
  } catch {
    return null;
  }
}

/**
 * ChatGPT plan slug from auth.json id_token (never returns token values).
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function readChatGptPlanTypeFromAuthPayload(raw) {
  if (!raw || typeof raw !== 'object') return '';
  const tokens = /** @type {Record<string, unknown>} */ (raw).tokens;
  if (!tokens || typeof tokens !== 'object') return '';
  const idToken = /** @type {Record<string, unknown>} */ (tokens).id_token;
  const payload = decodeJwtPayload(idToken);
  if (!payload) return '';
  const nested = payload[OPENAI_AUTH_CLAIM];
  const fromNested = nested && typeof nested === 'object' && !Array.isArray(nested)
    ? /** @type {Record<string, unknown>} */ (nested).chatgpt_plan_type
    : '';
  if (typeof fromNested === 'string' && fromNested.trim()) return fromNested.trim();
  const fromTop = payload.chatgpt_plan_type;
  return typeof fromTop === 'string' ? fromTop.trim() : '';
}

/**
 * Client-safe ChatGPT login flags (no tokens).
 *
 * @param {string} [homeDir]
 * @returns {{
 *   codexChatGptAuthEffective: boolean,
 *   chatgptPlanType: string,
 * }}
 */
export function getCodexChatGptAuthMetaForClient(homeDir = resolveCodexHomeDir()) {
  const file = resolveCodexAuthJsonPath(homeDir);
  let payload = null;
  try {
    payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {
      codexChatGptAuthEffective: false,
      chatgptPlanType: '',
    };
  }
  const effective = isCodexChatGptAuthPayload(payload);
  return {
    codexChatGptAuthEffective: effective,
    chatgptPlanType: effective ? readChatGptPlanTypeFromAuthPayload(payload) : '',
  };
}
