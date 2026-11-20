import assert from 'node:assert/strict';
import {
  getSdkDiagRunStatusCandidates,
  normalizeSdkRunStatusValue,
} from './e2e/chat-e2e-sdk-contract.js';

assert.equal(normalizeSdkRunStatusValue('finished'), 'completed');
assert.equal(normalizeSdkRunStatusValue('completed'), 'completed');
assert.equal(normalizeSdkRunStatusValue('plan_guard_cancelled'), 'cancelled');
assert.equal(normalizeSdkRunStatusValue('run_setup_cancelled'), 'cancelled');
assert.equal(normalizeSdkRunStatusValue('run_setup_failed'), 'error');
assert.equal(normalizeSdkRunStatusValue(''), '');

const diagWithRawStatus = {
  room: {
    lastRunStatus: 'finished',
  },
};
assert.deepEqual(
  getSdkDiagRunStatusCandidates(diagWithRawStatus),
  ['finished', 'completed']
);

const diagWithNormalizedStatus = {
  room: {
    lastRunStatus: 'run_setup_failed',
    lastRunStatusNormalized: 'error',
  },
};
assert.deepEqual(
  getSdkDiagRunStatusCandidates(diagWithNormalizedStatus),
  ['run_setup_failed', 'error', 'error']
);

console.log('All chat-e2e-sdk-contract tests passed.');
