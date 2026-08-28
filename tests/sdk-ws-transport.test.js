import assert from 'node:assert/strict';
import {
  BACKPRESSURE_DRAIN_MAX_WAIT_MS,
  chunkReplayPayloads,
  REPLAY_BATCH_SIZE,
  resolveBroadcastPriority,
  shouldSendToClient,
  WS_BACKPRESSURE_THRESHOLD_BYTES,
} from '../lib/sdk/sdk-ws-transport.js';

function createMockClient(bufferedAmount, readyState = 1) {
  return { readyState, bufferedAmount };
}

assert.equal(resolveBroadcastPriority({ type: 'sdkEvent' }), 'critical');
assert.equal(resolveBroadcastPriority({ type: 'sdkRunProgress' }), 'normal');
assert.equal(resolveBroadcastPriority({ type: 'sdkRunProgress' }, 'critical'), 'critical');

assert.equal(
  shouldSendToClient(createMockClient(WS_BACKPRESSURE_THRESHOLD_BYTES + 1), 'normal'),
  false
);
assert.equal(
  shouldSendToClient(createMockClient(WS_BACKPRESSURE_THRESHOLD_BYTES + 1), 'critical'),
  true
);
assert.equal(shouldSendToClient(createMockClient(0, 0), 'critical'), false);

const inputEntries = Array.from({ length: 53 }, (_, index) => ({
  payload: { type: 'sdkEvent', roomEventSeq: index + 1 },
}));
const actualBatches = chunkReplayPayloads(inputEntries, REPLAY_BATCH_SIZE);
assert.equal(actualBatches.length, Math.ceil(53 / REPLAY_BATCH_SIZE));
assert.equal(actualBatches[0].length, REPLAY_BATCH_SIZE);
assert.equal(actualBatches.at(-1).length, 53 % REPLAY_BATCH_SIZE || REPLAY_BATCH_SIZE);
assert.equal(actualBatches[0][0].replay, true);

assert.equal(typeof BACKPRESSURE_DRAIN_MAX_WAIT_MS, 'number');

console.log('All sdk-ws-transport tests passed.');
