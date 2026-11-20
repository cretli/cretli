import './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { createTempRepo } from './helpers/temp-git-repo.js';
import { addChat } from '../lib/persist/chats-persist.js';
import {
  createDelegationRecord,
  getDelegationById,
  loadDelegations,
  updateDelegationRecord,
} from '../lib/persist/delegations-persist.js';
import { readDelegationMaterialRevisionForRecord } from '../lib/delegation-material-revision.js';
import { createDelegationService } from '../lib/delegation-service.js';
import { registerMockChatRunAdapter, resetMockChatRuns } from '../lib/chat-run/mock-adapter.ts';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';

resetMockChatRuns();
registerMockChatRunAdapter('testfake');

const gitWorkspace = createTempRepo();
const executor = { transport: 'testfake', model: 'testfake/test' };
const service = createDelegationService({
  workspaceDirForAgent: () => gitWorkspace.dir,
  isModelAvailable: () => true,
});

test.after(() => {
  fs.rmSync(gitWorkspace.dir, { recursive: true, force: true });
});

function parentChat() {
  return addChat(crypto.randomUUID(), 'parent', null, ISOLATED_DATA_DIR, 'testfake/test', {
    agentTransport: 'testfake',
    sdkMode: 'agent',
  });
}

/** Leaf whose latest implement has a failed host verify on the current material. */
function seedFailedVerifyLeaf(parentChatId) {
  const leafId = crypto.randomUUID();
  const implement = createDelegationRecord({
    parentChatId,
    workspaceFolder: gitWorkspace.dir,
    executor,
    assignment: 'implement',
    workRole: 'implement',
    status: 'completed',
    leafId,
    finishedAt: '2026-10-12T12:00:00.000Z',
  });
  updateDelegationRecord(implement.id, {
    verifyResult: {
      status: 'failed',
      exitCode: 1,
      verdict: '',
      source: 'delegation_verify',
      dataDir: '/tmp/x',
      recordedAt: '2026-10-12T12:01:00.000Z',
      attemptId: implement.attemptId,
      materialRevision: readDelegationMaterialRevisionForRecord(implement),
    },
  });
  return leafId;
}

function queuedReview(parentChatId, leafId, extra = {}) {
  return createDelegationRecord({
    parentChatId,
    workspaceFolder: gitWorkspace.dir,
    executor,
    assignment: 'review',
    reviewSubject: 'code',
    executionMode: 'agent',
    status: 'queued',
    leafId,
    sourceKind: 'text',
    sourceText: 'review it',
    ...extra,
  });
}

test('persist round-trip keeps allowVerifyFailedReview', () => {
  const p = parentChat();
  const on = createDelegationRecord({ parentChatId: p.id, executor, assignment: 'review', allowVerifyFailedReview: true });
  const off = createDelegationRecord({ parentChatId: p.id, executor, assignment: 'review' });
  const reloaded = loadDelegations();
  assert.equal(reloaded.find((r) => r.id === on.id)?.allowVerifyFailedReview, true);
  assert.equal(reloaded.find((r) => r.id === off.id)?.allowVerifyFailedReview, false);
  assert.equal(getDelegationById(on.id)?.allowVerifyFailedReview, true);
});

async function drainReview(extra) {
  const p = parentChat();
  const leafId = seedFailedVerifyLeaf(p.id);
  const row = queuedReview(p.id, leafId, extra);
  const drained = await service.drainQueue({ parentChatId: p.id });
  return { row, drained, after: getDelegationById(row.id) };
}

test('queued review with override survives drain/resume past the verify gate', async () => {
  const { row, drained, after } = await drainReview({ allowVerifyFailedReview: true });
  assert.equal(drained.started.includes(row.id), true, JSON.stringify({ drained, status: after.status }));
  assert.notEqual(after.status, 'queued');
  assert.equal(after.allowVerifyFailedReview, true);
});

test('control: queued review without override stays refused by the verify gate', async () => {
  const { row, drained, after } = await drainReview({});
  assert.equal(drained.started.includes(row.id), false);
  assert.equal(after.status, 'queued');
});

test('allowVerifyFailedReview is outside requestHash and the first value wins on replay', async () => {
  const p = parentChat();
  const base = {
    parentChatId: p.id,
    sourceKind: 'text',
    taskText: 'replay task',
    assignment: 'implement',
    executor,
    idempotencyKey: `verify-override-replay-${crypto.randomUUID()}`,
  };
  const first = await service.createAndStart({ ...base, allowVerifyFailedReview: true });
  assert.equal(first.ok, true, JSON.stringify(first));
  const replay = await service.createAndStart({ ...base, allowVerifyFailedReview: false });
  assert.notEqual(replay.code, 'idempotency_conflict');
  assert.equal(replay.ok, true, JSON.stringify(replay));
  assert.equal(replay.delegation.id, first.delegation.id);
  assert.equal(getDelegationById(first.delegation.id).allowVerifyFailedReview, true);
});
