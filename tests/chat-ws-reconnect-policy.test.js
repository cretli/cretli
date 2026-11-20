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

// A pane rebuilt over a live background socket must not show `connecting` forever:
// an open socket never fires `onopen` again, so nothing would clear that status.
{
  const { resolvePaneOpenConnectionStatus } = await import('../app_front/features/chat/chatWsReconnectPolicy.js');
  assert.equal(resolvePaneOpenConnectionStatus({ ws: { readyState: 1 } }), 'connected');
  assert.equal(resolvePaneOpenConnectionStatus({ ws: { readyState: 0 } }), 'connecting');
  assert.equal(resolvePaneOpenConnectionStatus({ ws: { readyState: 3 } }), 'connecting');
  assert.equal(resolvePaneOpenConnectionStatus({ ws: null }), 'connecting');
  assert.equal(resolvePaneOpenConnectionStatus(null), 'connecting');
}
