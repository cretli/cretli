import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { createTempRepo } from './helpers/temp-git-repo.js';
import { addChat } from '../lib/persist/chats-persist.js';
import { createDelegationRecord, getDelegationById, updateDelegationRecord } from '../lib/persist/delegations-persist.js';
import { inspectImplementVerifyBeforeReview } from '../lib/delegation-implement-verify-gate.js';
import { startAutoVerifyAfterImplement } from '../lib/delegation-service.js';
import { isAutoVerifyChainInFlight, resetAutoVerifyChainsForTests, trackAutoVerifyChain } from '../lib/auto-verify-inflight.js';
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

test('gate stays blocked while a registered auto-verify chain is in flight past the marker age', async () => {
  const { parent, leafId, row } = makeImplement();
  const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  updateDelegationRecord(row.id, { verifyPending: { since: old, revision: 'r-chain' } });
  const input = { parentChatId: parent.id, assignment: 'review', executionMode: 'agent', reviewSubject: 'code', leafId };
  assert.equal(inspectImplementVerifyBeforeReview(input).ok, true, 'expired marker without a chain opens the gate');
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  trackAutoVerifyChain({ delegationId: row.id, projectRoot: repo.dir, materialRevision: 'r-chain', promise });
  assert.equal(isAutoVerifyChainInFlight({ delegationId: row.id, projectRoot: repo.dir, materialRevision: 'r-chain' }), true);
  const blocked = inspectImplementVerifyBeforeReview(input);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.retryable, true);
  release();
  await promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(inspectImplementVerifyBeforeReview(input).ok, true);
  resetAutoVerifyChainsForTests();
});

test('production auto-verify chain keeps the gate closed past the marker age until it settles', async () => {
  const { parent, leafId, row } = makeImplement();
  const previousEnv = process.env.CRETLI_AUTO_VERIFY_AFTER_IMPLEMENT;
  process.env.CRETLI_AUTO_VERIFY_AFTER_IMPLEMENT = '1';
  try {
    let release;
    let runnerInput = null;
    const held = new Promise((resolve) => { release = resolve; });
    const runner = (input) => { runnerInput = input; return held; };
    const settled = startAutoVerifyAfterImplement(row, { runner });
    assert.ok(settled, 'chain started');
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(runnerInput, 'runner invoked with the production input');
    assert.equal(runnerInput.projectRoot, repo.dir);
    assert.ok(Array.isArray(runnerInput.ids) && runnerInput.ids.length > 0);
    const pending = getDelegationById(row.id).verifyPending;
    assert.ok(pending, 'marker persisted');
    assert.equal(runnerInput.materialRevision, pending.revision);
    updateDelegationRecord(row.id, {
      verifyPending: { ...pending, since: new Date(Date.now() - 60 * 60 * 1000).toISOString() },
    });
    const input = { parentChatId: parent.id, assignment: 'review', executionMode: 'agent', reviewSubject: 'code', leafId };
    assert.equal(isAutoVerifyChainInFlight({
      delegationId: row.id, projectRoot: repo.dir, materialRevision: pending.revision,
    }), true, 'registry key matches the production registration');
    assert.equal(inspectImplementVerifyBeforeReview(input).ok, false, 'blocked by the live chain, not marker age');
    release({ ok: true, output: 'ok' });
    await settled;
    assert.equal(isAutoVerifyChainInFlight({
      delegationId: row.id, projectRoot: repo.dir, materialRevision: pending.revision,
    }), false);
    assert.equal(inspectImplementVerifyBeforeReview(input).ok, true, 'gate opens after the chain settles');
  } finally {
    if (previousEnv === undefined) delete process.env.CRETLI_AUTO_VERIFY_AFTER_IMPLEMENT;
    else process.env.CRETLI_AUTO_VERIFY_AFTER_IMPLEMENT = previousEnv;
    resetAutoVerifyChainsForTests();
  }
});
