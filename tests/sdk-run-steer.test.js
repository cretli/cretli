import assert from 'node:assert/strict';
import {
  STEER_ACK_DELIVERED,
  STEER_ACK_REVERT,
  SDK_STEER_ERROR_CODES,
  buildSdkSteerAckPayload,
  buildSdkSteerErrorPayload,
  requestSdkRunSteer,
  supportsSdkRunSteer,
} from '../lib/sdk/sdk-run-steer.js';

assert.equal(buildSdkSteerAckPayload({ outcome: STEER_ACK_DELIVERED }).outcome, STEER_ACK_DELIVERED);
assert.equal(buildSdkSteerAckPayload({ outcome: 'other' }).outcome, STEER_ACK_REVERT);

{
  const run = {
    id: 'run-1',
    async steer(text) {
      assert.equal(text, 'hello');
      return STEER_ACK_DELIVERED;
    },
  };
  const delivered = await requestSdkRunSteer({ run, busy: true, text: 'hello' });
  assert.equal(delivered.status, 'delivered');
  assert.equal(delivered.outcome, STEER_ACK_DELIVERED);
}

{
  const run = {
    id: 'run-2',
    async steer() {
      return STEER_ACK_REVERT;
    },
  };
  const reverted = await requestSdkRunSteer({ run, busy: true, text: 'follow up' });
  assert.equal(reverted.status, 'queued');
}

{
  const run = {
    id: 'run-3',
    async steer() {
      throw new Error('transport glitch');
    },
  };
  const queued = await requestSdkRunSteer({ run, busy: true, text: 'retry me' });
  assert.equal(queued.status, 'queued');
  assert.equal(queued.code, SDK_STEER_ERROR_CODES.DELIVERY_FAILED);
}

{
  const unsupported = await requestSdkRunSteer({
    run: { id: 'run-4', agentId: 'local-1' },
    busy: true,
    text: 'x',
  });
  assert.equal(unsupported.status, 'rejected');
  assert.equal(unsupported.code, SDK_STEER_ERROR_CODES.UNSUPPORTED);
}

{
  const cloud = await requestSdkRunSteer({
    run: { id: 'run-5', agentId: 'bc-cloud', steer() {} },
    busy: true,
    text: 'x',
  });
  assert.equal(cloud.status, 'rejected');
  assert.equal(cloud.code, SDK_STEER_ERROR_CODES.CLOUD_RUN);
}

{
  const remote = await requestSdkRunSteer({
    run: { id: 'run-6', steer() {} },
    busy: true,
    remoteRoom: true,
    text: 'x',
  });
  assert.equal(remote.status, 'rejected');
  assert.equal(remote.code, SDK_STEER_ERROR_CODES.REMOTE_ROOM);
}

{
  const empty = await requestSdkRunSteer({ run: { steer() {} }, busy: true, text: '   ' });
  assert.equal(empty.status, 'rejected');
  assert.equal(empty.code, SDK_STEER_ERROR_CODES.EMPTY_TEXT);
}

assert.equal(supportsSdkRunSteer({ steer() {} }), true);
assert.equal(supportsSdkRunSteer({}), false);

assert.equal(
  buildSdkSteerErrorPayload({ code: SDK_STEER_ERROR_CODES.NO_ACTIVE_RUN, message: 'nope' }).type,
  'sdkSteerError'
);

console.log('sdk-run-steer.test.js: ok');
