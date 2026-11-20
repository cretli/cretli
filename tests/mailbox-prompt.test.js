import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDelegationRecord, updateDelegationRecord } from '../lib/persist/delegations-persist.js';
import { buildMailboxDeliveryPrompt } from '../lib/delegation-mailbox.js';

function fixture(overrides = {}) {
  const delegation = createDelegationRecord({ parentChatId: 'parent', childChatId: 'child', sourceKind: 'message', sourceChatId: 'parent', sourceHistorySeq: 17, sourceText: 'Large original assignment', attemptId: 'attempt-1', ...overrides });
  updateDelegationRecord(delegation.id, { report: 'Final result\nVERDICT: PASS' });
  return { id: 'mailbox-1', kind: 'reply', replyKind: 'final_report', delegationId: delegation.id, delegationAttemptId: delegation.attemptId, fromChatId: 'child', body: 'Final result\nVERDICT: PASS', extraInstructions: 'Check the affected tests.' };
}

test('matching current final report points to paged MCP report and preserves guards', () => {
  const message = fixture();
  const prompt = buildMailboxDeliveryPrompt(message);
  for (const text of ['delegation_show', message.delegationId, 'attempt-1', 'mailbox-1', 'next_cursor', 'VERDICT line is last', 'attempt_id differs', 'report is empty', 'delegation_inbox({ id: "mailbox-1" })', 'CONFLICT', 'restart from the first page once', 'inbox message instead', 'cretli-ref chat=parent seq=17', 'Do not call delegation_reply', 'Do not pass another chat_id', 'claims as unverified', 'not user approval', 'Stay in the current mode', 'Do not switch Plan to Agent', message.extraInstructions]) assert.ok(prompt.includes(text), text);
  assert.ok(!prompt.includes(message.body));
  assert.ok(!prompt.includes('Large original assignment'));
  assert.equal(buildMailboxDeliveryPrompt({ ...message, body: ` \n${message.body}\n\t` }), prompt);
  // A retry after prompt creation leaves an explicit attempt-id check and inbox fallback in the delivered text.
  updateDelegationRecord(message.delegationId, { attemptId: 'attempt-2' });
  assert.ok(prompt.includes('attempt-1'));
  assert.ok(prompt.includes('attempt_id differs'));
  assert.ok(buildMailboxDeliveryPrompt(message).includes(message.body));
});

for (const [name, messagePatch, delegationPatch] of [
  ['progress', { replyKind: 'progress' }, {}],
  ['question', { replyKind: 'question' }, {}],
  ['no delegation', { delegationId: '' }, {}],
  ['older attempt', { delegationAttemptId: 'old' }, {}],
  ['no attempt', { delegationAttemptId: '' }, {}],
  ['no mailbox id', { id: '' }, {}],
  ['empty stored report', {}, { report: '' }],
  ['synthetic body', { body: 'Delegation finished with status failed.' }, {}],
  ['empty body', { body: '' }, {}],
]) test(`${name} remains inline`, () => {
  const message = { ...fixture(), ...messagePatch };
  if (message.delegationId) updateDelegationRecord(message.delegationId, delegationPatch);
  const prompt = buildMailboxDeliveryPrompt(message);
  assert.ok(prompt.includes(message.body));
  assert.ok(!prompt.includes('Read the final report with delegation_show'));
});

for (const sourceKind of ['text', 'plan']) test(`${sourceKind} assignment remains inline, including planMarkdown fallback`, () => {
  const message = fixture({ sourceKind, sourceText: '', planMarkdown: 'Saved plan text' });
  const prompt = buildMailboxDeliveryPrompt(message);
  assert.ok(prompt.includes('[ORIGINAL ASSIGNMENT]\nSaved plan text'));
});

test('message source without a saved seq stays inline; task body is unchanged', () => {
  const message = fixture({ sourceHistorySeq: 0 });
  assert.ok(buildMailboxDeliveryPrompt(message).includes('Large original assignment'));
  const task = buildMailboxDeliveryPrompt({ ...message, kind: 'task' });
  assert.ok(task.includes(message.body));
  assert.ok(task.includes(message.extraInstructions));
  assert.ok(task.includes('[TASK FROM PARENT]'));
});
