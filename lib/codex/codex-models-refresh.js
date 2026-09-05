/**
 * Force Codex CLI to rewrite CODEX_HOME/models_cache.json.
 * Start of `codex exec` fetches the account catalog even when the model 400s.
 */

import { spawn } from 'node:child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildCodexProcessEnv } from './codex-api-key.js';
import { isCodexCliFound, resolveCodexCli } from './codex-cli.js';
import { ensureCodexHomeDir } from './codex-home.js';
import { catalogFromCodexModelsCache } from './codex-models.js';

export const CODEX_MODELS_CACHE_FILENAME = 'models_cache.json';
export const CODEX_CATALOG_PROBE_TIMEOUT_MS = 20000;
export const CODEX_CATALOG_PROBE_MODEL = 'gpt-5.6-luna';

/**
 * @param {string} homeDir
 * @returns {string}
 */
export function resolveCodexModelsCachePath(homeDir) {
  return path.join(homeDir, CODEX_MODELS_CACHE_FILENAME);
}

/**
 * @param {string} homeDir
 * @returns {void}
 */
export function deleteCodexModelsCache(homeDir) {
  try {
    fs.unlinkSync(resolveCodexModelsCachePath(homeDir));
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return;
    throw err;
  }
}

/**
 * @param {Array<{ modelId?: string }>} catalog
 * @returns {string}
 */
export function fingerprintCodexCatalog(catalog) {
  const ids = [...new Set((catalog || [])
    .map((row) => String(row?.modelId || '').trim())
    .filter(Boolean))].sort();
  return ids.join(',');
}

/**
 * @param {{
 *   refresh?: boolean,
 *   catalogUnchanged?: boolean,
 *   planTypeUnchanged?: boolean,
 * }} input
 * @returns {boolean}
 */
export function shouldHintCodexCatalogRelogin(input) {
  if (input.refresh !== true) return false;
  if (input.catalogUnchanged !== true) return false;
  return input.planTypeUnchanged === true;
}

/**
 * @param {string} homeDir
 * @returns {import('../model-catalog.js').ModelCatalogEntry[]}
 */
function readCatalogFromHome(homeDir) {
  let raw;
  try {
    raw = fs.readFileSync(resolveCodexModelsCachePath(homeDir), 'utf8');
  } catch {
    return [];
  }
  try {
    return catalogFromCodexModelsCache(JSON.parse(raw));
  } catch {
    return [];
  }
}

/**
 * Cheap `codex exec` so CLI rewrites models_cache.json. Non-zero exit is OK.
 *
 * @param {{
 *   homeDir?: string,
 *   cliPath?: string,
 *   cwd?: string,
 *   timeoutMs?: number,
 *   spawnFn?: typeof spawn,
 * }} [options]
 * @returns {Promise<{ exitCode: number }>}
 */
export async function runCodexCatalogProbe(options = {}) {
  const homeDir = options.homeDir || ensureCodexHomeDir();
  const spawnFn = options.spawnFn || spawn;
  if (!options.spawnFn && !options.cliPath && !isCodexCliFound()) {
    return { exitCode: 1 };
  }
  const bin = options.cliPath || resolveCodexCli();
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? options.timeoutMs
    : CODEX_CATALOG_PROBE_TIMEOUT_MS;
  /** @type {Record<string, string>} */
  const env = { ...buildCodexProcessEnv({ forceChatGpt: true }) };
  env.CODEX_HOME = homeDir;
  env.NO_COLOR = '1';
  env.TERM = 'dumb';
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      resolve({ exitCode: code == null ? 1 : Number(code) });
    };
    let child;
    try {
      child = spawnFn(bin, [
        'exec',
        '--skip-git-repo-check',
        '--experimental-json',
        '-m',
        CODEX_CATALOG_PROBE_MODEL,
      ], {
        env,
        cwd: options.cwd || os.tmpdir(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      finish(1);
      return;
    }
    try {
      child.stdin?.write('x');
      child.stdin?.end();
    } catch {
      /* ignore */
    }
    const timer = setTimeout(() => {
      try {
        if (child && child.exitCode == null && !child.killed) child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      finish(1);
    }, timeoutMs);
    child.on?.('error', () => {
      clearTimeout(timer);
      finish(1);
    });
    child.on?.('close', (code) => {
      clearTimeout(timer);
      finish(code);
    });
  });
}

/**
 * Delete the stale cache, probe CLI, then read the rewritten catalog.
 *
 * @param {{
 *   homeDir?: string,
 *   runProbe?: (opts: { homeDir: string }) => Promise<unknown>,
 *   spawnFn?: typeof spawn,
 *   cliPath?: string,
 * }} [options]
 * @returns {Promise<{
 *   catalog: import('../model-catalog.js').ModelCatalogEntry[],
 *   modelsSource: 'live' | 'fallback',
 * }>}
 */
export async function refreshLiveCodexCatalog(options = {}) {
  const homeDir = options.homeDir || ensureCodexHomeDir();
  deleteCodexModelsCache(homeDir);
  const runProbe = options.runProbe || ((opts) => runCodexCatalogProbe({
    ...opts,
    spawnFn: options.spawnFn,
    cliPath: options.cliPath,
  }));
  await runProbe({ homeDir });
  const catalog = readCatalogFromHome(homeDir);
  return {
    catalog,
    modelsSource: catalog.length > 0 ? 'live' : 'fallback',
  };
}
