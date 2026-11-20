import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadAndValidateStorageRegistry,
  validateStorageRegistry,
} from '../lib/storage/validate-storage-registry.js';
import { getStorageRegistry, getStorageStoreById } from '../lib/storage/store-registry.js';
import { enumerateManaged } from '../lib/backup/offline/managed-files.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

  it('describes store.chats as the marker-selected sqlite store with chats.json retained (leaf B1)', () => {
    const chats = getStorageStoreById('store.chats');
    assert.ok(chats);
    assert.equal(chats.backend.kind, 'sqlite-wal-full');
    assert.equal(chats.backend.file, 'chats.sqlite');
    assert.deepEqual(chats.bootstrapMarker, { path: 'chats-backend.json', detect: 'backend-field' });
    for (const managed of ['chats.json', 'chats.sqlite', 'chats.sqlite-wal', 'chats.sqlite-shm', 'chats-backend.json']) {
      assert.ok(chats.managedPaths.includes(managed), `managedPaths lists ${managed}`);
    }
    assert.deepEqual(chats.retainedPaths, ['chats.json']);
    assert.equal(chats.lockOrderRank, 60);
    assert.deepEqual(chats.ackClasses, ['post-commit-chat-row-cas']);
    assert.equal(chats.durability.mode, 'synchronous=FULL');
    assert.ok(chats.writers.known.some((w) => w.module === 'lib/routes/chats-routes.js'));
    assert.deepEqual(chats.writers.unknownGaps, []);
  });

  it('backs up browser policies while retaining encrypted Browser storage state', () => {
    const policy = getStorageStoreById('store.browser-policy');
    assert.ok(policy);
    assert.deepEqual(policy.managedPaths, ['browser-policy.json']);
    assert.ok(policy.retainedPaths.includes('browser-storage-state.json'));
    assert.equal(policy.adapters.migration, 'none');
    assert.match(policy.adapters.restore, /browser-storage-state\.json.*remains on destination/);

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-browser-backup-'));
    try {
      fs.writeFileSync(path.join(dataDir, 'browser-policy.json'), '{"v":1,"workspaces":{}}');
      fs.writeFileSync(path.join(dataDir, 'browser-storage-state.json'), '{"encrypted":"payload"}');
      const files = enumerateManaged(dataDir, { includeSidecars: true }).files;
      assert.deepEqual(files.filter((file) => file.rel.startsWith('browser-')), [
        { rel: 'browser-policy.json', storeId: 'store.browser-policy' },
      ]);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
  it('includes Docs state in managed backup and restore enumeration', () => {
    const store = getStorageStoreById('store.docs-state');
    assert.ok(store);
    assert.deepEqual(store.managedPaths, ['docs-state.json']);
    assert.equal(store.adapters.migration, 'none');
    assert.equal(store.lockOrderRank, 300);
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-docs-backup-'));
    try {
      fs.writeFileSync(path.join(dataDir, 'docs-state.json'), '{"v":1,"workspaces":{}}');
      assert.deepEqual(enumerateManaged(dataDir, { includeSidecars: true }).files, [
        { rel: 'docs-state.json', storeId: 'store.docs-state' },
      ]);
    } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
  });

});
