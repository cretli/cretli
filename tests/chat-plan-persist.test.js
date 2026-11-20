import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  buildChatPlanPromptContext,
  buildChatPlanRelativePath,
  pickRicherPlanMarkdown,
  readChatPlanDocument,
  readChatPlanFile,
  stripChatPlanComment,
  writeChatPlanFile,
} from '../lib/chat-plan-persist.js';
import { buildApprovedPlanImplementPrompt } from '../lib/chat-plan-path.js';

const inputCwd = mkdtempSync(path.join(os.tmpdir(), 'cr-chat-plan-'));
const inputChatId = 'chat-abc-123';
const expectedRelativePath = '.cursor/plans/cretli-chat-abc-123.md';

assert.equal(buildChatPlanRelativePath(inputChatId), expectedRelativePath);
assert.equal(buildChatPlanRelativePath('../evil'), '');

const actualWrittenPath = writeChatPlanFile({
  cwd: inputCwd,
  chatId: inputChatId,
  title: 'Bar heights',
  markdown: '# Fix the toolbar',
});
assert.equal(actualWrittenPath, expectedRelativePath);

const actualFile = readChatPlanFile({ cwd: inputCwd, chatId: inputChatId });
assert.match(actualFile, /Fix the toolbar/);
assert.match(actualFile, /cretli-chat-plan:chat-abc-123/);

const actualContext = buildChatPlanPromptContext({ cwd: inputCwd, chatId: inputChatId });
assert.match(actualContext, /CURRENT CHAT PLAN/);
assert.match(actualContext, /cretli-chat-abc-123\.md/);
assert.equal(buildChatPlanPromptContext({ cwd: inputCwd, chatId: 'missing' }), '');
assert.equal(pickRicherPlanMarkdown('# Full plan\n\n- a\n- b', 'short'), '# Full plan\n\n- a\n- b');
writeChatPlanFile({
  cwd: inputCwd,
  chatId: inputChatId,
  title: 'Should not win',
  markdown: 'too short',
  sourceTurnId: 'turn-2',
});
assert.match(readChatPlanFile({ cwd: inputCwd, chatId: inputChatId }), /Fix the toolbar/);
assert.equal(readChatPlanFile({ cwd: inputCwd, chatId: inputChatId }).includes('too short'), false);

writeChatPlanFile({
  cwd: inputCwd,
  chatId: inputChatId,
  title: 'Shorter complete',
  markdown: '# Shorter fix\n\n- do a\n- do b',
  sourceTurnId: 'turn-3',
});
assert.match(readChatPlanFile({ cwd: inputCwd, chatId: inputChatId }), /Shorter fix/);
assert.equal(readChatPlanFile({ cwd: inputCwd, chatId: inputChatId }).includes('Fix the toolbar'), false);

writeChatPlanFile({
  cwd: inputCwd,
  chatId: inputChatId,
  title: 'Progress',
  markdown: 'Let me draft the plan next after I look around.',
  sourceTurnId: 'turn-4',
});
assert.match(readChatPlanFile({ cwd: inputCwd, chatId: inputChatId }), /Shorter fix/);

const actualDoc = readChatPlanDocument({ cwd: inputCwd, chatId: inputChatId });
assert.ok(actualDoc.revision >= 2);
assert.ok(actualDoc.contentHash);
assert.equal(
  stripChatPlanComment(`${actualFile}`).includes('cretli-chat-plan'),
  false
);
assert.match(stripChatPlanComment(actualFile), /^# Bar heights/);

const actualImplementPrompt = buildApprovedPlanImplementPrompt(inputChatId);
assert.equal(
  actualImplementPrompt,
  `Implement the approved plan from \`${expectedRelativePath}\`. Read that file and implement it.`
);
assert.equal(
  buildApprovedPlanImplementPrompt('../evil'),
  'Implement the approved plan. Read the latest plan file and implement it.'
);
assert.equal(
  buildApprovedPlanImplementPrompt(''),
  'Implement the approved plan. Read the latest plan file and implement it.'
);

rmSync(inputCwd, { recursive: true, force: true });
console.log('All chat-plan-persist tests passed.');
