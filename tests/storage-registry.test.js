import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadAndValidateStorageRegistry,
  validateStorageRegistry,
} from '../lib/storage/validate-storage-registry.js';
import { getStorageRegistry, getStorageStoreById } from '../lib/storage/store-registry.js';

describe('storage registry (A1)', () => {
  it('loads and validates docs/storage-registry.json', () => {
    const loaded = loadAndValidateStorageRegistry();
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    assert.ok(loaded.registry.registryVersion >= 1);
    assert.ok(Array.isArray(loaded.registry.stores));
    assert.ok(loaded.registry.stores.length >= 20);
  });

  it('rejects duplicate store ids', () => {
    const loaded = loadAndValidateStorageRegistry();
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    const broken = structuredClone(loaded.registry);
    broken.stores.push(structuredClone(broken.stores[0]));
    const result = validateStorageRegistry(broken);
    assert.equal(result.ok, false);
  });

  it('rejects path traversal in managedPaths and bootstrapMarker', () => {
    const loaded = loadAndValidateStorageRegistry();
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    const broken = structuredClone(loaded.registry);
    broken.stores[0].managedPaths.push('../escape.json');
    const badPaths = validateStorageRegistry(broken);
    assert.equal(badPaths.ok, false);
    const broken2 = structuredClone(loaded.registry);
    broken2.stores[0].bootstrapMarker = { path: '../../etc/passwd', detect: 'file-exists' };
    const badMarker = validateStorageRegistry(broken2);
    assert.equal(badMarker.ok, false);
  });

  it('rejects missing bootstrapMarker and non-numeric lockOrderRank', () => {
    const loaded = loadAndValidateStorageRegistry();
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    const broken = structuredClone(loaded.registry);
    delete broken.stores[0].bootstrapMarker;
    broken.stores[1].lockOrderRank = 'first';
    const result = validateStorageRegistry(broken);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.some((e) => e.includes('bootstrapMarker')));
      assert.ok(result.errors.some((e) => e.includes('lockOrderRank')));
    }
  });

  it('exposes getStorageStoreById for recovery and usage journal', () => {
    const recovery = getStorageStoreById('store.recovery');
    assert.ok(recovery);
    const usage = getStorageStoreById('store.usage-journal');
    assert.ok(usage);
    assert.equal(usage.backend.kind, 'jsonl-append');
    const registry = getStorageRegistry();
    assert.ok(Array.isArray(registry.inventoryGaps));
  });
});
