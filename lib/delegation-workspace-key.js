/**
 * Canonical workspace key for delegation records. Dependency-free on purpose:
 * the settings store imports it, and the guard/status modules sit in a cycle.
 */

import fs from 'node:fs';
import path from 'node:path';

const REALPATH_CACHE_MAX = 256;
// Short TTL so a re-pointed symlink is picked up; the Watcher tick runs every ~20 s.
const REALPATH_CACHE_TTL_MS = 30_000;
/** @type {Map<string, { value: string, at: number }>} resolved path -> realpath (successes only) */
const realpathCache = new Map();

/** Test-only: drop every cached realpath. */
export function resetDelegationWorkspaceKeyCache() {
  realpathCache.clear();
}

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
  const now = Date.now();
  const hit = realpathCache.get(resolved);
  if (hit && now - hit.at < REALPATH_CACHE_TTL_MS) return hit.value;
  try {
    const value = fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
    realpathCache.delete(resolved);
    if (realpathCache.size >= REALPATH_CACHE_MAX) {
      // Evict the oldest insertion (Map iterates in insertion order).
      const oldest = realpathCache.keys().next().value;
      if (oldest !== undefined) realpathCache.delete(oldest);
    }
    realpathCache.set(resolved, { value, at: now });
    return value;
  } catch {
    // Failures are never cached so a later-created path resolves.
    return resolved;
  }
}
