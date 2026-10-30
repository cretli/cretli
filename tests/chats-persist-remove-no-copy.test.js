import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-chats-remove-'));
process.env.CRETLI_DATA_DIR = dir;
const chats = await import('../lib/persist/chats-persist.js');

test('removeChat skips the per-call list copy and keeps cache and file consistent', () => {
  const a = chats.addChat('s-a', 'Chat A', '', dir);
  const b = chats.addChat('s-b', 'Chat B', '', dir);
  const held = chats.loadChats();
  const before = chats.getChatsReadStats().listCopies;
  for (let i = 0; i < 5; i += 1) chats.removeChat(`missing-${i}`);
  assert.equal(chats.getChatsReadStats().listCopies, before, 'filter-only writer must not copy the list');
  chats.removeChat(a.id);
  assert.equal(chats.getChatsReadStats().listCopies, before);
  assert.deepEqual(chats.loadChats().map((c) => c.id), [b.id]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'chats.json'), 'utf8')).chats.map((c) => c.id), [b.id]);
  // A list handed out earlier is unaffected by the removal.
  assert.equal(held.length, 2);
});

test('mutating a loadChats() result still cannot corrupt the cache', () => {
  const [row] = chats.loadChats();
  row.title = 'mutated by caller';
  assert.notEqual(chats.loadChats()[0].title, 'mutated by caller');
});
