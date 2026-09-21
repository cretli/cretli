import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { addChat } from '../lib/persist/chats-persist.js';
import {
  applyDelegationWorkflowPatch,
  fingerprintDelegationWorkflowPatch,
  inspectDelegationWorkflowStart,
  isDelegationWorkflowDeadlinePassed,
} from '../lib/delegation-workflow.js';
import {
  getDelegationWorkflowsDataPath,
  loadDelegationWorkflows,
  upsertDelegationWorkflow,
} from '../lib/persist/delegation-workflows-persist.js';
import { UnsupportedDelegationSchemaError } from '../lib/persist/delegation-schema.js';
import { createDelegationRecord, getDelegationById } from '../lib/persist/delegations-persist.js';
import { createDelegationService } from '../lib/delegation-service.js';
import { buildDelegationRequestHash, hashDelegationContent } from '../lib/delegation-request.js';
import { registerMockChatRunAdapter, resetMockChatRuns } from '../lib/chat-run/mock-adapter.js';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';

resetMockChatRuns();
registerMockChatRunAdapter('opencode');

const parentId = crypto.randomUUID();

{
  const first = applyDelegationWorkflowPatch({
    parentChatId: parentId,
    workspaceFolder: ISOLATED_DATA_DIR,
    role: 'review',
    round: 1,
    lastImplementer: 'composer-2',
    lastVerdict: 'FAIL',
    findingsText: 'same finding',
    idempotencyKey: 'review-1',
  });
  assert.equal(first.consecutiveSameFail, 1);
  assert.equal(first.stopReason, '');
  assert.equal(first.lastReviewer, '');
  const namedReviewer = applyDelegationWorkflowPatch({
    parentChatId: parentId,
    lastReviewer: 'deepseek-flash',
    idempotencyKey: 'reviewer-name',
  });
  assert.equal(namedReviewer.lastReviewer, 'deepseek-flash');
  assert.equal(namedReviewer.consecutiveSameFail, 1);
  assert.equal(first.replayed, false);
  const replay = applyDelegationWorkflowPatch({
    parentChatId: parentId,
    workspaceFolder: ISOLATED_DATA_DIR,
    role: 'review',
    round: 1,
    lastImplementer: 'composer-2',
    lastVerdict: 'FAIL',
    findingsText: 'same finding',
    idempotencyKey: 'review-1',
  });
  assert.equal(replay.consecutiveSameFail, 1);
  assert.equal(replay.stopReason, '');
  assert.equal(replay.replayed, true);
  const second = applyDelegationWorkflowPatch({
    parentChatId: parentId,
    round: 1,
    lastVerdict: 'FAIL',
    findingsText: 'same finding',
    idempotencyKey: 'review-2',
  });
  assert.equal(second.consecutiveSameFail, 2);
  assert.equal(second.stopReason, 'same_findings');
  assert.equal(second.reviewEventCount, 2);
  const blocked = inspectDelegationWorkflowStart({ parentChatId: parentId });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'workflow_stopped');
}

{
  const parentChatId = crypto.randomUUID();
  const failPatch = {
    parentChatId,
    round: 1,
    lastVerdict: 'FAIL',
    findingsText: 'same',
    idempotencyKey: 'review-1',
  };
  const first = applyDelegationWorkflowPatch(failPatch);
  assert.equal(first.replayed, false);
  assert.equal(first.reviewEventCount, 1);
  applyDelegationWorkflowPatch({
    parentChatId,
    idempotencyKey: 'role-fix',
    role: 'fix',
  });
  const replayA = applyDelegationWorkflowPatch(failPatch);
  assert.equal(replayA.replayed, true);
  assert.equal(replayA.reviewEventCount, 1);
  assert.equal(replayA.stopReason, '');
  assert.equal(replayA.consecutiveSameFail, 1);
  assert.equal(replayA.appliedPatches['review-1'], first.lastPatchFingerprint);
  let conflictCode = '';
  try {
    applyDelegationWorkflowPatch({
      ...failPatch,
      findingsText: 'other',
    });
  } catch (err) {
    conflictCode = err?.code || '';
  }
  assert.equal(conflictCode, 'idempotency_conflict');
  applyDelegationWorkflowPatch({
    parentChatId,
    stopReason: 'deadline',
  });
  const afterWorker = applyDelegationWorkflowPatch(failPatch);
  assert.equal(afterWorker.replayed, true);
  assert.equal(afterWorker.stopReason, 'deadline');
  assert.equal(afterWorker.reviewEventCount, 1);
}

{
  const parentChatId = crypto.randomUUID();
  const first = applyDelegationWorkflowPatch({
    parentChatId,
    lastVerdict: 'FAIL',
    findingsText: 'legacy',
    idempotencyKey: 'legacy-a',
  });
  const file = getDelegationWorkflowsDataPath();
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const item = doc.items.find((row) => row.parentChatId === parentChatId);
  delete item.appliedPatches;
  fs.writeFileSync(file, JSON.stringify(doc));
  const replayLegacy = applyDelegationWorkflowPatch({
    parentChatId,
    lastVerdict: 'FAIL',
    findingsText: 'legacy',
    idempotencyKey: 'legacy-a',
  });
  assert.equal(replayLegacy.replayed, true);
  assert.equal(replayLegacy.reviewEventCount, first.reviewEventCount);
  applyDelegationWorkflowPatch({
    parentChatId,
    idempotencyKey: 'legacy-b',
    role: 'fix',
  });
  const replayAfterReload = applyDelegationWorkflowPatch({
    parentChatId,
    lastVerdict: 'FAIL',
    findingsText: 'legacy',
    idempotencyKey: 'legacy-a',
  });
  assert.equal(replayAfterReload.replayed, true);
}

{
  const omittedStop = fingerprintDelegationWorkflowPatch({ lastVerdict: 'FAIL' });
  const emptyStop = fingerprintDelegationWorkflowPatch({ lastVerdict: 'FAIL', stopReason: '' });
  const omittedDeadline = fingerprintDelegationWorkflowPatch({ round: 1 });
  const emptyDeadline = fingerprintDelegationWorkflowPatch({ round: 1, deadlineAt: '' });
  assert.notEqual(omittedStop, emptyStop);
  assert.notEqual(omittedDeadline, emptyDeadline);
  const parentChatId = crypto.randomUUID();
  applyDelegationWorkflowPatch({
    parentChatId,
    stopReason: 'same_findings',
    idempotencyKey: 'keep-stop',
  });
  const kept = applyDelegationWorkflowPatch({
    parentChatId,
    role: 'fix',
    idempotencyKey: 'omit-stop',
  });
  assert.equal(kept.stopReason, 'same_findings');
  const cleared = applyDelegationWorkflowPatch({
    parentChatId,
    stopReason: '',
    idempotencyKey: 'clear-stop',
  });
  assert.equal(cleared.stopReason, '');
}

{
  const parentChatId = crypto.randomUUID();
  applyDelegationWorkflowPatch({
    parentChatId,
    lastVerdict: 'FAIL',
    findingsText: 'same finding',
    materialRevision: 'src-1',
    idempotencyKey: 'mat-r1',
  });
  const revised = applyDelegationWorkflowPatch({
    parentChatId,
    lastVerdict: 'FAIL',
    findingsText: 'same finding',
    materialRevision: 'src-2',
    idempotencyKey: 'mat-r2',
  });
  assert.equal(revised.consecutiveSameFail, 1);
  assert.equal(revised.stopReason, '');
  assert.equal(revised.materialRevision, 'src-2');
  assert.equal(revised.reviewEventCount, 2);
  const stuck = applyDelegationWorkflowPatch({
    parentChatId,
    lastVerdict: 'FAIL',
    findingsText: 'same finding',
    materialRevision: 'src-2',
    idempotencyKey: 'mat-r3',
  });
  assert.equal(stuck.consecutiveSameFail, 2);
  assert.equal(stuck.stopReason, 'same_findings');
}

{
  const parentChatId = crypto.randomUUID();
  const first = applyDelegationWorkflowPatch({
    parentChatId,
    lastVerdict: 'FAIL',
    findingsText: 'X',
    materialRevision: 'src-1',
    idempotencyKey: 'a',
  });
  assert.equal(first.consecutiveSameFail, 1);
  assert.equal(first.lastReviewMaterialRevision, 'src-1');
  const bumped = applyDelegationWorkflowPatch({
    parentChatId,
    materialRevision: 'src-2',
    idempotencyKey: 'bump',
  });
  assert.equal(bumped.consecutiveSameFail, 1);
  assert.equal(bumped.stopReason, '');
  assert.equal(bumped.reviewEventCount, 1);
  assert.equal(bumped.materialRevision, 'src-2');
  assert.equal(bumped.lastReviewMaterialRevision, 'src-1');
  assert.equal(bumped.lastReviewFindingsHash, first.findingsHash);
  const replayBump = applyDelegationWorkflowPatch({
    parentChatId,
    materialRevision: 'src-2',
    idempotencyKey: 'bump',
  });
  assert.equal(replayBump.replayed, true);
  assert.equal(replayBump.consecutiveSameFail, 1);
  const secondFail = applyDelegationWorkflowPatch({
    parentChatId,
    lastVerdict: 'FAIL',
    findingsText: 'X',
    idempotencyKey: 'c',
  });
  assert.equal(secondFail.consecutiveSameFail, 1);
  assert.equal(secondFail.stopReason, '');
  assert.equal(secondFail.reviewEventCount, 2);
  assert.equal(secondFail.lastReviewMaterialRevision, 'src-2');
  const unchanged = applyDelegationWorkflowPatch({
    parentChatId,
    lastVerdict: 'FAIL',
    findingsText: 'X',
    materialRevision: 'src-2',
    idempotencyKey: 'd',
  });
  assert.equal(unchanged.consecutiveSameFail, 2);
  assert.equal(unchanged.stopReason, 'same_findings');
}

{
  const parentChatId = crypto.randomUUID();
  const first = applyDelegationWorkflowPatch({
    parentChatId,
    lastVerdict: 'FAIL',
    findingsText: 'X',
    materialRevision: 'src-1',
    idempotencyKey: 'findings-a',
  });
  const notes = applyDelegationWorkflowPatch({
    parentChatId,
    findingsText: 'Y',
    idempotencyKey: 'findings-note',
  });
  assert.equal(notes.consecutiveSameFail, 1);
  assert.equal(notes.reviewEventCount, 1);
  assert.equal(notes.lastReviewFindingsHash, first.findingsHash);
  const nextFail = applyDelegationWorkflowPatch({
    parentChatId,
    lastVerdict: 'FAIL',
    findingsText: 'Y',
    materialRevision: 'src-1',
    idempotencyKey: 'findings-b',
  });
  assert.equal(nextFail.consecutiveSameFail, 1);
  assert.equal(nextFail.stopReason, '');
}

{
  const parentChatId = crypto.randomUUID();
  applyDelegationWorkflowPatch({
    parentChatId,
    lastVerdict: 'FAIL',
    findingsText: 'legacy-X',
    materialRevision: 'src-1',
    idempotencyKey: 'legacy-fail',
  });
  const file = getDelegationWorkflowsDataPath();
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const item = doc.items.find((row) => row.parentChatId === parentChatId);
  delete item.lastReviewFindingsHash;
  delete item.lastReviewMaterialRevision;
  fs.writeFileSync(file, JSON.stringify(doc));
  const reloaded = applyDelegationWorkflowPatch({
    parentChatId,
    materialRevision: 'src-2',
    idempotencyKey: 'legacy-bump',
  });
  assert.equal(reloaded.lastReviewMaterialRevision, 'src-1');
  assert.equal(reloaded.consecutiveSameFail, 1);
  const afterReloadFail = applyDelegationWorkflowPatch({
    parentChatId,
    lastVerdict: 'FAIL',
    findingsText: 'legacy-X',
    idempotencyKey: 'legacy-c',
  });
  assert.equal(afterReloadFail.consecutiveSameFail, 1);
  assert.equal(afterReloadFail.stopReason, '');
  const deadlock = applyDelegationWorkflowPatch({
    parentChatId,
    lastVerdict: 'FAIL',
    findingsText: 'legacy-X',
    materialRevision: 'src-2',
    idempotencyKey: 'legacy-d',
  });
  assert.equal(deadlock.consecutiveSameFail, 2);
  assert.equal(deadlock.stopReason, 'same_findings');
}

{
  const noKey = crypto.randomUUID();
  const first = applyDelegationWorkflowPatch({
    parentChatId: noKey,
    round: 1,
    lastVerdict: 'FAIL',
    findingsText: 'same finding',
  });
  const second = applyDelegationWorkflowPatch({
    parentChatId: noKey,
    round: 1,
    lastVerdict: 'FAIL',
    findingsText: 'same finding',
  });
  assert.equal(first.consecutiveSameFail, 1);
  assert.equal(second.consecutiveSameFail, 1);
  assert.equal(second.stopReason, '');
  assert.equal(second.replayed, true);
}

{
  const conflictId = crypto.randomUUID();
  applyDelegationWorkflowPatch({
    parentChatId: conflictId,
    round: 1,
    lastVerdict: 'FAIL',
    findingsText: 'one',
    idempotencyKey: 'same-key',
  });
  let code = '';
  try {
    applyDelegationWorkflowPatch({
      parentChatId: conflictId,
      round: 1,
      lastVerdict: 'FAIL',
      findingsText: 'other',
      idempotencyKey: 'same-key',
    });
  } catch (err) {
    code = err?.code || '';
  }
  assert.equal(code, 'idempotency_conflict');
}

{
  const revised = crypto.randomUUID();
  applyDelegationWorkflowPatch({
    parentChatId: revised,
    lastVerdict: 'FAIL',
    findingsText: 'first',
    idempotencyKey: 'r1',
  });
  const next = applyDelegationWorkflowPatch({
    parentChatId: revised,
    lastVerdict: 'FAIL',
    findingsText: 'changed',
    idempotencyKey: 'r2',
  });
  assert.equal(next.consecutiveSameFail, 1);
  assert.equal(next.stopReason, '');
  assert.equal(next.reviewEventCount, 2);
}

{
  const other = crypto.randomUUID();
  applyDelegationWorkflowPatch({
    parentChatId: other,
    round: 4,
    maxRounds: 4,
    role: 'review',
  });
  const actual = inspectDelegationWorkflowStart({ parentChatId: other });
  assert.equal(actual.ok, false);
  assert.equal(actual.code, 'workflow_rounds_exhausted');
}

{
  const late = crypto.randomUUID();
  const deadlineAt = new Date(Date.now() - 1000).toISOString();
  const row = applyDelegationWorkflowPatch({
    parentChatId: late,
    deadlineAt,
    clearStop: true,
    stopReason: '',
  });
  assert.equal(isDelegationWorkflowDeadlinePassed(row), true);
  const actual = inspectDelegationWorkflowStart({ parentChatId: late });
  assert.equal(actual.ok, false);
  assert.equal(actual.code, 'workflow_deadline');
}

{
  const file = getDelegationWorkflowsDataPath();
  const fixture = { v: 999, items: [{ parentChatId: 'p', futureField: 'important' }] };
  fs.writeFileSync(file, JSON.stringify(fixture));
  let schemaCode = '';
  try {
    loadDelegationWorkflows();
  } catch (err) {
    schemaCode = err?.code || '';
    assert.equal(err instanceof UnsupportedDelegationSchemaError, true);
  }
  assert.equal(schemaCode, 'WORKFLOWS_SCHEMA');
  const raw = fs.readFileSync(file, 'utf8');
  assert.match(raw, /"v":\s*999/);
  assert.match(raw, /futureField/);
  let upsertCode = '';
  try {
    upsertDelegationWorkflow({ parentChatId: 'p', round: 1 });
  } catch (err) {
    upsertCode = err?.code || '';
  }
  assert.equal(upsertCode, 'WORKFLOWS_SCHEMA');
  assert.equal(fs.readFileSync(file, 'utf8'), raw);
  fs.writeFileSync(file, JSON.stringify({ v: 1, items: [] }));
}

{
  const file = getDelegationWorkflowsDataPath();
  fs.writeFileSync(file, '{BROKEN');
  let threw = false;
  try {
    loadDelegationWorkflows();
  } catch {
    threw = true;
  }
  assert.equal(threw, true);
  assert.equal(fs.readFileSync(file, 'utf8'), '{BROKEN');
  fs.writeFileSync(file, JSON.stringify({ v: 1, items: [] }));
}

{
  const service = createDelegationService({
    workspaceDirForAgent: () => ISOLATED_DATA_DIR,
    isModelAvailable: () => true,
  });
  const parent = addChat(crypto.randomUUID(), 'resume-queued', null, ISOLATED_DATA_DIR, 'opencode/test', {
    agentTransport: 'opencode',
    sdkMode: 'agent',
  });
  const taskText = 'queued resume';
  const sourceHash = hashDelegationContent(taskText);
  const key = crypto.randomUUID();
  const requestHash = buildDelegationRequestHash({
    parentChatId: parent.id,
    sourceKind: 'text',
    sourceHash,
    harness: 'opencode',
    model: 'opencode/test',
    assignment: 'implement',
  });
  const queued = createDelegationRecord({
    parentChatId: parent.id,
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'opencode', model: 'opencode/test' },
    status: 'queued',
    assignment: 'implement',
    sourceKind: 'text',
    sourceText: taskText,
    sourceHash,
    requestHash,
    idempotencyKey: key,
  });
  applyDelegationWorkflowPatch({
    parentChatId: parent.id,
    round: 4,
    maxRounds: 4,
    role: 'review',
  });
  const blocked = await service.createAndStart({
    parentChatId: parent.id,
    sourceKind: 'text',
    taskText,
    assignment: 'implement',
    executor: { transport: 'opencode', model: 'opencode/test' },
    idempotencyKey: key,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'workflow_rounds_exhausted');
  assert.equal(getDelegationById(queued.id).status, 'queued');
  const { finishDelegation } = await import('../lib/delegation-service.js');
  finishDelegation(queued, { status: 'cancelled' });
}

{
  const service = createDelegationService({
    workspaceDirForAgent: () => ISOLATED_DATA_DIR,
    isModelAvailable: () => true,
  });
  const parent = addChat(crypto.randomUUID(), 'resume-terminal', null, ISOLATED_DATA_DIR, 'opencode/test', {
    agentTransport: 'opencode',
    sdkMode: 'agent',
  });
  const started = await service.createAndStart({
    parentChatId: parent.id,
    sourceKind: 'text',
    taskText: 'terminal replay',
    assignment: 'implement',
    executor: { transport: 'opencode', model: 'opencode/test' },
    idempotencyKey: 'terminal-replay',
  });
  assert.equal(started.ok, true);
  const { finishDelegation } = await import('../lib/delegation-service.js');
  finishDelegation(started.delegation, { status: 'completed', report: 'done' });
  applyDelegationWorkflowPatch({
    parentChatId: parent.id,
    round: 4,
    maxRounds: 4,
  });
  const replay = await service.createAndStart({
    parentChatId: parent.id,
    sourceKind: 'text',
    taskText: 'terminal replay',
    assignment: 'implement',
    executor: { transport: 'opencode', model: 'opencode/test' },
    idempotencyKey: 'terminal-replay',
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);
  assert.equal(replay.delegation.status, 'completed');
  assert.equal(replay.delegation.id, started.delegation.id);
}

console.log('delegation-workflow.test.js OK');
