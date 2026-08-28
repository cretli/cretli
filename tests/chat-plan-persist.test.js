import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  buildChatPlanPromptContext,
  buildChatPlanRelativePath,
  pickRicherPlanMarkdown,
  readChatPlanFile,
  stripChatPlanComment,
  writeChatPlanFile,
} from '../lib/chat-plan-persist.js';

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
});
assert.match(readChatPlanFile({ cwd: inputCwd, chatId: inputChatId }), /Fix the toolbar/);
assert.equal(readChatPlanFile({ cwd: inputCwd, chatId: inputChatId }).includes('too short'), false);
assert.equal(
  stripChatPlanComment(`${actualFile}`).includes('cretli-chat-plan'),
  false
);
assert.match(stripChatPlanComment(actualFile), /^# Bar heights/);

rmSync(inputCwd, { recursive: true, force: true });
console.log('All chat-plan-persist tests passed.');
