import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { addChat, updateChat } from '../lib/persist/chats-persist.js';
import {
  patchMockChatRun,
  registerMockChatRunAdapter,
  resetMockChatRuns,
} from '../lib/chat-run/mock-adapter.js';
import { startChatRun } from '../lib/chat-run-service.js';
import '../lib/chat-archive-guard.js';

resetMockChatRuns();
registerMockChatRunAdapter('sdk');

/**
 * @param {string} id
 * @param {string} [parentId]
 */
function makeChat(id, parentId = '') {
  return addChat(`sess-${id}`, id, null, '/tmp/archive-guard', 'm', {
    id,
    agentTransport: 'sdk',
    ...(parentId ? { forkParentChatId: parentId } : {}),
  });
}

test('an idle chat can be archived', () => {
  const chat = makeChat('idle-root');
  const archived = updateChat(chat.id, { archived: true });
  assert.ok(archived?.archivedAt);
});

test('a chat with a live run cannot be archived', async () => {
  const chat = makeChat('busy-root');
  await startChatRun({ chatId: chat.id, prompt: 'still working', mode: 'agent' });
  assert.throws(
    () => updateChat(chat.id, { archived: true }),
    (err) => err?.code === 'CHAT_ARCHIVE_BUSY' && err.chatId === chat.id,
  );
  assert.equal(updateChat(chat.id, { title: 'rename while busy' })?.title, 'rename while busy');
});

test('a busy nested child blocks archiving the parent', async () => {
  const parent = makeChat('parent-idle');
  const child = makeChat('child-busy', parent.id);
  await startChatRun({ chatId: child.id, prompt: 'child working', mode: 'agent' });
  assert.throws(
    () => updateChat(parent.id, { archived: true }),
    (err) => err?.code === 'CHAT_ARCHIVE_BUSY' && err.chatId === child.id,
  );
  assert.equal(Boolean(updateChat(parent.id, { title: 'still live' })?.archivedAt), false);
});

test('a chat waiting for input cannot be archived', async () => {
  const chat = makeChat('waiting-root');
  await startChatRun({ chatId: chat.id, prompt: 'ask', mode: 'agent' });
  patchMockChatRun(chat.id, { busy: false, waitingForInput: true });
  assert.throws(
    () => updateChat(chat.id, { archived: true }),
    (err) => err?.code === 'CHAT_ARCHIVE_BUSY',
  );
});

test('restoring an archived chat is not blocked by a live sibling', async () => {
  const archived = makeChat('already-archived');
  updateChat(archived.id, { archived: true });
  const sibling = makeChat('sibling-busy');
  await startChatRun({ chatId: sibling.id, prompt: 'other', mode: 'agent' });
  const restored = updateChat(archived.id, { archived: false });
  assert.equal(restored?.archivedAt, undefined);
});
