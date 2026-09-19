import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { buildDelegationExecutorPrompt } from '../lib/delegation-prompt.js';
import {
  buildDelegationRequestHash,
  resolveDelegationChildExecutionMode,
} from '../lib/delegation-request.js';

const review = buildDelegationExecutorPrompt({
  sourceKind: 'plan',
  planMarkdown: '# Verify the plan',
  executionMode: 'agent',
  assignment: 'review',
  extraInstructions: 'Only inspect the implementation and report defects. Do not edit files.',
});
assert.equal(review.ok, true);
assert.match(review.prompt, /You are the reviewer/);
assert.match(review.prompt, /Do not implement\. Do not edit files/);
assert.match(review.prompt, /scripts\/review-verify\.js/);
assert.doesNotMatch(review.prompt, /node tests\/\*\.test\.js/);
assert.match(review.prompt, /\[ASSIGNMENT\]/);
assert.equal(review.displayText, 'Only inspect the implementation and report defects. Do not edit files.');
assert.doesNotMatch(review.prompt, /Implement the attached approved plan/);

const planDefault = buildDelegationExecutorPrompt({
  sourceKind: 'plan',
  planMarkdown: '# Verify the plan',
  executionMode: 'plan',
});
assert.equal(planDefault.ok, true);
assert.match(planDefault.prompt, /Assignment: review/);
assert.match(planDefault.prompt, /Review the assignment against the repository/);
assert.equal(planDefault.displayText, 'Review the approved plan.');
assert.equal(resolveDelegationChildExecutionMode('plan', 'review'), 'agent');
assert.equal(resolveDelegationChildExecutionMode('plan', 'implement'), 'plan');

const implementation = buildDelegationExecutorPrompt({
  sourceKind: 'plan',
  planMarkdown: '# Implement the plan',
  executionMode: 'agent',
  assignment: 'implement',
});
assert.equal(implementation.ok, true);
assert.match(implementation.prompt, /Implement the attached approved plan/);
assert.match(implementation.prompt, /Assignment: implement/);
assert.match(implementation.prompt, /Send the report through delegation_reply/);
assert.match(implementation.prompt, /idempotency_key/);
assert.match(implementation.prompt, /blockers/);
assert.match(implementation.prompt, /artifacts/);
assert.doesNotMatch(implementation.prompt, /wait for the user to pass it/);
assert.match(implementation.prompt, /cretli-ref chat=<uuid> seq=<n>/);
assert.match(implementation.prompt, /chat_event\(\{ chat: "<full-uuid>", seq: <n>, field: "text" \}\)/);
assert.match(implementation.prompt, /field is required/);

assert.match(planDefault.prompt, /The system will deliver the final report to the parent/);
assert.doesNotMatch(planDefault.prompt, /delegation_reply/);

const baseHash = {
  parentChatId: 'parent',
  sourceKind: 'plan',
  planRevision: 1,
  harness: 'sdk',
  model: 'model',
};
assert.notEqual(
  buildDelegationRequestHash({ ...baseHash, assignment: 'review' }),
  buildDelegationRequestHash({ ...baseHash, assignment: 'implement' }),
);

console.log('delegation-prompt.test.js OK');
