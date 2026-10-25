import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgentRoomKernel } from '../lib/agent-harness/room-kernel.ts';
import { addChat } from '../lib/persist/chats-persist.js';
import { writeChatPlanFile, readChatPlanDocument } from '../lib/chat-plan-persist.js';
import { createDelegationService, finishDelegation } from '../lib/delegation-service.js';
import { clearHarnessUsageLimit } from '../lib/harness-usage-limits.js';
import { listDelegationsForController } from '../lib/persist/delegations-persist.js';
import { loadWakeups } from '../lib/persist/wakeups-persist.js';
import { patchMockChatRun, registerMockChatRunAdapter, resetMockChatRuns } from '../lib/chat-run/mock-adapter.ts';
import { saveSettings } from '../lib/persist/settings.js';

const QUOTA = "You've hit your session limit · resets 2:30pm";
const enabled = { usageLimitResume: { enabled: true } };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ulp-hooks-'));
const rows = (dataDir) => loadWakeups({ dataDir });

function kernelFor(dataDir, over = {}) {
  return createAgentRoomKernel({
    transport: 'qwen',
    persistHistory: () => {},
    recordUsage: () => null,
    usageDataDir: dataDir,
    usageLimitPauseDeps: {
      settings: enabled,
      resolveContext: () => ({ context: 'legacy_ad_hoc' }),
      findChat: (id) => ({ id }),
      ...over,
    },
    ...(over.kernel || {}),
  });
}
const quotaError = { type: 'sdkRunFinished', runId: 'r1', status: 'error', lastErrorMessage: QUOTA };

test('room kernel: quota error on a human chat arms exactly one pause', () => {
  const dataDir = tmp();
  const kernel = kernelFor(dataDir);
  const room = kernel.createRoomState({ sessionKey: 's1', chatId: 'c1', modelId: 'qwen-max' });
  kernel.broadcastRoom(room, quotaError);
  const first = rows(dataDir);
  assert.equal(first.length, 1);
  assert.equal(first[0].subjectType, 'chat');
  assert.equal(first[0].subjectId, 'c1');
  assert.equal(first[0].state, 'armed');
});

test('room kernel: disabled feature arms nothing and never loads chats', () => {
  const dataDir = tmp();
  const kernel = kernelFor(dataDir, {
    settings: { usageLimitResume: { enabled: false } },
    findChat: () => assert.fail('chats must not be read while disabled'),
  });
  const room = kernel.createRoomState({ sessionKey: 's1', chatId: 'c1', modelId: 'qwen-max' });
  kernel.broadcastRoom(room, quotaError);
  assert.equal(rows(dataDir).length, 0);
});

test('room kernel: delegation child, scout and automatic chats arm nothing', () => {
  const dataDir = tmp();
  const chats = {
    a: { id: 'a', delegationId: 'd1' },
    b: { id: 'b', pickPurpose: 'scout' },
    c: { id: 'c' },
  };
  const kernel = kernelFor(dataDir, {
    findChat: (id) => chats[id],
    resolveContext: ({ parent }) => ({ context: parent.id === 'c' ? 'automatic' : 'legacy_ad_hoc' }),
  });
  for (const id of ['a', 'b', 'c']) {
    const room = kernel.createRoomState({ sessionKey: `s-${id}`, chatId: id, modelId: 'qwen-max' });
    kernel.broadcastRoom(room, quotaError);
  }
  assert.equal(rows(dataDir).length, 0);
});

test('room kernel: a throwing chats store or store write does not break run-finish handling', () => {
  const dataDir = tmp();
  const finished = [];
  const kernel = kernelFor(dataDir, {
    findChat: () => { throw new Error('chats.json is corrupt'); },
    kernel: { recordUsage: (partial) => { finished.push(partial.outcome ?? partial); return null; } },
  });
  const room = kernel.createRoomState({ sessionKey: 's1', chatId: 'c1', modelId: 'qwen-max' });
  kernel.broadcastRoom(room, { type: 'sdkPromptStarted', runId: 'r1' });
  assert.doesNotThrow(() => kernel.broadcastRoom(room, quotaError));
  assert.ok(finished.length > 0, JSON.stringify(finished) + 'run-finish handling must still complete');
  // A store whose directory is a file: the arm write fails and is swallowed.
  const blocker = path.join(tmp(), 'file');
  fs.writeFileSync(blocker, 'x');
  const kernel2 = kernelFor(path.join(blocker, 'sub'));
  const room2 = kernel2.createRoomState({ sessionKey: 's2', chatId: 'c2', modelId: 'qwen-max' });
  assert.doesNotThrow(() => kernel2.broadcastRoom(room2, quotaError));
  assert.doesNotThrow(() => kernel2.broadcastRoom(room2, { type: 'sdkPromptStarted' }));
});

test('room kernel: sdkPromptStarted and a cancelled Stop cancel the armed chat pause', () => {
  for (const [payload, reason] of [
    [{ type: 'sdkPromptStarted', runId: 'r2' }, 'new_run'],
    [{ type: 'sdkRunFinished', runId: 'r2', status: 'cancelled' }, 'user_stop'],
  ]) {
    const dataDir = tmp();
    const kernel = kernelFor(dataDir);
    const room = kernel.createRoomState({ sessionKey: 's1', chatId: 'c1', modelId: 'qwen-max' });
    kernel.broadcastRoom(room, quotaError);
    assert.equal(rows(dataDir)[0].state, 'armed');
    kernel.broadcastRoom(room, payload);
    const after = rows(dataDir);
    assert.equal(after.length, 1);
    assert.equal(after[0].state, 'cancelled');
    assert.equal(after[0].reason, reason);
  }
});

// ---- delegation hooks ----
resetMockChatRuns();
registerMockChatRunAdapter('opencode');
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ulp-hooks-ws-'));
const service = createDelegationService({ workspaceDirForAgent: () => project });
// A leaf-attributed start resolves models through the favorites gate; open it.
const leafService = createDelegationService({ workspaceDirForAgent: () => project, isModelAvailable: () => true });
const executor = { transport: 'opencode', model: 'opencode/test' };

function parentChat(title) {
  const chat = addChat(`sess-${title}`, title, null, project, 'planner-model', { agentTransport: 'opencode', sdkMode: 'agent' });
  writeChatPlanFile({ cwd: project, chatId: chat.id, title, markdown: `# ${title}\n\n- step`, sourceTurnId: 't1' });
  return chat;
}
async function start(chat, key, extra = {}) {
  const res = await (extra.leafId ? leafService : service).createAndStart({
    parentChatId: chat.id,
    executor,
    planRevision: readChatPlanDocument({ cwd: project, chatId: chat.id }).revision,
    idempotencyKey: key,
    ...extra,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  return res.delegation;
}
const pauses = () => rows(ISOLATED_DATA_DIR).filter((r) => r.subjectType === 'delegation');
const armedFor = (id) => pauses().filter((r) => r.subjectId === id && r.state === 'armed');

test('delegation quota failure arms a pause; started retry cancels it', async () => {
  saveSettings({ ...enabled });
  const parent = parentChat('Quota parent');
  const delegation = await start(parent, 'ulp-q1');
  finishDelegation(delegation, { status: 'failed', error: QUOTA });
  const armed = armedFor(delegation.id);
  assert.equal(armed.length, 1);
  assert.equal(armed[0].subjectAttemptId, delegation.attemptId);
  assert.equal(armed[0].subjectModel, executor.model);
  assert.equal(armed[0].parentChatId, parent.id);
  assert.equal(armed[0].harness, 'opencode');
  clearHarnessUsageLimit('opencode', executor.model, ISOLATED_DATA_DIR);
  patchMockChatRun(delegation.childChatId, { busy: false });
  const retried = await service.retry(delegation.id);
  assert.equal(retried.ok, true, retried.error);
  assert.equal(armedFor(delegation.id).length, 0);
  const cancelled = pauses().find((r) => r.subjectId === delegation.id);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.reason, 'manual_retry');
  finishDelegation(retried.delegation, { status: 'completed', report: 'done' });
});

test('retry that opens a new attempt but ends terminal cancels the pause; a refused retry does not', async () => {
  saveSettings({ ...enabled });
  const parent = parentChat('Terminal retry parent');
  const delegation = await start(parent, 'ulp-q2');
  finishDelegation(delegation, { status: 'failed', error: QUOTA });
  assert.equal(armedFor(delegation.id).length, 1);
  // The active limit lockout refuses the retry before any attempt is created.
  const refused = await service.retry(delegation.id);
  assert.equal(refused.ok, false);
  assert.equal(listDelegationsForController(parent.id).find((r) => r.id === delegation.id).attemptId, delegation.attemptId);
  assert.equal(armedFor(delegation.id).length, 1, 'a refusal leaves the pause armed');
  clearHarnessUsageLimit('opencode', executor.model, ISOLATED_DATA_DIR);
  // The child run is still busy, so the accepted retry fails to start: a new
  // attempt ends terminal without ever reaching `running`.
  const failedRetry = await service.retry(delegation.id);
  const after = listDelegationsForController(parent.id).find((r) => r.id === delegation.id);
  assert.equal(failedRetry.ok, false);
  assert.equal(after.status, 'failed');
  assert.notEqual(after.attemptId, delegation.attemptId);
  assert.equal(armedFor(delegation.id).length, 0);
  finishDelegation(after, { status: 'failed', error: 'cleanup' });
});

test('sibling delegation on the same leaf cancels the pause; another leaf does not', async () => {
  saveSettings({ ...enabled });
  const parent = parentChat('Sibling parent');
  const failed = await start(parent, 'ulp-s1', { leafId: 'aaaa1111-0000-4000-8000-000000000001' });
  finishDelegation(failed, { status: 'failed', error: QUOTA });
  assert.equal(armedFor(failed.id)[0]?.leafId, 'aaaa1111-0000-4000-8000-000000000001');
  clearHarnessUsageLimit('opencode', executor.model, ISOLATED_DATA_DIR);
  const other = await start(parent, 'ulp-s2', { leafId: 'bbbb2222-0000-4000-8000-000000000002' });
  assert.equal(armedFor(failed.id).length, 1, 'another leaf must not cancel');
  finishDelegation(other, { status: 'completed', report: 'done' });
  await start(parent, 'ulp-s3', { leafId: 'aaaa1111-0000-4000-8000-000000000001' });
  assert.equal(armedFor(failed.id).length, 0, 'same leaf sibling cancels');
});
