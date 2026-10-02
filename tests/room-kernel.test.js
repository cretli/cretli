import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  broadcastToRoomClients,
  createAgentRoomKernel,
  mapWsPayloadToHistoryRecord,
  MAX_EVENT_LOG,
  pushRoomEvent,
  ROOM_EMPTY_GRACE_MS,
} from '../lib/agent-harness/room-kernel.js';
import { WS_BACKPRESSURE_THRESHOLD_BYTES } from '../lib/sdk/sdk-ws-transport.js';

assert.equal(ROOM_EMPTY_GRACE_MS, 90_000);
assert.equal(MAX_EVENT_LOG, 1200);

const inputError = mapWsPayloadToHistoryRecord(
  'sdkError',
  { type: 'sdkError', message: ' boom ' },
  { harness: 'openrouter' },
);
assert.equal(inputError?.rec.variant, 'error');
assert.equal(inputError?.rec.payload, 'boom');
assert.equal(inputError?.flushNow, true);

const inputMode = mapWsPayloadToHistoryRecord(
  'sdkMode',
  { type: 'sdkMode', mode: 'plan' },
  { harness: 'openrouter' },
);
assert.equal(inputMode?.rec.payload, 'plan');

const inputAskMode = mapWsPayloadToHistoryRecord(
  'sdkMode',
  { type: 'sdkMode', mode: 'ask' },
  { harness: 'openrouter' },
);
assert.equal(inputAskMode?.rec.payload, 'ask');

const inputIgnored = mapWsPayloadToHistoryRecord('sdkBusy', { type: 'sdkBusy' }, { harness: 'openrouter' });
assert.equal(inputIgnored, null);

const inputOpenCodeQuestionResolved = mapWsPayloadToHistoryRecord(
  'opencodeQuestionResolved',
  { type: 'opencodeQuestionResolved', requestId: 'q-op-1' },
  { harness: 'opencode' },
);
assert.equal(inputOpenCodeQuestionResolved?.rec.variant, 'questionResolved');
assert.equal(inputOpenCodeQuestionResolved?.rec.payload.requestId, 'q-op-1');
assert.equal(inputOpenCodeQuestionResolved?.rec.payload.status, 'answered');

const inputRoom = { eventStreamId: 'stream-1', eventLog: [] };
const actualPushed = pushRoomEvent(inputRoom, { type: 'sdkBusy', busy: true }, 2);
assert.equal(actualPushed.roomEventSeq, 1);
pushRoomEvent(inputRoom, { type: 'sdkBusy', busy: false }, 2);
pushRoomEvent(inputRoom, { type: 'sdkPromptStarted' }, 2);
assert.equal(inputRoom.eventLog.length, 2);
assert.equal(inputRoom.eventLog[0].seq, 2);

const sent = [];
const readyClient = Object.assign(new EventEmitter(), {
  readyState: 1,
  bufferedAmount: 0,
  send(msg) {
    sent.push(JSON.parse(msg));
  },
});
const slowClient = {
  readyState: 1,
  bufferedAmount: WS_BACKPRESSURE_THRESHOLD_BYTES + 1,
  send() {
    throw new Error('should skip backpressure');
  },
};
broadcastToRoomClients({ clients: new Set([readyClient, slowClient]) }, { type: 'ping' });
assert.equal(sent.length, 1);
assert.equal(sent[0].type, 'ping');

const persisted = [];
const aborted = [];
const kernel = createAgentRoomKernel({
  transport: 'openrouter',
  graceMs: 25,
  persistHistory: (_room, recs) => {
    persisted.push(...recs);
  },
  abortRoom: (room) => {
    aborted.push(room.sessionKey);
  },
});
const room = kernel.createRoomState({ sessionKey: 'sess-1', chatId: 'chat-1' });
kernel.rooms.set('sess-1', room);
kernel.attachClient(room, readyClient);
const modePersisted = [];
const modeKernel = createAgentRoomKernel({
  transport: 'codex',
  persistHistory: (_room, recs) => modePersisted.push(...recs),
});
const modeRoom = modeKernel.createRoomState({ sessionKey: 'mode-sess', chatId: 'mode-chat', sdkMode: 'agent' });
modeKernel.applySdkModeIfChanged(modeRoom, 'agent', {
  updateChat: () => assert.fail('no-op mode change must not update chat'),
});
assert.equal(modePersisted.length, 0);
assert.equal(modeKernel.applySdkModeIfChanged(modeRoom, 'plan'), true);
assert.equal(modePersisted.length, 1);
assert.equal(modePersisted[0].rec.payload, 'plan');
assert.equal(modePersisted[0].rec.roomEventSeq, 1);
kernel.broadcastRoom(room, { type: 'sdkEvent', event: { type: 'assistant' } });
kernel.broadcastRoom(room, { type: 'sdkError', message: 'failed' });
kernel.flushPersistBuffer(room);
assert.equal(persisted.some((row) => row.rec.kind === 'sdk'), true);
assert.equal(persisted.some((row) => row.rec.variant === 'error'), true);
assert.equal(room.transport, 'openrouter');

kernel.detachClient(room, readyClient, 'sess-1');
assert.ok(room._shutdownTimer);
room.busy = true;
await new Promise((resolve) => setTimeout(resolve, 40));
assert.equal(kernel.rooms.has('sess-1'), true);
room.busy = false;
room.serverHold = true;
await new Promise((resolve) => setTimeout(resolve, 40));
assert.equal(kernel.rooms.has('sess-1'), true);
room.serverHold = false;
await new Promise((resolve) => setTimeout(resolve, 40));
assert.equal(kernel.rooms.has('sess-1'), false);
assert.deepEqual(aborted, ['sess-1']);

// Agent-finished push wiring: every kernel harness notifies on sdkRunFinished,
// except server-started runs (delegation/headless/mailbox) which keep SDK parity.
const finishedCalls = [];
const notifyKernel = createAgentRoomKernel({
  transport: 'qwen',
  persistHistory: () => {},
  recordUsage: () => null,
  notifyRunFinished: (input) => {
    finishedCalls.push(input);
  },
});
const interactiveRoom = notifyKernel.createRoomState({
  sessionKey: 's-int',
  chatId: 'chat-int',
  chatTitle: 'Interactive chat',
  _interactiveClientSeen: true,
});
notifyKernel.broadcastRoom(interactiveRoom, {
  type: 'sdkRunFinished',
  status: 'completed',
  runId: 'run-int',
});
assert.equal(finishedCalls.length, 1);
assert.equal(finishedCalls[0].chatId, 'chat-int');
assert.equal(finishedCalls[0].chatTitle, 'Interactive chat');
assert.equal(finishedCalls[0].status, 'completed');

// Delegation children have no interactive client: SDK parity means no push.
const delegationRoom = notifyKernel.createRoomState({
  sessionKey: 's-del',
  chatId: 'chat-del',
  delegationId: 'delegation-1',
});
notifyKernel.broadcastRoom(delegationRoom, {
  type: 'sdkRunFinished',
  status: 'completed',
  runId: 'run-del',
});
assert.equal(finishedCalls.length, 1, 'headless delegation runs must not push');

// Mailbox/headless server-started runs without a client also stay silent.
const serverHeldRoom = notifyKernel.createRoomState({
  sessionKey: 's-hold',
  chatId: 'chat-hold',
  serverHold: true,
});
notifyKernel.broadcastRoom(serverHeldRoom, {
  type: 'sdkRunFinished',
  status: 'completed',
  runId: 'run-hold',
});
assert.equal(finishedCalls.length, 1, 'server-started runs without a client must not push');

// A user watching a delegation child arms the push, exactly like the SDK room
// keeping `onRunFinished` after a WS connection.
const watchedDelegationRoom = notifyKernel.createRoomState({
  sessionKey: 's-del-watch',
  chatId: 'chat-del-watch',
  delegationId: 'delegation-2',
  _interactiveClientSeen: true,
});
notifyKernel.broadcastRoom(watchedDelegationRoom, {
  type: 'sdkRunFinished',
  status: 'completed',
  runId: 'run-del-watch',
});
assert.equal(finishedCalls.length, 2, 'a watched room keeps SDK push semantics');

console.log('All room-kernel tests passed.');
