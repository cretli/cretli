import assert from 'node:assert/strict';
import {
  getSdkEventTerminalChunk,
  mergeThinkingSnapshot,
  resetSdkStreamState,
  takeThinkingStreamDelta,
} from '../app_front/lib/sdk-chat-format.js';
import { createClaudeEventNormalizer } from '../lib/agent-harness/claude-event-normalizer.ts';

const thinkingDelta = (thinking) => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking } },
});

// A snapshot restarted by a new API call must not append each growing copy.
{
  const normalizer = createClaudeEventNormalizer();
  const chat = {};
  const feed = (message) => {
    for (const event of normalizer.normalize(message)) {
      if (event.type !== 'thinking') continue;
      assert.equal(event.streamTextMode, 'snapshot');
      takeThinkingStreamDelta(chat, 'acc', event.text, event.streamTextMode);
    }
  };
  feed({ type: 'stream_event', event: { type: 'message_start', message: {} } });
  feed(thinkingDelta('First step.'));
  feed({ type: 'stream_event', event: { type: 'message_start', message: {} } });
  feed(thinkingDelta('Zrzut p'));
  feed(thinkingDelta('okazał'));
  feed(thinkingDelta(' numer.'));
  assert.equal(chat.acc, 'First step.\n\nZrzut pokazał numer.');
}

assert.equal(mergeThinkingSnapshot('', 'a'), 'a');
assert.equal(mergeThinkingSnapshot('abc', ''), 'abc');
assert.equal(mergeThinkingSnapshot('abc', 'abcd'), 'abcd');
assert.equal(mergeThinkingSnapshot('abc', 'ab'), 'abc', 'a shorter replay changes nothing');
assert.equal(mergeThinkingSnapshot('abc', 'xyz'), 'abc\n\nxyz');
assert.equal(
  mergeThinkingSnapshot('One.\n\nTwo gr', 'Two grows'),
  'One.\n\nTwo grows',
  'after a stream reset the rehydrated last segment keeps growing',
);
assert.equal(mergeThinkingSnapshot('One.\n\nTwo grows', 'Two'), 'One.\n\nTwo grows');
assert.equal(
  mergeThinkingSnapshot('One.\n\nTwo\n\nThree', 'Two\n\nThree more'),
  'One.\n\nTwo\n\nThree more',
  'a snapshot with its own paragraphs matches at the start of its segment',
);
assert.equal(
  mergeThinkingSnapshot('One.\n\n', 'One.\n\n'),
  'One.\n\n',
  'a redelivered snapshot ending with the separator is not repeated',
);
assert.equal(mergeThinkingSnapshot('One.\n\n', 'One.'), 'One.\n\n');
assert.equal(mergeThinkingSnapshot('One.\n\n', 'One.\n\nTwo'), 'One.\n\nTwo');
assert.equal(mergeThinkingSnapshot('Zero.\n\nOne.\n\n', 'One.\n\n'), 'Zero.\n\nOne.\n\n');
assert.equal(
  mergeThinkingSnapshot('One.\n\n', 'Two'),
  'One.\n\nTwo',
  'a new segment after a trailing separator gets no second separator',
);

// Without the snapshot mark (DeepSeek reasoning deltas) text is still appended.
{
  const chat = {};
  takeThinkingStreamDelta(chat, 'acc', 'tok', undefined);
  assert.equal(takeThinkingStreamDelta(chat, 'acc', 'en', undefined), 'en');
  assert.equal(chat.acc, 'token');
}

// The terminal view prints only the new text of a restarted snapshot.
{
  const chat = {};
  const thinking = (text) => ({ type: 'thinking', text, streamTextMode: 'snapshot' });
  getSdkEventTerminalChunk(chat, thinking('First.'));
  assert.equal(getSdkEventTerminalChunk(chat, thinking('Sec')), '\n\nSec');
  assert.equal(getSdkEventTerminalChunk(chat, thinking('Second')), 'ond');
  resetSdkStreamState(chat);
  assert.equal(chat._sdkThinkingAcc, undefined);
}

console.log('sdk-thinking-snapshot-merge.test.js OK');
