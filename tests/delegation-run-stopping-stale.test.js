import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addChat } from '../lib/persist/chats-persist.js';
import {
  createDelegationService,
  releaseDelegationRunSlot,
} from '../lib/delegation-service.js';
import {
  createDelegationRecord,
  getDelegationById,
  updateDelegationRecord,
} from '../lib/persist/delegations-persist.js';
import {
  DELEGATION_RUN_STOPPING_STALE_MS,
  isDelegationSlotOccupied,
} from '../lib/delegation-status.js';
import {
  formatWorkspaceBusyError,
  resolveDelegationWorkspaceWriteConflict,
} from '../lib/delegation-workspace-guard.js';
import { registerMockChatRunAdapter } from '../lib/chat-run/mock-adapter.js';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';

registerMockChatRunAdapter('opencode');

function parent(label) {
  return addChat(crypto.randomUUID(), label, null, ISOLATED_DATA_DIR, 'opencode/test', {
    agentTransport: 'opencode',
    sdkMode: 'agent',
  });
}

{
  const staleAt = new Date(Date.now() - DELEGATION_RUN_STOPPING_STALE_MS - 5000).toISOString();
  const blocker = updateDelegationRecord(createDelegationRecord({
    parentChatId: parent('stale-stop-parent').id,
    childChatId: parent('stale-stop-child').id,
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'opencode', model: 'opencode/test' },
    assignment: 'implement',
    status: 'completed',
  }).id, { runStoppingAt: staleAt, finishedAt: staleAt });
  assert.equal(isDelegationSlotOccupied(blocker), false);
  const released = releaseDelegationRunSlot(blocker);
  assert.equal(String(released.runStoppingAt || '').trim(), '');
  const conflict = resolveDelegationWorkspaceWriteConflict({
    active: [getDelegationById(blocker.id)],
    workspaceFolder: ISOLATED_DATA_DIR,
    parentChatId: parent('other-parent').id,
    incomingAssignment: 'implement',
  });
  assert.equal(conflict.ok, true);
}

{
  const freshAt = new Date().toISOString();
  const child = parent('fresh-stop-child');
  const held = updateDelegationRecord(createDelegationRecord({
    parentChatId: parent('fresh-stop-parent').id,
    childChatId: child.id,
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'opencode', model: 'opencode/test' },
    assignment: 'implement',
    status: 'completed',
    runId: 'run-fresh',
  }).id, { runStoppingAt: freshAt, finishedAt: freshAt });
  assert.equal(isDelegationSlotOccupied(held), true);
  const conflict = resolveDelegationWorkspaceWriteConflict({
    active: [held],
    workspaceFolder: ISOLATED_DATA_DIR,
    parentChatId: parent('blocked-parent').id,
    incomingAssignment: 'implement',
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'workspace_busy');
  assert.match(conflict.error, /Blocker delegation id:/);
  assert.match(conflict.error, /Blocker parent chat:/);
  assert.equal(formatWorkspaceBusyError(held).includes(held.id), true);
}

{
  const integrateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-stale-slot-'));
  const integrateParent = (label) => addChat(crypto.randomUUID(), label, null, integrateDir, 'opencode/test', {
    agentTransport: 'opencode',
    sdkMode: 'agent',
  });
  const service = createDelegationService({
    workspaceDirForAgent: () => integrateDir,
    isModelAvailable: () => true,
  });
  const parentA = integrateParent('integrate-a');
  const parentB = integrateParent('integrate-b');
  const staleAt = new Date(Date.now() - DELEGATION_RUN_STOPPING_STALE_MS - 1000).toISOString();
  updateDelegationRecord(createDelegationRecord({
    parentChatId: parentA.id,
    childChatId: integrateParent('integrate-child').id,
    workspaceFolder: integrateDir,
    executor: { transport: 'opencode', model: 'opencode/test' },
    assignment: 'implement',
    status: 'completed',
  }).id, { runStoppingAt: staleAt, finishedAt: staleAt });
  const start = await service.createAndStart({
    parentChatId: parentB.id,
    sourceKind: 'text',
    taskText: 'after stale slot',
    assignment: 'implement',
    executor: { transport: 'opencode', model: 'opencode/test' },
    idempotencyKey: crypto.randomUUID(),
  });
  assert.equal(start.ok, true, start.error || start.code || 'expected start ok');
}

console.log('delegation-run-stopping-stale.test.js OK');
