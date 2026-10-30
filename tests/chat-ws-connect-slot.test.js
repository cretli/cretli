/**
 * The chat WebSocket connect cap bounds parallel handshakes, not open sockets.
 *
 * Regression: the slot was only released on close, so once the cap's worth of
 * background chats had open sockets every other background chat stayed queued
 * as `reconnecting` forever and its sidebar row kept the `connecting` spinner.
 */
import assert from 'node:assert/strict';

import { createChatTransport } from '../app_front/features/chat/chatTransport.js';
import { resolveMaxConcurrentWsConnects } from '../app_front/features/chat/chatWsReconnectPolicy.js';
import {
  CHAT_PING_INTERVAL_MS,
  CHAT_RECONNECT_DELAYS,
  CHAT_RECONNECT_MAX,
  WS_PATH_AGENT_SDK,
} from '../app_front/config.js';

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  /** @type {FakeWebSocket[]} */
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    FakeWebSocket.instances.push(this);
  }
  send() {}
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1000, reason: '', wasClean: true });
  }
}

globalThis.WebSocket = FakeWebSocket;
if (!globalThis.location) {
  globalThis.location = { protocol: 'http:', host: '127.0.0.1:3011' };
}

const cap = resolveMaxConcurrentWsConnects();
const chats = Array.from({ length: cap + 2 }, (_, index) => ({
  id: 'bg-' + index,
  cursorSessionId: 'sess-bg-' + index,
  agentTransport: 'sdk',
}));
const noop = () => {};
const transport = createChatTransport({
  WS_PATH_AGENT_SDK,
  CHAT_RECONNECT_MAX,
  CHAT_RECONNECT_DELAYS,
  CHAT_PING_INTERVAL_MS,
  getChats: () => chats,
  // No active chat: every chat goes through the cap.
  getActiveChatId: () => null,
  getMaintainSessionsEnabled: () => false,
  getChatActivityAt: () => Date.now(),
  getSkipCatchUpOnResume: () => false,
  appLogger: { log() {} },
  setChatStatus: noop,
  setAgentState: noop,
  renderChatTerminalState: noop,
  buildCatchUpSignature: () => '',
  processAgentOutput: noop,
  processAgentOutputCatchUp: noop,
  updateAwaitingInput: noop,
  setLaunchCommand: noop,
  scrollChatTerminalToBottom: noop,
});

// Fill the cap with handshakes that are still in flight.
for (let index = 0; index < cap; index += 1) transport.ensureChatConnection(chats[index]);
assert.equal(FakeWebSocket.instances.length, cap);

const waiting = chats[cap];
transport.ensureChatConnection(waiting);
assert.equal(FakeWebSocket.instances.length, cap, 'a handshake beyond the cap is deferred');
assert.equal(waiting._connectionStatus, 'reconnecting');

// Finished handshakes free their slots even though the sockets stay open.
for (const socket of FakeWebSocket.instances.slice()) socket.open();
transport.ensureChatConnection(waiting);
assert.equal(FakeWebSocket.instances.length, cap + 1, 'open sockets must not hold the connect cap');
assert.equal(waiting._connectionStatus, 'connecting');

const last = chats[cap + 1];
FakeWebSocket.instances[cap].open();
transport.ensureChatConnection(last);
assert.equal(FakeWebSocket.instances.length, cap + 2);

// `last` still holds one slot. Closing already-open sockets must not release again,
// so exactly cap - 1 more handshakes fit.
FakeWebSocket.instances[0].close();
FakeWebSocket.instances[1].close();
const extras = Array.from({ length: cap }, (_, index) => ({
  id: 'extra-' + index,
  cursorSessionId: 'sess-extra-' + index,
  agentTransport: 'sdk',
}));
chats.push(...extras);
for (const extra of extras) transport.ensureChatConnection(extra);
assert.deepEqual(
  extras.map((extra) => extra._connectionStatus),
  [...Array(cap - 1).fill('connecting'), 'reconnecting'],
  'closing open sockets must not over-release the cap',
);

transport.stopChatBackgroundMonitor?.();
console.log('chat-ws-connect-slot.test.js: ok');
process.exit(0);
