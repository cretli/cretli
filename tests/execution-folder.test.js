import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addChat, loadChats, updateChat } from '../lib/persist/chats-persist.js';
import { createDelegationService } from '../lib/delegation-service.js';
import { getDelegationById, updateDelegationRecord } from '../lib/persist/delegations-persist.js';
import {
  normalizeExecutionFolder,
  readChatExecutionFolder,
  resolveExecutionFolderForChat,
  resolveExecutionFolderForRecord,
} from '../lib/execution-folder.js';
import { resolveSdkCwdForChat } from '../lib/workspace.js';
import { resolveDelegationWorkspaceWriteConflict } from '../lib/delegation-workspace-guard.js';
import { readDelegationMaterialRevisionForRecord } from '../lib/delegation-material-revision.js';
import { registerChatRunAdapter } from '../lib/chat-run-service.js';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';

const workspaceA = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-exec-ws-a-'));
const workspaceB = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-exec-ws-b-'));
const executionA = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-exec-run-a-'));
const executionB = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-exec-run-b-'));

// --- Resolver compatibility fallback -------------------------------------
{
  const legacy = addChat(crypto.randomUUID(), 'legacy', null, workspaceA, 'opencode/test', {
    agentTransport: 'opencode',
    sdkMode: 'agent',
  });
  assert.equal(Object.prototype.hasOwnProperty.call(legacy, 'executionFolder'), false);
  assert.equal(readChatExecutionFolder(legacy), '');
  assert.equal(resolveExecutionFolderForChat(legacy), normalizeExecutionFolder(workspaceA));
  assert.equal(resolveExecutionFolderForChat(legacy), resolveSdkCwdForChat(legacy, () => ''));

  const split = addChat(crypto.randomUUID(), 'split', null, workspaceA, 'opencode/test', {
    agentTransport: 'opencode',
    sdkMode: 'agent',
    executionFolder: executionA,
  });
  assert.equal(split.workspaceFolder, workspaceA);
  assert.equal(split.executionFolder, executionA);
  assert.equal(resolveExecutionFolderForChat(split), normalizeExecutionFolder(executionA));

  // Clearing the field restores the logical workspace.
  const cleared = updateChat(split.id, { executionFolder: '' });
  assert.equal(readChatExecutionFolder(cleared), '');
  assert.equal(resolveExecutionFolderForChat(cleared), normalizeExecutionFolder(workspaceA));

  // A workspace-file chat falls back to the caller resolver.
  const fileOnly = addChat(crypto.randomUUID(), 'file-only', '/tmp/example.code-workspace', null, 'opencode/test', {
    agentTransport: 'opencode',
    sdkMode: 'agent',
  });
  assert.equal(resolveExecutionFolderForChat(fileOnly, () => workspaceB), normalizeExecutionFolder(workspaceB));
}

// --- Delegation record resolver + material revision -----------------------
{
  assert.equal(resolveExecutionFolderForRecord({ workspaceFolder: workspaceA }), normalizeExecutionFolder(workspaceA));
  assert.equal(
    resolveExecutionFolderForRecord({ workspaceFolder: workspaceA, executionFolder: executionA }),
    normalizeExecutionFolder(executionA),
  );

  const gitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-exec-git-'));
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Dev',
    GIT_AUTHOR_EMAIL: 'dev@example.com',
    GIT_COMMITTER_NAME: 'Dev',
    GIT_COMMITTER_EMAIL: 'dev@example.com',
  };
  execFileSync('git', ['-C', gitDir, 'init'], { stdio: 'ignore', env: gitEnv });
  fs.writeFileSync(path.join(gitDir, 'README.md'), 'hi\n');
  execFileSync('git', ['-C', gitDir, 'add', 'README.md'], { stdio: 'ignore', env: gitEnv });
  execFileSync('git', ['-C', gitDir, 'commit', '-m', 'init'], { stdio: 'ignore', env: gitEnv });
  // A record with a split execution folder reads the revision from it, not
  // from the logical workspace (which is not a repo here).
  const revision = readDelegationMaterialRevisionForRecord({
    workspaceFolder: workspaceA,
    executionFolder: gitDir,
  });
  assert.match(revision, /^[0-9a-f]{7,12}$/i);
}

// --- Write lock keyed on the execution folder -----------------------------
{
  const occupied = [{
    id: 'job-a',
    parentChatId: 'parent-a',
    workspaceFolder: workspaceA,
    executionFolder: executionA,
    assignment: 'implement',
    status: 'running',
  }];
  // Same execution folder, different logical project: still busy.
  const sameExecution = resolveDelegationWorkspaceWriteConflict({
    active: occupied,
    workspaceFolder: workspaceB,
    executionFolder: executionA,
    parentChatId: 'parent-b',
    incomingAssignment: 'implement',
  });
  assert.equal(sameExecution.ok, false);
  assert.equal(sameExecution.code, 'workspace_busy');
  // Different execution folder, same logical project: allowed.
  const otherExecution = resolveDelegationWorkspaceWriteConflict({
    active: occupied,
    workspaceFolder: workspaceA,
    executionFolder: executionB,
    parentChatId: 'parent-b',
    incomingAssignment: 'implement',
  });
  assert.equal(otherExecution.ok, true);
  // Legacy rows without an execution folder keep the old workspace key.
  const legacyOccupied = [{ ...occupied[0], executionFolder: '' }];
  const legacySame = resolveDelegationWorkspaceWriteConflict({
    active: legacyOccupied,
    workspaceFolder: workspaceA,
    parentChatId: 'parent-b',
    incomingAssignment: 'implement',
  });
  assert.equal(legacySame.ok, false);
}

// --- Delegation start/resume inherit both contexts ------------------------
/** @type {object | null} */
let capturedChat = null;
let capturedPrompts = 0;
registerChatRunAdapter({
  transport: 'opencode',
  capabilities: { canLookupRequest: false, canCancel: true },
  async start({ chat }) {
    capturedChat = { ...chat };
    capturedPrompts += 1;
    return { runId: crypto.randomUUID(), accepted: true };
  },
  async cancel() {},
  getState() {
    return null;
  },
});

const service = createDelegationService({
  workspaceDirForAgent: () => workspaceA,
  isModelAvailable: () => true,
});

const parent = addChat(crypto.randomUUID(), 'parent', null, workspaceA, 'opencode/test', {
  agentTransport: 'opencode',
  sdkMode: 'agent',
  executionFolder: executionA,
});

const started = await service.createAndStart({
  parentChatId: parent.id,
  sourceKind: 'text',
  taskText: 'run in the execution folder',
  assignment: 'implement',
  executor: { transport: 'opencode', model: 'opencode/test' },
  idempotencyKey: crypto.randomUUID(),
});
assert.equal(started.ok, true);
assert.equal(started.delegation.workspaceFolder, workspaceA);
assert.equal(started.delegation.executionFolder, executionA);
const childChat = loadChats().find((row) => row.id === started.delegation.childChatId);
assert.equal(childChat.workspaceFolder, workspaceA);
assert.equal(childChat.executionFolder, executionA);
assert.ok(capturedChat);
assert.equal(resolveExecutionFolderForChat(capturedChat, () => workspaceA), normalizeExecutionFolder(executionA));
assert.equal(capturedPrompts, 1);

// --- Retry keeps the frozen execution folder ------------------------------
updateDelegationRecord(started.delegation.id, { status: 'failed' });
// Pretend the parent (and child) execution folder moved after the start.
updateChat(parent.id, { executionFolder: executionB });
updateChat(childChat.id, { executionFolder: executionB });

const retried = await service.retry(started.delegation.id);
assert.equal(retried.ok, true);
const afterRetry = getDelegationById(started.delegation.id);
assert.equal(afterRetry.executionFolder, executionA);
const childAfterRetry = loadChats().find((row) => row.id === started.delegation.childChatId);
assert.equal(childAfterRetry.executionFolder, executionA);
assert.equal(capturedPrompts, 2);
assert.equal(resolveExecutionFolderForChat(capturedChat, () => workspaceB), normalizeExecutionFolder(executionA));

console.log('execution-folder.test.js OK (isolated data dir: ' + path.basename(ISOLATED_DATA_DIR) + ')');
