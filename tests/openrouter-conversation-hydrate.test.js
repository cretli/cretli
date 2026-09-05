import assert from 'node:assert/strict';
import { buildAssistantFullEvent } from '../lib/agent-harness/event-normalizer.js';
import { buildOpenRouterConversationFromHistory } from '../lib/openrouter/openrouter-conversation-hydrate.js';

const inputEvents = [
  { rec: { kind: 'localUser', text: 'Hello' } },
  { rec: { kind: 'sdk', event: buildAssistantFullEvent('Hi') } },
  { rec: { kind: 'sdk', event: buildAssistantFullEvent('Hi there') } },
  { rec: { kind: 'localUser', text: 'Continue' } },
  { rec: { kind: 'sdk', event: buildAssistantFullEvent('Done.') } },
  { rec: { kind: 'meta', variant: 'runFinished', payload: 'completed' } },
];
const actualMessages = buildOpenRouterConversationFromHistory(inputEvents);
const expectedMessages = [
  { role: 'user', content: 'Hello' },
  { role: 'assistant', content: 'Hi there' },
  { role: 'user', content: 'Continue' },
  { role: 'assistant', content: 'Done.' },
];
assert.deepEqual(actualMessages, expectedMessages);
assert.deepEqual(buildOpenRouterConversationFromHistory([]), []);
assert.deepEqual(buildOpenRouterConversationFromHistory(null), []);

console.log('openrouter-conversation-hydrate.test.js OK');
