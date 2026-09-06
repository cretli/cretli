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
  withInheritedFollowUp,
  resolvePendingInheritedSend,
} from '../lib/conversation-fork.js';
import {
  appendChatHistoryEvents,
  copyChatHistory,
  copyChatHistoryUntil,
  deleteChatHistory,
  loadChatHistory,
} from '../lib/persist/chat-history-persist.js';
import { formatChatHistoryEventsToText } from '../lib/context-compression.js';
import {
  createConversationForkChat,
  deleteChat,
  loadChats,
  saveChats,
} from '../lib/persist/chats-persist.js';
import { resolveDataPath } from '../lib/runtime-paths.js';

const prompt = buildConversationForkPrompt('User: start\nAgent: reply', 'Continue here', {
  sourceChatId: 'aaaaaaaa-1111-2222-3333-444444444444',
  sourceChatTitle: 'Ask',
  copiedThroughSeq: 12,
});
assert.match(prompt, /CONVERSATION FORK CONTEXT/);
assert.match(prompt, /User: start/);
assert.match(prompt, /Continue here$/);
assert.match(prompt, /Source chat: "Ask" aaaaaaaa-1111-2222-3333-444444444444/);
assert.match(prompt, /Copied history through event seq 12/);
assert.match(prompt, /newest transcript file/);
assert.match(prompt, /chat_show or chat_history/);
assert.equal(buildConversationForkPrompt('', 'New message'), 'New message');
assert.match(buildConversationForkPrompt('User: start\nAgent: reply', ''), /Continue the conversation from this point\.$/);
assert.equal(buildConversationForkPrompt('', ''), '');
assert.equal(withInheritedFollowUp('', 'Go on'), 'Go on');
assert.equal(withInheritedFollowUp('Base prompt', ''), 'Base prompt');
assert.match(withInheritedFollowUp('Base prompt', 'Go on'), /Base prompt\n\nNew user message:\nGo on/);
assert.equal(resolvePendingInheritedSend('', 'Draft', 'Go on'), null);
assert.equal(
  resolvePendingInheritedSend('Full prompt', 'Continue from fork.', 'Continue from fork.').payloadText,
  'Full prompt'
);
assert.equal(
  resolvePendingInheritedSend('Full prompt', 'Continue from fork.', 'Continue from fork.').displayText,
  'Continue from fork.'
);
assert.equal(
  resolvePendingInheritedSend('Full prompt', 'Continue from fork.', 'My own question').payloadText,
  withInheritedFollowUp('Full prompt', 'My own question')
);
assert.equal(
  resolvePendingInheritedSend('Full prompt', 'Continue from fork.', 'My own question').displayText,
  'My own question'
);

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

// Partial fork: inherited transcript is cut at the fork point.
const partialForkPrompt = buildConversationForkPrompt('User: start\nAgent: reply', '', {
  partial: true,
  sourceChatId: 'aaaaaaaa-1111-2222-3333-444444444444',
  copiedThroughSeq: 4,
});
assert.match(partialForkPrompt, /up to the fork point\.$/m);
assert.match(partialForkPrompt, /only through event seq 4/);
assert.equal(partialForkPrompt.includes('full conversation'), false);

const partialHandoffPrompt = buildHarnessHandoffPrompt({
  sourceText: 'User: start',
  fromHarness: 'qwen',
  toHarness: 'sdk',
  partial: true,
});
assert.match(partialHandoffPrompt, /Conversation so far \(up to the fork point\):/);

const partialInitialPrompt = buildForkInitialPrompt({
  sourceText: 'User: start\nAgent: reply',
  fromHarness: 'qwen',
  toHarness: 'qwen',
  partial: true,
});
assert.match(partialInitialPrompt, /CONVERSATION FORK CONTEXT/);
assert.match(partialInitialPrompt, /up to the fork point\./);

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
assert.match(handoff, /Continue the unfinished work of the source chat/);
assert.doesNotMatch(handoff, /Continue from where the previous agent left off/);
assert.match(handoff, /chat_history/);
assert.match(handoff, /newest transcript file/);

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

const analysisPrompt = buildAgentAnalysisPrompt('Diagnose the agent.');
assert.match(analysisPrompt, /AGENT ANALYSIS CONTEXT/);
assert.match(analysisPrompt, /new sub-chat with its own empty history/);
assert.match(analysisPrompt, /Do not continue its work/);
assert.match(analysisPrompt, /Diagnose the agent\.$/);
assert.equal(analysisPrompt.includes('HARNESS HANDOFF CONTEXT'), false);
assert.equal(analysisPrompt.includes('CONVERSATION FORK CONTEXT'), false);
assert.equal(analysisPrompt.includes('User: start'), false);
assert.equal(analysisPrompt.includes('Source conversation:'), false);

const inheritedAnalyze = parseInheritedPrompt(analysisPrompt);
assert.equal(inheritedAnalyze.wrapped, true);
assert.equal(inheritedAnalyze.kind, 'analyze');
assert.equal(inheritedAnalyze.followUp, 'Diagnose the agent.');
assert.equal(
  resolveInheritedPromptEcho(analysisPrompt, { analyze: 'Analyze the current agent.' }),
  'Analyze the current agent.'
);

const crossHarnessAnalyze = buildForkInitialPrompt({
  sourceText: 'User: start\nAgent: should not appear',
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
assert.equal(crossHarnessAnalyze.includes('User: start'), false);
assert.equal(crossHarnessAnalyze.includes('Agent: should not appear'), false);
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

// Partial copy: everything up to (and including) the record created at the cutoff.
const T1 = '2026-01-01T00:00:01.000Z';
const T2 = '2026-01-01T00:00:02.000Z';
const T3 = '2026-01-01T00:00:03.000Z';
const partialSourceId = randomUUID();
const partialTargetId = randomUUID();
try {
  appendChatHistoryEvents(partialSourceId, 'source-session', [
    { rec: { kind: 'localUser', text: 'start', createdAt: T1 }, clientSeq: 1 },
    // Records without createdAt count as "before the fork point".
    { rec: { kind: 'meta', variant: 'notice', payload: 'mid-run' }, clientSeq: 2 },
    {
      rec: {
        kind: 'sdk',
        event: { type: 'assistant', message: { content: [{ type: 'text', text: 'assistant reply' }] } },
        createdAt: T2,
      },
      clientSeq: 3,
    },
    { rec: { kind: 'localUser', text: 'go on FOREIGN_DELEGATION_MARKER', createdAt: T3 }, clientSeq: 4 },
  ]);
  const cut = copyChatHistoryUntil(partialSourceId, partialTargetId, 'target-session', T2);
  assert.equal(cut.ok, true);
  assert.equal(cut.headSeq, 3);
  assert.equal(cut.events.length, 3);
  const target = loadChatHistory(partialTargetId);
  assert.equal(target?.headSeq, 3);
  assert.equal(target?.events.length, 3);
  assert.equal(target?.events[0]?.rec?.text, 'start');
  assert.equal(target?.events[1]?.rec?.payload, 'mid-run');
  assert.equal(target?.events[2]?.rec?.event?.type, 'assistant');
  assert.equal(target?.events.some((e) => String(e.rec?.text || '').includes('go on')), false);
  for (const event of target?.events || []) {
    assert.equal(event.rec?.clientSeq, undefined);
  }
  // The transcript built from the cut log keeps the copied turns and drops the rest.
  const cutTranscript = formatChatHistoryEventsToText(cut.events);
  assert.match(cutTranscript, /(^|\n)> start\n/);
  assert.match(cutTranscript, /assistant reply$/);
  assert.equal(cutTranscript.includes('go on'), false);
  assert.equal(cutTranscript.includes('FOREIGN_DELEGATION_MARKER'), false);

  // Cutoff before the first record — empty fork with a monotonic headSeq.
  const emptyCut = copyChatHistoryUntil(
    partialSourceId,
    partialTargetId,
    'target-session',
    '2020-01-01T00:00:00.000Z'
  );
  assert.equal(emptyCut.ok, true);
  assert.equal(emptyCut.headSeq, 0);
  assert.equal(emptyCut.events.length, 0);
  assert.equal(loadChatHistory(partialTargetId)?.events.length, 0);

  // Unparsable cutoff disables the cut (full copy fallback).
  const fullCut = copyChatHistoryUntil(partialSourceId, partialTargetId, 'target-session', 'not-a-date');
  assert.equal(fullCut.ok, true);
  assert.equal(fullCut.headSeq, 4);
  assert.equal(fullCut.events.length, 4);
  assert.equal(loadChatHistory(partialTargetId)?.headSeq, 4);
} finally {
  deleteChatHistory(partialSourceId);
  deleteChatHistory(partialTargetId);
}

const chatsFile = resolveDataPath('chats.json');
const chatsBackup = fs.existsSync(chatsFile) ? fs.readFileSync(chatsFile, 'utf8') : null;
let createdForkId = '';
let createdAnalyzeId = '';
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
  const analyzed = createConversationForkChat(parentChat, {
    agentTransport: 'opencode',
    model: 'opencode/glm-4.6',
    title: 'Analyze parent',
    forkKind: 'analyze',
  });
  createdAnalyzeId = analyzed.id;
  assert.equal(analyzed.forkKind, 'analyze');
  assert.equal(analyzed.forkParentChatId, parentId);
  assert.equal(analyzed.summaries, undefined);
} finally {
  if (createdAnalyzeId) deleteChat(createdAnalyzeId);
  if (createdForkId) deleteChat(createdForkId);
  if (chatsBackup == null) {
    if (fs.existsSync(chatsFile)) fs.unlinkSync(chatsFile);
  } else {
    fs.writeFileSync(chatsFile, chatsBackup, 'utf8');
  }
}

console.log('All conversation fork tests passed.');
