import assert from 'node:assert/strict';
import {
  SDK_ERROR_CHAT_NOT_FOUND,
  buildSdkChatNotFoundPayload,
  isSdkChatGoneErrorCode,
  notifySdkClientsChatGone,
  sendSdkChatNotFoundAndClose,
} from '../lib/sdk/sdk-ws-chat-gone.js';

assert.equal(isSdkChatGoneErrorCode(SDK_ERROR_CHAT_NOT_FOUND), true);
assert.equal(isSdkChatGoneErrorCode('invalid_session'), false);
assert.equal(isSdkChatGoneErrorCode(''), false);

const payload = buildSdkChatNotFoundPayload('No SDK chat found for this session.');
assert.equal(payload.type, 'sdkError');
assert.equal(payload.code, SDK_ERROR_CHAT_NOT_FOUND);
assert.equal(payload.message, 'No SDK chat found for this session.');

const sent = [];
const closed = [];
const mockWs = {
  readyState: 1,
  send(raw) {
    sent.push(JSON.parse(raw));
  },
  close() {
    closed.push(true);
  },
};

sendSdkChatNotFoundAndClose(mockWs, 'gone');
assert.equal(sent.length, 1);
assert.equal(sent[0].code, SDK_ERROR_CHAT_NOT_FOUND);
assert.equal(sent[0].message, 'gone');
assert.equal(closed.length, 1);

const secondSent = [];
const secondClosed = [];
notifySdkClientsChatGone(
  [
    {
      readyState: 1,
      send(raw) {
        secondSent.push(JSON.parse(raw));
      },
      close() {
        secondClosed.push(true);
      },
    },
  ],
  'deleted'
);
assert.equal(secondSent[0].code, SDK_ERROR_CHAT_NOT_FOUND);
assert.equal(secondClosed.length, 1);

console.log('sdk-ws-chat-gone.test.js: ok');
