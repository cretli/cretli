import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  subscribeChatHistoryUpdates, unsubscribeChatHistoryUpdates, broadcastChatHistoryUpdate,
} from '../lib/sdk/sdk-history-updates.js';

function socket() {
  const messages = [];
  return Object.assign(new EventEmitter(), {
    readyState: 1, messages, send: (payload) => messages.push(JSON.parse(payload)),
  });
}
const parent = socket();
const other = socket();
subscribeChatHistoryUpdates('parent', parent);
subscribeChatHistoryUpdates('parent', parent);
subscribeChatHistoryUpdates('other', other);
broadcastChatHistoryUpdate('parent');
assert.deepEqual(parent.messages, [{ type: 'sdkHistoryChanged', records: [] }]);
assert.deepEqual(other.messages, []);
parent.emit('close');
broadcastChatHistoryUpdate('parent');
assert.equal(parent.messages.length, 1);
unsubscribeChatHistoryUpdates('other', other);
broadcastChatHistoryUpdate('other');
assert.deepEqual(other.messages, []);
console.log('sdk-history-updates.test.js OK');
