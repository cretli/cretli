import assert from 'node:assert/strict';
import { takeStreamDelta, resetSdkStreamState } from '../app_front/lib/sdk-chat-format.js';
import {
  findReusableSdkAssistantBlockIndex,
  restoreSdkAssistantAccumulator,
} from '../lib/sdk/sdk-assistant-block-reuse.ts';

// Cumulative snapshots of one message replace the accumulator, never append.
{
  const chat = {};
  const snaps = ['Krok', 'Krok 3', 'Krok 3 jest zrobiony', '```js\nlet a', '```js\nlet a = 1;\n```'];
  let acc = '';
  for (const full of ['Krok', 'Krok 3', 'Krok 3 jest zrobiony']) {
    const d = takeStreamDelta(chat, '_sdkAssistantAcc', full);
    assert.equal(acc + d, full);
    acc = chat._sdkAssistantAcc;
    assert.equal(acc, full);
  }
  assert.equal(takeStreamDelta(chat, '_sdkAssistantAcc', 'Krok 3'), '');
  assert.equal(chat._sdkAssistantAcc, 'Krok 3 jest zrobiony');
  assert.ok(snaps.length);
}

// Simulates the view after a stream reset: block list + accumulator handling.
function simulate(blocksAfterTools) {
  const chat = {};
  const blocks = [{ variant: 'assistant', isConnected: true, hasAssistantMd: true, raw: 'Short text 422' }];
  resetSdkStreamState(chat);
  // Tools 423-426 run in parallel, settle out of order, one fails.
  for (const entry of blocksAfterTools) {
    blocks.push(typeof entry === 'string'
      ? { variant: entry, isConnected: true }
      : { ...entry, isConnected: true });
  }
  // Reset (reconnect) happened while the first message was live.
  const resume = true;
  const idx = findReusableSdkAssistantBlockIndex(blocks, resume);
  const finalText = 'Final answer 437';
  if (idx >= 0) {
    chat._sdkAssistantAcc = restoreSdkAssistantAccumulator('', blocks[idx].raw);
    takeStreamDelta(chat, '_sdkAssistantAcc', finalText);
    blocks[idx].raw = chat._sdkAssistantAcc;
  } else {
    delete chat._sdkAssistantAcc;
    takeStreamDelta(chat, '_sdkAssistantAcc', finalText);
    blocks.push({ variant: 'assistant', isConnected: true, hasAssistantMd: true, raw: chat._sdkAssistantAcc });
  }
  return blocks.filter((b) => b.variant === 'assistant').map((b) => b.raw);
}

// Running x4, then completed out of order incl. an error: two separate messages.
const messages = simulate(['ok', 'err', 'ok', 'ok']);
assert.deepEqual(messages, ['Short text 422', 'Final answer 437']);
assert.deepEqual(simulate(['warn', 'ok']), ['Short text 422', 'Final answer 437']);
assert.deepEqual(simulate(['run', 'run', 'run', 'run']), ['Short text 422', 'Final answer 437']);

// A timeout progress warning is presentation-only. Reconnect reuses the current
// assistant block instead of creating a duplicate answer bubble.
assert.deepEqual(
  simulate([{ variant: 'warn', timeoutProgress: true }]),
  ['Short text 422Final answer 437'],
);

console.log('sdk-assistant-two-messages-parallel-tools.test.js OK');
