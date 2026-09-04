import assert from 'node:assert/strict';
import {
  applySequencedRemoteRoomEvent,
  createSdkRemoteRoomStub,
  isSdkRemoteRoomStub,
} from '../lib/sdk/sdk-remote-room-stub.js';

const broadcasts = [];
const persists = [];

const room = createSdkRemoteRoomStub(
  'session-stub-1',
  { id: 'chat-1', title: 'Stub chat', model: 'auto', sdkMode: 'agent' },
  { instanceId: 'owner-node', eventStreamId: 'stream-owner', eventSeq: 4, busy: true },
  {
    cwd: '/tmp/workspace',
    modelId: 'auto',
    modelSelection: 'auto',
    apiKey: 'key',
    sdkMode: 'agent',
    onRunFinished: null,
  }
);

assert.equal(isSdkRemoteRoomStub(room), true);
assert.equal(room.ownerInstanceId, 'owner-node');
assert.equal(room.eventSeq, 4);
assert.equal(room.busy, true);

const applied = applySequencedRemoteRoomEvent(
  room,
  { type: 'sdkEvent', roomEventSeq: 5, eventStreamId: 'stream-owner', event: { type: 'text' } },
  {
    roomEventLogMax: 10,
    broadcast: (targetRoom, payload) => {
      broadcasts.push({ targetRoom, payload });
    },
    persist: (targetRoom, payload) => {
      persists.push({ targetRoom, payload });
    },
  }
);
assert.equal(applied, true);
assert.equal(room.eventSeq, 5);
assert.equal(broadcasts.length, 1);
assert.equal(persists.length, 0);

const duplicate = applySequencedRemoteRoomEvent(room, { type: 'sdkEvent', roomEventSeq: 5 }, {
  roomEventLogMax: 10,
  broadcast: () => broadcasts.push('dup'),
});
assert.equal(duplicate, false);
assert.equal(broadcasts.length, 1);

applySequencedRemoteRoomEvent(room, { type: 'sdkRoomState', roomEventSeq: 6, busy: false }, {
  roomEventLogMax: 10,
  broadcast: () => {},
});
assert.equal(room.busy, false);

console.log('All sdk-remote-room-stub tests passed.');
