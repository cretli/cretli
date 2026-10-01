import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addChat } from '../lib/persist/chats-persist.js';
import { createDelegationService } from '../lib/delegation-service.js';
import {
  formatWorkspaceBusyError,
  listOccupiedDelegations,
  normalizeDelegationWorkspaceKey,
  resolveDelegationGlobalLimit,
  resolveDelegationWorkspaceWriteConflict,
} from '../lib/delegation-workspace-guard.js';
import { registerMockChatRunAdapter, resetMockChatRuns } from '../lib/chat-run/mock-adapter.js';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';

resetMockChatRuns();
registerMockChatRunAdapter('opencode');

const otherFolder = path.join(os.tmpdir(), 'cretli-ws-other');
const occupied = [{
  id: 'job-a',
  parentChatId: 'parent-a',
  workspaceFolder: ISOLATED_DATA_DIR,
  assignment: 'implement',
  status: 'running',
}];

{
  const same = resolveDelegationWorkspaceWriteConflict({
    active: occupied,
    workspaceFolder: ISOLATED_DATA_DIR,
    parentChatId: 'parent-b',
    incomingAssignment: 'implement',
  });
  assert.equal(same.ok, false);
  assert.equal(same.code, 'workspace_busy');
  assert.match(same.error, /Blocker delegation id: job-a/);
  assert.match(same.error, /Blocker parent chat: parent-a/);
  assert.equal(formatWorkspaceBusyError(occupied[0]).includes('job-a'), true);
}

{
  const review = resolveDelegationWorkspaceWriteConflict({
    active: occupied,
    workspaceFolder: ISOLATED_DATA_DIR,
    parentChatId: 'parent-b',
    incomingAssignment: 'review',
  });
  assert.equal(review.ok, true);
}

{
  const other = resolveDelegationWorkspaceWriteConflict({
    active: occupied,
    workspaceFolder: otherFolder,
    parentChatId: 'parent-b',
    incomingAssignment: 'implement',
  });
  assert.equal(other.ok, true);
}

{
  const limited = resolveDelegationGlobalLimit({ active: occupied, limit: 1 });
  assert.equal(limited.ok, false);
  assert.equal(limited.code, 'global_limit');
  const open = resolveDelegationGlobalLimit({ active: occupied, limit: 0 });
  assert.equal(open.ok, true);
}

const service = createDelegationService({
  workspaceDirForAgent: () => ISOLATED_DATA_DIR,
  isModelAvailable: () => true,
});
const parentA = addChat(crypto.randomUUID(), 'ws-a', null, ISOLATED_DATA_DIR, 'opencode/test', {
  agentTransport: 'opencode',
  sdkMode: 'agent',
});
const parentB = addChat(crypto.randomUUID(), 'ws-b', null, ISOLATED_DATA_DIR, 'opencode/test', {
  agentTransport: 'opencode',
  sdkMode: 'agent',
});
const first = await service.createAndStart({
  parentChatId: parentA.id,
  sourceKind: 'text',
  taskText: 'implement a',
  assignment: 'implement',
  executor: { transport: 'opencode', model: 'opencode/test' },
  idempotencyKey: crypto.randomUUID(),
});
assert.equal(first.ok, true);
const second = await service.createAndStart({
  parentChatId: parentB.id,
  sourceKind: 'text',
  taskText: 'implement b',
  assignment: 'implement',
  executor: { transport: 'opencode', model: 'opencode/test' },
  idempotencyKey: crypto.randomUUID(),
});
assert.equal(second.ok, false);
assert.equal(second.code, 'workspace_busy');

{
  const link = path.join(os.tmpdir(), `cretli-ws-alias-${crypto.randomUUID()}`);
  fs.symlinkSync(ISOLATED_DATA_DIR, link);
  assert.equal(normalizeDelegationWorkspaceKey(link), normalizeDelegationWorkspaceKey(ISOLATED_DATA_DIR));
  const viaLink = resolveDelegationWorkspaceWriteConflict({
    active: occupied,
    workspaceFolder: link,
    parentChatId: 'parent-b',
    incomingAssignment: 'implement',
  });
  assert.equal(viaLink.ok, false);
  assert.equal(viaLink.code, 'workspace_busy');
}

{
  const raceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-ws-race-'));
  const raceService = createDelegationService({
    workspaceDirForAgent: () => raceDir,
    isModelAvailable: () => true,
  });
  const raceA = addChat(crypto.randomUUID(), 'race-a', null, raceDir, 'opencode/test', {
    agentTransport: 'opencode',
    sdkMode: 'agent',
  });
  const raceB = addChat(crypto.randomUUID(), 'race-b', null, raceDir, 'opencode/test', {
    agentTransport: 'opencode',
    sdkMode: 'agent',
  });
  const [left, right] = await Promise.all([
    raceService.createAndStart({
      parentChatId: raceA.id,
      sourceKind: 'text',
      taskText: 'race a',
      assignment: 'implement',
      executor: { transport: 'opencode', model: 'opencode/test' },
      idempotencyKey: crypto.randomUUID(),
    }),
    raceService.createAndStart({
      parentChatId: raceB.id,
      sourceKind: 'text',
      taskText: 'race b',
      assignment: 'implement',
      executor: { transport: 'opencode', model: 'opencode/test' },
      idempotencyKey: crypto.randomUUID(),
    }),
  ]);
  const okCount = [left, right].filter((row) => row.ok === true).length;
  const busyCount = [left, right].filter((row) => row.code === 'workspace_busy').length;
  assert.equal(okCount, 1);
  assert.equal(busyCount, 1);
}

{
  const previousLimit = process.env.CRETLI_DELEGATION_GLOBAL_LIMIT;
  const occupiedCount = listOccupiedDelegations().length;
  process.env.CRETLI_DELEGATION_GLOBAL_LIMIT = String(occupiedCount + 1);
  try {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-gl-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-gl-b-'));
    const globalService = createDelegationService({
      workspaceDirForAgent: (folder) => folder,
      isModelAvailable: () => true,
    });
    const globalA = addChat(crypto.randomUUID(), 'gl-a', null, dirA, 'opencode/test', {
      agentTransport: 'opencode',
      sdkMode: 'agent',
    });
    const globalB = addChat(crypto.randomUUID(), 'gl-b', null, dirB, 'opencode/test', {
      agentTransport: 'opencode',
      sdkMode: 'agent',
    });
    const [left, right] = await Promise.all([
      globalService.createAndStart({
        parentChatId: globalA.id,
        sourceKind: 'text',
        taskText: 'global a',
        assignment: 'implement',
        executor: { transport: 'opencode', model: 'opencode/test' },
        idempotencyKey: crypto.randomUUID(),
      }),
      globalService.createAndStart({
        parentChatId: globalB.id,
        sourceKind: 'text',
        taskText: 'global b',
        assignment: 'implement',
        executor: { transport: 'opencode', model: 'opencode/test' },
        idempotencyKey: crypto.randomUUID(),
      }),
    ]);
    const okCount = [left, right].filter((row) => row.ok === true).length;
    const limitedCount = [left, right].filter((row) => row.code === 'global_limit').length;
    assert.equal(okCount, 1);
    assert.equal(limitedCount, 1);
  } finally {
    if (previousLimit == null) delete process.env.CRETLI_DELEGATION_GLOBAL_LIMIT;
    else process.env.CRETLI_DELEGATION_GLOBAL_LIMIT = previousLimit;
  }
}

console.log('delegation-workspace-guard.test.js OK');
