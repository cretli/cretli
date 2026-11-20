/**
 * Headless ChatGPT device-code login for the bundled Codex CLI.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'fs';
import { isCodexCliFound, resolveCodexCli, getCodexCliMissingHint, isCodexNativeMissingOutput } from './codex-cli.ts';
import {
  getCodexTermuxRequestErrorHint,
  isCodexDeviceAuthRequestError,
  isTermuxLike,
} from './codex-termux-net.ts';
import { parseCodexDeviceAuthOutput, stripAnsi } from './codex-device-auth.ts';
import { resolveCodexAuthJsonPath } from './codex-chatgpt-auth.ts';
import { ensureCodexHomeDir } from './codex-home.ts';
import { buildCodexProcessEnv } from './codex-api-key.ts';

const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;
const FILE_STORE_OVERRIDE = 'cli_auth_credentials_store=file';

export type CodexLoginPhase = 'idle' | 'starting' | 'waiting' | 'completed' | 'error' | 'cancelled';

interface LoginState {
  phase: CodexLoginPhase;
  url: string;
  userCode: string;
  error: string;
  startedAt: number;
  child: ChildProcess | null;
  buffer: string;
  timeout: ReturnType<typeof setTimeout> | null;
}

let loginState: LoginState = createIdleState();

function createIdleState(): LoginState {
  return {
    phase: 'idle',
    url: '',
    userCode: '',
    error: '',
    startedAt: 0,
    child: null,
    buffer: '',
    timeout: null,
  };
}

function clearTimeoutSafe() {
  if (loginState.timeout) {
    clearTimeout(loginState.timeout);
    loginState.timeout = null;
  }
}

export function getCodexLoginState(): { phase: CodexLoginPhase, url: string, userCode: string, error: string, startedAt: number } {
  const showUrl = loginState.phase === 'waiting' || loginState.phase === 'starting';
  return {
    phase: loginState.phase,
    url: showUrl ? loginState.url : '',
    userCode: showUrl ? loginState.userCode : '',
    error: loginState.error,
    startedAt: loginState.startedAt,
  };
}

export function cancelCodexDeviceLogin(): void {
  const child = loginState.child;
  if (child && child.exitCode == null && !child.killed) {
    child.kill('SIGTERM');
  }
  clearTimeoutSafe();
  loginState = {
    ...createIdleState(),
    phase: 'cancelled',
    error: 'Login cancelled.',
  };
}

function formatLoginExitError(code: number | null, buffer: string): string {
  const text = stripAnsi(buffer).replace(/\r/g, '').trim();
  if (isCodexNativeMissingOutput(text)) return getCodexCliMissingHint();
  if (isCodexDeviceAuthRequestError(text)) {
    if (isTermuxLike()) return getCodexTermuxRequestErrorHint();
  }
  if (text) {
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
    const tail = lines.slice(-6).join(' ').slice(0, 500);
    if (tail) return tail;
  }
  return `Codex login exited with code ${code == null ? '?' : code}. Enable device-code login in ChatGPT security settings.`;
}

export function startCodexDeviceLogin(): { ok: boolean, error?: string } {
  if (!isCodexCliFound()) {
    return { ok: false, error: getCodexCliMissingHint() };
  }
  if (loginState.child && loginState.child.exitCode == null) {
    return { ok: true };
  }
  const bin = resolveCodexCli();
  const home = ensureCodexHomeDir();
  const env = buildCodexProcessEnv({ forceChatGpt: true });
  env.CODEX_HOME = home;
  env.NO_COLOR = '1';
  env.TERM = 'dumb';
  loginState = createIdleState();
  loginState.phase = 'starting';
  loginState.startedAt = Date.now();
  const child = spawn(bin, ['login', '--device-auth', '-c', FILE_STORE_OVERRIDE], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  loginState.child = child;
  const onChunk = (chunk: unknown) => {
    loginState.buffer += String(chunk || '');
    const parsed = parseCodexDeviceAuthOutput(loginState.buffer);
    if (parsed.url) loginState.url = parsed.url;
    if (parsed.userCode) loginState.userCode = parsed.userCode;
    if (loginState.url || loginState.userCode) loginState.phase = 'waiting';
  };
  child.stdout?.on('data', onChunk);
  child.stderr?.on('data', onChunk);
  child.on('error', (err) => {
    clearTimeoutSafe();
    loginState.child = null;
    loginState.phase = 'error';
    loginState.error = err?.message ? String(err.message) : 'Failed to start Codex login.';
  });
  child.on('close', (code) => {
    clearTimeoutSafe();
    loginState.child = null;
    if (loginState.phase === 'cancelled') return;
    if (code === 0) {
      loginState.phase = 'completed';
      loginState.error = '';
      return;
    }
    loginState.phase = 'error';
    loginState.error = formatLoginExitError(code, loginState.buffer);
  });
  loginState.timeout = setTimeout(() => {
    if (loginState.child && loginState.child.exitCode == null) {
      loginState.child.kill('SIGTERM');
    }
    loginState.phase = 'error';
    loginState.error = 'Login timed out. Start again and complete the code within 15 minutes.';
  }, LOGIN_TIMEOUT_MS);
  return { ok: true };
}

/**
 * Signs out of the isolated Codex ChatGPT session.
 */
export function logoutCodexChatGpt(): { ok: boolean, error?: string } {
  cancelCodexDeviceLogin();
  const home = ensureCodexHomeDir();
  if (isCodexCliFound()) {
    const env = buildCodexProcessEnv({ forceChatGpt: true });
    env.CODEX_HOME = home;
    spawnSync(resolveCodexCli(), ['logout', '-c', FILE_STORE_OVERRIDE], {
      env,
      encoding: 'utf8',
      timeout: 15000,
    });
  }
  const authFile = resolveCodexAuthJsonPath(home);
  try {
    if (fs.existsSync(authFile)) fs.unlinkSync(authFile);
  } catch (err) {
    const message = (err as { message?: unknown } | null)?.message;
    return { ok: false, error: message ? String(message) : 'Failed to remove auth.json.' };
  }
  return { ok: true };
}
