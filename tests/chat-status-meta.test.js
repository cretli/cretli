import assert from 'node:assert/strict';
import {
  hasActiveAgentRun,
  hasKeepAliveHarnessWork,
  hasLiveHarnessWork,
  shouldCloseLiveTurnAfterHistoryReplay,
  overlayHistorySyncingMeta,
  resolveChatStatusWithHistorySync,
  readHarnessPendingFlags,
  resolveChatListDotState,
  resolveHarnessChatStateMeta,
} from '../app_front/features/chat/chatStatusMeta.js';
import { createSidebarStatusStabilizer } from '../app_front/features/sidebar/sidebarChatStatusStability.js';

// Expected labels below are the English i18n fallbacks from chatStatusMeta.js.

const inputIdle = {
  connection: 'connected',
  agent: 'idle',
  hasPendingQuestion: false,
  hasPendingPermission: false,
};
const actualIdle = resolveHarnessChatStateMeta(inputIdle);
assert.equal(actualIdle.tone, 'idle');
assert.equal(actualIdle.label, 'Ready');

const actualFailedRun = resolveHarnessChatStateMeta({
  ...inputIdle,
  lastRunStatus: 'run_failed',
});
assert.equal(actualFailedRun.tone, 'attention');
assert.equal(actualFailedRun.status, 'failed');
assert.equal(actualFailedRun.label, 'Run failed');

const actualCancelledRun = resolveHarnessChatStateMeta({
  ...inputIdle,
  lastRunStatus: 'cancelled',
});
assert.equal(actualCancelledRun.tone, 'idle');

const inputAwaitingFromBufferHeuristic = {
  connection: 'connected',
  agent: 'idle',
  hasPendingQuestion: false,
  hasPendingPermission: false,
};
const actualAfterMarkdownQuestion = resolveHarnessChatStateMeta(inputAwaitingFromBufferHeuristic);
assert.equal(actualAfterMarkdownQuestion.tone, 'idle');
assert.equal(actualAfterMarkdownQuestion.label, 'Ready');

const inputDisconnectedActive = { connection: 'disconnected', agent: 'active' };
const actualDisconnectedActive = resolveHarnessChatStateMeta(inputDisconnectedActive);
assert.equal(actualDisconnectedActive.tone, 'active');
assert.equal(actualDisconnectedActive.label, 'Agent working');

const inputAttentionBeatsLive = {
  connection: 'connected',
  agent: 'active',
  serverRunState: { state: 'attention', delegationStatus: 'completed' },
};
const actualAttentionBeatsLive = resolveHarnessChatStateMeta(inputAttentionBeatsLive);
assert.equal(actualAttentionBeatsLive.tone, 'attention');

const inputWaitingBeatsLive = {
  connection: 'connected',
  agent: 'active',
  serverRunState: { state: 'waiting', waitingAgentCount: 2, inFlightChildCount: 2 },
};
const actualWaitingBeatsLive = resolveHarnessChatStateMeta(inputWaitingBeatsLive);
assert.equal(actualWaitingBeatsLive.tone, 'awaiting');
assert.match(actualWaitingBeatsLive.label, /2/);

const inputActivityBusy = {
  connection: 'disconnected',
  agent: 'idle',
  serverRunState: { state: 'busy', activityKey: 'read', activityArg: 'a.js' },
};
const actualActivityBusy = resolveHarnessChatStateMeta(inputActivityBusy);
assert.equal(actualActivityBusy.tone, 'active');
assert.match(actualActivityBusy.label, /Read/);
assert.equal(actualActivityBusy.activityKey, 'read');

const inputLiveActivity = {
  connection: 'connected',
  agent: 'active',
  serverRunState: { state: 'busy', activityKey: 'read', activityArg: 'a.js' },
};
const actualLiveActivity = resolveHarnessChatStateMeta(inputLiveActivity);
assert.equal(actualLiveActivity.tone, 'active');
assert.match(actualLiveActivity.label, /Read/);
assert.equal(actualLiveActivity.activityKey, 'read');

const inputServerBusyBeatsLocalQueue = {
  connection: 'connected',
  agent: 'active',
  queuedCount: 2,
  serverRunState: { state: 'busy', activityKey: 'read', activityArg: 'a.js' },
};
const actualServerBusyBeatsLocalQueue = resolveHarnessChatStateMeta(inputServerBusyBeatsLocalQueue);
assert.equal(actualServerBusyBeatsLocalQueue.tone, 'active');
assert.match(actualServerBusyBeatsLocalQueue.label, /Read/);
assert.equal(actualServerBusyBeatsLocalQueue.activityKey, 'read');

const inputServerBusyNoKeyBeatsLocalQueue = {
  connection: 'connected',
  agent: 'active',
  queuedCount: 2,
  serverRunState: { state: 'busy' },
};
const actualServerBusyNoKeyBeatsQueue = resolveHarnessChatStateMeta(inputServerBusyNoKeyBeatsLocalQueue);
assert.equal(actualServerBusyNoKeyBeatsQueue.tone, 'active');
assert.equal(actualServerBusyNoKeyBeatsQueue.label, 'Agent working');

const inputDisconnectedPending = {
  connection: 'disconnected',
  agent: 'idle',
  hasPendingQuestion: true,
};
const actualDisconnectedPending = resolveHarnessChatStateMeta(inputDisconnectedPending);
assert.equal(actualDisconnectedPending.tone, 'awaiting');
assert.equal(actualDisconnectedPending.label, 'Needs action');

const inputDisconnectedIdle = { connection: 'disconnected', agent: 'idle' };
const actualDisconnectedIdle = resolveHarnessChatStateMeta(inputDisconnectedIdle);
assert.equal(actualDisconnectedIdle.tone, 'disconnected');
assert.equal(actualDisconnectedIdle.label, 'Disconnected');

const inputConnecting = { connection: 'connecting', agent: 'idle' };
const actualConnecting = resolveHarnessChatStateMeta(inputConnecting);
assert.equal(actualConnecting.tone, 'connecting');
assert.equal(actualConnecting.label, 'Connecting…');

const inputActive = { connection: 'connected', agent: 'active' };
const actualActive = resolveHarnessChatStateMeta(inputActive);
assert.equal(actualActive.tone, 'active');
assert.equal(actualActive.label, 'Agent working');

const inputQueued = { connection: 'connected', agent: 'active', queuedCount: 2 };
const actualQueued = resolveHarnessChatStateMeta(inputQueued);
assert.equal(actualQueued.tone, 'active');
assert.equal(actualQueued.label, 'Agent working · queue: 2');

const inputOpenCodeQuestion = {
  connection: 'connected',
  agent: 'idle',
  hasPendingQuestion: true,
};
const actualOpenCodeQuestion = resolveHarnessChatStateMeta(inputOpenCodeQuestion);
assert.equal(actualOpenCodeQuestion.tone, 'awaiting');
assert.equal(actualOpenCodeQuestion.label, 'Needs action');

const inputOpenCodePermission = {
  connection: 'connected',
  agent: 'idle',
  hasPendingPermission: true,
};
const actualOpenCodePermission = resolveHarnessChatStateMeta(inputOpenCodePermission);
assert.equal(actualOpenCodePermission.tone, 'awaiting');
assert.equal(actualOpenCodePermission.label, 'Needs action');

const inputChatNoPending = {
  _awaitingInput: true,
  _opencodePendingQuestion: null,
  _sdkServerPendingQuestionCount: 0,
  _sdkServerPendingPermissionCount: 0,
};
const actualFlagsIgnoreBuffer = readHarnessPendingFlags(inputChatNoPending);
assert.equal(actualFlagsIgnoreBuffer.hasPendingQuestion, false);
assert.equal(actualFlagsIgnoreBuffer.hasPendingPermission, false);

const inputChatOpenCode = {
  _opencodePendingQuestion: { id: 'q1' },
  _sdkServerPendingPermissionCount: 1,
};
const actualFlagsOpenCode = readHarnessPendingFlags(inputChatOpenCode);
assert.equal(actualFlagsOpenCode.hasPendingQuestion, true);
assert.equal(actualFlagsOpenCode.hasPendingPermission, true);

assert.equal(resolveChatListDotState('idle'), 'idle');
assert.equal(resolveChatListDotState('awaiting'), 'awaiting');
assert.equal(resolveChatListDotState('question'), 'awaiting');
assert.equal(resolveChatListDotState('active'), 'active');
assert.equal(resolveChatListDotState('disconnected'), 'disconnected');
assert.equal(resolveChatListDotState('connecting'), 'active');

const inputTranslated = resolveHarnessChatStateMeta({
  connection: 'connected',
  agent: 'idle',
  translate: (key) => `T:${key}`,
});
assert.equal(inputTranslated.label, 'T:status.ready');

assert.equal(hasLiveHarnessWork(null), false);
assert.equal(hasLiveHarnessWork({ _agentState: 'active' }), true);
assert.equal(hasLiveHarnessWork({ _sdkServerBusy: true }), true);
assert.equal(hasLiveHarnessWork({ _sdkServerQueuedCount: 2 }), true);
assert.equal(hasLiveHarnessWork({ _sdkRichView: { queuedCount: 1 } }), true);
assert.equal(hasLiveHarnessWork({ _opencodePendingQuestion: { id: 'q1' } }), true);
assert.equal(hasLiveHarnessWork({ _sdkServerPendingPermissionCount: 1 }), true);
assert.equal(hasLiveHarnessWork({ _agentState: 'idle', _sdkServerBusy: false }), false);
assert.equal(hasKeepAliveHarnessWork({ _agentState: 'active' }), false);
assert.equal(hasKeepAliveHarnessWork({ _agentState: 'active', _sdkServerBusy: true }), true);
assert.equal(hasKeepAliveHarnessWork({ _agentState: 'active', _sdkRichView: { queuedCount: 1 } }), true);
assert.equal(shouldCloseLiveTurnAfterHistoryReplay({ _agentState: 'active' }), true);
assert.equal(shouldCloseLiveTurnAfterHistoryReplay({ _sdkServerBusy: true }), false);
assert.equal(shouldCloseLiveTurnAfterHistoryReplay({ _serverRunState: { state: 'busy' } }), false);
assert.equal(hasActiveAgentRun({ _agentState: 'active' }), true);
assert.equal(hasActiveAgentRun({ _opencodePendingQuestion: { id: 'q1' } }), false);
assert.equal(hasLiveHarnessWork({ _serverRunState: { state: 'busy' } }), true);
assert.equal(hasActiveAgentRun({ _serverRunState: { state: 'busy' } }), true);
assert.equal(hasLiveHarnessWork({ _serverRunState: { state: 'waiting' } }), true);
assert.equal(hasLiveHarnessWork({ _serverRunState: { state: 'attention' } }), false);

const inputServerBusy = {
  connection: 'disconnected',
  agent: 'idle',
  serverRunState: { state: 'busy' },
};
const actualServerBusy = resolveHarnessChatStateMeta(inputServerBusy);
assert.equal(actualServerBusy.tone, 'active');

const inputServerWaiting = {
  connection: 'disconnected',
  agent: 'idle',
  serverRunState: { state: 'waiting', attention: true },
};
const actualServerWaiting = resolveHarnessChatStateMeta(inputServerWaiting);
assert.equal(actualServerWaiting.tone, 'awaiting');
assert.equal(actualServerWaiting.label, 'Needs action');
const actualServerWaitingAgents = resolveHarnessChatStateMeta({
  connection: 'disconnected',
  agent: 'idle',
  serverRunState: { state: 'waiting', waitingAgentCount: 2, inFlightChildCount: 2 },
});
assert.equal(actualServerWaitingAgents.label, 'Waiting for 2 agents');

const inputServerDone = {
  connection: 'disconnected',
  agent: 'idle',
  serverRunState: { state: 'attention', delegationStatus: 'completed', attention: true },
};
const actualServerDone = resolveHarnessChatStateMeta(inputServerDone);
assert.equal(actualServerDone.tone, 'attention');
assert.equal(actualServerDone.label, 'Completed');
assert.equal(resolveChatListDotState('attention'), 'awaiting');

const inputGenerating = overlayHistorySyncingMeta(true, (key) => (
  key === 'chat.historySyncing' ? 'Syncing messages…' : key
));
assert.equal(inputGenerating.tone, 'syncing');
assert.equal(inputGenerating.label, 'Syncing messages…');
assert.equal(overlayHistorySyncingMeta(false), null);
assert.equal(overlayHistorySyncingMeta(true).label, 'Syncing messages…');

const inputGeneratingFallback = { tone: 'generating', label: 'Generating…' };
const actualSyncOverGenerating = resolveChatStatusWithHistorySync(true, inputGeneratingFallback);
assert.equal(actualSyncOverGenerating.tone, 'syncing');
assert.equal(actualSyncOverGenerating.label, 'Syncing messages…');
const actualKeepGenerating = resolveChatStatusWithHistorySync(false, inputGeneratingFallback);
assert.equal(actualKeepGenerating.tone, 'generating');
const actualSyncOverConnecting = resolveChatStatusWithHistorySync(true, actualConnecting);
assert.equal(actualSyncOverConnecting.tone, 'syncing');

// --- Priority table: work from the server outranks a transient connection. ---

const inputBusyConnecting = {
  connection: 'connecting',
  agent: 'idle',
  serverRunState: { state: 'busy', activityKey: 'read', activityArg: 'a.js' },
};
const actualBusyConnecting = resolveHarnessChatStateMeta(inputBusyConnecting);
assert.equal(actualBusyConnecting.tone, 'active');
assert.equal(actualBusyConnecting.label, 'Read a.js');

const inputBusyNoActivityConnecting = {
  connection: 'connecting',
  agent: 'idle',
  serverRunState: { state: 'busy' },
};
assert.equal(resolveHarnessChatStateMeta(inputBusyNoActivityConnecting).tone, 'active');

const inputWaitingConnecting = {
  connection: 'connecting',
  agent: 'idle',
  serverRunState: { state: 'waiting' },
};
assert.equal(resolveHarnessChatStateMeta(inputWaitingConnecting).tone, 'awaiting');

const inputPendingConnecting = { connection: 'connecting', agent: 'idle', hasPendingPermission: true };
assert.equal(resolveHarnessChatStateMeta(inputPendingConnecting).tone, 'awaiting');

// --- Sidebar surface: background chats without a socket are idle, not broken. ---

const inputSidebarBackgroundDisconnected = {
  surface: 'sidebar',
  connection: 'disconnected',
  agent: 'idle',
  socketExpected: false,
};
const actualSidebarBackground = resolveHarnessChatStateMeta(inputSidebarBackgroundDisconnected);
assert.equal(actualSidebarBackground.tone, 'idle');
assert.equal(actualSidebarBackground.label, 'Ready');
assert.equal(resolveHarnessChatStateMeta({ ...inputSidebarBackgroundDisconnected, surface: 'bar' }).tone, 'disconnected');

const inputSidebarExpectedDisconnected = {
  surface: 'sidebar',
  connection: 'disconnected',
  agent: 'idle',
  socketExpected: true,
};
assert.equal(resolveHarnessChatStateMeta(inputSidebarExpectedDisconnected).tone, 'disconnected');

const inputSidebarConnecting = {
  surface: 'sidebar',
  connection: 'connecting',
  agent: 'idle',
  socketExpected: true,
  connectingForMs: 200,
};
assert.equal(resolveHarnessChatStateMeta(inputSidebarConnecting).tone, 'idle');
assert.equal(
  resolveHarnessChatStateMeta({ ...inputSidebarConnecting, connectingForMs: 2000 }).tone,
  'connecting'
);
// Sidebar work still wins over the connecting grace.
assert.equal(
  resolveHarnessChatStateMeta({
    ...inputSidebarConnecting,
    connectingForMs: 200,
    serverRunState: { state: 'busy', activityKey: 'grep', activityArg: 'x' },
  }).tone,
  'active'
);

const inputSidebarStaleWaiting = {
  surface: 'sidebar',
  connection: 'disconnected',
  agent: 'idle',
  socketExpected: false,
  serverRunState: { state: 'waiting' },
};
assert.equal(resolveHarnessChatStateMeta(inputSidebarStaleWaiting).tone, 'idle');
assert.equal(resolveHarnessChatStateMeta(inputSidebarStaleWaiting).label, 'Ready');
assert.equal(
  resolveHarnessChatStateMeta({
    ...inputSidebarStaleWaiting,
    serverRunState: { state: 'waiting', waitingAgentCount: 2, inFlightChildCount: 2 },
  }).tone,
  'awaiting',
);

// --- Hysteresis: a short busy -> idle -> busy blip keeps the row working. ---

function createFakeClockStabilizer() {
  let nowValue = 1_000_000;
  const timers = new Set();
  const expires = [];
  const stabilizer = createSidebarStatusStabilizer({
    now: () => nowValue,
    setTimeout: (fn, ms) => {
      const timer = { fn, at: nowValue + ms };
      timers.add(timer);
      return timer;
    },
    clearTimeout: (timer) => timers.delete(timer),
    onExpire: (chatId) => expires.push(chatId),
  });
  const advance = (ms) => {
    nowValue += ms;
    for (const timer of [...timers]) {
      if (timer.at <= nowValue) {
        timers.delete(timer);
        timer.fn();
      }
    }
  };
  return { stabilizer, advance, now: () => nowValue, expires };
}

const activeMeta = { tone: 'active', label: 'Read a.js', activityKey: 'read' };
const idleMeta = { tone: 'idle', label: 'Ready' };
const busySources = { serverBusy: true, serverKnown: true, localActive: true };
const idleBlipSources = { serverBusy: false, serverKnown: true, localActive: true };

const blip = createFakeClockStabilizer();
blip.stabilizer.stabilize('c1', activeMeta, busySources);
blip.advance(50);
assert.equal(blip.stabilizer.stabilize('c1', idleMeta, idleBlipSources).tone, 'active');
blip.advance(300);
assert.equal(blip.stabilizer.stabilize('c1', idleMeta, idleBlipSources).tone, 'active');
blip.stabilizer.stabilize('c1', activeMeta, busySources);
assert.equal(blip.stabilizer.stabilize('c1', activeMeta, busySources).tone, 'active');

const threshold = createFakeClockStabilizer();
threshold.stabilizer.stabilize('c2', activeMeta, busySources);
threshold.advance(100);
assert.equal(threshold.stabilizer.stabilize('c2', idleMeta, idleBlipSources).tone, 'active');
threshold.advance(600);
assert.equal(threshold.stabilizer.stabilize('c2', idleMeta, idleBlipSources).tone, 'idle');

const agreement = createFakeClockStabilizer();
agreement.stabilizer.stabilize('c3', activeMeta, busySources);
agreement.advance(50);
assert.equal(
  agreement.stabilizer.stabilize('c3', idleMeta, { serverBusy: false, serverKnown: true, localActive: false }).tone,
  'idle'
);

const labels = createFakeClockStabilizer();
labels.stabilizer.stabilize('c4', activeMeta, busySources);
labels.advance(100);
const heldLabel = labels.stabilizer.stabilize(
  'c4',
  { tone: 'active', label: 'Grep y', activityKey: 'grep' },
  busySources
);
assert.equal(heldLabel.label, 'Read a.js');
labels.advance(500);
const nextLabel = labels.stabilizer.stabilize(
  'c4',
  { tone: 'active', label: 'Grep y', activityKey: 'grep' },
  busySources
);
assert.equal(nextLabel.label, 'Grep y');
labels.advance(100);
const heldGeneric = labels.stabilizer.stabilize(
  'c4',
  { tone: 'active', label: 'Agent working' },
  busySources
);
assert.equal(heldGeneric.activityKey, 'grep');
labels.advance(600);
assert.equal(
  labels.stabilizer.stabilize('c4', { tone: 'active', label: 'Agent working' }, busySources).activityKey,
  ''
);

// After the tool label was visible longer than labelMs, losing activityKey still
// holds it for labelMs measured from the drop, not from labelSince.
const longLabel = createFakeClockStabilizer();
longLabel.stabilizer.stabilize('c6', activeMeta, busySources);
longLabel.advance(700);
const stillRead = longLabel.stabilizer.stabilize(
  'c6',
  { tone: 'active', label: 'Agent working' },
  busySources
);
assert.equal(stillRead.label, 'Read a.js');
assert.equal(stillRead.activityKey, 'read');
longLabel.advance(400);
const stillReadMidHold = longLabel.stabilizer.stabilize(
  'c6',
  { tone: 'active', label: 'Agent working' },
  busySources
);
assert.equal(stillReadMidHold.label, 'Read a.js');
longLabel.advance(200);
const genericAfterHold = longLabel.stabilizer.stabilize(
  'c6',
  { tone: 'active', label: 'Agent working' },
  busySources
);
assert.equal(genericAfterHold.label, 'Agent working');
assert.equal(genericAfterHold.activityKey, '');

// The connecting grace window reports elapsed time and wakes the row once at the
// 1.5s boundary, then resets when the socket connects.
const connecting = createFakeClockStabilizer();
assert.equal(connecting.stabilizer.connectingForMs('c5', 'connecting'), 0);
connecting.advance(600);
assert.equal(connecting.stabilizer.connectingForMs('c5', 'connecting'), 600);
assert.equal(connecting.expires.length, 0);
connecting.advance(1000);
assert.equal(connecting.expires.includes('c5'), true);
assert.equal(connecting.stabilizer.connectingForMs('c5', 'connecting') >= 1500, true);
assert.equal(connecting.stabilizer.connectingForMs('c5', 'connected'), 0);

console.log('All chat status meta tests passed.');
