import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { createAgentRoomKernel } from '../lib/agent-harness/room-kernel.js';
import {
  createDelegationRecord,
  updateDelegationRecord,
} from '../lib/persist/delegations-persist.js';
import {
  DELEGATION_FINAL_REPORT_ERROR_CODE,
  trackSdkRoomRunOutcome,
} from '../lib/sdk/sdk-run-outcome.js';
import { buildOpenCodeRunErrorEvents } from '../lib/opencode/opencode-prompt-run.js';

const acceptedRunId = 'run-accepted';
const job = createDelegationRecord({
  parentChatId: crypto.randomUUID(),
  childChatId: crypto.randomUUID(),
  status: 'completed',
  runId: acceptedRunId,
  sourceKind: 'text',
});
const completed = updateDelegationRecord(job.id, {
  status: 'completed',
  finalReportAcceptedAt: '2026-09-19T13:16:00.000Z',
  finalReportRunId: acceptedRunId,
});
assert.ok(completed.finalReportAcceptedAt);
assert.equal(completed.finalReportRunId, acceptedRunId);

const persisted = [];
const outgoing = [];
const kernel = createAgentRoomKernel({
  transport: 'opencode',
  persistHistory: (_room, recs) => {
    persisted.push(...recs);
  },
  afterBroadcast: (room, payload) => {
    outgoing.push({ ...payload });
    trackSdkRoomRunOutcome(room, payload);
  },
});
const room = kernel.createRoomState({
  sessionKey: 'quiet-stop-sess',
  chatId: job.childChatId,
  delegationId: job.id,
});
kernel.rooms.set(room.sessionKey, room);

kernel.broadcastRoom(room, {
  type: 'sdkRunFinished',
  runId: acceptedRunId,
  status: 'cancelled',
  result: 'Run was cancelled before completion.',
});
const matching = outgoing[0];
assert.equal(matching.status, 'completed');
assert.equal(matching.lastErrorCode, DELEGATION_FINAL_REPORT_ERROR_CODE);
assert.equal(matching.result, '');
assert.equal(room.lastRunStatus, 'completed');
assert.equal(persisted.some((row) => row.rec.variant === 'runFinished' && row.rec.payload === 'reported'), true);

kernel.broadcastRoom(room, {
  type: 'sdkEvent',
  event: { type: 'status', status: 'cancelled', run_id: acceptedRunId },
});
const statusOut = outgoing.find((row) => row.type === 'sdkEvent');
assert.equal(statusOut.event.status, 'completed');
assert.equal(statusOut.event.lastErrorCode, DELEGATION_FINAL_REPORT_ERROR_CODE);

kernel.broadcastRoom(room, {
  type: 'sdkRunFinished',
  runId: 'run-later',
  status: 'cancelled',
  result: 'Run was cancelled before completion.',
});
const later = outgoing.find((row) => row.type === 'sdkRunFinished' && row.runId === 'run-later');
assert.equal(later.status, 'cancelled');
assert.equal(later.lastErrorCode, undefined);
assert.equal(room.lastRunStatus, 'cancelled');

// An aborted leftover OpenCode run reaches notify as completed, with no sdkError.
const liveNotifications = [];
const liveOutgoing = [];
const livePersisted = [];
const liveKernel = createAgentRoomKernel({
  transport: 'opencode',
  persistHistory: (_room, recs) => {
    livePersisted.push(...recs);
  },
  afterBroadcast: (_room, payload) => {
    liveOutgoing.push({ ...payload });
  },
  notifyRunFinished: (input) => {
    liveNotifications.push(input);
  },
});
const liveRoom = liveKernel.createRoomState({
  sessionKey: 'quiet-stop-live-sess',
  chatId: job.childChatId,
  delegationId: job.id,
});
liveRoom._interactiveClientSeen = true;
liveKernel.rooms.set(liveRoom.sessionKey, liveRoom);
for (const event of buildOpenCodeRunErrorEvents({
  runId: acceptedRunId,
  message: 'Aborted',
  cancelled: true,
  remaining: 0,
})) {
  liveKernel.broadcastRoom(liveRoom, event, { log: true });
}
assert.equal(liveNotifications.length, 1);
assert.equal(liveNotifications[0].status, 'completed');
assert.equal(liveOutgoing.some((row) => row.type === 'sdkError'), false);
const liveFinished = liveOutgoing.find((row) => row.type === 'sdkRunFinished');
assert.equal(liveFinished.status, 'completed');
assert.equal(liveFinished.lastErrorCode, DELEGATION_FINAL_REPORT_ERROR_CODE);
assert.equal(livePersisted.some((row) => row.rec.variant === 'runFinished' && row.rec.payload === 'reported'), true);

console.log('delegation-quiet-stop-kernel.test.js OK');
