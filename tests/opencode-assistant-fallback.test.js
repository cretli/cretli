import assert from 'node:assert/strict';
import { extractOpenCodeAssistantTextFromMessages } from '../lib/opencode/opencode-agent-ws.js';

const messages = [
  {
    info: { id: 'u1', role: 'user' },
    parts: [{ type: 'text', text: 'test' }],
  },
  {
    info: { id: 'a0', role: 'assistant', parentID: 'u0' },
    parts: [{ type: 'text', text: 'old response' }],
  },
  {
    info: { id: 'a1', role: 'assistant', parentID: 'u1' },
    parts: [
      { type: 'reasoning', text: 'thinking' },
      { type: 'text', text: 'Working. How can I help?' },
    ],
  },
];

const recovered = extractOpenCodeAssistantTextFromMessages(messages, 'test');
assert.equal(recovered, 'Working. How can I help?');

const withoutPromptMatch = extractOpenCodeAssistantTextFromMessages(messages, 'different');
assert.equal(withoutPromptMatch, '');

const pendingAssistantMessages = [
  {
    info: { id: 'u-old', role: 'user' },
    parts: [{ type: 'text', text: 'old prompt' }],
  },
  {
    info: { id: 'a-old', role: 'assistant', parentID: 'u-old' },
    parts: [{ type: 'text', text: 'Old completed answer' }],
  },
  {
    info: { id: 'u-new', role: 'user' },
    parts: [{ type: 'text', text: 'new prompt' }],
  },
  {
    info: { id: 'a-new', role: 'assistant', parentID: 'u-new' },
    parts: [{ type: 'text', text: '' }],
  },
];

const pendingRecovery = extractOpenCodeAssistantTextFromMessages(pendingAssistantMessages, 'new prompt');
assert.equal(pendingRecovery, '');

const noAssistant = extractOpenCodeAssistantTextFromMessages([
  { info: { id: 'u1', role: 'user' }, parts: [{ type: 'text', text: 'test' }] },
], 'test');
assert.equal(noAssistant, '');

console.log('opencode-assistant-fallback.test.js OK');
