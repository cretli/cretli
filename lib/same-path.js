import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function expandHome(value) {
  return value === '~' || value.startsWith(`~${path.sep}`)
    ? path.join(os.homedir(), value.slice(2))
    : value;
}

/**
 * Normalized form per raw path for a few seconds. Hot paths compare the same workspace folders for thousands of
 * chats, and every comparison was two synchronous realpath calls on the main thread.
 */
const NORMALIZED_TTL_MS = 5000;
const NORMALIZED_MAX = 5000;
/** @type {Map<string, { value: string, at: number }>} */
const normalizedCache = new Map();

/** @param {string} value */
function normalizeUncached(value) {
  let resolved = path.resolve(expandHome(value));
  try {
    resolved = fs.realpathSync.native(resolved);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const root = path.parse(resolved).root;
  resolved = resolved.replace(/[\\/]+$/, '') || root;
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** @param {string} value */
function normalize(value) {
  const now = Date.now();
  const hit = normalizedCache.get(value);
  if (hit && now - hit.at < NORMALIZED_TTL_MS) return hit.value;
  const normalized = normalizeUncached(value);
  if (normalizedCache.size >= NORMALIZED_MAX) normalizedCache.clear();
  normalizedCache.set(value, { value: normalized, at: now });
  return normalized;
}

/** Compare filesystem paths after resolving aliases and harmless spelling differences. */
export function samePath(left, right) {
  const a = String(left || '').trim();
  const b = String(right || '').trim();
  if (!a || !b) return false;
  return normalize(a) === normalize(b);
}
