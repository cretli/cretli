import assert from 'node:assert/strict';
import {
  armContextCompressionWatchdog,
  clearContextCompressionFlags,
  CONTEXT_COMPRESSION_WATCHDOG_MS,
  disarmContextCompressionWatchdog,
  initChatContextCompressionRecovery,
  isPendingContextCompressionChat,
  recoverChatAfterCompressionFailure,
} from '../app_front/features/chat/chatContextCompressionRecovery.js';

const events = [];

initChatContextCompressionRecovery({
  setAgentState(chat, state) {
    chat._agentState = state;
    events.push(['state', chat.id, state]);
  },
  ensureChatConnection(chat) {
    events.push(['ensure', chat.id]);
  },
  syncBackgroundChatConnections() {
    events.push(['sync']);
  },
  forceReconnectChat(chat) {
    events.push(['reconnect', chat.id]);
  },
  appLogger: {
    log(...args) {
      events.push(['log', ...args]);
    },
  },
});

const chat = {
  id: 'chat-1',
  _contextCompressionRunning: true,
  _autoContextCompressionPending: true,
  _sdkServerBusy: true,
  _sdkServerQueuedCount: 2,
  _sdkRichView: {
    appendMetaNotice(message) {
      events.push(['notice', message]);
    },
  },
};

assert.equal(isPendingContextCompressionChat(chat), true);
clearContextCompressionFlags(chat);
assert.equal(isPendingContextCompressionChat(chat), false);

recoverChatAfterCompressionFailure(chat, 'summary_failed');
assert.equal(chat._sdkServerBusy, false);
assert.equal(chat._sdkServerQueuedCount, 0);
assert.equal(chat._agentState, 'idle');
assert.ok(events.some((entry) => entry[0] === 'reconnect' && entry[1] === 'chat-1'));

const watchdogChat = {
  id: 'chat-watchdog',
  _contextCompressionRunning: true,
  _sdkRichView: { appendMetaNotice() {} },
};
armContextCompressionWatchdog(watchdogChat);
assert.equal(typeof CONTEXT_COMPRESSION_WATCHDOG_MS, 'number');
disarmContextCompressionWatchdog(watchdogChat);

console.log('chat-context-compression-recovery.test.js: ok');
