/**
 * Persistent HMAC secret for billing-account credential fingerprints.
 * Stored once under gitignored `data/`; not tied to serverInstanceToken.
 */

import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { writeJsonAtomic } from '../persist/atomic-write.js';
import { resolveDataPath } from '../runtime-paths.js';

/**
 * @param {{ filePath?: string }} [input]
 * @returns {string}
 */
export function resolveBillingAccountSecretPath(input = {}) {
  return String(input.filePath || '').trim() || resolveDataPath('billing-account-hmac-secret.json');
}

/**
 * @param {{ filePath?: string, secret?: string, secretId?: string }} [overrides]
 * @returns {{ secretId: string, secret: string, recreated: boolean }}
 */
export function loadBillingAccountHmacSecret(overrides = {}) {
  if (typeof overrides.secret === 'string' && overrides.secret.length >= 32) {
    const secretId = String(overrides.secretId || 'test').trim() || 'test';
    return { secretId, secret: overrides.secret, recreated: false };
  }
  const filePath = resolveBillingAccountSecretPath(overrides);
  if (fs.existsSync(filePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const secret = typeof parsed?.secret === 'string' ? parsed.secret.trim() : '';
      const secretId = String(parsed?.secretId || '').trim();
      if (secret.length >= 32 && secretId) {
        return { secretId, secret, recreated: false };
      }
    } catch {
      // Recreate below — treat as secret loss, not a new wallet identity.
    }
  }
  const secretId = randomUUID();
  const secret = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
  const dir = filePath.slice(0, filePath.lastIndexOf('/'));
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  writeJsonAtomic(filePath, { secretId, secret, createdAt: new Date().toISOString() });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // ignore
  }
  return { secretId, secret, recreated: true };
}
