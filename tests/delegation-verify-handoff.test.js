import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addChat } from '../lib/persist/chats-persist.js';
import { createDelegationRecord, getDelegationById, updateDelegationRecord } from '../lib/persist/delegations-persist.js';
import { saveDelegationSettings } from '../lib/persist/delegation-settings-persist.js';
import { getDelegationSettingDef } from '../lib/delegation-settings-schema.js';
import { buildVerifyHandoffTaskText, inspectVerifyHandoff, VERIFY_HANDOFF_KEY_PREFIX } from '../lib/delegation-implement-verify-gate.js';
import { handBackNewVerifyFailures } from '../lib/delegation-service.js';
import { applyDelegationWorkflowPatch, inspectDelegationWorkflowStart } from '../lib/delegation-workflow.js';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';

const failedRow = (over = {}, verify = {}) => ({
  assignment: 'implement',
  status: 'completed',
  idempotencyKey: 'k',
  verifyResult: { status: 'failed', newFailures: ['t1'], preexistingFailures: ['old'], materialRevision: 'r1', baseline: { source: 'merge_base' }, ...verify },
  ...over,
});
const ok = (row, extra = {}) => inspectVerifyHandoff({ enabled: true, row, canResumeSession: true, usageLimitActive: false, ...extra });

test('setting defaults to off and is a workspace boolean', () => {
  const def = getDelegationSettingDef('auto_verify_handoff');
  assert.equal(def.default, false);
  assert.equal(def.scope, 'workspace');
  assert.equal(def.parse('maybe').ok, false);
  assert.equal(inspectVerifyHandoff({ enabled: false, row: failedRow(), canResumeSession: true }).reason, 'disabled');
});

test('only NEW failures are handed back, never baseline ones', () => {
  const good = ok(failedRow());
  assert.equal(good.ok, true);
  assert.deepEqual(good.newFailures, ['t1']);
  assert.equal(ok(failedRow({}, { newFailures: [] })).reason, 'no_new_failures');
  assert.equal(ok(failedRow({}, { newFailures: ['t1'], baseline: { source: 'unavailable' } })).reason, 'baseline_unavailable');
  assert.equal(ok(failedRow({}, { status: 'passed' })).reason, 'verify_not_failed');
  assert.equal(ok(failedRow({}, { stale: true })).reason, 'verify_stale');
  const text = buildVerifyHandoffTaskText({ newFailures: ['t1'], outputTail: 'boom' });
  assert.match(text, /t1/);
  assert.doesNotMatch(text, /old/);
});

test('at most one attempt per material; a failing handoff fix goes to the parent', () => {
  assert.equal(ok(failedRow({ verifyHandoff: { at: 'x', materialRevision: 'r1', status: 'started' } })).reason, 'already_attempted');
  assert.equal(ok(failedRow({ verifyHandoff: { at: 'x', materialRevision: 'r0', status: 'started' } })).ok, true, 'new material');
  assert.equal(ok(failedRow({ idempotencyKey: `${VERIFY_HANDOFF_KEY_PREFIX}abc:r0` })).reason, 'second_failure');
});

test('disabled without session resume and while a usage limit is active', () => {
  assert.equal(ok(failedRow(), { canResumeSession: false }).reason, 'resume_unsupported');
  assert.equal(ok(failedRow(), { usageLimitActive: true }).reason, 'usage_limit_active');
});

function makeFailedImplement(verify = {}) {
  const parent = addChat(crypto.randomUUID(), 'parent', null, ISOLATED_DATA_DIR, 'testfake/test', { agentTransport: 'testfake', sdkMode: 'agent' });
  const leafId = crypto.randomUUID();
  const row = createDelegationRecord({
    parentChatId: parent.id,
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'testfake', model: 'testfake/test' },
    assignment: 'implement',
    status: 'completed',
    leafId,
    finishedAt: new Date().toISOString(),
  });
  updateDelegationRecord(row.id, {
    verifyResult: { status: 'failed', exitCode: 1, attemptId: row.attemptId, materialRevision: 'r1', newFailures: ['t1'], baseline: { source: 'merge_base' }, outputTail: 'boom', ...verify },
  });
  return { parent, leafId, row };
}

test('service: setting off starts nothing; on starts one resumed fix and records the attempt', async () => {
  const { row, parent, leafId } = makeFailedImplement();
  const calls = [];
  const startFix = async (input) => { calls.push(input); return { ok: true, delegation: { id: 'fix-1' } }; };
  const probes = { canResumeSession: true, usageLimitActive: false };
  await handBackNewVerifyFailures(row.id, startFix, probes);
  assert.equal(calls.length, 0, 'default off');
  assert.equal(getDelegationById(row.id).verifyHandoff, null);

  saveDelegationSettings(ISOLATED_DATA_DIR, { auto_verify_handoff: true }, { dataDir: ISOLATED_DATA_DIR });
  try {
    await handBackNewVerifyFailures(row.id, startFix, probes);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].parentChatId, parent.id);
    assert.equal(calls[0].resumeSessionOf, row.id);
    assert.equal(calls[0].requireSessionResume, true);
    assert.equal(calls[0].requestedRole, 'fix');
    assert.equal(calls[0].leafId, leafId);
    const record = getDelegationById(row.id).verifyHandoff;
    assert.equal(record.status, 'started');
    assert.equal(record.fixDelegationId, 'fix-1');
    assert.deepEqual(record.newFailures, ['t1']);
    await handBackNewVerifyFailures(row.id, startFix, probes);
    assert.equal(calls.length, 1, 'second call for the same material does nothing');
  } finally {
    saveDelegationSettings(ISOLATED_DATA_DIR, { auto_verify_handoff: false }, { dataDir: ISOLATED_DATA_DIR });
  }
});

test('service: concurrent calls for the same material start exactly one fix', async () => {
  // The marker is written synchronously before the first await, so a second call
  // issued in the same tick already sees `already_attempted`.
  saveDelegationSettings(ISOLATED_DATA_DIR, { auto_verify_handoff: true }, { dataDir: ISOLATED_DATA_DIR });
  try {
    const { row } = makeFailedImplement();
    let started = 0;
    const startFix = async () => { started += 1; await new Promise((resolve) => setTimeout(resolve, 20)); return { ok: true, delegation: { id: 'fix-race' } }; };
    const probes = { canResumeSession: true, usageLimitActive: false };
    await Promise.all(Array.from({ length: 4 }, () => handBackNewVerifyFailures(row.id, startFix, probes)));
    assert.equal(started, 1);
    assert.equal(getDelegationById(row.id).verifyHandoff.status, 'started');
  } finally {
    saveDelegationSettings(ISOLATED_DATA_DIR, { auto_verify_handoff: false }, { dataDir: ISOLATED_DATA_DIR });
  }
});

test('service: resume / usage-limit gating is recorded and starts nothing', async () => {
  saveDelegationSettings(ISOLATED_DATA_DIR, { auto_verify_handoff: true }, { dataDir: ISOLATED_DATA_DIR });
  try {
    for (const [probes, reason] of [[{ canResumeSession: false, usageLimitActive: false }, 'resume_unsupported'], [{ canResumeSession: true, usageLimitActive: true }, 'usage_limit_active']]) {
      const { row } = makeFailedImplement();
      let started = 0;
      await handBackNewVerifyFailures(row.id, async () => { started += 1; return { ok: true }; }, probes);
      assert.equal(started, 0, reason);
      const record = getDelegationById(row.id).verifyHandoff;
      assert.equal(record.status, 'skipped');
      assert.equal(record.reason, reason);
    }
  } finally {
    saveDelegationSettings(ISOLATED_DATA_DIR, { auto_verify_handoff: false }, { dataDir: ISOLATED_DATA_DIR });
  }
});

test('service: a refused start (slots, budget, rounds, same_findings) is recorded and not retried', async () => {
  saveDelegationSettings(ISOLATED_DATA_DIR, { auto_verify_handoff: true }, { dataDir: ISOLATED_DATA_DIR });
  try {
    for (const code of ['slot_occupied', 'workflow_budget_exceeded', 'workflow_rounds_exhausted', 'workflow_stopped']) {
      const { row } = makeFailedImplement();
      let started = 0;
      const refuse = async () => { started += 1; return { ok: false, status: 409, code, error: code }; };
      const probes = { canResumeSession: true, usageLimitActive: false };
      await handBackNewVerifyFailures(row.id, refuse, probes);
      await handBackNewVerifyFailures(row.id, refuse, probes);
      assert.equal(started, 1, `${code}: one attempt only`);
      const record = getDelegationById(row.id).verifyHandoff;
      assert.equal(record.status, 'refused');
      assert.equal(record.reason, code);
    }
  } finally {
    saveDelegationSettings(ISOLATED_DATA_DIR, { auto_verify_handoff: false }, { dataDir: ISOLATED_DATA_DIR });
  }
});

test('the real start gate refuses once the round limit or same_findings stop is reached', async () => {
  const parentChatId = crypto.randomUUID();
  const leafId = crypto.randomUUID();
  applyDelegationWorkflowPatch({ parentChatId, leafId, maxRounds: 1, round: 1 });
  assert.equal((await inspectDelegationWorkflowStart({ parentChatId, leafId, assignment: 'implement' })).code, 'workflow_rounds_exhausted');
  const other = crypto.randomUUID();
  applyDelegationWorkflowPatch({ parentChatId: other, leafId, stopReason: 'same_findings' });
  assert.equal((await inspectDelegationWorkflowStart({ parentChatId: other, leafId, assignment: 'implement' })).code, 'workflow_stopped');
});
