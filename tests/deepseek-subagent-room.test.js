import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import {
  applyDeepSeekRoomNotification,
  resolveDeepSeekRoomOutcome,
  resolveDeepSeekRoomRunScope,
} from '../lib/deepseek/deepseek-agent-ws.js';
import { DEEPSEEK_EMPTY_RUN_ERROR } from '../lib/deepseek/deepseek-run-outcome.js';

const ROOT = 'dsh-root';
const CHILD = 'dsh-child';

function createRoom(rootId = ROOT) {
  return {
    deepseekSessionId: rootId,
    deepseekChildSessionIds: new Set(),
    chatId: '',
  };
}

function sessionEvent(sessionId, event) {
  return { method: 'session.event', params: { sessionId, event } };
}

function finishError(message) {
  return {
    type: 'assistant/chunk',
    data: {
      turn: 1,
      step: 1,
      chunk: {
        type: 'finish',
        reason: { kind: 'error', failure: { message } },
      },
    },
  };
}

function turnEnd(reason) {
  return { type: 'turn/end', data: { turn: 1, reason } };
}

function textMessage(text) {
  return {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text }] } },
  };
}

const room = createRoom();

const beforeStart = applyDeepSeekRoomNotification(room, sessionEvent(CHILD, finishError(
  'no adapter registered for provider "codex"',
)));
assert.deepEqual(beforeStart, []);
assert.equal(room.deepseekSessionId, ROOT);
assert.equal(room.deepseekChildSessionIds.has(CHILD), true);

const started = applyDeepSeekRoomNotification(room, {
  method: 'subagent.started',
  params: { parentSessionId: ROOT, childSessionId: CHILD, provider: 'codex' },
});
assert.equal(started.length, 1);
assert.equal(started[0].type, 'tool_call');
assert.equal(started[0].name, 'subagent');
assert.equal(started[0].status, 'running');
assert.equal(started.some((item) => item.type === 'assistant'), false);

const childAssistant = applyDeepSeekRoomNotification(room, sessionEvent(CHILD, {
  type: 'assistant/chunk',
  data: { chunk: { type: 'text-delta', text: 'should not leak' } },
}));
assert.deepEqual(childAssistant, []);

const finished = applyDeepSeekRoomNotification(room, {
  method: 'subagent.finished',
  params: { childSessionId: CHILD, parentSessionId: ROOT, status: 'error' },
});
assert.equal(finished.length, 1);
assert.equal(finished[0].name, 'subagent');
assert.equal(finished[0].status, 'error');
assert.match(String(finished[0].result), /delegation_start/);
assert.doesNotMatch(String(finished[0].result), /\[object Object\]/);
assert.doesNotMatch(String(finished[0].result), /DeepSeek subagent failed/);
assert.equal(room.deepseekSessionId, ROOT);

const parentText = applyDeepSeekRoomNotification(room, sessionEvent(ROOT, {
  type: 'assistant/chunk',
  data: { chunk: { type: 'text-delta', text: 'parent answer' } },
}));
assert.equal(parentText[0].type, 'assistant');
assert.equal(parentText[0].message.content[0].text, 'parent answer');

const blocksRoom = createRoom();
const blockOk = applyDeepSeekRoomNotification(blocksRoom, {
  method: 'subagent.finished',
  params: {
    childSessionId: 'child-ok',
    lastAssistantMessage: [{ type: 'text', text: 'child report' }],
  },
});
assert.equal(blockOk[0].status, 'completed');
assert.equal(blockOk[0].result, 'child report');
assert.equal(blocksRoom.deepseekSessionId, ROOT);
assert.equal(blocksRoom.deepseekChildSessionIds.has('child-ok'), true);

const emptyRoom = createRoom();
const emptyOk = applyDeepSeekRoomNotification(emptyRoom, {
  method: 'subagent.finished',
  params: { childSessionId: 'child-empty', status: 'ok' },
});
assert.equal(emptyOk[0].status, 'completed');
assert.equal(emptyOk[0].result, '');

const outcomeRoom = createRoom();
outcomeRoom.deepseekChildSessionIds.add(CHILD);
const inputChildErrorParentOk = {
  sessionId: CHILD,
  finalResponse: 'parent answer',
  events: [textMessage('parent answer'), turnEnd({ kind: 'completed' })],
  notifications: [
    sessionEvent(CHILD, turnEnd({ kind: 'error', error: { message: 'no adapter registered for provider "codex"' } })),
  ],
};
assert.equal(resolveDeepSeekRoomRunScope(outcomeRoom, inputChildErrorParentOk, ROOT).rootSessionId, ROOT);
assert.deepEqual(resolveDeepSeekRoomOutcome(outcomeRoom, inputChildErrorParentOk, ROOT), {
  status: 'completed',
  errorMessage: '',
  reasonKind: 'completed',
  isSessionCollision: false,
});

const inputChildOnlyText = {
  sessionId: ROOT,
  finalResponse: '',
  events: [],
  notifications: [
    sessionEvent(CHILD, textMessage('only child text')),
    sessionEvent(CHILD, turnEnd({ kind: 'completed' })),
  ],
};
assert.deepEqual(resolveDeepSeekRoomOutcome(outcomeRoom, inputChildOnlyText, ROOT), {
  status: 'error',
  errorMessage: DEEPSEEK_EMPTY_RUN_ERROR,
  reasonKind: '',
  isSessionCollision: false,
});

removeIsolatedDataDir();
console.log('deepseek-subagent-room.test.js OK');
