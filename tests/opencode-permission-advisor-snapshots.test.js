/**
 * OpenCode permission advisor snapshot cleanup — pending removal and replay payloads.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  broadcastPermissionAdvisorStatus,
  getPendingAdvisorReplayPayloads,
  removePendingOpenCodePermission,
} from '../lib/opencode/opencode-agent-ws.js';
import { buildOpenCodePermissionAdvisorStatusPayload } from '../lib/approval/approval-advisor.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const opencodeWs = fs.readFileSync(path.join(projectRoot, 'lib/opencode/opencode-agent-ws.js'), 'utf8');

assert.match(opencodeWs, /function removePendingOpenCodePermission/);
assert.match(opencodeWs, /reason: 'session_pin_mismatch'/);
assert.match(opencodeWs, /broadcastAdvisorSkippedIfPending[\s\S]{0,200}'session_changed'/);
assert.match(opencodeWs, /forgetPermissionAdvisorStatus\(room, requestId\)[\s\S]{0,120}broadcastAdvisorSkippedIfPending/);
assert.match(opencodeWs, /reason: 'permission_gone_late'/);
assert.match(opencodeWs, /forgetPermissionAdvisorStatus\(room, requestId\)[\s\S]{0,200}reason: 'permission_gone_late'/);
assert.match(opencodeWs, /listOpenCodePermissionIdsForFailedTool[\s\S]{0,400}removePendingOpenCodePermission/);
assert.match(opencodeWs, /settleOpenCodePromptRunAfterAbort[\s\S]{0,500}forgetPermissionAdvisorStatus/);
assert.match(opencodeWs, /resetSession === true[\s\S]{0,120}reconcileAdvisorSnapshotsAfterSessionReset/);
assert.match(opencodeWs, /approvalActionSnapshot: captureApprovalActionSnapshot/);
assert.match(opencodeWs, /pending\?\.approvalActionSnapshot/);

const room = {
  _pendingOpenCodePermissions: new Map([['perm_a', { requestId: 'perm_a' }]]),
  _approvalAdvisorStatusByRequestId: new Map([
    ['perm_a', { type: 'opencodePermissionAdvisorStatus', status: 'checking', requestId: 'perm_a' }],
    ['perm_b', { type: 'opencodePermissionAdvisorStatus', status: 'decided', requestId: 'perm_b' }],
  ]),
  _approvalAdvisorSessionPins: new Map([['perm_a', { sessionId: 's1' }], ['perm_b', { sessionId: 's2' }]]),
};

assert.deepEqual(getPendingAdvisorReplayPayloads(room).map((p) => p.status), ['checking']);

removePendingOpenCodePermission(room, 'perm_a');
assert.equal(room._pendingOpenCodePermissions.has('perm_a'), false);
assert.equal(room._approvalAdvisorStatusByRequestId.has('perm_a'), false);
assert.equal(room._approvalAdvisorSessionPins.has('perm_a'), false);
assert.deepEqual(getPendingAdvisorReplayPayloads(room), []);

room._pendingOpenCodePermissions.set('perm_c', { requestId: 'perm_c' });
room._approvalAdvisorStatusByRequestId.set('perm_c', {
  type: 'opencodePermissionAdvisorStatus',
  status: 'skipped',
  reason: 'session_changed',
  requestId: 'perm_c',
});
const replay = getPendingAdvisorReplayPayloads(room);
assert.equal(replay.length, 1);
assert.equal(replay[0].status, 'skipped');
assert.equal(replay[0].reason, 'session_changed');
assert.notEqual(replay[0].status, 'checking');

const permEvent = { requestId: 'perm_human_first', action: 'read' };
const approvalAction = { risk: 'low', categories: [] };
const plan = { protocol: 'systemone', model: 'test-advisor', role: 'advisory' };

function advisorPayload(status, requestId = 'perm_human_first', extra = {}) {
  return buildOpenCodePermissionAdvisorStatusPayload({
    requestId,
    status,
    permissionEvent: permEvent,
    approvalAction,
    plan,
    ...extra,
  });
}

const leakRoom = {
  chatId: 'chat-leak-test',
  eventStreamId: 'stream-leak',
  _pendingOpenCodePermissions: new Map([['perm_human_first', permEvent]]),
  _approvalAdvisorStatusByRequestId: new Map(),
};

broadcastPermissionAdvisorStatus(leakRoom, advisorPayload('checking'));
assert.equal(leakRoom._approvalAdvisorStatusByRequestId.has('perm_human_first'), true);

removePendingOpenCodePermission(leakRoom, 'perm_human_first');
assert.equal(leakRoom._pendingOpenCodePermissions.has('perm_human_first'), false);
assert.equal(leakRoom._approvalAdvisorStatusByRequestId.has('perm_human_first'), false);

broadcastPermissionAdvisorStatus(leakRoom, advisorPayload('decided', 'perm_human_first', {
  advisorDecision: 'ask_user',
  finalDecision: 'ask_user',
}));
assert.equal(
  leakRoom._approvalAdvisorStatusByRequestId.has('perm_human_first'),
  false,
  'final advisor broadcast after human resolve must not re-store snapshot',
);

broadcastPermissionAdvisorStatus(leakRoom, advisorPayload('error', 'perm_human_first', {
  reason: 'advisor_run_exception',
}));
assert.equal(leakRoom._approvalAdvisorStatusByRequestId.has('perm_human_first'), false);

const replayRoom = {
  chatId: 'chat-replay',
  eventStreamId: 'stream-replay',
  _pendingOpenCodePermissions: new Map([['perm_still', permEvent]]),
  _approvalAdvisorStatusByRequestId: new Map(),
};
broadcastPermissionAdvisorStatus(replayRoom, advisorPayload('decided', 'perm_still'));
assert.equal(replayRoom._approvalAdvisorStatusByRequestId.get('perm_still')?.status, 'decided');
assert.equal(getPendingAdvisorReplayPayloads(replayRoom).length, 1);

console.log('opencode-permission-advisor-snapshots.test.js OK');
