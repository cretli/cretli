import assert from 'node:assert/strict';
import test from 'node:test';
import { isStructuredInfraDelegationOutcome } from '../lib/delegation-cycle-classify.js';

test('a missing-subscription provider error is classified as infra', () => {
  const inputRow = {
    status: 'failed',
    error: 'Upstream request failed: An active OpenCode Go subscription is required to use Go models.',
  };
  assert.equal(isStructuredInfraDelegationOutcome(inputRow), true);
});

test('an ordinary failed review without provider error is not infra by error text', () => {
  assert.equal(isStructuredInfraDelegationOutcome({ status: 'completed', error: '' }), false);
});
