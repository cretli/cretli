import assert from 'node:assert/strict';
import {
  buildSdkRoomStatePayload,
  computeRoomEventSeqGap,
  formatRoomEventSeqDiag,
  resolveAgentStateFromRoomState,
  ROOM_STATE_HEARTBEAT_INTERVAL_MS,
  shouldSyncHistoryFromRoomState,
} from '../lib/sdk/sdk-room-state.js';

const inputRoom = {
  eventStreamId: 'stream-1',
  eventSeq: 42,
  busy: true,
  currentRun: { id: 'run-1' },
  lastRunId: 'run-1',
  lastRunStatus: 'error',
  pendingPrompts: [{ text: 'queued' }],
  clients: new Set([{}, {}]),
};
const actualPayload = buildSdkRoomStatePayload(inputRoom);
assert.equal(actualPayload.type, 'sdkRoomState');
assert.equal(actualPayload.eventStreamId, 'stream-1');
assert.equal(actualPayload.lastRoomEventSeq, 42);
assert.equal(actualPayload.runId, 'run-1');
assert.equal(actualPayload.lastRunId, 'run-1');
assert.equal(actualPayload.lastRunStatus, 'error');
assert.equal(actualPayload.queuedCount, 1);
assert.equal(actualPayload.clientCount, 2);
assert.equal(actualPayload.busy, true);

const openCodeRoom = {
  ...inputRoom,
  transport: 'opencode',
  _pendingOpenCodeQuestions: new Map([['q1', {}]]),
  _pendingOpenCodePermissions: new Map([['p1', {}]]),
  lastEventAt: 999,
};
const openCodeState = buildSdkRoomStatePayload(openCodeRoom);
assert.equal(openCodeState.pendingQuestionCount, 1);
assert.equal(openCodeState.pendingPermissionCount, 1);
assert.equal(openCodeState.transport, 'opencode');
assert.equal(openCodeState.lastEventAt, 999);

assert.equal(resolveAgentStateFromRoomState('idle', actualPayload), 'active');
assert.equal(
  resolveAgentStateFromRoomState('idle', {
    type: 'sdkRoomState',
    busy: false,
    queuedCount: 0,
    pendingQuestionCount: 1,
    pendingPermissionCount: 0,
  }),
  'active'
);
assert.equal(
  resolveAgentStateFromRoomState('idle', {
    type: 'sdkRoomState',
    busy: false,
    queuedCount: 0,
    pendingQuestionCount: 0,
    pendingPermissionCount: 2,
  }),
  'active'
);
assert.equal(
  resolveAgentStateFromRoomState('idle', { type: 'sdkRoomState', busy: false, queuedCount: 0 }),
  'idle'
);
assert.equal(shouldSyncHistoryFromRoomState({ _sdkLastRoomEventSeq: 10 }, actualPayload), true);
assert.equal(shouldSyncHistoryFromRoomState({ _sdkLastRoomEventSeq: 42 }, actualPayload), false);
assert.equal(
  shouldSyncHistoryFromRoomState({ _sdkHistoryHydrating: true, _sdkLastRoomEventSeq: 1 }, actualPayload),
  false
);
assert.equal(typeof ROOM_STATE_HEARTBEAT_INTERVAL_MS, 'number');

assert.equal(computeRoomEventSeqGap(10, 12), 2);
assert.equal(computeRoomEventSeqGap(12, 12), 0);
assert.equal(computeRoomEventSeqGap(null, 5), 5);
const expectedSynced = formatRoomEventSeqDiag(42, 42);
assert.equal(expectedSynced.gap, 0);
assert.equal(expectedSynced.isSynced, true);
const expectedGap = formatRoomEventSeqDiag(8, 12);
assert.equal(expectedGap.gap, 4);
assert.equal(expectedGap.gapLabel, '4');

console.log('All sdk-room-state tests passed.');
