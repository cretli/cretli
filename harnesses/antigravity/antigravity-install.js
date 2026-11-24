/**
 * One-click install of the Antigravity CLI (`agy`) from Settings.
 *
 * Runs Google's official Unix bootstrapper (the documented
 * `curl -fsSL https://antigravity.google/cli/install.sh | bash`) under the server account:
 * the script is fetched from a fixed HTTPS URL, written to a private temp directory and run
 * with bash and no arguments (it rejects unknown flags). The bootstrapper verifies the
 * binary's SHA-512 against the release manifest, installs `~/.local/bin/agy` without sudo,
 * leaves an existing binary untouched and runs `agy install` to set up the shell PATH.
 * Windows uses a PowerShell installer and stays manual.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { defaultAntigravityInstallPath } from './antigravity-config.js';

export const ANTIGRAVITY_INSTALL_SCRIPT_URL = 'https://antigravity.google/cli/install.sh';
export const ANTIGRAVITY_INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_SCRIPT_BYTES = 256 * 1024;
const OUTPUT_TAIL = 4000;

/**
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   spawnImpl?: typeof spawn,
 *   platform?: string,
 *   env?: NodeJS.ProcessEnv,
 *   timeoutMs?: number,
 * }} [deps]
 * @returns {Promise<{ ok: true, binPath: string } | { ok: false, code: string, error: string }>}
 */
export async function installAntigravityCli(deps = {}) {
  const { fetchImpl = fetch, spawnImpl = spawn, platform = process.platform, env = process.env, timeoutMs = ANTIGRAVITY_INSTALL_TIMEOUT_MS } = deps;
  if (platform !== 'linux' && platform !== 'darwin') {
    return { ok: false, code: 'unsupported_platform', error: 'Automatic install supports Linux and macOS. On Windows run the PowerShell installer from the Antigravity docs.' };
  }
  let script;
  try {
    const response = await fetchImpl(ANTIGRAVITY_INSTALL_SCRIPT_URL, { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
    if (!response.ok) return { ok: false, code: 'download_failed', error: `Installer download failed (HTTP ${response.status}).` };
    script = await response.text();
  } catch (error) {
    return { ok: false, code: 'download_failed', error: `Installer download failed: ${error?.message || error}` };
  }
  if (Buffer.byteLength(script) > MAX_SCRIPT_BYTES || !/^#!\/bin\/(ba)?sh\b/.test(script)) {
    return { ok: false, code: 'unexpected_installer', error: 'The downloaded installer does not look like the Antigravity shell script; nothing was run.' };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-agy-install-'));
  const file = path.join(dir, 'install.sh');
  try {
    fs.writeFileSync(file, script, { mode: 0o600 });
    const result = await runInstaller(spawnImpl, file, dir, env, timeoutMs);
    if (result.ok === false) return result;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const binPath = defaultAntigravityInstallPath(env);
  if (!binPath || !isExecutable(binPath)) {
    return { ok: false, code: 'binary_missing', error: `The installer finished but ${binPath || '~/.local/bin/agy'} was not found.` };
  }
  return { ok: true, binPath };
}

/** @param {string} file */
function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch { return false; }
}

/**
 * @param {typeof spawn} spawnImpl
 * @param {string} file
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} env
 * @param {number} timeoutMs
 * @returns {Promise<{ ok: true } | { ok: false, code: string, error: string }>}
 */
function runInstaller(spawnImpl, file, cwd, env, timeoutMs) {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const child = spawnImpl('bash', [file], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ ok: false, code: 'timeout', error: 'The Antigravity installer did not finish in time.' });
    }, timeoutMs);
    for (const stream of [child.stdout, child.stderr]) {
      stream?.setEncoding('utf8');
      stream?.on('data', (chunk) => { output = `${output}${chunk}`.slice(-OUTPUT_TAIL); });
    }
    child.once('error', (error) => finish({ ok: false, code: 'spawn_failed', error: `Could not start bash: ${error?.message || error}` }));
    child.once('close', (code) => {
      if (code === 0) finish({ ok: true });
      else finish({ ok: false, code: 'installer_failed', error: output.trim().split('\n').slice(-3).join('\n') || `Installer exited with code ${code}` });
    });
  });
}

let inFlight = false;

/** @param {import('express').Express} app */
export function registerAntigravityInstallRoute(app, install = installAntigravityCli) {
  app.post('/api/antigravity/install', async (req, res) => {
    if (req.widgetAccess || req.mcpIntegration) return res.status(403).json({ ok: false, error: 'Forbidden' });
    res.set('Cache-Control', 'no-store');
    if (inFlight) return res.status(409).json({ ok: false, code: 'in_progress', error: 'An Antigravity install is already running.' });
    inFlight = true;
    try {
      const result = await install();
      return res.status(result.ok === true ? 200 : result.code === 'unsupported_platform' ? 400 : 500).json(result);
    } finally {
      inFlight = false;
    }
  });
}
