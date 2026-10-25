import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import {
  getChatById,
  getChatsReadStats,
  peekChats,
  saveChats,
  setChatClaudeSessionId,
  updateChat,
} from '../lib/persist/chats-persist.js';

const rows = Array.from({ length: 300 }, (_, i) => ({
  id: `c${i}`,
  title: `Chat ${i} "q"\nline`,
  cursorSessionId: `s${i}`,
  createdAt: '2026-01-01T00:00:00.000Z',
  titleSource: 'auto',
  nested: { a: [1, { b: 'x\ny' }] },
}));
const file = path.join(ISOLATED_DATA_DIR, 'chats.json');

saveChats(rows);
const held = peekChats();
const heldRow = held[7];
const before = getChatsReadStats();

updateChat('c7', { title: 'Renamed' });
setChatClaudeSessionId('c9', 'claude-1');

// Readers holding the old array/row are not mutated (copy-on-write).
assert.equal(heldRow.title, 'Chat 7 "q"\nline');
assert.equal(held[9].claudeSessionId, undefined);
// No full list copy and no re-parse on the update path.
const after = getChatsReadStats();
assert.equal(after.listCopies, before.listCopies);
assert.equal(after.parses, before.parses);
assert.equal(getChatById('c7').title, 'Renamed');
assert.equal(getChatById('c9').claudeSessionId, 'claude-1');

// The file is byte-identical to a plain full serialization of the same list.
const onDisk = fs.readFileSync(file, 'utf8');
assert.equal(onDisk, JSON.stringify({ chats: JSON.parse(onDisk).chats }, null, 2));
assert.equal(JSON.parse(onDisk).chats.length, 300);
assert.equal(JSON.parse(onDisk).chats[7].title, 'Renamed');
assert.equal(fs.readdirSync(ISOLATED_DATA_DIR).filter((f) => f.endsWith('.tmp')).length, 0);

// Returned rows are private copies.
const ret = setChatClaudeSessionId('c9', 'claude-2');
ret.title = 'mutated';
assert.notEqual(getChatById('c9').title, 'mutated');

// Empty list keeps the canonical shape.
saveChats([]);
assert.equal(updateChat('nope', { title: 'x' }), null);
console.log('ok');
