// Isolated data dir must be the first import: persist paths resolve at load.
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  beginUpdateOperation,
  assertCanAcceptNewRun,
  canAcceptNewRun,
  createUpdateInProgressError,
  endUpdateOperation,
  getUpdateOperation,
  isUpdateOperationActive,
  resetUpdateGateForTest,
  resolveActiveRunCount,
  resolveRestartScheduled,
  resolveUpdateGate,
  setActiveRunCountProvider,
  setRestartScheduledProvider,
} from '../lib/update-gate.js';
import { SERVER_RESTART_ACTION, resolveServerRestartGate } from '../lib/server-restart-policy.js';
import { buildUpdateStatusPayload, getUpdateStatus, resolveUpdateApplyGate } from '../lib/self-update.js';
import { countActiveTaskRuns } from '../lib/dev-build.js';
import { countActiveDelegationRuns, createDelegationService } from '../lib/delegation-service.js';
import {
  countActiveChatRuns,
  startChatRun,
  unregisterChatRunAdapter,
} from '../lib/chat-run-service.js';
import {
  patchMockChatRun,
  registerMockChatRunAdapter,
  resetMockChatRuns,
} from '../lib/chat-run/mock-adapter.js';
import { addChat } from '../lib/persist/chats-persist.js';
import { msg } from '../lib/messages.js';

resetUpdateGateForTest();

// (a) The gate allows an update with no active runs.
assert.deepEqual(
  resolveUpdateGate({
    isRepo: true,
    busy: false,
    activeRuns: 0,
    restartScheduled: false,
    updateOperationActive: false,
  }),
  { allowed: true, status: 202 },
);
assert.deepEqual(
  resolveUpdateApplyGate({ isRepo: true, busy: false, activeRuns: 0 }),
  { allowed: true, status: 202 },
);

// Historical self-update codes stay intact.
assert.deepEqual(
  resolveUpdateApplyGate({ isRepo: false, busy: false }),
  { allowed: false, status: 400, errorKey: 'update.noRepo' },
);
assert.deepEqual(
  resolveUpdateApplyGate({ isRepo: true, busy: true }),
  { allowed: false, status: 409, errorKey: 'update.busy' },
);

// (b) An active run blocks the update with the new key.
assert.deepEqual(
  resolveUpdateGate({ isRepo: true, busy: false, activeRuns: 1 }),
  { allowed: false, status: 409, errorKey: 'update.activeRuns' },
);
assert.deepEqual(
  resolveUpdateApplyGate({ isRepo: true, busy: false, activeRuns: 2 }),
  { allowed: false, status: 409, errorKey: 'update.activeRuns' },
);

// D4: fail-closed when the active-run count is unknown.
assert.deepEqual(
  resolveUpdateGate({ isRepo: true, busy: false, activeRuns: null, activeRunsUnknown: true }),
  { allowed: false, status: 409, errorKey: 'update.activeRunsUnknown' },
);
// P1: missing activeRuns must not fail-open as zero.
assert.deepEqual(
  resolveUpdateGate({ isRepo: true, busy: false }),
  { allowed: false, status: 409, errorKey: 'update.activeRunsUnknown' },
);
assert.deepEqual(
  resolveUpdateApplyGate({ isRepo: true, busy: false }),
  { allowed: false, status: 409, errorKey: 'update.activeRunsUnknown' },
);
// D6: the long-lived front-build watch must not block self-update.
const taskRuns = new Map([
  ['dev-build-watch', { pty: {} }],
  ['real-task', { pty: {} }],
]);
assert.equal(countActiveTaskRuns(taskRuns), 2);
assert.equal(countActiveTaskRuns(taskRuns, 'dev-build-watch'), 1);
assert.equal(countActiveTaskRuns(taskRuns, 'other-id'), 2);
setActiveRunCountProvider(() => {
  throw new Error('store down');
});
assert.equal(resolveActiveRunCount(), null);
assert.deepEqual(
  beginUpdateOperation({ kind: 'self-update' }),
  { allowed: false, status: 409, errorKey: 'update.activeRunsUnknown' },
);
setActiveRunCountProvider(() => 0);

// A scheduled restart blocks the update (mutual exclusion).
assert.deepEqual(
  resolveUpdateGate({ isRepo: true, busy: false, activeRuns: 0, restartScheduled: true }),
  { allowed: false, status: 409, errorKey: 'update.restartInProgress' },
);
assert.deepEqual(
  resolveUpdateApplyGate({ isRepo: true, busy: false, activeRuns: 0, restartScheduled: true }),
  { allowed: false, status: 409, errorKey: 'update.restartInProgress' },
);

// The injected provider is the single source of the live run count.
setActiveRunCountProvider(() => 3);
assert.equal(resolveActiveRunCount(), 3);
assert.deepEqual(
  beginUpdateOperation({ kind: 'self-update' }),
  { allowed: false, status: 409, errorKey: 'update.activeRuns' },
);
setActiveRunCountProvider(() => 0);

// A scheduled restart, read through its provider, blocks begin too.
setRestartScheduledProvider(() => true);
assert.equal(resolveRestartScheduled(), true);
assert.deepEqual(
  beginUpdateOperation({ kind: 'install' }),
  { allowed: false, status: 409, errorKey: 'update.restartInProgress' },
);
setRestartScheduledProvider(() => false);

// D1: a live chat run blocks begin when the provider includes chat runs.
resetMockChatRuns();
const mockTransport = 'codex';
registerMockChatRunAdapter(mockTransport);
const chat = addChat('sess-gate-1', 'gate chat', '', '', '', { agentTransport: mockTransport });
await startChatRun({ chatId: chat.id, prompt: 'hello' });
assert.equal(countActiveChatRuns(), 1);
setActiveRunCountProvider(() => countActiveDelegationRuns() + countActiveChatRuns());
assert.deepEqual(
  beginUpdateOperation({ kind: 'self-update' }),
  { allowed: false, status: 409, errorKey: 'update.activeRuns' },
);
patchMockChatRun(chat.id, { busy: false, waitingForInput: false });
assert.equal(countActiveChatRuns(), 0);
const updateSlot = beginUpdateOperation({ kind: 'install', reason: 'block-starts' });
assert.equal(updateSlot.allowed, true);
let blockedStartCode = '';
try {
  await startChatRun({ chatId: chat.id, prompt: 'blocked' });
} catch (err) {
  blockedStartCode = String(err?.code || '');
}
assert.equal(blockedStartCode, 'update_in_progress');
endUpdateOperation(updateSlot.operationId);
unregisterChatRunAdapter(mockTransport);
resetMockChatRuns();
setActiveRunCountProvider(() => 0);

// (c) First begin wins; the second is refused, so there is no double start.
const firstBegin = beginUpdateOperation({ kind: 'self-update', reason: 'test' });
assert.equal(firstBegin.allowed, true);
assert.equal(firstBegin.status, 202);
assert.match(String(firstBegin.operationId || ''), /^[0-9a-f-]{36}$/i);
assert.equal(isUpdateOperationActive(), true);
assert.equal(getUpdateOperation().kind, 'self-update');
assert.deepEqual(
  beginUpdateOperation({ kind: 'install' }),
  { allowed: false, status: 409, errorKey: 'update.busy' },
);

// (e) No new run may be admitted while the operation is active.
assert.equal(canAcceptNewRun(), false);
assert.throws(() => assertCanAcceptNewRun(), (err) => err?.code === 'update_in_progress');
assert.equal(createUpdateInProgressError().code, 'update_in_progress');

// (d) The restart action is refused while an update operation is active.
assert.deepEqual(
  resolveServerRestartGate({ action: SERVER_RESTART_ACTION, env: { NODE_ENV: 'development' } }),
  { allowed: false, status: 409, errorKey: 'dev.restartInProgress' },
);

// Admission integration: a real delegation start and retry are refused with
// the shared code while the operation owns the update slot.
const service = createDelegationService();
const admission = await service.createAndStart({});
assert.equal(admission.ok, false);
assert.equal(admission.status, 409);
assert.equal(admission.code, 'update_in_progress');
const retryAdmission = await service.retry('missing-id');
assert.equal(retryAdmission.ok, false);
assert.equal(retryAdmission.status, 409);
assert.equal(retryAdmission.code, 'update_in_progress');

// D2: error+close style double end releases once; stale token cannot clear a new slot.
endUpdateOperation(firstBegin.operationId);
assert.equal(isUpdateOperationActive(), false);
const secondBegin = beginUpdateOperation({ kind: 'install' });
assert.equal(secondBegin.allowed, true);
endUpdateOperation(secondBegin.operationId);
endUpdateOperation(secondBegin.operationId);
assert.equal(isUpdateOperationActive(), false);
const thirdBegin = beginUpdateOperation({ kind: 'self-update' });
assert.equal(thirdBegin.allowed, true);
endUpdateOperation(firstBegin.operationId);
assert.equal(isUpdateOperationActive(), true);
endUpdateOperation(thirdBegin.operationId);
assert.equal(isUpdateOperationActive(), false);

// (f) endUpdateOperation releases the gate.
assert.equal(canAcceptNewRun(), true);
const installBegin = beginUpdateOperation({ kind: 'install' });
assert.equal(installBegin.allowed, true);
endUpdateOperation(installBegin.operationId);
assert.deepEqual(
  resolveServerRestartGate({ action: SERVER_RESTART_ACTION, env: { NODE_ENV: 'development' } }),
  { allowed: true, status: 202 },
);

// After the operation a start passes the update gate and reaches normal
// validation (empty input -> parent_required).
const afterEnd = await service.createAndStart({});
assert.equal(afterEnd.ok, false);
assert.equal(afterEnd.code, 'parent_required');

// D3: a failure after begin must release the slot (persist/spawn throw path).
const claimBegin = beginUpdateOperation({ kind: 'self-update', reason: 'persist-fail' });
assert.equal(claimBegin.allowed, true);
try {
  throw new Error('writeJsonAtomic failed');
} catch {
  endUpdateOperation(claimBegin.operationId);
}
assert.equal(isUpdateOperationActive(), false);
const afterPersistFail = beginUpdateOperation({ kind: 'install' });
assert.equal(afterPersistFail.allowed, true);
endUpdateOperation(afterPersistFail.operationId);

// The status payload exposes the gate reason and disables apply.
const gatedPayload = buildUpdateStatusPayload({
  isRepo: true,
  busy: false,
  gateAllowed: false,
  gateError: 'update.activeRuns',
});
assert.equal(gatedPayload.canApply, false);
assert.equal(gatedPayload.gateError, 'update.activeRuns');

// getUpdateStatus reports the live gate reason for a real git repo.
const repoDir = mkdtempSync(path.join(os.tmpdir(), 'cretli-update-gate-repo-'));
assert.equal(spawnSync('git', ['init'], { cwd: repoDir }).status, 0);
setActiveRunCountProvider(() => 1);
const gatedStatus = getUpdateStatus({
  projectRoot: repoDir,
  check: false,
  env: { NODE_ENV: 'production' },
});
assert.equal(gatedStatus.isRepo, true);
assert.equal(gatedStatus.canApply, false);
assert.equal(gatedStatus.gateError, 'update.activeRuns');
setActiveRunCountProvider(() => 0);

// The real provider is safe with an empty store.
assert.equal(countActiveDelegationRuns(), 0);

// Every new gate key exists in EN and PL.
const plReq = { headers: { 'accept-language': 'pl' } };
const enReq = { headers: { 'accept-language': 'en' } };
for (const key of [
  'update.activeRuns',
  'update.activeRunsUnknown',
  'update.restartInProgress',
  'update.notAcceptingRuns',
]) {
  assert.notEqual(msg(enReq, key), key);
  assert.notEqual(msg(plReq, key), key);
}
assert.match(msg(plReq, 'update.notAcceptingRuns'), /Nowe uruchomienia/);

// Interactive WS adapters reject new prompts while the update slot is held.
const interactiveWsAdapters = [
  '../lib/codex/codex-agent-ws.js',
  '../lib/deepseek/deepseek-agent-ws.js',
  '../lib/claude/claude-agent-ws.js',
  '../lib/codebuddy/codebuddy-agent-ws.js',
  '../lib/qwen/qwen-agent-ws.js',
  '../lib/sdk/cursor-agent-sdk-ws.js',
  '../lib/opencode/opencode-agent-ws.js',
  '../lib/openrouter/openrouter-agent-ws.js',
];
for (const relPath of interactiveWsAdapters) {
  const source = readFileSync(new URL(relPath, import.meta.url), 'utf8');
  assert.match(source, /if \(!canAcceptNewRun\(\)\)/, `${relPath} must gate runPrompt on the update slot`);
  assert.match(source, /code: 'update_in_progress'/, `${relPath} must surface update_in_progress to clients`);
}
const gateDuringUpdate = beginUpdateOperation({ kind: 'install', reason: 'ws-guard-contract' });
assert.equal(gateDuringUpdate.allowed, true);
assert.equal(canAcceptNewRun(), false);
endUpdateOperation(gateDuringUpdate.operationId);
assert.equal(canAcceptNewRun(), true);
assert.doesNotThrow(() => assertCanAcceptNewRun());

resetUpdateGateForTest();

console.log('update-gate.test.js: ok');
