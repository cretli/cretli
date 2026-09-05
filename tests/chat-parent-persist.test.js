import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { saveChats, updateChat, loadChats } from '../lib/persist/chats-persist.js';

function seed() {
  saveChats([
    { id: 'a', title: 'A', cursorSessionId: 's-a', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'b', title: 'B', cursorSessionId: 's-b', createdAt: '2026-01-02T00:00:00.000Z' },
    { id: 'c', title: 'C', cursorSessionId: 's-c', createdAt: '2026-01-03T00:00:00.000Z' },
  ]);
}

test('updateChat nests a chat under another chat', () => {
  seed();
  const actual = updateChat('b', { forkParentChatId: 'a' });
  assert.equal(actual.forkParentChatId, 'a');
  assert.equal(loadChats().find((chat) => chat.id === 'b')?.forkParentChatId, 'a');
});

test('updateChat clears forkParentChatId when nested under null', () => {
  seed();
  updateChat('b', { forkParentChatId: 'a' });
  const actual = updateChat('b', { forkParentChatId: null });
  assert.equal(actual.forkParentChatId, undefined);
});

test('updateChat rejects nesting a chat under itself', () => {
  seed();
  assert.throws(() => updateChat('a', { forkParentChatId: 'a' }), /nested under itself/);
});

test('updateChat rejects nesting a folder under its descendant', () => {
  seed();
  updateChat('b', { forkParentChatId: 'a' });
  updateChat('c', { forkParentChatId: 'b' });
  assert.throws(() => updateChat('a', { forkParentChatId: 'c' }), /descendant/);
});
