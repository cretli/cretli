/**
 * Claude Code plan login (PKCE). The browser shows a code; Cretli exchanges
 * it and stores the session in the isolated Claude home. Tokens never leave
 * the server response.
 */

import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { ensureWritableDir } from '../ensure-writable-dir.js';
import { resolveDataPath } from '../runtime-paths.js';
import { loadSettings, saveSettings } from '../persist/settings.js';

const CLAUDE_AI_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const CLAUDE_CODE_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const CLAUDE_CODE_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const CLAUDE_CODE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CLAUDE_CODE_REDIRECT_URL = 'https://console.anthropic.com/oauth/code/callback';
const CLAUDE_CODE_LOGIN_SCOPE = 'user:profile user:inference user:sessions:claude_code';
const LOGIN_TTL_MS = 15 * 60 * 1000;

export type ClaudeLoginPhase = 'idle' | 'waiting' | 'completed' | 'error' | 'cancelled';

interface ClaudeLoginInternalState {
  phase: ClaudeLoginPhase;
  url: string;
  error: string;
  startedAt: number;
  verifier: string;
  state: string;
}

export interface ClaudePlanLoginState {
  phase: ClaudeLoginPhase;
  url: string;
  error: string;
  startedAt: number;
}

export type ClaudePlanLoginResult =
  | { ok: true; login: ClaudePlanLoginState }
  | { ok: false; error: string; login: ClaudePlanLoginState };

let loginState: ClaudeLoginInternalState = createIdleState();

function createIdleState(): ClaudeLoginInternalState {
  return {
    phase: 'idle',
    url: '',
    error: '',
    startedAt: 0,
    verifier: '',
    state: '',
  };
}

function createRandomToken(): string {
  return randomBytes(32).toString('base64url');
}

export function createClaudeCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function buildClaudePlanAuthorizeUrl(input: { challenge: string; state: string }): string {
  const url = new URL(CLAUDE_AI_AUTHORIZE_URL);
  url.searchParams.set('code', 'true');
  url.searchParams.set('client_id', CLAUDE_CODE_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', CLAUDE_CODE_REDIRECT_URL);
  url.searchParams.set('scope', CLAUDE_CODE_LOGIN_SCOPE);
  url.searchParams.set('code_challenge', input.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', input.state);
  return url.toString();
}

/**
 * Accepts a raw code, `code#state`, or the callback URL.
 */
export function parseClaudeAuthorizationCode(
  raw: unknown,
  expectedState = '',
): { ok: true; code: string; state: string } | { ok: false; error: string } {
  const text = String(raw || '').trim();
  if (!text) return { ok: false, error: 'Paste the code from the Claude login page.' };
  let code = text;
  let state = expectedState;
  if (text.startsWith('http://') || text.startsWith('https://')) {
    try {
      const url = new URL(text);
      code = url.searchParams.get('code') || '';
      state = url.searchParams.get('state') || expectedState;
    } catch {
      return { ok: false, error: 'That value is not a Claude authorization code.' };
    }
  }
  const hashAt = code.indexOf('#');
  if (hashAt >= 0) {
    state = code.slice(hashAt + 1).trim() || state;
    code = code.slice(0, hashAt);
  }
  code = code.trim();
  if (!code) return { ok: false, error: 'Paste the code from the Claude login page.' };
  if (expectedState && state && state !== expectedState) {
    return { ok: false, error: 'That code is for a different login attempt. Start again.' };
  }
  return { ok: true, code, state: state || expectedState };
}

export function getClaudePlanLoginState(): ClaudePlanLoginState {
  const showUrl = loginState.phase === 'waiting';
  return {
    phase: loginState.phase,
    url: showUrl ? loginState.url : '',
    error: loginState.error,
    startedAt: loginState.startedAt,
  };
}

export function startClaudePlanLogin(): { ok: true; login: ClaudePlanLoginState } {
  const stillWaiting = loginState.phase === 'waiting'
    && loginState.verifier
    && Date.now() - loginState.startedAt < LOGIN_TTL_MS;
  if (stillWaiting) {
    return { ok: true, login: getClaudePlanLoginState() };
  }
  const verifier = createRandomToken();
  const state = createRandomToken();
  loginState = {
    phase: 'waiting',
    url: buildClaudePlanAuthorizeUrl({
      challenge: createClaudeCodeChallenge(verifier),
      state,
    }),
    error: '',
    startedAt: Date.now(),
    verifier,
    state,
  };
  return { ok: true, login: getClaudePlanLoginState() };
}

export function cancelClaudePlanLogin(): { ok: true; login: ClaudePlanLoginState } {
  loginState = {
    ...createIdleState(),
    phase: 'cancelled',
    error: 'Login cancelled.',
  };
  return { ok: true, login: getClaudePlanLoginState() };
}

async function readClaudeOauthProfile(
  accessToken: string,
): Promise<{ subscriptionType: string | null; rateLimitTier: string | null }> {
  const empty = { subscriptionType: null, rateLimitTier: null };
  try {
    const response = await fetch(CLAUDE_CODE_PROFILE_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });
    if (!response.ok) return empty;
    const data = (await response.json()) as { organization?: unknown } | null | undefined;
    const organization: { organization_type?: unknown; rate_limit_tier?: unknown } =
      data?.organization && typeof data.organization === 'object' ? data.organization : {};
    const kind = String(organization.organization_type || '');
    const subscriptionType = ({
      claude_max: 'max',
      claude_pro: 'pro',
      claude_enterprise: 'enterprise',
      claude_team: 'team',
    } as Record<string, string>)[kind] || null;
    const rateLimitTier = typeof organization.rate_limit_tier === 'string'
      ? organization.rate_limit_tier
      : null;
    return { subscriptionType, rateLimitTier };
  } catch {
    return empty;
  }
}

export async function completeClaudePlanLogin(rawCode: unknown): Promise<ClaudePlanLoginResult> {
  if (loginState.phase !== 'waiting' || !loginState.verifier) {
    return {
      ok: false,
      error: 'Start Claude login first.',
      login: getClaudePlanLoginState(),
    };
  }
  if (Date.now() - loginState.startedAt > LOGIN_TTL_MS) {
    loginState = { ...createIdleState(), phase: 'error', error: 'Login expired. Start again.' };
    return { ok: false, error: loginState.error, login: getClaudePlanLoginState() };
  }
  const parsed = parseClaudeAuthorizationCode(rawCode, loginState.state);
  if (parsed.ok === false) {
    return { ok: false, error: parsed.error, login: getClaudePlanLoginState() };
  }
  let data: { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown };
  try {
    const response = await fetch(CLAUDE_CODE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code: parsed.code,
        redirect_uri: CLAUDE_CODE_REDIRECT_URL,
        client_id: CLAUDE_CODE_CLIENT_ID,
        code_verifier: loginState.verifier,
        state: loginState.state,
      }),
    });
    if (!response.ok) {
      loginState = {
        ...loginState,
        phase: 'error',
        error: response.status === 401
          ? 'Claude rejected that code. Start again and paste the new code.'
          : `Claude login failed (${response.status}).`,
      };
      return { ok: false, error: loginState.error, login: getClaudePlanLoginState() };
    }
    data = (await response.json()) as typeof data;
  } catch {
    loginState = { ...loginState, phase: 'error', error: 'Could not reach Claude to finish login.' };
    return { ok: false, error: loginState.error, login: getClaudePlanLoginState() };
  }
  const accessToken = typeof data.access_token === 'string' ? data.access_token.trim() : '';
  const refreshToken = typeof data.refresh_token === 'string' ? data.refresh_token.trim() : '';
  if (!accessToken || !refreshToken) {
    loginState = { ...loginState, phase: 'error', error: 'Claude login did not return a session.' };
    return { ok: false, error: loginState.error, login: getClaudePlanLoginState() };
  }
  const expiresIn = Number(data.expires_in || 0);
  const scopes = typeof data.scope === 'string'
    ? data.scope.split(' ').filter(Boolean)
    : CLAUDE_CODE_LOGIN_SCOPE.split(' ');
  const profile = await readClaudeOauthProfile(accessToken);
  const configuredDir = String(process.env.CRETLI_CLAUDE_CONFIG_DIR || '').trim();
  const dir = ensureWritableDir(configuredDir || resolveDataPath('claude-home'));
  const file = path.join(dir, '.credentials.json');
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!payload || typeof payload !== 'object') payload = {};
  } catch {
    payload = {};
  }
  payload.claudeAiOauth = {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000,
    scopes,
    subscriptionType: profile.subscriptionType,
    rateLimitTier: profile.rateLimitTier,
  };
  fs.writeFileSync(file, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  const settings = loadSettings();
  settings.claudeAuthMode = 'subscription';
  saveSettings(settings);
  loginState = { ...createIdleState(), phase: 'completed' };
  return { ok: true, login: getClaudePlanLoginState() };
}
