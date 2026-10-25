/**
 * recordDelegationVerifyResult: the baseline classification decides the gate
 * status; without it (reviewer-run path) the raw outcome stands.
 */
import './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import assert from 'node:assert/strict';
import { createDelegationRecord, getDelegationById } from '../lib/persist/delegations-persist.js';
import { recordDelegationVerifyResult } from '../lib/delegation-service.js';

const created = createDelegationRecord({
  parentChatId: 'classify-parent',
  executor: { transport: 'testfakeb', model: 'model-d' },
  assignment: 'review',
  executionMode: 'agent',
});
const raw = { ok: false, output: 'boom', error: 'x', dataDir: '', results: [{ id: 'notices', ok: false, durationMs: 3, outputTail: 'boom' }] };

// Reviewer-run path: no classification -> raw outcome.
recordDelegationVerifyResult({ delegationId: created.id, attemptId: created.attemptId, result: raw });
assert.equal(getDelegationById(created.id).verifyResult.status, 'failed');

// Baseline-only failures -> gate passed, failures stay visible.
recordDelegationVerifyResult({
  delegationId: created.id,
  attemptId: created.attemptId,
  result: raw,
  classification: {
    status: 'passed', rawOk: false, newFailures: [], preexistingFailures: ['notices'], flakyFailures: [],
    baseline: { source: 'base-commit', baseCommit: 'abc', reason: '' },
  },
});
const passed = getDelegationById(created.id).verifyResult;
assert.equal(passed.status, 'passed');
assert.equal(passed.exitCode, 0);
assert.equal(passed.rawOk, false);
assert.deepEqual(passed.preexistingFailures, ['notices']);
assert.equal(passed.results[0].id, 'notices');

// A new failure -> gate failed (a changed classification is not "equivalent").
recordDelegationVerifyResult({
  delegationId: created.id,
  attemptId: created.attemptId,
  result: raw,
  classification: {
    status: 'failed', rawOk: false, newFailures: ['notices'], preexistingFailures: [], flakyFailures: [],
    baseline: { source: 'base-commit', baseCommit: 'abc', reason: '' },
  },
});
const failed = getDelegationById(created.id).verifyResult;
assert.equal(failed.status, 'failed');
assert.deepEqual(failed.newFailures, ['notices']);
console.log('OK');
