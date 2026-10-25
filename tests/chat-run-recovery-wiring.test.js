import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addChat } from '../lib/persist/chats-persist.js';
import {
  registerChatRunAdapter,
  unregisterChatRunAdapter,
  startChatRun,
  cancelChatRun,
} from '../lib/chat-run-service.js';
import { registerRecoveryResumeRoutes } from '../lib/routes/recovery-resume-routes.js';
import { openRecoveryStore, closeRecoveryStore } from '../lib/recovery/recovery-store.ts';
import {
  getChatRunRecordByCallerRequest,
  noteChatRunFinished,
  noteChatRunStopped,
} from '../lib/chat-run/chat-run-recovery.ts';
import { bindRoomRecoveryLifecycle } from '../lib/chat-run/kernel-adapter.ts';
import { listRuns } from '../lib/recovery/recovery-store.ts';
import { makeTempDir } from './helpers/temp-dir.js';

const dataDir = makeTempDir('chat-run-recovery-');
const store = openRecoveryStore({ dataDir });

let startCalls = 0;
let nextStart = () => ({ runId: 'run-A', accepted: true });
const idle = { busy: false, waitingForInput: false };
function installAdapter(transport) {
  unregisterChatRunAdapter(transport);
  registerChatRunAdapter({
    transport,
    capabilities: {},
    lookupRequest: () => null,
    async start() {
      startCalls += 1;
      return nextStart();
    },
    async cancel() {},
    getState: () => idle,
  });
}
installAdapter('codex');

let seq = 0;
function newChat() {
  seq += 1;
  return addChat(`sess-wire-${seq}`, `Wire ${seq}`, null, '/tmp', 'm', { agentTransport: 'codex', sdkMode: 'agent' });
}

// 1. Intent + acceptance are written for a real startChatRun.
const chat1 = newChat();
const started = await startChatRun({ chatId: chat1.id, prompt: 'hi', requestId: 'att-wire-1' });
assert.equal(started.runId, 'run-A');
let row = getChatRunRecordByCallerRequest('att-wire-1', store);
assert.ok(row, 'durable row exists');
assert.equal(row.family, 'chat');
assert.equal(row.chatId, chat1.id);
assert.equal(row.state, 'running');
assert.equal(row.acceptance.state, 'accepted');
assert.equal(row.acceptance.adapterRunId, 'run-A');

// 2. Terminal evidence: stale run id ignored, matching one finishes the run.
assert.equal(noteChatRunFinished({ chatId: chat1.id, runId: 'run-OTHER', status: 'completed', store }), false);
assert.equal(getChatRunRecordByCallerRequest('att-wire-1', store).state, 'running');
assert.equal(noteChatRunFinished({ chatId: chat1.id, runId: 'run-A', status: 'completed', store }), true);
row = getChatRunRecordByCallerRequest('att-wire-1', store);
assert.equal(row.state, 'completed');
assert.equal(row.terminalProof.source, 'adapter_event');
assert.equal(noteChatRunFinished({ chatId: chat1.id, runId: 'run-A', status: 'completed', store }), false);

// 3. Replay of an accepted requestId never launches a second attempt.
const callsBefore = startCalls;
await assert.rejects(
  startChatRun({ chatId: chat1.id, prompt: 'hi', requestId: 'att-wire-1' }),
  (err) => err.code === 'request_already_accepted'
);
assert.equal(startCalls, callsBefore);

// 4. Unknown start failure -> acceptance unconfirmed, and no resend on retry.
const chat2 = newChat();
nextStart = () => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); };
await assert.rejects(startChatRun({ chatId: chat2.id, prompt: 'p', requestId: 'att-wire-2' }), /socket hang up/);
row = getChatRunRecordByCallerRequest('att-wire-2', store);
assert.equal(row.state, 'starting');
assert.equal(row.acceptance.state, 'unconfirmed');
const callsAfterFail = startCalls;
nextStart = () => ({ runId: 'run-B', accepted: true });
await assert.rejects(
  startChatRun({ chatId: chat2.id, prompt: 'p', requestId: 'att-wire-2' }),
  (err) => err.code === 'acceptance_unconfirmed'
);
assert.equal(startCalls, callsAfterFail, 'prompt was not resent');

// 5. Proven pre-launch refusal is final for that row but retryable.
const chat3 = newChat();
nextStart = () => { throw Object.assign(new Error('busy'), { code: 'recipient_busy' }); };
await assert.rejects(startChatRun({ chatId: chat3.id, prompt: 'p', requestId: 'att-wire-3' }), /busy/);
row = getChatRunRecordByCallerRequest('att-wire-3', store);
assert.equal(row.state, 'cancelled');
assert.match(row.terminalProof.detail, /^launch_refused/);
nextStart = () => ({ runId: 'run-C', accepted: true });
const retried = await startChatRun({ chatId: chat3.id, prompt: 'p', requestId: 'att-wire-3' });
assert.equal(retried.runId, 'run-C');
row = getChatRunRecordByCallerRequest('att-wire-3', store);
assert.equal(row.state, 'running');
assert.equal(row.acceptance.adapterRunId, 'run-C');

// 6. Intent write failure blocks the launch (store closed mid-flight is skip;
// a failing write must not start the executor).
const chat4 = newChat();
const failing = store.db;
const realPrepare = failing.prepare.bind(failing);
failing.prepare = (sql) => {
  if (/INSERT INTO recovery_runs/i.test(sql)) throw new Error('disk full');
  return realPrepare(sql);
};
const callsBeforeBlock = startCalls;
await assert.rejects(
  startChatRun({ chatId: chat4.id, prompt: 'p', requestId: 'att-wire-4' }),
  (err) => err.code === 'launch_blocked'
);
assert.equal(startCalls, callsBeforeBlock, 'executor not started when intent failed');
failing.prepare = realPrepare;

// 6b. A real run is found by the resume endpoint (not 404); User Stop is
// persisted by cancelChatRun and the endpoint then refuses to resume it.
let resumeHandler = null;
registerRecoveryResumeRoutes({ post: (_route, handler) => { resumeHandler = handler; } }, {});
async function callResume(chatId, run, idempotencyKey) {
  let code = 0;
  let body = null;
  const res = { status(c) { code = c; return this; }, json(b) { body = b; return this; } };
  await resumeHandler({
    params: { id: chatId, logicalRunId: run.logicalRunId },
    body: { expectedState: run.state, expectedRevision: run.revision, idempotencyKey },
  }, res);
  return { code, body };
}
const chat6 = newChat();
nextStart = () => ({ runId: 'run-S', accepted: true });
await startChatRun({ chatId: chat6.id, prompt: 'p', requestId: 'att-wire-6' });
let stopRow = getChatRunRecordByCallerRequest('att-wire-6', store);
const found = await callResume(chat6.id, stopRow, 'idem-found-1');
assert.notEqual(found.code, 404, 'resume endpoint finds the real run record');
assert.notEqual(found.body?.status, 'not_found');
assert.equal(noteChatRunStopped({ chatId: chat6.id, runId: 'run-OTHER', store }), 0);
await cancelChatRun({ chatId: chat6.id, runId: 'run-S' });
stopRow = getChatRunRecordByCallerRequest('att-wire-6', store);
assert.equal(stopRow.state, 'cancelled');
const stopped = await callResume(chat6.id, stopRow, 'idem-stopped-1');
assert.equal(stopped.body.status, 'cancelled');
assert.equal(stopped.body.reason, 'user_stop');

// 6c. The production room hook covers direct WS prompts and distinguishes
// UI Stop from the internal cancellation used by server-owned runs.
const interactiveChat = newChat();
let interactiveRunId = 'interactive-run';
const interactiveRoom = {
  chatId: interactiveChat.id,
  sessionKey: interactiveChat.cursorSessionId,
  cwd: '/tmp',
  recoveryStore: store,
  startPrompt() {
    this.currentRun = { id: interactiveRunId };
    return Promise.resolve();
  },
  cancelCurrentRun() {
    this.currentRun = null;
  },
};
bindRoomRecoveryLifecycle({ room: interactiveRoom, chat: interactiveChat, transport: 'codex' });
await interactiveRoom.startPrompt('direct WS prompt');
let interactiveRows = listRuns({ family: 'chat', chatIds: [interactiveChat.id], order: 'desc' }, store);
assert.equal(interactiveRows[0].state, 'running', 'direct prompt intent precedes launch and is accepted');
await interactiveRoom.cancelCurrentRun();
interactiveRows = listRuns({ family: 'chat', chatIds: [interactiveChat.id], order: 'desc' }, store);
assert.equal(interactiveRows[0].state, 'cancelled');
assert.equal(interactiveRows[0].cancelReason, 'user_stop');
interactiveRunId = 'internal-run';
const internalRoom = {
  chatId: interactiveChat.id,
  sessionKey: interactiveChat.cursorSessionId,
  cwd: '/tmp',
  recoveryStore: store,
  startPrompt() {
    this.currentRun = { id: interactiveRunId };
    return Promise.resolve();
  },
  cancelCurrentRun() {
    this.currentRun = null;
  },
};
bindRoomRecoveryLifecycle({ room: internalRoom, chat: interactiveChat, transport: 'codex' });
await internalRoom.startPrompt('internal prompt');
noteChatRunStopped({ chatId: interactiveChat.id, runId: 'internal-run', reason: 'internal_cancel', store });
internalRoom._internalRecoveryCancel = true;
await internalRoom.cancelCurrentRun();
interactiveRows = listRuns({ family: 'chat', chatIds: [interactiveChat.id], order: 'desc' }, store);
assert.equal(interactiveRows[0].cancelReason, 'internal_cancel');

// 6b. Re-binding after the caller re-assigns room.startPrompt (OpenCode/SDK
// pattern) must keep recording direct prompts, without double-wrapping.
let rebindCalls = 0;
const rebindRoom = {
  chatId: interactiveChat.id,
  sessionKey: interactiveChat.cursorSessionId,
  cwd: '/tmp',
  recoveryStore: store,
  cancelCurrentRun() {},
};
const rebindRunPrompt = function runPrompt() {
  rebindCalls += 1;
  this.currentRun = { id: `rebind-run-${rebindCalls}` };
  return Promise.resolve();
};
for (let i = 0; i < 2; i += 1) {
  rebindRoom.startPrompt = rebindRunPrompt;
  bindRoomRecoveryLifecycle({ room: rebindRoom, chat: interactiveChat, transport: 'codex' });
}
const rowsBeforeRebind = listRuns({ family: 'chat', chatIds: [interactiveChat.id], order: 'desc' }, store).length;
await rebindRoom.startPrompt('after rebind');
bindRoomRecoveryLifecycle({ room: rebindRoom, chat: interactiveChat, transport: 'codex' });
await rebindRoom.startPrompt('after idempotent rebind');
assert.equal(rebindCalls, 2, 'underlying prompt runner called once per prompt (no double wrap)');
assert.equal(
  listRuns({ family: 'chat', chatIds: [interactiveChat.id], order: 'desc' }, store).length,
  rowsBeforeRebind + 2,
  'each direct prompt after re-bind creates exactly one record',
);

// 6d. A second bind with a refreshed chat (other model/transport) makes the
// next direct prompt record the NEW chat's metadata.
const chatA = { ...newChat(), model: 'model-A' };
const chatB = { ...chatA, model: 'model-B' };
const refreshRoom = {
  chatId: chatA.id,
  sessionKey: chatA.cursorSessionId,
  cwd: '/tmp',
  recoveryStore: store,
  startPrompt() {
    this.currentRun = { id: 'refresh-run' };
    return Promise.resolve();
  },
  cancelCurrentRun() {
    this.currentRun = null;
  },
};
bindRoomRecoveryLifecycle({ room: refreshRoom, chat: chatA, transport: 'codex' });
bindRoomRecoveryLifecycle({ room: refreshRoom, chat: chatB, transport: 'opencode' });
await refreshRoom.startPrompt('after refreshed bind');
const refreshRow = listRuns({ family: 'chat', chatIds: [chatA.id], order: 'desc' }, store)[0];
assert.equal(refreshRow.model, 'model-B', 'record carries the refreshed chat model');
assert.equal(refreshRow.harness, 'opencode', 'record carries the refreshed transport');

// 6e. The caller replaces room.cancelCurrentRun after bind; a re-bind re-wraps
// it and cancel still marks the recovery record as user-stopped.
let replacedCancelCalls = 0;
refreshRoom.cancelCurrentRun = function replacedCancel() {
  replacedCancelCalls += 1;
  this.currentRun = null;
};
bindRoomRecoveryLifecycle({ room: refreshRoom, chat: chatB, transport: 'opencode' });
await refreshRoom.startPrompt('prompt before cancel');
await refreshRoom.cancelCurrentRun();
assert.equal(replacedCancelCalls, 1, 'replaced cancel still runs once');
const cancelRow = listRuns({ family: 'chat', chatIds: [chatA.id], order: 'desc' }, store)[0];
assert.equal(cancelRow.state, 'cancelled');
assert.equal(cancelRow.cancelReason, 'user_stop');
const before = replacedCancelCalls;
bindRoomRecoveryLifecycle({ room: refreshRoom, chat: chatB, transport: 'opencode' });
await refreshRoom.cancelCurrentRun();
assert.equal(replacedCancelCalls - before, 1, 'idempotent re-bind does not double-wrap cancel');

// 7. Recovery not initialised in this process: runs still start.
closeRecoveryStore(store);
const chat5 = newChat();
const noStore = await startChatRun({ chatId: chat5.id, prompt: 'p', requestId: 'att-wire-5' });
assert.equal(noStore.accepted, true);

fs.rmSync(dataDir, { recursive: true, force: true });
console.log('chat-run-recovery-wiring.test.js OK');
