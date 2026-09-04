/**
 * Headless ChatGPT device-code login for the bundled Codex CLI.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'fs';
import { isCodexCliFound, resolveCodexCli, getCodexCliMissingHint, isCodexNativeMissingOutput } from './codex-cli.js';
import {
  getCodexTermuxRequestErrorHint,
  isCodexDeviceAuthRequestError,
  isTermuxLike,
} from './codex-termux-net.js';
import { parseCodexDeviceAuthOutput, stripAnsi } from './codex-device-auth.js';
import { resolveCodexAuthJsonPath } from './codex-chatgpt-auth.js';
import { ensureCodexHomeDir } from './codex-home.js';
import { buildCodexProcessEnv } from './codex-api-key.js';

const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;
const FILE_STORE_OVERRIDE = 'cli_auth_credentials_store=file';

/** @typedef {'idle' | 'starting' | 'waiting' | 'completed' | 'error' | 'cancelled'} CodexLoginPhase */

/** @type {{
 *   phase: CodexLoginPhase,
 *   url: string,
 *   userCode: string,
 *   error: string,
 *   startedAt: number,
 *   child: import('node:child_process').ChildProcess | null,
 *   buffer: string,
 *   timeout: ReturnType<typeof setTimeout> | null,
 * }} */
let loginState = createIdleState();

function createIdleState() {
  return {
    phase: /** @type {CodexLoginPhase} */ ('idle'),
    url: '',
    userCode: '',
    error: '',
    startedAt: 0,
    child: /** @type {import('node:child_process').ChildProcess | null} */ (null),
    buffer: '',
    timeout: /** @type {ReturnType<typeof setTimeout> | null} */ (null),
  };
}

function clearTimeoutSafe() {
  if (loginState.timeout) {
    clearTimeout(loginState.timeout);
    loginState.timeout = null;
  }
}

/**
 * @returns {{
 *   phase: CodexLoginPhase,
 *   url: string,
 *   userCode: string,
 *   error: string,
 *   startedAt: number,
 * }}
 */
export function getCodexLoginState() {
  const showUrl = loginState.phase === 'waiting' || loginState.phase === 'starting';
  return {
    phase: loginState.phase,
    url: showUrl ? loginState.url : '',
    userCode: showUrl ? loginState.userCode : '',
    error: loginState.error,
    startedAt: loginState.startedAt,
  };
}

/**
 * @returns {void}
 */
export function cancelCodexDeviceLogin() {
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

/**
 * @param {number | null} code
 * @param {string} buffer
 * @returns {string}
 */
function formatLoginExitError(code, buffer) {
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

/**
 * @returns {{ ok: boolean, error?: string }}
 */
export function startCodexDeviceLogin() {
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
  const onChunk = (chunk) => {
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
 *
 * @returns {{ ok: boolean, error?: string }}
 */
export function logoutCodexChatGpt() {
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
    return { ok: false, error: err?.message ? String(err.message) : 'Failed to remove auth.json.' };
  }
  return { ok: true };
}
