/**
 * Loads `.env` without executing it. Precedence: process env → file → defaults.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @param {string} content
 * @returns {Record<string, string>}
 */
export function parseEnvFileContent(content) {
  return parseEnv(String(content || ''));
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} key
 * @returns {boolean}
 */
function hasEnvKey(env, key) {
  return Object.prototype.hasOwnProperty.call(env, key);
}

/**
 * @param {{ filePath?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {{ applied: string[] }}
 */
export function applyEnvFileToProcess(options = {}) {
  const env = options.env || process.env;
  const filePath = options.filePath || '';
  if (!filePath || !existsSync(filePath)) return { applied: [] };
  const parsed = parseEnvFileContent(readFileSync(filePath, 'utf8'));
  const applied = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (hasEnvKey(env, key)) continue;
    env[key] = value;
    applied.push(key);
  }
  return { applied };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function applyHttpsDefault(env = process.env) {
  if (hasEnvKey(env, 'USE_HTTPS') && String(env.USE_HTTPS || '') !== '') return false;
  env.USE_HTTPS = '1';
  return true;
}

/**
 * @param {{ root?: string, env?: NodeJS.ProcessEnv, envFile?: string }} [options]
 * @returns {void}
 */
export function applyCretliBootEnv(options = {}) {
  const env = options.env || process.env;
  const root = options.root || PROJECT_ROOT;
  const envFile = options.envFile || path.join(root, '.env');
  applyEnvFileToProcess({ filePath: envFile, env });
  applyHttpsDefault(env);
}
