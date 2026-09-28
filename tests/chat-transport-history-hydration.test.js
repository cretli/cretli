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
import {
  beginSdkHistoryHydration,
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

function createTransport(chat) {
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

console.log('All chat-transport-history-hydration tests passed.');
