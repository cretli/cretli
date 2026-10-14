import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDelegationFinishReport } from '../lib/delegation-verdict.js';

const prose = `${'The plan is coherent and every reference resolves. '.repeat(12)}No blocking defects.`;

test('review prose without VERDICT is infra no-answer, not a verdict', () => {
  const out = resolveDelegationFinishReport({ assignment: 'review', report: prose, status: 'completed', taskOutcome: 'success' });
  assert.equal(out.status, 'failed');
  assert.equal(out.taskOutcome, 'unspecified');
  assert.match(out.error, /adapter_no_verdict/);
  assert.match(out.error, /no answer, not a FAIL/);
});

test('empty review keeps the plain incomplete message', () => {
  const out = resolveDelegationFinishReport({ assignment: 'review', report: '', status: 'completed' });
  assert.match(out.error, /ended without a VERDICT report/);
});

test('review with a VERDICT line stays completed', () => {
  const out = resolveDelegationFinishReport({ assignment: 'review', report: `${prose}\nVERDICT: PASS`, status: 'completed' });
  assert.equal(out.status, 'completed');
});

import { queueVerdictFollowUp, shouldRequestVerdictFollowUp } from '../lib/delegation-verdict-followup.js';

test('no-verdict error uses the adapter_no_verdict code', () => {
  const out = resolveDelegationFinishReport({ assignment: 'review', report: prose, status: 'completed' });
  assert.match(out.error, /adapter_no_verdict/);
});

test('follow-up is queued once for a supported review without VERDICT', () => {
  const room = { sdkMode: 'agent' };
  const input = { assignment: 'review', report: prose, harness: 'claude' };
  assert.equal(queueVerdictFollowUp(room, input), true);
  assert.equal(room.pendingPrompts.length, 1);
  assert.equal(queueVerdictFollowUp(room, input), false);
});

test('follow-up reply with VERDICT completes with that verdict', () => {
  const out = resolveDelegationFinishReport({ assignment: 'review', report: `${prose}\n\nVERDICT: PASS`, status: 'completed' });
  assert.equal(out.status, 'completed');
  assert.equal(out.verdict, 'PASS');
});

test('no follow-up for VERDICT report, non-review or unsupported harness', () => {
  assert.equal(shouldRequestVerdictFollowUp({ assignment: 'review', report: `${prose}\nVERDICT: PASS`, harness: 'claude' }), false);
  assert.equal(shouldRequestVerdictFollowUp({ assignment: 'implement', report: prose, harness: 'claude' }), false);
  assert.equal(shouldRequestVerdictFollowUp({ assignment: 'review', report: prose, harness: 'openrouter' }), false);
});
