import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildConversationForkPrompt } from '../lib/conversation-fork.js';
import {
  appendChatHistoryEvents,
  copyChatHistory,
  deleteChatHistory,
  loadChatHistory,
} from '../lib/persist/chat-history-persist.js';

const prompt = buildConversationForkPrompt('User: start\nAgent: reply', 'Continue here');
assert.match(prompt, /CONVERSATION FORK CONTEXT/);
assert.match(prompt, /User: start/);
assert.match(prompt, /Continue here$/);
assert.equal(buildConversationForkPrompt('', 'New message'), 'New message');

const sourceChatId = randomUUID();
const targetChatId = randomUUID();
try {
  appendChatHistoryEvents(sourceChatId, 'source-session', [
    {
      rec: {
        kind: 'localUser',
        text: 'First message',
        createdAt: new Date().toISOString(),
      },
      clientSeq: 1,
    },
  ]);
  const result = copyChatHistory(sourceChatId, targetChatId, 'target-session');
  assert.equal(result.ok, true);
  const target = loadChatHistory(targetChatId);
  assert.equal(target?.chatId, targetChatId);
  assert.equal(target?.cursorSessionId, 'target-session');
  assert.equal(target?.events.length, 1);
  assert.equal(target?.events[0]?.rec?.text, 'First message');
  assert.equal(target?.events[0]?.rec?.clientSeq, undefined);
} finally {
  deleteChatHistory(sourceChatId);
  deleteChatHistory(targetChatId);
}

console.log('All conversation fork tests passed.');
