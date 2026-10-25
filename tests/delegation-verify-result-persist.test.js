/**
 * Durable host-verify fields on a delegation record: the start-time
 * `verifyRequired` policy and the `verifyResult` hard evidence (now carrying the
 * review verdict + exit code) must round-trip and be normalized for legacy rows.
 */
import './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import assert from 'node:assert/strict';
import {
  createDelegationRecord,
  getDelegationById,
  updateDelegationRecord,
} from '../lib/persist/delegations-persist.js';

const created = createDelegationRecord({
  parentChatId: 'verify-parent',
  executor: { transport: 'testfakeb', model: 'model-d' },
  assignment: 'review',
  executionMode: 'agent',
  verifyRequired: true,
  reviewCanRunTests: false,
  reviewCanRunTestsSource: 'observed',
});
assert.equal(created.verifyRequired, true);
assert.equal(created.reviewCanRunTests, false);
assert.equal(created.reviewCanRunTestsSource, 'observed');
assert.equal(created.verifyResult, null);

const withResult = updateDelegationRecord(created.id, {
  verifyResult: {
    status: 'passed',
    exitCode: 0,
    verdict: 'PASS',
    source: 'delegation_verify',
    dataDir: '/tmp/cretli-review-verify-data-x',
    recordedAt: '2026-10-07T00:00:00.000Z',
    attemptId: created.attemptId,
  },
});
assert.equal(withResult.verifyResult.status, 'passed');
assert.equal(withResult.verifyResult.verdict, 'PASS');
assert.equal(withResult.verifyResult.exitCode, 0);
assert.equal(withResult.verifyResult.source, 'delegation_verify');

const reloaded = getDelegationById(created.id);
assert.equal(reloaded.verifyResult.verdict, 'PASS', 'verdict survives a store round-trip');
assert.equal(reloaded.verifyResult.exitCode, 0);
assert.equal(reloaded.verifyRequired, true);
assert.equal(reloaded.reviewCanRunTestsSource, 'observed');

// An unknown verdict is dropped, but the hard status survives.
const dirty = updateDelegationRecord(created.id, {
  verifyResult: { status: 'failed', verdict: 'MAYBE' },
});
assert.equal(dirty.verifyResult.status, 'failed');
assert.equal(dirty.verifyResult.verdict, '', 'an invalid verdict is not persisted');
assert.equal(dirty.verifyResult.exitCode, 1, 'exit code falls back to the status');

// Baseline classification fields round-trip; legacy records carry none.
assert.equal(reloaded.verifyResult.baseline, undefined, 'legacy record has no classification');
const classified = updateDelegationRecord(created.id, {
  verifyResult: {
    status: 'passed',
    rawOk: false,
    newFailures: [],
    preexistingFailures: ['notices'],
    flakyFailures: [],
    baseline: { source: 'base-commit', baseCommit: 'abc', reason: '' },
    results: [{ id: 'notices', ok: false, durationMs: 5, outputTail: 'boom' }],
  },
});
assert.deepEqual(classified.verifyResult.preexistingFailures, ['notices']);
assert.equal(classified.verifyResult.baseline.source, 'base-commit');
assert.equal(getDelegationById(created.id).verifyResult.results[0].id, 'notices');
assert.equal(getDelegationById(created.id).verifyResult.status, 'passed');

// A non-review legacy record defaults the policy fields instead of undefined.
const legacy = createDelegationRecord({
  parentChatId: 'verify-parent',
  executor: { transport: 'sdk', model: 'model-a' },
  assignment: 'implement',
});
assert.equal(legacy.verifyRequired, false);
assert.equal(legacy.reviewCanRunTests, false);
assert.equal(legacy.reviewCanRunTestsSource, '');

// The policy fields can be cleared/updated through a patch.
const updated = updateDelegationRecord(created.id, {
  verifyRequired: false,
  reviewCanRunTests: true,
  reviewCanRunTestsSource: 'prior',
});
assert.equal(updated.verifyRequired, false);
assert.equal(updated.reviewCanRunTests, true);
assert.equal(updated.reviewCanRunTestsSource, 'prior');

console.log('delegation-verify-result-persist.test.js OK');

// Optional required-test manifest round-trips; legacy rows carry none.
const withManifest = updateDelegationRecord(created.id, {
  verifyResult: {
    status: 'passed',
    manifest: {
      attemptId: 'a1', materialRevision: 'r1', envKey: 'e', testSetKey: 't',
      entries: [{ id: 'notices', path: 'tests/notices.test.js', sha256: 'abc', origin: 'curated' }],
    },
  },
});
assert.equal(withManifest.verifyResult.manifest.entries[0].origin, 'curated');
assert.equal(getDelegationById(created.id).verifyResult.manifest.testSetKey, 't');
assert.equal(updateDelegationRecord(created.id, { verifyResult: { status: 'passed' } }).verifyResult.manifest, undefined);
