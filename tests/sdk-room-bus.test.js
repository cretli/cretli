import assert from 'node:assert/strict';
import {
  getSdkRoomBusMode,
  getServerInstanceId,
  initSdkRoomBus,
  publishSdkRoomEvent,
  shutdownSdkRoomBus,
} from '../lib/sdk/sdk-room-bus.js';

const received = [];

const initResult = await initSdkRoomBus({
  onRemoteEvent: (sessionKey, payload) => {
    received.push({ sessionKey, payload });
  },
});

assert.equal(initResult.mode, 'local');
assert.equal(getSdkRoomBusMode(), 'local');
assert.equal(typeof getServerInstanceId(), 'string');
assert.ok(getServerInstanceId().length > 0);

publishSdkRoomEvent('session-1', { type: 'sdkEvent', roomEventSeq: 1 });
assert.equal(received.length, 0);

await shutdownSdkRoomBus();

console.log('All sdk-room-bus tests passed.');
