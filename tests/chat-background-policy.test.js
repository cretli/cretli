import assert from 'node:assert/strict';
import {
  isLiveAgentChat,
  isListedChat,
  isRecentlyActiveChat,
  isPendingSummaryForkChat,
  resolveBackgroundMonitorMode,
  selectBackgroundWsChatIds,
  selectMonitoredChatIds,
  selectHistoryHttpChatIds,
  shouldKeepChatSocket,
  shouldSkipBackgroundHistoryHttp,
  capHistoryHttpJobs,
} from '../app_front/features/chat/chatBackgroundPolicy.js';
import {
  resolveBackgroundHttpBatchDelayMs,
  resolveBackgroundHttpBatchSize,
  resolveBackgroundHttpMaxConcurrent,
} from '../app_front/features/chat/chatWsReconnectPolicy.js';
import { CHAT_BACKGROUND_MONITOR_WINDOW_MS } from '../app_front/config.js';

const now = 1_000_000;
const getChatActivityAt = (chat) => chat.activityAt;

assert.equal(
  isRecentlyActiveChat({ cursorSessionId: 's1', activityAt: now - 1000 }, getChatActivityAt, now),
  true,
  'Recent activity should be monitored'
);

assert.equal(
  isRecentlyActiveChat(
    { cursorSessionId: 's1', activityAt: now - CHAT_BACKGROUND_MONITOR_WINDOW_MS - 1 },
    getChatActivityAt,
    now
  ),
  false,
  'Stale activity should not be monitored'
);

const chats = [
  { id: 'active', cursorSessionId: 'a', activityAt: now - 1000 },
  { id: 'bg-1', cursorSessionId: 'b1', activityAt: now - 2000 },
  { id: 'bg-2', cursorSessionId: 'b2', activityAt: now - 3000 },
  { id: 'bg-3', cursorSessionId: 'b3', activityAt: now - 4000 },
  { id: 'bg-4', cursorSessionId: 'b4', activityAt: now - 5000 },
  { id: 'bg-5', cursorSessionId: 'b5', activityAt: now - 6000 },
  { id: 'old', cursorSessionId: 'old', activityAt: now - CHAT_BACKGROUND_MONITOR_WINDOW_MS - 1 },
];

const wsChatIds = selectBackgroundWsChatIds(chats, () => 'active', getChatActivityAt, now);
assert.equal(wsChatIds.size, 5, 'Active chat plus 4 background WS slots');
assert.ok(wsChatIds.has('active'));
assert.ok(wsChatIds.has('bg-1'));
assert.ok(!wsChatIds.has('bg-5'));
assert.ok(!wsChatIds.has('old'));

const monitoredChatIds = selectMonitoredChatIds(chats, () => 'active', getChatActivityAt, now);
assert.equal(monitoredChatIds.size, 6, 'All recent chats except stale one should be monitored');
assert.ok(monitoredChatIds.has('bg-5'));
assert.ok(!monitoredChatIds.has('old'));

assert.equal(
  resolveBackgroundMonitorMode({ id: 'active' }, wsChatIds, monitoredChatIds, 'active'),
  'ws-active'
);
assert.equal(
  resolveBackgroundMonitorMode({ id: 'bg-5' }, wsChatIds, monitoredChatIds, 'active'),
  'poll'
);
assert.equal(
  resolveBackgroundMonitorMode({ id: 'old' }, wsChatIds, monitoredChatIds, 'active'),
  'none'
);

const summaryForkChats = [
  { id: 'active', cursorSessionId: 'a', activityAt: now - 1000 },
  {
    id: 'summary-fork',
    cursorSessionId: 'sf',
    activityAt: now - CHAT_BACKGROUND_MONITOR_WINDOW_MS - 1000,
    isTemporary: true,
    forkKind: 'summary',
  },
];
const summaryForkWsIds = selectBackgroundWsChatIds(
  summaryForkChats,
  () => 'active',
  getChatActivityAt,
  now
);
assert.ok(
  summaryForkWsIds.has('summary-fork'),
  'Pending summary fork chat should keep WS even without recent activity'
);
assert.equal(isPendingSummaryForkChat(summaryForkChats[1]), true);
assert.equal(isPendingSummaryForkChat({ id: 'x', cursorSessionId: 's', forkKind: 'title' }), false);

const compressionChats = [
  { id: 'active', cursorSessionId: 'a', activityAt: now - 1000 },
  {
    id: 'compressing',
    cursorSessionId: 'c',
    activityAt: now - CHAT_BACKGROUND_MONITOR_WINDOW_MS - 1000,
    _contextCompressionRunning: true,
  },
];
const compressionWsIds = selectBackgroundWsChatIds(
  compressionChats,
  () => 'active',
  getChatActivityAt,
  now
);
assert.ok(
  compressionWsIds.has('compressing'),
  'Chat waiting for context compression should keep WS'
);

const liveAgentChats = [
  { id: 'active', cursorSessionId: 'a', activityAt: now - 1000 },
  {
    id: 'working',
    cursorSessionId: 'w',
    activityAt: now - CHAT_BACKGROUND_MONITOR_WINDOW_MS - 1000,
    _agentState: 'active',
  },
  {
    id: 'busy',
    cursorSessionId: 'b',
    activityAt: now - CHAT_BACKGROUND_MONITOR_WINDOW_MS - 1000,
    _sdkServerBusy: true,
  },
];
const liveAgentWsIds = selectBackgroundWsChatIds(
  liveAgentChats,
  () => 'active',
  getChatActivityAt,
  now
);
assert.ok(liveAgentWsIds.has('working'), 'Active-agent chat should keep WS without recent activity');
assert.ok(liveAgentWsIds.has('busy'), 'Busy harness chat should keep WS without recent activity');
const liveAgentMonitoredIds = selectMonitoredChatIds(
  liveAgentChats,
  () => 'active',
  getChatActivityAt,
  now
);
assert.ok(liveAgentMonitoredIds.has('working'), 'Active-agent chat should stay monitored');
assert.ok(liveAgentMonitoredIds.has('busy'), 'Busy harness chat should stay monitored');
assert.equal(
  isLiveAgentChat(liveAgentChats[1]),
  true,
  'Chat with _agentState=active is a live agent chat'
);
assert.equal(
  isLiveAgentChat({ id: 'x', cursorSessionId: 's', _agentState: 'idle' }),
  false
);

assert.equal(isListedChat(chats, 'active'), true);
assert.equal(isListedChat(chats, 'missing'), false);
assert.equal(
  shouldKeepChatSocket({ id: 'active' }, chats),
  true,
  'Listed chat should keep the socket'
);
assert.equal(
  shouldKeepChatSocket({ id: 'active', _remoteDeleted: true }, chats),
  false,
  'Remotely deleted chat must not reconnect'
);
assert.equal(
  shouldKeepChatSocket({ id: 'ghost' }, chats),
  false,
  'Chat missing from the list must not reconnect'
);

const staleActiveWsIds = selectBackgroundWsChatIds(chats, () => 'deleted-elsewhere', getChatActivityAt, now);
assert.equal(
  staleActiveWsIds.has('deleted-elsewhere'),
  false,
  'Active id that is no longer in the list must not keep a WS slot'
);

assert.ok(
  resolveBackgroundHttpMaxConcurrent(true) >= 1,
  'Mobile HTTP queue must stay above 0 (backgroundWsMax is 0)'
);
assert.ok(resolveBackgroundHttpMaxConcurrent(false) >= 1);
assert.ok(resolveBackgroundHttpBatchSize(true) >= 1);
assert.ok(resolveBackgroundHttpBatchDelayMs(true) >= 0);
assert.equal(
  shouldSkipBackgroundHistoryHttp({ monitorMode: 'ws-active', hasPendingDelegation: false }),
  true
);
assert.equal(
  shouldSkipBackgroundHistoryHttp({ monitorMode: 'ws-active', hasPendingDelegation: true }),
  false
);

const httpIds = selectHistoryHttpChatIds(monitoredChatIds, chats, {
  activeChatId: 'active',
  visibleChatIds: new Set(['bg-1']),
});
assert.equal(httpIds.has('active'), true);
assert.equal(httpIds.has('bg-1'), true);
assert.equal(httpIds.has('bg-5'), false);

const emptyVisibleIds = selectHistoryHttpChatIds(monitoredChatIds, chats, {
  activeChatId: 'active',
  visibleChatIds: new Set(),
});
assert.equal(emptyVisibleIds.has('active'), true);
assert.equal(emptyVisibleIds.has('bg-1'), false, 'empty sidebar snapshot must not dump the full monitor set');
assert.equal(emptyVisibleIds.has('bg-5'), false);

const busyChats = [
  ...chats,
  {
    id: 'busy',
    cursorSessionId: 'bz',
    activityAt: now,
    _serverRunState: { state: 'busy' },
  },
];
const busyMonitored = selectMonitoredChatIds(busyChats, () => 'active', getChatActivityAt, now);
const emptyVisibleBusy = selectHistoryHttpChatIds(busyMonitored, busyChats, {
  activeChatId: 'active',
  visibleChatIds: new Set(),
});
assert.equal(emptyVisibleBusy.has('busy'), true);

const capped = capHistoryHttpJobs(Array.from({ length: 40 }, (_, i) => i), {
  chunkSize: 16,
  maxPosts: 2,
});
assert.equal(capped.length, 32);
assert.equal(capHistoryHttpJobs(null).length, 0);

console.log('chat-background-policy.test.js: ok');
