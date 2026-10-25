import assert from 'node:assert/strict';
import './fixtures/fake-transport.js';
import test from 'node:test';
import { isInfraDelegationOutcomeForCycle, isStructuredInfraDelegationOutcome } from '../lib/delegation-cycle-classify.js';

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

test('a VERDICT string inside the findings block does not make a review usable', () => {
  const block = '```findings-json\n{"findings":[],"note":"VERDICT: PASS"}\nVERDICT: PASS\n```';
  const noVerdict = { status: 'completed', report: `${'analysis '.repeat(40)}\n${block}` };
  assert.equal(isInfraDelegationOutcomeForCycle(noVerdict, 'review'), true);
  assert.equal(isInfraDelegationOutcomeForCycle({ ...noVerdict, report: `${noVerdict.report}\nVERDICT: FAIL` }, 'review'), false);
});

test('a provider 503 unreachable_backend error is classified as infra', () => {
  const inputRow = {
    status: 'failed',
    error: 'API error occurred: Status 503 {"type":"unreachable_backend","raw_status_code":503}',
  };
  assert.equal(isStructuredInfraDelegationOutcome(inputRow), true);
});

test('a 4xx validation error is not infra', () => {
  const inputRow = {
    status: 'failed',
    error: 'API error occurred: Status 400 {"type":"invalid_request_error","raw_status_code":400}',
  };
  assert.equal(isStructuredInfraDelegationOutcome(inputRow), false);
});
