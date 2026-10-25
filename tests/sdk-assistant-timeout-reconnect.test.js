import assert from 'node:assert/strict';
import { findReusableSdkAssistantBlockIndex } from '../lib/sdk/sdk-assistant-block-reuse.ts';

const assistant = {
  variant: 'assistant',
  isConnected: true,
  hasAssistantMd: true,
};

// A reconnect after an idle-timeout progress card must continue the live answer.
assert.equal(findReusableSdkAssistantBlockIndex([
  assistant,
  {
    variant: 'warn',
    isConnected: true,
    timeoutProgress: true,
  },
], true), 0);

// Settled tool warnings use the same visual variant but end the answer segment.
assert.equal(findReusableSdkAssistantBlockIndex([
  assistant,
  {
    variant: 'warn',
    isConnected: true,
    timeoutProgress: false,
  },
], true), -1);

console.log('sdk-assistant-timeout-reconnect.test.js OK');
