import assert from 'node:assert/strict';
import { applyChatConnectionRecovery } from '../app_front/features/chat/chatServerRecovery.js';

function createChat(id, status = 'disconnected') {
  return {
    id,
    cursorSessionId: `session-${id}`,
    _connectionStatus: status,
  };
}

const activeId = 'active-chat';
const chats = [
  createChat(activeId, 'disconnected'),
  createChat('bg-1', 'reconnecting'),
  createChat('bg-2', 'connecting'),
  createChat('bg-3', 'connected'),
];

let ensureCalls = 0;
let forceReconnectCalls = 0;
let backgroundSyncCalls = 0;
let historySyncReason = '';

applyChatConnectionRecovery(
  {
    getChats: () => chats,
    getActiveChatId: () => activeId,
    ensureChatConnection: () => {
      ensureCalls += 1;
    },
    forceReconnectChat: () => {
      forceReconnectCalls += 1;
    },
    syncBackgroundChatConnections: () => {
      backgroundSyncCalls += 1;
    },
    syncSdkHistoryOnResume: async (_chat, context = {}) => {
      historySyncReason = String(context.reason || '');
    },
    appendRecoveryNotice: () => {},
    appLogger: { log: () => {} },
  },
  { serverRestarted: false }
);

assert.equal(forceReconnectCalls, 1, 'only active chat should force reconnect');
assert.equal(ensureCalls, 0, 'background chats must not call ensureChatConnection directly');
assert.equal(backgroundSyncCalls, 1, 'background monitor should run once');
assert.equal(historySyncReason, 'backend_recovery');

ensureCalls = 0;
forceReconnectCalls = 0;
backgroundSyncCalls = 0;

applyChatConnectionRecovery(
  {
    getChats: () => chats,
    getActiveChatId: () => activeId,
    ensureChatConnection: () => {
      ensureCalls += 1;
    },
    syncSdkHistoryOnResume: async () => {},
    appendRecoveryNotice: () => {},
    appLogger: { log: () => {} },
  },
  { serverRestarted: true }
);

assert.equal(forceReconnectCalls, 0);
assert.equal(ensureCalls, 1, 'active chat falls back to ensureChatConnection without forceReconnect');
assert.equal(backgroundSyncCalls, 0);

console.log('All chat-server-recovery tests passed.');
