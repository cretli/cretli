import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CRETLI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chats-index-'));
const { saveChats, loadChats, peekChats, peekChatsByIds } = await import('../lib/persist/chats-persist.js');

saveChats([{ id: 'a', title: 'A' }, { id: 'b', title: 'Chat 2' }, { id: 'c', title: 'C' }]);
assert.deepEqual(peekChatsByIds(['c', 'zzz', 'a']).map((row) => row.id), ['c', 'a']);
assert.equal(peekChats(), peekChats(), 'peek must not copy the list');
assert.notEqual(loadChats()[0], peekChats()[0], 'loadChats still returns copies');
const loaded = loadChats();
loaded[0].title = 'mutated';
assert.equal(loadChats()[0].title, 'A', 'loadChats top-level row mutations must not affect later reads');

saveChats([{ id: 'a', title: 'A' }]);
assert.deepEqual(peekChatsByIds(['a', 'b', 'c']).map((row) => row.id), ['a'], 'index follows saves');
console.log('chats-persist-index ok');
