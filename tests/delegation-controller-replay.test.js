/**
 * Controller model (leaf S1): idempotent replay and chat deletion on fixtures
 * where `controllerChatId` differs from the historical `parentChatId`.
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { addChat } from '../lib/persist/chats-persist.js';
import { writeChatPlanFile, readChatPlanDocument } from '../lib/chat-plan-persist.js';
import { createDelegationService } from '../lib/delegation-service.js';
import {
  createDelegationRecord,
  getDelegationById,
  updateDelegationRecord,
} from '../lib/persist/delegations-persist.js';
import { registerMockChatRunAdapter, resetMockChatRuns } from '../lib/chat-run/mock-adapter.js';
import { registerChatRunAdapter } from '../lib/chat-run-service.js';

const project = mkdtempSync(path.join(os.tmpdir(), 'cr-ctl-replay-'));
const service = createDelegationService({
  workspaceDirForAgent: () => project,
  isModelAvailable: () => true,
});

test.beforeEach(() => {
  resetMockChatRuns();
  registerMockChatRunAdapter('opencode');
});

function createPlanChat(title) {
  const chat = addChat(`sess-${title}`, title, null, project, 'planner-model', {
    agentTransport: 'opencode',
    sdkMode: 'plan',
  });
  writeChatPlanFile({
    cwd: project,
    chatId: chat.id,
    title: 'Shared plan',
    markdown: '# Shared plan\n\n- step one\n- step two',
    sourceTurnId: 'turn-1',
  });
  return chat;
}

const request = (chat, overrides = {}) => ({
  parentChatId: chat.id,
  executor: { transport: 'opencode', model: 'opencode/test' },
  planRevision: readChatPlanDocument({ cwd: project, chatId: chat.id }).revision,
  idempotencyKey: 'idem-moved',
  ...overrides,
});

test('replay from the new controller is a replay, a different payload still conflicts', async () => {
  const from = createPlanChat('replay-from');
  const to = createPlanChat('replay-to');
  // A real start by `from` yields the requestHash a legacy row would carry.
  const source = await service.createAndStart(request(from, { idempotencyKey: 'idem-source' }));
  assert.equal(source.ok, true);
  const sourceRow = getDelegationById(source.delegation.id);
  assert.ok(sourceRow.requestHash, 'original requestHash is stored');
  assert.equal(sourceRow.parentChatId, from.id);
  const moved = createDelegationRecord({
    parentChatId: from.id,
    controllerChatId: to.id,
    workspaceFolder: project,
    executor: { transport: 'opencode', model: 'opencode/test' },
    assignment: sourceRow.assignment,
    executionMode: sourceRow.executionMode,
    sourceKind: sourceRow.sourceKind,
    idempotencyKey: 'idem-moved',
    requestHash: sourceRow.requestHash,
  });
  updateDelegationRecord(moved.id, { status: 'completed', report: 'TASK: implement\nVERDICT: PASS' });
  assert.equal(getDelegationById(moved.id).controllerChatId, to.id);

  const replayed = await service.createAndStart(request(to));
  assert.equal(replayed.ok, true, replayed.error || '');
  assert.equal(replayed.delegation?.id, moved.id);

  const conflict = await service.createAndStart(request(to, { executor: { transport: 'opencode', model: 'other' } }));
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'idempotency_conflict');
});

test('deleting the old parent keeps a moved job, deleting the controller cancels it', async () => {
  const mkRow = (parentChatId, controllerChatId) => {
    const child = addChat(randomUUID(), 'del-child', null, project, 'ctl-delete/x', {
      agentTransport: 'ctl-delete',
      sdkMode: 'agent',
    });
    const row = createDelegationRecord({
      parentChatId,
      childChatId: child.id,
      ...(controllerChatId ? { controllerChatId } : {}),
      workspaceFolder: project,
      executor: { transport: 'ctl-delete', model: 'ctl-delete/x' },
      assignment: 'implement',
      runId: 'run-ctl',
    });
    return updateDelegationRecord(row.id, { status: 'running', runId: 'run-ctl' });
  };
  registerChatRunAdapter({
    transport: 'ctl-delete',
    capabilities: { canCancel: true },
    getState: () => ({ runId: 'run-ctl', busy: false, waitingForInput: false }),
    cancel: async () => {},
    start: async () => ({ accepted: true, runId: 'run-ctl' }),
  });
  const oldParent = createPlanChat('del-old');
  const controller = createPlanChat('del-ctl');
  const moved = mkRow(oldParent.id, controller.id);
  const legacy = mkRow(oldParent.id, '');

  // The stop may stay pending (409 cancel_pending) in this fixture; what matters
  // is which row was driven to cancelling/cancelled.
  const stopped = (row) => ['cancelling', 'cancelled'].includes(getDelegationById(row.id).status);
  await service.cancelForDeletedChat(oldParent.id);
  assert.equal(stopped(legacy), true, 'legacy row is controlled by its parent');
  assert.equal(getDelegationById(moved.id).status, 'running', 'moved row must survive the old parent');

  await service.cancelForDeletedChat(controller.id);
  assert.equal(stopped(moved), true, 'deleting the controller stops the moved row');
});
