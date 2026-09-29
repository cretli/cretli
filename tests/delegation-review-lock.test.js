import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { addChat, loadChats } from '../lib/persist/chats-persist.js';
import {
  createDelegationRecord,
  updateDelegationRecord,
} from '../lib/persist/delegations-persist.js';
import {
  bindRoomToDelegation,
  noteDelegationRoomEvent,
  syncRoomDelegationAssignment,
} from '../lib/delegation-run-bridge.js';
import { resolvePlanModeToolDecision } from '../lib/sdk/sdk-plan-guard.js';
import { resolveOpenCodeApprovalAction } from '../lib/opencode/opencode-permission.js';

const parent = addChat('sess-review-lock-parent', 'Parent', null, '/tmp', 'model', {
  agentTransport: 'codex',
  sdkMode: 'agent',
});
const child = addChat('sess-review-lock-child', 'Child (review)', null, '/tmp', 'model', {
  agentTransport: 'codex',
  sdkMode: 'agent',
  forkParentChatId: parent.id,
  forkKind: 'delegation',
  delegationParentChatId: parent.id,
  delegationAssignment: 'review',
});
const job = createDelegationRecord({
  parentChatId: parent.id,
  childChatId: child.id,
  status: 'running',
  assignment: 'review',
  executionMode: 'agent',
  sourceKind: 'text',
  taskText: 'Review only.',
});

const room = {
  chatId: child.id,
  delegationAssignment: '',
  sdkMode: 'agent',
};
bindRoomToDelegation(room, {
  delegationId: job.id,
  attemptId: job.attemptId,
  assignment: 'review',
});
assert.equal(room.delegationAssignment, 'review');
assert.equal(
  resolvePlanModeToolDecision({
    transport: 'codex',
    mode: 'agent',
    assignment: room.delegationAssignment,
    toolName: 'shell',
    input: { command: 'python3 -c "open(\'x\',\'w\').write(\'a\')"' },
  }).deny,
  true,
);

updateDelegationRecord(job.id, { status: 'completed' });
assert.equal(syncRoomDelegationAssignment(room), '');
assert.equal(room.delegationAssignment, '');
assert.equal(
  loadChats().find((row) => row.id === child.id)?.delegationAssignment,
  undefined,
);
assert.equal(
  resolvePlanModeToolDecision({
    transport: 'codex',
    mode: 'agent',
    assignment: room.delegationAssignment,
    toolName: 'shell',
    input: { command: 'python3 -c "open(\'x\',\'w\').write(\'a\')"' },
  }).deny,
  false,
);

const sticky = {
  chatId: child.id,
  delegationId: job.id,
  delegationAssignment: 'review',
};
noteDelegationRoomEvent(sticky, { type: 'sdkRunFinished', status: 'completed', runId: 'follow-up' });
assert.equal(sticky.delegationAssignment, '');

// --- reattach hydration from the persisted child chat (no deps meta) --------

const reattachParent = addChat('sess-reattach-parent', 'Parent reattach', null, '/tmp', 'model', {
  agentTransport: 'opencode',
  sdkMode: 'agent',
});

const activeChildId = 'sess-reattach-active';
const activeJob = createDelegationRecord({
  parentChatId: reattachParent.id,
  childChatId: activeChildId,
  status: 'running',
  assignment: 'review',
  executionMode: 'agent',
  sourceKind: 'text',
  taskText: 'Review only.',
});
addChat(activeChildId, 'Child (review active)', null, '/tmp', 'model', {
  id: activeChildId,
  agentTransport: 'opencode',
  sdkMode: 'agent',
  forkKind: 'delegation',
  delegationAssignment: 'review',
  delegationId: activeJob.id,
});
const reattachRoom = { chatId: activeChildId, sdkMode: 'agent' };
bindRoomToDelegation(reattachRoom, {});
assert.equal(reattachRoom.delegationId, activeJob.id);
assert.equal(reattachRoom.delegationAttemptId, activeJob.attemptId);
assert.equal(reattachRoom.delegationAssignment, 'review');
assert.equal(reattachRoom.serverHold, true);
assert.equal(
  resolveOpenCodeApprovalAction({
    mode: 'off',
    sdkMode: 'agent',
    permissionEvent: { action: 'bash', metadata: { command: 'git diff --stat' } },
    assignment: reattachRoom.delegationAssignment,
    workspaceFolder: '/tmp',
  }).reply,
  'once',
  'hydrated review room keeps the off-mode read auto-allow',
);
assert.equal(
  resolveOpenCodeApprovalAction({
    mode: 'off',
    sdkMode: 'agent',
    permissionEvent: { action: 'bash', metadata: { command: 'rm -rf data' } },
    assignment: reattachRoom.delegationAssignment,
    workspaceFolder: '/tmp',
  }).decision,
  'deny',
  'hydrated review room still rejects mutations',
);

// `cancelling` is still an active job, so the room keeps its assignment.
const cancellingChildId = 'sess-reattach-cancelling';
const cancellingJob = createDelegationRecord({
  parentChatId: reattachParent.id,
  childChatId: cancellingChildId,
  status: 'cancelling',
  assignment: 'review',
  executionMode: 'agent',
  sourceKind: 'text',
  taskText: 'Review only.',
});
addChat(cancellingChildId, 'Child (review cancelling)', null, '/tmp', 'model', {
  id: cancellingChildId,
  agentTransport: 'opencode',
  sdkMode: 'agent',
  forkKind: 'delegation',
  delegationAssignment: 'review',
  delegationId: cancellingJob.id,
});
const cancellingRoom = { chatId: cancellingChildId };
bindRoomToDelegation(cancellingRoom, {});
assert.equal(cancellingRoom.delegationId, cancellingJob.id);
assert.equal(cancellingRoom.delegationAssignment, 'review');

// A terminal job must not adopt the reattached room.
const terminalChildId = 'sess-reattach-terminal';
const terminalJob = createDelegationRecord({
  parentChatId: reattachParent.id,
  childChatId: terminalChildId,
  status: 'completed',
  assignment: 'review',
  executionMode: 'agent',
  sourceKind: 'text',
  taskText: 'Review only.',
});
addChat(terminalChildId, 'Child (review done)', null, '/tmp', 'model', {
  id: terminalChildId,
  agentTransport: 'opencode',
  sdkMode: 'agent',
  forkKind: 'delegation',
  delegationAssignment: 'review',
  delegationId: terminalJob.id,
});
const terminalRoom = { chatId: terminalChildId, delegationAssignment: 'review' };
bindRoomToDelegation(terminalRoom, {});
assert.equal(terminalRoom.delegationId, undefined);
assert.equal(terminalRoom.delegationAssignment, '');
assert.equal(
  loadChats().find((row) => row.id === terminalChildId)?.delegationAssignment,
  undefined,
  'terminal job clears the persisted assignment',
);

// A record that does not own this chat must not adopt the room either.
const mismatchChildId = 'sess-reattach-mismatch';
const mismatchJob = createDelegationRecord({
  parentChatId: reattachParent.id,
  childChatId: 'sess-reattach-foreign',
  status: 'running',
  assignment: 'review',
  executionMode: 'agent',
  sourceKind: 'text',
  taskText: 'Review only.',
});
addChat(mismatchChildId, 'Child (mismatch)', null, '/tmp', 'model', {
  id: mismatchChildId,
  agentTransport: 'opencode',
  sdkMode: 'agent',
  delegationId: mismatchJob.id,
});
const mismatchRoom = { chatId: mismatchChildId, delegationAssignment: 'review' };
bindRoomToDelegation(mismatchRoom, {});
assert.equal(mismatchRoom.delegationId, undefined);
assert.equal(mismatchRoom.delegationAssignment, '');

// --- UI room binds before the worker delegation exists ----------------------

const uiFirstChildId = 'sess-ui-before-worker';
addChat(uiFirstChildId, 'Child (UI before worker)', null, '/tmp', 'model', {
  id: uiFirstChildId,
  agentTransport: 'opencode',
  sdkMode: 'agent',
  forkKind: 'delegation',
});
const uiRoom = { chatId: uiFirstChildId, sdkMode: 'agent' };
// No deps meta and no active job yet: the room must not guess an assignment.
bindRoomToDelegation(uiRoom, {});
assert.equal(uiRoom.delegationId, undefined);
assert.equal(uiRoom.delegationAssignment, '');
assert.equal(uiRoom.serverHold, undefined);

// The worker then starts the review job and binds its meta; the room adopts it.
const uiJob = createDelegationRecord({
  parentChatId: reattachParent.id,
  childChatId: uiFirstChildId,
  status: 'running',
  assignment: 'review',
  executionMode: 'agent',
  sourceKind: 'text',
  taskText: 'Review only.',
});
bindRoomToDelegation(uiRoom, {
  delegationId: uiJob.id,
  attemptId: uiJob.attemptId,
  assignment: 'review',
});
assert.equal(uiRoom.delegationId, uiJob.id);
assert.equal(uiRoom.delegationAttemptId, uiJob.attemptId);
assert.equal(uiRoom.delegationAssignment, 'review');
assert.equal(uiRoom.serverHold, true);

console.log('delegation-review-lock.test.js OK');
