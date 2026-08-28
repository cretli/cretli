/**
 * OpenCode harness flow tests — user/assistant part routing, no duplicate user echo.
 */
import assert from 'node:assert/strict';
import { OpenCodeMessageRegistry } from '../lib/agent-harness/opencode-message-registry.js';
import { processOpenCodeStreamEventForHarness } from '../lib/agent-harness/opencode-event-normalizer.js';
import { extractAssistantPlainText } from '../app_front/lib/sdk-chat-format.js';

const SESSION = 'sess-harness-1';
const USER_MSG = 'msg-user-1';
const ASST_MSG = 'msg-asst-1';
const PROMPT = 'chat test';

function ctx(registry, lastUserPromptText = PROMPT, streamCtx = null) {
  const base = {
    opencodeSessionId: SESSION,
    messageRegistry: registry,
    lastUserPromptText,
  };
  if (!streamCtx) return base;
  return {
    ...base,
    partTextAcc: streamCtx.partTextAcc,
    assistantTextByMessageId: streamCtx.assistantTextByMessageId,
    thinkingTextByMessageId: streamCtx.thinkingTextByMessageId,
  };
}

const streamCtx = {
  partTextAcc: new Map(),
  assistantTextByMessageId: new Map(),
  thinkingTextByMessageId: new Map(),
};

function assistantText(events) {
  return events
    .filter((ev) => ev.type === 'assistant')
    .map((ev) => extractAssistantPlainText(ev))
    .join('');
}

const registry = new OpenCodeMessageRegistry();

const userRoleEvent = {
  type: 'message.updated',
  properties: {
    sessionID: SESSION,
    info: { id: USER_MSG, role: 'user', sessionID: SESSION },
  },
};
assert.deepEqual(processOpenCodeStreamEventForHarness(userRoleEvent, ctx(registry)), []);

const userPartEvent = {
  type: 'message.part.updated',
  properties: {
    sessionID: SESSION,
    part: { type: 'text', messageID: USER_MSG, text: PROMPT },
  },
};
assert.deepEqual(processOpenCodeStreamEventForHarness(userPartEvent, ctx(registry)), []);

const asstRoleEvent = {
  type: 'message.updated',
  properties: {
    sessionID: SESSION,
    info: { id: ASST_MSG, role: 'assistant', sessionID: SESSION },
  },
};
assert.deepEqual(processOpenCodeStreamEventForHarness(asstRoleEvent, ctx(registry)), []);

const asstPartEcho = {
  type: 'message.part.updated',
  properties: {
    sessionID: SESSION,
    part: { type: 'text', messageID: ASST_MSG, text: PROMPT },
  },
};
assert.deepEqual(processOpenCodeStreamEventForHarness(asstPartEcho, ctx(registry)), []);

const asstDelta = {
  type: 'message.part.delta',
  properties: {
    sessionID: SESSION,
    messageID: ASST_MSG,
    partID: 'part-1',
    field: 'text',
    delta: 'It works. ',
  },
};
const deltaEvents = processOpenCodeStreamEventForHarness(asstDelta, ctx(registry, PROMPT, streamCtx));
assert.equal(deltaEvents.length, 1);
assert.equal(extractAssistantPlainText(deltaEvents[0]), 'It works. ');

const asstFull = {
  type: 'message.part.updated',
  properties: {
    sessionID: SESSION,
    part: { id: 'part-1', type: 'text', messageID: ASST_MSG, text: 'It works. How can I help?' },
  },
};
const fullEvents = processOpenCodeStreamEventForHarness(asstFull, ctx(registry, PROMPT, streamCtx));
assert.equal(fullEvents.length, 1);
assert.equal(extractAssistantPlainText(fullEvents[0]), 'How can I help?');

const combined = assistantText([...deltaEvents, ...fullEvents]);
assert.ok(!combined.includes(PROMPT), `assistant output must not echo user prompt: ${combined}`);
assert.ok(combined.includes('It works'), combined);

const unknownPart = {
  type: 'message.part.updated',
  properties: {
    sessionID: SESSION,
    part: { type: 'text', messageID: 'unknown-msg', text: 'should skip' },
  },
};
assert.deepEqual(processOpenCodeStreamEventForHarness(unknownPart, ctx(registry)), []);

const dedupRegistry = new OpenCodeMessageRegistry();
dedupRegistry.noteMessageUpdated({ id: ASST_MSG, role: 'assistant' });
const dedupCtx = {
  partTextAcc: new Map(),
  assistantTextByMessageId: new Map(),
  thinkingTextByMessageId: new Map(),
};
const narration = 'Now let me analyze the project to find cursor rules.';
for (const delta of ['Now', ' let me analyze', ' the project']) {
  processOpenCodeStreamEventForHarness({
    type: 'message.part.delta',
    properties: {
      sessionID: SESSION,
      messageID: ASST_MSG,
      partID: 'part-narration',
      field: 'text',
      delta,
    },
  }, ctx(dedupRegistry, PROMPT, dedupCtx));
}
const reasoningDup = processOpenCodeStreamEventForHarness({
  type: 'message.part.updated',
  properties: {
    sessionID: SESSION,
    part: { id: 'part-reason', type: 'reasoning', messageID: ASST_MSG, text: narration },
  },
}, ctx(dedupRegistry, PROMPT, dedupCtx));
assert.deepEqual(reasoningDup, []);

console.log('opencode-harness-flow.test.js OK');
