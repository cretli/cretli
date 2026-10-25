import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import { getChatByCursorSessionId, getChatById, getChatsReadStats, loadChats, saveChats } from '../lib/persist/chats-persist.js';

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
  // Row lookup: shared cache, copy isolation, no re-read.
  chatFileReads = 0;
  const found = getChatByCursorSessionId('s');
  found.title = 'mutated';
  assert.equal(getChatByCursorSessionId('s').title, 'Two');
  assert.equal(getChatByCursorSessionId('missing'), null);
  assert.equal(chatFileReads, 0);
  // Id lookup: no list copy, no parse, private row copy.
  const before = getChatsReadStats();
  for (let i = 0; i < 100; i += 1) getChatById('1');
  const after = getChatsReadStats();
  assert.equal(after.parses, before.parses);
  assert.equal(after.listCopies, before.listCopies);
  assert.equal(after.hits - before.hits, 100);
  const byId = getChatById('1');
  byId.title = 'mutated';
  assert.equal(getChatById('1').title, 'Two');
  assert.equal(getChatById('nope'), null);
  // External change (size differs) invalidates the cache.
  const file = path.join(ISOLATED_DATA_DIR, 'chats.json');
  fs.writeFileSync(file, JSON.stringify({ chats: [{ ...row, title: 'External edit' }] }));
  chatFileReads = 0;
  assert.equal(loadChats()[0].title, 'External edit');
  assert.equal(chatFileReads, 1);
  console.log('chats-persist-cache.test.js ok');
} finally {
  fs.readFileSync = originalRead;
}
