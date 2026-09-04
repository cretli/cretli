import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import {
  HARNESS_HANDOFF_MAX_CHARS,
  buildAgentAnalysisPrompt,
  buildConversationForkPrompt,
  buildForkInitialPrompt,
  buildHarnessHandoffPrompt,
  parseInheritedPrompt,
  resolveInheritedPromptEcho,
} from '../lib/conversation-fork.js';
import {
  appendChatHistoryEvents,
  copyChatHistory,
  deleteChatHistory,
  loadChatHistory,
} from '../lib/persist/chat-history-persist.js';
import {
  createConversationForkChat,
  deleteChat,
  loadChats,
  saveChats,
} from '../lib/persist/chats-persist.js';
import { resolveDataPath } from '../lib/runtime-paths.js';

const prompt = buildConversationForkPrompt('User: start\nAgent: reply', 'Continue here');
assert.match(prompt, /CONVERSATION FORK CONTEXT/);
assert.match(prompt, /User: start/);
assert.match(prompt, /Continue here$/);
assert.equal(buildConversationForkPrompt('', 'New message'), 'New message');
assert.match(buildConversationForkPrompt('User: start\nAgent: reply', ''), /Continue the conversation from this point\.$/);
assert.equal(buildConversationForkPrompt('', ''), '');

const sameHarnessPrompt = buildForkInitialPrompt({
  sourceText: 'User: start',
  message: 'Go on',
  fromHarness: 'qwen',
  toHarness: 'qwen',
  fromModel: 'qwen3',
  toModel: 'qwen3',
});
assert.match(sameHarnessPrompt, /CONVERSATION FORK CONTEXT/);
assert.match(sameHarnessPrompt, /Go on$/);

const crossHarnessPrompt = buildForkInitialPrompt({
  sourceText: 'User: start',
  fromHarness: 'qwen',
  toHarness: 'opencode',
  fromModel: 'qwen3',
  toModel: 'opencode/glm-4.6',
});
assert.match(crossHarnessPrompt, /HARNESS HANDOFF CONTEXT/);
assert.match(crossHarnessPrompt, /Previous harness: qwen \(qwen3\)/);
assert.match(crossHarnessPrompt, /Your harness: opencode \(opencode\/glm-4\.6\)/);
assert.equal(crossHarnessPrompt.includes('CONVERSATION FORK CONTEXT'), false);

const handoff = buildHarnessHandoffPrompt({
  sourceText: 'User: start\nAgent: mid-task',
  fromHarness: 'qwen',
  toHarness: 'sdk',
  fromModel: 'qwen3.8-flash',
  toModel: 'auto',
});
assert.match(handoff, /HARNESS HANDOFF CONTEXT/);
assert.match(handoff, /Previous harness: qwen \(qwen3\.8-flash\)/);
assert.match(handoff, /Your harness: sdk \(auto\)/);
assert.match(handoff, /User: start/);
assert.match(handoff, /Continue from where the previous agent left off/);

const emptyHandoff = buildHarnessHandoffPrompt({ fromHarness: 'sdk', toHarness: 'qwen' });
assert.match(emptyHandoff, /No conversation transcript was available/);

const longSource = `HEAD-UNIQUE-MARKER${'x'.repeat(HARNESS_HANDOFF_MAX_CHARS)}TAIL`;
const clipped = buildHarnessHandoffPrompt({ sourceText: longSource, fromHarness: 'sdk', toHarness: 'qwen' });
assert.match(clipped, /Earlier conversation truncated/);
assert.match(clipped, /TAIL/);
assert.equal(clipped.includes('HEAD-UNIQUE-MARKER'), false);

const inheritedFork = parseInheritedPrompt(sameHarnessPrompt);
assert.equal(inheritedFork.wrapped, true);
assert.equal(inheritedFork.kind, 'fork');
assert.equal(inheritedFork.followUp, 'Go on');
assert.equal(
  resolveInheritedPromptEcho(sameHarnessPrompt, { fork: 'Continue from fork.' }),
  'Go on'
);

const inheritedHandoff = parseInheritedPrompt(crossHarnessPrompt);
assert.equal(inheritedHandoff.wrapped, true);
assert.equal(inheritedHandoff.kind, 'handoff');
assert.equal(inheritedHandoff.followUp, '');
assert.equal(
  resolveInheritedPromptEcho(crossHarnessPrompt, { handoff: 'Continue previous work.' }),
  'Continue previous work.'
);
assert.equal(parseInheritedPrompt('Just a normal message').wrapped, false);
assert.equal(resolveInheritedPromptEcho('Just a normal message'), 'Just a normal message');

const analysisPrompt = buildAgentAnalysisPrompt('User: start\nAgent: stuck', 'Diagnose the agent.');
assert.match(analysisPrompt, /AGENT ANALYSIS CONTEXT/);
assert.match(analysisPrompt, /Do not continue its work/);
assert.match(analysisPrompt, /User: start/);
assert.match(analysisPrompt, /Diagnose the agent\.$/);
assert.equal(analysisPrompt.includes('HARNESS HANDOFF CONTEXT'), false);
assert.equal(analysisPrompt.includes('CONVERSATION FORK CONTEXT'), false);

const inheritedAnalyze = parseInheritedPrompt(analysisPrompt);
assert.equal(inheritedAnalyze.wrapped, true);
assert.equal(inheritedAnalyze.kind, 'analyze');
assert.equal(inheritedAnalyze.followUp, 'Diagnose the agent.');
assert.equal(
  resolveInheritedPromptEcho(analysisPrompt, { analyze: 'Analyze the current agent.' }),
  'Analyze the current agent.'
);

const crossHarnessAnalyze = buildForkInitialPrompt({
  sourceText: 'User: start',
  message: 'Diagnose the agent.',
  fromHarness: 'qwen',
  toHarness: 'opencode',
  fromModel: 'qwen3',
  toModel: 'opencode/glm-4.6',
  analyze: true,
});
assert.match(crossHarnessAnalyze, /AGENT ANALYSIS CONTEXT/);
assert.equal(crossHarnessAnalyze.includes('HARNESS HANDOFF CONTEXT'), false);
assert.equal(crossHarnessAnalyze.includes('taking over this task'), false);
assert.match(crossHarnessAnalyze, /Diagnose the agent\.$/);

const sourceChatId = randomUUID();
const targetChatId = randomUUID();
try {
  appendChatHistoryEvents(sourceChatId, 'source-session', [
    {
      rec: {
        kind: 'localUser',
        text: 'First message',
        createdAt: new Date().toISOString(),
      },
      clientSeq: 1,
    },
  ]);
  const result = copyChatHistory(sourceChatId, targetChatId, 'target-session');
  assert.equal(result.ok, true);
  const target = loadChatHistory(targetChatId);
  assert.equal(target?.chatId, targetChatId);
  assert.equal(target?.cursorSessionId, 'target-session');
  assert.equal(target?.events.length, 1);
  assert.equal(target?.events[0]?.rec?.text, 'First message');
  assert.equal(target?.events[0]?.rec?.clientSeq, undefined);
} finally {
  deleteChatHistory(sourceChatId);
  deleteChatHistory(targetChatId);
}

const chatsFile = resolveDataPath('chats.json');
const chatsBackup = fs.existsSync(chatsFile) ? fs.readFileSync(chatsFile, 'utf8') : null;
let createdForkId = '';
try {
  const parentId = randomUUID();
  saveChats([
    {
      id: parentId,
      title: 'Parent chat',
      cursorSessionId: 'parent-session',
      agentTransport: 'qwen',
      model: 'qwen3',
      workspaceFile: '/tmp/ws.code-workspace',
      workspaceFolder: '/tmp/ws',
      createdAt: new Date().toISOString(),
    },
  ]);
  const parentChat = loadChats().find((entry) => entry.id === parentId);
  const forked = createConversationForkChat(parentChat, {
    agentTransport: 'opencode',
    model: 'opencode/glm-4.6',
    title: 'Custom fork',
  });
  createdForkId = forked.id;
  assert.equal(forked.agentTransport, 'opencode');
  assert.equal(forked.model, 'opencode/glm-4.6');
  assert.equal(forked.title, 'Custom fork');
  assert.equal(forked.forkParentChatId, parentId);
  assert.equal(forked.forkKind, 'conversation');
  const remainingParent = loadChats().find((entry) => entry.id === parentId);
  assert.ok(remainingParent);
  assert.equal(remainingParent.agentTransport, 'qwen');
  assert.equal(remainingParent.model, 'qwen3');
} finally {
  if (createdForkId) deleteChat(createdForkId);
  if (chatsBackup == null) {
    if (fs.existsSync(chatsFile)) fs.unlinkSync(chatsFile);
  } else {
    fs.writeFileSync(chatsFile, chatsBackup, 'utf8');
  }
}

console.log('All conversation fork tests passed.');
