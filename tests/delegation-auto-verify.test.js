import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { createTempRepo } from './helpers/temp-git-repo.js';
import { addChat } from '../lib/persist/chats-persist.js';
import { createDelegationRecord, getDelegationById, updateDelegationRecord } from '../lib/persist/delegations-persist.js';
import { inspectImplementVerifyBeforeReview } from '../lib/delegation-implement-verify-gate.js';
import { startAutoVerifyAfterImplement } from '../lib/delegation-service.js';
import { isReviewVerifyInFlight } from '../lib/sdk/sdk-review-verify.js';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';

const repo = createTempRepo();
test.after(() => fs.rmSync(repo.dir, { recursive: true, force: true }));

function makeImplement() {
  const parent = addChat(crypto.randomUUID(), 'parent', null, ISOLATED_DATA_DIR, 'opencode/test', {
    agentTransport: 'opencode',
    sdkMode: 'agent',
  });
  const leafId = crypto.randomUUID();
  const row = createDelegationRecord({
    parentChatId: parent.id,
    workspaceFolder: repo.dir,
    executor: { transport: 'opencode', model: 'opencode/test' },
    assignment: 'implement',
    status: 'completed',
    leafId,
    finishedAt: new Date().toISOString(),
  });
  return { parent, leafId, row };
}

test('verifyPending persists and blocks review start without a child', () => {
  const { parent, leafId, row } = makeImplement();
  updateDelegationRecord(row.id, { verifyPending: { since: new Date().toISOString(), revision: 'r1' } });
  assert.equal(getDelegationById(row.id).verifyPending.revision, 'r1');
  const gate = inspectImplementVerifyBeforeReview({
    parentChatId: parent.id, assignment: 'review', executionMode: 'agent', reviewSubject: 'code', leafId,
  });
  assert.equal(gate.ok, false);
  assert.equal(gate.code, 'verify_pending');
  updateDelegationRecord(row.id, { verifyPending: null });
  assert.equal(inspectImplementVerifyBeforeReview({
    parentChatId: parent.id, assignment: 'review', executionMode: 'agent', reviewSubject: 'code', leafId,
  }).ok, true);
});

test('stale verify result does not block review', () => {
  const { parent, leafId, row } = makeImplement();
  updateDelegationRecord(row.id, {
    verifyResult: { status: 'failed', exitCode: 1, attemptId: row.attemptId, materialRevision: 'old', stale: true },
  });
  assert.equal(getDelegationById(row.id).verifyResult.stale, true);
  assert.equal(inspectImplementVerifyBeforeReview({
    parentChatId: parent.id, assignment: 'review', executionMode: 'agent', reviewSubject: 'code', leafId,
  }).ok, true);
});

test('hook is skipped when disabled', () => {
  const { row } = makeImplement();
  process.env.CRETLI_AUTO_VERIFY_AFTER_IMPLEMENT = '0';
  assert.equal(startAutoVerifyAfterImplement(row), null);
  assert.equal(getDelegationById(row.id).verifyPending, null);
});

test('hook records result, ids and clears the marker', async () => {
  const { row } = makeImplement();
  process.env.CRETLI_AUTO_VERIFY_AFTER_IMPLEMENT = '1';
  try {
    const pending = startAutoVerifyAfterImplement(row);
    assert.ok(pending, 'run started');
    assert.ok(getDelegationById(row.id).verifyPending, 'marker set synchronously');
    await pending;
    const after = getDelegationById(row.id);
    assert.equal(after.verifyPending, null);
    assert.equal(after.verifyResult.source, 'auto_after_implement');
    assert.equal(after.verifyResult.implementDelegationId, row.id);
    assert.ok(Array.isArray(after.verifyResult.ids));
    assert.equal(isReviewVerifyInFlight({ projectRoot: repo.dir }), false);
  } finally {
    process.env.CRETLI_AUTO_VERIFY_AFTER_IMPLEMENT = '0';
  }
});
