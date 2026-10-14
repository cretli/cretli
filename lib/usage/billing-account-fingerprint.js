/**
 * Private credential fingerprints for billing accounts. Never persist raw keys.
 */

import { createHmac } from 'node:crypto';

/**
 * @param {{ secret: string, provider: string, endpoint: string, credentialMaterial: string }} input
 * @returns {string}
 */
export function fingerprintBillingCredential(input) {
  const provider = String(input.provider || '').trim().toLowerCase();
  const endpoint = normalizeEndpoint(input.endpoint);
  const material = String(input.credentialMaterial || '').trim();
  if (!input.secret || !provider || !endpoint || !material) return '';
  const payload = `v1|${provider}|${endpoint}|${material.length}|${material}`;
  return createHmac('sha256', input.secret).update(payload, 'utf8').digest('hex');
}

/**
 * @param {unknown} endpoint
 * @returns {string}
 */
export function normalizeEndpoint(endpoint) {
  const raw = String(endpoint || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '') || ''}`.toLowerCase();
  } catch {
    return raw.toLowerCase().replace(/\/+$/, '');
  }
}
