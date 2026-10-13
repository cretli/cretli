/**
 * Applies upstream package updates for one harness (explicit Settings action).
 *
 * The plan is derived from the version inventory, never from the request body:
 * only packages Cretli declares in one of its own manifests and that the last
 * registry check reported as behind are touched. `npm install <name>@<version>`
 * rewrites the owning manifest and lockfile, so the bump survives a later
 * `npm install` / `npm ci`. The running server keeps the old modules loaded
 * until it is restarted.
 */

import path from 'node:path';
import { spawn } from 'node:child_process';

import { compareSemver, parseSemver } from './harness-updates.js';

export const PACKAGE_UPDATE_TIMEOUT_MS = 10 * 60 * 1000;
const STDERR_TAIL_LENGTH = 4000;

/**
 * @param {string} spec
 * @returns {boolean} true when the manifest pins one exact version
 */
function isExactSpec(spec) {
  return Boolean(parseSemver(String(spec || '').trim().replace(/^=/, '')));
}

/**
 * @param {object} inventory merged inventory (`getHarnessVersionInventoryWithUpdates`)
 * @param {string} harnessId
 * @returns {{
 *   harness: string,
 *   installPrefix: string,
 *   targets: { name: string, from: string, to: string, exact: boolean }[],
 * } | null} null when the harness is unknown
 */
export function planHarnessPackageUpdate(inventory, harnessId) {
  const id = String(harnessId || '').trim().toLowerCase();
  const rows = Array.isArray(inventory?.harnesses) ? inventory.harnesses : [];
  const entry = rows.find((row) => String(row?.harness || '').trim().toLowerCase() === id);
  if (!id || !entry) return null;
  const targets = [];
  for (const row of Array.isArray(entry.packages) ? entry.packages : []) {
    if (row?.canUpdate !== true || !row.declaredSpec) continue;
    const latest = parseSemver(row.latest);
    if (!latest || !row.installed) continue;
    if (compareSemver(latest.raw, row.installed) <= 0) continue;
    targets.push({
      name: String(row.name),
      from: String(row.installed),
      to: latest.raw,
      exact: isExactSpec(row.declaredSpec),
    });
  }
  return {
    harness: id,
    installPrefix: typeof entry.installPrefix === 'string' ? entry.installPrefix : '',
    targets,
  };
}

/**
 * One npm invocation per pin style, so an exact pin stays exact and a range
 * keeps its range operator in the manifest.
 *
 * @param {{ installPrefix: string, targets: { name: string, to: string, exact: boolean }[] }} plan
 * @param {string} projectRoot
 * @returns {{ args: string[], cwd: string }[]}
 */
export function buildNpmUpdateCommands(plan, projectRoot) {
  const commands = [];
  for (const exact of [true, false]) {
    const specs = plan.targets
      .filter((target) => target.exact === exact)
      .map((target) => `${target.name}@${target.to}`);
    if (!specs.length) continue;
    const args = ['install', '--no-audit', '--no-fund'];
    if (exact) args.push('--save-exact');
    // The isolated Claude tree is installed with scripts disabled; keep that.
    if (plan.installPrefix) {
      args.push('--ignore-scripts', '--prefix', path.join(projectRoot, plan.installPrefix));
    }
    commands.push({ args: args.concat(specs), cwd: projectRoot });
  }
  return commands;
}

/**
 * @param {{ args: string[], cwd: string }} command
 * @param {{ timeoutMs?: number, spawnFactory?: typeof spawn }} [options]
 * @returns {Promise<void>} rejects with the npm stderr tail
 */
export function runNpmCommand(command, options = {}) {
  const spawnFactory = options.spawnFactory || spawn;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : PACKAGE_UPDATE_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const child = spawnFactory('npm', command.args, {
      cwd: command.cwd,
      env: process.env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`npm install timed out after ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    child.stderr?.setEncoding?.('utf8');
    child.stderr?.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-STDERR_TAIL_LENGTH); });
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `npm install exited with code ${code}`));
    });
  });
}
