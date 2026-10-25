import assert from 'node:assert/strict';
import {
  splitTextIntoCompressionChunks,
  formatChatHistoryEventsToText,
  buildSeedSummaryFromSummaries,
  buildCompressionPromptForChunk,
  normalizeAutoContextCompressionThresholdPercent,
  shouldTriggerAutoContextCompression,
  truncateTextForAgentPrompt,
} from '../lib/context-compression.js';

assert.deepEqual(splitTextIntoCompressionChunks(''), []);
assert.deepEqual(splitTextIntoCompressionChunks('abc', 10), ['abc']);
assert.equal(splitTextIntoCompressionChunks('abcdefghij', 6000).length, 1);
assert.equal(splitTextIntoCompressionChunks('x'.repeat(13000), 6000).length, 3);

const historyText = formatChatHistoryEventsToText([
  {
    seq: 1,
    rec: { kind: 'localUser', text: 'Fix auth module', createdAt: '2026-01-01T00:00:00.000Z' },
  },
  {
    seq: 2,
    rec: {
      kind: 'sdk',
      event: {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Updated lib/auth.js' }] },
      },
      createdAt: '2026-01-01T00:00:01.000Z',
    },
  },
  {
    seq: 3,
    rec: {
      kind: 'sdk',
      event: {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Updated lib/auth.js with guard clauses.' }],
        },
      },
      createdAt: '2026-01-01T00:00:02.000Z',
    },
  },
]);
assert.match(historyText, /> Fix auth module/);
assert.match(historyText, /Updated lib\/auth\.js with guard clauses/);
assert.doesNotMatch(historyText, /Updated lib\/auth\.js\n\nUpdated lib\/auth\.js\n/);

const seed = buildSeedSummaryFromSummaries([
  { summary: '## Goal\nAuth fix', at: '2026-01-01' },
  { summary: '## Goal\nAuth fix done', at: '2026-01-02' },
]);
assert.match(seed, /Session state 1/);
assert.match(seed, /Session state 2/);

const mergePrompt = buildCompressionPromptForChunk('new segment', '## Goal\nOld', 2, 3);
assert.match(mergePrompt, /CURRENT STATE/);
assert.match(mergePrompt, /NEW SEGMENT/);

const chunkPrompt = buildCompressionPromptForChunk('segment only', '', 1, 1);
assert.match(chunkPrompt, /Conversation segment 1 of 1/);
assert.doesNotMatch(chunkPrompt, /CURRENT STATE/);

assert.equal(normalizeAutoContextCompressionThresholdPercent(undefined), 80);
assert.equal(normalizeAutoContextCompressionThresholdPercent(40), 50);
assert.equal(normalizeAutoContextCompressionThresholdPercent(120), 95);
assert.equal(shouldTriggerAutoContextCompression(79, 80), false);
assert.equal(shouldTriggerAutoContextCompression(80, 80), true);

const truncated = truncateTextForAgentPrompt('x'.repeat(5000), 800);
assert.match(truncated, /\[truncated\]/);
assert.ok(truncated.length < 5000);

console.log('context-compression.test.js: ok');
