/** Sending from an archived chat restores it first and resends the kept draft. */
import assert from 'node:assert/strict';
import { restoreChatAndResend } from '../app_front/features/chat/chatArchivedSend.js';

function makeChat(readyState = 1) {
  const chat = { id: 'c', ws: { readyState }, submits: 0 };
  chat.pane = { _sendBar: { submit: () => { chat.submits += 1; } } };
  return chat;
}
const deps = (over = {}) => ({
  confirmRestore: async () => true,
  restoreChat: async () => true,
  ensureConnection: () => {},
  sleep: async () => {},
  ...over,
});

{
  const chat = makeChat();
  assert.equal(await restoreChatAndResend(chat, deps()), true);
  assert.equal(chat.submits, 1);
}
{
  const chat = makeChat();
  let restored = 0;
  const result = await restoreChatAndResend(chat, deps({
    confirmRestore: async () => false,
    restoreChat: async () => { restored += 1; return true; },
  }));
  assert.equal(result, false, 'cancel keeps the draft and the archive');
  assert.equal(restored, 0);
  assert.equal(chat.submits, 0);
}
{
  const chat = makeChat();
  assert.equal(await restoreChatAndResend(chat, deps({ restoreChat: async () => false })), false);
  assert.equal(chat.submits, 0);
}
{
  const chat = makeChat(0);
  await restoreChatAndResend(chat, deps({
    ensureConnection: (target) => { target.ws = { readyState: 0 }; },
    sleep: async () => { chat.ws.readyState = 1; },
  }));
  assert.equal(chat.submits, 1, 'the resend waits for the socket');
}
{
  const chat = makeChat();
  let release;
  const first = restoreChatAndResend(chat, deps({
    confirmRestore: () => new Promise((resolve) => { release = resolve; }),
  }));
  assert.equal(await restoreChatAndResend(chat, deps()), false, 'a second Send opens no second dialog');
  release(true);
  await first;
  assert.equal(chat.submits, 1);
}

console.log('chat-archived-send ok');
