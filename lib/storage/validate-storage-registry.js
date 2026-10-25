/**
 * Validates the versioned storage registry artifact (A1).
 * @see docs/storage-contract.md
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ALLOWED_BACKEND_KINDS = new Set([
  'json-document',
  'json-document-per-key',
  'jsonl-append',
  'sqlite-wal-full',
  'sqlite-lock-only',
  'json-with-sqlite-lock',
  'process-env-only',
]);

const ALLOWED_PATH_CLASS = new Set(['managed', 'retained', 'control-external']);

const REQUIRED_STORE_KEYS = [
  'id',
  'domainOwner',
  'backend',
  'managedPaths',
  'retainedPaths',
  'lockOrderRank',
  'locks',
  'buffers',
  'secrets',
  'rawValidator',
  'adapters',
  'durability',
  'ackClasses',
  'writers',
];

/**
 * @param {unknown} registry
 * @returns {{ ok: true, registry: any, path?: string } | { ok: false, errors: string[] }}
 */
export function validateStorageRegistry(registry) {
  /** @type {string[]} */
  const errors = [];
  if (!registry || typeof registry !== 'object') {
    return { ok: false, errors: ['registry must be an object'] };
  }
  const doc = /** @type {Record<string, unknown>} */ (registry);
  if (typeof doc.registryVersion !== 'number' || doc.registryVersion < 1) {
    errors.push('registryVersion must be a positive number');
  }
  if (!Array.isArray(doc.lockOrderHint)) {
    errors.push('lockOrderHint must be an array of store ids');
  }
  if (!Array.isArray(doc.stores) || doc.stores.length === 0) {
    errors.push('stores must be a non-empty array');
  }
  if (!Array.isArray(doc.inventoryGaps)) {
    errors.push('inventoryGaps must be an array (explicit unknown writers / unresolved paths)');
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  const lockOrderHint = /** @type {string[]} */ (doc.lockOrderHint);
  const stores = /** @type {any[]} */ (doc.stores);
  const ids = new Set();
  for (const store of stores) {
    if (!store || typeof store !== 'object') {
      errors.push('each store must be an object');
      continue;
    }
    const row = /** @type {Record<string, unknown>} */ (store);
    for (const key of REQUIRED_STORE_KEYS) {
      if (!(key in row)) {
        errors.push(`store missing required field "${key}"`);
      }
    }
    const id = String(row.id || '').trim();
    if (!id) {
      errors.push('store id is required');
      continue;
    }
    if (ids.has(id)) {
      errors.push(`duplicate store id "${id}"`);
    }
    ids.add(id);
    const backend = row.backend;
    if (!backend || typeof backend !== 'object') {
      errors.push(`${id}: backend must be an object`);
    } else {
      const kind = String(/** @type {Record<string, unknown>} */ (backend).kind || '');
      if (!ALLOWED_BACKEND_KINDS.has(kind)) {
        errors.push(`${id}: unsupported backend.kind "${kind}"`);
      }
    }
    const writers = row.writers;
    if (!writers || typeof writers !== 'object') {
      errors.push(`${id}: writers must be an object`);
    } else {
      const w = /** @type {Record<string, unknown>} */ (writers);
      if (!Array.isArray(w.known)) {
        errors.push(`${id}: writers.known must be an array`);
      }
      if (!Array.isArray(w.unknownGaps)) {
        errors.push(`${id}: writers.unknownGaps must be an array`);
      }
    }
    for (const listKey of ['managedPaths', 'retainedPaths']) {
      const list = row[listKey];
      if (!Array.isArray(list)) {
        errors.push(`${id}: ${listKey} must be an array`);
      } else {
        for (const entry of list) {
          if (typeof entry !== 'string' || entry.includes('..')) {
            errors.push(`${id}: ${listKey} entries must be relative paths without ".."`);
          }
        }
      }
    }
    if (!Number.isFinite(Number(row.lockOrderRank))) {
      errors.push(`${id}: lockOrderRank must be a finite number`);
    }
    const marker = row.bootstrapMarker;
    if (!marker || typeof marker !== 'object') {
      errors.push(`${id}: bootstrapMarker must be an object`);
    } else {
      const m = /** @type {Record<string, unknown>} */ (marker);
      if (typeof m.path !== 'string' || m.path.length === 0 || m.path.includes('..')) {
        errors.push(`${id}: bootstrapMarker.path must be a relative path without ".."`);
      }
      if (typeof m.detect !== 'string' || m.detect.length === 0) {
        errors.push(`${id}: bootstrapMarker.detect must be a non-empty string`);
      }
    }
    const domainOwner = String(row.domainOwner || '');
    if (domainOwner.includes('..') || domainOwner.startsWith('/')) {
      errors.push(`${id}: domainOwner must be a repo-relative path`);
    }
  }
  for (const hintedId of lockOrderHint) {
    if (!ids.has(hintedId)) {
      errors.push(`lockOrderHint references unknown store id "${hintedId}"`);
    }
  }
  const sortedByRank = [...stores].sort(
    (left, right) =>
      Number(/** @type {Record<string, unknown>} */ (left).lockOrderRank) -
      Number(/** @type {Record<string, unknown>} */ (right).lockOrderRank)
  );
  const rankIds = sortedByRank.map((row) => String(/** @type {Record<string, unknown>} */ (row).id));
  if (lockOrderHint.join('|') !== rankIds.join('|')) {
    errors.push('lockOrderHint must match stores sorted by ascending lockOrderRank');
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, registry: doc };
}

/**
 * @param {string} [registryPath]
 * @returns {{ ok: true, registry: any, path?: string } | { ok: false, errors: string[] }}
 */
export function loadAndValidateStorageRegistry(registryPath) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const filePath = registryPath
    ? path.resolve(registryPath)
    : path.join(root, 'docs', 'storage-registry.json');
  if (!fs.existsSync(filePath)) {
    return { ok: false, errors: [`registry file not found: ${filePath}`] };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return { ok: false, errors: [`invalid JSON: ${/** @type {Error} */ (err).message}`] };
  }
  const result = validateStorageRegistry(parsed);
  if (!result.ok) {
    return result;
  }
  return { ok: true, registry: result.registry, path: filePath };
}

/**
 * @param {'managed' | 'retained' | 'control-external'} pathClass
 * @param {string} relativePath
 * @returns {boolean}
 */
export function isAllowedPathClass(pathClass, relativePath) {
  if (!ALLOWED_PATH_CLASS.has(pathClass)) {
    return false;
  }
  return relativePath.length > 0 && !relativePath.includes('..');
}
