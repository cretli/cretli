import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  appendRelatedChatHistoryLinks,
  parseRelatedChatPayload,
} from '../lib/chat-relation-history.js';
import { executeConversationFork } from '../lib/conversation-fork-execute.js';
import { isValidSdkHistoryRecord } from '../lib/persist/chat-history-validate.js';
import { appendChatHistoryEvents, loadChatHistory } from '../lib/persist/chat-history-persist.js';
import { addChat, saveChats, updateChat, loadChats } from '../lib/persist/chats-persist.js';

function relatedEvents(chatId, role) {
  return (loadChatHistory(chatId)?.events || []).filter((row) => {
    if (row.rec?.variant !== 'relatedChat') return false;
    const data = parseRelatedChatPayload(row.rec.payload);
    return data?.role === role;
  });
}

assert.equal(
  isValidSdkHistoryRecord({ kind: 'meta', variant: 'relatedChat', payload: '{}' }),
  true,
);
assert.equal(parseRelatedChatPayload('{"role":"child","chatId":"abc"}')?.role, 'child');
assert.equal(parseRelatedChatPayload({ role: 'parent', chatId: 'p1', title: 'Plan' })?.title, 'Plan');
assert.equal(parseRelatedChatPayload({ role: 'other', chatId: 'x' }), null);

const parent = addChat('sess-parent', 'Planner', null, '/tmp/ws', 'm', {
  agentTransport: 'opencode',
});
const child = addChat('sess-child', 'Executor', null, '/tmp/ws', 'm', {
  agentTransport: 'sdk',
  forkParentChatId: parent.id,
  forkKind: 'delegation',
});
const first = appendRelatedChatHistoryLinks({
  parentChat: parent,
  childChat: child,
  reason: 'delegation',
});
assert.equal(first.ok, true);
assert.equal(relatedEvents(parent.id, 'child').length, 1);
assert.equal(relatedEvents(child.id, 'parent').length, 1);
const childPayload = parseRelatedChatPayload(relatedEvents(parent.id, 'child')[0].rec.payload);
assert.equal(childPayload.chatId, child.id);
assert.equal(childPayload.title, 'Executor');
const parentPayload = parseRelatedChatPayload(relatedEvents(child.id, 'parent')[0].rec.payload);
assert.equal(parentPayload.chatId, parent.id);
assert.equal(parentPayload.title, 'Planner');

appendRelatedChatHistoryLinks({
  parentChat: parent,
  childChat: child,
  reason: 'delegation',
});
assert.equal(relatedEvents(parent.id, 'child').length, 1);
assert.equal(relatedEvents(child.id, 'parent').length, 1);

const tempChild = addChat('sess-temp', '[Temp] Summary', null, '/tmp/ws', 'm', {
  isTemporary: true,
  forkParentChatId: parent.id,
  forkKind: 'summary',
});
assert.equal(appendRelatedChatHistoryLinks({
  parentChat: parent,
  childChat: tempChild,
  reason: 'summary',
}).ok, false);
assert.equal(relatedEvents(parent.id, 'child').length, 1);

const forkParentId = randomUUID();
saveChats([
  ...loadChats().filter((row) => row.id !== forkParentId),
  {
    id: forkParentId,
    title: 'Ask',
    cursorSessionId: 'fork-parent-session',
    agentTransport: 'sdk',
    model: 'grok-4.6',
    workspaceFolder: '/tmp/ws',
    createdAt: new Date().toISOString(),
  },
]);
const forkParent = loadChats().find((row) => row.id === forkParentId);
appendChatHistoryEvents(forkParent.id, forkParent.cursorSessionId, [
  { rec: { kind: 'localUser', text: 'hello from parent' } },
]);
const forked = await executeConversationFork({
  parentChat: forkParent,
  message: 'continue',
});
const parentChildLinks = relatedEvents(forkParent.id, 'child');
assert.equal(parentChildLinks.length, 1);
assert.equal(parseRelatedChatPayload(parentChildLinks[0].rec.payload).chatId, forked.chat.id);
const childParentLinks = relatedEvents(forked.chat.id, 'parent');
assert.equal(childParentLinks.length, 1);
assert.equal(parseRelatedChatPayload(childParentLinks[0].rec.payload).chatId, forkParent.id);
const selfLinks = (loadChatHistory(forked.chat.id)?.events || []).filter((row) => {
  const data = parseRelatedChatPayload(row.rec?.payload);
  return row.rec?.variant === 'relatedChat' && data?.role === 'child' && data.chatId === forked.chat.id;
});
assert.equal(selfLinks.length, 0);
assert.equal(
  (loadChatHistory(forked.chat.id)?.events || []).some((row) => row.rec?.kind === 'localUser'),
  true,
);

const nestParent = addChat('sess-nest-parent', 'Folder', null, '/tmp/ws', 'm');
const nestChild = addChat('sess-nest-child', 'Leaf', null, '/tmp/ws', 'm');
updateChat(nestChild.id, { forkParentChatId: nestParent.id });
appendRelatedChatHistoryLinks({
  parentChat: loadChats().find((row) => row.id === nestParent.id),
  childChat: loadChats().find((row) => row.id === nestChild.id),
  reason: 'nested',
});
assert.equal(relatedEvents(nestParent.id, 'child').length, 1);
assert.equal(relatedEvents(nestChild.id, 'parent').length, 1);

console.log('chat-relation-history.test.js OK');
