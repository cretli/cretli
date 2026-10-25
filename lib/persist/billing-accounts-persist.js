/**
 * Durable billing-account registry (`data/billing-accounts.json`).
 */

import fs from 'node:fs';
import { writeJsonAtomic } from './atomic-write.js';
import { resolveDataPath } from '../runtime-paths.js';

export const BILLING_ACCOUNTS_SCHEMA_VERSION = 1;

/**
 * @param {{ filePath?: string }} [input]
 * @returns {string}
 */
export function resolveBillingAccountsPath(input = {}) {
  return String(input.filePath || '').trim() || resolveDataPath('billing-accounts.json');
}

/**
 * @param {{ filePath?: string }} [input]
 * @returns {{ version: number, secretId: string, accounts: Record<string, any>[] }}
 */
export function loadBillingAccountsDocument(input = {}) {
  const filePath = resolveBillingAccountsPath(input);
  if (!fs.existsSync(filePath)) {
    return { version: BILLING_ACCOUNTS_SCHEMA_VERSION, secretId: '', accounts: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const accounts = Array.isArray(parsed?.accounts) ? parsed.accounts : [];
    return {
      version: Number(parsed?.version) || BILLING_ACCOUNTS_SCHEMA_VERSION,
      secretId: String(parsed?.secretId || '').trim(),
      accounts,
    };
  } catch {
    return { version: BILLING_ACCOUNTS_SCHEMA_VERSION, secretId: '', accounts: [] };
  }
}

/**
 * @param {Record<string, any>} document
 * @param {{ filePath?: string }} [input]
 */
export function saveBillingAccountsDocument(document, input = {}) {
  const filePath = resolveBillingAccountsPath(input);
  const dir = filePath.slice(0, filePath.lastIndexOf('/'));
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  writeJsonAtomic(filePath, document);
}
