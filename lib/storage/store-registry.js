/**
 * Versioned storage registry loader (A1 owner, B1 consumer).
 * Canonical artifact: docs/storage-registry.json
 */

import { loadAndValidateStorageRegistry, validateStorageRegistry } from './validate-storage-registry.js';

export { validateStorageRegistry, loadAndValidateStorageRegistry };

/**
 * @returns {any}
 */
export function getStorageRegistry() {
  const loaded = loadAndValidateStorageRegistry();
  if (!loaded.ok) {
    throw new Error(`storage registry invalid: ${/** @type {any} */ (loaded).errors.join('; ')}`);
  }
  return loaded.registry;
}

/**
 * @param {string} storeId
 * @returns {any | null}
 */
export function getStorageStoreById(storeId) {
  const registry = getStorageRegistry();
  const id = String(storeId || '').trim();
  const stores = /** @type {any[]} */ (registry.stores);
  return stores.find((row) => String(/** @type {Record<string, unknown>} */ (row).id) === id) || null;
}
