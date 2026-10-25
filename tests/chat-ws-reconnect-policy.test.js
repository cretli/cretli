import assert from 'node:assert/strict';
import {
  canOpenChatWebSocketNow,
  resolveBackgroundReconnectBatchDelayMs,
  resolveBackgroundReconnectBatchSize,
  resolveMaxConcurrentWsConnects,
} from '../app_front/features/chat/chatWsReconnectPolicy.js';

assert.equal(resolveBackgroundReconnectBatchSize(false), 2);
assert.equal(resolveBackgroundReconnectBatchSize(true), 1);
assert.equal(resolveBackgroundReconnectBatchDelayMs(false), 400);
assert.equal(resolveBackgroundReconnectBatchDelayMs(true), 900);
assert.ok(resolveMaxConcurrentWsConnects() >= 1);
assert.equal(canOpenChatWebSocketNow(99, true), true);
assert.equal(canOpenChatWebSocketNow(resolveMaxConcurrentWsConnects(), false), false);
assert.equal(canOpenChatWebSocketNow(resolveMaxConcurrentWsConnects() - 1, false), true);

console.log('chat-ws-reconnect-policy.test.js: ok');
