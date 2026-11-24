import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import {
  CHAT_PING_INTERVAL_MS,
  CHAT_RECONNECT_DELAYS,
  CHAT_RECONNECT_MAX,
  WS_PATH_AGENT_SDK,
} from '../app_front/config.js';
import { createChatTransport } from '../app_front/features/chat/chatTransport.js';
import {
  applyCatchUpSdkHistoryRecords,
} from '../app_front/features/chat/chatHistoryViewApply.js';
import { insertRecordByViewOrder } from '../app_front/features/chat/chatHistoryViewOrder.js';
import {
  getViewAppliedSeq,
  replaceViewAppliedRecords,
  resetViewAppliedSeqMemoryForTests,
  resetViewAppliedState,
} from '../app_front/features/chat/chatHistoryConvergence.js';
import { runSdkHistoryConvergence } from '../app_front/features/chat/chatHistoryConvergenceRun.js';
import { mergeServerSdkHistoryIntoRichView } from '../app_front/features/chat/chatHistoryHttpMerge.js';
import {
  beginSdkHistoryHydration,
  beginSdkOpenTerminalHydration,
  hasUnrenderedSdkRoomEventSeq,
  selectRoomCoveredSdkHistoryRecords,
} from '../app_front/features/chat/sdkEventReplayGuard.js';

resetViewAppliedSeqMemoryForTests();

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
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }
  send(data) {
    this.sent.push(data);
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

function readAssistantText(event) {
  const text = event?.message?.content?.[0]?.text;
  return typeof text === 'string' ? text : '';
}

function createFakeView(options = {}) {
  const nodes = [];
  return {
    nodes,
    hasRenderedHistory() {
      return nodes.length > 0;
    },
    applyEvent(event, meta = {}) {
      if (typeof options.failApply === 'function' && options.failApply(event)) {
        throw new Error('applyEvent failed');
      }
      insertRecordByViewOrder(nodes, {
        kind: 'sdk',
        text: readAssistantText(event),
        event,
        historySeq: Number(meta?.historySeq) || 0,
        roomEventSeq: Number(meta?.roomEventSeq) || 0,
        eventStreamId: typeof meta?.eventStreamId === 'string' ? meta.eventStreamId.trim() : '',
      });
    },
    prependHistoryRecords(records) {
      nodes.unshift(...records);
    },
    async appendHistoryRecords(records) {
      for (const record of records) {
        insertRecordByViewOrder(nodes, record);
      }
    },
    hasQueuedOrSentUserText() {
      return false;
    },
    appendBannerConnected() {},
    appendRunFinished(status, opts = {}) {
      insertRecordByViewOrder(nodes, {
        kind: 'runFinished',
        status: String(status || ''),
        historySeq: Number(opts?.historySeq) || 0,
        roomEventSeq: Number(opts?.roomEventSeq) || 0,
        eventStreamId: typeof opts?.eventStreamId === 'string' ? opts.eventStreamId.trim() : '',
      });
    },
    onStreamReset() {},
  };
}

function nodeOrder(chat) {
  return chat._sdkRichView.nodes.map((row) => {
    if (row?.kind === 'runFinished') return `runFinished:${row.status}`;
    if (typeof row?.text === 'string' && row.text) return row.text;
    if (row?.event) return readAssistantText(row.event);
    if (row?.kind === 'meta') return `${row.variant}:${row.historySeq || 0}`;
    return String(row?.historySeq || row?.kind || '');
  });
}

function countText(chat, text) {
  return chat._sdkRichView.nodes.filter((row) => {
    if (row?.text === text) return true;
    if (row?.event) return readAssistantText(row.event) === text;
    return false;
  }).length;
}

function assistantEvent(text) {
  return {
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
  };
}

function assistantHistoryRecord(seq, text, roomSeq, streamId = 'room') {
  return {
    kind: 'sdk',
    historySeq: seq,
    eventStreamId: streamId,
    roomEventSeq: roomSeq,
    event: assistantEvent(text),
  };
}

function createTransport(chat, options = {}) {
  const chats = [chat];
  const noop = () => {};
  return createChatTransport({
    WS_PATH_AGENT_SDK,
    CHAT_RECONNECT_MAX,
    CHAT_RECONNECT_DELAYS,
    CHAT_PING_INTERVAL_MS,
    getChats: () => chats,
    getActiveChatId: () => chat.id,
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
    ...options,
  });
}

function connectOpenSocket(transport, chat) {
  FakeWebSocket.instances.length = 0;
  transport.ensureChatConnection(chat);
  const socket = FakeWebSocket.instances.at(-1);
  assert.ok(socket, 'ensureChatConnection must construct a WebSocket');
  socket.readyState = FakeWebSocket.OPEN;
  socket.onopen?.();
  return socket;
}

function emitSocketMessage(socket, payload) {
  socket.onmessage?.({ data: JSON.stringify(payload) });
}

{
  const hydrated = [];
  const chat = { id: 'prompt-suggestion-hydration', cursorSessionId: 'suggestion-session' };
  chat._promptSuggestionChip = { set: (suggestion) => hydrated.push(suggestion) };
  const transport = createTransport(chat);
  const socket = connectOpenSocket(transport, chat);
  emitSocketMessage(socket, {
    type: 'sdkRoomState',
    promptSuggestion: { text: 'Continue with a regression test', turnRunId: 'run-hydrated' },
  });
  assert.deepEqual(hydrated, [{ text: 'Continue with a regression test', turnRunId: 'run-hydrated' }]);
}

function replayAssistantBatch(socket, roomEventSeq, text) {
  emitSocketMessage(socket, { type: 'replayBatchStart', totalEvents: 1, totalBatches: 1 });
  emitSocketMessage(socket, {
    type: 'replayBatch',
    batchIndex: 0,
    totalBatches: 1,
    events: [{
      type: 'sdkEvent',
      eventStreamId: 'room',
      roomEventSeq,
      event: assistantEvent(text),
    }],
  });
}

const missingReply = 'missing reply';

resetViewAppliedSeqMemoryForTests();
const chat = {
  id: 'transport-a',
  cursorSessionId: 'sess-transport',
  _sdkEventStreamId: 'room',
  _sdkLastRoomEventSeq: 100,
  _sdkHydratedRoomEventSeqByStream: { room: 100 },
};
chat._sdkRichView = createFakeView();
chat._sdkRichView.nodes.push({ kind: 'sdk', historySeq: 100, text: 'already on screen' });
replaceViewAppliedRecords(chat.id, chat, [{ historySeq: 100 }]);
assert.equal(chat._sdkRichView.hasRenderedHistory(), true);

const transport = createTransport(chat);
beginSdkHistoryHydration(chat);
const socket = connectOpenSocket(transport, chat);
replayAssistantBatch(socket, 101, missingReply);
assert.equal(countText(chat, missingReply), 0, 'Replay stays buffered while hydrating');
assert.equal(chat._sdkPendingRoomEvents.length, 1);

let fetchAttempt = 0;
const first = await runSdkHistoryConvergence(chat, { reason: 'replay_complete' }, {
  isDocumentHidden: () => false,
  fetchDelta: async () => {
    fetchAttempt += 1;
    if (fetchAttempt === 1) return null;
    return {
      headSeq: 101,
      ackSeq: 101,
      events: [assistantHistoryRecord(101, missingReply, 101)],
    };
  },
  readLocal: async () => ({ events: [{ historySeq: 100 }] }),
  applyCatchUp: applyCatchUpSdkHistoryRecords,
  completeHydration: (target, records) => transport.completeSdkHistoryHydration(target, records),
  getStoreAckSeq: () => 100,
});
assert.equal(first.status, 'error');
assert.equal(countText(chat, missingReply), 1, 'HTTP failure must still render buffered replay');
assert.equal(chat._sdkLastRoomEventSeq, 101);
assert.equal(chat._sdkHistoryHydrating, false);

beginSdkHistoryHydration(chat);
const retried = await runSdkHistoryConvergence(chat, { reason: 'replay_complete' }, {
  isDocumentHidden: () => false,
  fetchDelta: async () => ({
    headSeq: 101,
    ackSeq: 101,
    events: [assistantHistoryRecord(101, missingReply, 101)],
  }),
  readLocal: async () => ({ events: [{ historySeq: 100 }] }),
  applyCatchUp: applyCatchUpSdkHistoryRecords,
  completeHydration: (target, records) => transport.completeSdkHistoryHydration(target, records),
  getStoreAckSeq: () => 100,
});
assert.notEqual(retried.status, 'error');
assert.equal(countText(chat, missingReply), 1, 'Successful HTTP retry must not duplicate the reply');
assert.equal(getViewAppliedSeq(chat.id, chat), 101);
const covered = selectRoomCoveredSdkHistoryRecords(chat, [
  assistantHistoryRecord(101, missingReply, 101),
]);
assert.equal(covered.length, 1);

resetViewAppliedSeqMemoryForTests();
const noEndChat = {
  id: 'transport-b',
  cursorSessionId: 'sess-transport',
  _sdkEventStreamId: 'room',
  _sdkLastRoomEventSeq: 100,
  _sdkHydratedRoomEventSeqByStream: { room: 100 },
};
noEndChat._sdkRichView = createFakeView();
noEndChat._sdkRichView.nodes.push({ kind: 'sdk', historySeq: 100, text: 'seed' });
replaceViewAppliedRecords(noEndChat.id, noEndChat, [{ historySeq: 100 }]);
const noEndTransport = createTransport(noEndChat);
beginSdkHistoryHydration(noEndChat);
const noEndSocket = connectOpenSocket(noEndTransport, noEndChat);
replayAssistantBatch(noEndSocket, 101, missingReply);
const partial = await runSdkHistoryConvergence(noEndChat, { reason: 'replay_fallback' }, {
  isDocumentHidden: () => false,
  fetchDelta: async () => ({
    headSeq: 101,
    ackSeq: 100,
    incomplete: true,
    events: [],
  }),
  readLocal: async () => ({ events: [{ historySeq: 100 }] }),
  applyCatchUp: applyCatchUpSdkHistoryRecords,
  completeHydration: (target, records) => noEndTransport.completeSdkHistoryHydration(target, records),
  getStoreAckSeq: () => 100,
});
assert.equal(partial.status, 'partial');
assert.equal(countText(noEndChat, missingReply), 1, 'Missing replay end plus partial HTTP still shows the reply');
assert.equal(noEndChat._sdkLastRoomEventSeq, 101);

const catchUpAfterPartial = await applyCatchUpSdkHistoryRecords(noEndChat, [
  assistantHistoryRecord(101, missingReply, 101),
]);
assert.equal(catchUpAfterPartial, 0);
assert.equal(countText(noEndChat, missingReply), 1);
assert.equal(getViewAppliedSeq(noEndChat.id, noEndChat), 101);

resetViewAppliedSeqMemoryForTests();
const swapChat = {
  id: 'transport-c',
  cursorSessionId: 'sess-transport',
  _sdkEventStreamId: 'room',
  _sdkLastRoomEventSeq: 100,
  _sdkHydratedRoomEventSeqByStream: { room: 100 },
};
swapChat._sdkRichView = createFakeView();
replaceViewAppliedRecords(swapChat.id, swapChat, [{ historySeq: 100 }]);
const swapTransport = createTransport(swapChat);
beginSdkHistoryHydration(swapChat);
connectOpenSocket(swapTransport, swapChat);
let resolveSwapFetch = () => {};
const swapFetchHold = new Promise((resolve) => {
  resolveSwapFetch = resolve;
});
let swapHydrationCalls = 0;
const swapRun = runSdkHistoryConvergence(swapChat, { reason: 'visibility' }, {
  isDocumentHidden: () => false,
  fetchDelta: async () => {
    await swapFetchHold;
    return null;
  },
  readLocal: async () => ({ events: [{ historySeq: 100 }] }),
  completeHydration: (target, records) => {
    swapHydrationCalls += 1;
    swapTransport.completeSdkHistoryHydration(target, records);
  },
  getStoreAckSeq: () => 100,
});
resetViewAppliedState(swapChat.id, swapChat);
swapChat._sdkRichView = createFakeView();
beginSdkHistoryHydration(swapChat);
const swapSocket = swapChat.ws;
assert.ok(swapSocket?.onmessage);
emitSocketMessage(swapSocket, {
  type: 'replayBatch',
  events: [{
    type: 'sdkEvent',
    eventStreamId: 'room',
    roomEventSeq: 101,
    event: assistantEvent('new pane pending'),
  }],
});
assert.equal(swapChat._sdkPendingRoomEvents.length, 1);
resolveSwapFetch();
const swapResult = await swapRun;
assert.equal(swapResult.deferReason, 'view_replaced');
assert.equal(swapHydrationCalls, 0);
assert.equal(swapChat._sdkHistoryHydrating, true);
assert.equal(swapChat._sdkPendingRoomEvents.length, 1);
assert.equal(countText(swapChat, 'new pane pending'), 0);

resetViewAppliedSeqMemoryForTests();
const reply101 = 'response 101';
const reply102 = 'response 102';
let failApply101 = true;
const holeChat = {
  id: 'transport-d',
  cursorSessionId: 'sess-transport',
  _sdkEventStreamId: 'room',
  _sdkLastRoomEventSeq: 100,
  _sdkHydratedRoomEventSeqByStream: { room: 100 },
};
holeChat._sdkRichView = createFakeView({
  failApply: (event) => failApply101 && readAssistantText(event) === reply101,
});
holeChat._sdkRichView.nodes.push({ kind: 'sdk', historySeq: 100, text: 'seed' });
replaceViewAppliedRecords(holeChat.id, holeChat, [{ historySeq: 100 }]);
const holeTransport = createTransport(holeChat);
const holeSocket = connectOpenSocket(holeTransport, holeChat);

emitSocketMessage(holeSocket, {
  type: 'sdkEvent',
  eventStreamId: 'room',
  roomEventSeq: 101,
  event: assistantEvent(reply101),
});
assert.equal(countText(holeChat, reply101), 0, 'Failed applyEvent must not leave the reply on screen');
assert.equal(hasUnrenderedSdkRoomEventSeq(holeChat, 'room', 101), true);
assert.equal(
  selectRoomCoveredSdkHistoryRecords(holeChat, [assistantHistoryRecord(101, reply101, 101)]).length,
  0,
  'Seq 101 must not be covered after applyEvent threw'
);

emitSocketMessage(holeSocket, {
  type: 'sdkRunFinished',
  eventStreamId: 'room',
  roomEventSeq: 102,
  status: 'finished',
  runId: 'run-102',
});
assert.equal(holeChat._sdkLastRoomEventSeq, 102);
assert.equal(
  selectRoomCoveredSdkHistoryRecords(holeChat, [assistantHistoryRecord(101, reply101, 101)]).length,
  0,
  'Status seq 102 must not confirm missing 101'
);
assert.equal(
  holeChat._sdkRichView.nodes.filter((row) => row.kind === 'runFinished').length,
  1
);

failApply101 = false;
const holeCatchUp = await applyCatchUpSdkHistoryRecords(holeChat, [
  assistantHistoryRecord(101, reply101, 101),
  assistantHistoryRecord(102, reply102, 102),
]);
assert.equal(holeCatchUp, 1);
assert.equal(countText(holeChat, reply101), 1, 'Catch-up must render the failed seq 101 once');
assert.deepEqual(
  nodeOrder(holeChat),
  ['seed', reply101, 'runFinished:finished'],
  'Recovered 101 must sit before the already-rendered runFinished 102'
);
assert.equal(
  holeChat._sdkRichView.nodes.filter((row) => row.kind === 'runFinished').length,
  1,
  'Correctly rendered seq 102 must not be duplicated'
);
assert.equal(hasUnrenderedSdkRoomEventSeq(holeChat, 'room', 101), false);

const holeRetry = await applyCatchUpSdkHistoryRecords(holeChat, [
  assistantHistoryRecord(101, reply101, 101),
  assistantHistoryRecord(102, reply102, 102),
]);
assert.equal(holeRetry, 0);
assert.equal(countText(holeChat, reply101), 1);
emitSocketMessage(holeSocket, {
  type: 'sdkEvent',
  eventStreamId: 'room',
  roomEventSeq: 101,
  event: assistantEvent(reply101),
  replay: true,
});
assert.equal(countText(holeChat, reply101), 1, 'Replay after successful catch-up must not duplicate 101');

resetViewAppliedSeqMemoryForTests();
failApply101 = true;
const retryChat = {
  id: 'transport-e',
  cursorSessionId: 'sess-transport',
  _sdkEventStreamId: 'room',
  _sdkLastRoomEventSeq: 100,
  _sdkHydratedRoomEventSeqByStream: { room: 100 },
};
retryChat._sdkRichView = createFakeView({
  failApply: (event) => failApply101 && readAssistantText(event) === reply101,
});
retryChat._sdkRichView.nodes.push({ kind: 'sdk', historySeq: 100, text: 'seed' });
replaceViewAppliedRecords(retryChat.id, retryChat, [{ historySeq: 100 }]);
const retryTransport = createTransport(retryChat);
const retrySocket = connectOpenSocket(retryTransport, retryChat);
emitSocketMessage(retrySocket, {
  type: 'sdkEvent',
  eventStreamId: 'room',
  roomEventSeq: 101,
  event: assistantEvent(reply101),
});
emitSocketMessage(retrySocket, {
  type: 'sdkEvent',
  eventStreamId: 'room',
  roomEventSeq: 102,
  event: assistantEvent(reply102),
});
assert.equal(countText(retryChat, reply101), 0);
assert.equal(countText(retryChat, reply102), 1);
assert.equal(hasUnrenderedSdkRoomEventSeq(retryChat, 'room', 101), true);
failApply101 = false;
emitSocketMessage(retrySocket, {
  type: 'sdkEvent',
  eventStreamId: 'room',
  roomEventSeq: 101,
  event: assistantEvent(reply101),
  replay: true,
});
assert.equal(countText(retryChat, reply101), 1, 'WS retry must render seq 101 after the failed apply');
assert.equal(countText(retryChat, reply102), 1, 'Live seq 102 must stay a single card');
assert.deepEqual(
  nodeOrder(retryChat),
  ['seed', reply101, reply102],
  'WS retry of 101 must insert before live 102'
);
const retryCatchUp = await applyCatchUpSdkHistoryRecords(retryChat, [
  assistantHistoryRecord(101, reply101, 101),
  assistantHistoryRecord(102, reply102, 102),
]);
assert.equal(retryCatchUp, 0);
assert.equal(countText(retryChat, reply101), 1);
assert.equal(countText(retryChat, reply102), 1);
assert.deepEqual(nodeOrder(retryChat), ['seed', reply101, reply102]);

resetViewAppliedSeqMemoryForTests();
failApply101 = true;
const httpOrderChat = {
  id: 'transport-e-http',
  cursorSessionId: 'sess-transport',
  _sdkEventStreamId: 'room',
  _sdkLastRoomEventSeq: 100,
  _sdkHydratedRoomEventSeqByStream: { room: 100 },
};
httpOrderChat._sdkRichView = createFakeView({
  failApply: (event) => failApply101 && readAssistantText(event) === reply101,
});
httpOrderChat._sdkRichView.nodes.push({ kind: 'sdk', historySeq: 100, text: 'seed' });
replaceViewAppliedRecords(httpOrderChat.id, httpOrderChat, [{ historySeq: 100 }]);
const httpOrderTransport = createTransport(httpOrderChat);
const httpOrderSocket = connectOpenSocket(httpOrderTransport, httpOrderChat);
emitSocketMessage(httpOrderSocket, {
  type: 'sdkEvent',
  eventStreamId: 'room',
  roomEventSeq: 101,
  event: assistantEvent(reply101),
});
emitSocketMessage(httpOrderSocket, {
  type: 'sdkEvent',
  eventStreamId: 'room',
  roomEventSeq: 102,
  event: assistantEvent(reply102),
});
failApply101 = false;
const httpOrderCatchUp = await applyCatchUpSdkHistoryRecords(httpOrderChat, [
  assistantHistoryRecord(101, reply101, 101),
  assistantHistoryRecord(102, reply102, 102),
]);
assert.equal(httpOrderCatchUp, 1);
assert.deepEqual(
  nodeOrder(httpOrderChat),
  ['seed', reply101, reply102],
  'HTTP catch-up of 101 must insert before live assistant 102'
);

resetViewAppliedSeqMemoryForTests();
failApply101 = true;
const delegationOrderChat = {
  id: 'transport-e-del',
  cursorSessionId: 'sess-transport',
  _sdkEventStreamId: 'room',
  _sdkLastRoomEventSeq: 100,
  _sdkHydratedRoomEventSeqByStream: { room: 100 },
};
delegationOrderChat._sdkRichView = createFakeView({
  failApply: (event) => failApply101 && readAssistantText(event) === reply101,
});
delegationOrderChat._sdkRichView.nodes.push({ kind: 'sdk', historySeq: 100, text: 'seed' });
replaceViewAppliedRecords(delegationOrderChat.id, delegationOrderChat, [{ historySeq: 100 }]);
const delegationOrderTransport = createTransport(delegationOrderChat);
const delegationOrderSocket = connectOpenSocket(delegationOrderTransport, delegationOrderChat);
emitSocketMessage(delegationOrderSocket, {
  type: 'sdkEvent',
  eventStreamId: 'room',
  roomEventSeq: 101,
  event: assistantEvent(reply101),
});
assert.equal(countText(delegationOrderChat, reply101), 0);
failApply101 = false;
delegationOrderChat._sdkRichView.nodes.push({
  kind: 'meta',
  variant: 'delegation',
  historySeq: 102,
  text: 'delegation 102',
});
const delegationCatchUp = await applyCatchUpSdkHistoryRecords(delegationOrderChat, [
  assistantHistoryRecord(101, reply101, 101),
]);
assert.equal(delegationCatchUp, 1);
assert.deepEqual(
  nodeOrder(delegationOrderChat),
  ['seed', reply101, 'delegation 102'],
  'Recovered 101 must sit before an already-rendered delegation card 102'
);

resetViewAppliedSeqMemoryForTests();
const resetChat = {
  id: 'transport-f',
  cursorSessionId: 'sess-transport',
  _sdkEventStreamId: 'room',
  _sdkLastRoomEventSeq: 100,
  _sdkHydratedRoomEventSeqByStream: { room: 100 },
};
resetChat._sdkRichView = createFakeView({
  failApply: () => true,
});
const resetTransport = createTransport(resetChat);
const resetSocket = connectOpenSocket(resetTransport, resetChat);
emitSocketMessage(resetSocket, {
  type: 'sdkEvent',
  eventStreamId: 'room',
  roomEventSeq: 101,
  event: assistantEvent(reply101),
});
assert.equal(hasUnrenderedSdkRoomEventSeq(resetChat, 'room', 101), true);
resetViewAppliedState(resetChat.id, resetChat);
assert.equal(resetChat._sdkUnrenderedRoomEventSeqsByStream, undefined);
assert.equal(hasUnrenderedSdkRoomEventSeq(resetChat, 'room', 101), false);

resetViewAppliedSeqMemoryForTests();
const streamA = 'stream-a';
const streamB = 'stream-b';
const oldA102 = 'old A102';
const newB1 = 'new B1';
const newB2 = 'new B2';
const crossStreamChat = {
  id: 'transport-streams',
  cursorSessionId: 'sess-transport',
  _sdkEventStreamId: streamA,
  _sdkLastRoomEventSeq: 100,
  _sdkHydratedRoomEventSeqByStream: { [streamA]: 100 },
};
crossStreamChat._sdkRichView = createFakeView();
crossStreamChat._sdkRichView.nodes.push({
  kind: 'sdk',
  historySeq: 100,
  eventStreamId: streamA,
  roomEventSeq: 100,
  text: 'seed',
});
replaceViewAppliedRecords(crossStreamChat.id, crossStreamChat, [{ historySeq: 100 }]);
const crossStreamTransport = createTransport(crossStreamChat);
const crossStreamSocket = connectOpenSocket(crossStreamTransport, crossStreamChat);
emitSocketMessage(crossStreamSocket, {
  type: 'sdkEvent',
  eventStreamId: streamA,
  roomEventSeq: 102,
  event: assistantEvent(oldA102),
});
emitSocketMessage(crossStreamSocket, {
  type: 'sdkEvent',
  eventStreamId: streamB,
  roomEventSeq: 1,
  event: assistantEvent(newB1),
});
assert.deepEqual(
  nodeOrder(crossStreamChat),
  ['seed', oldA102, newB1],
  'Live B1 of a new stream must stay after A102'
);

resetViewAppliedSeqMemoryForTests();
let failApplyB1 = true;
const recoverBChat = {
  id: 'transport-streams-recover',
  cursorSessionId: 'sess-transport',
  _sdkEventStreamId: streamA,
  _sdkLastRoomEventSeq: 100,
  _sdkHydratedRoomEventSeqByStream: { [streamA]: 100 },
};
recoverBChat._sdkRichView = createFakeView({
  failApply: (event) => failApplyB1 && readAssistantText(event) === newB1,
});
recoverBChat._sdkRichView.nodes.push({
  kind: 'sdk',
  historySeq: 100,
  eventStreamId: streamA,
  roomEventSeq: 100,
  text: 'seed',
});
replaceViewAppliedRecords(recoverBChat.id, recoverBChat, [{ historySeq: 100 }]);
const recoverBTransport = createTransport(recoverBChat);
const recoverBSocket = connectOpenSocket(recoverBTransport, recoverBChat);
emitSocketMessage(recoverBSocket, {
  type: 'sdkEvent',
  eventStreamId: streamA,
  roomEventSeq: 102,
  event: assistantEvent(oldA102),
});
emitSocketMessage(recoverBSocket, {
  type: 'sdkEvent',
  eventStreamId: streamB,
  roomEventSeq: 1,
  event: assistantEvent(newB1),
});
emitSocketMessage(recoverBSocket, {
  type: 'sdkEvent',
  eventStreamId: streamB,
  roomEventSeq: 2,
  event: assistantEvent(newB2),
});
assert.equal(countText(recoverBChat, newB1), 0);
assert.deepEqual(nodeOrder(recoverBChat), ['seed', oldA102, newB2]);
failApplyB1 = false;
const recoverBCatchUp = await applyCatchUpSdkHistoryRecords(recoverBChat, [
  assistantHistoryRecord(200, oldA102, 102, streamA),
  assistantHistoryRecord(201, newB1, 1, streamB),
  assistantHistoryRecord(202, newB2, 2, streamB),
]);
assert.equal(recoverBCatchUp, 1);
assert.deepEqual(
  nodeOrder(recoverBChat),
  ['seed', oldA102, newB1, newB2],
  'Recovered B1 sits before live B2; both stay after A102'
);

for (const kind of ['Question', 'Permission']) {
  const repairChat = {
    id: `repair-${kind}`, cursorSessionId: 'repair-session', _sdkEventStreamId: 'room',
    _sdkLastRoomEventSeq: 102, _sdkHydratedRoomEventSeqByStream: { room: 102 },
  };
  repairChat._sdkRichView = createFakeView();
  repairChat._sdkRichView.getPendingInteractiveCounts = () => ({ questions: 0, permissions: 0 });
  replaceViewAppliedRecords(repairChat.id, repairChat, [{ historySeq: 101 }, { historySeq: 102 }]);
  let repairCalls = 0;
  let repairRun;
  const interactive = {
    kind: 'sdk', historySeq: 101, roomEventSeq: 101, eventStreamId: 'room',
    event: { type: `opencode_${kind.toLowerCase()}`, requestId: 'missing-card' },
  };
  const records = [interactive, assistantHistoryRecord(102, 'tail restored', 102)];
  repairChat._sdkRichView.replayHistoryRecords = async (rows) => {
    repairChat._sdkActiveHistoryReplayGeneration = 1;
    repairChat._sdkRichView.nodes.splice(0, Infinity, ...rows);
    return { generation: 1, reason: 'complete', applied: rows.length };
  };
  const repairTransport = createTransport(repairChat, {
    onSdkResume: (target, context) => {
      repairCalls += 1;
      assert.equal(context.reason, 'room_state_missing_interactive');
      repairRun = runSdkHistoryConvergence(target, context, {
        fetchDelta: async () => { throw new Error('Advanced delta cannot recover this card'); },
        fetchTail: async () => ({ events: records }),
        readLocal: async () => ({ events: [] }),
        completeHydration: (chat, rows) => repairTransport.completeSdkHistoryHydration(chat, rows),
      });
      return repairRun;
    },
  });
  const repairSocket = connectOpenSocket(repairTransport, repairChat);
  beginSdkHistoryHydration(repairChat);
  const state = {
    type: 'sdkRoomState', eventStreamId: 'room', lastRoomEventSeq: 102,
    [`pending${kind}Count`]: 1,
  };
  emitSocketMessage(repairSocket, state);
  await repairRun;
  assert.equal(repairCalls, 1, 'Missing card must trigger recovery even during stuck hydration');
  assert.equal(repairChat._sdkHistoryHydrating, false);
  assert.deepEqual(repairChat._sdkRichView.nodes, records, 'Full tail bypasses stale coverage');
  emitSocketMessage(repairSocket, state);
  assert.equal(repairCalls, 1, 'Room heartbeats must respect the repair cooldown');
}

const visibleChat = { id: 'visible-interactive', cursorSessionId: 'visible-session', _sdkLastRoomEventSeq: 102 };
visibleChat._sdkRichView = createFakeView();
visibleChat._sdkRichView.getPendingInteractiveCounts = () => ({ questions: 1, permissions: 1 });
let redundantRepairs = 0;
const visibleTransport = createTransport(visibleChat, { onSdkResume: () => { redundantRepairs += 1; } });
const visibleSocket = connectOpenSocket(visibleTransport, visibleChat);
emitSocketMessage(visibleSocket, {
  type: 'sdkRoomState', lastRoomEventSeq: 102, pendingQuestionCount: 1, pendingPermissionCount: 1,
});
assert.equal(redundantRepairs, 0, 'Connected unresolved cards need no repair');

{
  // Opening a chat mid-turn: the gap sync was aborted by a view replace, then the agent
  // asked a question. Neither the aborted run nor the 45 s gap cooldown may hide the card.
  const lateChat = { id: 'late-question', cursorSessionId: 'late-session', _sdkLastRoomEventSeq: 100 };
  lateChat._sdkRichView = createFakeView();
  lateChat._sdkRichView.getPendingInteractiveCounts = () => ({ questions: 0, permissions: 0 });
  const reasons = [];
  const results = [];
  const lateTransport = createTransport(lateChat, {
    onSdkResume: (_target, context) => {
      reasons.push(context.reason);
      const result = Promise.resolve(context.reason === 'room_state_gap'
        ? { status: 'deferred', deferReason: 'view_replaced' }
        : { status: 'success' });
      results.push(result);
      return result;
    },
  });
  const lateSocket = connectOpenSocket(lateTransport, lateChat);
  emitSocketMessage(lateSocket, { type: 'sdkRoomState', eventStreamId: 'room', lastRoomEventSeq: 105 });
  assert.deepEqual(reasons, ['room_state_gap']);
  await Promise.all(results);
  await new Promise((resolve) => setImmediate(resolve));
  emitSocketMessage(lateSocket, { type: 'sdkRoomState', eventStreamId: 'room', lastRoomEventSeq: 105 });
  assert.deepEqual(reasons, ['room_state_gap', 'room_state_gap'], 'A deferred gap sync must not consume the cooldown');
  emitSocketMessage(lateSocket, {
    type: 'sdkRoomState', eventStreamId: 'room', lastRoomEventSeq: 106, pendingQuestionCount: 1,
  });
  assert.equal(reasons.at(-1), 'room_state_missing_interactive', 'A missing question must not wait behind the gap cooldown');
}

{
  // The chat sits in the sidebar without a pane; its background socket receives the
  // agent question. Opening the pane later must still render it from the HTTP tail.
  const closedChat = { id: 'closed-question', cursorSessionId: 'closed-session', _sdkEventStreamId: 'room' };
  const closedTransport = createTransport(closedChat);
  const closedSocket = connectOpenSocket(closedTransport, closedChat);
  emitSocketMessage(closedSocket, {
    type: 'sdkEvent', eventStreamId: 'room', roomEventSeq: 7, historySeq: 7,
    event: assistantEvent('asked while closed'),
  });
  assert.equal(closedChat._sdkLastRoomEventSeq, 7, 'Background receive advances the room watermark');
  // openTerminal resets the view state before it creates the rich view.
  resetViewAppliedState(closedChat.id, closedChat);
  closedChat._sdkRichView = createFakeView();
  await applyCatchUpSdkHistoryRecords(closedChat, [assistantHistoryRecord(7, 'asked while closed', 7)]);
  assert.equal(countText(closedChat, 'asked while closed'), 1, 'A record only seen by the background socket must render in the new view');
}

{
  // Opening a chat mid-turn: the local cache ends at seq 5, a live frame at seq 9 renders
  // while the slow HTTP pull is in flight. Seq 9 must not mark 6..8 as already shown.
  const midChat = { id: 'mid-turn-open', cursorSessionId: 'mid-session', _sdkEventStreamId: 'room' };
  const midTransport = createTransport(midChat);
  const midSocket = connectOpenSocket(midTransport, midChat);
  emitSocketMessage(midSocket, { type: 'hello', transport: 'claude', eventStreamId: 'room', replayTagged: true });
  resetViewAppliedState(midChat.id, midChat);
  midChat._sdkRichView = createFakeView();
  beginSdkOpenTerminalHydration(midChat);
  const serverTail = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => assistantHistoryRecord(n, `mid ${n}`, n));
  await midChat._sdkRichView.appendHistoryRecords(serverTail.slice(0, 5));
  emitSocketMessage(midSocket, {
    type: 'sdkEvent', eventStreamId: 'room', roomEventSeq: 9, historySeq: 9, event: assistantEvent('mid 9'),
  });
  assert.equal(countText(midChat, 'mid 9'), 1, 'Live frames still render during hydration');
  await mergeServerSdkHistoryIntoRichView(midChat, serverTail, '', true, null, null);
  assert.deepEqual(
    nodeOrder(midChat),
    serverTail.map((record) => readAssistantText(record.event)),
    'The HTTP tail must fill the records the live frame jumped over, without duplicates',
  );
  midTransport.completeSdkHistoryHydration(midChat, serverTail);
  assert.equal(midChat._sdkHydrationLiveRoomSeqsByStream, undefined, 'Hydration coverage is dropped afterwards');
}

const paneSource = await import('node:fs').then((fs) => fs.readFileSync(
  new URL('../app_front/features/chat/views/chatPane.js', import.meta.url), 'utf8'));
const paneResetAt = paneSource.lastIndexOf('resetViewAppliedState(chat.id, chat);');
assert.ok(
  paneResetAt > -1 && paneResetAt < paneSource.indexOf('chat._sdkRichView = createSdkRichView('),
  'openTerminal must drop room watermarks before it creates a fresh rich view',
);

{
  const snapshotChat = { id: 'question-snapshot', cursorSessionId: 'snapshot-session' };
  snapshotChat._sdkRichView = createFakeView();
  let restored = [];
  snapshotChat._sdkRichView.syncPendingQuestions = (questions) => { restored = questions; };
  snapshotChat._sdkRichView.getPendingInteractiveCounts = () => ({ questions: restored.length, permissions: 0 });
  let historyRepairs = 0;
  const transport = createTransport(snapshotChat, { onSdkResume: () => { historyRepairs += 1; } });
  const socket = connectOpenSocket(transport, snapshotChat);
  const question = { type: 'opencode_question', requestId: 'live-question', questions: [{ question: 'Continue?' }] };
  emitSocketMessage(socket, { type: 'sdkRoomState', pendingQuestionCount: 1, pendingQuestions: [question] });
  assert.deepEqual(restored, [question], 'Missing card restores directly from the live snapshot');
  assert.equal(historyRepairs, 0, 'Restoring a live card needs no history replay');
  assert.equal(snapshotChat._awaitingInput, true);
  emitSocketMessage(socket, { type: 'sdkRoomState', pendingQuestionCount: 0, pendingQuestions: [] });
  assert.deepEqual(restored, []);
  assert.equal(snapshotChat._opencodePendingQuestion, null);
  assert.equal(snapshotChat._awaitingInput, false, 'Missed resolution must not leave a phantom question');
}

console.log('All chat-transport-history-hydration tests passed.');
