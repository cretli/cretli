/**
 * Canonical workspace key for delegation records. Dependency-free on purpose:
 * the settings store imports it, and the guard/status modules sit in a cycle.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {unknown} folder
 * @returns {string}
 */
export function normalizeDelegationWorkspaceKey(folder) {
  const raw = String(folder || '').trim();
  if (!raw) return '';
  let resolved = raw;
  try {
    resolved = path.resolve(raw);
  } catch {
    return raw;
  }
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}
