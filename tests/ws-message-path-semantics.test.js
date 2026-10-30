// Pins the per-message WS path semantics (event order, replayBatch deliver,
// replayBatchEnd state clearing, hydration buffering, room watermarks) that the
// per-message cost work must preserve.
import assert from 'node:assert/strict';
import {
  CHAT_PING_INTERVAL_MS,
  CHAT_RECONNECT_DELAYS,
  CHAT_RECONNECT_MAX,
  WS_PATH_AGENT_SDK,
} from '../app_front/config.js';
import { createChatTransport } from '../app_front/features/chat/chatTransport.js';
import {
  beginSdkHistoryHydration,
  hasUnrenderedSdkRoomEventSeq,
  noteRenderedSdkRoomEvent,
  rememberUnrenderedSdkRoomEvent,
  shouldApplySdkRoomEvent,
} from '../app_front/features/chat/sdkEventReplayGuard.js';

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    FakeWebSocket.instances.push(this);
  }
  send() {}
  close() {}
}
globalThis.WebSocket = FakeWebSocket;
if (!globalThis.location) globalThis.location = { protocol: 'http:', host: '127.0.0.1:3011' };

const noop = () => {};
function makeChat(id, extra = {}) {
  const applied = [];
  const chat = {
    id,
    cursorSessionId: 's',
    _sdkEventStreamId: 'room',
    _sdkReplayTagged: true,
    _sdkRichView: {
      applied,
      applyEvent(event, meta) { applied.push({ text: event.text, replay: meta?.replay, seq: meta?.roomEventSeq }); },
      hasRenderedHistory: () => applied.length > 0,
      onHarnessBusy: noop,
      onHarnessIdle: noop,
      appendBusy: noop,
      appendBannerConnected: noop,
      onStreamReset: noop,
    },
    ...extra,
  };
  return chat;
}
function connect(chat) {
  const chats = [chat];
  const transport = createChatTransport({
    WS_PATH_AGENT_SDK, CHAT_RECONNECT_MAX, CHAT_RECONNECT_DELAYS, CHAT_PING_INTERVAL_MS,
    getChats: () => chats,
    getActiveChatId: () => chat.id,
    getMaintainSessionsEnabled: () => false,
    getChatActivityAt: () => Date.now(),
    getSkipCatchUpOnResume: () => false,
    appLogger: { log: noop },
    setChatStatus: noop,
    setAgentState: (c, state) => { c._agentState = state; },
    renderChatTerminalState: noop,
    buildCatchUpSignature: () => '',
    processAgentOutput: noop,
    processAgentOutputCatchUp: noop,
    updateAwaitingInput: noop,
    setLaunchCommand: noop,
    scrollChatTerminalToBottom: noop,
  });
  transport.ensureChatConnection(chat);
  const socket = chat.ws;
  socket.readyState = 1;
  socket.onopen?.();
  return { transport, socket };
}
const send = (socket, payload) => socket.onmessage({ data: JSON.stringify(payload) });
const sdkEvent = (seq, text) => ({
  type: 'sdkEvent', eventStreamId: 'room', roomEventSeq: seq, event: { type: 'assistant', text },
});

// 1. replayBatch delivers events in order, tags replay, skips non-objects, and
//    does not serialize each re-entered event (parsed fast path).
{
  const chat = makeChat('order');
  const { socket } = connect(chat);
  const realStringify = JSON.stringify;
  let stringifyCalls = 0;
  JSON.stringify = (...args) => { stringifyCalls += 1; return realStringify(...args); };
  try {
    send(socket, { type: 'replayBatchStart', totalEvents: 3 });
    assert.equal(chat._sdkReplayBatchActive, true);
    assert.equal(chat._sdkReplayBatchExpected, 3);
    const before = stringifyCalls;
    // `send` itself stringifies once for the outer frame.
    send(socket, { type: 'replayBatch', events: [sdkEvent(1, 'a'), null, 'junk', sdkEvent(2, 'b'), sdkEvent(3, 'c')] });
    assert.equal(stringifyCalls - before, 1, 'replay re-entry must not stringify each event');
  } finally {
    JSON.stringify = realStringify;
  }
  assert.deepEqual(chat._sdkRichView.applied.map((row) => row.text), ['a', 'b', 'c']);
  assert.equal(chat._sdkLastRoomEventSeq, 3);
  assert.deepEqual(chat._sdkHydratedRoomEventSeqByStream, { room: 3 });
}

// 2. Duplicate / out-of-order replay events are dropped by the room watermark.
{
  const chat = makeChat('dups');
  const { socket } = connect(chat);
  send(socket, { type: 'replayBatch', events: [sdkEvent(1, 'a'), sdkEvent(2, 'b')] });
  send(socket, { type: 'replayBatch', events: [sdkEvent(2, 'b'), sdkEvent(1, 'a'), sdkEvent(3, 'c')] });
  send(socket, sdkEvent(3, 'c-live'));
  send(socket, sdkEvent(4, 'd-live'));
  assert.deepEqual(chat._sdkRichView.applied.map((row) => row.text), ['a', 'b', 'c', 'd-live']);
}

// 3. The re-entered frame still exposes the serialized `data` lazily.
{
  const chat = makeChat('lazy');
  const { socket } = connect(chat);
  const seen = [];
  const original = socket.onmessage;
  socket.onmessage = (ev) => { seen.push(ev); original(ev); };
  send(socket, { type: 'replayBatch', events: [sdkEvent(1, 'a')] });
  const reentered = seen[1];
  assert.ok(reentered.parsed && reentered.parsed.replay === true);
  assert.deepEqual(JSON.parse(reentered.data), reentered.parsed);
}

// 4. During hydration replay events are buffered in order, then flushed in order.
{
  const chat = makeChat('hydrate');
  const { transport, socket } = connect(chat);
  beginSdkHistoryHydration(chat);
  send(socket, { type: 'replayBatch', events: [sdkEvent(1, 'a'), sdkEvent(2, 'b')] });
  assert.equal(chat._sdkRichView.applied.length, 0);
  assert.deepEqual(chat._sdkPendingRoomEvents.map((m) => m.roomEventSeq), [1, 2]);
  assert.ok(chat._sdkPendingRoomEvents.every((m) => m.replay === true));
  transport.completeSdkHistoryHydration(chat, []);
  assert.equal(chat._sdkHistoryHydrating, false);
  assert.equal(chat._sdkPendingRoomEvents, undefined);
  assert.deepEqual(chat._sdkRichView.applied.map((row) => row.text), ['a', 'b']);
}

// 5. replayBatchEnd clears the replay batch state and the WS replay wait state.
{
  const chat = makeChat('end', { _sdkAwaitingWsReplay: true });
  const { socket } = connect(chat);
  send(socket, { type: 'replayBatchStart', totalEvents: 5 });
  assert.equal(chat._sdkReplayBatchActive, true);
  send(socket, { type: 'replayBatchEnd' });
  assert.equal('_sdkReplayBatchActive' in chat, false);
  assert.equal('_sdkReplayBatchExpected' in chat, false);
  assert.notEqual(chat._sdkAwaitingWsReplay, true);
}

// 6. A replayed busy-asserting frame does not flip the chat busy state.
{
  const chat = makeChat('busy', { _sdkServerBusy: false, _sdkServerQueuedCount: 0, _agentState: 'idle' });
  const { socket } = connect(chat);
  send(socket, { type: 'replayBatch', events: [{ type: 'sdkBusy', busy: true }] });
  assert.equal(chat._sdkServerBusy, false);
  assert.equal(chat._agentState, 'idle');
  send(socket, { type: 'sdkBusy', busy: true });
  assert.equal(chat._sdkServerBusy, true);
}

// 7. Replay guard: in-place watermark, holes, and noteRendered semantics.
{
  const chat = { _sdkEventStreamId: 'room' };
  assert.equal(shouldApplySdkRoomEvent(chat, { roomEventSeq: 1 }), true);
  const map = chat._sdkHydratedRoomEventSeqByStream;
  assert.deepEqual(map, { room: 1 });
  assert.equal(shouldApplySdkRoomEvent(chat, { roomEventSeq: 1 }), false);
  assert.equal(shouldApplySdkRoomEvent(chat, { roomEventSeq: 2, eventStreamId: 'other' }), true);
  assert.deepEqual(chat._sdkHydratedRoomEventSeqByStream, { room: 1, other: 2 });
  assert.equal(chat._sdkLastRoomEventSeq, 1, 'foreign stream must not move the current-stream seq');
  assert.equal(shouldApplySdkRoomEvent(chat, { roomEventSeq: 3 }), true);
  assert.equal(chat._sdkLastRoomEventSeq, 3);

  noteRenderedSdkRoomEvent(chat, { roomEventSeq: 3 });
  assert.equal('_sdkUnrenderedRoomEventSeqsByStream' in chat, false);

  rememberUnrenderedSdkRoomEvent(chat, { roomEventSeq: 3 });
  assert.equal(hasUnrenderedSdkRoomEventSeq(chat, 'room', 3), true);
  assert.equal(shouldApplySdkRoomEvent(chat, { roomEventSeq: 3 }), true, 'hole must be re-applicable');
  noteRenderedSdkRoomEvent(chat, { roomEventSeq: 4 });
  assert.equal(hasUnrenderedSdkRoomEventSeq(chat, 'room', 3), true);
  noteRenderedSdkRoomEvent(chat, { roomEventSeq: 3 });
  assert.equal(hasUnrenderedSdkRoomEventSeq(chat, 'room', 3), false);
  assert.equal('_sdkUnrenderedRoomEventSeqsByStream' in chat, false);
}

console.log('ws-message-path-semantics: ok');
