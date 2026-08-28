import assert from 'node:assert/strict';
import {
  buildSdkRoomOwnerMeta,
  getSdkRoomRegistryMode,
  initSdkRoomRegistry,
  parseSdkRoomOwnerRecord,
  resolveSdkRoomOwnerTtlSec,
} from '../lib/sdk/sdk-room-registry.js';
import { getServerInstanceId, resetServerInstanceIdForTests } from '../lib/sdk/sdk-instance-id.js';

resetServerInstanceIdForTests();
process.env.CURSOR_REMOTE_INSTANCE_ID = 'registry-test-instance';

initSdkRoomRegistry(null);
assert.equal(getSdkRoomRegistryMode(), 'local');

const parsed = parseSdkRoomOwnerRecord(
  JSON.stringify({
    instanceId: 'node-a',
    eventStreamId: 'stream-1',
    eventSeq: 12,
    busy: true,
    updatedAt: 1000,
  })
);
assert.equal(parsed?.instanceId, 'node-a');
assert.equal(parsed?.eventSeq, 12);
assert.equal(parsed?.busy, true);

const invalid = parseSdkRoomOwnerRecord('{not-json');
assert.equal(invalid, null);

const meta = buildSdkRoomOwnerMeta({
  eventStreamId: 'stream-2',
  eventSeq: 3,
  busy: false,
});
assert.equal(meta.instanceId, getServerInstanceId());
assert.equal(meta.eventStreamId, 'stream-2');
assert.equal(meta.eventSeq, 3);

assert.equal(resolveSdkRoomOwnerTtlSec(), 120);
process.env.CURSOR_REMOTE_SDK_ROOM_OWNER_TTL_SEC = '45';
assert.equal(resolveSdkRoomOwnerTtlSec(), 45);
delete process.env.CURSOR_REMOTE_SDK_ROOM_OWNER_TTL_SEC;
delete process.env.CURSOR_REMOTE_INSTANCE_ID;

console.log('All sdk-room-registry tests passed.');
