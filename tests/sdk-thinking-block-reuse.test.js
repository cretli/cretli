import assert from 'node:assert/strict';
import {
  findReusableSdkThinkingBlockIndex,
  isReusableSdkThinkingBlock,
  restoreSdkThinkingAccumulator,
} from '../lib/sdk/sdk-thinking-block-reuse.js';

assert.equal(isReusableSdkThinkingBlock(null), false);
assert.equal(isReusableSdkThinkingBlock({ isConnected: false }), false);
assert.equal(isReusableSdkThinkingBlock({ isConnected: true, isActivityOnly: true }), false);
assert.equal(isReusableSdkThinkingBlock({ isConnected: true, hasThinkingPre: false }), false);
assert.equal(isReusableSdkThinkingBlock({ isConnected: true }), true);

const inputBlocks = [
  { runKey: 'local-run-1', isConnected: true },
  { runKey: 'local-run-1-activity', isConnected: true, isActivityOnly: true },
  { runKey: 'local-run-2', isConnected: false },
];

const actualSameRun = findReusableSdkThinkingBlockIndex(inputBlocks, 'local-run-1', false);
assert.equal(actualSameRun, 0);

const actualAfterReset = findReusableSdkThinkingBlockIndex(inputBlocks, 'local-run-3', true);
assert.equal(actualAfterReset, 0);

const inputLaterBurst = [
  { runKey: 'local-run-1', isConnected: true },
  { runKey: 'local-run-2', isConnected: true },
];
const actualLatestAfterReset = findReusableSdkThinkingBlockIndex(
  inputLaterBurst,
  'local-run-9',
  true
);
assert.equal(actualLatestAfterReset, 1);

const actualNewTurn = findReusableSdkThinkingBlockIndex(inputBlocks, 'local-run-3', false);
assert.equal(actualNewTurn, -1);

const actualEmpty = findReusableSdkThinkingBlockIndex([], 'local-run-1', true);
assert.equal(actualEmpty, -1);

assert.equal(restoreSdkThinkingAccumulator('kept', 'from-dom'), 'kept');
assert.equal(restoreSdkThinkingAccumulator('', 'from-dom'), 'from-dom');
assert.equal(restoreSdkThinkingAccumulator('', ''), '');

console.log('sdk-thinking-block-reuse.test.js OK');
