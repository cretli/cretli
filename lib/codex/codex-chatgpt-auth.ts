/**
 * ChatGPT / Codex plan session stored under isolated CODEX_HOME (auth.json).
 * Never returns token values to callers that feed HTTP responses.
 */

import fs from 'fs';
import path from 'path';
import { resolveCodexHomeDir } from './codex-home.ts';

const CHATGPT_AUTH_MODES = new Set(['chatgpt', 'chat-gpt', 'chatgpt_oauth', 'oauth']);

export function resolveCodexAuthJsonPath(homeDir: string = resolveCodexHomeDir()): string {
  return path.join(homeDir, 'auth.json');
}

export function isCodexChatGptAuthPayload(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const data = raw as Record<string, unknown>;
  const mode = typeof data.auth_mode === 'string' ? data.auth_mode.trim().toLowerCase() : '';
  if (mode && CHATGPT_AUTH_MODES.has(mode)) return true;
  const tokens = data.tokens && typeof data.tokens === 'object' ? (data.tokens as Record<string, unknown>) : null;
  if (!tokens) return false;
  const access = typeof tokens.access_token === 'string' && tokens.access_token.trim();
  const refresh = typeof tokens.refresh_token === 'string' && tokens.refresh_token.trim();
  return !!(access || refresh);
}

export function hasCodexChatGptAuth(homeDir: string = resolveCodexHomeDir()): boolean {
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
 */
export function decodeJwtPayload(token: unknown): Record<string, unknown> | null {
  if (typeof token !== 'string' || !token.trim()) return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4;
    if (pad) b64 += '='.repeat(4 - pad);
    const parsed = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * ChatGPT plan slug from auth.json id_token (never returns token values).
 */
export function readChatGptPlanTypeFromAuthPayload(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return '';
  const tokens = (raw as Record<string, unknown>).tokens;
  if (!tokens || typeof tokens !== 'object') return '';
  const idToken = (tokens as Record<string, unknown>).id_token;
  const payload = decodeJwtPayload(idToken);
  if (!payload) return '';
  const nested = payload[OPENAI_AUTH_CLAIM];
  const fromNested = nested && typeof nested === 'object' && !Array.isArray(nested)
    ? (nested as Record<string, unknown>).chatgpt_plan_type
    : '';
  if (typeof fromNested === 'string' && fromNested.trim()) return fromNested.trim();
  const fromTop = payload.chatgpt_plan_type;
  return typeof fromTop === 'string' ? fromTop.trim() : '';
}

/**
 * Client-safe ChatGPT login flags (no tokens).
 */
export function getCodexChatGptAuthMetaForClient(
  homeDir: string = resolveCodexHomeDir(),
): { codexChatGptAuthEffective: boolean; chatgptPlanType: string } {
  const file = resolveCodexAuthJsonPath(homeDir);
  let payload: unknown = null;
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
