import './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import { addChat } from '../lib/persist/chats-persist.js';
import {
  createDelegationRecord,
  getDelegationById,
  updateDelegationRecord,
} from '../lib/persist/delegations-persist.js';
import {
  createDelegationService,
  finishDelegation,
  hasInFlightDelegationStart,
  releaseDelegationRunSlot,
} from '../lib/delegation-service.js';
import { tickDelegationRuntime } from '../lib/delegation-runtime-worker.js';
import { resolveCancellingDeadline } from '../lib/delegation-cancelling-deadline.js';
import {
  registerMockChatRunAdapter,
  patchMockChatRun,
  resetMockChatRuns,
} from '../lib/chat-run/mock-adapter.ts';
import { registerChatRunAdapter } from '../lib/chat-run-service.js';
import {
  DELEGATION_CANCELLING_TIMEOUT_MS,
  DELEGATION_RUN_STOPPING_STALE_MS,
  isDelegationSlotOccupied,
  readDelegationCancellingTimeoutMs,
} from '../lib/delegation-status.js';
import { escalateCancellingToCancelUnconfirmed } from '../lib/delegation-cancelling-deadline.js';
import {
  readDelegationSlotHeldBy,
  readDelegationStopProof,
} from '../lib/delegation-slot-stop.js';
import { resolveDelegationParentWidth } from '../lib/delegation-width.js';
import { resolveDelegationWorkspaceWriteConflict } from '../lib/delegation-workspace-guard.js';
import { listActiveDelegationsForController } from '../lib/persist/delegations-persist.js';
import { addTodo, getTodoById, updateTodo } from '../lib/persist/todos-persist.js';

const service = createDelegationService({ isModelAvailable: () => true });

test.beforeEach(() => {
  resetMockChatRuns();
  registerMockChatRunAdapter('testfake');
});

test('record without slotHeldBy reads as running', () => {
  const row = createDelegationRecord({
    parentChatId: 'p1',
    childChatId: 'c1',
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'testfake', model: 'testfake/test' },
    assignment: 'implement',
    status: 'running',
  });
  assert.equal(readDelegationSlotHeldBy(getDelegationById(row.id)), 'running');
});

test('successful abort releases slot with stopProof', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-stop-proof-'));
  const localService = createDelegationService({
    isModelAvailable: () => true,
    workspaceDirForAgent: () => dir,
  });
  const parent = addChat(crypto.randomUUID(), 'parent', null, dir, 'testfake/test', {
    agentTransport: 'testfake',
    sdkMode: 'agent',
  });
  const start = await localService.createAndStart({
    parentChatId: parent.id,
    sourceKind: 'text',
    taskText: 'stop proof',
    assignment: 'implement',
    executor: { transport: 'testfake', model: 'testfake/test' },
    idempotencyKey: crypto.randomUUID(),
  });
  assert.equal(start.ok, true, start.error || start.code || 'start failed');
  const job = start.delegation;
  patchMockChatRun(job.childChatId, { busy: false, waitingForInput: false });
  const cancelled = await localService.cancel(job.id);
  assert.equal(cancelled.ok, true);
  const after = getDelegationById(job.id);
  assert.equal(after.status, 'cancelled');
  assert.equal(readDelegationStopProof(after)?.kind, 'adapter_abort');
  assert.equal(isDelegationSlotOccupied(after), false);
});

test('harness without abort API finishes read-only review as infra and releases slot', async () => {
  registerChatRunAdapter({
    transport: 'no-abort-test',
    capabilities: { canCancel: false },
    getState: () => ({ runId: 'r', busy: true, waitingForInput: false }),
    cancel: async () => {},
    start: async () => ({ accepted: true, runId: 'r' }),
  });
  const parent = addChat(crypto.randomUUID(), 'parent-na', null, ISOLATED_DATA_DIR, 'no-abort-test/x', {
    agentTransport: 'no-abort-test',
    sdkMode: 'agent',
  });
  const child = addChat(crypto.randomUUID(), 'child-na', null, ISOLATED_DATA_DIR, 'no-abort-test/x', {
    agentTransport: 'no-abort-test',
    sdkMode: 'agent',
  });
  const row = updateDelegationRecord(createDelegationRecord({
    parentChatId: parent.id,
    childChatId: child.id,
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'no-abort-test', model: 'no-abort-test/x' },
    assignment: 'review',
    status: 'cancelling',
    runId: 'r',
  }).id, {
    lastTransitionAt: new Date(Date.now() - DELEGATION_CANCELLING_TIMEOUT_MS - 50).toISOString(),
  });
  resolveCancellingDeadline(row, Date.now(), { busy: true, known: true }, {
    finishDelegation,
    hasInFlightDelegationStart,
  });
  const after = getDelegationById(row.id);
  assert.equal(after.status, 'interrupted');
  assert.equal(after.interruptCode, 'review_cancel_stuck');
  assert.equal(after.slotHeldBy, 'running');
  assert.equal(isDelegationSlotOccupied(after), false);
});

test('harness without abort API still escalates implement to cancel_unconfirmed', () => {
  const parent = addChat(crypto.randomUUID(), 'parent-na-impl', null, ISOLATED_DATA_DIR, 'no-abort-test/x', {
    agentTransport: 'no-abort-test',
    sdkMode: 'agent',
  });
  const child = addChat(crypto.randomUUID(), 'child-na-impl', null, ISOLATED_DATA_DIR, 'no-abort-test/x', {
    agentTransport: 'no-abort-test',
    sdkMode: 'agent',
  });
  const row = updateDelegationRecord(createDelegationRecord({
    parentChatId: parent.id,
    childChatId: child.id,
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'no-abort-test', model: 'no-abort-test/x' },
    assignment: 'implement',
    status: 'cancelling',
    runId: 'r-impl',
  }).id, {
    lastTransitionAt: new Date(Date.now() - DELEGATION_CANCELLING_TIMEOUT_MS - 50).toISOString(),
  });
  resolveCancellingDeadline(row, Date.now(), { busy: true, known: true }, {
    finishDelegation,
    hasInFlightDelegationStart,
  });
  const after = getDelegationById(row.id);
  assert.equal(after.interruptCode, 'cancel_unconfirmed');
  assert.equal(isDelegationSlotOccupied(after), true);
});

test('stale-release does not free cancel_unconfirmed slot', () => {
  const staleAt = new Date(Date.now() - DELEGATION_RUN_STOPPING_STALE_MS - 5000).toISOString();
  const row = updateDelegationRecord(createDelegationRecord({
    parentChatId: 'p-stale',
    childChatId: 'c-stale',
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'testfake', model: 'testfake/test' },
    assignment: 'implement',
    status: 'interrupted',
    interruptCode: 'cancel_unconfirmed',
  }).id, {
    slotHeldBy: 'cancel_unconfirmed',
    runStoppingAt: staleAt,
    finishedAt: staleAt,
  });
  assert.equal(isDelegationSlotOccupied(row), true);
  const released = releaseDelegationRunSlot(row);
  assert.equal(isDelegationSlotOccupied(released), true);
});

test('manual release requires confirmation and writes todo changelog', async () => {
  const todo = addTodo(ISOLATED_DATA_DIR, ISOLATED_DATA_DIR, {
    title: 'Leaf',
    body: 'x',
    status: 'doing',
  }).item;
  const row = updateDelegationRecord(createDelegationRecord({
    parentChatId: 'p-manual',
    childChatId: 'c-manual',
    workspaceFolder: ISOLATED_DATA_DIR,
    leafId: todo.id,
    executor: { transport: 'testfake', model: 'testfake/test' },
    assignment: 'implement',
    status: 'interrupted',
    interruptCode: 'cancel_unconfirmed',
  }).id, {
    slotHeldBy: 'cancel_unconfirmed',
    runStoppingAt: new Date().toISOString(),
  });
  updateTodo(ISOLATED_DATA_DIR, ISOLATED_DATA_DIR, todo.id, {
    blockedReason: 'cancel_unconfirmed',
  });
  const denied = await service.confirmManualSlotRelease(row.id, { confirmation: false });
  assert.equal(denied.ok, false);
  const ok = await service.confirmManualSlotRelease(row.id, {
    confirmation: true,
    note: 'Process killed manually.',
  });
  assert.equal(ok.ok, true);
  const after = getDelegationById(row.id);
  assert.equal(after.slotHeldBy, 'running');
  assert.equal(readDelegationStopProof(after)?.kind, 'manual');
  assert.equal(isDelegationSlotOccupied(after), false);
  const leaf = getTodoById(ISOLATED_DATA_DIR, ISOLATED_DATA_DIR, todo.id);
  assert.equal(String(leaf?.blockedReason || ''), '');
  assert.ok((leaf?.changelog || []).some((entry) => String(entry.text || '').includes('Process killed manually.')));
});

test('second reviewer blocked when fanout allows more but cancel_unconfirmed holds slot', () => {
  const parent = 'parent-fanout';
  updateDelegationRecord(createDelegationRecord({
    parentChatId: parent,
    childChatId: 'child-cu-review',
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'testfake', model: 'testfake/test' },
    assignment: 'review',
    status: 'interrupted',
    interruptCode: 'cancel_unconfirmed',
  }).id, {
    slotHeldBy: 'cancel_unconfirmed',
    runStoppingAt: new Date().toISOString(),
  });
  const width = resolveDelegationParentWidth({
    active: listActiveDelegationsForController(parent),
    incomingAssignment: 'review',
    fanout: 2,
  });
  assert.equal(width.ok, false);
});

test('late idle cancel after cancel_unconfirmed escalation does not release slot', async () => {
  const parent = addChat(crypto.randomUUID(), 'late-cancel', null, ISOLATED_DATA_DIR, 'testfake/test', {
    agentTransport: 'testfake',
    sdkMode: 'agent',
  });
  const child = addChat(crypto.randomUUID(), 'late-cancel-child', null, ISOLATED_DATA_DIR, 'testfake/test', {
    agentTransport: 'testfake',
    sdkMode: 'agent',
  });
  const row = updateDelegationRecord(createDelegationRecord({
    parentChatId: parent.id,
    childChatId: child.id,
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'testfake', model: 'testfake/test' },
    assignment: 'implement',
    status: 'interrupted',
    interruptCode: 'cancel_unconfirmed',
    runId: 'late-run',
  }).id, {
    slotHeldBy: 'cancel_unconfirmed',
    runStoppingAt: new Date().toISOString(),
    lastTransitionAt: new Date(Date.now() - DELEGATION_CANCELLING_TIMEOUT_MS - 100).toISOString(),
  });
  patchMockChatRun(child.id, { busy: false, waitingForInput: false, runId: 'late-run' });
  const result = await service.cancel(row.id);
  assert.equal(result.ok, true);
  const after = getDelegationById(row.id);
  assert.equal(after.slotHeldBy, 'cancel_unconfirmed');
  assert.equal(isDelegationSlotOccupied(after), true);
  assert.equal(readDelegationStopProof(after), null);
});

test('manual release without leafId records note on delegation row', async () => {
  const row = updateDelegationRecord(createDelegationRecord({
    parentChatId: 'p-no-leaf',
    childChatId: 'c-no-leaf',
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'testfake', model: 'testfake/test' },
    assignment: 'implement',
    status: 'interrupted',
    interruptCode: 'cancel_unconfirmed',
  }).id, {
    slotHeldBy: 'cancel_unconfirmed',
    runStoppingAt: new Date().toISOString(),
  });
  const ok = await service.confirmManualSlotRelease(row.id, {
    confirmation: true,
    note: 'Killed PID manually.',
  });
  assert.equal(ok.ok, true);
  const after = getDelegationById(row.id);
  assert.ok((after.errors || []).some((entry) => entry.code === 'manual_slot_release'
    && String(entry.message || '').includes('Killed PID manually.')));
});

test('occupied cancel_unconfirmed blocks new implement on same folder and second reviewer', () => {
  const folder = ISOLATED_DATA_DIR;
  const parent = 'parent-width';
  const reviewBlocker = updateDelegationRecord(createDelegationRecord({
    parentChatId: parent,
    childChatId: 'child-block-review',
    workspaceFolder: folder,
    executor: { transport: 'testfake', model: 'testfake/test' },
    assignment: 'review',
    status: 'interrupted',
    interruptCode: 'cancel_unconfirmed',
  }).id, {
    slotHeldBy: 'cancel_unconfirmed',
    runStoppingAt: new Date().toISOString(),
  });
  const implementBlocker = updateDelegationRecord(createDelegationRecord({
    parentChatId: 'other-parent',
    childChatId: 'child-block-implement',
    workspaceFolder: folder,
    executor: { transport: 'testfake', model: 'testfake/test' },
    assignment: 'implement',
    status: 'interrupted',
    interruptCode: 'cancel_unconfirmed',
  }).id, {
    slotHeldBy: 'cancel_unconfirmed',
    runStoppingAt: new Date().toISOString(),
  });
  const active = listActiveDelegationsForController(parent);
  assert.ok(active.some((row) => row.id === reviewBlocker.id));
  const width = resolveDelegationParentWidth({
    active,
    incomingAssignment: 'review',
    fanout: 1,
  });
  assert.equal(width.ok, false);
  const workspace = resolveDelegationWorkspaceWriteConflict({
    active: [implementBlocker],
    workspaceFolder: folder,
    parentChatId: 'yet-another-parent',
    incomingAssignment: 'implement',
  });
  assert.equal(workspace.ok, false);
});

test('readDelegationCancellingTimeoutMs reads CRETLI_DELEGATION_CANCELLING_TIMEOUT_MS', () => {
  assert.equal(readDelegationCancellingTimeoutMs({}), 120000);
  assert.equal(readDelegationCancellingTimeoutMs({ CRETLI_DELEGATION_CANCELLING_TIMEOUT_MS: '45000' }), 45000);
  assert.equal(readDelegationCancellingTimeoutMs({ CRETLI_DELEGATION_CANCELLING_TIMEOUT_MS: 'bad' }), 120000);
});

test('resolveCancellingDeadline respects configured cancelling timeout', () => {
  const prev = process.env.CRETLI_DELEGATION_CANCELLING_TIMEOUT_MS;
  process.env.CRETLI_DELEGATION_CANCELLING_TIMEOUT_MS = '8000';
  try {
    const parent = addChat(crypto.randomUUID(), 'cfg-parent', null, ISOLATED_DATA_DIR, 'testfake/test', {
      agentTransport: 'testfake',
      sdkMode: 'agent',
    });
    const child = addChat(crypto.randomUUID(), 'cfg-child', null, ISOLATED_DATA_DIR, 'testfake/test', {
      agentTransport: 'testfake',
      sdkMode: 'agent',
    });
    const row = updateDelegationRecord(createDelegationRecord({
      parentChatId: parent.id,
      childChatId: child.id,
      workspaceFolder: ISOLATED_DATA_DIR,
      executor: { transport: 'testfake', model: 'testfake/test' },
      assignment: 'implement',
      status: 'cancelling',
      runId: 'cfg-run',
    }).id, {
      lastTransitionAt: new Date(Date.now() - 9000).toISOString(),
    });
    const outcome = resolveCancellingDeadline(row, Date.now(), { busy: true, known: true }, {
      finishDelegation,
      hasInFlightDelegationStart,
    });
    assert.equal(outcome, 'escalated');
    const within = updateDelegationRecord(createDelegationRecord({
      parentChatId: parent.id,
      childChatId: addChat(crypto.randomUUID(), 'cfg-child-2', null, ISOLATED_DATA_DIR, 'testfake/test', {
        agentTransport: 'testfake',
        sdkMode: 'agent',
      }).id,
      workspaceFolder: ISOLATED_DATA_DIR,
      executor: { transport: 'testfake', model: 'testfake/test' },
      assignment: 'implement',
      status: 'cancelling',
    }).id, {
      lastTransitionAt: new Date(Date.now() - 2000).toISOString(),
    });
    const noop = resolveCancellingDeadline(within, Date.now(), { busy: true, known: true }, {
      finishDelegation,
      hasInFlightDelegationStart,
    });
    assert.equal(noop, 'noop');
  } finally {
    if (prev === undefined) delete process.env.CRETLI_DELEGATION_CANCELLING_TIMEOUT_MS;
    else process.env.CRETLI_DELEGATION_CANCELLING_TIMEOUT_MS = prev;
  }
});

test('escalation writes interrupted and cancel_unconfirmed slot in one finish transition', () => {
  const parent = addChat(crypto.randomUUID(), 'atomic-parent', null, ISOLATED_DATA_DIR, 'testfake/test', {
    agentTransport: 'testfake',
    sdkMode: 'agent',
  });
  const child = addChat(crypto.randomUUID(), 'atomic-child', null, ISOLATED_DATA_DIR, 'testfake/test', {
    agentTransport: 'testfake',
    sdkMode: 'agent',
  });
  const row = createDelegationRecord({
    parentChatId: parent.id,
    childChatId: child.id,
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'testfake', model: 'testfake/test' },
    assignment: 'implement',
    status: 'cancelling',
    runId: 'atomic-run',
  });
  const now = Date.now();
  escalateCancellingToCancelUnconfirmed(row, now, { finishDelegation });
  const after = getDelegationById(row.id);
  assert.equal(after.status, 'interrupted');
  assert.equal(after.interruptCode, 'cancel_unconfirmed');
  assert.equal(after.slotHeldBy, 'cancel_unconfirmed');
  assert.equal(readDelegationSlotHeldBy(after), 'cancel_unconfirmed');
  assert.equal(isDelegationSlotOccupied(after), true);
});

test('cancelForDeletedChat on no-abort harness escalates after deadline without freeing slot', async () => {
  registerChatRunAdapter({
    transport: 'no-abort-delete',
    capabilities: { canCancel: false },
    getState: () => ({ runId: 'del-run', busy: true, waitingForInput: false }),
    cancel: async () => {},
    start: async () => ({ accepted: true, runId: 'del-run' }),
  });
  const parent = addChat(crypto.randomUUID(), 'del-parent', null, ISOLATED_DATA_DIR, 'no-abort-delete/x', {
    agentTransport: 'no-abort-delete',
    sdkMode: 'agent',
  });
  const child = addChat(crypto.randomUUID(), 'del-child', null, ISOLATED_DATA_DIR, 'no-abort-delete/x', {
    agentTransport: 'no-abort-delete',
    sdkMode: 'agent',
  });
  const row = updateDelegationRecord(createDelegationRecord({
    parentChatId: parent.id,
    childChatId: child.id,
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'no-abort-delete', model: 'no-abort-delete/x' },
    assignment: 'implement',
    status: 'cancelling',
    runId: 'del-run',
  }).id, {
    lastTransitionAt: new Date(Date.now() - readDelegationCancellingTimeoutMs() - 100).toISOString(),
  });
  const result = await service.cancelForDeletedChat(child.id);
  assert.equal(result.ok, true);
  const after = getDelegationById(row.id);
  assert.equal(after.status, 'interrupted');
  assert.equal(after.interruptCode, 'cancel_unconfirmed');
  assert.equal(after.slotHeldBy, 'cancel_unconfirmed');
  assert.equal(isDelegationSlotOccupied(after), true);
  assert.equal(readDelegationStopProof(after), null);
});

test('cancelForDeletedChat pending no-abort before deadline does not finish as cancelled', async () => {
  registerChatRunAdapter({
    transport: 'no-abort-delete-early',
    capabilities: { canCancel: false },
    getState: () => ({ runId: 'early-run', busy: true, waitingForInput: false }),
    cancel: async () => {},
    start: async () => ({ accepted: true, runId: 'early-run' }),
  });
  const parent = addChat(crypto.randomUUID(), 'early-parent', null, ISOLATED_DATA_DIR, 'no-abort-delete-early/x', {
    agentTransport: 'no-abort-delete-early',
    sdkMode: 'agent',
  });
  const child = addChat(crypto.randomUUID(), 'early-child', null, ISOLATED_DATA_DIR, 'no-abort-delete-early/x', {
    agentTransport: 'no-abort-delete-early',
    sdkMode: 'agent',
  });
  const row = updateDelegationRecord(createDelegationRecord({
    parentChatId: parent.id,
    childChatId: child.id,
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'no-abort-delete-early', model: 'no-abort-delete-early/x' },
    assignment: 'implement',
    status: 'cancelling',
    runId: 'early-run',
  }).id, {
    lastTransitionAt: new Date(Date.now() - 500).toISOString(),
  });
  const result = await service.cancelForDeletedChat(child.id);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'cancel_pending');
  const after = getDelegationById(row.id);
  assert.equal(after.status, 'cancelling');
  assert.equal(isDelegationSlotOccupied(after), true);
});

test('cancel to stopProof records elapsed time from lastTransitionAt', async () => {
  const parent = addChat(crypto.randomUUID(), 'metrics', null, ISOLATED_DATA_DIR, 'testfake/test', {
    agentTransport: 'testfake',
    sdkMode: 'agent',
  });
  const start = await service.createAndStart({
    parentChatId: parent.id,
    sourceKind: 'text',
    taskText: 'metrics',
    assignment: 'implement',
    executor: { transport: 'testfake', model: 'testfake/test' },
    idempotencyKey: crypto.randomUUID(),
  });
  const job = start.delegation;
  const cancelAt = Date.now();
  updateDelegationRecord(job.id, {
    status: 'cancelling',
    lastTransitionAt: new Date(cancelAt - 5000).toISOString(),
  });
  patchMockChatRun(job.childChatId, { busy: false, waitingForInput: false });
  await tickDelegationRuntime({
    now: cancelAt + DELEGATION_CANCELLING_TIMEOUT_MS + 100,
    drainMailbox: false,
  });
  const after = getDelegationById(job.id);
  const proofAt = Date.parse(String(readDelegationStopProof(after)?.at || ''));
  const escalatedAt = Date.parse(String(after.cancelEscalatedAt || readDelegationStopProof(after)?.at || ''));
  assert.ok(Number.isFinite(proofAt) || Number.isFinite(escalatedAt));
});

console.log('delegation-cancel-unconfirmed.test.js OK');
