/**
 * Installs, reinstalls or removes the Windows helper (cretli-netd) from the UI.
 *
 * Threat model: the endpoint never elevates by itself. It stages the repository
 * scripts in the Windows %TEMP% and asks Windows to run them with
 * `Start-Process -Verb RunAs`, which shows a UAC prompt on the Windows desktop.
 * Nothing happens without that click. The PowerShell command line is built here
 * from a fixed allow list; the client supplies only the action, never a path,
 * user or argument. See docs/apps-and-ports.md#windows-helper.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isWslHost, runProcess } from './netd-client.js';

export const INSTALL_ACTIONS = Object.freeze(['install', 'reinstall', 'uninstall']);
export const INSTALL_TIMEOUT_MS = 5 * 60_000;
/** Exit code Windows reports when the user declines the UAC prompt (ERROR_CANCELLED). */
export const UAC_CANCELLED_CODE = 1223;

const SCRIPT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'windows');
const STAGED_FILES = Object.freeze([
  'install-cretli-netd.ps1', 'cretli-netd.ps1', 'cretli-netctl.ps1', 'cretli-netd-common.ps1', 'cretli-netd-rule-spec.json',
]);
const INSTALLER = 'install-cretli-netd.ps1';
const ACTION_FLAGS = Object.freeze({ install: [], reinstall: ['-Reinstall'], uninstall: ['-Uninstall'] });

/**
 * Argument list of the elevated installer, from the action only. `stagingWin` is
 * a server-generated Windows path (random directory name), never client input.
 * @param {string} action
 * @param {string} stagingWin
 * @returns {string[]}
 */
export function buildInstallerArgs(action, stagingWin) {
  const flags = ACTION_FLAGS[/** @type {keyof typeof ACTION_FLAGS} */ (action)];
  if (!flags) throw new Error('unknown action');
  return ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', `${stagingWin}\\${INSTALLER}`, '-Yes', ...flags];
}

/**
 * Full powershell.exe argument vector that triggers the UAC prompt and relays the
 * elevated process exit code.
 * @param {string} action
 * @param {string} stagingWin
 * @returns {string[]}
 */
export function buildElevationCommand(action, stagingWin) {
  const inner = buildInstallerArgs(action, stagingWin).map((a) => `'${a.replace(/'/g, "''")}'`).join(',');
  const script = `$p = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -ArgumentList ${inner}; exit $p.ExitCode`;
  return ['-NoProfile', '-NonInteractive', '-Command', script];
}

/** Hash of the installer shown in the confirmation dialog so the user can compare it with the UAC target. */
export function installerSha256(dir = SCRIPT_DIR) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, INSTALLER))).digest('hex');
}

/**
 * Default staging: copies the scripts to a random directory in the Windows %TEMP%.
 * @param {import('./netd-client.js').RunProcess} run
 * @returns {Promise<{ ok: true, windowsDir: string, cleanup: () => void } | { ok: false, error: string }>}
 */
async function stageScripts(run) {
  const temp = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::Out.Write($env:TEMP)'], { timeout: 15_000, windowsHide: true, maxBuffer: 1 << 16 });
  const winTemp = String(temp.stdout || '').trim();
  if (temp.code !== 0 || !/^[A-Za-z]:\\/.test(winTemp)) return { ok: false, error: 'stage_failed' };
  const linuxTemp = await run('wslpath', ['-u', winTemp], { timeout: 5_000, windowsHide: true, maxBuffer: 1 << 16 });
  const base = String(linuxTemp.stdout || '').trim();
  if (linuxTemp.code !== 0 || !base.startsWith('/')) return { ok: false, error: 'stage_failed' };
  const name = `cretli-netd-${crypto.randomBytes(8).toString('hex')}`;
  const dir = path.join(base, name);
  try {
    fs.mkdirSync(dir, { recursive: false, mode: 0o700 });
    for (const file of STAGED_FILES) fs.copyFileSync(path.join(SCRIPT_DIR, file), path.join(dir, file));
  } catch {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    return { ok: false, error: 'stage_failed' };
  }
  return { ok: true, windowsDir: `${winTemp.replace(/\\+$/, '')}\\${name}`, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } } };
}

/**
 * @param {{ run?: import('./netd-client.js').RunProcess, isWsl?: () => boolean, stage?: typeof stageScripts, timeoutMs?: number, powershell?: string, getSha?: () => string }} [options]
 */
export function createHelperInstaller(options = {}) {
  const run = options.run || runProcess;
  const isWsl = options.isWsl || (() => isWslHost(process.platform, os.release()));
  const stage = options.stage || stageScripts;
  const timeoutMs = options.timeoutMs || INSTALL_TIMEOUT_MS;
  const powershell = options.powershell || 'powershell.exe';
  const getSha = options.getSha || (() => installerSha256());
  let busy = false;

  /** Static data for the confirmation dialog; carries no client input. */
  function describe() {
    const wsl = isWsl();
    let sha256 = null;
    try { sha256 = getSha(); } catch { /* scripts missing: the dialog shows no hash */ }
    return {
      supported: wsl, sha256,
      command: `powershell.exe -NoProfile -NonInteractive -Command "${buildElevationCommand('install', '%TEMP%\\cretli-netd-<random>')[3]}"`,
      manualCommand: '.\\scripts\\windows\\install-cretli-netd.ps1',
    };
  }

  /**
   * @param {string} action one of INSTALL_ACTIONS
   * @returns {Promise<{ ok: boolean, state: string, status: number, error?: string, message?: string }>}
   */
  async function execute(action) {
    if (!INSTALL_ACTIONS.includes(action)) return { ok: false, state: 'failed', status: 400, error: 'invalid-action' };
    if (!isWsl()) return { ok: false, state: 'unsupported', status: 409, error: 'not-wsl' };
    if (busy) return { ok: false, state: 'busy', status: 409, error: 'busy' };
    busy = true;
    let staged = null;
    try {
      staged = await stage(run);
      if (!staged.ok) return { ok: false, state: 'failed', status: 500, error: staged.error, message: staged.error };
      const result = await run(powershell, buildElevationCommand(action, staged.windowsDir), { timeout: timeoutMs, windowsHide: false, maxBuffer: 1 << 20 });
      const text = `${result.stderr || ''}\n${result.stdout || ''}`;
      if (result.timedOut) return { ok: false, state: 'failed', status: 504, error: 'timeout', message: 'timeout' };
      if (Number(result.code) === UAC_CANCELLED_CODE || /canceled by the user|cancelled by the user/i.test(text)) {
        return { ok: false, state: 'cancelled', status: 200, error: 'cancelled' };
      }
      if (Number(result.code) !== 0) {
        const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        return { ok: false, state: 'failed', status: 200, error: 'failed', message: (lines[lines.length - 1] || `exit ${result.code}`).slice(0, 300) };
      }
      return { ok: true, state: 'success', status: 200 };
    } catch (err) {
      return { ok: false, state: 'failed', status: 500, error: 'failed', message: String(/** @type {any} */ (err)?.message || err).slice(0, 300) };
    } finally {
      busy = false;
      try { staged?.ok && staged.cleanup(); } catch { /* best effort */ }
    }
  }

  return { describe, execute, isBusy: () => busy };
}

/** @type {ReturnType<typeof createHelperInstaller> | null} */
let defaultInstaller = null;
export function getDefaultHelperInstaller() {
  if (!defaultInstaller) defaultInstaller = createHelperInstaller();
  return defaultInstaller;
}
