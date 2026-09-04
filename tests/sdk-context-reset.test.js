import assert from 'node:assert/strict';
import { createFreshSdkContextEntry } from '../lib/persist/chats-persist.js';

const original = {
  id: 'chat-1',
  title: 'Kontekst',
  cursorSessionId: 'old-session',
  sdkAgentId: 'agent-old',
  agentTransport: 'sdk',
  workspaceFolder: '/workspace',
  model: 'gpt-5.6-sol',
};

const reset = createFreshSdkContextEntry(original, 'new-session');

assert.equal(reset.cursorSessionId, 'new-session');
assert.equal(Object.hasOwn(reset, 'sdkAgentId'), false);
assert.equal(reset.id, original.id);
assert.equal(reset.title, original.title);
assert.equal(reset.workspaceFolder, original.workspaceFolder);
assert.equal(reset.model, original.model);
assert.equal(original.cursorSessionId, 'old-session');
assert.equal(original.sdkAgentId, 'agent-old');

assert.throws(
  () => createFreshSdkContextEntry(original, ''),
  /New cursor session id is required/
);

console.log('All SDK context reset tests passed.');
