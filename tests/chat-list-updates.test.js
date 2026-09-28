import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import {
  subscribeChatListUpdates,
  unsubscribeChatListUpdates,
  broadcastChatListChanged,
  sendChatListClientMessage,
  __clearChatListUpdateClientsForTest,
} from '../lib/chat-list-updates.js';
import { addChat, deleteChat, saveChats, updateChat } from '../lib/persist/chats-persist.js';
import { resolveDataPath } from '../lib/runtime-paths.js';

function socket() {
  const messages = [];
  return Object.assign(new EventEmitter(), {
    readyState: 1,
    bufferedAmount: 0,
    messages,
    send: (payload) => messages.push(JSON.parse(payload)),
  });
}

__clearChatListUpdateClientsForTest();

const viewer = socket();
const duplicate = viewer;
const closed = socket();
subscribeChatListUpdates(viewer);
subscribeChatListUpdates(duplicate);
subscribeChatListUpdates(closed);
broadcastChatListChanged({ reason: 'archive', chatId: 'aaa' });
assert.deepEqual(viewer.messages, [{ type: 'chatsChanged', reason: 'archive', chatId: 'aaa' }]);
assert.equal(closed.messages.length, 1);
viewer.emit('close');
broadcastChatListChanged({ reason: 'restore' });
assert.equal(viewer.messages.length, 1);
assert.equal(closed.messages.at(-1).reason, 'restore');
unsubscribeChatListUpdates(closed);
broadcastChatListChanged();
assert.equal(closed.messages.length, 2);

const widget = socket();
const session = socket();
subscribeChatListUpdates(widget, { kind: 'widget', chatIds: ['own'] });
subscribeChatListUpdates(session, { kind: 'session' });
broadcastChatListChanged({ reason: 'title', chatId: 'foreign' });
assert.equal(widget.messages.at(-1).type, 'chatsChanged');
assert.equal(session.messages.at(-1).type, 'chatsChanged');
widget.bufferedAmount = 3_000_000;
assert.equal(sendChatListClientMessage(widget, '{"type":"agentPresence"}'), false);
assert.equal(sendChatListClientMessage(session, '{"type":"agentPresence"}'), true);

const dataFile = resolveDataPath('chats.json');
const backup = fs.existsSync(dataFile) ? fs.readFileSync(dataFile, 'utf8') : null;
try {
  __clearChatListUpdateClientsForTest();
  const live = socket();
  subscribeChatListUpdates(live);
  saveChats([
    {
      id: 'list-live-1',
      title: 'Keep',
      cursorSessionId: 'sess-live-1',
      createdAt: '2026-09-19T00:00:00.000Z',
    },
  ]);
  const created = addChat('sess-live-2', 'Created child', '', process.cwd(), 'auto', {
    delegationParentChatId: 'list-live-1',
    delegationId: 'delegation-live-1',
    delegationAssignment: 'review',
  });
  assert.deepEqual(live.messages.at(-1), {
    type: 'chatsChanged',
    reason: 'create',
    chatId: created.id,
  });
  live.messages.length = 0;
  updateChat('list-live-1', { model: 'auto' });
  assert.equal(live.messages.length, 0, 'model patch must not refresh the sidebar');
  updateChat('list-live-1', { archived: true });
  assert.deepEqual(live.messages.at(-1), {
    type: 'chatsChanged',
    reason: 'archive',
    chatId: 'list-live-1',
  });
  updateChat('list-live-1', { archived: false });
  assert.equal(live.messages.at(-1).reason, 'restore');
  deleteChat('list-live-1');
  assert.equal(live.messages.at(-1).reason, 'delete');
} finally {
  __clearChatListUpdateClientsForTest();
  if (backup == null) {
    if (fs.existsSync(dataFile)) fs.unlinkSync(dataFile);
  } else {
    fs.writeFileSync(dataFile, backup);
  }
}

console.log('chat-list-updates.test.js OK');
