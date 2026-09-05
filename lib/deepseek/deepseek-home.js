/**
 * Isolated DSH_HOME for DeepSeek Harness (never ~/.dsh).
 */

import { ensureWritableDir } from '../ensure-writable-dir.js';
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
  return ensureWritableDir(resolveDeepSeekHomeDir());
}
