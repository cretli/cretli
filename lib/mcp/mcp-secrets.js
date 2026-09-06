/**
 * Secret values for MCP connections. API responses never include raw values.
 * Mutations go through mutateMcpConfiguration so a 409 cannot change secrets.
 */

import { getMcpSecretsPath as persistSecretsPath, loadMcpSecretsDocument } from '../persist/mcp-persist.js';

/**
 * @returns {string}
 */
export function getMcpSecretsPath() {
  return persistSecretsPath();
}

/**
 * @param {string} serverId
 * @returns {Record<string, string>}
 */
export function getMcpSecrets(serverId) {
  const id = String(serverId || '').trim();
  if (!id) return {};
  return { ...(loadMcpSecretsDocument().secrets[id] || {}) };
}

/**
 * @param {string} serverId
 * @returns {string[]}
 */
export function listMcpSecretKeys(serverId) {
  return Object.keys(getMcpSecrets(serverId));
}

/**
 * Apply a secret patch onto an in-memory map (no disk write).
 *
 * @param {Record<string, Record<string, string>>} secrets
 * @param {string} serverId
 * @param {Record<string, string | null | undefined>} patch
 * @returns {Record<string, Record<string, string>>}
 */
export function applySecretPatchToMap(secrets, serverId, patch) {
  const id = String(serverId || '').trim();
  if (!id || !patch || typeof patch !== 'object') return secrets;
  const next = { ...secrets };
  const current = { ...(next[id] || {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete current[key];
      continue;
    }
    if (typeof value === 'string' && value) current[key] = value;
  }
  if (Object.keys(current).length === 0) delete next[id];
  else next[id] = current;
  return next;
}

/**
 * @param {Record<string, Record<string, string>>} secrets
 * @param {string} serverId
 * @returns {Record<string, Record<string, string>>}
 */
export function deleteSecretsFromMap(secrets, serverId) {
  const id = String(serverId || '').trim();
  if (!id) return secrets;
  const next = { ...secrets };
  delete next[id];
  return next;
}

/**
 * @param {Record<string, unknown>} bag
 * @param {Record<string, string>} secrets
 * @returns {Record<string, string>}
 */
export function resolveSecretMap(bag, secrets) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!bag || typeof bag !== 'object' || Array.isArray(bag)) return out;
  for (const [key, raw] of Object.entries(bag)) {
    if (typeof raw === 'string') {
      out[key] = raw;
      continue;
    }
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'secret' in raw) {
      const secretKey = typeof raw.secret === 'string' && raw.secret.trim()
        ? raw.secret.trim()
        : key;
      const value = secrets[secretKey];
      if (typeof value === 'string') out[key] = value;
    }
  }
  return out;
}
