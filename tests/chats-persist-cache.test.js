import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadChats, saveChats } from '../lib/persist/chats-persist.js';

const originalRead = fs.readFileSync;
let chatFileReads = 0;
fs.readFileSync = function readFileSyncCounting(file, ...args) {
  if (String(file).endsWith('chats.json')) chatFileReads += 1;
  return originalRead.call(this, file, ...args);
};

const row = {
  id: '1',
  title: 'One',
  cursorSessionId: 's',
  createdAt: '2026-01-01T00:00:00.000Z',
};

try {
  saveChats([row]);
  chatFileReads = 0;
  const first = loadChats();
  const second = loadChats();
  assert.equal(chatFileReads, 1);
  assert.equal(first[0].title, 'One');
  assert.equal(second[0].title, 'One');
  first[0].title = 'mutated';
  assert.equal(loadChats()[0].title, 'One');
  assert.equal(chatFileReads, 1);
  saveChats([{ ...row, title: 'Two' }]);
  chatFileReads = 0;
  assert.equal(loadChats()[0].title, 'Two');
  assert.equal(chatFileReads, 1);
  console.log('chats-persist-cache.test.js ok');
} finally {
  fs.readFileSync = originalRead;
}
