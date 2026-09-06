import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  commandTouchesHistoryStore,
  ensureHistoryStoreIgnoreFiles,
  findHistoryStoreDirectories,
  HISTORY_STORE_IGNORE_PATTERNS,
  HISTORY_STORE_NESTED_IGNORE_PATTERNS,
  historyStoreBlockedMessage,
  isHistoryStorePath,
  matchesHistoryStoreIgnore,
  OBSOLETE_HISTORY_STORE_IGNORE_PATTERNS,
  OBSOLETE_NESTED_HISTORY_STORE_IGNORE_PATTERNS,
  sealHistoryStoreDirectory,
  syncHistoryStoreIgnoreFile,
} from '../lib/agent-harness/history-store-guard.js';
import {
  collectSdkConversationToolCalls,
  collectSdkToolCallEvent,
  evaluateSdkHistoryIsolationEvidence,
  HELLO_PROBE_CONTENT,
  HELLO_PROBE_CONTENT_A,
  HELLO_PROBE_CONTENT_B,
  HISTORY_ISOLATION_MARKER,
  isCompletedSdkToolCall,
  statusFromHarvestedSdkToolResult,
} from '../lib/sdk/sdk-history-isolation.js';
import { createSdkHistoryIsolationFixture } from '../lib/sdk/sdk-history-isolation-probe.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

assert.equal(isHistoryStorePath(''), false);
assert.equal(isHistoryStorePath('/tmp/project/src/app.js'), false);
assert.equal(
  isHistoryStorePath('/tmp/cretli/data/runtime-home/.cursor/projects/ws/agent-transcripts/agent-abc.jsonl'),
  true,
);
assert.equal(isHistoryStorePath('/tmp/cretli/data/chat-history/aaaaaaaa-1111.json'), true);
assert.equal(isHistoryStorePath('data/sdk-agent-store/session.json'), true);
assert.equal(
  isHistoryStorePath('/extra/cursor-dir/.cursor/projects/other/agent-transcripts/agent-xyz.jsonl'),
  true,
);
assert.equal(isHistoryStorePath('/tmp/project/agent-transcripts.txt'), false);
assert.equal(
  matchesHistoryStoreIgnore('data/runtime-home/.cursor/projects/home-ar2oor-www-cretli/agent-transcripts/agent-9bd3fb76.jsonl'),
  true,
);
assert.equal(matchesHistoryStoreIgnore('src/app.js'), false);
assert.equal(commandTouchesHistoryStore('rg hello.txt'), false);
assert.equal(commandTouchesHistoryStore(`cat data/chat-history/chat.json`), true);
assert.equal(
  commandTouchesHistoryStore('cat /tmp/cretli/data/runtime-home/.cursor/projects/ws/agent-transcripts/a.jsonl'),
  true,
);

const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-hist-link-'));
const storeFile = path.join(linkDir, 'agent-transcripts', 'secret.jsonl');
fs.mkdirSync(path.dirname(storeFile), { recursive: true });
fs.writeFileSync(storeFile, 'secret\n', 'utf8');
const alias = path.join(linkDir, 'safe-link.txt');
fs.symlinkSync(storeFile, alias);
assert.equal(isHistoryStorePath(alias), true);
fs.rmSync(linkDir, { recursive: true, force: true });

const extraRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-hist-ignore-'));
ensureHistoryStoreIgnoreFiles([extraRoot]);
const cursorIgnore = fs.readFileSync(path.join(extraRoot, '.cursorignore'), 'utf8');
for (const pattern of HISTORY_STORE_IGNORE_PATTERNS) {
  assert.ok(cursorIgnore.includes(pattern), `synced .cursorignore missing ${pattern}`);
}
fs.rmSync(extraRoot, { recursive: true, force: true });

const repoIgnore = fs.readFileSync(path.join(root, '.cursorignore'), 'utf8');
const rgIgnore = fs.readFileSync(path.join(root, '.rgignore'), 'utf8');
for (const token of ['agent-transcripts', 'chat-history', 'sdk-agent-store']) {
  assert.ok(repoIgnore.includes(token), `.cursorignore missing ${token}`);
  assert.ok(rgIgnore.includes(token), `.rgignore missing ${token}`);
}
const repoIgnoreLines = new Set(repoIgnore.split(/\r?\n/).map((line) => line.trim()));
for (const pattern of OBSOLETE_HISTORY_STORE_IGNORE_PATTERNS) {
  assert.equal(repoIgnoreLines.has(pattern), false, `.cursorignore still has ${pattern}`);
}
assert.equal(HISTORY_STORE_IGNORE_PATTERNS.includes('data/runtime-home/'), false);
assert.equal(HISTORY_STORE_IGNORE_PATTERNS.includes('data/runtime-home/**'), false);
assert.match(historyStoreBlockedMessage(), /chat_show|chat_history/);

assert.equal(isCompletedSdkToolCall({ name: 'glob', status: 'running' }), false);
assert.equal(isCompletedSdkToolCall({ name: 'glob', status: 'cancelled' }), false);
assert.equal(isCompletedSdkToolCall({ name: 'read', status: 'completed', result: { content: 'x' } }), true);
assert.equal(isCompletedSdkToolCall({ name: 'read', result: { content: 'x' } }), true);

const coalescedAttempt = evaluateSdkHistoryIsolationEvidence({
  toolCalls: [
    { name: 'glob', status: 'running', args: { target_directory: '/tmp/ws/agent-transcripts' } },
    { name: 'glob', status: 'completed', result: { files: [] } },
    { name: 'read', status: 'completed', args: { path: '/tmp/ws/hello.txt' }, result: { content: HELLO_PROBE_CONTENT } },
  ],
  requiredAttempts: [
    { id: 'glob-transcript', toolNeedles: ['glob'], pathNeedles: ['/tmp/ws/agent-transcripts'] },
    { id: 'read-hello', toolNeedles: ['read'], pathNeedles: ['hello.txt'] },
  ],
});
assert.equal(coalescedAttempt.ok, true);
assert.equal(coalescedAttempt.completedToolCallCount, 2);

const leak = evaluateSdkHistoryIsolationEvidence({
  toolCalls: [{ name: 'read', result: { content: HISTORY_ISOLATION_MARKER } }],
  blockedBasenames: ['agent-delegation-probe.jsonl'],
});
assert.equal(leak.ok, false);
assert.equal(leak.leaks[0].reason, 'marker');

const filenameEcho = evaluateSdkHistoryIsolationEvidence({
  toolCalls: [
    { name: 'read', status: 'completed', args: { path: 'hello.txt' }, result: { error: 'denied' } },
    { name: 'glob', status: 'running', args: { glob_pattern: '**/*' } },
    { name: 'grep', status: 'running', args: { pattern: HISTORY_ISOLATION_MARKER } },
  ],
  requiredAttempts: [
    { id: 'glob', toolNeedles: ['glob'] },
    { id: 'grep', toolNeedles: ['grep'] },
    { id: 'read-hello', toolNeedles: ['read'], pathNeedles: ['hello.txt'] },
  ],
  blockedBasenames: ['agent-delegation-probe.jsonl'],
});
assert.equal(filenameEcho.ok, false);
assert.equal(filenameEcho.helloSeen, false);
assert.ok(filenameEcho.missingAttempts.includes('glob'));
assert.ok(filenameEcho.missingAttempts.includes('grep'));

const clean = evaluateSdkHistoryIsolationEvidence({
  toolCalls: [
    { name: 'glob', result: { files: ['hello.txt'] } },
    { name: 'read', args: { path: '/ws/hello.txt' }, result: { content: HELLO_PROBE_CONTENT } },
    { name: 'read', result: { path: '/abs/agent-delegation-probe.jsonl', error: 'denied' } },
  ],
  requiredAttempts: [
    { id: 'glob', toolNeedles: ['glob'] },
    { id: 'read-hello', toolNeedles: ['read'], pathNeedles: ['hello.txt'] },
    { id: 'read-transcript', toolNeedles: ['read'], pathNeedles: ['agent-delegation-probe.jsonl'] },
  ],
  blockedBasenames: ['agent-delegation-probe.jsonl'],
});
assert.equal(clean.ok, true);
assert.equal(clean.helloSeen, true);

const listedLeak = evaluateSdkHistoryIsolationEvidence({
  toolCalls: [
    { name: 'glob', result: { files: ['hello.txt', 'agent-delegation-probe.jsonl'] } },
  ],
  blockedBasenames: ['agent-delegation-probe.jsonl'],
});
assert.equal(listedLeak.ok, false);
assert.ok(listedLeak.leaks.some((row) => row.reason === 'basename'));

const listedHello = evaluateSdkHistoryIsolationEvidence({
  toolCalls: [
    { name: 'glob', result: { files: ['hello.txt', 'ASK_TASK.md'] } },
    { name: 'read', result: { error: 'Conversation history is not available' } },
  ],
  blockedBasenames: ['agent-delegation-probe.jsonl'],
});
assert.equal(listedHello.ok, false);
assert.equal(listedHello.helloSeen, false);

const cancelledAttempt = evaluateSdkHistoryIsolationEvidence({
  toolCalls: [
    { name: 'glob', status: 'cancelled', args: { targetDirectory: '/tmp/ws/agent-transcripts' } },
    { name: 'read', status: 'completed', args: { path: '/tmp/ws/hello.txt' }, result: { content: HELLO_PROBE_CONTENT } },
  ],
  requiredAttempts: [
    { id: 'glob-transcript-dir', toolNeedles: ['glob'], pathNeedles: ['/tmp/ws/agent-transcripts'] },
    { id: 'read-hello', toolNeedles: ['read'], pathNeedles: ['hello.txt'] },
  ],
});
assert.equal(cancelledAttempt.ok, false);
assert.ok(cancelledAttempt.missingAttempts.includes('glob-transcript-dir'));
assert.equal(cancelledAttempt.attempts.find((row) => row.id === 'glob-transcript-dir')?.completed, false);

const runningOnlyExplicit = evaluateSdkHistoryIsolationEvidence({
  toolCalls: [
    { name: 'glob', status: 'running', callId: 'g1', args: { targetDirectory: '/tmp/ws/data/runtime-home/.cursor/projects/probe-workspace/agent-transcripts' } },
    { name: 'read', status: 'completed', args: { path: '/tmp/ws/hello.txt' }, result: { content: HELLO_PROBE_CONTENT } },
  ],
  requiredAttempts: [
    { id: 'glob-transcript-dir', toolNeedles: ['glob'], pathNeedles: ['agent-transcripts'] },
    { id: 'read-hello', toolNeedles: ['read'], pathNeedles: ['hello.txt'] },
  ],
});
assert.equal(runningOnlyExplicit.ok, false);
assert.ok(runningOnlyExplicit.missingAttempts.includes('glob-transcript-dir'));

const helloAssigned = evaluateSdkHistoryIsolationEvidence({
  toolCalls: [
    { name: 'read', status: 'completed', callId: 'ha', args: { path: '/tmp/ws/hello.txt' }, result: { content: HELLO_PROBE_CONTENT_A } },
    { name: 'read', status: 'completed', callId: 'hb', args: { path: '/tmp/extra/hello.txt' }, result: { content: HELLO_PROBE_CONTENT_B } },
  ],
  helloContents: [HELLO_PROBE_CONTENT_A, HELLO_PROBE_CONTENT_B],
  requiredAttempts: [
    { id: 'read-hello-a', toolNeedles: ['read'], pathNeedles: ['/tmp/ws/hello.txt'], resultNeedles: [HELLO_PROBE_CONTENT_A] },
    { id: 'read-hello-b', toolNeedles: ['read'], pathNeedles: ['/tmp/extra/hello.txt'], resultNeedles: [HELLO_PROBE_CONTENT_B] },
  ],
});
assert.equal(helloAssigned.ok, true);
assert.equal(helloAssigned.attempts.find((row) => row.id === 'read-hello-a')?.callId, 'ha');
assert.equal(helloAssigned.attempts.find((row) => row.id === 'read-hello-b')?.callId, 'hb');

const helloSwapped = evaluateSdkHistoryIsolationEvidence({
  toolCalls: [
    { name: 'read', status: 'completed', args: { path: '/tmp/ws/hello.txt' }, result: { content: HELLO_PROBE_CONTENT_B } },
    { name: 'read', status: 'completed', args: { path: '/tmp/extra/hello.txt' }, result: { content: HELLO_PROBE_CONTENT_A } },
  ],
  helloContents: [HELLO_PROBE_CONTENT_A, HELLO_PROBE_CONTENT_B],
  requiredAttempts: [
    { id: 'read-hello-a', toolNeedles: ['read'], pathNeedles: ['/tmp/ws/hello.txt'], resultNeedles: [HELLO_PROBE_CONTENT_A] },
    { id: 'read-hello-b', toolNeedles: ['read'], pathNeedles: ['/tmp/extra/hello.txt'], resultNeedles: [HELLO_PROBE_CONTENT_B] },
  ],
});
assert.equal(helloSwapped.ok, false);
assert.ok(helloSwapped.missingAttempts.includes('read-hello-a'));
assert.ok(helloSwapped.missingAttempts.includes('read-hello-b'));

const deniedHello = evaluateSdkHistoryIsolationEvidence({
  toolCalls: [
    { name: 'read', status: 'completed', args: { path: '/tmp/ws/hello.txt' }, result: { error: 'denied' } },
  ],
  requiredAttempts: [
    { id: 'read-hello-a', toolNeedles: ['read'], pathNeedles: ['/tmp/ws/hello.txt'], resultNeedles: [HELLO_PROBE_CONTENT_A] },
  ],
});
assert.equal(deniedHello.ok, false);
assert.equal(deniedHello.helloSeen, false);
assert.ok(deniedHello.missingAttempts.includes('read-hello-a'));

const mixedCallIds = evaluateSdkHistoryIsolationEvidence({
  toolCalls: [
    { name: 'glob', status: 'running', args: { target_directory: '/tmp/ws/agent-transcripts' } },
    { name: 'glob', status: 'completed', callId: 'g-mixed', result: { files: [] } },
    { name: 'read', status: 'completed', args: { path: '/tmp/ws/hello.txt' }, result: { content: HELLO_PROBE_CONTENT } },
  ],
  requiredAttempts: [
    { id: 'glob-transcript-dir', toolNeedles: ['glob'], pathNeedles: ['agent-transcripts'] },
    { id: 'read-hello', toolNeedles: ['read'], pathNeedles: ['hello.txt'] },
  ],
});
assert.equal(mixedCallIds.ok, true);
assert.equal(mixedCallIds.attempts.find((row) => row.id === 'glob-transcript-dir')?.completed, true);
assert.equal(mixedCallIds.attempts.find((row) => row.id === 'glob-transcript-dir')?.callId, 'g-mixed');

const completedThenArgs = evaluateSdkHistoryIsolationEvidence({
  toolCalls: [
    { name: 'read', status: 'completed', callId: 'r1', result: { error: 'Conversation history is not available' } },
    { name: 'read', status: 'running', args: { path: '/tmp/ws/data/runtime-home/.cursor/projects/probe-workspace/agent-transcripts/agent-delegation-probe.jsonl' } },
    { name: 'read', status: 'completed', args: { path: '/tmp/ws/hello.txt' }, result: { content: HELLO_PROBE_CONTENT } },
  ],
  requiredAttempts: [
    { id: 'read-transcript', toolNeedles: ['read'], pathNeedles: ['agent-delegation-probe.jsonl'] },
    { id: 'read-hello', toolNeedles: ['read'], pathNeedles: ['hello.txt'] },
  ],
  blockedBasenames: ['agent-delegation-probe.jsonl'],
});
assert.equal(completedThenArgs.ok, true);
assert.equal(completedThenArgs.attempts.find((row) => row.id === 'read-transcript')?.completed, true);

const assistantToolUseOnly = evaluateSdkHistoryIsolationEvidence({
  toolCalls: [
    { name: 'glob', status: 'running', args: { target_directory: '/tmp/ws/agent-transcripts' } },
    { name: 'read', status: 'completed', args: { path: '/tmp/ws/hello.txt' }, result: { content: HELLO_PROBE_CONTENT } },
  ],
  requiredAttempts: [
    { id: 'glob-transcript-dir', toolNeedles: ['glob'], pathNeedles: ['agent-transcripts'] },
    { id: 'read-hello', toolNeedles: ['read'], pathNeedles: ['hello.txt'] },
  ],
});
assert.equal(assistantToolUseOnly.ok, false);
assert.ok(assistantToolUseOnly.missingAttempts.includes('glob-transcript-dir'));

const missingExplicitStillFails = evaluateSdkHistoryIsolationEvidence({
  toolCalls: [
    { name: 'glob', status: 'completed', args: { glob_pattern: '**/*' }, result: { files: ['hello.txt'] } },
    { name: 'read', status: 'completed', args: { path: '/tmp/ws/hello.txt' }, result: { content: HELLO_PROBE_CONTENT } },
  ],
  requiredAttempts: [
    { id: 'glob-root', toolNeedles: ['glob'] },
    { id: 'glob-transcript-dir', toolNeedles: ['glob'], pathNeedles: ['agent-transcripts'] },
    { id: 'read-hello', toolNeedles: ['read'], pathNeedles: ['hello.txt'] },
  ],
});
assert.equal(missingExplicitStillFails.ok, false);
assert.ok(missingExplicitStillFails.missingAttempts.includes('glob-transcript-dir'));
assert.equal(missingExplicitStillFails.helloSeen, true);

const envelopeCollected = [];
collectSdkToolCallEvent({
  type: 'sdk_message',
  message: {
    type: 'tool_call',
    call_id: 'env-1',
    name: 'read',
    status: 'completed',
    args: { path: '/tmp/ws/hello.txt' },
    result: { content: HELLO_PROBE_CONTENT },
  },
}, envelopeCollected);
assert.equal(envelopeCollected[0]?.callId, 'env-1');
assert.equal(isCompletedSdkToolCall(envelopeCollected[0]), true);

const newlineBucket = [];
collectSdkToolCallEvent({
  type: 'tool_call',
  name: 'glob',
  status: 'running',
  call_id: 'call-aaa-0\nfc_bbb_0',
  args: { globPattern: '**/*', targetDirectory: '/tmp/ws/agent-transcripts' },
}, newlineBucket);
collectSdkToolCallEvent({
  type: 'tool_call',
  name: 'glob',
  status: 'completed',
  call_id: 'call-aaa-0',
  result: { files: [] },
}, newlineBucket);
collectSdkToolCallEvent({
  type: 'tool_call',
  name: 'read',
  status: 'completed',
  call_id: 'r-hello',
  args: { path: '/tmp/ws/hello.txt' },
  result: { content: HELLO_PROBE_CONTENT },
}, newlineBucket);
const newlineCallId = evaluateSdkHistoryIsolationEvidence({
  toolCalls: newlineBucket,
  requiredAttempts: [
    { id: 'glob-transcript-dir', toolNeedles: ['glob'], pathNeedles: ['agent-transcripts'] },
    { id: 'read-hello', toolNeedles: ['read'], pathNeedles: ['hello.txt'] },
  ],
});
assert.equal(newlineCallId.ok, true);
assert.equal(newlineCallId.attempts.find((row) => row.id === 'glob-transcript-dir')?.callId, 'call-aaa-0');

const globEmptyStoreDir = evaluateSdkHistoryIsolationEvidence({
  toolCalls: [
    {
      name: 'glob',
      status: 'completed',
      callId: 'g-empty',
      args: { globPattern: '**/*', targetDirectory: '/tmp/ws/data/runtime-home/.cursor/projects/probe-workspace/agent-transcripts' },
      result: { status: 'success', value: { files: [], totalFiles: 0 } },
    },
    { name: 'read', status: 'completed', args: { path: '/tmp/ws/hello.txt' }, result: { content: HELLO_PROBE_CONTENT } },
  ],
  requiredAttempts: [
    { id: 'glob-transcript-dir', toolNeedles: ['glob'], pathNeedles: ['agent-transcripts'] },
    { id: 'read-hello', toolNeedles: ['read'], pathNeedles: ['hello.txt'] },
  ],
  blockedBasenames: ['agent-delegation-probe.jsonl'],
});
assert.equal(globEmptyStoreDir.ok, true);
assert.equal(globEmptyStoreDir.leaks.length, 0);
assert.equal(globEmptyStoreDir.attempts.find((row) => row.id === 'glob-transcript-dir')?.callId, 'g-empty');

const ignoredReadDropped = evaluateSdkHistoryIsolationEvidence({
  toolCalls: [
    {
      name: 'read',
      status: 'running',
      callId: 'r-drop',
      args: { path: '/tmp/ws/data/runtime-home/.cursor/projects/probe-workspace/agent-transcripts/agent-delegation-probe.jsonl' },
    },
    { name: 'read', status: 'completed', args: { path: '/tmp/ws/hello.txt' }, result: { content: HELLO_PROBE_CONTENT } },
  ],
  requiredAttempts: [
    { id: 'read-transcript', toolNeedles: ['read'], pathNeedles: ['agent-delegation-probe.jsonl'] },
    { id: 'read-hello', toolNeedles: ['read'], pathNeedles: ['hello.txt'] },
  ],
});
assert.equal(ignoredReadDropped.ok, false);
assert.ok(ignoredReadDropped.missingAttempts.includes('read-transcript'));
assert.equal(ignoredReadDropped.attempts.find((row) => row.id === 'read-transcript')?.completed, false);
assert.equal(ignoredReadDropped.attempts.find((row) => row.id === 'read-transcript')?.status, 'running');

const conversationHarvested = [];
collectSdkConversationToolCalls([
  {
    type: 'agentConversationTurn',
    turn: {
      steps: [
        {
          type: 'toolCall',
          message: {
            type: 'glob',
            args: { globPattern: '**/*', targetDirectory: '/tmp/ws/agent-transcripts' },
            result: { status: 'success', value: { files: [], totalFiles: 0 } },
          },
        },
      ],
    },
  },
], conversationHarvested);
assert.equal(conversationHarvested[0]?.name, 'glob');
assert.equal(isCompletedSdkToolCall(conversationHarvested[0]), true);

assert.equal(statusFromHarvestedSdkToolResult({ content: HELLO_PROBE_CONTENT_A }), 'completed');
assert.equal(statusFromHarvestedSdkToolResult({ error: 'denied' }), 'error');
assert.equal(statusFromHarvestedSdkToolResult(undefined), 'running');

const contentWithoutStatus = [];
collectSdkConversationToolCalls([
  {
    type: 'agentConversationTurn',
    turn: {
      steps: [
        {
          type: 'toolCall',
          message: {
            type: 'read',
            args: { path: '/tmp/ws/hello.txt' },
            result: { content: HELLO_PROBE_CONTENT_A },
          },
        },
      ],
    },
  },
], contentWithoutStatus);
assert.equal(contentWithoutStatus[0]?.status, 'completed');
assert.equal(isCompletedSdkToolCall(contentWithoutStatus[0]), true);

const messagesListHarvest = [];
collectSdkConversationToolCalls([
  {
    message: {
      agentConversationTurn: {
        steps: [
          {
            toolCall: {
              readToolCall: {
                toolCallId: 'r-list',
                args: {
                  path: '/tmp/ws/data/runtime-home/.cursor/projects/probe-workspace/agent-transcripts/agent-delegation-probe.jsonl',
                },
                result: { error: 'Conversation history is not available' },
              },
            },
          },
          {
            toolCall: {
              globToolCall: {
                toolCallId: 'g-list',
                args: {
                  globPattern: '**/*',
                  targetDirectory: '/tmp/ws/data/runtime-home/.cursor/projects/probe-workspace/agent-transcripts',
                },
                result: { files: [], totalFiles: 0 },
              },
            },
          },
        ],
      },
    },
  },
], messagesListHarvest);
const messagesListEvidence = evaluateSdkHistoryIsolationEvidence({
  toolCalls: [
    ...messagesListHarvest,
    {
      name: 'read',
      status: 'completed',
      args: { path: '/tmp/ws/hello.txt' },
      result: { content: HELLO_PROBE_CONTENT },
    },
  ],
  requiredAttempts: [
    { id: 'glob-transcript-dir', toolNeedles: ['glob'], pathNeedles: ['agent-transcripts'] },
    { id: 'read-transcript', toolNeedles: ['read'], pathNeedles: ['agent-delegation-probe.jsonl'] },
    { id: 'read-hello', toolNeedles: ['read'], pathNeedles: ['hello.txt'] },
  ],
  blockedBasenames: ['agent-delegation-probe.jsonl'],
});
assert.equal(messagesListEvidence.ok, true);
assert.equal(messagesListEvidence.attempts.find((row) => row.id === 'read-transcript')?.completed, true);
assert.equal(messagesListEvidence.attempts.find((row) => row.id === 'read-transcript')?.callId, 'r-list');
assert.equal(messagesListEvidence.attempts.find((row) => row.id === 'glob-transcript-dir')?.callId, 'g-list');
assert.equal(messagesListEvidence.attempts.find((row) => row.id === 'glob-transcript-dir')?.completed, true);

const globRootDoesNotCoverExplicitDir = evaluateSdkHistoryIsolationEvidence({
  toolCalls: [
    { name: 'glob', status: 'completed', args: { globPattern: '**/*' }, result: { files: ['hello.txt'] } },
    { name: 'read', status: 'completed', args: { path: '/tmp/ws/hello.txt' }, result: { content: HELLO_PROBE_CONTENT } },
  ],
  requiredAttempts: [
    { id: 'glob-root', toolNeedles: ['glob'] },
    { id: 'glob-transcript-dir', toolNeedles: ['glob'], pathNeedles: ['agent-transcripts'] },
    { id: 'read-hello', toolNeedles: ['read'], pathNeedles: ['hello.txt'] },
  ],
});
assert.equal(globRootDoesNotCoverExplicitDir.ok, false);
assert.ok(globRootDoesNotCoverExplicitDir.missingAttempts.includes('glob-transcript-dir'));

const pruneNestedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-hist-nested-prune-'));
fs.writeFileSync(path.join(pruneNestedDir, '.cursorignore'), '*\n**\nkeep-nested\n', 'utf8');
assert.equal(sealHistoryStoreDirectory(pruneNestedDir), true);
const nestedPruned = fs.readFileSync(path.join(pruneNestedDir, '.cursorignore'), 'utf8');
const nestedPrunedLines = new Set(nestedPruned.split(/\r?\n/).map((line) => line.trim()));
for (const pattern of OBSOLETE_NESTED_HISTORY_STORE_IGNORE_PATTERNS) {
  assert.equal(nestedPrunedLines.has(pattern), false, `nested ignore still has ${pattern}`);
}
for (const pattern of HISTORY_STORE_NESTED_IGNORE_PATTERNS) {
  assert.equal(nestedPrunedLines.has(pattern), true, `nested ignore missing ${pattern}`);
}
assert.equal(nestedPrunedLines.has('keep-nested'), true);
fs.rmSync(pruneNestedDir, { recursive: true, force: true });

const pruneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-hist-prune-'));
const pruneFile = path.join(pruneDir, '.cursorignore');
fs.writeFileSync(pruneFile, 'data/runtime-home/\ndata/runtime-home/**\n**/agent-transcripts/\nkeep-me\n', 'utf8');
assert.equal(syncHistoryStoreIgnoreFile(pruneFile), true);
const pruned = fs.readFileSync(pruneFile, 'utf8');
assert.equal(pruned.includes('data/runtime-home/'), false);
assert.equal(pruned.includes('**/agent-transcripts/**'), true);
assert.equal(pruned.includes('keep-me'), true);
fs.rmSync(pruneDir, { recursive: true, force: true });

const beforeIgnore = createSdkHistoryIsolationFixture({ applyIgnore: false });
assert.equal(beforeIgnore.ignoreApplied, false);
assert.equal(fs.existsSync(path.join(beforeIgnore.workspaceA, '.cursorignore')), false);
fs.rmSync(beforeIgnore.root, { recursive: true, force: true });
const afterIgnore = createSdkHistoryIsolationFixture();
assert.equal(afterIgnore.ignoreApplied, true);
assert.equal(fs.existsSync(path.join(afterIgnore.workspaceA, '.cursorignore')), true);
const nestedStores = findHistoryStoreDirectories(afterIgnore.workspaceA);
assert.ok(nestedStores.some((dir) => dir.endsWith('agent-transcripts')));
const nestedIgnore = fs.readFileSync(path.join(afterIgnore.transcriptDir, '.cursorignore'), 'utf8');
for (const pattern of HISTORY_STORE_NESTED_IGNORE_PATTERNS) {
  assert.ok(nestedIgnore.includes(pattern), `nested store ignore missing ${pattern}`);
}
assert.equal(HISTORY_STORE_NESTED_IGNORE_PATTERNS.includes('*'), false);
assert.equal(HISTORY_STORE_NESTED_IGNORE_PATTERNS.includes('**'), false);
assert.equal(afterIgnore.helloAContent, HELLO_PROBE_CONTENT_A);
assert.equal(afterIgnore.helloBContent, HELLO_PROBE_CONTENT_B);
assert.equal(fs.readFileSync(afterIgnore.helloA, 'utf8').includes(HELLO_PROBE_CONTENT_A), true);
assert.equal(fs.readFileSync(afterIgnore.helloB, 'utf8').includes(HELLO_PROBE_CONTENT_B), true);
fs.rmSync(afterIgnore.root, { recursive: true, force: true });

console.log('history-store-guard.test.js OK');
