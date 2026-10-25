import assert from 'node:assert/strict';
import {
  breaksSdkAssistantBlockReuse,
  findReusableSdkAssistantBlockIndex,
  isReusableSdkAssistantBlock,
  restoreSdkAssistantAccumulator,
} from '../lib/sdk/sdk-assistant-block-reuse.ts';

assert.equal(breaksSdkAssistantBlockReuse('run'), true);
assert.equal(breaksSdkAssistantBlockReuse('thinking'), true);
assert.equal(breaksSdkAssistantBlockReuse('user'), true);
assert.equal(breaksSdkAssistantBlockReuse('muted'), false);
assert.equal(isReusableSdkAssistantBlock(null), false);
assert.equal(isReusableSdkAssistantBlock({ variant: 'thinking', isConnected: true }), false);
assert.equal(isReusableSdkAssistantBlock({ variant: 'assistant', isConnected: false }), false);
assert.equal(isReusableSdkAssistantBlock({ variant: 'assistant', hasAssistantMd: false }), false);
assert.equal(isReusableSdkAssistantBlock({ variant: 'assistant', isConnected: true }), true);

const inputLiveAnswer = [
  { variant: 'thinking', isConnected: true },
  { variant: 'assistant', isConnected: true, hasAssistantMd: true },
];
const actualAfterReset = findReusableSdkAssistantBlockIndex(inputLiveAnswer, true);
assert.equal(actualAfterReset, 1);

const actualWithoutReset = findReusableSdkAssistantBlockIndex(inputLiveAnswer, false);
assert.equal(actualWithoutReset, -1);

const inputAfterTool = [
  { variant: 'assistant', isConnected: true, hasAssistantMd: true },
  { variant: 'run', isConnected: true },
];
const actualAfterTool = findReusableSdkAssistantBlockIndex(inputAfterTool, true);
assert.equal(actualAfterTool, -1);

const inputMutedTail = [
  { variant: 'assistant', isConnected: true, hasAssistantMd: true },
  { variant: 'muted', isConnected: true },
];
const actualSkipMuted = findReusableSdkAssistantBlockIndex(inputMutedTail, true);
assert.equal(actualSkipMuted, 0);

const inputTimeoutProgressTail = [
  { variant: 'assistant', isConnected: true, hasAssistantMd: true },
  { variant: 'warn', isConnected: true, timeoutProgress: true },
];
assert.equal(findReusableSdkAssistantBlockIndex(inputTimeoutProgressTail, true), 0);
assert.equal(findReusableSdkAssistantBlockIndex([
  ...inputTimeoutProgressTail,
  { variant: 'ok', isConnected: true },
], true), -1);

assert.equal(restoreSdkAssistantAccumulator('kept', 'from-dom'), 'kept');
assert.equal(restoreSdkAssistantAccumulator('', 'from-dom'), 'from-dom');
assert.equal(restoreSdkAssistantAccumulator('', ''), '');

// Regression: assistant (seq 422) -> parallel tools settled out of order (one error)
// -> assistant (seq 437). Settled tool blocks must stop reuse, otherwise the
// second message is merged into the first after a stream reset.
for (const settled of ['ok', 'err', 'warn']) {
  assert.equal(breaksSdkAssistantBlockReuse(settled), true);
}
const inputAfterSettledTools = [
  { variant: 'assistant', isConnected: true, hasAssistantMd: true },
  { variant: 'ok', isConnected: true },
  { variant: 'err', isConnected: true },
  { variant: 'ok', isConnected: true },
  { variant: 'warn', isConnected: true },
];
assert.equal(findReusableSdkAssistantBlockIndex(inputAfterSettledTools, true), -1);

console.log('sdk-assistant-block-reuse.test.js OK');
