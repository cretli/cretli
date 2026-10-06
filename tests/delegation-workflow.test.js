import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { addChat } from '../lib/persist/chats-persist.js';
import {
  applyDelegationWorkflowPatch,
  fingerprintDelegationWorkflowPatch,
  inspectDelegationWorkflowStart,
  isDelegationWorkflowDeadlinePassed,
  resolveDelegationWorkflowRow,
} from '../lib/delegation-workflow.js';
import {
  extractDelegationWorkflowLeafIdFromText,
  isDelegationWorkflowHardStopReason,
} from '../lib/delegation-workflow-leaf.js';
import { formatTodoRef } from '../lib/todo-ref.js';
import { updateDelegationRecord } from '../lib/persist/delegations-persist.js';
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
import { recordUsage } from '../lib/usage/usage-ledger.js';
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
    lastModel: 'review-model-1',
    lastVerdict: 'FAIL',
    findingsText: 'same finding',
    idempotencyKey: 'review-1',
  });
  assert.equal(first.consecutiveSameFail, 1);
  assert.equal(first.stopReason, '');
  assert.equal(first.lastReviewer, '');
  assert.equal(first.lastModel, 'review-model-1');
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
    lastModel: 'review-model-1',
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

{
  const parentChatId = crypto.randomUUID();
  const leafA = '1a72632d-aaaa-bbbb-cccc-ddddeeeeffff';
  const leafB = 'b457689e-1111-2222-3333-444455556666';
  applyDelegationWorkflowPatch({
    parentChatId,
    leafId: leafA,
    round: 3,
    maxRounds: 4,
  });
  applyDelegationWorkflowPatch({
    parentChatId,
    leafId: leafB,
    round: 3,
    maxRounds: 4,
  });
  const gateA = inspectDelegationWorkflowStart({ parentChatId, leafId: leafA });
  const gateB = inspectDelegationWorkflowStart({ parentChatId, leafId: leafB });
  assert.equal(gateA.ok, true);
  assert.equal(gateB.ok, true);
  applyDelegationWorkflowPatch({
    parentChatId,
    leafId: leafA,
    round: 4,
    maxRounds: 4,
  });
  const exhaustedA = inspectDelegationWorkflowStart({ parentChatId, leafId: leafA });
  assert.equal(exhaustedA.ok, false);
  assert.equal(exhaustedA.code, 'workflow_rounds_exhausted');
  const stillB = inspectDelegationWorkflowStart({ parentChatId, leafId: leafB });
  assert.equal(stillB.ok, true);
}

{
  const parentChatId = crypto.randomUUID();
  const leafId = 'deadbeef-aaaa-bbbb-cccc-ddddeeeeffff';
  applyDelegationWorkflowPatch({
    parentChatId,
    leafId,
    round: 2,
    maxRounds: 6,
    idempotencyKey: 'persist-leaf',
  });
  const reloaded = resolveDelegationWorkflowRow({ parentChatId, leafId });
  assert.equal(reloaded.round, 2);
  assert.equal(reloaded.leafId, leafId);
}

{
  const parentChatId = crypto.randomUUID();
  const leafId = 'cafebabe-1111-2222-3333-444455556666';
  applyDelegationWorkflowPatch({
    parentChatId,
    leafId,
    lastVerdict: 'FAIL',
    findingsText: 'leaf-only',
    idempotencyKey: 'leaf-f1',
  });
  const second = applyDelegationWorkflowPatch({
    parentChatId,
    leafId,
    lastVerdict: 'FAIL',
    findingsText: 'leaf-only',
    idempotencyKey: 'leaf-f2',
  });
  assert.equal(second.stopReason, 'same_findings');
  const blocked = inspectDelegationWorkflowStart({ parentChatId, leafId });
  assert.equal(blocked.code, 'workflow_stopped');
}

{
  const parentChatId = crypto.randomUUID();
  const leafId = 'aabbccdd-eeee-ffff-1111-222233334444';
  applyDelegationWorkflowPatch({
    parentChatId,
    leafId,
    round: 4,
    maxRounds: 4,
  });
  const row = resolveDelegationWorkflowRow({ parentChatId, leafId });
  assert.equal(row.stopReason, 'rounds_exhausted_soft');
  assert.equal(isDelegationWorkflowHardStopReason(row.stopReason), false);
  const resumed = applyDelegationWorkflowPatch({
    parentChatId,
    leafId,
    resumeRounds: true,
    maxRounds: 6,
  });
  assert.equal(resumed.stopReason, '');
  const gate = inspectDelegationWorkflowStart({ parentChatId, leafId });
  assert.equal(gate.ok, true);
}

{
  const parentChatId = crypto.randomUUID();
  const leafId = '11112222-3333-4444-5555-666677778888';
  const todoLine = formatTodoRef(leafId);
  const impl = createDelegationRecord({
    parentChatId,
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'opencode', model: 'opencode/test' },
    status: 'completed',
    assignment: 'implement',
    sourceKind: 'text',
    sourceText: `${todoLine}\nImplement leaf`,
    sourceHash: hashDelegationContent(`${todoLine}\nImplement leaf`),
    requestHash: buildDelegationRequestHash({
      parentChatId,
      sourceKind: 'text',
      sourceHash: hashDelegationContent('impl'),
      harness: 'opencode',
      model: 'opencode/test',
      assignment: 'implement',
    }),
    idempotencyKey: crypto.randomUUID(),
  });
  const review = createDelegationRecord({
    parentChatId,
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'opencode', model: 'opencode/test' },
    status: 'completed',
    assignment: 'review',
    sourceKind: 'text',
    sourceText: `${todoLine}\nReview leaf`,
    sourceHash: hashDelegationContent(`${todoLine}\nReview leaf`),
    requestHash: buildDelegationRequestHash({
      parentChatId,
      sourceKind: 'text',
      sourceHash: hashDelegationContent('rev'),
      harness: 'opencode',
      model: 'opencode/test',
      assignment: 'review',
    }),
    idempotencyKey: crypto.randomUUID(),
  });
  updateDelegationRecord(review.id, { report: 'VERDICT: FAIL\nFindings' });
  assert.equal(extractDelegationWorkflowLeafIdFromText(impl.sourceText), leafId);
  const synced = resolveDelegationWorkflowRow({ parentChatId, leafId });
  assert.equal(synced.round, 1);
  assert.equal(synced.lastVerdict, 'FAIL');
  updateDelegationRecord(review.id, { status: 'cancelled' });
}

{
  const parentChatId = crypto.randomUUID();
  applyDelegationWorkflowPatch({
    parentChatId,
    round: 4,
    maxRounds: 4,
  });
  const legacy = inspectDelegationWorkflowStart({ parentChatId });
  assert.equal(legacy.ok, false);
  assert.equal(legacy.code, 'workflow_rounds_exhausted');
}

// ---------------------------------------------------------------------------
// Per-leaf loop state: history inference, fan-out grouping, budgets, resume.
// ---------------------------------------------------------------------------

/**
 * @param {string} parentChatId
 * @param {string} leafId
 * @param {'implement' | 'review'} assignment
 * @param {string} [report]
 * @returns {object}
 */
function leafTerminalJob(parentChatId, leafId, assignment, report = '') {
  const todoLine = formatTodoRef(leafId);
  const sourceText = `${todoLine}\n${assignment} job`;
  const record = createDelegationRecord({
    parentChatId,
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'opencode', model: 'opencode/test' },
    status: 'completed',
    assignment,
    sourceKind: 'text',
    sourceText,
    sourceHash: hashDelegationContent(sourceText),
    requestHash: buildDelegationRequestHash({
      parentChatId,
      sourceKind: 'text',
      sourceHash: hashDelegationContent(`${assignment}-${crypto.randomUUID()}`),
      harness: 'opencode',
      model: 'opencode/test',
      assignment,
    }),
    idempotencyKey: crypto.randomUUID(),
  });
  if (report) updateDelegationRecord(record.id, { report });
  return record;
}

// PASS resets the inferred round; a following cycle starts from 1 again.
{
  const parentChatId = crypto.randomUUID();
  const leafId = 'feedface-0000-1111-2222-333344445555';
  leafTerminalJob(parentChatId, leafId, 'implement');
  leafTerminalJob(parentChatId, leafId, 'review', 'VERDICT: FAIL\nfinding one');
  const first = resolveDelegationWorkflowRow({ parentChatId, leafId });
  assert.equal(first.round, 1);
  assert.equal(first.lastVerdict, 'FAIL');

  leafTerminalJob(parentChatId, leafId, 'review', 'VERDICT: PASS');
  const afterPass = resolveDelegationWorkflowRow({ parentChatId, leafId });
  assert.equal(afterPass.round, 0);
  assert.equal(afterPass.lastVerdict, 'PASS');

  leafTerminalJob(parentChatId, leafId, 'implement');
  const newCycle = resolveDelegationWorkflowRow({ parentChatId, leafId });
  assert.equal(newCycle.round, 1);
  assert.ok(newCycle.round < 2, 'post-PASS cycle must not resurrect pre-PASS rounds');
  const newCycleAgain = resolveDelegationWorkflowRow({ parentChatId, leafId });
  assert.equal(newCycleAgain.round, 1, 'resolve must not toggle the round on a second call');
}

// A parallel review fan-out is one round, not one round per reviewer.
{
  const parentChatId = crypto.randomUUID();
  const leafId = 'decafbad-1111-2222-3333-444455556666';
  leafTerminalJob(parentChatId, leafId, 'implement');
  leafTerminalJob(parentChatId, leafId, 'review', 'VERDICT: FAIL\nreviewer A');
  leafTerminalJob(parentChatId, leafId, 'review', 'VERDICT: FAIL\nreviewer B');
  leafTerminalJob(parentChatId, leafId, 'review', 'VERDICT: FAIL\nreviewer C');
  const fanout = resolveDelegationWorkflowRow({ parentChatId, leafId });
  assert.equal(fanout.round, 1, 'three reviews of one cycle must not sum to three rounds');
}

// Two leaves do not sum their rounds: each resolve sees only its own cycle.
{
  const parentChatId = crypto.randomUUID();
  const leafA = '1111aaaa-1111-2222-3333-444455556666';
  const leafB = '2222bbbb-1111-2222-3333-444455556666';
  for (let cycle = 0; cycle < 3; cycle += 1) {
    leafTerminalJob(parentChatId, leafA, 'implement');
    leafTerminalJob(parentChatId, leafA, 'review', 'VERDICT: FAIL');
  }
  leafTerminalJob(parentChatId, leafB, 'implement');
  leafTerminalJob(parentChatId, leafB, 'review', 'VERDICT: FAIL');
  const rowA = resolveDelegationWorkflowRow({ parentChatId, leafId: leafA });
  const rowB = resolveDelegationWorkflowRow({ parentChatId, leafId: leafB });
  assert.equal(rowA.round, 3);
  assert.equal(rowB.round, 1, 'leaf B must not inherit leaf A rounds');
}

// Without a leaf id there is no history inference (legacy per-chat behavior).
{
  const parentChatId = crypto.randomUUID();
  leafTerminalJob(parentChatId, '3333cccc-1111-2222-3333-444455556666', 'implement');
  leafTerminalJob(parentChatId, '3333cccc-1111-2222-3333-444455556666', 'review', 'VERDICT: FAIL');
  const legacy = resolveDelegationWorkflowRow({ parentChatId });
  assert.equal(legacy, null, 'unattributed parent review must not create/steal a workflow round');
  const gate = inspectDelegationWorkflowStart({ parentChatId });
  assert.equal(gate.ok, true);
}

// resume_rounds with no explicit cap really lifts the soft gate.
{
  const parentChatId = crypto.randomUUID();
  const leafId = '4444dddd-1111-2222-3333-444455556666';
  applyDelegationWorkflowPatch({ parentChatId, leafId, round: 4, maxRounds: 4 });
  const blocked = inspectDelegationWorkflowStart({ parentChatId, leafId });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'workflow_rounds_exhausted');
  const resumed = inspectDelegationWorkflowStart({ parentChatId, leafId, resumeRounds: true });
  assert.equal(resumed.ok, true, 'resume_rounds must unblock the leaf');
  const row = resolveDelegationWorkflowRow({ parentChatId, leafId });
  assert.equal(row.stopReason, '');
  assert.ok(Number(row.maxRounds) > Number(row.round));
  assert.equal(Number(row.maxRounds), 5);
}

// Budgets block only when the ledger measured spend at or above the cap.
{
  const parentChatId = crypto.randomUUID();
  const leafId = '5555eeee-1111-2222-3333-444455556666';
  const noMeasurement = leafTerminalJob(parentChatId, leafId, 'implement');
  applyDelegationWorkflowPatch({ parentChatId, leafId, budgetTokens: 1000 });
  const safeBefore = inspectDelegationWorkflowStart({ parentChatId, leafId });
  assert.equal(safeBefore.ok, true, 'missing measurement must not fabricate a budget block');

  recordUsage({
    provider: 'openai',
    feature: 'chat',
    harness: 'sdk',
    model: 'budget-probe',
    eventType: 'delta',
    chatId: noMeasurement.childChatId,
    delegationId: noMeasurement.id,
    tokens: { textInput: 900, textOutput: 200 },
  });
  const budgetBlock = inspectDelegationWorkflowStart({ parentChatId, leafId });
  assert.equal(budgetBlock.ok, false);
  assert.equal(budgetBlock.code, 'workflow_budget_exhausted');

  applyDelegationWorkflowPatch({ parentChatId, leafId, budgetTokens: 5000, idempotencyKey: 'raise-budget' });
  const raised = inspectDelegationWorkflowStart({ parentChatId, leafId });
  assert.equal(raised.ok, true);
}

console.log('delegation-workflow.test.js OK');
