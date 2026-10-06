import assert from 'node:assert/strict';
import {
  extractAssistantPlainText,
  isEmptyAssistantStreamPayload,
  takeStreamDelta,
} from '../app_front/lib/sdk-chat-format.js';

/**
 * Regression: token-delta harnesses (DeepSeek/Qwen/Claude/CodeBuddy) stream
 * newlines as their own assistant deltas. The live view used to discard every
 * whitespace-only payload (`!full.trim()`), which glued lines together and left
 * Markdown fences open, so the answer rendered as raw text until reload.
 */

assert.equal(isEmptyAssistantStreamPayload(''), true, 'empty payload is skippable');
assert.equal(isEmptyAssistantStreamPayload(undefined), true, 'missing payload is skippable');
assert.equal(isEmptyAssistantStreamPayload('\n'), false, 'newline delta is real content');
assert.equal(isEmptyAssistantStreamPayload(' \n\t'), false, 'whitespace delta is real content');
assert.equal(isEmptyAssistantStreamPayload(' x '), false, 'text payload is real content');

// A whitespace-only delta must survive the accumulator.
{
  const chat = {};
  const recovered = takeStreamDelta(chat, '_sdkAssistantAcc', '\n\n');
  assert.equal(recovered, '\n\n');
  assert.equal(chat._sdkAssistantAcc, '\n\n');
}

// Realistic streamed answer: every newline arrives as a standalone delta.
{
  const chat = {};
  const deltas = [
    '## Dlaczego nie działa',
    '\n\n',
    '1. **Astro nie nasłuchiwał**',
    '\n',
    '2. ','LAN nie widzi WSL2',
    '\n\n',
    '```powershell',
    '\n',
    'netsh interface portproxy add v4tov4 listenport=4321',
    '\n',
    '```',
    '\n',
  ];
  let out = '';
  for (const delta of deltas) out += takeStreamDelta(chat, '_sdkAssistantAcc', delta);

  assert.equal(out, deltas.join(''), 'accumulator must keep every whitespace delta');
  assert.ok(out.includes('```powershell\nnetsh'), 'fence and body stay on separate lines');
  assert.ok(out.includes('\n```\n'), 'fence closes on its own line');
  assert.ok(out.includes('nie działa\n\n1. **'), 'heading stays a block above the list');
}

// The same events still come back intact through extractAssistantPlainText.
{
  const event = {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: '\n' }] },
  };
  assert.equal(extractAssistantPlainText(event), '\n');
}

console.log('sdk-assistant-stream-payload.test.js OK');
