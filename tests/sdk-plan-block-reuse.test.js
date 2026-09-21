import assert from 'node:assert/strict';
import {
  isPlaceholderSdkPlanMarkdown,
  mergeSdkPlanMarkdown,
  pickSdkPlanKeeper,
  shouldFoldSdkPlanCard,
} from '../lib/sdk/sdk-plan-block-reuse.js';

assert.equal(isPlaceholderSdkPlanMarkdown(''), true);
assert.equal(isPlaceholderSdkPlanMarkdown('{"plan":""}'), true);
assert.equal(isPlaceholderSdkPlanMarkdown('{\n  "plan": ""\n}'), true);
assert.equal(isPlaceholderSdkPlanMarkdown('# Plan: fanout'), false);

const callId = 'call-fc4f1c78-ed19-46e0-ba2c-aada56042bae-110';
const empty = { callId, status: 'running', text: '{\n  "plan": ""\n}' };
const running = { callId, status: 'running', text: '# Plan: fanout subczatów\n\n- item' };
const completed = { callId, status: 'completed', text: '# Plan: fanout subczatów\n\n- item\n- two' };
const liveUnstamped = { callId: '', status: 'completed', text: '# Plan: fanout subczatów\n\n- item' };

assert.equal(shouldFoldSdkPlanCard(empty, completed), true);
assert.equal(shouldFoldSdkPlanCard(running, completed), true);
assert.equal(shouldFoldSdkPlanCard({ callId: '', text: '{"plan":""}' }, completed), true);
assert.equal(
  shouldFoldSdkPlanCard(
    { callId: '', text: '# Plan: fanout subczatów\n\n- item\n- two' },
    { callId: '', text: '# Plan: fanout subczatów\n\n- item\n- two' }
  ),
  true
);
assert.equal(shouldFoldSdkPlanCard({ callId: 'other', text: '# other' }, completed), false);

const keeper = pickSdkPlanKeeper([empty, running, completed, liveUnstamped]);
assert.equal(keeper, completed);

assert.equal(
  mergeSdkPlanMarkdown(running.text, empty.text),
  running.text,
  'Empty CreatePlan snapshot must not wipe the full plan'
);
assert.equal(
  mergeSdkPlanMarkdown(empty.text, running.text),
  running.text
);

console.log('sdk-plan-block-reuse.test.js OK');
