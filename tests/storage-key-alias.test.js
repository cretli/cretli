import assert from 'node:assert/strict';
import {
  cleanupLegacyStorageAliases,
  readStorageValueWithAlias,
  removeStorageValueWithAlias,
  writeStorageValueWithAlias,
} from '../app_front/lib/storageKeyAlias.js';

function createStorage() {
  const map = new Map();
  return {
    get length() {
      return map.size;
    },
    key(index) {
      const keys = Array.from(map.keys());
      return typeof keys[index] === 'string' ? keys[index] : null;
    },
    getItem(key) {
      return map.has(String(key)) ? map.get(String(key)) : null;
    },
    setItem(key, value) {
      map.set(String(key), String(value));
    },
    removeItem(key) {
      map.delete(String(key));
    },
    debugMap() {
      return new Map(map);
    },
  };
}

{
  const storage = createStorage();
  storage.setItem('cursor-remote-theme', 'light');
  assert.equal(readStorageValueWithAlias(storage, 'cursor-remote-theme', 'dark'), 'light');
}

{
  const storage = createStorage();
  writeStorageValueWithAlias(storage, 'cursor-remote-theme', 'dark');
  assert.equal(storage.getItem('cretli-theme'), 'dark');
  assert.equal(
    storage.getItem('cursor-remote-theme'),
    null,
    'write should not create legacy alias when legacy key was missing'
  );
}

{
  const storage = createStorage();
  storage.setItem('cursor-remote-theme', 'light');
  writeStorageValueWithAlias(storage, 'cursor-remote-theme', 'dark');
  assert.equal(storage.getItem('cretli-theme'), 'dark');
  assert.equal(storage.getItem('cursor-remote-theme'), 'dark');
}

{
  const storage = createStorage();
  storage.setItem('cretli-theme', 'dark');
  storage.setItem('cursor-remote-theme', 'dark');
  storage.setItem('cretli-lang', 'pl');
  storage.setItem('cursor-remote-lang', 'en');
  const result = cleanupLegacyStorageAliases(storage);
  assert.equal(result.removed, 1);
  assert.equal(storage.getItem('cursor-remote-theme'), null);
  assert.equal(storage.getItem('cursor-remote-lang'), 'en');
}

{
  const storage = createStorage();
  writeStorageValueWithAlias(storage, 'cursor-remote-theme', 'dark');
  storage.setItem('cursor-remote-theme', 'dark');
  removeStorageValueWithAlias(storage, 'cursor-remote-theme');
  assert.equal(storage.getItem('cretli-theme'), null);
  assert.equal(storage.getItem('cursor-remote-theme'), null);
}

console.log('All storage-key-alias tests passed.');
