import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import { addChat, loadChats, updateChat } from '../lib/persist/chats-persist.js';
import { createDelegationService } from '../lib/delegation-service.js';
import { createDelegationRecord, getDelegationById, listDelegationsForParent, updateDelegationRecord } from '../lib/persist/delegations-persist.js';
import { registerMockChatRunAdapter } from '../lib/chat-run/mock-adapter.js';

registerMockChatRunAdapter('opencode');
const service = createDelegationService({
  workspaceDirForAgent: () => ISOLATED_DATA_DIR,
  isModelAvailable: () => true,
});

function createParent(title) {
  return addChat(crypto.randomUUID(), title, null, ISOLATED_DATA_DIR, 'opencode/test', {
    agentTransport: 'opencode', sdkMode: 'agent',
  });
}

function buildRequest(parent, assignment = 'implement') {
  return {
    parentChatId: parent.id,
    executor: { transport: 'opencode', model: 'opencode/test' },
    sourceKind: 'text', taskText: 'Perform the task', assignment,
    idempotencyKey: `archived-${parent.id}-${assignment}`,
  };
}

function assertArchivedRefusal(result) {
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.code, 'parent_archived');
}

try {
  const parent = createParent('Archived parent');
  updateChat(parent.id, { archived: true });
  const beforeChats = loadChats();
  for (const assignment of ['implement', 'review']) {
    assertArchivedRefusal(await service.createAndStart(buildRequest(parent, assignment)));
  }
  assert.deepEqual(loadChats(), beforeChats, 'refused starts never create a child');
  assert.deepEqual(listDelegationsForParent(parent.id), [], 'refused starts never create a job');

  const queuedParent = createParent('Queued parent');
  const queuedRequest = buildRequest(queuedParent);
  const queued = createDelegationRecord({
    parentChatId: queuedParent.id, workspaceFolder: ISOLATED_DATA_DIR,
    childChatId: crypto.randomUUID(), executor: queuedRequest.executor,
    idempotencyKey: queuedRequest.idempotencyKey, sourceKind: 'text',
    sourceText: queuedRequest.taskText, assignment: 'implement', executionMode: 'agent', status: 'queued',
  });
  updateChat(queuedParent.id, { archived: true });
  const queuedBefore = getDelegationById(queued.id);
  assertArchivedRefusal(await service.createAndStart(queuedRequest));
  assert.deepEqual(getDelegationById(queued.id), queuedBefore, 'queued replay is rejected before mutation');
  assert.equal(loadChats().some(chat => chat.id === queued.childChatId), false);
  updateDelegationRecord(queued.id, { status: 'cancelled', finishedAt: new Date().toISOString() });

  const retryParent = createParent('Retry parent');
  const failed = createDelegationRecord({
    parentChatId: retryParent.id, workspaceFolder: ISOLATED_DATA_DIR,
    childChatId: crypto.randomUUID(), executor: queuedRequest.executor,
    sourceKind: 'text', sourceText: 'Perform the task', assignment: 'implement',
    executionMode: 'agent', status: 'failed', finishedAt: new Date().toISOString(),
  });
  updateChat(retryParent.id, { archived: true });
  const retryBefore = getDelegationById(failed.id);
  assertArchivedRefusal(await service.retry(failed.id));
  assert.deepEqual(getDelegationById(failed.id), retryBefore, 'retry does not reset the attempt');

  assert.throws(() => addChat(crypto.randomUUID(), 'Late child', null, ISOLATED_DATA_DIR, null, {
    forkParentChatId: parent.id,
  }), { code: 'parent_archived' }, 'direct store writes cannot bypass the delegation guard');
  const liveChat = createParent('Live root');
  assert.throws(() => updateChat(liveChat.id, { forkParentChatId: parent.id }), { code: 'parent_archived' });
  assert.equal(loadChats().find(chat => chat.id === liveChat.id).forkParentChatId, undefined);

  const racingParent = createParent('Archive during start');
  const racingService = createDelegationService({
    workspaceDirForAgent: () => ISOLATED_DATA_DIR,
    isModelAvailable: () => { updateChat(racingParent.id, { archived: true }); return true; },
  });
  assertArchivedRefusal(await racingService.createAndStart(buildRequest(racingParent)));
  assert.deepEqual(listDelegationsForParent(racingParent.id), [], 'archive during validation leaves no job');

  updateChat(parent.id, { archived: false });
  const restored = await service.createAndStart(buildRequest(parent));
  assert.equal(restored.ok, true, JSON.stringify(restored));
  assert.equal(restored.chat.forkParentChatId, parent.id, 'restoring the parent permits delegation');
  console.log('delegation-archived-parent.test.js OK');
} finally {
  removeIsolatedDataDir();
}
