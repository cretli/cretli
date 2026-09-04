/**
 * Isolated DSH_HOME for DeepSeek Harness (never ~/.dsh).
 */

import fs from 'fs';
import { resolveDataPath } from '../runtime-paths.js';

/**
 * @returns {string}
 */
export function resolveDeepSeekHomeDir() {
  return resolveDataPath('dsh-home');
}

/**
 * @returns {string}
 */
export function ensureDeepSeekHomeDir() {
  const dir = resolveDeepSeekHomeDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
